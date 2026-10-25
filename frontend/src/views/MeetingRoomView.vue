<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import type { MessageItem } from '../types';
import { 
  Sliders,
  Send,
  Sparkles,
  Copy,
  Check,
  ArrowLeft,
  Box,
  Palette,
  FileText,
  Edit3,
  X,
  Paperclip,
  Download,
  Lock,
  Unlock,
  AlertCircle,
  Zap,
  Cpu,
  LogIn,
  Eye,
  WifiOff,
  Loader2,
  RefreshCw,
  PenTool,
  CornerUpLeft,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Settings,
  CheckCircle2,
  Plus,
  ShieldCheck
} from 'lucide-vue-next';

import ParametricViewer3D from '../components/ParametricViewer3D.vue';
import ModelViewerGLB from '../components/ModelViewerGLB.vue';
import MoodBoardViewer from '../components/MoodBoardViewer.vue';
import FactCheckViewer from '../components/FactCheckViewer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';
import AlertModal from '../components/AlertModal.vue';
import PdfViewerModal from '../components/PdfViewerModal.vue';
import CollaborativeWhiteboard from '../components/CollaborativeWhiteboard.vue';
import * as fabric from 'fabric';
import { currentLocale, setLocale, t, type SupportedLocale } from '../i18n';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const isWhiteboardOpen = ref(false);
const whiteboardRef = ref<any>(null);
const activeWhiteboardAssetId = ref<string | null>(null);
const currentWhiteboardJson = ref<string | undefined>(undefined);
const whiteboardSessionKey = ref<string>('wb_init_' + Date.now());
const whiteboardWidth = ref<number | null>(null);
const isResizingWhiteboard = ref(false);
const isPipDismissed = ref(false);
const isJoiningSharedBoard = ref(false);

watch(isWhiteboardOpen, (isOpen) => {
  if (isOpen) {
    if (whiteboardWidth.value === null || whiteboardWidth.value > window.innerWidth - 320) {
      whiteboardWidth.value = Math.max(500, window.innerWidth - 360);
    }
  }
});

const isLocalWhiteboardPublisher = ref(false);
const isActiveWhiteboardPrivate = ref(false);
const activeWhiteboardIsPublic = ref(false);
const activeWhiteboardCreatorUid = ref<string | null>(null);

const startWhiteboardResize = (e: MouseEvent) => {
  e.preventDefault();
  isResizingWhiteboard.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMouseMove = (moveEvent: MouseEvent) => {
    const remainingFromRight = window.innerWidth - moveEvent.clientX;
    // Dragged all the way to the right edge (< 120px) -> Close Whiteboard through confirmation/pip handler
    if (remainingFromRight < 120) {
      stopResize();
      whiteboardRef.value?.handleCloseRequest();
      return;
    }
    const maxWhiteboardW = Math.max(300, window.innerWidth - 240);
    const clampedW = Math.max(300, Math.min(maxWhiteboardW, remainingFromRight));
    whiteboardWidth.value = clampedW;
  };

  const stopResize = () => {
    isResizingWhiteboard.value = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stopResize);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', stopResize);
};

// When broadcast/publishing stops or converts to private, auto-eject non-publisher participants
watch(() => roomStore.currentRoom?.whiteboardActive, (isActive, wasActive) => {
  if (isActive === true) {
    isPipDismissed.value = false;
    if (roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
      if (!isActiveWhiteboardPrivate.value) {
        isLocalWhiteboardPublisher.value = true;
      }
    }
  }
  if (isActive === false) {
    if (isLocalWhiteboardPublisher.value) {
      // Keep publisher's whiteboard open seamlessly as a Personal Board!
      isLocalWhiteboardPublisher.value = false;
      isActiveWhiteboardPrivate.value = true;
      activeWhiteboardIsPublic.value = false;
      return;
    }
    // Any participant viewing or joining a shared board MUST be kicked out to prevent parallel whiteboards!
    if (isWhiteboardOpen.value && !isActiveWhiteboardPrivate.value) {
      isWhiteboardOpen.value = false;
      isJoiningSharedBoard.value = false;
      isActiveWhiteboardPrivate.value = false;
      activeWhiteboardIsPublic.value = false;
      activeWhiteboardCreatorUid.value = null;
      activeWhiteboardAssetId.value = null;
      currentWhiteboardJson.value = undefined;
      roomStore.pushToast('Collaboration Ended', 'The shared whiteboard session has ended.', 'info');
    }
  }
});

// Keep active whiteboard privacy status in sync if message updates in Firestore (e.g. made private or published)
watch(() => {
  if (!activeWhiteboardAssetId.value) return null;
  const asset = roomStore.currentRoom?.messages.find(m => m.id === activeWhiteboardAssetId.value);
  return asset?.metadata?.isPrivate;
}, (isPrivate) => {
  if (isPrivate === true) {
    isActiveWhiteboardPrivate.value = true;
    activeWhiteboardIsPublic.value = false;
  } else if (isPrivate === false) {
    isActiveWhiteboardPrivate.value = false;
    activeWhiteboardIsPublic.value = true;
  }
});

const isWhiteboardSharedSession = computed(() => {
  // 1. If explicitly marked as private, it is NEVER a shared session!
  if (isActiveWhiteboardPrivate.value) return false;

  // 2. If the active asset ID is private, it is NEVER a shared session!
  if (activeWhiteboardAssetId.value) {
    const asset = roomStore.currentRoom?.messages.find(m => m.id === activeWhiteboardAssetId.value);
    if (asset?.metadata?.isPrivate) {
      return false;
    }
  }

  // 3. Otherwise, check if room has an active whiteboard broadcast and this user is joined/publishing
  if (!roomStore.currentRoom?.whiteboardActive) return false;
  if (isLocalWhiteboardPublisher.value) return true;
  if (isJoiningSharedBoard.value) return true;
  if (activeWhiteboardAssetId.value) {
    const hostUid = roomStore.currentRoom?.whiteboardHostUid;
    const asset = roomStore.currentRoom?.messages.find(m => m.id === activeWhiteboardAssetId.value);
    if (asset && !asset.metadata?.isPrivate && (!hostUid || asset.metadata?.creatorUid === hostUid || asset.senderUid === hostUid)) {
      return true;
    }
  }
  return false;
});

const handleOpenNewWhiteboard = async () => {
  if (isWhiteboardOpen.value && whiteboardRef.value?.hasUnsavedChanges) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
    } catch (e) {
      console.warn('Auto save before new whiteboard error:', e);
    }
  }
  // Always open a clean, new blank whiteboard (entering collab is done via chat message or assets library)
  isActiveWhiteboardPrivate.value = true;
  activeWhiteboardIsPublic.value = false;
  activeWhiteboardCreatorUid.value = authStore.uid;
  isJoiningSharedBoard.value = false;
  isLocalWhiteboardPublisher.value = false;
  activeWhiteboardAssetId.value = null;
  currentWhiteboardJson.value = undefined;
  whiteboardSessionKey.value = 'wb_new_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  isWhiteboardOpen.value = true;
};

const handleJoinSharedWhiteboard = async () => {
  if (!roomStore.currentRoom?.whiteboardActive) {
    roomStore.pushToast('Session Ended', 'The shared whiteboard session is no longer active.', 'warning');
    return;
  }
  if (isWhiteboardOpen.value && whiteboardRef.value?.hasUnsavedChanges) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
    } catch (e) {
      console.warn('Auto save before joining shared board error:', e);
    }
  }
  isActiveWhiteboardPrivate.value = false;
  activeWhiteboardIsPublic.value = true;
  activeWhiteboardCreatorUid.value = roomStore.currentRoom?.whiteboardHostUid || null;
  isJoiningSharedBoard.value = true;
  const hostUid = roomStore.currentRoom?.whiteboardHostUid;
  const existingShared = roomStore.currentRoom?.messages.find(m => 
    m.type === 'whiteboard_state' && 
    (!hostUid || m.metadata?.creatorUid === hostUid || m.senderUid === hostUid) && 
    (m.metadata?.isSharedPost || !m.metadata?.isPrivate)
  );
  activeWhiteboardAssetId.value = existingShared?.id || null;
  currentWhiteboardJson.value = roomStore.currentRoom?.whiteboardState || existingShared?.metadata?.whiteboardJson || undefined;
  whiteboardSessionKey.value = 'wb_shared_' + (existingShared?.id || roomStore.currentRoom?.roomId || Date.now());
  isWhiteboardOpen.value = true;
};

const handleShareWhiteboard = async (file: File) => {
  await stageFile(file);
  await handleSend();
};

const isManagingAssets = ref(false);

const toggleManageAssets = () => {
  isManagingAssets.value = !isManagingAssets.value;
};

const handleToggleHideAsset = async (msg: any) => {
  if (!msg.id) return;
  const newHidden = !msg.metadata?.isHidden;
  const updatedMeta = {
    ...(msg.metadata || {}),
    isHidden: newHidden
  };
  msg.metadata = updatedMeta;
  try {
    await roomStore.updateCustomMessage(msg.id, {
      metadata: updatedMeta
    });
    roomStore.pushToast(
      newHidden ? 'Asset Hidden' : 'Asset Unhidden',
      newHidden ? 'Asset hidden from standard album view.' : 'Asset restored to album view.',
      'info'
    );
  } catch (e) {
    console.error('Failed to toggle asset hide status:', e);
  }
};

const handleSaveWhiteboardState = async (json: string, previewUrl: string, explicitAssetId?: string | null, isPrivateParam?: boolean) => {
  let targetAssetId = explicitAssetId || activeWhiteboardAssetId.value;
  const existingMsg = targetAssetId ? roomStore.currentRoom?.messages.find(m => m.id === targetAssetId) : null;

  // Strict privacy determination:
  let isPrivate = true;
  if (isPrivateParam !== undefined) {
    isPrivate = isPrivateParam;
  } else if (isActiveWhiteboardPrivate.value) {
    isPrivate = true;
  } else if (activeWhiteboardIsPublic.value) {
    isPrivate = false;
  } else if (existingMsg?.metadata?.isPrivate === true) {
    isPrivate = true;
  } else if (existingMsg?.metadata?.isPrivate === false && (existingMsg.metadata?.wasPublished || existingMsg.metadata?.isSharedPost)) {
    isPrivate = false;
  } else {
    isPrivate = !isWhiteboardSharedSession.value;
  }
  
  // Sync the local state back so MeetingRoomView knows about the change!
  isActiveWhiteboardPrivate.value = isPrivate;
  activeWhiteboardIsPublic.value = !isPrivate;


  // A session is shared ONLY if it is not private AND isWhiteboardSharedSession is true
  const isShared = !isPrivate && isWhiteboardSharedSession.value;

  const hostUid = roomStore.currentRoom?.whiteboardHostUid || authStore.uid;
  const hostName = roomStore.currentRoom?.whiteboardHostName || authStore.displayName || 'Host';

  if (isShared) {
    // In shared session, look for the shared asset in this room
    if (!targetAssetId) {
      const existingShared = roomStore.currentRoom?.messages.find(m => 
        m.type === 'whiteboard_state' && 
        (!hostUid || m.metadata?.creatorUid === hostUid || m.senderUid === hostUid) && 
        !m.metadata?.isPrivate
      );
      if (existingShared) {
        targetAssetId = existingShared.id;
        activeWhiteboardAssetId.value = existingShared.id;
      }
    }
  } else {
    // Ownership verification for personal/private mode: if editing another user's asset, fork into a new personal asset
    const isOwner = existingMsg ? (existingMsg.metadata?.creatorUid === authStore.uid || existingMsg.senderUid === authStore.uid) : true;
    if (isPrivate && targetAssetId && !isOwner) {
      targetAssetId = null;
      activeWhiteboardAssetId.value = null;
    }
  }

  const wasPublished = Boolean(existingMsg?.metadata?.wasPublished || !isPrivate);
  const isSharedPost = Boolean(existingMsg?.metadata?.isSharedPost || !isPrivate);
  const creatorUid = existingMsg?.metadata?.creatorUid || (isShared ? hostUid : authStore.uid);
  const creatorName = existingMsg?.metadata?.creatorName || (isShared ? hostName : (authStore.displayName || 'Participant'));
  const creatorAvatar = existingMsg?.metadata?.creatorAvatar || (isShared ? (roomStore.currentRoom?.participants[hostUid]?.avatar || '🎨') : (authStore.avatar || '🎨'));

  const meta = {
    whiteboardJson: json,
    isPrivate,
    isSharedPost,
    wasPublished,
    creatorUid,
    creatorName,
    creatorAvatar,
    isAutoSave: true
  };

  if (targetAssetId) {
    // Update existing asset in Assets Library (silent auto-save, NO chat flood)
    await roomStore.updateCustomMessage(targetAssetId, {
      fileData: {
        type: 'image',
        url: previewUrl,
        name: 'whiteboard.jpg',
        size: 0
      },
      metadata: meta
    });
  } else {
    // Create new whiteboard asset under appropriate owner
    const existingContent = existingMsg?.content;
    const content = isPrivate
      ? (wasPublished && existingContent && !existingContent.includes('Personal Draft') ? existingContent : 'Personal Draft')
      : `${hostName} shared a collaborative whiteboard`;

    const newId = await roomStore.sendCustomMessage({
      senderUid: authStore.uid,
      senderName: authStore.displayName || 'Participant',
      senderAvatar: authStore.avatar || '🎨',
      type: 'whiteboard_state',
      content,
      fileData: {
        type: 'image',
        url: previewUrl,
        name: 'whiteboard.jpg',
        size: 0
      },
      metadata: meta
    });
    if (newId) {
      activeWhiteboardAssetId.value = newId;
      targetAssetId = newId;
      if (whiteboardRef.value) {
        (whiteboardRef.value as any).setCurrentAssetId?.(newId);
      }
    }
  }

  // Trigger Gemini Whiteboard Vision Background Memory Record ONLY for shared boards or deliberate captures
  if (isShared) {
    roomStore.recordWhiteboardSnapshotMemory(previewUrl, json, targetAssetId || undefined);
  }
};

const retryingAiMessageId = ref<string | null>(null);
const handleRetryAiMessage = async (messageId: string) => {
  retryingAiMessageId.value = messageId;
  try {
    await roomStore.retryAiMentorMessage(messageId);
  } finally {
    retryingAiMessageId.value = null;
  }
};

const openWhiteboardState = async (msg: any) => {
  if (msg.type !== 'whiteboard_state') return;
  const isHost = roomStore.currentRoom?.whiteboardHostUid === authStore.uid || msg.metadata?.creatorUid === authStore.uid || msg.senderUid === authStore.uid;
  if (msg.metadata?.isPrivate && !isHost) {
    roomStore.pushToast('Access Restricted', 'This whiteboard is set to private by its creator.', 'warning');
    return;
  }

  // If already viewing this exact asset on open whiteboard and canvas is not blank, no need to reload
  const isCanvasBlank = whiteboardRef.value ? (whiteboardRef.value as any).isBlankCanvas?.() : false;
  if (isWhiteboardOpen.value && activeWhiteboardAssetId.value === msg.id && !isJoiningSharedBoard.value && !isCanvasBlank) {
    roomStore.pushToast('Whiteboard Active', 'This whiteboard is currently open.', 'info');
    return;
  }
  if (isWhiteboardOpen.value && whiteboardRef.value?.hasUnsavedChanges) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
    } catch (e) {
      console.warn('Auto save before opening asset error:', e);
    }
  }

  const isPrivateAsset = !!msg.metadata?.isPrivate;
  const isPublicAsset = !isPrivateAsset && (!!msg.metadata?.wasPublished || !!msg.metadata?.isSharedPost || !msg.metadata?.isPrivate);

  isActiveWhiteboardPrivate.value = isPrivateAsset;
  activeWhiteboardIsPublic.value = isPublicAsset;
  activeWhiteboardCreatorUid.value = msg.metadata?.creatorUid || msg.senderUid || null;

  if (isPrivateAsset) {
    isLocalWhiteboardPublisher.value = false;
    isJoiningSharedBoard.value = false;
  } else {
    // Check if room currently has an active broadcast AND this board is the active shared board:
    const hostUid = roomStore.currentRoom?.whiteboardHostUid;
    const isThisBoardLive = roomStore.currentRoom?.whiteboardActive && (
      (!hostUid || msg.metadata?.creatorUid === hostUid || msg.senderUid === hostUid)
    );
    if (isThisBoardLive) {
      isJoiningSharedBoard.value = true;
      if (hostUid === authStore.uid) {
        isLocalWhiteboardPublisher.value = true;
      }
    } else {
      isJoiningSharedBoard.value = false;
      isLocalWhiteboardPublisher.value = false;
    }
  }

  activeWhiteboardAssetId.value = msg.id;
  currentWhiteboardJson.value = msg.metadata?.whiteboardJson || null;
  whiteboardSessionKey.value = 'wb_asset_' + msg.id + '_' + Date.now();
  isWhiteboardOpen.value = true;
};

// Get participants currently active/viewing a specific whiteboard asset
const getActiveWhiteboardUsers = (assetId: string) => {
  if (!roomStore.currentRoom?.participants) return [];
  const parts = Object.values(roomStore.currentRoom.participants);
  return parts.filter(p => p.status === 'approved' && p.isOnline !== false && p.activeWhiteboardId === assetId);
};

// Sync active public whiteboard presence to participant profile
watch([isWhiteboardOpen, activeWhiteboardAssetId, isActiveWhiteboardPrivate], ([isOpen, assetId, isPrivate]) => {
  if (isOpen && assetId && !isPrivate) {
    roomStore.updateParticipantWhiteboard(assetId);
  } else {
    roomStore.updateParticipantWhiteboard(null);
  }
}, { immediate: true });

const activeAssetTab = ref<'public' | 'personal'>('public');

// All Public Album Items (Shared whiteboards, 3D models, images, moodboards)
const allPublicAlbumItems = computed(() => {
  if (!roomStore.currentRoom?.messages) return [];
  const items = roomStore.currentRoom.messages.filter(m => {
    if (m.type === 'whiteboard_state') {
      // Must NOT be private!
      if (m.metadata?.isPrivate) return false;
      // Must be a published/shared whiteboard
      if (!m.metadata?.wasPublished && !m.metadata?.isSharedPost) return false;
      // Exclude redundant pointer duplicates
      if (m.metadata?.assetId && roomStore.currentRoom?.messages.some(other => other.id === m.metadata.assetId)) {
        return false;
      }
    } else if (m.type !== 'ai_asset' && !(m.type === 'file' && m.fileData?.type === 'image')) {
      return false;
    }
    return true;
  });
  return [...items].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
});

// All Personal Drafts (Current user's own private saved whiteboards)
const allPersonalAlbumItems = computed(() => {
  if (!roomStore.currentRoom?.messages) return [];
  const items = roomStore.currentRoom.messages.filter(m => {
    if (m.type === 'whiteboard_state') {
      const isMine = m.metadata?.creatorUid === authStore.uid || m.senderUid === authStore.uid;
      if (!isMine) return false;
      // Must be private draft! If it's shared/public, it lives strictly in Public Assets
      if (!m.metadata?.isPrivate) return false;
      // Exclude redundant pointer duplicates
      if (m.metadata?.assetId && roomStore.currentRoom?.messages.some(other => other.id === m.metadata.assetId)) {
        return false;
      }
      return true;
    }
    return false;
  });
  return [...items].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
});

const currentTabAllItems = computed(() => {
  return activeAssetTab.value === 'public' ? allPublicAlbumItems.value : allPersonalAlbumItems.value;
});

// Spatial partitioning: visible items in the top grid, hidden items in the bottom section
// Preserves original chronological timestamp ordering
const visibleAlbumItems = computed(() => {
  return currentTabAllItems.value.filter(m => !m.metadata?.isHidden);
});

const hiddenAlbumItems = computed(() => {
  return currentTabAllItems.value.filter(m => !!m.metadata?.isHidden);
});

const publicAlbumItems = computed(() => allPublicAlbumItems.value);
const personalAlbumItems = computed(() => allPersonalAlbumItems.value);

const albumItems = computed(() => {
  return visibleAlbumItems.value;
});

// Client-side thumbnail cache for whiteboard drafts
const draftThumbnails = ref<Record<string, string>>({});
const isProcessingDraft = new Set<string>();

const renderWhiteboardThumbnail = async (jsonStr: string): Promise<string> => {
  if (!jsonStr) return '';
  try {
    const rawData = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    const width = 400;
    const height = 250;

    const canvasEl = document.createElement('canvas');
    canvasEl.width = width;
    canvasEl.height = height;

    const staticCanvas = new fabric.StaticCanvas(canvasEl, {
      width,
      height,
      renderOnAddRemove: false
    });

    await staticCanvas.loadFromJSON(rawData);
    staticCanvas.getObjects().forEach((o: any) => o.setCoords());

    const objs = staticCanvas.getObjects();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    objs.forEach((o: any) => {
      if (o.isSystemObject || o.id === 'workspace-bg') return;
      const br = o.getBoundingRect ? o.getBoundingRect(true) : {
        left: o.left || 0,
        top: o.top || 0,
        width: (o.width || 0) * (o.scaleX || 1),
        height: (o.height || 0) * (o.scaleY || 1)
      };
      if (br.left < minX) minX = br.left;
      if (br.top < minY) minY = br.top;
      if (br.left + br.width > maxX) maxX = br.left + br.width;
      if (br.top + br.height > maxY) maxY = br.top + br.height;
    });

    const hasContent = minX !== Infinity && maxX > minX && maxY > minY;
    let vpt: number[] = [1, 0, 0, 1, 0, 0];

    if (hasContent) {
      const pad = 60;
      const bw = Math.max(100, (maxX - minX) + pad * 2);
      const bh = Math.max(100, (maxY - minY) + pad * 2);
      const scale = Math.min(width / bw, height / bh);

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      vpt = [
        scale, 0,
        0, scale,
        (width / 2) - cx * scale,
        (height / 2) - cy * scale
      ];
    } else {
      // Clean center of standard workspace (3200 x 2000)
      const scale = Math.min(width / 3200, height / 2000);
      vpt = [
        scale, 0,
        0, scale,
        (width / 2) - 1600 * scale,
        (height / 2) - 1000 * scale
      ];
    }

    (staticCanvas as any).setViewportTransform(vpt);
    staticCanvas.renderAll();

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) {
      staticCanvas.dispose();
      return '';
    }

    // Always fill light background so JPEG never turns black
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    if (!hasContent) {
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(20, 20, width - 40, height - 40);
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Blank Canvas', width / 2, height / 2 + 5);
    } else {
      ctx.drawImage(canvasEl, 0, 0);
    }

    const resultDataUrl = outCanvas.toDataURL('image/jpeg', 0.85);
    staticCanvas.dispose();
    return resultDataUrl;
  } catch (e) {
    console.warn('renderWhiteboardThumbnail error:', e);
    const outCanvas = document.createElement('canvas');
    outCanvas.width = 400;
    outCanvas.height = 250;
    const ctx = outCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, 400, 250);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Whiteboard Draft', 200, 130);
      return outCanvas.toDataURL('image/jpeg', 0.85);
    }
    return '';
  }
};

const getAssetThumbnail = (msg: any) => {
  // If memory cache has generated thumbnail, use it
  if (draftThumbnails.value[msg.id]) return draftThumbnails.value[msg.id];

  // If fileData.url exists and is NOT a tiny black data URL artifact (< 3500 bytes)
  if (msg.fileData?.url) {
    if (msg.fileData.url.startsWith('data:image/') && msg.fileData.url.length < 3500) {
      return ''; // Trigger automatic regeneration
    }
    return msg.fileData.url;
  }
  return '';
};

const generateDraftThumbnail = async (msg: any) => {
  if (!msg || !msg.id || isProcessingDraft.has(msg.id)) return;
  const jsonStr = msg.metadata?.whiteboardJson;
  if (!jsonStr) return;

  isProcessingDraft.add(msg.id);
  try {
    const dataUrl = await renderWhiteboardThumbnail(jsonStr);
    if (dataUrl) {
      draftThumbnails.value[msg.id] = dataUrl;

      // Persist good thumbnail to Firestore
      if (msg.metadata?.creatorUid === authStore.uid || msg.senderUid === authStore.uid) {
        await roomStore.updateCustomMessage(msg.id, {
          fileData: {
            name: 'whiteboard.jpg',
            size: 0,
            type: 'image',
            url: dataUrl
          }
        });
      }
    }
  } catch (e) {
    console.warn('Failed to generate draft thumbnail for msg', msg.id, e);
  } finally {
    isProcessingDraft.delete(msg.id);
  }
};

watch(
  () => [currentTabAllItems.value, isAssetsDrawerOpen.value, activeAssetTab.value],
  ([items, isOpen]) => {
    if (!isOpen || !items || !Array.isArray(items)) return;
    items.forEach((m) => {
      if (m.type === 'whiteboard_state' && m.metadata?.whiteboardJson) {
        if (!draftThumbnails.value[m.id] || !getAssetThumbnail(m)) {
          generateDraftThumbnail(m);
        }
      }
    });
  },
  { immediate: true, deep: true }
);

// Eagerly pre-generate thumbnails for all personal drafts in the background so opening the drawer is instantaneous
watch(
  () => allPersonalAlbumItems.value,
  (items) => {
    if (!items || !Array.isArray(items)) return;
    items.forEach((m) => {
      if (m.type === 'whiteboard_state' && m.metadata?.whiteboardJson) {
        if (!draftThumbnails.value[m.id] || !getAssetThumbnail(m)) {
          generateDraftThumbnail(m);
        }
      }
    });
  },
  { immediate: true, deep: true }
);

const pageEnteredAt = ref(Date.now());

// Filtered messages for the main chat stream:
// 1. Exclude all save messages & capsules from auto-saving
// 2. Only show live join notifications occurring while user is on the chat page; past join messages are omitted
const visibleChatMessages = computed(() => {
  if (!roomStore.currentRoom?.messages) return [];
  const all = roomStore.currentRoom.messages;
  
  const joinMsgIds: string[] = [];
  for (const m of all) {
    if (m.senderUid === 'system' && (m.content.includes('joined') || m.content.includes('join'))) {
      if (m.timestamp >= pageEnteredAt.value) {
        joinMsgIds.push(m.id);
      }
    }
  }
  const allowedJoinIds = new Set(joinMsgIds.slice(-3));

  return all.filter(m => {
    // Only show live join notices occurring in the current active session
    if (m.senderUid === 'system' && (m.content.includes('joined') || m.content.includes('join'))) {
      if (m.timestamp < pageEnteredAt.value) return false;
      return allowedJoinIds.has(m.id);
    }

    // Filter out all system save notifications (user request: ignore all save messages)
    if (m.senderUid === 'system') {
      const c = m.content.toLowerCase();
      if (c.includes('saved') || c.includes('updated a shared whiteboard') || c.includes('sketchpad saved') || c.includes('whiteboard saved')) {
        return false;
      }
    }

    // Filter out routine auto-save whiteboard capsules and private drafts from chat, keep only deliberate share posts
    if (m.type === 'whiteboard_state') {
      // Exclude redundant pointer cards
      if (m.metadata?.assetId && roomStore.currentRoom?.messages.some(other => other.id === m.metadata.assetId)) {
        return false;
      }
      // If a whiteboard is private, ONLY show it in chat if it was originally published/shared before.
      // Routine personal drafts and unshared personal boards MUST NEVER appear in the team chat stream!
      if (m.metadata?.isPrivate) {
        if (!m.metadata?.wasPublished) {
          return false;
        }
      }
    }

    return true;
  });
});

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');

const isDrawerOpen = ref(false);
const isAssetsDrawerOpen = ref(false);

const drawerTopOffset = computed(() => {
  return isMeetingClosed.value ? '89px' : '56px';
});

const toggleSettingsDrawer = () => {
  if (isDrawerOpen.value) {
    isDrawerOpen.value = false;
  } else {
    isAssetsDrawerOpen.value = false;
    isDrawerOpen.value = true;
  }
};

const toggleAssetsDrawer = () => {
  if (isAssetsDrawerOpen.value) {
    isAssetsDrawerOpen.value = false;
  } else {
    isDrawerOpen.value = false;
    isAssetsDrawerOpen.value = true;
  }
};

const openUserProfile = () => {
  isDrawerOpen.value = false;
  isAssetsDrawerOpen.value = false;
  isEditProfileOpen.value = true;
};

watch(isDrawerOpen, (isOpen) => {
  if (isOpen) {
    isAssetsDrawerOpen.value = false;
  }
});

watch(isAssetsDrawerOpen, (isOpen) => {
  if (isOpen) {
    isDrawerOpen.value = false;
  } else {
    isManagingAssets.value = false;
  }
});
const inputMessage = ref('');
const copiedUrl = ref(false);
const chatContainerRef = ref<HTMLDivElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const showScrollFab = ref(false);

const isVerifyingAccess = ref(true);
const isScrolling = ref(false);
const isUploadingFile = ref(false);
const previewMediaUrl = ref<string | null>(null);
let scrollbarTimer: any = null;

// Read-only status when closed
const isMeetingClosed = computed(() => roomStore.currentRoom?.roomStatus === 'ended');

// Profile Edit Modal
const isEditProfileOpen = ref(false);
const editName = ref(authStore.displayName);
const editAvatar = ref(authStore.avatar);
const avatarChoices = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];

// Alert Modal state
const alertModal = ref({
  isOpen: false,
  title: '',
  message: '',
  type: 'info' as 'warning'|'info'|'error',
  onConfirm: () => {}
});

// Document Modal state
const isDocModalOpen = ref(false);
const docModalTitle = ref('');
const docModalContent = ref('');

const pdfModal = ref({
  isOpen: false,
  title: '',
  url: ''
});

const openPdfPreview = (title: string, url: string) => {
  pdfModal.value = {
    isOpen: true,
    title,
    url
  };
};

const isGoogleSigningIn = ref(false);
const handleGoogleSignInProfile = async () => {
  if (isGoogleSigningIn.value) return;
  isGoogleSigningIn.value = true;
  try {
    const res = await authStore.upgradeWithGoogle();
    if (res?.previousAnonUid && roomStore.currentRoom) {
      await roomStore.transferHostOwnership(res.previousAnonUid, authStore.uid);
    }
    roomStore.pushToast('Signed In', `Signed in as ${authStore.displayName}`, 'success');
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
      roomStore.pushToast('Sign-In Failed', err?.message || 'Could not complete sign in', 'error');
    }
  } finally {
    isGoogleSigningIn.value = false;
  }
};

const openDocument = (title: string, content: string) => {
  docModalTitle.value = title;
  docModalContent.value = content;
  isDocModalOpen.value = true;
};

const copyInviteLink = () => {
  const url = `${window.location.origin}/#/waiting/${roomId.value}`;
  navigator.clipboard.writeText(url);
  copiedUrl.value = true;
  setTimeout(() => (copiedUrl.value = false), 2000);
};

const scrollToMessage = (id: string) => {
  isAssetsDrawerOpen.value = false;
  setTimeout(() => {
    const el = document.getElementById('msg_' + id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('bg-sky-500/20'); // Highlight background
      setTimeout(() => el.classList.remove('bg-sky-500/20'), 2000);
    }
  }, 300); // Wait for drawer to close
};

const scrollToBottom = () => {
  const scroll = () => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
    }
  };
  nextTick(scroll);
  
  // Progressive retry to handle heavy DOM rendering and image loading
  [50, 150, 300, 600, 1000, 2000].forEach(delay => {
    setTimeout(scroll, delay);
  });
};

watch(isVerifyingAccess, (val) => {
  if (!val) {
    scrollToBottom();
  }
});

watch(() => [roomStore.isAnalyzing, roomStore.isGenerating3D], () => {
  if (roomStore.isAnalyzing || roomStore.isGenerating3D) {
    scrollToBottom();
  }
});

const handleScroll = () => {
  if (chatContainerRef.value) {
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.value;
    showScrollFab.value = scrollHeight - (scrollTop + clientHeight) > 100;
  }
  isScrolling.value = true;
  clearTimeout(scrollbarTimer);
  scrollbarTimer = setTimeout(() => {
    isScrolling.value = false;
  }, 3000);
};

const adjustTextarea = () => {
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
      const newHeight = Math.min(textareaRef.value.scrollHeight, 128);
      textareaRef.value.style.height = `${Math.max(newHeight, 44)}px`;
    }
  });
};

watch(inputMessage, () => {
  adjustTextarea();
});

const isMentionMenuOpen = ref(false);
const mentionQuery = ref('');
const mentionMenuIndex = ref(0);
const mentionMatchStart = ref(-1);

const checkMentionTrigger = () => {
  const el = textareaRef.value;
  if (!el) return;
  const cursorPos = el.selectionStart;
  const textBefore = el.value.slice(0, cursorPos);
  const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
  if (match) {
    mentionQuery.value = match[1].toLowerCase();
    mentionMatchStart.value = textBefore.lastIndexOf('@' + match[1]);
    isMentionMenuOpen.value = true;
    mentionMenuIndex.value = 0;
  } else {
    isMentionMenuOpen.value = false;
    mentionMatchStart.value = -1;
  }
};

const mentionCandidates = computed(() => {
  const q = mentionQuery.value;
  const list: Array<{ id: string; name: string; avatar: string; handle: string; isAi: boolean; subtitle?: string }> = [
    { id: 'mentor', name: 'AI Mentor', avatar: '✨', handle: '@mentor', isAi: true, subtitle: 'Ask AI Design Mentor' }
  ];
  if (roomStore.currentRoom?.participants) {
    for (const [uid, p] of Object.entries(roomStore.currentRoom.participants)) {
      if (p.status === 'approved') {
        list.push({
          id: uid,
          name: p.displayName || 'Participant',
          avatar: p.avatar || '👤',
          handle: `@${p.displayName || 'Participant'}`,
          isAi: false,
          subtitle: p.isHost ? 'Host' : 'Member'
        });
      }
    }
  }
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q));
});

const selectMentionCandidate = (candidate: { handle: string }) => {
  const el = textareaRef.value;
  if (!el || mentionMatchStart.value === -1) return;
  const before = inputMessage.value.slice(0, mentionMatchStart.value);
  const after = inputMessage.value.slice(el.selectionStart);
  const insertText = `${candidate.handle} `;
  inputMessage.value = before + insertText + after;
  isMentionMenuOpen.value = false;
  nextTick(() => {
    el.focus();
    const newPos = before.length + insertText.length;
    el.setSelectionRange(newPos, newPos);
    adjustTextarea();
  });
};

const onInputTextarea = () => {
  adjustTextarea();
  roomStore.setMyTyping(true);
  checkMentionTrigger();
};

const formatTypingText = (users: { displayName: string }[]) => {
  if (users.length === 1) {
    return `${users[0].displayName} is typing...`;
  }
  if (users.length === 2) {
    return `${users[0].displayName} and ${users[1].displayName} are typing...`;
  }
  return `${users[0].displayName} and ${users.length - 1} others are typing...`;
};

interface StagedAttachment {
  file: File;
  name: string;
  size: number;
  type: 'image' | 'video' | 'document';
  previewUrl?: string;
  dataUrl?: string;
  mimeType: string;
  isOverLimit: boolean;
}

const stagedAttachment = ref<StagedAttachment | null>(null);
const replyingToMessage = ref<MessageItem | null>(null);

const replyToMessage = (msg: MessageItem) => {
  replyingToMessage.value = msg;
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.focus();
    }
  });
};

const copyMessageContent = (msg: MessageItem) => {
  if (msg.content) {
    navigator.clipboard.writeText(msg.content);
    roomStore.pushToast('Copied', 'Message copied to clipboard', 'success');
  }
};

const expandedMessages = ref<Record<string, boolean>>({});
const isMessageExpanded = (id: string) => !!expandedMessages.value[id];
const toggleMessageExpanded = (id: string) => {
  expandedMessages.value[id] = !expandedMessages.value[id];
};

const shouldShowCollapseToggle = (msg: MessageItem) => {
  return msg.senderUid !== 'ai_mentor' && (msg.content?.length || 0) > 260;
};

const getDisplayMessageContent = (msg: MessageItem) => {
  if (shouldShowCollapseToggle(msg) && !isMessageExpanded(msg.id)) {
    return msg.content.slice(0, 260) + '...';
  }
  return msg.content;
};

// Date Separator for Chat Stream (When crossing calendar days)
const shouldShowDateDivider = (msg: MessageItem, index: number) => {
  if (index === 0) return true;
  const prevMsg = visibleChatMessages.value[index - 1];
  if (!prevMsg) return true;
  const currDate = new Date(msg.timestamp).toDateString();
  const prevDate = new Date(prevMsg.timestamp).toDateString();
  return currDate !== prevDate;
};

const formatMessageDate = (timestamp: number) => {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
};

// Web Audio Notification Chime & Mute State
const isSoundMuted = ref(localStorage.getItem('ai_mentor_sound_muted') === 'true');
const toggleSoundMute = () => {
  isSoundMuted.value = !isSoundMuted.value;
  localStorage.setItem('ai_mentor_sound_muted', String(isSoundMuted.value));
};

const playNotificationSound = () => {
  if (isSoundMuted.value) return;
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.08);

    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.08);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.32);
  } catch {
    // ignore audio policy restrictions
  }
};

const isMentioningMe = (msg: MessageItem) => {
  if (!msg || !msg.content || !authStore.displayName) return false;
  const contentLower = msg.content.toLowerCase();
  const nameLower = authStore.displayName.toLowerCase().trim();
  const uidLower = authStore.uid.toLowerCase();
  return (
    contentLower.includes(`@${nameLower}`) ||
    contentLower.includes(`@${uidLower}`)
  );
};

let lastKnownMsgCount = 0;
watch(() => roomStore.currentRoom?.messages.length, (newCount) => {
  if (newCount && lastKnownMsgCount && newCount > lastKnownMsgCount) {
    const latest = roomStore.currentRoom?.messages[roomStore.currentRoom.messages.length - 1];
    if (latest && latest.senderUid !== authStore.uid && latest.senderUid !== 'system') {
      playNotificationSound();
      if (isMentioningMe(latest)) {
        roomStore.pushToast(
          latest.senderUid === 'ai_mentor' ? '✨ AI Mentor tagged you' : `💬 ${latest.senderName} tagged you`,
          latest.content.slice(0, 100),
          'info'
        );
      }
    }
  }
  lastKnownMsgCount = newCount || 0;
});

const handleSend = async () => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;

  const text = inputMessage.value.trim();
  const attachment = stagedAttachment.value;

  if (!text && !attachment) return;

  const replyPayload = replyingToMessage.value ? {
    id: replyingToMessage.value.id,
    senderName: replyingToMessage.value.senderName,
    text: replyingToMessage.value.content.slice(0, 100)
  } : undefined;

  inputMessage.value = '';
  stagedAttachment.value = null;
  replyingToMessage.value = null;

  if (textareaRef.value) {
    textareaRef.value.style.height = '44px';
  }

  if (attachment) {
    await roomStore.sendFileMessage(
      {
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        url: attachment.dataUrl || attachment.previewUrl || '',
        mimeType: attachment.mimeType
      },
      text
    );
  } else if (text) {
    await roomStore.sendMessage(text, replyPayload);
  }

  scrollToBottom();
};

const handleTextareaKeyDown = (e: KeyboardEvent) => {
  if (e.isComposing || (e as any).keyCode === 229) return;

  if (isMentionMenuOpen.value && mentionCandidates.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionMenuIndex.value = (mentionMenuIndex.value + 1) % mentionCandidates.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionMenuIndex.value = (mentionMenuIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectMentionCandidate(mentionCandidates.value[mentionMenuIndex.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      isMentionMenuOpen.value = false;
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

const activeCustomPollInput = ref<Record<string, boolean>>({});
const customPollText = ref<Record<string, string>>({});

const getOptionVoters = (msg: MessageItem, option: string) => {
  if (!msg.pollVotes) return [];
  return Object.values(msg.pollVotes).filter((v) => v && v.option === option);
};

const isMyVote = (msg: MessageItem, option: string) => {
  if (!msg.pollVotes || !authStore.uid) return false;
  return msg.pollVotes[authStore.uid]?.option === option;
};

const handleVoteOption = async (messageId: string, option: string) => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;
  await roomStore.votePollOption(messageId, option);
};

const handleAddCustomOption = async (messageId: string) => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;
  const text = customPollText.value[messageId]?.trim();
  if (!text) return;
  await roomStore.addCustomPollOption(messageId, text);
  customPollText.value[messageId] = '';
  activeCustomPollInput.value[messageId] = false;
};

const handleSendQuickThumbsUp = async () => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;
  await roomStore.sendMessage('👍');
  nextTick(() => {
    scrollToBottom();
  });
};

const handleSendOption = async (option: string) => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;
  await roomStore.sendMessage(option);
  nextTick(() => {
    scrollToBottom();
  });
};

const handleRefineModel = async (msg: MessageItem, customPrompt?: string) => {
  if (isMeetingClosed.value) return;
  await roomStore.refineMeshyModel(msg, customPrompt);
};

import { marked } from 'marked';
import DOMPurify from 'dompurify';

const formatMessageText = (text: string) => {
  if (!text) return '';

  // Check if text has markdown blocks: headers, lists, codeblocks, blockquotes, tables, or multiple paragraphs
  const hasMarkdownBlocks = /^(?:#{1,6}\s|```|[-*+]\s|\d+\.\s|>\s|\|)/m.test(text) || text.includes('\n\n');

  let rawHtml: string;
  if (!hasMarkdownBlocks) {
    // Standard chat message or single paragraph:
    // parse inline to retain links, bold, italics, inline code, @mentions
    // and map single newlines to <br> without wrapping in <p>...</p>\n
    rawHtml = marked.parseInline(text, { breaks: true, gfm: true }) as string;
  } else {
    // Multi-paragraph or structured markdown (e.g. AI mentor structured output, tables, code blocks):
    rawHtml = (marked.parse(text, { breaks: true, gfm: true }) as string).trim();
  }

  // Make links open in new tab and styled correctly
  const styledHtml = rawHtml.replace(/<a href="/g, '<a target="_blank" rel="noopener noreferrer" class="text-sky-400 hover:underline font-semibold pointer-events-auto" data-link="true" href="');
  return DOMPurify.sanitize(styledHtml, { ADD_ATTR: ['target', 'data-link'] });
};

const reactionEmojiList = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

const getEmojiVoters = (msg: MessageItem, emoji: string): string[] => {
  return msg.reactions?.[emoji] || [];
};

const isEmojiSelectedByMe = (msg: MessageItem, emoji: string): boolean => {
  return (msg.reactions?.[emoji] || []).includes(authStore.uid);
};

const hasActiveReactions = (msg: MessageItem): boolean => {
  if (!msg.reactions) return false;
  return Object.values(msg.reactions).some(uids => Array.isArray(uids) && uids.length > 0);
};

const handleMessageClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'A' && target.dataset.link) {
    // Let the browser open it in a new tab naturally
    return;
  }
};

// Image Compression (Max 1200px, JPEG 0.75)
const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(e.target?.result as string);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const stageFile = async (file: File) => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;

  isUploadingFile.value = true;
  try {
    let fileType: 'image' | 'video' | 'document' = 'document';
    let dataUrl = '';
    let isOverLimit = false;

    if (file.type.startsWith('image/')) {
      fileType = 'image';
      dataUrl = await compressImage(file);
    } else if (file.type.startsWith('video/')) {
      fileType = 'video';
      if (file.size > 15 * 1024 * 1024) {
        roomStore.pushToast('Video Too Large', 'Please keep video size under 15MB.', 'warning');
        isUploadingFile.value = false;
        return;
      }

      // Check duration <= 30 seconds
      const duration = await new Promise<number>((res) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => {
          window.URL.revokeObjectURL(v.src);
          res(v.duration);
        };
        v.onerror = () => res(0);
        v.src = URL.createObjectURL(file);
      });

      if (duration > 32) {
        roomStore.pushToast('Video Too Long', `Video is ${Math.round(duration)}s long. Please keep under 30 seconds.`, 'warning');
        isUploadingFile.value = false;
        return;
      }

      dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
    } else {
      // Document (PDF, Word, TXT, etc.)
      fileType = 'document';
      if (file.size > 10 * 1024 * 1024) {
        roomStore.pushToast('Document Too Large', 'Please keep documents under 10MB.', 'warning');
        isUploadingFile.value = false;
        return;
      }
      dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
    }

    stagedAttachment.value = {
      file,
      name: file.name,
      size: file.size,
      type: fileType,
      previewUrl: fileType === 'image' ? dataUrl : undefined,
      dataUrl,
      mimeType: file.type || 'application/octet-stream',
      isOverLimit: false
    };
  } catch (err) {
    console.error('File staging error:', err);
    roomStore.pushToast('File Error', 'Could not prepare attachment.', 'error');
  } finally {
    isUploadingFile.value = false;
    if (fileInputRef.value) fileInputRef.value.value = '';
  }
};

const triggerFileInput = () => {
  if (isMeetingClosed.value) return;
  fileInputRef.value?.click();
};

const onFileSelected = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  await stageFile(input.files[0]);
};

const handlePaste = async (e: ClipboardEvent) => {
  if (isMeetingClosed.value) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      const file = items[i].getAsFile();
      if (file) {
        e.preventDefault();
        await stageFile(file);
        break;
      }
    }
  }
};

const insertQuickTag = (tag: string) => {
  if (isMeetingClosed.value) return;
  const el = textareaRef.value;
  if (el) {
    el.focus();
    const curVal = el.value;
    const prefix = curVal && !curVal.endsWith(' ') && !curVal.endsWith('\n') ? ' ' : '';
    const textToInsert = `${prefix}${tag} `;

    let success = false;
    try {
      // document.execCommand natively preserves the browser's textarea undo/redo stack (Ctrl+Z)
      success = document.execCommand('insertText', false, textToInsert);
    } catch {
      success = false;
    }

    if (success) {
      inputMessage.value = el.value;
    } else {
      inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
      nextTick(() => {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    }
  } else {
    inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
  }
  adjustTextarea();
};

const handleUnload = () => {
  roomStore.leaveRoom();
};

const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    roomStore.sendHeartbeat();
  }
};

const handleSaveProfile = () => {
  if (editName.value.trim()) {
    roomStore.updateParticipantProfile(editName.value.trim(), editAvatar.value);
  }
  isEditProfileOpen.value = false;
};

// Watch for muted state to trigger Toast
watch(
  () => roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted,
  (newVal, oldVal) => {
    if (newVal === true && oldVal === false) {
      roomStore.pushToast('Microphone Muted', 'You have been muted by the host.', 'warning');
    }
  }
);

// Watch for kicked state
watch(() => roomStore.myStatus, (newStatus) => {
  if (newStatus === 'kicked') {
    alertModal.value = {
      isOpen: true,
      title: 'Removed from Meeting',
      message: 'You have been removed from the meeting by the host.',
      type: 'warning',
      onConfirm: () => {
        alertModal.value.isOpen = false;
        router.replace(`/waiting/room_${pin}`);
      }
    };
  }
});

watch(() => roomStore.currentRoom?.messages?.length, (newLen, oldLen) => {
  if (newLen && newLen !== oldLen) {
    if (!showScrollFab.value) {
      scrollToBottom();
    }
  }
}, { immediate: true });

let accessCheckTimer: any = null;

onMounted(async () => {
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('pagehide', handleUnload);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAssetsDrawerOpen.value) {
      isAssetsDrawerOpen.value = false;
    }
  });

  // 1. Verify meeting exists
  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    roomStore.pushToast('Meeting Not Found', `Meeting room ${pin} does not exist or has been deleted.`, 'error');
    router.replace(authStore.isGoogleLinked ? '/dashboard' : '/');
    return;
  }

  // 2. Start listener & heartbeat
  roomStore.startFirestoreListener(roomId.value);

  // 3. Reactive Security Access Verification
  const checkMyAccess = () => {
    if (!roomStore.currentRoom) return;
    const isHost = roomStore.currentRoom.hostUid === authStore.uid;
    const myStatus = roomStore.myStatus;

    if (isHost || myStatus === 'approved') {
      isVerifyingAccess.value = false;
      clearTimeout(accessCheckTimer);
      scrollToBottom();
    } else if (myStatus === 'rejected' || myStatus === 'kicked') {
      roomStore.stopListening();
      router.replace(`/waiting/room_${pin}`);
    }
  };

  watch(() => roomStore.myStatus, () => {
    checkMyAccess();
  });

  // Safety fallback after 6s (only if still unresolved)
  accessCheckTimer = setTimeout(() => {
    if (isVerifyingAccess.value) {
      const isHost = roomStore.currentRoom?.hostUid === authStore.uid;
      const me = roomStore.currentRoom?.participants?.[authStore.uid];
      if (!isHost && me?.status !== 'approved') {
        roomStore.stopListening();
        router.replace(`/waiting/room_${pin}`);
      } else {
        isVerifyingAccess.value = false;
      }
    }
  }, 6000);
});

const handleWhiteboardBeforeUnload = (e: BeforeUnloadEvent) => {
  if (isWhiteboardOpen.value && roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
    whiteboardRef.value?.triggerAutoSaveAsAsset();
    roomStore.endWhiteboardSession();
    return;
  }
};

onBeforeRouteLeave(async (to, from, next) => {
  if (isWhiteboardOpen.value && roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
      await roomStore.endWhiteboardSession();
    } catch (err) {
      console.error('Error auto-saving whiteboard on navigation leave:', err);
    }
    next();
    return;
  }
  if (isWhiteboardOpen.value && whiteboardRef.value?.hasUnsavedChanges) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
    } catch (err) {
      console.error('Error auto-saving whiteboard on navigation leave:', err);
    }
  }
  next();
});

onMounted(() => {
  window.addEventListener('beforeunload', handleWhiteboardBeforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', handleWhiteboardBeforeUnload);
  if (roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
    whiteboardRef.value?.triggerAutoSaveAsAsset();
    roomStore.endWhiteboardSession();
  }

  window.removeEventListener('beforeunload', handleUnload);
  window.removeEventListener('pagehide', handleUnload);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  clearTimeout(scrollbarTimer);
  clearTimeout(accessCheckTimer);
  roomStore.updateParticipantWhiteboard(null);
  roomStore.stopListening();
});
</script>

<template>
  <!-- Access verification loading screen -->
  <div v-if="isVerifyingAccess" class="h-[100dvh] flex flex-col items-center justify-center bg-slate-950 text-slate-400">
    <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mb-3"></div>
    <p class="text-xs">Verifying credentials & permissions...</p>
  </div>

  <div v-else class="h-[100dvh] flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
    <!-- Read-Only Archive Notice Bar (When closed) -->
    <div
      v-if="isMeetingClosed"
      class="bg-amber-950/70 border-b border-amber-500/30 px-3 sm:px-4 py-2 text-center text-xs text-amber-300 flex items-center justify-center gap-1.5 shrink-0 z-40 relative"
    >
      <Lock class="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span class="truncate">Meeting closed by host (Read-only).</span>
      <button
        v-if="roomStore.isHost"
        @click="toggleSettingsDrawer"
        class="underline font-semibold hover:text-white ml-1 cursor-pointer shrink-0"
      >
        Reopen
      </button>
    </div>

    <!-- Top Navigation Bar -->
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-2.5 sm:px-5 flex items-center justify-between z-40 shrink-0 gap-2 relative">
      <div class="flex items-center gap-1.5 sm:gap-2 min-w-0">
        <router-link
          :to="authStore.isGoogleLinked ? '/dashboard' : '/'"
          class="p-2 sm:p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0"
          :title="authStore.isGoogleLinked ? 'Back to Dashboard' : 'Back to Home'"
        >
          <ArrowLeft class="w-4 h-4" />
        </router-link>

        <div class="min-w-0">
          <div
            class="flex items-center gap-1.5 cursor-pointer group"
            @click="toggleSettingsDrawer"
            :title="roomStore.isHost ? 'Click to edit room name & avatar in Settings' : 'Room settings'"
          >
            <span class="text-base sm:text-lg select-none shrink-0 group-hover:scale-110 transition-transform">{{ roomStore.currentRoom?.roomEmoji || '💡' }}</span>
            <h1 class="font-bold text-xs sm:text-base text-white truncate max-w-[110px] xs:max-w-[160px] sm:max-w-xs group-hover:text-sky-300 transition-colors">
              {{ roomStore.currentRoom?.roomName || 'Meeting' }}
            </h1>
            <Edit3 v-if="roomStore.isHost" class="w-3 h-3 text-slate-500 group-hover:text-sky-400 hidden sm:inline transition-colors shrink-0" />
            <span class="font-mono text-[10px] sm:text-[11px] px-1.5 sm:px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-sky-400 shrink-0">
              {{ pin }}
            </span>
            <span
              v-if="isMeetingClosed"
              class="text-[9px] sm:text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-medium shrink-0"
            >
              Archived
            </span>
          </div>
          <div class="text-[10px] sm:text-[11px] text-slate-400 flex items-center gap-1.5 sm:gap-2">
            <span class="flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              {{ roomStore.onlineParticipants.length }} / {{ roomStore.approvedParticipants.length }} Online
            </span>
            <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● Host</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-1 sm:gap-1.5 shrink-0">
        <!-- Network Offline Warning Pill -->
        <div
          v-if="!roomStore.isOnline"
          class="flex items-center gap-1 px-2 py-1 rounded-full bg-rose-950/80 border border-rose-500/50 text-[10px] text-rose-300 font-medium animate-pulse"
          title="Network offline"
        >
          <WifiOff class="w-3 h-3 text-rose-400" />
          <span class="hidden xs:inline">Offline</span>
        </div>

        <!-- AI Status Capsule (Desktop/Tablet) -->
        <button
          @click="toggleSettingsDrawer"
          class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition cursor-pointer"
          :class="{
            'bg-sky-950/50 border-sky-500/40 text-sky-300 hover:bg-sky-900/50': roomStore.aiStatus === 'idle',
            'bg-amber-950/60 border-amber-500/50 text-amber-300 animate-pulse': roomStore.aiStatus === 'analyzing',
            'bg-slate-900 border-slate-700 text-slate-400': roomStore.aiStatus === 'cooldown',
            'bg-rose-950/60 border-rose-500/50 text-rose-300': roomStore.aiStatus === 'error'
          }"
          :title="'AI Mentor: ' + roomStore.aiStatusDetail + ' (Click to configure)'"
        >
          <Sparkles v-if="roomStore.aiStatus === 'idle'" class="w-3 h-3 text-sky-400" />
          <span v-else-if="roomStore.aiStatus === 'analyzing'" class="relative flex h-2 w-2">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
          <span v-else-if="roomStore.aiStatus === 'cooldown'" class="text-[10px]">⏳</span>
          <AlertCircle v-else class="w-3 h-3 text-rose-400" />
          <span class="max-w-[130px] truncate text-[11px]">{{ roomStore.aiStatusDetail }}</span>
        </button>

        <!-- User Profile Pill (Click to edit) -->
        <button
          @click="openUserProfile"
          class="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition text-xs cursor-pointer min-h-[36px]"
          title="Change name or avatar"
        >
          <span class="text-sm">{{ authStore.avatar }}</span>
          <span class="hidden sm:inline font-medium truncate max-w-[80px]">{{ authStore.displayName }}</span>
          <Edit3 class="w-3 h-3 text-slate-400 hidden sm:inline" />
        </button>

        <!-- Copy Invite Link -->
        <button
          @click="copyInviteLink"
          class="inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition cursor-pointer min-h-[36px]"
          title="Copy invite link"
        >
          <Check v-if="copiedUrl" class="w-3.5 h-3.5 text-emerald-400" />
          <Copy v-else class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">{{ copiedUrl ? 'Copied!' : 'Invite' }}</span>
        </button>

        <!-- Notification Sound Mute Toggle -->
        <button
          @click="toggleSoundMute"
          class="inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 transition cursor-pointer min-h-[36px]"
          :class="isSoundMuted ? 'text-slate-500' : 'text-sky-400'"
          :title="isSoundMuted ? 'Notification sound: Muted (Click to unmute)' : 'Notification sound: Active (Click to mute)'"
        >
          <BellOff v-if="isSoundMuted" class="w-3.5 h-3.5" />
          <Bell v-else class="w-3.5 h-3.5" />
        </button>

        <!-- Album / Assets Drawer Button -->
        <button
          @click="toggleAssetsDrawer"
          class="relative inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border transition cursor-pointer min-h-[36px]"
          :class="isAssetsDrawerOpen ? 'border-amber-500/60 bg-amber-500/20 text-amber-300 shadow-xs' : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-amber-400 font-medium'"
          title="Assets Library"
        >
          <Box class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Assets</span>
        </button>

        <!-- Controls Drawer Button -->
        <button
          @click="toggleSettingsDrawer"
          class="relative inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg font-semibold shadow transition cursor-pointer min-h-[36px]"
          :class="isDrawerOpen ? 'bg-sky-500 text-white ring-2 ring-sky-400/40 shadow-md' : 'bg-sky-600 hover:bg-sky-500 text-white'"
          title="Room Settings & Members"
        >
          <Sliders class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Settings</span>
          <!-- Pending Badge -->
          <span
            v-if="roomStore.pendingParticipants.length > 0"
            class="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-slate-950 font-bold text-[9px] rounded-full flex items-center justify-center animate-bounce shadow-md"
          >
            {{ roomStore.pendingParticipants.length }}
          </span>
        </button>
      </div>
    </header>

    <div class="flex-1 flex overflow-hidden w-full relative" :class="{ 'select-none': isResizingWhiteboard }">
      <!-- Fullscreen drag overlay to prevent canvas mouse capture while resizing -->
      <div v-if="isResizingWhiteboard" class="fixed inset-0 z-50 cursor-col-resize pointer-events-auto"></div>

      <div class="flex flex-col h-full w-full min-w-0"
           :class="[
             isResizingWhiteboard ? 'transition-none' : 'transition-all duration-75',
             isWhiteboardOpen ? 'hidden sm:flex sm:flex-1 sm:min-w-[260px]' : 'flex-1'
           ]">
      <!-- Chat Stream Area with 3-second fading scrollbar -->
      <main
        ref="chatContainerRef"
        @scroll="handleScroll"
      class="flex-1 overflow-y-auto w-full relative custom-scrollbar"
      :class="{ 'is-scrolling': isScrolling }"
    >
      <div class="max-w-5xl mx-auto w-full p-3 sm:p-5 space-y-3">
        <div
          v-for="(msg, idx) in visibleChatMessages"
          :key="msg.id"
          :id="'msg_' + msg.id"
          class="transition-colors duration-500 rounded-xl"
        >
          <!-- Date Separator when crossing calendar days -->
          <div v-if="shouldShowDateDivider(msg, idx)" class="flex items-center justify-center my-3.5 gap-3 select-none">
            <div class="h-px bg-slate-700/40 flex-1 max-w-[120px] sm:max-w-[160px]"></div>
            <span class="text-[11px] font-mono font-medium text-slate-500 tracking-wider">
              {{ formatMessageDate(msg.timestamp) }}
            </span>
            <div class="h-px bg-slate-700/40 flex-1 max-w-[120px] sm:max-w-[160px]"></div>
          </div>

        <!-- Centered Subtle System Status Pill -->
        <div v-if="msg.senderUid === 'system'" class="flex justify-center my-2.5">
          <div class="px-3.5 py-1 rounded-full bg-slate-900/70 border border-slate-800/80 text-[11px] text-slate-400 font-medium shadow-xs text-center max-w-md">
            {{ msg.content }}
          </div>
        </div>

        <!-- Normal User or AI Chat Bubble -->
        <div
          v-else
          class="flex gap-2.5 group relative"
          :class="msg.senderUid === authStore.uid ? 'flex-row-reverse' : ''"
        >
          <!-- Avatar -->
          <div
            class="w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0 select-none shadow"
            :class="{
              'bg-sky-500/20 border border-sky-400/40': msg.senderUid === 'ai_mentor',
              'bg-slate-800 border border-slate-700': msg.senderUid !== 'ai_mentor'
            }"
          >
            {{ msg.senderAvatar }}
          </div>

          <!-- Message Body -->
          <div
            class="flex flex-col min-w-0 group/msg relative"
            :class="[
              msg.senderUid === authStore.uid ? 'items-end' : 'items-start',
              msg.type === 'ai_asset' ? 'w-full max-w-full sm:max-w-3xl' : 'max-w-[85%] sm:max-w-[75%] md:max-w-[70%]'
            ]"
          >
            <!-- Sender info (Self: [11:25] [You], Others: [Name] [11:25]) -->
            <div class="flex items-center gap-1.5 mb-0.5 text-[11px] text-slate-400">
              <template v-if="msg.senderUid === authStore.uid">
                <span class="text-[9px] text-slate-500/70 font-mono tracking-wider">
                  {{ new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                </span>
                <span class="font-medium text-slate-300 truncate">{{ msg.senderName }}</span>
              </template>
              <template v-else>
                <span class="font-medium text-slate-300 truncate">{{ msg.senderName }}</span>
                <span class="text-[9px] text-slate-500/70 font-mono tracking-wider">
                  {{ new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                </span>
                <span
                  v-if="msg.senderUid === 'ai_mentor'"
                  class="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-1.5 py-0.2 rounded-md font-mono"
                >
                  AI Mentor
                </span>
              </template>
            </div>

            <!-- Frameless Media Container (When message has image/video and no caption text) -->
            <div
              v-if="msg.type === 'file' && msg.fileData && (msg.fileData.type === 'image' || msg.fileData.type === 'video') && !msg.content"
              class="rounded-2xl overflow-hidden max-w-sm shadow-md hover:shadow-xl transition"
            >
              <!-- Hidden Image Placeholder in Chat -->
              <div
                v-if="msg.fileData.type === 'image' && msg.metadata?.isHidden"
                class="w-52 h-32 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col items-center justify-center p-3 text-center text-xs text-slate-400 select-none shadow"
              >
                <EyeOff class="w-5 h-5 text-slate-500 mb-1.5" />
                <span class="font-medium text-slate-300">This image has been hidden from assets</span>
              </div>

              <!-- Image Preview (Frameless) -->
              <div
                v-else-if="msg.fileData.type === 'image'"
                class="cursor-pointer group rounded-2xl overflow-hidden"
                @click="previewMediaUrl = msg.fileData.url"
                title="Click to expand"
              >
                <img
                  :src="msg.fileData.url"
                  alt="Attachment"
                  class="w-full h-auto max-h-72 object-cover group-hover:scale-105 transition duration-300 rounded-2xl"
                  loading="lazy"
                />
              </div>

              <!-- Video Player (Frameless) -->
              <div v-else-if="msg.fileData.type === 'video'" class="rounded-2xl overflow-hidden">
                <video :src="msg.fileData.url" controls class="w-full max-h-72 rounded-2xl" preload="metadata"></video>
              </div>
            </div>

            <!-- Bubble Content (for text, documents, assets, or media with captions) -->
            <div
              v-else
              class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed shadow break-words min-w-0 w-fit max-w-full transition-all duration-200"
              :class="[
                msg.senderUid === authStore.uid ? 'bg-sky-600 text-white rounded-tr-xs' : '',
                msg.senderUid !== authStore.uid && msg.senderUid !== 'ai_mentor' ? 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-xs' : '',
                msg.senderUid === 'ai_mentor' ? 'bg-sky-950/50 border border-sky-500/40 text-sky-100 rounded-tl-xs shadow-sky-950/30' : '',
                isMentioningMe(msg) ? 'ring-2 ring-amber-400/90 bg-amber-950/35 border-amber-500/60 shadow-amber-900/20 shadow-lg' : '',
                msg.replyTo ? 'min-w-[180px] sm:min-w-[200px]' : '',
                msg.type === 'ai_asset' ? 'w-full' : ''
              ]"
            >
              <!-- Mentioned You Badge -->
              <div v-if="isMentioningMe(msg)" class="inline-flex items-center gap-1 mb-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 select-none">
                <span>@ You were mentioned</span>
              </div>

              <!-- Quote reply preview if this message replies to someone -->
              <div
                v-if="msg.replyTo"
                class="mb-2 px-2.5 py-1 rounded-lg bg-black/35 border-l-2 border-sky-400 text-xs text-slate-300 select-none min-w-0 max-w-full overflow-hidden"
              >
                <div class="font-semibold text-[10px] text-sky-300 truncate whitespace-nowrap overflow-hidden text-ellipsis">{{ msg.replyTo.senderName }}</div>
                <div class="truncate text-[11px] opacity-80 whitespace-nowrap overflow-hidden text-ellipsis">{{ msg.replyTo.text }}</div>
              </div>

              <!-- Message Text (Collapsible if > 260 chars) -->
              <div
                v-if="msg.content && (!msg.type.startsWith('file') || (!msg.content.startsWith('Shared image:') && !msg.content.startsWith('Shared video:') && !msg.content.startsWith('Shared document:')))"
                class="break-words max-w-none message-content"
                :class="msg.senderUid === authStore.uid ? 'text-white' : 'text-slate-200'"
              >
                <div
                  v-html="formatMessageText(getDisplayMessageContent(msg))"
                  @click="handleMessageClick"
                ></div>
                <button
                  v-if="shouldShowCollapseToggle(msg)"
                  @click="toggleMessageExpanded(msg.id)"
                  class="mt-1 inline-flex items-center gap-0.5 text-xs text-sky-400 hover:text-sky-300 font-medium underline cursor-pointer"
                >
                  <component :is="isMessageExpanded(msg.id) ? ChevronUp : ChevronDown" class="w-3 h-3" />
                  {{ isMessageExpanded(msg.id) ? 'Show less' : 'Show more' }}
                </button>
              </div>
              
              <!-- AI Action Options / Interactive Polls & Voting Card -->
              <div
                v-if="msg.actionOptions && msg.actionOptions.length > 0"
                class="mt-3 p-2.5 rounded-xl bg-slate-950/70 border border-sky-500/25 shadow-inner"
              >
                <div class="flex items-center justify-between gap-2 mb-2 px-1 text-[11px] font-semibold text-sky-300">
                  <div class="flex items-center gap-1.5">
                    <Sparkles class="w-3.5 h-3.5 text-sky-400" />
                    <span>Interactive Poll & Decisions</span>
                  </div>
                  <span class="text-[10px] text-slate-400 font-normal">
                    {{ Object.keys(msg.pollVotes || {}).length }} voted
                  </span>
                </div>

                <div class="space-y-1.5">
                  <div
                    v-for="(option, idx) in msg.actionOptions"
                    :key="idx"
                    @click="handleVoteOption(msg.id, option)"
                    class="group relative flex items-center justify-between p-2 rounded-lg border transition-all cursor-pointer text-xs"
                    :class="[
                      isMyVote(msg, option)
                        ? 'bg-sky-500/20 border-sky-400 text-sky-100 ring-1 ring-sky-400/50 shadow-sm'
                        : 'bg-slate-900/90 border-slate-800 hover:border-slate-700 text-slate-300 hover:bg-slate-800/80'
                    ]"
                  >
                    <!-- Left: Choice text and radio indicator -->
                    <div class="flex items-center gap-2 min-w-0 pr-2">
                      <div
                        class="w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition"
                        :class="isMyVote(msg, option) ? 'border-sky-400 bg-sky-500 text-slate-950' : 'border-slate-600 bg-slate-800'"
                      >
                        <CheckCircle2 v-if="isMyVote(msg, option)" class="w-3 h-3 text-slate-950 stroke-[3]" />
                      </div>
                      <span class="truncate font-medium">{{ option }}</span>
                    </div>

                    <!-- Right: Voter Avatar Badges & Count -->
                    <div class="flex items-center gap-1.5 shrink-0">
                      <div
                        v-if="getOptionVoters(msg, option).length > 0"
                        class="flex -space-x-1.5 overflow-hidden py-0.5"
                      >
                        <span
                          v-for="voter in getOptionVoters(msg, option).slice(0, 4)"
                          :key="voter.uid"
                          :title="voter.name"
                          class="inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-900 bg-slate-800 text-[10px] select-none shadow-xs"
                        >
                          {{ voter.avatar || '👤' }}
                        </span>
                        <span
                          v-if="getOptionVoters(msg, option).length > 4"
                          class="inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-900 bg-slate-700 text-[9px] font-bold text-slate-200"
                        >
                          +{{ getOptionVoters(msg, option).length - 4 }}
                        </span>
                      </div>
                      <span
                        v-if="getOptionVoters(msg, option).length > 0"
                        class="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        :class="isMyVote(msg, option) ? 'bg-sky-500/30 text-sky-200' : 'bg-slate-800 text-slate-400'"
                      >
                        {{ getOptionVoters(msg, option).length }}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Custom Option Input / Toggle -->
                <div class="mt-2 pt-2 border-t border-slate-800/80">
                  <div v-if="!activeCustomPollInput[msg.id]">
                    <button
                      type="button"
                      @click="activeCustomPollInput[msg.id] = true"
                      class="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 font-medium cursor-pointer transition px-1 py-0.5"
                    >
                      <Plus class="w-3.5 h-3.5" />
                      <span>Add custom idea / vote option</span>
                    </button>
                  </div>
                  <div v-else class="flex items-center gap-1.5 mt-1">
                    <input
                      v-model="customPollText[msg.id]"
                      @keydown.enter.prevent="handleAddCustomOption(msg.id)"
                      type="text"
                      placeholder="Type your own option idea..."
                      class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                      autofocus
                    />
                    <button
                      type="button"
                      @click="handleAddCustomOption(msg.id)"
                      :disabled="!customPollText[msg.id]?.trim()"
                      class="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition shadow"
                    >
                      Add & Vote
                    </button>
                    <button
                      type="button"
                      @click="activeCustomPollInput[msg.id] = false"
                      class="p-1 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 cursor-pointer"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Embedded File / Media Attachment -->
              <div v-if="msg.type === 'file' && msg.fileData" :class="{ 'mt-2': msg.content }">
                <!-- Image Preview (Inside bubble when caption is present) -->
                <div
                  v-if="msg.fileData.type === 'image'"
                  class="rounded-xl overflow-hidden max-w-sm cursor-pointer group shadow"
                  @click="!msg.metadata?.isHidden && (previewMediaUrl = msg.fileData.url)"
                  :title="msg.metadata?.isHidden ? 'This image has been hidden from assets' : 'Click to expand'"
                >
                  <div
                    v-if="msg.metadata?.isHidden"
                    class="px-3.5 py-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-400 italic flex items-center gap-2 select-none"
                  >
                    <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
                    <span>This image has been hidden from assets</span>
                  </div>
                  <img
                    v-else
                    :src="msg.fileData.url"
                    alt="Image attachment"
                    class="w-full h-auto max-h-64 object-cover group-hover:scale-105 transition duration-300 rounded-xl"
                    loading="lazy"
                  />
                </div>

                <!-- Video Player (Inside bubble when caption is present) -->
                <div v-else-if="msg.fileData.type === 'video'" class="rounded-xl overflow-hidden max-w-sm shadow">
                  <video :src="msg.fileData.url" controls class="w-full max-h-64 rounded-xl" preload="metadata"></video>
                </div>

                <!-- Document Card (Shows filename & PDF preview if applicable) -->
                <div v-else class="p-3 bg-slate-950/90 border border-slate-700/80 rounded-xl flex items-center justify-between gap-3 max-w-sm shadow-md">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="p-2 rounded-lg bg-sky-500/20 text-sky-400 shrink-0">
                      <FileText class="w-5 h-5" />
                    </div>
                    <div class="min-w-0">
                      <p class="text-xs font-semibold text-slate-200 truncate">{{ msg.fileData.name }}</p>
                      <p class="text-[10px] text-slate-400 font-mono">{{ (msg.fileData.size / 1024).toFixed(1) }} KB</p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <button
                      v-if="msg.fileData.name.toLowerCase().endsWith('.pdf') || msg.fileData.mimeType === 'application/pdf'"
                      @click="openPdfPreview(msg.fileData.name, msg.fileData.url)"
                      class="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-xs transition shrink-0"
                      title="Preview PDF"
                    >
                      <Eye class="w-3.5 h-3.5" /> Preview
                    </button>
                    <a
                      :href="msg.fileData.url"
                      :download="msg.fileData.name"
                      class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0"
                      title="Download document"
                    >
                      <Download class="w-4 h-4" />
                    </a>
                  </div>
                </div>
              </div>

              <!-- Fact Check AI Asset -->
              <FactCheckViewer
                v-if="msg.type === 'ai_asset' && msg.assetType === 'fact_check'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded 3D Model Hidden Placeholder -->
              <div
                v-if="msg.type === 'ai_asset' && (msg.assetType === 'parametric_3d' || msg.assetType === 'mesh_3d') && msg.metadata?.isHidden"
                class="mt-2 px-3.5 py-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-400 italic flex items-center gap-2 select-none max-w-sm"
              >
                <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
                <span>This 3D model has been hidden from assets</span>
              </div>

              <!-- Embedded 3D Parametric Viewer -->
              <ParametricViewer3D
                v-else-if="msg.type === 'ai_asset' && msg.assetType === 'parametric_3d'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded GLB Model Viewer -->
              <ModelViewerGLB
                v-else-if="msg.type === 'ai_asset' && msg.assetType === 'mesh_3d'"
                :assetData="msg.assetPayload"
                :message="msg"
                :isResizing="isResizingWhiteboard"
                @refine="handleRefineModel"
              />

              <!-- Hidden Whiteboard Placeholder in Chat -->
              <div
                v-if="msg.type === 'whiteboard_state' && msg.metadata?.isHidden"
                class="mt-2 px-3.5 py-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-400 italic flex items-center gap-2 select-none max-w-[250px]"
              >
                <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
                <span>This whiteboard preview has been hidden from assets</span>
              </div>

              <!-- Embedded Whiteboard Share Card -->
              <div
                v-else-if="msg.type === 'whiteboard_state'"
                class="mt-2 rounded-xl overflow-hidden shadow-lg relative border transition max-w-[210px] sm:max-w-[250px] select-none cursor-pointer group"
                :class="[
                  (msg.metadata?.isPrivate || !roomStore.currentRoom?.whiteboardActive)
                    ? 'border-slate-800 bg-slate-950/70 opacity-75 grayscale-[35%] hover:border-slate-700'
                    : 'border-emerald-500/50 hover:border-emerald-400 shadow-emerald-950/30 bg-slate-900'
                ]"
                @click="openWhiteboardState(msg)"
              >
                <div class="relative w-full aspect-[4/3] bg-slate-950 flex items-center justify-center overflow-hidden">
                  <!-- Non-private with valid thumbnail URL: render image -->
                  <img
                    v-if="!msg.metadata?.isPrivate && msg.fileData?.url"
                    :src="msg.fileData.url"
                    class="w-full h-full object-cover transition duration-300 group-hover:scale-105"
                  />
                  <!-- Private: thumbnail removed completely, clean indicator -->
                  <div
                    v-else-if="msg.metadata?.isPrivate"
                    class="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 select-none p-4 text-center"
                  >
                    <div class="w-10 h-10 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center mb-1.5 shadow-sm">
                      <Lock class="w-5 h-5 text-slate-400" />
                    </div>
                    <span class="text-xs font-semibold text-slate-300 tracking-wide">Private Whiteboard</span>
                  </div>
                  <!-- Non-private fallback when no image yet -->
                  <div v-else class="text-slate-600 flex flex-col items-center">
                    <Palette class="w-8 h-8 opacity-40" />
                  </div>

                  <!-- Active Live Badge vs Ended Badge (Top Right) -->
                  <div
                    v-if="roomStore.currentRoom?.whiteboardActive && (msg.metadata?.isSharedPost || !msg.metadata?.isPrivate)"
                    class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-full bg-emerald-500/90 text-white text-[9px] font-bold shadow flex items-center gap-1 animate-pulse"
                  >
                    <span class="w-1.5 h-1.5 rounded-full bg-white"></span>
                    <span>Live</span>
                  </div>
                  <div
                    v-else
                    class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-full bg-slate-800/90 text-slate-400 text-[9px] font-medium border border-slate-700/60 shadow flex items-center gap-1"
                  >
                    <span>Ended</span>
                  </div>

                  <!-- Active Join / Open Hover Action -->
                  <div
                    class="absolute inset-0 flex items-center justify-center bg-indigo-950/60 opacity-0 group-hover:opacity-100 transition z-10"
                  >
                    <span class="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-lg text-xs font-bold shadow-lg flex items-center gap-1.5 transition">
                      <Palette class="w-3.5 h-3.5" />
                      {{ msg.metadata?.isPrivate ? 'Open Private Board' : (roomStore.currentRoom?.whiteboardActive ? 'Join Live Board' : 'Open Whiteboard') }}
                    </span>
                  </div>
                </div>

                <!-- Footer label -->
                <div class="px-2.5 py-1.5 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px]">
                  <span class="text-slate-300 font-medium truncate max-w-[140px]">
                    {{ msg.metadata?.creatorName || msg.senderName }}'s Board
                  </span>
                  <span v-if="msg.metadata?.isPrivate" class="text-slate-500 font-medium text-[9px] shrink-0">
                    Private
                  </span>
                  <span v-else-if="roomStore.currentRoom?.whiteboardActive && (msg.metadata?.isSharedPost || !msg.metadata?.isPrivate)" class="text-emerald-400 font-semibold text-[9px] shrink-0">
                    Active
                  </span>
                  <span v-else class="text-slate-500 text-[9px] shrink-0">
                    Ended
                  </span>
                </div>
              </div>

              <!-- Embedded Visual Moodboard -->
              <MoodBoardViewer
                v-if="msg.type === 'ai_asset' && msg.assetType === 'moodboard'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded Document Trigger -->
              <div
                v-if="msg.type === 'ai_asset' && (msg.assetType === 'summary' || msg.assetType === 'contract')"
                class="mt-3 p-3 bg-slate-950/80 border border-slate-700 rounded-xl flex items-center justify-between"
              >
                <div class="flex items-center gap-2">
                  <FileText class="w-5 h-5 text-sky-400 shrink-0" />
                  <span class="text-xs font-semibold text-slate-200 truncate">{{ msg.assetPayload?.title }}</span>
                </div>
                <button
                  @click="openDocument(msg.assetPayload?.title, msg.assetPayload?.content)"
                  class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium rounded-lg transition shrink-0 ml-2"
                >
                  View Document
                </button>
              </div>
            </div>

            <!-- Unified Bottom Action Toolbar (Emoji Reactions, Reply, Copy) -->
            <div
              v-if="!isMeetingClosed && msg.senderUid !== 'system'"
              class="mt-1 flex items-center select-none z-10 transition-all duration-150"
              :class="[
                msg.senderUid === authStore.uid ? 'justify-end' : 'justify-start',
                hasActiveReactions(msg) ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100 pointer-events-none group-hover/msg:pointer-events-auto'
              ]"
            >
              <div
                class="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-slate-900/95 border border-slate-700/80 shadow-md backdrop-blur-sm text-xs transition-all duration-150"
              >
                <!-- 6 Emojis -->
                <button
                  v-for="emoji in reactionEmojiList"
                  :key="emoji"
                  @click.stop="roomStore.toggleMessageReaction(msg.id, emoji)"
                  class="flex items-center gap-1 px-1.5 py-0.5 rounded-full transition transform active:scale-90 cursor-pointer text-xs"
                  :class="[
                    isEmojiSelectedByMe(msg, emoji)
                      ? 'bg-sky-500/30 border border-sky-400/90 text-sky-200 ring-2 ring-sky-400/80 shadow-xs font-semibold scale-105'
                      : (getEmojiVoters(msg, emoji).length > 0
                        ? 'bg-slate-800/80 text-slate-300 border border-slate-700/80 hover:bg-slate-700'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/60 hidden group-hover/msg:inline-flex')
                  ]"
                  :title="isEmojiSelectedByMe(msg, emoji) ? `Remove ${emoji}` : `React ${emoji}`"
                >
                  <span class="text-xs">{{ emoji }}</span>
                  <span
                    v-if="getEmojiVoters(msg, emoji).length > 0"
                    class="text-[10px] font-bold"
                    :class="isEmojiSelectedByMe(msg, emoji) ? 'text-sky-300' : 'text-slate-400'"
                  >
                    {{ getEmojiVoters(msg, emoji).length }}
                  </span>
                </button>

                <!-- Subtle Divider (visible on hover) -->
                <div class="hidden group-hover/msg:block h-3.5 w-px bg-slate-700/80 mx-0.5"></div>

                <!-- Reply Button (visible on hover) -->
                <button
                  @click.stop="replyToMessage(msg)"
                  class="hidden group-hover/msg:inline-flex p-1 rounded-full text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition cursor-pointer"
                  title="Reply"
                >
                  <CornerUpLeft class="w-3.5 h-3.5" />
                </button>

                <!-- Copy Button (visible on hover) -->
                <button
                  @click.stop="copyMessageContent(msg)"
                  class="hidden group-hover/msg:inline-flex p-1 rounded-full text-slate-400 hover:text-emerald-300 hover:bg-slate-800 transition cursor-pointer"
                  title="Copy message"
                >
                  <Copy class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <!-- AI Mentor Failure / 503 Retry with Flash Button -->
            <div
              v-if="msg.senderUid === 'ai_mentor' && (msg.content?.includes('503') || msg.content?.includes('GoogleGenerativeAI Error') || msg.content?.includes('high demand') || msg.content?.includes('overloaded'))"
              class="flex items-center gap-2 mt-1.5"
            >
              <button
                @click="handleRetryAiMessage(msg.id)"
                :disabled="retryingAiMessageId === msg.id"
                class="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-indigo-600/90 hover:bg-indigo-600 text-white text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
              >
                <Loader2 v-if="retryingAiMessageId === msg.id" class="w-3.5 h-3.5 animate-spin" />
                <RefreshCw v-else class="w-3.5 h-3.5 text-sky-300" />
                <span>{{ retryingAiMessageId === msg.id ? 'Retrying with Flash...' : 'Retry with Flash' }}</span>
              </button>
            </div>

            <!-- Optimistic UI Status indicators (Failed with retry) -->
            <div
              v-if="msg.senderUid === authStore.uid && msg.status === 'failed'"
              class="flex items-center gap-1 mt-0.5 text-[10px]"
            >
              <button
                @click="roomStore.retrySendMessage(msg)"
                class="text-rose-400 hover:underline flex items-center gap-1 font-medium cursor-pointer"
                title="Click to retry sending"
              >
                <AlertCircle class="w-3 h-3 text-rose-400" />
                <span>Failed to send. Click to retry.</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- AI Mentor Analyzing / Thinking Bubble (Global & Real-time) -->
      <div
        v-if="roomStore.isAnalyzing || (roomStore.aiStatus === 'analyzing' && roomStore.typingUsers.some(u => u.uid === 'ai_mentor' || u.uid === 'ai_mentor_3d'))"
        class="flex items-center gap-3 px-3.5 py-2 rounded-2xl bg-slate-900/90 border border-sky-500/40 text-xs text-slate-200 w-fit animate-fade-in shadow-xl my-2 ml-1"
      >
        <span class="text-base leading-none animate-pulse">✨</span>
        <span class="font-medium text-sky-300">
          {{ roomStore.aiStatusDetail || 'AI Mentor is analyzing design...' }}
        </span>
        <span class="flex gap-1 items-center ml-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <button
          @click="roomStore.abortCurrentAiGeneration()"
          class="ml-2 px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-white text-[11px] font-medium transition cursor-pointer flex items-center gap-1"
          title="Interrupt AI Generation"
        >
          <X class="w-3 h-3" /> Stop
        </button>
      </div>

      <!-- Live In-Chat Human Typing Bubble -->
      <div
        v-if="roomStore.typingUsers.filter(u => u.uid !== 'ai_mentor' && u.uid !== 'ai_mentor_3d').length > 0"
        class="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300 w-fit animate-fade-in shadow-sm my-2 ml-1"
      >
        <span class="text-base leading-none">
          {{ roomStore.typingUsers.filter(u => u.uid !== 'ai_mentor' && u.uid !== 'ai_mentor_3d')[0].avatar || '💬' }}
        </span>
        <span class="font-medium text-slate-200">
          {{ formatTypingText(roomStore.typingUsers.filter(u => u.uid !== 'ai_mentor' && u.uid !== 'ai_mentor_3d')) }}
        </span>
        <span class="flex gap-1 items-center ml-1">
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
      </div>

      <!-- 3D Generation Progress Bubble -->
      <div
        v-if="roomStore.isGenerating3D"
        class="flex items-center gap-3 px-3.5 py-2 rounded-2xl bg-indigo-900/60 border border-indigo-500/50 text-xs text-indigo-200 w-fit animate-fade-in shadow-xl my-2 ml-1"
      >
        <span class="text-base leading-none animate-pulse">🎨</span>
        <span class="font-medium text-indigo-100">
          {{ roomStore.generating3DStatus || 'Generating 3D Model...' }}
        </span>
        <span class="flex gap-1 items-center ml-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" style="animation-delay: 300ms"></span>
        </span>
        <button
          @click="roomStore.abortCurrentAiGeneration()"
          class="ml-2 px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-white text-[11px] font-medium transition cursor-pointer flex items-center gap-1"
          title="Cancel 3D Generation"
        >
          <X class="w-3 h-3" /> Stop
        </button>
      </div>
      </div>
      
      <!-- Invisible anchor for auto-scroll -->
      <div ref="bottomAnchorRef" class="h-2 w-full"></div>
      
      <!-- Scroll to bottom FAB -->
      <button
        v-show="showScrollFab"
        @click="scrollToBottom"
        class="sticky bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-full bg-slate-800 border border-slate-700 shadow-xl text-sky-400 hover:text-white transition z-20 animate-fade-in opacity-90 hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
      </button>
    </main>

    <!-- Bottom Input & Triggers Bar -->
    <footer class="border-t border-slate-800 bg-slate-900/90 backdrop-blur-md p-2.5 sm:p-3 shrink-0">
      <div class="max-w-4xl mx-auto space-y-1.5">
        <!-- Room-wide AI Task Progress Banner -->
        <div
          v-if="roomStore.currentRoom?.aiActiveTask"
          class="flex items-center justify-between p-2.5 rounded-xl bg-sky-950/90 border border-sky-500/40 shadow-lg text-xs text-sky-200 animate-pulse"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="p-1 rounded-lg bg-sky-500/20 text-sky-400 shrink-0">
              <Loader2 class="w-4 h-4 animate-spin text-sky-400" />
            </div>
            <div class="min-w-0">
              <p class="font-semibold text-sky-200 truncate">
                AI Mentor is responding to {{ roomStore.currentRoom.aiActiveTask.callerName }}...
              </p>
              <p class="text-slate-400 text-[11px] truncate">
                {{ roomStore.currentRoom.aiActiveTask.type }}: "{{ roomStore.currentRoom.aiActiveTask.prompt }}"
              </p>
            </div>
          </div>
          <button
            v-if="roomStore.currentRoom.aiActiveTask.callerUid === authStore.uid || roomStore.isHost"
            @click="roomStore.abortCurrentAiGeneration()"
            class="ml-2 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-white text-[11px] font-medium transition cursor-pointer flex items-center gap-1 shrink-0"
            title="Stop AI Generation"
          >
            <X class="w-3 h-3" /> Stop
          </button>
        </div>

        <!-- Replying To Quote Banner -->
        <div
          v-if="replyingToMessage"
          class="flex items-center justify-between p-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-xs text-slate-300"
        >
          <div class="flex items-center gap-2 min-w-0">
            <CornerUpLeft class="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span class="text-sky-300 font-medium shrink-0">Replying to {{ replyingToMessage.senderName }}:</span>
            <span class="truncate opacity-80">{{ replyingToMessage.content.slice(0, 75) }}</span>
          </div>
          <button
            @click="replyingToMessage = null"
            class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0 cursor-pointer"
            title="Cancel reply"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Quick Action Badges -->
        <div class="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-[11px] text-slate-400">
          <button
            @click="insertQuickTag('@Mentor')"
            :disabled="isMeetingClosed"
            class="px-2 py-0.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          >
            <Sparkles class="w-3 h-3" /> @Mentor
          </button>
          <button
            @click="insertQuickTag('@Mentor generate a 3D prototype')"
            :disabled="isMeetingClosed"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          >
            <Box class="w-3 h-3 text-sky-400" /> 3D Prototype
          </button>
          <button
            @click="insertQuickTag('@Mentor create a visual mood board')"
            :disabled="isMeetingClosed"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          >
            <Palette class="w-3 h-3 text-amber-400" /> Mood Board
          </button>
          <button
            @click="insertQuickTag('@Mentor fact-check this design specification')"
            :disabled="isMeetingClosed"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          >
            <Check class="w-3 h-3 text-emerald-400" /> Fact Check
          </button>
          <button
            @click="insertQuickTag('@Mentor summarize the discussion so far')"
            :disabled="isMeetingClosed"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          >
            <FileText class="w-3 h-3 text-purple-400" /> Summary
          </button>
        </div>

        <!-- Staged Attachment Draft Bar (File selected via paperclip, waiting for send) -->
        <div
          v-if="stagedAttachment"
          class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-sky-500/50 shadow-lg animate-fade-in"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <img
              v-if="stagedAttachment.type === 'image' && stagedAttachment.previewUrl"
              :src="stagedAttachment.previewUrl"
              class="w-10 h-10 rounded-lg object-cover border border-slate-700 shrink-0"
            />
            <div v-else class="p-2 rounded-lg bg-sky-500/20 text-sky-400 shrink-0">
              <FileText class="w-5 h-5" />
            </div>
            <div class="min-w-0">
              <p class="text-xs font-semibold text-slate-200 truncate">{{ stagedAttachment.name }}</p>
              <p class="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                <span>{{ (stagedAttachment.size / 1024).toFixed(1) }} KB</span>
                <span class="text-emerald-400 font-medium">• Ready to send</span>
              </p>
            </div>
          </div>
          <button
            @click="stagedAttachment = null"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
            title="Remove attachment"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Input Bar with Paperclip, Whiteboard & Auto-expanding Textarea -->
        <div class="flex items-center gap-2">
          <!-- Hidden File Input -->
          <input
            ref="fileInputRef"
            type="file"
            class="hidden"
            accept="image/*,video/*,.pdf,.doc,.docx,.txt"
            @change="onFileSelected"
          />

          <!-- Attachment Paperclip Button -->
          <button
            @click="triggerFileInput"
            :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted || isUploadingFile"
            class="p-2.5 rounded-xl border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-sky-400 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
            title="Attach images, videos (<=30s), PDF or documents"
          >
            <Paperclip class="w-4 h-4" :class="{ 'animate-spin': isUploadingFile }" />
          </button>

          <!-- Collaborative Whiteboard Button -->
          <button
            @click="handleOpenNewWhiteboard"
            :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted || isWhiteboardOpen"
            class="p-2.5 rounded-xl border border-indigo-500/40 bg-indigo-950/40 hover:bg-indigo-900/60 text-indigo-300 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
            title="Open Collaborative Whiteboard"
          >
            <Palette class="w-4 h-4 text-indigo-400" />
          </button>

          <!-- Textarea Input with Clipboard Paste & Mention Popover -->
          <div class="relative flex-1 min-w-0">
            <!-- Mention Autocomplete Popover -->
            <div
              v-if="isMentionMenuOpen && mentionCandidates.length > 0"
              class="absolute bottom-full left-0 mb-2 w-72 sm:w-80 bg-slate-900/95 border border-slate-700/80 rounded-xl shadow-2xl p-1.5 backdrop-blur-md z-50 max-h-56 overflow-y-auto"
            >
              <div class="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800 mb-1 flex items-center justify-between">
                <span>{{ t('room.mentionMember') }}</span>
                <span class="text-[9px] text-slate-500">↑↓ to navigate · Enter to select</span>
              </div>
              <button
                v-for="(cand, idx) in mentionCandidates"
                :key="cand.id"
                type="button"
                @mousedown.prevent="selectMentionCandidate(cand)"
                class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition cursor-pointer text-xs"
                :class="idx === mentionMenuIndex ? 'bg-sky-600/30 text-white ring-1 ring-sky-500' : 'hover:bg-slate-800 text-slate-200'"
              >
                <div class="w-6 h-6 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0 text-sm">
                  {{ cand.avatar }}
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate flex items-center gap-1.5">
                    <span>{{ cand.name }}</span>
                    <span v-if="cand.isAi" class="text-[9px] px-1 py-0.2 rounded bg-sky-500/20 text-sky-300 font-bold">AI</span>
                    <span v-else-if="cand.subtitle === 'Host'" class="text-[9px] px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-medium">Host</span>
                  </div>
                  <div class="text-[10px] text-slate-400 font-mono">{{ cand.handle }}</div>
                </div>
              </button>
            </div>

            <textarea
              ref="textareaRef"
              v-model="inputMessage"
              @input="onInputTextarea"
              @paste="handlePaste"
              @keydown="handleTextareaKeyDown"
              :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted"
              :placeholder="isMeetingClosed
                ? 'This meeting has been closed. Chat is in read-only mode.'
                : roomStore.currentRoom?.participants[authStore.uid]?.isMuted
                  ? 'You have been muted by the host.'
                  : 'Type a message (e.g. @Mentor or @Name)...'"
              class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition resize-none min-h-[44px] max-h-32 overflow-y-auto disabled:opacity-50"
              rows="1"
            ></textarea>
          </div>

          <!-- Quick Thumbs-Up (When empty) OR Send Button (When text/attachment present) -->
          <button
            v-if="!inputMessage.trim() && !stagedAttachment"
            @click="handleSendQuickThumbsUp"
            :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted"
            class="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed text-sky-400 rounded-xl font-semibold shadow transition flex items-center justify-center shrink-0 min-h-[44px] min-w-[44px] cursor-pointer text-lg select-none"
            title="Send quick thumbs up (👍)"
          >
            👍
          </button>
          <button
            v-else
            @click="handleSend"
            :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted || (inputMessage.toLowerCase().includes('@mentor') && (roomStore.aiCooldownRemaining > 0 || roomStore.isAnalyzing))"
            class="px-3.5 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow transition flex items-center justify-center gap-1.5 shrink-0 min-h-[44px] min-w-[44px] cursor-pointer"
            :title="inputMessage.toLowerCase().includes('@mentor') && roomStore.aiCooldownRemaining > 0 ? `AI Cooling down (${roomStore.aiCooldownRemaining}s remaining)` : 'Send message'"
          >
            <template v-if="inputMessage.toLowerCase().includes('@mentor') && roomStore.aiCooldownRemaining > 0">
              <span class="text-xs font-mono text-amber-200">{{ roomStore.aiCooldownRemaining }}s</span>
            </template>
            <template v-else-if="inputMessage.toLowerCase().includes('@mentor') && roomStore.isAnalyzing">
              <Loader2 class="w-4 h-4 animate-spin text-sky-200" />
            </template>
            <template v-else>
              <Send class="w-4 h-4" />
              <span class="hidden sm:inline">Send</span>
            </template>
          </button>
        </div>
      </div>
    </footer>
      </div>

      <!-- Resizer Handle Divider between Chat and Whiteboard -->
      <div
        v-if="isWhiteboardOpen"
        class="hidden sm:flex w-2.5 hover:w-3 bg-slate-900 hover:bg-indigo-500/80 active:bg-indigo-600 transition-all cursor-col-resize shrink-0 z-30 items-center justify-center select-none group border-x border-slate-800"
        @mousedown="startWhiteboardResize"
        title="Drag to resize whiteboard (drag to right edge to close)"
      >
        <div class="h-8 w-1 rounded-full bg-slate-600 group-hover:bg-white transition-colors"></div>
      </div>

      <!-- Collaborative Whiteboard Column -->
      <div
        v-if="isWhiteboardOpen"
        class="h-full relative overflow-hidden bg-slate-900 shrink-0 w-full sm:w-auto min-w-[320px] max-w-[calc(100%-260px)]"
        :class="{ 'transition-none': isResizingWhiteboard }"
        :style="whiteboardWidth ? { width: `${whiteboardWidth}px` } : { width: '68%' }"
      >
        <CollaborativeWhiteboard
          ref="whiteboardRef"
          :key="whiteboardSessionKey"
          :initialJson="currentWhiteboardJson"
          :activeAssetId="activeWhiteboardAssetId"
          :isSharedSession="isWhiteboardSharedSession"
          :isPublic="activeWhiteboardIsPublic"
          :assetCreatorUid="activeWhiteboardCreatorUid"
          @close="isWhiteboardOpen = false; isJoiningSharedBoard = false; isLocalWhiteboardPublisher = false; isActiveWhiteboardPrivate = false; activeWhiteboardIsPublic = false; activeWhiteboardCreatorUid = null; activeWhiteboardAssetId = null; currentWhiteboardJson = undefined;"
          @share="handleShareWhiteboard"
          @save-state="handleSaveWhiteboardState"
        />
      </div>
    </div>

    <!-- Assets / Album Drawer -->
    <div
      class="fixed bottom-0 right-0 z-[100] w-full sm:w-80 bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out"
      :style="{ top: drawerTopOffset, height: `calc(100dvh - ${drawerTopOffset})` }"
      :class="isAssetsDrawerOpen ? 'translate-x-0' : 'translate-x-full'"
    >
      <div class="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
        <h2 class="text-base font-bold text-slate-100 flex items-center gap-2">
          <Box class="w-4 h-4 text-amber-400" />
          Assets Library
        </h2>
        <div class="flex items-center gap-1.5">
          <button
            @click="toggleManageAssets"
            class="px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1"
            :class="isManagingAssets ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-slate-800 text-slate-400 hover:text-slate-200'"
            title="Manage hidden assets"
          >
            <Settings class="w-3.5 h-3.5" />
            <span>{{ isManagingAssets ? 'Done' : 'Manage' }}</span>
          </button>
          <button
            @click="isAssetsDrawerOpen = false"
            class="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>
      <!-- Public vs Personal Assets Tabs -->
      <div class="px-4 pt-3 pb-1 bg-slate-950/60 border-b border-slate-800">
        <div class="flex items-center gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800">
          <button
            @click="activeAssetTab = 'public'"
            class="flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition cursor-pointer text-center"
            :class="activeAssetTab === 'public' ? 'bg-sky-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'"
          >
            Public Assets ({{ isManagingAssets ? allPublicAlbumItems.length : allPublicAlbumItems.filter(m => !m.metadata?.isHidden).length }})
          </button>
          <button
            @click="activeAssetTab = 'personal'"
            class="flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition cursor-pointer text-center"
            :class="activeAssetTab === 'personal' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'"
          >
            Personal Drafts ({{ isManagingAssets ? allPersonalAlbumItems.length : allPersonalAlbumItems.filter(m => !m.metadata?.isHidden).length }})
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <!-- Empty State -->
        <div v-if="!visibleAlbumItems.length && !hiddenAlbumItems.length" class="text-center text-xs text-slate-500 py-10 px-4">
          <template v-if="activeAssetTab === 'personal'">
            No personal drafts yet. When you save a board as private, it will appear here only for you.
          </template>
          <template v-else>
            No public media assets or shared whiteboards in this room yet.
          </template>
        </div>

        <!-- Upper Visible Assets Grid -->
        <div v-if="visibleAlbumItems.length" class="grid grid-cols-3 gap-2">
          <template v-for="msg in visibleAlbumItems" :key="msg.id">
            <!-- Whiteboard States (Editable) -->
            <div
              v-if="msg.type === 'whiteboard_state'"
              class="relative aspect-square cursor-pointer transition group"
              @click="!isManagingAssets && (openWhiteboardState(msg), isAssetsDrawerOpen = false)"
              title="Click to edit whiteboard"
            >
              <div class="w-full h-full rounded-xl bg-slate-950 border-2 overflow-hidden shadow-md border-indigo-500/40 hover:border-indigo-400 relative">
                <img
                  v-if="getAssetThumbnail(msg)"
                  :src="getAssetThumbnail(msg)"
                  class="w-full h-full object-cover group-hover:scale-105 transition duration-300 bg-white"
                />
                <div v-else class="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 gap-1.5 p-2 text-center">
                  <Palette class="w-6 h-6 opacity-60 animate-pulse text-indigo-400" />
                  <span class="text-[9px] text-slate-300 font-medium">繪製縮圖中...</span>
                </div>
                <!-- Badge -->
                <div class="absolute top-1 left-1 bg-indigo-950/90 text-indigo-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-indigo-500/50 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
                  <Lock v-if="msg.metadata?.isPrivate" class="w-2.5 h-2.5 text-amber-400" />
                  <Palette v-else class="w-2.5 h-2.5 text-indigo-400" />
                  <span>{{ msg.metadata?.isPrivate ? 'Private' : 'Whiteboard' }}</span>
                </div>
                <!-- Hide/Unhide Button in Manage Mode -->
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                  title="Hide this asset"
                >
                  <EyeOff class="w-2.5 h-2.5" />
                  <span>Hide</span>
                </button>
                <!-- Creator Name Pill (Bottom) -->
                <div class="absolute bottom-1 left-1 right-1 bg-slate-950/85 px-1.5 py-0.5 rounded text-[8px] text-slate-300 font-medium truncate backdrop-blur-xs z-10 flex items-center gap-1">
                  <span class="text-[9px]">{{ msg.metadata?.creatorAvatar || msg.senderAvatar || '🎨' }}</span>
                  <span class="truncate">{{ msg.metadata?.creatorName || msg.senderName || 'Member' }}</span>
                </div>
                <!-- Hover Overlay -->
                <div v-if="!isManagingAssets" class="absolute inset-0 bg-indigo-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                  <span class="bg-indigo-600 text-white px-2 py-0.5 rounded text-[9px] font-bold shadow flex items-center gap-1">
                    <PenTool class="w-2.5 h-2.5" /> Edit
                  </span>
                </div>
              </div>

              <!-- Active Viewers Avatars on Public Whiteboards (Slightly overflows top-right corner, 50% larger, NO background underlay pill) -->
              <div
                v-if="!msg.metadata?.isPrivate && getActiveWhiteboardUsers(msg.id).length && !isManagingAssets"
                class="absolute -top-2.5 -right-2.5 z-30 flex items-center -space-x-1.5 pointer-events-auto"
                :title="getActiveWhiteboardUsers(msg.id).map(u => u.displayName).join(', ') + ' on this canvas'"
              >
                <div
                  v-for="u in getActiveWhiteboardUsers(msg.id).slice(0, 3)"
                  :key="u.uid"
                  class="relative"
                >
                  <span
                    class="w-6 h-6 rounded-full flex items-center justify-center text-xs bg-slate-800 border-2 border-sky-400 shadow-lg select-none ring-1 ring-slate-950"
                    :title="u.displayName"
                  >
                    {{ u.avatar || '👤' }}
                  </span>
                  <span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-slate-950 animate-pulse" />
                </div>
                <span
                  v-if="getActiveWhiteboardUsers(msg.id).length > 3"
                  class="w-5 h-5 rounded-full bg-sky-600 text-white text-[9px] font-bold flex items-center justify-center border-2 border-slate-900 shadow-md ring-1 ring-slate-950"
                >
                  +{{ getActiveWhiteboardUsers(msg.id).length - 3 }}
                </span>
              </div>
            </div>

            <!-- Static Image Attachments -->
            <div
              v-else-if="msg.type === 'file' && msg.fileData?.type === 'image'"
              class="aspect-square rounded-xl bg-slate-950 border overflow-hidden cursor-pointer transition group relative border-slate-800 hover:border-sky-500/50"
              @click="!isManagingAssets && scrollToMessage(msg.id)"
              title="View image in chat"
            >
              <img :src="msg.fileData.url" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" />
              <!-- Badge -->
              <div class="absolute top-1 left-1 bg-slate-900/90 text-slate-300 px-1.5 py-0.5 rounded text-[8px] font-medium border border-slate-700/60 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
                <ImageIcon class="w-2.5 h-2.5 text-sky-400" />
                <span>Image</span>
              </div>
              <!-- Hide Button in Manage Mode -->
              <button
                v-if="isManagingAssets"
                @click.stop="handleToggleHideAsset(msg)"
                class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                title="Hide this asset"
              >
                <EyeOff class="w-2.5 h-2.5" />
                <span>Hide</span>
              </button>
              <!-- Hover Overlay -->
              <div v-if="!isManagingAssets" class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                <span class="bg-slate-800 text-slate-200 px-2 py-0.5 rounded text-[9px] font-medium shadow flex items-center gap-1">
                  <Eye class="w-2.5 h-2.5" /> View
                </span>
              </div>
            </div>

            <!-- 3D Assets -->
            <div
              v-else-if="msg.type === 'ai_asset' && msg.assetType === 'mesh_3d'"
              class="aspect-square rounded-xl bg-sky-950/30 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-sky-500/30 hover:bg-sky-900/50"
              @click="!isManagingAssets && scrollToMessage(msg.id)"
              title="View 3D Model in chat"
            >
              <div class="absolute top-1 left-1 bg-sky-950/90 text-sky-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-sky-500/40 backdrop-blur-sm flex items-center gap-1">
                <Box class="w-2.5 h-2.5 text-sky-400" />
                <span>3D</span>
              </div>
              <!-- Hide Button in Manage Mode -->
              <button
                v-if="isManagingAssets"
                @click.stop="handleToggleHideAsset(msg)"
                class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                title="Hide this asset"
              >
                <EyeOff class="w-2.5 h-2.5" />
                <span>Hide</span>
              </button>
              <Box class="w-6 h-6 text-sky-400 mb-1 mt-2" />
              <span class="text-[9px] text-sky-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || '3D Model' }}</span>
            </div>

            <!-- Moodboards -->
            <div
              v-else-if="msg.type === 'ai_asset' && msg.assetType === 'moodboard'"
              class="aspect-square rounded-xl bg-amber-950/30 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-amber-500/30 hover:bg-amber-900/50"
              @click="!isManagingAssets && scrollToMessage(msg.id)"
              title="View Moodboard in chat"
            >
              <div class="absolute top-1 left-1 bg-amber-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/40 backdrop-blur-sm flex items-center gap-1">
                <Palette class="w-2.5 h-2.5 text-amber-400" />
                <span>Moodboard</span>
              </div>
              <!-- Hide Button in Manage Mode -->
              <button
                v-if="isManagingAssets"
                @click.stop="handleToggleHideAsset(msg)"
                class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                title="Hide this asset"
              >
                <EyeOff class="w-2.5 h-2.5" />
                <span>Hide</span>
              </button>
              <Palette class="w-6 h-6 text-amber-400 mb-1 mt-2" />
              <span class="text-[9px] text-amber-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || 'Moodboard' }}</span>
            </div>

            <!-- Summary / Contract Documents -->
            <div
              v-else-if="msg.type === 'ai_asset' && (msg.assetType === 'summary' || msg.assetType === 'contract')"
              class="aspect-square rounded-xl bg-violet-950/30 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-violet-500/30 hover:bg-violet-900/50"
              @click="!isManagingAssets && openDocument(msg.assetPayload?.title || (msg.assetType === 'contract' ? 'Team Agreement' : 'Executive Summary'), msg.assetPayload?.content || '')"
              :title="msg.assetPayload?.title || 'View Document'"
            >
              <div class="absolute top-1 left-1 bg-violet-950/90 text-violet-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-violet-500/40 backdrop-blur-sm flex items-center gap-1">
                <FileText class="w-2.5 h-2.5 text-violet-400" />
                <span>{{ msg.assetType === 'contract' ? 'Agreement' : 'Doc' }}</span>
              </div>
              <!-- Hide Button in Manage Mode -->
              <button
                v-if="isManagingAssets"
                @click.stop="handleToggleHideAsset(msg)"
                class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                title="Hide this asset"
              >
                <EyeOff class="w-2.5 h-2.5" />
                <span>Hide</span>
              </button>
              <FileText class="w-6 h-6 text-violet-400 mb-1 mt-2" />
              <span class="text-[9px] text-violet-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || 'Summary' }}</span>
            </div>

            <!-- Fact Check Assets -->
            <div
              v-else-if="msg.type === 'ai_asset' && msg.assetType === 'fact_check'"
              class="aspect-square rounded-xl bg-emerald-950/30 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-emerald-500/30 hover:bg-emerald-900/50"
              @click="!isManagingAssets && scrollToMessage(msg.id)"
              title="View Fact Check in chat"
            >
              <div class="absolute top-1 left-1 bg-emerald-950/90 text-emerald-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-emerald-500/40 backdrop-blur-sm flex items-center gap-1">
                <ShieldCheck class="w-2.5 h-2.5 text-emerald-400" />
                <span>Verify</span>
              </div>
              <!-- Hide Button in Manage Mode -->
              <button
                v-if="isManagingAssets"
                @click.stop="handleToggleHideAsset(msg)"
                class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-rose-600 hover:bg-rose-500"
                title="Hide this asset"
              >
                <EyeOff class="w-2.5 h-2.5" />
                <span>Hide</span>
              </button>
              <ShieldCheck class="w-6 h-6 text-emerald-400 mb-1 mt-2" />
              <span class="text-[9px] text-emerald-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.claim || msg.assetPayload?.verdict || 'Fact Check' }}</span>
            </div>
          </template>
        </div>

        <!-- Spatial Partition Divider for Hidden Items (Shown only in Manage mode, chronological timestamp preserved) -->
        <div v-if="isManagingAssets && hiddenAlbumItems.length" class="pt-4 border-t border-slate-800/80">
          <div class="flex items-center justify-between mb-2.5 px-1 select-none">
            <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
              <EyeOff class="w-3.5 h-3.5 text-amber-400/80" />
              <span>Hidden Items ({{ hiddenAlbumItems.length }})</span>
            </div>
            <span class="text-[10px] text-slate-500">Chronological Partition</span>
          </div>
          <div class="grid grid-cols-3 gap-2 opacity-65 hover:opacity-100 transition-opacity">
            <template v-for="msg in hiddenAlbumItems" :key="msg.id">
              <!-- Hidden Whiteboard States -->
              <div
                v-if="msg.type === 'whiteboard_state'"
                class="relative aspect-square cursor-pointer transition group"
                @click="!isManagingAssets && (openWhiteboardState(msg), isAssetsDrawerOpen = false)"
                title="Click to edit hidden whiteboard"
              >
                <div class="w-full h-full rounded-xl bg-slate-950 border-2 overflow-hidden shadow-md border-amber-500/40 hover:border-amber-400 relative">
                  <img
                    v-if="getAssetThumbnail(msg)"
                    :src="getAssetThumbnail(msg)"
                    class="w-full h-full object-cover group-hover:scale-105 transition duration-300 bg-white"
                  />
                  <div v-else class="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 gap-1.5 p-2 text-center">
                    <Palette class="w-6 h-6 opacity-60 animate-pulse text-amber-400" />
                    <span class="text-[9px] text-slate-300 font-medium">繪製縮圖中...</span>
                  </div>
                  <!-- Badge -->
                  <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
                    <Lock v-if="msg.metadata?.isPrivate" class="w-2.5 h-2.5 text-amber-400" />
                    <Palette v-else class="w-2.5 h-2.5 text-amber-400" />
                    <span>{{ msg.metadata?.isPrivate ? 'Hidden Private' : 'Hidden' }}</span>
                  </div>
                  <!-- Unhide Button in Manage Mode -->
                  <button
                    v-if="isManagingAssets"
                    @click.stop="handleToggleHideAsset(msg)"
                    class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                    title="Unhide this asset"
                  >
                    <Eye class="w-2.5 h-2.5" />
                    <span>Unhide</span>
                  </button>
                  <!-- Creator Name Pill (Bottom) -->
                  <div class="absolute bottom-1 left-1 right-1 bg-slate-950/85 px-1.5 py-0.5 rounded text-[8px] text-slate-300 font-medium truncate backdrop-blur-xs z-10 flex items-center gap-1">
                    <span class="text-[9px]">{{ msg.metadata?.creatorAvatar || msg.senderAvatar || '🎨' }}</span>
                    <span class="truncate">{{ msg.metadata?.creatorName || msg.senderName || 'Member' }}</span>
                  </div>
                </div>
              </div>

              <!-- Hidden Static Image Attachments -->
              <div
                v-else-if="msg.type === 'file' && msg.fileData?.type === 'image'"
                class="aspect-square rounded-xl bg-slate-950 border overflow-hidden cursor-pointer transition group relative border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && scrollToMessage(msg.id)"
                title="View hidden image in chat"
              >
                <img :src="msg.fileData.url" class="w-full h-full object-cover group-hover:scale-105 transition duration-300 opacity-70" />
                <!-- Badge -->
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-medium border border-amber-500/50 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
                  <ImageIcon class="w-2.5 h-2.5 text-amber-400" />
                  <span>Hidden</span>
                </div>
                <!-- Unhide Button in Manage Mode -->
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                  title="Unhide this asset"
                >
                  <Eye class="w-2.5 h-2.5" />
                  <span>Unhide</span>
                </button>
              </div>

              <!-- Hidden 3D Assets -->
              <div
                v-else-if="msg.type === 'ai_asset' && msg.assetType === 'mesh_3d'"
                class="aspect-square rounded-xl bg-slate-950 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && scrollToMessage(msg.id)"
                title="View hidden 3D Model in chat"
              >
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1">
                  <Box class="w-2.5 h-2.5 text-amber-400" />
                  <span>Hidden</span>
                </div>
                <!-- Unhide Button in Manage Mode -->
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                  title="Unhide this asset"
                >
                  <Eye class="w-2.5 h-2.5" />
                  <span>Unhide</span>
                </button>
                <Box class="w-6 h-6 text-amber-400 mb-1 mt-2 opacity-70" />
                <span class="text-[9px] text-amber-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || '3D Model' }}</span>
              </div>

              <!-- Hidden Moodboards -->
              <div
                v-else-if="msg.type === 'ai_asset' && msg.assetType === 'moodboard'"
                class="aspect-square rounded-xl bg-slate-950 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && scrollToMessage(msg.id)"
                title="View hidden Moodboard in chat"
              >
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1">
                  <Palette class="w-2.5 h-2.5 text-amber-400" />
                  <span>Hidden</span>
                </div>
                <!-- Unhide Button in Manage Mode -->
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                  title="Unhide this asset"
                >
                  <Eye class="w-2.5 h-2.5" />
                  <span>Unhide</span>
                </button>
                <Palette class="w-6 h-6 text-amber-400 mb-1 mt-2 opacity-70" />
                <span class="text-[9px] text-amber-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || 'Moodboard' }}</span>
              </div>

              <!-- Hidden Documents -->
              <div
                v-else-if="msg.type === 'ai_asset' && (msg.assetType === 'summary' || msg.assetType === 'contract')"
                class="aspect-square rounded-xl bg-slate-950 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && openDocument(msg.assetPayload?.title || (msg.assetType === 'contract' ? 'Team Agreement' : 'Executive Summary'), msg.assetPayload?.content || '')"
                :title="msg.assetPayload?.title || 'View hidden Document'"
              >
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1">
                  <FileText class="w-2.5 h-2.5 text-amber-400" />
                  <span>Hidden Doc</span>
                </div>
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                  title="Unhide this asset"
                >
                  <Eye class="w-2.5 h-2.5" />
                  <span>Unhide</span>
                </button>
                <FileText class="w-6 h-6 text-amber-400 mb-1 mt-2 opacity-70" />
                <span class="text-[9px] text-amber-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.title || 'Document' }}</span>
              </div>

              <!-- Hidden Fact Checks -->
              <div
                v-else-if="msg.type === 'ai_asset' && msg.assetType === 'fact_check'"
                class="aspect-square rounded-xl bg-slate-950 border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && scrollToMessage(msg.id)"
                title="View hidden Fact Check in chat"
              >
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1">
                  <ShieldCheck class="w-2.5 h-2.5 text-amber-400" />
                  <span>Hidden</span>
                </div>
                <button
                  v-if="isManagingAssets"
                  @click.stop="handleToggleHideAsset(msg)"
                  class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5 bg-emerald-600 hover:bg-emerald-500"
                  title="Unhide this asset"
                >
                  <Eye class="w-2.5 h-2.5" />
                  <span>Unhide</span>
                </button>
                <ShieldCheck class="w-6 h-6 text-amber-400 mb-1 mt-2 opacity-70" />
                <span class="text-[9px] text-amber-300 font-medium truncate w-full px-1">{{ msg.assetPayload?.claim || msg.assetPayload?.verdict || 'Fact Check' }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Overlay for Assets Drawer (Dimmed without blur) -->
    <div
      v-if="isAssetsDrawerOpen"
      @click="isAssetsDrawerOpen = false"
      class="fixed inset-x-0 bottom-0 z-[90] bg-black/60 transition-opacity"
      :style="{ top: drawerTopOffset }"
    ></div>

    <!-- Host Control Drawer -->
    <HostControlDrawer
      :isOpen="isDrawerOpen"
      :topOffset="drawerTopOffset"
      @close="isDrawerOpen = false"
    />

    <!-- Document Preview Modal -->
    <DocumentModal
      :isOpen="isDocModalOpen"
      :title="docModalTitle"
      :content="docModalContent"
      @close="isDocModalOpen = false"
    />

    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      :isOpen="pdfModal.isOpen"
      :title="pdfModal.title"
      :pdfUrl="pdfModal.url"
      @close="pdfModal.isOpen = false"
    />

    <!-- Fullscreen Media Preview Modal -->
    <div
      v-if="previewMediaUrl"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
      @click="previewMediaUrl = null"
    >
      <button
        class="absolute top-4 right-4 p-2 text-white/70 hover:text-white bg-black/50 rounded-full"
        @click="previewMediaUrl = null"
      >
        <X class="w-6 h-6" />
      </button>
      <img :src="previewMediaUrl" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl" @click.stop />
    </div>

    <!-- Alert Modal for Kicks & System Notifications -->
    <AlertModal
      :isOpen="alertModal.isOpen"
      :title="alertModal.title"
      :message="alertModal.message"
      :type="alertModal.type"
      @confirm="alertModal.onConfirm"
    />

    <!-- Profile Edit Modal -->
    <div v-if="isEditProfileOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-bold text-white">Update Profile</h3>
          <button @click="isEditProfileOpen = false" class="text-slate-400 hover:text-white">
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="space-y-3 mb-5">
          <div class="flex items-center gap-3">
            <span class="text-3xl p-1.5 bg-slate-800 rounded-xl border border-slate-700">{{ editAvatar }}</span>
            <input
              v-model="editName"
              type="text"
              maxlength="20"
              class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
              placeholder="Your name"
            />
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button
              v-for="av in avatarChoices"
              :key="av"
              @click="editAvatar = av"
              class="w-8 h-8 rounded-lg text-base flex items-center justify-center transition border"
              :class="editAvatar === av ? 'bg-sky-500/20 border-sky-400' : 'bg-slate-950 border-slate-800 hover:border-slate-700'"
            >
              {{ av }}
            </button>
          </div>

          <!-- Google Sign-in to link account -->
          <div v-if="!authStore.isGoogleLinked" class="pt-3 border-t border-slate-800">
            <p class="text-xs text-slate-400 mb-2">Want to save your profile & history?</p>
            <button
              type="button"
              @click="handleGoogleSignInProfile"
              :disabled="isGoogleSigningIn"
              class="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Loader2 v-if="isGoogleSigningIn" class="w-3.5 h-3.5 animate-spin text-sky-400" />
              <LogIn v-else class="w-3.5 h-3.5 text-sky-400" />
              <span>{{ isGoogleSigningIn ? 'Signing in...' : 'Sign in with Google' }}</span>
            </button>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button
            @click="isEditProfileOpen = false"
            class="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white transition"
          >
            Cancel
          </button>
          <button
            @click="handleSaveProfile"
            class="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold shadow transition"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.12) transparent;
  transition: scrollbar-color 0.4s ease;
}

.custom-scrollbar.is-scrolling {
  scrollbar-color: rgba(148, 163, 184, 0.55) transparent;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.12);
  border-radius: 9999px;
  transition: background 0.4s ease;
}

.custom-scrollbar.is-scrolling::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.55);
}

:deep(.message-content) {
  overflow-wrap: break-word;
  word-break: break-word;
}
:deep(.message-content p) {
  margin-top: 0;
  margin-bottom: 0.35rem;
}
:deep(.message-content p:last-child) {
  margin-bottom: 0 !important;
}
:deep(.message-content ul),
:deep(.message-content ol) {
  margin-top: 0.25rem;
  margin-bottom: 0.25rem;
  padding-left: 1.25rem;
}
:deep(.message-content table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5rem 0;
}
:deep(.message-content th),
:deep(.message-content td) {
  border: 1px solid rgba(148, 163, 184, 0.2);
  padding: 0.35rem 0.5rem;
  text-align: left;
}
:deep(.message-content th) {
  background: rgba(15, 23, 42, 0.4);
  font-weight: 600;
}
</style>
