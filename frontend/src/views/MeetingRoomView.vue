<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
  Loader2
} from 'lucide-vue-next';

import ParametricViewer3D from '../components/ParametricViewer3D.vue';
import ModelViewerGLB from '../components/ModelViewerGLB.vue';
import MoodBoardViewer from '../components/MoodBoardViewer.vue';
import FactCheckViewer from '../components/FactCheckViewer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';
import AlertModal from '../components/AlertModal.vue';
import PdfViewerModal from '../components/PdfViewerModal.vue';
import WhiteboardModal from '../components/WhiteboardModal.vue';
import { currentLocale, setLocale, t, type SupportedLocale } from '../i18n';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const isWhiteboardOpen = ref(false);

const handleShareWhiteboard = async (file: File) => {
  await stageFile(file);
  await handleSend();
};

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');

const isDrawerOpen = ref(false);
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

const handleGoogleSignInProfile = async () => {
  try {
    const res = await authStore.upgradeWithGoogle();
    if (res.previousAnonUid && roomStore.currentRoom) {
      await roomStore.transferHostOwnership(res.previousAnonUid, authStore.uid);
    }
    roomStore.pushToast('Signed In', `Signed in as ${authStore.displayName}`, 'success');
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user') {
      roomStore.pushToast('Sign-In Failed', err?.message || 'Could not complete sign in', 'error');
    }
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

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
    }
  });
  
  // Progressive retry to handle heavy DOM rendering on initial load
  [100, 300, 600, 1000].forEach(delay => {
    setTimeout(() => {
      if (chatContainerRef.value) {
        chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
      }
    }, delay);
  });
};

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

const handleSend = async () => {
  if (isMeetingClosed.value) return;
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;

  const text = inputMessage.value.trim();
  const attachment = stagedAttachment.value;

  if (!text && !attachment) return;

  inputMessage.value = '';
  stagedAttachment.value = null;

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
    await roomStore.sendMessage(text);
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
  inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
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

watch(() => roomStore.currentRoom?.messages, () => {
  scrollToBottom();
}, { deep: true, immediate: true });

let accessCheckTimer: any = null;

onMounted(async () => {
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('pagehide', handleUnload);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // 1. Verify meeting exists
  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    roomStore.pushToast('Meeting Not Found', `Meeting room ${pin} does not exist.`, 'error');
    router.replace('/');
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

onUnmounted(() => {
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
          <div class="flex items-center gap-1.5">
            <h1 class="font-bold text-xs sm:text-base text-white truncate max-w-[110px] xs:max-w-[160px] sm:max-w-xs">
              {{ roomStore.currentRoom?.roomName || 'Meeting' }}
            </h1>
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
              {{ roomStore.onlineParticipants.length }} / {{ roomStore.approvedParticipants.length }} 在線
            </span>
            <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● Host</span>
            <span class="text-[10px] text-slate-500 font-mono hidden sm:inline">v1.7.2</span>
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

    <!-- Chat Stream Area with 3-second fading scrollbar -->
    <main
      ref="chatContainerRef"
      @scroll="handleScroll"
      class="flex-1 overflow-y-auto w-full relative custom-scrollbar"
      :class="{ 'is-scrolling': isScrolling }"
    >
      <div class="max-w-5xl mx-auto w-full p-3 sm:p-5 space-y-3">
        <div
          v-for="msg in roomStore.currentRoom?.messages"
          :key="msg.id"
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
          class="flex gap-2.5"
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
            class="flex flex-col min-w-0"
            :class="[
              msg.senderUid === authStore.uid ? 'items-end' : 'items-start',
              msg.type === 'ai_asset' ? 'w-full max-w-2xl sm:max-w-3xl' : 'max-w-2xl'
            ]"
          >
            <!-- Sender info -->
            <div class="flex items-center gap-1.5 mb-0.5 text-[11px] text-slate-400">
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
            </div>

            <!-- Frameless Media Container (When message has image/video and no caption text) -->
            <div
              v-if="msg.type === 'file' && msg.fileData && (msg.fileData.type === 'image' || msg.fileData.type === 'video') && !msg.content"
              class="rounded-2xl overflow-hidden max-w-sm shadow-md hover:shadow-xl transition"
            >
              <!-- Image Preview (Frameless) -->
              <div
                v-if="msg.fileData.type === 'image'"
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
                msg.type === 'ai_asset' ? 'w-full' : 'max-w-[88%] sm:max-w-[80%]'
              ]"
            >
              <!-- Message Text -->
              <div
                v-if="msg.content && (!msg.type.startsWith('file') || (!msg.content.startsWith('Shared image:') && !msg.content.startsWith('Shared video:') && !msg.content.startsWith('Shared document:')))"
                class="whitespace-pre-wrap break-words prose prose-sm prose-invert max-w-none text-slate-200"
                v-html="formatMessageText(msg.content)"
                @click="handleMessageClick"
              ></div>

              <!-- Embedded File / Media Attachment -->
              <div v-if="msg.type === 'file' && msg.fileData" :class="{ 'mt-2': msg.content }">
                <!-- Image Preview (Inside bubble when caption is present) -->
                <div
                  v-if="msg.fileData.type === 'image'"
                  class="rounded-xl overflow-hidden max-w-sm cursor-pointer group shadow"
                  @click="previewMediaUrl = msg.fileData.url"
                  title="Click to expand"
                >
                  <img
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

              <!-- Embedded 3D Parametric Viewer -->
              <ParametricViewer3D
                v-if="msg.type === 'ai_asset' && msg.assetType === 'parametric_3d'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded GLB Model Viewer -->
              <ModelViewerGLB
                v-if="msg.type === 'ai_asset' && msg.assetType === 'mesh_3d'"
                :assetData="msg.assetPayload"
                :message="msg"
                @refine="handleRefineModel"
              />

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

          <!-- Whiteboard & Sketchpad Button -->
          <button
            @click="isWhiteboardOpen = true"
            :disabled="isMeetingClosed || roomStore.currentRoom?.participants[authStore.uid]?.isMuted"
            class="p-2.5 rounded-xl border border-indigo-500/40 bg-indigo-950/40 hover:bg-indigo-900/60 text-indigo-300 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
            title="Open Collaborative Design Whiteboard & Annotate"
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

          <!-- Send Button with Cooldown Lock and Throttle -->
          <button
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

    <!-- Host Control Drawer -->
    <HostControlDrawer
      :isOpen="isDrawerOpen"
      @close="isDrawerOpen = false"
    />

    <!-- Design Whiteboard Modal -->
    <WhiteboardModal
      v-if="isWhiteboardOpen"
      @close="isWhiteboardOpen = false"
      @share="handleShareWhiteboard"
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
              class="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-semibold transition flex items-center justify-center gap-2"
            >
              <LogIn class="w-3.5 h-3.5 text-sky-400" />
              <span>Sign in with Google</span>
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
