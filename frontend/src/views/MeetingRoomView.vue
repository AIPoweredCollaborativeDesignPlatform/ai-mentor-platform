<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { X } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import type { MessageItem } from '../types';
import { formatDate, isDuplicateBoardPointer, isMentioning } from '../utils/chat';
import { useNotificationSound } from '../composables/useNotificationSound';
import { useWhiteboardResize, useWhiteboardSession, type WhiteboardHandle } from '../composables/useWhiteboardSession';

import RoomHeader from '../components/room/RoomHeader.vue';
import ChatMessage from '../components/room/ChatMessage.vue';
import ChatStatusBubbles from '../components/room/ChatStatusBubbles.vue';
import ChatComposer from '../components/room/ChatComposer.vue';
import AssetsDrawer from '../components/room/AssetsDrawer.vue';
import ProfileModal from '../components/room/ProfileModal.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import PdfViewerModal from '../components/PdfViewerModal.vue';
import AlertModal from '../components/AlertModal.vue';
import CollaborativeWhiteboard from '../components/CollaborativeWhiteboard.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();
const { playNotificationSound } = useNotificationSound();

const roomId = route.params.roomId as string;
const pin = roomId.replace('room_', '');

// ---------- Whiteboard ----------
const whiteboardRef = ref<WhiteboardHandle | null>(null);
const wb = useWhiteboardSession(whiteboardRef);
const { isWhiteboardOpen } = wb;
const { whiteboardWidth, isResizingWhiteboard, startWhiteboardResize } = useWhiteboardResize(whiteboardRef, isWhiteboardOpen);

const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const shareWhiteboardExport = (file: File) => composerRef.value?.sendFile(file);

// ---------- Drawers & modals (only one drawer open at a time) ----------
const isMeetingClosed = computed(() => roomStore.currentRoom?.roomStatus === 'ended');
const drawerTopOffset = computed(() => (isMeetingClosed.value ? '89px' : '56px'));
const isSettingsOpen = ref(false);
const isAssetsOpen = ref(false);
const isProfileOpen = ref(false);

const toggleSettings = () => {
  isAssetsOpen.value = false;
  isSettingsOpen.value = !isSettingsOpen.value;
};
const toggleAssets = () => {
  isSettingsOpen.value = false;
  isAssetsOpen.value = !isAssetsOpen.value;
};
const openProfile = () => {
  isSettingsOpen.value = isAssetsOpen.value = false;
  isProfileOpen.value = true;
};

const docModal = ref({ isOpen: false, title: '', content: '' });
const openDocument = (title: string, content: string) => (docModal.value = { isOpen: true, title, content });
const pdfModal = ref({ isOpen: false, title: '', url: '' });
const openPdf = (title: string, url: string) => (pdfModal.value = { isOpen: true, title, url });
const previewMediaUrl = ref<string | null>(null);
const alertModal = ref({ isOpen: false, title: '', message: '', type: 'info' as 'warning' | 'info' | 'error', onConfirm: () => {} });

// ---------- Chat stream ----------
const pageEnteredAt = Date.now();
const isJoinNotice = (m: MessageItem) => m.senderUid === 'system' && m.content.includes('join');
const SAVE_NOTICES = ['saved', 'updated a shared whiteboard', 'sketchpad saved', 'whiteboard saved'];

// Hides old join notices (keeps the last 3 since I arrived), save notices, and private boards never shared
const visibleChatMessages = computed(() => {
  const all = roomStore.currentRoom?.messages || [];
  const recentJoinIds = new Set(all.filter(m => isJoinNotice(m) && m.timestamp >= pageEnteredAt).slice(-3).map(m => m.id));
  return all.filter(m => {
    if (isJoinNotice(m)) return recentJoinIds.has(m.id);
    if (m.senderUid === 'system' && SAVE_NOTICES.some(s => m.content.toLowerCase().includes(s))) return false;
    if (m.type === 'whiteboard_state') {
      if (isDuplicateBoardPointer(m, all)) return false;
      if (m.metadata?.isPrivate && !m.metadata?.wasPublished) return false;
    }
    return true;
  });
});

const showDateDivider = (msg: MessageItem, index: number) => {
  const prev = visibleChatMessages.value[index - 1];
  return !prev || new Date(msg.timestamp).toDateString() !== new Date(prev.timestamp).toDateString();
};

const chatContainerRef = ref<HTMLElement | null>(null);
const showScrollFab = ref(false);
const isScrolling = ref(false);
let scrollbarTimer: ReturnType<typeof setTimeout> | undefined;

// Retries cover late layout shifts from images and 3D viewers
const scrollToBottom = () => {
  const scroll = () => {
    if (chatContainerRef.value) chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
  };
  nextTick(scroll);
  [50, 150, 300, 600, 1000, 2000].forEach(delay => setTimeout(scroll, delay));
};

const handleScroll = () => {
  const el = chatContainerRef.value;
  if (el) showScrollFab.value = el.scrollHeight - (el.scrollTop + el.clientHeight) > 100;
  isScrolling.value = true;
  clearTimeout(scrollbarTimer);
  scrollbarTimer = setTimeout(() => (isScrolling.value = false), 3000);
};

const scrollToMessage = (id: string) => {
  isAssetsOpen.value = false;
  setTimeout(() => {
    const el = document.getElementById('msg_' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('bg-sky-500/20');
    setTimeout(() => el.classList.remove('bg-sky-500/20'), 2000);
  }, 300); // wait for the drawer to close
};

watch(() => [roomStore.isAnalyzing, roomStore.isGenerating3D], ([analyzing, generating]) => {
  if (analyzing || generating) scrollToBottom();
});

// New message from someone else: chime, plus a toast if it @mentions me; follow the stream unless scrolled up
let lastKnownMsgCount = 0;
watch(() => roomStore.currentRoom?.messages.length, (count = 0) => {
  if (count && lastKnownMsgCount && count > lastKnownMsgCount) {
    const latest = roomStore.currentRoom!.messages[count - 1];
    if (latest && latest.senderUid !== authStore.uid && latest.senderUid !== 'system') {
      playNotificationSound();
      if (isMentioning(latest, authStore.displayName, authStore.uid)) {
        roomStore.pushToast(
          latest.senderUid === 'ai_mentor' ? '✨ AI Mentor tagged you' : `💬 ${latest.senderName} tagged you`,
          latest.content.slice(0, 100),
          'info'
        );
      }
    }
  }
  if (count && count !== lastKnownMsgCount && !showScrollFab.value) scrollToBottom();
  lastKnownMsgCount = count;
}, { immediate: true });

// ---------- Membership status ----------
watch(() => roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted, (muted, wasMuted) => {
  if (muted === true && wasMuted === false) roomStore.pushToast('Microphone Muted', 'You have been muted by the host.', 'warning');
});

watch(() => roomStore.myStatus, status => {
  if (status !== 'kicked') return;
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
});

// ---------- Access verification & lifecycle ----------
const isVerifyingAccess = ref(true);
let accessCheckTimer: ReturnType<typeof setTimeout> | undefined;
const backToWaitingRoom = () => {
  roomStore.stopListening();
  router.replace(`/waiting/room_${pin}`);
};

const handleUnload = () => roomStore.leaveRoom();
const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') roomStore.sendHeartbeat();
};
const handleEscape = (e: KeyboardEvent) => {
  if (e.key === 'Escape') isAssetsOpen.value = false;
};
// Publisher closing the tab: save and end the live session so others are not left on a dead board
const handleWhiteboardBeforeUnload = () => {
  if (wb.isMyLiveSessionOpen()) {
    whiteboardRef.value?.triggerAutoSaveAsAsset?.();
    roomStore.endWhiteboardSession();
  }
};

onMounted(async () => {
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('beforeunload', handleWhiteboardBeforeUnload);
  window.addEventListener('pagehide', handleUnload);
  window.addEventListener('keydown', handleEscape);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    roomStore.pushToast('Meeting Not Found', `Meeting room ${pin} does not exist or has been deleted.`, 'error');
    router.replace(authStore.isGoogleLinked ? '/dashboard' : '/');
    return;
  }
  roomStore.startFirestoreListener(roomId);

  // Also re-checks when the room doc arrives: a host's status is already 'approved' and never changes
  watch(() => [roomStore.myStatus, roomStore.currentRoom?.hostUid] as const, ([status]) => {
    if (!roomStore.currentRoom) return;
    if (roomStore.isHost || status === 'approved') {
      isVerifyingAccess.value = false;
      clearTimeout(accessCheckTimer);
      scrollToBottom();
    } else if (status === 'rejected' || status === 'kicked') {
      backToWaitingRoom();
    }
  });

  // Safety net if the status never resolves
  accessCheckTimer = setTimeout(() => {
    if (!isVerifyingAccess.value) return;
    const me = roomStore.currentRoom?.participants?.[authStore.uid];
    if (!roomStore.isHost && me?.status !== 'approved') backToWaitingRoom();
    else isVerifyingAccess.value = false;
  }, 6000);
});

onBeforeRouteLeave(async (_to, _from, next) => {
  await wb.saveBeforeLeaving();
  next();
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleUnload);
  window.removeEventListener('beforeunload', handleWhiteboardBeforeUnload);
  window.removeEventListener('pagehide', handleUnload);
  window.removeEventListener('keydown', handleEscape);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (roomStore.currentRoom?.whiteboardActive && roomStore.currentRoom?.whiteboardHostUid === authStore.uid) {
    whiteboardRef.value?.triggerAutoSaveAsAsset?.();
    roomStore.endWhiteboardSession();
  }
  clearTimeout(scrollbarTimer);
  clearTimeout(accessCheckTimer);
  roomStore.updateParticipantWhiteboard(null);
  roomStore.stopListening();
});
</script>

<template>
  <div v-if="isVerifyingAccess" class="h-[100dvh] flex flex-col items-center justify-center bg-slate-950 text-slate-400">
    <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mb-3"></div>
    <p class="text-xs">Verifying credentials & permissions...</p>
  </div>

  <div v-else class="h-[100dvh] flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
    <RoomHeader
      :pin="pin"
      :isMeetingClosed="isMeetingClosed"
      :isSettingsOpen="isSettingsOpen"
      :isAssetsOpen="isAssetsOpen"
      @toggle-settings="toggleSettings"
      @toggle-assets="toggleAssets"
      @open-profile="openProfile"
    />

    <div class="flex-1 flex overflow-hidden w-full relative" :class="{ 'select-none': isResizingWhiteboard }">
      <!-- Blocks the canvas from capturing the mouse while resizing -->
      <div v-if="isResizingWhiteboard" class="fixed inset-0 z-50 cursor-col-resize pointer-events-auto"></div>

      <div
        class="flex flex-col h-full w-full min-w-0"
        :class="[isResizingWhiteboard ? 'transition-none' : 'transition-all duration-75', isWhiteboardOpen ? 'hidden sm:flex sm:flex-1 sm:min-w-[260px]' : 'flex-1']"
      >
        <main ref="chatContainerRef" @scroll="handleScroll" class="flex-1 overflow-y-auto w-full relative custom-scrollbar" :class="{ 'is-scrolling': isScrolling }">
          <div class="max-w-5xl mx-auto w-full p-3 sm:p-5 space-y-3">
            <div v-for="(msg, idx) in visibleChatMessages" :key="msg.id" :id="'msg_' + msg.id" class="transition-colors duration-500 rounded-xl">
              <div v-if="showDateDivider(msg, idx)" class="flex items-center justify-center my-3.5 gap-3 select-none">
                <div class="h-px bg-slate-700/40 flex-1 max-w-[120px] sm:max-w-[160px]"></div>
                <span class="text-[11px] font-mono font-medium text-slate-500 tracking-wider">{{ formatDate(msg.timestamp) }}</span>
                <div class="h-px bg-slate-700/40 flex-1 max-w-[120px] sm:max-w-[160px]"></div>
              </div>
              <ChatMessage
                :msg="msg"
                :isMeetingClosed="isMeetingClosed"
                :isResizing="isResizingWhiteboard"
                @open-whiteboard="wb.openWhiteboardAsset"
                @open-document="openDocument"
                @open-pdf="openPdf"
                @preview-media="previewMediaUrl = $event"
                @reply="composerRef?.setReply($event)"
              />
            </div>
            <ChatStatusBubbles />
          </div>

          <div class="h-2 w-full"></div>

          <button
            v-show="showScrollFab"
            @click="scrollToBottom"
            class="sticky bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-full bg-slate-800 border border-slate-700 shadow-xl text-sky-400 hover:text-white transition z-20 animate-fade-in opacity-90 hover:opacity-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
          </button>
        </main>

        <ChatComposer
          ref="composerRef"
          :isMeetingClosed="isMeetingClosed"
          :isWhiteboardOpen="isWhiteboardOpen"
          @open-whiteboard="wb.openNewWhiteboard"
          @sent="scrollToBottom"
        />
      </div>

      <div
        v-if="isWhiteboardOpen"
        class="hidden sm:flex w-2.5 hover:w-3 bg-slate-900 hover:bg-indigo-500/80 active:bg-indigo-600 transition-all cursor-col-resize shrink-0 z-30 items-center justify-center select-none group border-x border-slate-800"
        @mousedown="startWhiteboardResize"
        title="Drag to resize whiteboard (drag to right edge to close)"
      >
        <div class="h-8 w-1 rounded-full bg-slate-600 group-hover:bg-white transition-colors"></div>
      </div>

      <div
        v-if="isWhiteboardOpen"
        class="h-full relative overflow-hidden bg-slate-900 shrink-0 w-full sm:w-auto min-w-[320px] max-w-[calc(100%-260px)]"
        :class="{ 'transition-none': isResizingWhiteboard }"
        :style="whiteboardWidth ? { width: `${whiteboardWidth}px` } : { width: '68%' }"
      >
        <CollaborativeWhiteboard
          ref="whiteboardRef"
          :key="wb.whiteboardSessionKey.value"
          :initialJson="wb.currentWhiteboardJson.value"
          :activeAssetId="wb.activeWhiteboardAssetId.value"
          :isSharedSession="wb.isWhiteboardSharedSession.value"
          :isPublic="wb.activeWhiteboardIsPublic.value"
          :assetCreatorUid="wb.activeWhiteboardCreatorUid.value"
          @close="wb.closeWhiteboard"
          @share="shareWhiteboardExport"
          @save-state="wb.saveWhiteboardState"
        />
      </div>
    </div>

    <AssetsDrawer
      :isOpen="isAssetsOpen"
      :topOffset="drawerTopOffset"
      @close="isAssetsOpen = false"
      @open-whiteboard="wb.openWhiteboardAsset"
      @open-document="openDocument"
      @scroll-to="scrollToMessage"
    />
    <HostControlDrawer :isOpen="isSettingsOpen" :topOffset="drawerTopOffset" @close="isSettingsOpen = false" />
    <DocumentModal :isOpen="docModal.isOpen" :title="docModal.title" :content="docModal.content" @close="docModal.isOpen = false" />
    <PdfViewerModal :isOpen="pdfModal.isOpen" :title="pdfModal.title" :pdfUrl="pdfModal.url" @close="pdfModal.isOpen = false" />

    <div v-if="previewMediaUrl" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4" @click="previewMediaUrl = null">
      <button class="absolute top-4 right-4 p-2 text-white/70 hover:text-white bg-black/50 rounded-full" @click="previewMediaUrl = null">
        <X class="w-6 h-6" />
      </button>
      <img :src="previewMediaUrl" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl" @click.stop />
    </div>

    <AlertModal :isOpen="alertModal.isOpen" :title="alertModal.title" :message="alertModal.message" :type="alertModal.type" @confirm="alertModal.onConfirm" />
    <ProfileModal :isOpen="isProfileOpen" @close="isProfileOpen = false" />
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
