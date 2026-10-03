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
  Settings
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
      isLocalWhiteboardPublisher.value = true;
    }
  }
  if (wasActive === true && isActive === false) {
    if (isLocalWhiteboardPublisher.value) {
      // Keep publisher's whiteboard open seamlessly as a Personal Board!
      isLocalWhiteboardPublisher.value = false;
      return;
    }
    if (isJoiningSharedBoard.value && isWhiteboardOpen.value) {
      isWhiteboardOpen.value = false;
      isJoiningSharedBoard.value = false;
      activeWhiteboardAssetId.value = null;
      currentWhiteboardJson.value = undefined;
      roomStore.pushToast('Collaboration Ended', 'The shared whiteboard session has ended.', 'info');
    }
  }
});

const isWhiteboardSharedSession = computed(() => {
  if (isLocalWhiteboardPublisher.value) return true;
  if (isJoiningSharedBoard.value) return true;
  if (activeWhiteboardAssetId.value) {
    const asset = roomStore.currentRoom?.messages.find(m => m.id === activeWhiteboardAssetId.value);
    if (asset?.metadata?.isSharedPost || (asset && !asset.metadata?.isPrivate)) {
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
  isJoiningSharedBoard.value = false;
  activeWhiteboardAssetId.value = null;
  currentWhiteboardJson.value = undefined;
  whiteboardSessionKey.value = 'wb_new_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  isWhiteboardOpen.value = true;
};

const handleJoinSharedWhiteboard = async () => {
  if (isWhiteboardOpen.value && whiteboardRef.value?.hasUnsavedChanges) {
    try {
      await whiteboardRef.value?.triggerAutoSaveAsAsset();
    } catch (e) {
      console.warn('Auto save before joining shared board error:', e);
    }
  }
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
  // Check if whiteboard is in shared session or personal session
  const isShared = isWhiteboardSharedSession.value;
  const isPrivate = isShared ? false : (isPrivateParam !== undefined ? isPrivateParam : true);

  const hostUid = roomStore.currentRoom?.whiteboardHostUid || authStore.uid;
  const hostName = roomStore.currentRoom?.whiteboardHostName || authStore.displayName || 'Host';

  if (isShared) {
    // In shared session, look for the shared asset in this room
    if (!targetAssetId) {
      const existingShared = roomStore.currentRoom?.messages.find(m => 
        m.type === 'whiteboard_state' && 
        (!hostUid || m.metadata?.creatorUid === hostUid || m.senderUid === hostUid) && 
        (m.metadata?.isSharedPost || !m.metadata?.isPrivate)
      );
      if (existingShared) {
        targetAssetId = existingShared.id;
        activeWhiteboardAssetId.value = existingShared.id;
      }
    }
  } else {
    // Ownership verification for personal/private mode: if editing another user's asset, fork into a new personal asset
    const existingMsg = targetAssetId ? roomStore.currentRoom?.messages.find(m => m.id === targetAssetId) : null;
    const isOwner = existingMsg ? (existingMsg.metadata?.creatorUid === authStore.uid || existingMsg.senderUid === authStore.uid) : true;
    if (targetAssetId && !isOwner) {
      targetAssetId = null;
      activeWhiteboardAssetId.value = null;
    }
  }

  const meta = {
    whiteboardJson: json,
    isPrivate,
    isSharedPost: isShared,
    creatorUid: isShared ? hostUid : authStore.uid,
    creatorName: isShared ? hostName : (authStore.displayName || 'Participant'),
    creatorAvatar: isShared ? (roomStore.currentRoom?.participants[hostUid]?.avatar || '🎨') : (authStore.avatar || '🎨'),
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
    currentWhiteboardJson.value = json;
  } else {
    // Create new whiteboard asset under appropriate owner
    const newId = await roomStore.sendCustomMessage({
      senderUid: authStore.uid,
      senderName: authStore.displayName || 'Participant',
      senderAvatar: authStore.avatar || '🎨',
      type: 'whiteboard_state',
      content: isPrivate ? 'Personal Draft' : `${hostName} shared a collaborative whiteboard`,
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
      currentWhiteboardJson.value = json;
      targetAssetId = newId;
      if (whiteboardRef.value) {
        (whiteboardRef.value as any).setCurrentAssetId?.(newId);
      }
    }
  }

  // Trigger Gemini Whiteboard Vision Background Memory Record
  roomStore.recordWhiteboardSnapshotMemory(previewUrl, json, targetAssetId || undefined);
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
  if (!roomStore.currentRoom?.whiteboardActive && !isHost && msg.metadata?.isPrivate && !msg.metadata?.isSharedPost) {
    roomStore.pushToast('Access Restricted', 'This whiteboard is private.', 'warning');
    return;
  }
  if (roomStore.currentRoom?.whiteboardActive && (msg.metadata?.isSharedPost || !msg.metadata?.isPrivate)) {
    await handleJoinSharedWhiteboard();
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
  // Open locally with asset JSON; DO NOT involuntarily trigger broadcast session!
  isJoiningSharedBoard.value = false;
  activeWhiteboardAssetId.value = msg.id;
  currentWhiteboardJson.value = msg.metadata?.whiteboardJson || null;
  whiteboardSessionKey.value = 'wb_asset_' + msg.id + '_' + Date.now();
  isWhiteboardOpen.value = true;
};

const activeAssetTab = ref<'public' | 'personal'>('public');

// All Public Album Items (Shared whiteboards, 3D models, images, moodboards)
const allPublicAlbumItems = computed(() => {
  if (!roomStore.currentRoom?.messages) return [];
  const items = roomStore.currentRoom.messages.filter(m => {
    if (m.type === 'whiteboard_state') {
      if (m.metadata?.isPrivate && !m.metadata?.isSharedPost) return false;
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
      if (m.metadata?.isPrivate && !m.metadata?.isSharedPost) {
        return false;
      }
      if (m.content?.includes('Personal Draft')) {
        return false;
      }
      if (m.metadata?.isAutoSave && !m.metadata?.isSharedPost) {
        return false;
      }
    }

    return true;
  });
});

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');

const isDrawerOpen = ref(false);
const isAssetsDrawerOpen = ref(false);

watch(isAssetsDrawerOpen, (isOpen) => {
  if (!isOpen) {
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

const onInputTextarea = () => {
  adjustTextarea();
  roomStore.setMyTyping(true);
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

let lastKnownMsgCount = 0;
watch(() => roomStore.currentRoom?.messages.length, (newCount) => {
  if (newCount && lastKnownMsgCount && newCount > lastKnownMsgCount) {
    const latest = roomStore.currentRoom?.messages[roomStore.currentRoom.messages.length - 1];
    if (latest && latest.senderUid !== authStore.uid && latest.senderUid !== 'system') {
      playNotificationSound();
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
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
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

const handleRefineModel = async (msg: MessageItem, customPrompt?: string) => {
  if (isMeetingClosed.value) return;
  await roomStore.refineMeshyModel(msg, customPrompt);
};

const formatMessageText = (text: string) => {
  if (!text) return '';
  // Escape HTML first to prevent XSS
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
    
  // Markdown links: [title](url) -> <a href="url" target="_blank" class="text-sky-400 hover:underline">title</a>
  let html = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, 
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-sky-400 hover:underline pointer-events-auto" data-link="true">$1</a>'
  );
  
  // Bare URLs: https://... -> <a href="...">https://...</a> (but avoid double replacing inside already replaced tags)
  // Simplified generic approach for bare URLs:
  html = html.replace(
    /(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="text-sky-400 hover:underline pointer-events-auto" data-link="true">$2</a>'
  );

  return html;
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
    scrollToBottom();
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
      class="bg-amber-950/70 border-b border-amber-500/30 px-3 sm:px-4 py-2 text-center text-xs text-amber-300 flex items-center justify-center gap-1.5 shrink-0 z-20"
    >
      <Lock class="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span class="truncate">Meeting closed by host (Read-only).</span>
      <button
        v-if="roomStore.isHost"
        @click="isDrawerOpen = true"
        class="underline font-semibold hover:text-white ml-1 cursor-pointer shrink-0"
      >
        Reopen
      </button>
    </div>

    <!-- Top Navigation Bar -->
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-2.5 sm:px-5 flex items-center justify-between z-10 shrink-0 gap-2">
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
            @click="isDrawerOpen = true"
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
          @click="isDrawerOpen = true"
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
          @click="isEditProfileOpen = true"
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
          @click="isAssetsDrawerOpen = true"
          class="relative inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-amber-400 font-medium transition cursor-pointer min-h-[36px]"
          title="Assets Library"
        >
          <Box class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Assets</span>
        </button>

        <!-- Controls Drawer Button -->
        <button
          @click="isDrawerOpen = true"
          class="relative inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold shadow transition cursor-pointer min-h-[36px]"
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
          v-for="msg in visibleChatMessages"
          :key="msg.id"
          :id="'msg_' + msg.id"
          class="transition-colors duration-500 rounded-xl"
        >
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
              msg.type === 'ai_asset' ? 'w-full max-w-2xl sm:max-w-3xl' : 'max-w-2xl'
            ]"
          >
            <!-- Unified Hover Action Bar (Emojis, Reply, Copy) -->
            <div
              v-if="!isMeetingClosed && msg.senderUid !== 'system'"
              class="absolute -top-4 z-30 hidden group-hover/msg:flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-900/95 border border-slate-700/90 shadow-xl backdrop-blur-sm select-none transition-all duration-150 animate-in fade-in zoom-in-90"
              :class="msg.senderUid === authStore.uid ? 'right-0' : 'left-0'"
            >
              <!-- 6 Emojis -->
              <button
                v-for="emoji in ['👍', '❤️', '😂', '😮', '😢', '🎉']"
                :key="emoji"
                @click.stop="roomStore.toggleMessageReaction(msg.id, emoji)"
                class="w-6 h-6 rounded-full hover:bg-slate-700/80 flex items-center justify-center text-xs sm:text-sm transition transform hover:scale-130 active:scale-95 cursor-pointer"
                :class="{ 'bg-sky-500/25 ring-1 ring-sky-400/50 scale-110': msg.reactions?.[emoji]?.includes(authStore.uid) }"
                :title="`React ${emoji}`"
              >
                {{ emoji }}
              </button>

              <!-- Subtle Divider -->
              <div class="h-3.5 w-px bg-slate-700/80 mx-0.5"></div>

              <!-- Reply Button -->
              <button
                @click.stop="replyToMessage(msg)"
                class="p-1 rounded-full hover:bg-slate-700/80 text-slate-400 hover:text-sky-400 transition cursor-pointer"
                title="Reply"
              >
                <CornerUpLeft class="w-3.5 h-3.5" />
              </button>

              <!-- Copy Button -->
              <button
                @click.stop="copyMessageContent(msg)"
                class="p-1 rounded-full hover:bg-slate-700/80 text-slate-400 hover:text-emerald-400 transition cursor-pointer"
                title="Copy message"
              >
                <Copy class="w-3.5 h-3.5" />
              </button>
            </div>

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
              class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed shadow whitespace-pre-wrap break-words min-w-0"
              :class="[
                msg.senderUid === authStore.uid ? 'bg-sky-600 text-white rounded-tr-xs' : '',
                msg.senderUid !== authStore.uid && msg.senderUid !== 'ai_mentor' ? 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-xs' : '',
                msg.senderUid === 'ai_mentor' ? 'bg-slate-900 border border-sky-500/40 text-sky-100 rounded-tl-xs shadow-sky-950/30' : '',
                msg.replyTo ? 'min-w-[180px] sm:min-w-[200px]' : '',
                msg.type === 'ai_asset' ? 'w-full' : 'max-w-[88%] sm:max-w-[80%]'
              ]"
            >
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
                class="whitespace-pre-wrap break-words prose prose-sm prose-invert max-w-none text-slate-200"
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
                class="mt-2 rounded-xl overflow-hidden shadow-lg relative border transition max-w-[210px] sm:max-w-[250px] bg-slate-900 select-none"
                :class="[
                  (msg.metadata?.isPrivate && !msg.metadata?.isSharedPost && msg.senderUid !== authStore.uid && msg.metadata?.creatorUid !== authStore.uid)
                    ? 'opacity-60 cursor-not-allowed border-slate-800'
                    : 'cursor-pointer group hover:border-indigo-500 border-indigo-500/40'
                ]"
                @click="openWhiteboardState(msg)"
              >
                <div class="relative w-full aspect-[4/3] bg-slate-950 flex items-center justify-center overflow-hidden">
                  <img
                    v-if="msg.fileData?.url"
                    :src="msg.fileData.url"
                    class="w-full h-full object-cover transition duration-300"
                    :class="[
                      (msg.metadata?.isPrivate && !msg.metadata?.isSharedPost && msg.senderUid !== authStore.uid && msg.metadata?.creatorUid !== authStore.uid)
                        ? 'grayscale brightness-75'
                        : 'group-hover:scale-105'
                    ]"
                  />
                  <div v-else class="text-slate-600 flex flex-col items-center">
                    <Palette class="w-8 h-8 opacity-40" />
                  </div>

                  <!-- Locked Overlay for non-hosts when explicitly private draft -->
                  <div
                    v-if="msg.metadata?.isPrivate && !msg.metadata?.isSharedPost && msg.senderUid !== authStore.uid && msg.metadata?.creatorUid !== authStore.uid"
                    class="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center p-2 text-center backdrop-blur-xs"
                  >
                    <div class="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mb-1">
                      <Lock class="w-3.5 h-3.5 text-amber-400" />
                    </div>
                    <span class="text-[10px] font-bold text-slate-200 leading-tight">Private Draft</span>
                    <span class="text-[8px] text-slate-400">Creator access only</span>
                  </div>

                  <!-- Active Live Badge (Top Right) -->
                  <div
                    v-else-if="roomStore.currentRoom?.whiteboardActive && (msg.metadata?.isSharedPost || !msg.metadata?.isPrivate)"
                    class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-full bg-emerald-500/90 text-white text-[9px] font-bold shadow flex items-center gap-1 animate-pulse"
                  >
                    <span class="w-1.5 h-1.5 rounded-full bg-white"></span>
                    <span>Live</span>
                  </div>

                  <!-- Active Join Hover Action -->
                  <div
                    v-if="!msg.metadata?.isPrivate || msg.metadata?.isSharedPost || msg.senderUid === authStore.uid || msg.metadata?.creatorUid === authStore.uid"
                    class="absolute inset-0 flex items-center justify-center bg-indigo-950/60 opacity-0 group-hover:opacity-100 transition z-10"
                  >
                    <span class="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-lg text-xs font-bold shadow-lg flex items-center gap-1.5 transition">
                      <Palette class="w-3.5 h-3.5" />
                      {{ roomStore.currentRoom?.whiteboardActive ? 'Join Canvas' : 'Open Whiteboard' }}
                    </span>
                  </div>
                </div>

                <!-- Footer label -->
                <div class="px-2.5 py-1.5 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px]">
                  <span class="text-slate-300 font-medium truncate max-w-[140px]">
                    {{ msg.metadata?.creatorName || msg.senderName }}'s Board
                  </span>
                  <span v-if="roomStore.currentRoom?.whiteboardActive && (msg.metadata?.isSharedPost || !msg.metadata?.isPrivate)" class="text-emerald-400 font-semibold text-[9px] shrink-0">
                    Active
                  </span>
                  <span v-else class="text-slate-500 text-[9px] shrink-0">
                    Saved
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

            <!-- Emoji Reaction Counter Pills Underneath Message Bubble -->
            <div
              v-if="msg.reactions && Object.values(msg.reactions).some(u => u && u.length > 0)"
              class="flex flex-wrap items-center gap-1 mt-1 z-10 select-none"
              :class="msg.senderUid === authStore.uid ? 'justify-end' : 'justify-start'"
            >
              <template v-for="(uids, emoji) in msg.reactions" :key="emoji">
                <button
                  v-if="uids && uids.length > 0"
                  @click="roomStore.toggleMessageReaction(msg.id, String(emoji))"
                  class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium border transition cursor-pointer select-none"
                  :class="uids.includes(authStore.uid)
                    ? 'bg-sky-600/30 border-sky-400/80 text-sky-200 shadow-xs'
                    : 'bg-slate-900/90 border-slate-700/80 text-slate-300 hover:bg-slate-800'"
                  :title="`${uids.length} reaction${uids.length > 1 ? 's' : ''}`"
                >
                  <span class="text-xs">{{ emoji }}</span>
                  <span class="text-[10px] font-bold opacity-90">{{ uids.length }}</span>
                </button>
              </template>
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

          <!-- Textarea Input with Clipboard Paste -->
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
                : 'Type a message (e.g. @Mentor)...'"
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition resize-none min-h-[44px] max-h-32 overflow-y-auto disabled:opacity-50"
            rows="1"
          ></textarea>

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
          @close="isWhiteboardOpen = false; isJoiningSharedBoard = false; activeWhiteboardAssetId = null; currentWhiteboardJson = undefined;"
          @share="handleShareWhiteboard"
          @save-state="handleSaveWhiteboardState"
        />
      </div>
    </div>

    <!-- Assets / Album Drawer -->
    <div
      class="fixed inset-y-0 right-0 z-50 w-full sm:w-80 bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out"
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
              class="aspect-square rounded-xl bg-slate-950 border-2 overflow-hidden cursor-pointer transition group relative shadow-md border-indigo-500/40 hover:border-indigo-400"
              @click="!isManagingAssets && (openWhiteboardState(msg), isAssetsDrawerOpen = false)"
              title="Click to edit whiteboard"
            >
              <img :src="msg.fileData?.url" class="w-full h-full object-cover group-hover:scale-105 transition duration-300 opacity-85" />
              <!-- Badge -->
              <div class="absolute top-1 left-1 bg-indigo-950/90 text-indigo-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-indigo-500/50 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
                <Palette class="w-2.5 h-2.5 text-indigo-400" />
                <span>Whiteboard</span>
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
                class="aspect-square rounded-xl bg-slate-950 border-2 overflow-hidden cursor-pointer transition group relative shadow-md border-amber-500/40 hover:border-amber-400"
                @click="!isManagingAssets && (openWhiteboardState(msg), isAssetsDrawerOpen = false)"
                title="Click to edit hidden whiteboard"
              >
                <img :src="msg.fileData?.url" class="w-full h-full object-cover group-hover:scale-105 transition duration-300 opacity-70" />
                <!-- Badge -->
                <div class="absolute top-1 left-1 bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded text-[8px] font-bold border border-amber-500/50 backdrop-blur-sm flex items-center gap-1 z-10 shadow">
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
                <!-- Creator Name Pill (Bottom) -->
                <div class="absolute bottom-1 left-1 right-1 bg-slate-950/85 px-1.5 py-0.5 rounded text-[8px] text-slate-300 font-medium truncate backdrop-blur-xs z-10 flex items-center gap-1">
                  <span class="text-[9px]">{{ msg.metadata?.creatorAvatar || msg.senderAvatar || '🎨' }}</span>
                  <span class="truncate">{{ msg.metadata?.creatorName || msg.senderName || 'Member' }}</span>
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
            </template>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Overlay for Assets Drawer (Dimmed without blur) -->
    <div
      v-if="isAssetsDrawerOpen"
      @click="isAssetsDrawerOpen = false"
      class="fixed inset-0 z-40 bg-black/60 transition-opacity"
    ></div>

    <!-- Host Control Drawer -->
    <HostControlDrawer
      :isOpen="isDrawerOpen"
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
</style>
