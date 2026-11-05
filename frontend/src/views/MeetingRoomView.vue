<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { Clock, Eye, Loader2, MessageSquare, PenTool, Power, Users, X } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import type { MessageItem } from '../types';
import { formatDate, isDuplicateBoardPointer, isMentioning } from '../utils/chat';
import { useNotificationSound } from '../composables/useNotificationSound';
import { useWhiteboardResize, useWhiteboardSession, type WhiteboardHandle } from '../composables/useWhiteboardSession';
import { useAiReadTracking } from '../composables/useAiReadTracking';
import { useStackedLayout } from '../composables/useStackedLayout';
import { setRecording, startResearchLog, stopResearchLog } from '../services/researchLog';
import { reopenStudySession } from '../services/session';
import { setRoomLocale, t } from '../i18n';

import RoomHeader from '../components/room/RoomHeader.vue';
import ChatMessage from '../components/room/ChatMessage.vue';
import DesignProgress from '../components/room/DesignProgress.vue';
import ChatStatusBubbles from '../components/room/ChatStatusBubbles.vue';
import ChatComposer from '../components/room/ChatComposer.vue';
import AssetsDrawer from '../components/room/AssetsDrawer.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import PdfViewerModal from '../components/PdfViewerModal.vue';
import AlertModal from '../components/AlertModal.vue';
import WhiteboardBoard from '../components/whiteboard/WhiteboardBoard.vue';
import LiveBoardViewer from '../components/whiteboard/LiveBoardViewer.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();
// Read-only entry from Admin > Room assignment (WaitingRoomView ?as=observer); survives a reload
roomStore.setViewOnly(route.query.view === 'readonly');
const { playNotificationSound } = useNotificationSound();

const roomId = route.params.roomId as string;
const pin = roomId.replace('room_', '');

// ---------- Experiment session (functions/src/session.js) ----------
const session = computed(() => roomStore.currentRoom?.session);
// The host of a study room is the researcher: an invisible, read-only observer who can End / Reopen.
// Observers (functions/src/roles.js) watch the same way; End / Reopen also for the administrator.
const isResearcher = computed(() => roomStore.isHost && Boolean(session.value));
const isObserving = computed(() => isResearcher.value || (roomStore.myStatus === 'observer' && Boolean(session.value)));
const canControlSession = computed(() => isResearcher.value || authStore.isAdmin);
// A room created by a participant has no researcher: its participants may restart an ended discussion
const canParticipantReopen = computed(() => Boolean(session.value) && !roomStore.currentRoom?.hostUid && roomStore.myStatus === 'approved');
const participantCount = computed(() => roomStore.onlineParticipants.length);

/** Why chat and whiteboards are locked for me right now, or null when I can take part. */
const lockReason = computed(() => {
  const s = session.value;
  if (!s) return roomStore.currentRoom?.roomStatus === 'ended' ? t('room.closedReadOnly') : null;
  if (s.phase === 'ended') return t('room.sessionEnded');
  if (isObserving.value) return t('room.observerReadOnly');
  if (s.phase === 'waiting') return t('room.waitingOthers', { count: participantCount.value, expected: s.expected });
  return null;
});

const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 1000);
const timeLeft = computed(() => {
  const endsAt = session.value?.endsAt;
  if (session.value?.phase !== 'running' || !endsAt) return null;
  const sec = Math.max(0, Math.round((endsAt - now.value) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
});

const isReopening = ref(false);
const reopen = async () => {
  if (!window.confirm(t(canControlSession.value ? 'room.reopenConfirm' : 'room.reopenConfirmParticipant'))) return;
  isReopening.value = true;
  try {
    await reopenStudySession(roomId);
  } catch (err: any) {
    roomStore.pushToast(t('room.reopenFailed'), err?.message || t('common.tryAgain'), 'error');
  } finally {
    isReopening.value = false;
  }
};

const showEndConfirm = ref(false);
const isEnding = ref(false);
const confirmEnd = async () => {
  isEnding.value = true;
  await roomStore.endMeetingForAll();
  isEnding.value = false;
  showEndConfirm.value = false;
};

// The room language (set by the experiment profile) drives the whole UI while inside the room
watch(() => roomStore.currentRoom?.language, lang => lang && setRoomLocale(lang), { immediate: true });

// Browser events are not recorded after the session ended (resumes on Reopen)
watch(() => session.value?.phase, phase => setRecording(phase !== 'ended'));

// ---------- Whiteboard ----------
const whiteboardRef = ref<WhiteboardHandle | null>(null);
const wb = useWhiteboardSession(whiteboardRef, () => lockReason.value, () => isObserving.value);
const { isWhiteboardOpen } = wb;
const { whiteboardWidth, isResizingWhiteboard, startWhiteboardResize } = useWhiteboardResize(whiteboardRef, isWhiteboardOpen);

// Phones and portrait tablets show chat or whiteboard, switched with tabs (useStackedLayout)
const isStacked = useStackedLayout();
const mobilePane = ref<'chat' | 'board'>('chat');
const unseenChat = ref(0);
const showPaneTabs = computed(() => isStacked.value && isWhiteboardOpen.value);
const showChatPane = computed(() => !showPaneTabs.value || mobilePane.value === 'chat');
const showBoardPane = computed(() => !showPaneTabs.value || mobilePane.value === 'board');
const switchPane = (pane: 'chat' | 'board') => {
  mobilePane.value = pane;
  if (pane === 'chat') {
    unseenChat.value = 0;
    if (!showScrollFab.value) scrollToBottom();
  }
};
// Opening a board (new, or from a chat card) brings it to the front; closing it returns to chat
watch(() => [isWhiteboardOpen.value, wb.activeBoardId.value] as const, ([open]) => switchPane(open ? 'board' : 'chat'));

const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const shareWhiteboardExport = (file: File) => composerRef.value?.sendFile(file);

// ---------- Drawers & modals (only one drawer open at a time) ----------
// Legacy rooms (no session) keep their own "closed by host" banner in the header
const isMeetingClosed = computed(() => Boolean(lockReason.value));
const isLegacyClosed = computed(() => !session.value && roomStore.currentRoom?.roomStatus === 'ended');
const showSessionBar = computed(() => Boolean(session.value) && (isObserving.value || session.value!.phase !== 'running'));
// Below the header (+ the notch inset when opened from the home screen)
const drawerTopOffset = computed(() => `calc(${isLegacyClosed.value || showSessionBar.value ? 89 : 56}px + env(safe-area-inset-top))`);
const isSettingsOpen = ref(false);
const isAssetsOpen = ref(false);

const toggleSettings = () => {
  isAssetsOpen.value = false;
  isSettingsOpen.value = !isSettingsOpen.value;
};
const toggleAssets = () => {
  isSettingsOpen.value = false;
  isAssetsOpen.value = !isAssetsOpen.value;
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
      // Observers see private drafts too (read-only)
      if (m.metadata?.isPrivate && !m.metadata?.wasPublished && !isObserving.value) return false;
    }
    return true;
  });
});

const showDateDivider = (msg: MessageItem, index: number) => {
  const prev = visibleChatMessages.value[index - 1];
  return !prev || new Date(msg.timestamp).toDateString() !== new Date(prev.timestamp).toDateString();
};

const chatContainerRef = ref<HTMLElement | null>(null);
const isAiMessage = (m: MessageItem) => m.senderUid === 'ai_mentor' || m.senderUid === 'ai_mentor_3d';
useAiReadTracking(chatContainerRef, () => visibleChatMessages.value.length);
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

// Double Diamond follows the chat: scrolled up, it shows the stage of the message in the middle of the view
const progressViewAt = ref<number | null>(null);
let progressFrame = 0;
const updateProgressViewAt = () => {
  progressFrame = 0;
  const el = chatContainerRef.value;
  if (!el || !showScrollFab.value) {
    progressViewAt.value = null;
    return;
  }
  const middle = el.getBoundingClientRect().top + el.clientHeight / 2;
  const rows = el.querySelectorAll<HTMLElement>('[data-ts]');
  let at: number | null = null;
  for (const row of rows) {
    if (row.getBoundingClientRect().top > middle) break;
    at = Number(row.dataset.ts) || at;
  }
  progressViewAt.value = at;
};

const handleScroll = () => {
  const el = chatContainerRef.value;
  if (el) showScrollFab.value = el.scrollHeight - (el.scrollTop + el.clientHeight) > 100;
  if (!progressFrame) progressFrame = requestAnimationFrame(updateProgressViewAt);
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

// New message from someone else: chime, plus a toast if it @mentions me; follow the stream unless scrolled up
let lastKnownMsgCount = 0;
watch(() => roomStore.currentRoom?.messages.length, (count = 0) => {
  if (count && lastKnownMsgCount && count > lastKnownMsgCount) {
    const latest = roomStore.currentRoom!.messages[count - 1];
    if (latest && latest.senderUid !== authStore.uid && latest.senderUid !== 'system') {
      playNotificationSound();
      if (!showChatPane.value) unseenChat.value++;
      if (isMentioning(latest, authStore.displayName, authStore.uid)) {
        roomStore.pushToast(
          t('room.taggedBy', { icon: latest.senderUid === 'ai_mentor' ? '✨' : '💬', name: latest.senderName }),
          '', // title only; the message itself is in the chat
          'info'
        );
      }
    }
  }
  if (count && count !== lastKnownMsgCount && !showScrollFab.value) scrollToBottom();
  lastKnownMsgCount = count;
}, { immediate: true });

// ---------- Membership status ----------
// In the room I am always my nickname from the participant record (never the Google account name)
watch(() => [roomStore.currentRoom?.participants?.[authStore.uid], authStore.displayName, authStore.avatar] as const, ([me]) => {
  if (!me || roomStore.isHost || !me.consent) return;
  if (me.displayName && (me.displayName !== authStore.displayName || me.avatar !== authStore.avatar)) authStore.updateProfile(me.displayName, me.avatar);
});

watch(() => roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted, (muted, wasMuted) => {
  if (muted === true && wasMuted === false) roomStore.pushToast(t('room.mutedTitle'), t('room.mutedText'), 'warning');
});

watch(() => roomStore.myStatus, status => {
  if (status !== 'kicked') return;
  alertModal.value = {
    isOpen: true,
    title: t('room.removedTitle'),
    message: t('room.removedText'),
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
// A sketch from the chat goes onto the open whiteboard, or a new private draft
const putOnWhiteboard = async (url: string) => {
  if (!isWhiteboardOpen.value) await wb.openNewWhiteboard();
  if (!isWhiteboardOpen.value) return; // locked (session not running, observer)
  if (isStacked.value) switchPane('board');
  for (let i = 0; i < 30 && !whiteboardRef.value?.insertImageUrl; i++) await new Promise(r => setTimeout(r, 100));
  await whiteboardRef.value?.insertImageUrl?.(url);
};

const switchToParticipant = () => {
  roomStore.setViewOnly(false);
  roomStore.stopListening();
  router.replace(`/waiting/room_${pin}?as=participant`);
};

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
const handleWhiteboardBeforeUnload = () => {
  whiteboardRef.value?.flush?.();
};

onMounted(async () => {
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('beforeunload', handleWhiteboardBeforeUnload);
  window.addEventListener('pagehide', handleUnload);
  window.addEventListener('keydown', handleEscape);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    roomStore.pushToast(t('room.notFoundTitle'), t('room.notFoundText', { pin }), 'error');
    router.replace(authStore.isGoogleLinked ? '/dashboard' : '/');
    return;
  }
  roomStore.startFirestoreListener(roomId);

  // Also re-checks when the room doc arrives: a host's status is already 'approved' and never changes
  watch(() => [roomStore.myStatus, roomStore.currentRoom?.hostUid] as const, ([status]) => {
    if (!roomStore.currentRoom) return;
    if (roomStore.isHost || status === 'approved' || status === 'observer') {
      setRecording(session.value?.phase !== 'ended');
      if (isVerifyingAccess.value) startResearchLog(roomId, authStore.uid, isResearcher.value ? 'researcher' : status === 'observer' ? 'observer' : 'participant');
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
    if (!roomStore.isHost && me?.status !== 'approved' && me?.status !== 'observer') backToWaitingRoom();
    else isVerifyingAccess.value = false;
  }, 6000);
});

onBeforeRouteLeave(async (_to, _from, next) => {
  await wb.saveBeforeLeaving();
  next();
});

onUnmounted(() => {
  setRoomLocale(null);
  window.removeEventListener('beforeunload', handleUnload);
  window.removeEventListener('beforeunload', handleWhiteboardBeforeUnload);
  window.removeEventListener('pagehide', handleUnload);
  window.removeEventListener('keydown', handleEscape);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  whiteboardRef.value?.flush?.();
  clearTimeout(scrollbarTimer);
  clearTimeout(accessCheckTimer);
  clearInterval(clock);
  stopResearchLog();
  roomStore.updateParticipantWhiteboard(null);
  roomStore.stopListening();
});
</script>

<template>
  <div v-if="isVerifyingAccess" class="h-[100dvh] flex flex-col items-center justify-center bg-slate-950 text-slate-400">
    <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mb-3"></div>
    <p class="text-xs">{{ t('room.verifying') }}</p>
  </div>

  <div v-else class="h-[100dvh] flex flex-col bg-slate-950 text-slate-100 overflow-hidden px-safe pt-safe">
    <RoomHeader
      :pin="pin"
      :isMeetingClosed="isLegacyClosed"
      :isSettingsOpen="isSettingsOpen"
      :isAssetsOpen="isAssetsOpen"
      @toggle-settings="toggleSettings"
      @toggle-assets="toggleAssets"
    />

    <!-- Session status: the researcher always sees it; participants only before and after the session -->
    <div
      v-if="showSessionBar"
      class="h-[33px] border-b px-3 sm:px-4 text-xs flex items-center gap-3 shrink-0 z-40 relative"
      :class="session!.phase === 'ended' ? 'bg-amber-950/70 border-amber-500/30 text-amber-200' : 'bg-slate-900 border-slate-800 text-slate-300'"
    >
      <template v-if="isObserving">
        <span class="inline-flex items-center gap-1 text-violet-300 font-medium"><Eye class="w-3.5 h-3.5" /> {{ t('room.observer') }}</span>
        <span class="inline-flex items-center gap-1"><Users class="w-3.5 h-3.5" /> {{ session!.maxOnline ? t('room.onlineMax', { count: participantCount, max: session!.maxOnline }) : t('room.online', { count: participantCount }) }}</span>
        <span v-if="session!.phase === 'waiting'" class="text-slate-400 truncate">{{ t('room.startsAt', { count: session!.expected }) }}</span>
        <span v-else-if="session!.phase === 'running'" class="inline-flex items-center gap-1" :class="timeLeft === '0:00' ? 'text-amber-300' : ''">
          <Clock class="w-3.5 h-3.5" /> {{ timeLeft ? (timeLeft === '0:00' ? t('room.timeIsUp') : t('room.timeLeft', { time: timeLeft })) : t('room.noTimeLimit') }}
        </span>
        <span v-else>{{ t('room.sessionEndedShort') }}</span>
        <!-- Study staff watching read-only can take part instead (nickname and consent like everyone) -->
        <button
          v-if="!isResearcher && session!.phase !== 'ended'"
          @click="switchToParticipant"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-600 hover:bg-slate-800 text-[11px] font-semibold transition"
          :class="canControlSession ? '' : 'ml-auto'"
        >
          {{ t('room.switchToParticipant') }}
        </button>
        <button
          v-if="canControlSession && session!.phase === 'ended'"
          @click="reopen"
          :disabled="isReopening"
          class="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold transition disabled:opacity-50"
        >
          {{ isReopening ? t('room.reopening') : t('room.reopen') }}
        </button>
        <button
          v-if="canControlSession && session!.phase !== 'ended'"
          @click="showEndConfirm = true"
          class="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-semibold transition"
        >
          <Power class="w-3.5 h-3.5" /> {{ t('room.end') }}
        </button>
      </template>
      <template v-else>
        <span class="inline-flex items-center gap-1.5 truncate" :class="canParticipantReopen && session!.phase === 'ended' ? '' : 'mx-auto'">
          <Loader2 v-if="session!.phase === 'waiting'" class="w-3.5 h-3.5 animate-spin shrink-0" />
          {{ session!.phase === 'ended' ? t('room.thanks') : lockReason }}
        </span>
        <button
          v-if="canParticipantReopen && session!.phase === 'ended'"
          @click="reopen"
          :disabled="isReopening"
          class="ml-auto shrink-0 inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-semibold transition disabled:opacity-50"
        >
          {{ isReopening ? t('room.reopening') : t('room.reopen') }}
        </button>
      </template>
    </div>

    <!-- Phones / portrait tablets: Chat | Whiteboard tabs while a board is open -->
    <div v-if="showPaneTabs" class="h-10 shrink-0 flex border-b border-slate-800 bg-slate-900 text-xs font-semibold">
      <button
        v-for="pane in (['chat', 'board'] as const)"
        :key="pane"
        class="flex-1 inline-flex items-center justify-center gap-1.5 border-b-2 transition-colors"
        :class="mobilePane === pane ? 'border-sky-500 text-ink' : 'border-transparent text-slate-400'"
        @click="switchPane(pane)"
      >
        <component :is="pane === 'chat' ? MessageSquare : PenTool" class="w-4 h-4" />
        {{ pane === 'chat' ? t('room.tabChat') : t('room.tabWhiteboard') }}
        <span v-if="pane === 'chat' && unseenChat" class="min-w-[18px] h-[18px] px-1 rounded-full bg-sky-600 text-white text-[10px] leading-[18px] text-center">{{ unseenChat > 99 ? '99+' : unseenChat }}</span>
      </button>
    </div>

    <div class="flex-1 flex overflow-hidden w-full relative" :class="{ 'select-none': isResizingWhiteboard }">
      <!-- Blocks the canvas from capturing the mouse while resizing -->
      <div v-if="isResizingWhiteboard" class="fixed inset-0 z-50 cursor-col-resize pointer-events-auto"></div>

      <div
        class="flex flex-col h-full w-full min-w-0"
        :class="[isResizingWhiteboard ? 'transition-none' : 'transition-all duration-75', !showChatPane ? '!hidden' : isWhiteboardOpen && !isStacked ? 'flex-1 min-w-[260px]' : 'flex-1']"
      >
        <!-- Double Diamond stage and milestones, judged by the AI, in the margin beside the chat (hidden in no-AI rooms) -->
        <div class="relative flex-1 min-h-0 flex flex-col">
          <DesignProgress :viewAt="progressViewAt" />
        <main ref="chatContainerRef" @scroll="handleScroll" class="flex-1 overflow-y-auto w-full relative custom-scrollbar" :class="{ 'is-scrolling': isScrolling }">
          <div class="max-w-5xl mx-auto w-full p-3 sm:p-5 space-y-3">
            <div v-for="(msg, idx) in visibleChatMessages" :key="msg.id" :id="'msg_' + msg.id" :data-ts="msg.timestamp" :data-ai-msg="isAiMessage(msg) ? msg.id : undefined" class="transition-colors duration-500 rounded-xl">
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
                @to-whiteboard="putOnWhiteboard"
                @reply="composerRef?.setReply($event)"
              />
            </div>
          </div>

          <div class="h-2 w-full"></div>

          <button
            v-show="showScrollFab"
            @click="scrollToBottom"
            class="sticky bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-full bg-slate-800 border border-slate-700 shadow-xl text-sky-400 hover:text-ink transition z-20 animate-fade-in opacity-90 hover:opacity-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
          </button>
        </main>
        </div>

        <!-- Fixed slot above the composer: typing / AI status never shifts the messages -->
        <ChatStatusBubbles />

        <ChatComposer
          ref="composerRef"
          :isMeetingClosed="isMeetingClosed"
          :lockedText="lockReason || undefined"
          :isWhiteboardOpen="isWhiteboardOpen"
          @open-whiteboard="wb.openNewWhiteboard"
          @sent="scrollToBottom"
        />
      </div>

      <div
        v-if="isWhiteboardOpen && !isStacked"
        class="flex w-2.5 hover:w-3 pointer-coarse:w-4 bg-slate-900 hover:bg-indigo-500/80 active:bg-indigo-600 transition-all cursor-col-resize shrink-0 z-30 items-center justify-center select-none touch-none group border-x border-slate-800"
        @pointerdown="startWhiteboardResize"
        :title="t('room.resizeHandle')"
      >
        <div class="h-8 w-1 rounded-full bg-slate-600 group-hover:bg-slate-300 transition-colors"></div>
      </div>

      <div
        v-if="isWhiteboardOpen"
        v-show="showBoardPane"
        class="h-full relative overflow-hidden bg-slate-900 shrink-0"
        :class="[isStacked ? 'w-full pb-safe' : 'min-w-[320px] max-w-[calc(100%-260px)]', { 'transition-none': isResizingWhiteboard }]"
        :style="isStacked ? undefined : whiteboardWidth ? { width: `${whiteboardWidth}px` } : { width: '68%' }"
      >
        <LiveBoardViewer
          v-if="wb.activeBoardId.value && isObserving"
          ref="whiteboardRef"
          :key="`live_${wb.whiteboardSessionKey.value}`"
          :roomId="roomId"
          :boardId="wb.activeBoardId.value"
          @close="wb.closeWhiteboard"
        />
        <WhiteboardBoard
          v-else-if="wb.activeBoardId.value"
          ref="whiteboardRef"
          :key="wb.whiteboardSessionKey.value"
          :roomId="roomId"
          :boardId="wb.activeBoardId.value"
          @close="wb.closeWhiteboard"
          @share="shareWhiteboardExport"
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

    <div v-if="showEndConfirm" class="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/75">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
        <h3 class="text-base font-bold text-rose-400 mb-2">{{ t('room.endConfirmTitle') }}</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          {{ t('room.endConfirmText') }}
        </p>
        <div class="flex gap-2">
          <button @click="showEndConfirm = false" class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition">{{ t('common.cancel') }}</button>
          <button @click="confirmEnd" :disabled="isEnding" class="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow disabled:opacity-50">
            {{ isEnding ? t('room.ending') : t('room.endSession') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgb(var(--c-n-400) / 0.15) transparent;
  transition: scrollbar-color 0.4s ease;
}
.custom-scrollbar.is-scrolling {
  scrollbar-color: rgb(var(--c-n-400) / 0.55) transparent;
}
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgb(var(--c-n-400) / 0.15);
  border-radius: 9999px;
  transition: background 0.4s ease;
}
.custom-scrollbar.is-scrolling::-webkit-scrollbar-thumb {
  background: rgb(var(--c-n-400) / 0.55);
}
</style>
