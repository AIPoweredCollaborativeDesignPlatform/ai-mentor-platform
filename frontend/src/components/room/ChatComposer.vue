<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Box, Check, CornerUpLeft, FileText, Loader2, Palette, Paperclip, Send, Sparkles, X } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';
import type { MessageItem } from '../../types';
import { t } from '../../i18n';
import { compressImage, getVideoDuration, readAsDataUrl } from '../../utils/files';
import { useRoomAi } from '../../composables/useRoomAi';

const props = defineProps<{
  isMeetingClosed: boolean;
  isWhiteboardOpen: boolean;
  /** Placeholder while the composer is locked (waiting for the session, ended, observer) */
  lockedText?: string;
}>();
const emit = defineEmits<{
  (e: 'open-whiteboard'): void;
  (e: 'sent'): void;
}>();

const authStore = useAuthStore();
const roomStore = useRoomStore();

const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 32; // 30s limit with a little tolerance
const MAX_DOC_BYTES = 10 * 1024 * 1024;

const { aiEnabled, aiName, aiModules } = useRoomAi();

// Shortcuts for the AI; hidden entirely in no-AI rooms, and per disabled module
const quickTags = computed(() => {
  if (!aiEnabled.value) return [];
  const m = aiModules.value;
  return [
    { tag: '@Mentor', label: `@${aiName.value}`, icon: Sparkles, iconClass: '', accent: true, show: true },
    { tag: `@Mentor ${t('quick.3dText')}`, label: t('quick.3d'), icon: Box, iconClass: 'text-sky-400', show: m.enable3D },
    { tag: `@Mentor ${t('quick.moodText')}`, label: t('quick.mood'), icon: Palette, iconClass: 'text-amber-400', show: m.enableMoodboard },
    { tag: `@Mentor ${t('quick.factText')}`, label: t('quick.fact'), icon: Check, iconClass: 'text-emerald-400', show: m.enableFactRetrieval },
    { tag: `@Mentor ${t('quick.summaryText')}`, label: t('quick.summary'), icon: FileText, iconClass: 'text-purple-400', show: m.enableSummary }
  ].filter(q => q.show);
});

interface StagedAttachment {
  name: string;
  size: number;
  type: 'image' | 'video' | 'document';
  previewUrl?: string;
  dataUrl: string;
  mimeType: string;
}

const inputMessage = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const stagedAttachment = ref<StagedAttachment | null>(null);
const replyingTo = ref<MessageItem | null>(null);
const isUploadingFile = ref(false);

const isMuted = computed(() => Boolean(roomStore.currentRoom?.participants[authStore.uid]?.isMuted));
const isBlocked = computed(() => props.isMeetingClosed || isMuted.value);
const mentionsMentor = computed(() => inputMessage.value.toLowerCase().includes('@mentor'));

const adjustTextarea = () => {
  nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(Math.min(el.scrollHeight, 128), 44)}px`;
  });
};
watch(inputMessage, adjustTextarea);

// ---------- @mentions ----------
const isMentionMenuOpen = ref(false);
const mentionQuery = ref('');
const mentionMenuIndex = ref(0);
const mentionMatchStart = ref(-1);

const checkMentionTrigger = () => {
  const el = textareaRef.value;
  if (!el) return;
  const textBefore = el.value.slice(0, el.selectionStart);
  const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
  isMentionMenuOpen.value = Boolean(match);
  mentionMatchStart.value = match ? textBefore.lastIndexOf('@' + match[1]) : -1;
  if (match) {
    mentionQuery.value = match[1].toLowerCase();
    mentionMenuIndex.value = 0;
  }
};

const mentionCandidates = computed(() => {
  const list = [
    ...(aiEnabled.value ? [{ id: 'mentor', name: aiName.value, avatar: '✨', handle: '@mentor', isAi: true, subtitle: 'AI' }] : []),
    ...Object.entries(roomStore.currentRoom?.participants || {})
      .filter(([, p]) => p.status === 'approved')
      .map(([uid, p]) => ({
        id: uid,
        name: p.displayName || 'Participant',
        avatar: p.avatar || '👤',
        handle: `@${p.displayName || 'Participant'}`,
        isAi: false,
        subtitle: p.isHost ? 'Host' : 'Member'
      }))
  ];
  const q = mentionQuery.value;
  return q ? list.filter(c => c.name.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q)) : list;
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
    const pos = before.length + insertText.length;
    el.setSelectionRange(pos, pos);
    adjustTextarea();
  });
};

const onInput = () => {
  adjustTextarea();
  roomStore.setMyTyping(true);
  checkMentionTrigger();
};

// ---------- Sending ----------
const handleSend = async () => {
  if (isBlocked.value) return;
  const text = inputMessage.value.trim();
  const attachment = stagedAttachment.value;
  if (!text && !attachment) return;

  const reply = replyingTo.value
    ? { id: replyingTo.value.id, senderName: replyingTo.value.senderName, text: replyingTo.value.content.slice(0, 100) }
    : undefined;
  inputMessage.value = '';
  stagedAttachment.value = null;
  replyingTo.value = null;
  if (textareaRef.value) textareaRef.value.style.height = '44px';

  if (attachment) {
    await roomStore.sendFileMessage(
      { name: attachment.name, size: attachment.size, type: attachment.type, url: attachment.dataUrl, mimeType: attachment.mimeType },
      text
    );
  } else {
    await roomStore.sendMessage(text, reply);
  }
  emit('sent');
};

const sendQuickThumbsUp = async () => {
  if (isBlocked.value) return;
  await roomStore.sendMessage('👍');
  emit('sent');
};

const onKeyDown = (e: KeyboardEvent) => {
  if (e.isComposing || (e as any).keyCode === 229) return; // IME composition
  const candidates = mentionCandidates.value;
  if (isMentionMenuOpen.value && candidates.length) {
    const moves: Record<string, () => void> = {
      ArrowDown: () => (mentionMenuIndex.value = (mentionMenuIndex.value + 1) % candidates.length),
      ArrowUp: () => (mentionMenuIndex.value = (mentionMenuIndex.value - 1 + candidates.length) % candidates.length),
      Enter: () => selectMentionCandidate(candidates[mentionMenuIndex.value]),
      Tab: () => selectMentionCandidate(candidates[mentionMenuIndex.value]),
      Escape: () => (isMentionMenuOpen.value = false)
    };
    if (moves[e.key]) {
      e.preventDefault();
      moves[e.key]();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

// ---------- Attachments ----------
const stageFile = async (file: File) => {
  if (isBlocked.value) return;
  isUploadingFile.value = true;
  try {
    let type: StagedAttachment['type'] = 'document';
    let dataUrl: string;
    if (file.type.startsWith('image/')) {
      type = 'image';
      dataUrl = await compressImage(file);
    } else if (file.type.startsWith('video/')) {
      type = 'video';
      if (file.size > MAX_VIDEO_BYTES) {
        roomStore.pushToast(t('composer.videoTooLargeTitle'), t('composer.videoTooLargeText'), 'warning');
        return;
      }
      const duration = await getVideoDuration(file);
      if (duration > MAX_VIDEO_SECONDS) {
        roomStore.pushToast(t('composer.videoTooLongTitle'), t('composer.videoTooLongText', { seconds: Math.round(duration) }), 'warning');
        return;
      }
      dataUrl = await readAsDataUrl(file);
    } else {
      if (file.size > MAX_DOC_BYTES) {
        roomStore.pushToast(t('composer.docTooLargeTitle'), t('composer.docTooLargeText'), 'warning');
        return;
      }
      dataUrl = await readAsDataUrl(file);
    }
    stagedAttachment.value = {
      name: file.name,
      size: file.size,
      type,
      previewUrl: type === 'image' ? dataUrl : undefined,
      dataUrl,
      mimeType: file.type || 'application/octet-stream'
    };
  } catch (err) {
    console.error('File staging error:', err);
    roomStore.pushToast(t('composer.fileErrorTitle'), t('composer.fileErrorText'), 'error');
  } finally {
    isUploadingFile.value = false;
    if (fileInputRef.value) fileInputRef.value.value = '';
  }
};

const onFileSelected = async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await stageFile(file);
};

const onPaste = async (e: ClipboardEvent) => {
  if (props.isMeetingClosed) return;
  const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) {
    e.preventDefault();
    await stageFile(file);
  }
};

const insertQuickTag = (tag: string) => {
  if (props.isMeetingClosed) return;
  const el = textareaRef.value;
  const appendFallback = () => {
    inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
  };
  if (!el) {
    appendFallback();
  } else {
    el.focus();
    const prefix = el.value && !el.value.endsWith(' ') && !el.value.endsWith('\n') ? ' ' : '';
    let inserted = false;
    try {
      // execCommand keeps the textarea's native undo stack (Ctrl+Z)
      inserted = document.execCommand('insertText', false, `${prefix}${tag} `);
    } catch {}
    if (inserted) {
      inputMessage.value = el.value;
    } else {
      appendFallback();
      nextTick(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }
  adjustTextarea();
};

const setReply = (m: MessageItem) => {
  replyingTo.value = m;
  nextTick(() => textareaRef.value?.focus());
};

/** Stages a file (e.g. a whiteboard export) and sends it immediately. */
const sendFile = async (file: File) => {
  await stageFile(file);
  await handleSend();
};

defineExpose({ setReply, sendFile });
</script>

<template>
  <footer class="border-t border-slate-800 bg-slate-900/90 p-2.5 sm:p-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] shrink-0">
    <div class="max-w-4xl mx-auto space-y-1.5">
      <div v-if="replyingTo" class="flex items-center justify-between p-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-xs text-slate-300">
        <div class="flex items-center gap-2 min-w-0">
          <CornerUpLeft class="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span class="text-sky-300 font-medium shrink-0">{{ t('composer.replyingTo', { name: replyingTo.senderName }) }}</span>
          <span class="truncate opacity-80">{{ replyingTo.content.slice(0, 75) }}</span>
        </div>
        <button @click="replyingTo = null" class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0 cursor-pointer" :title="t('composer.cancelReply')">
          <X class="w-3.5 h-3.5" />
        </button>
      </div>

      <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5 text-[11px] text-slate-400">
        <button
          v-for="q in quickTags"
          :key="q.label"
          @click="insertQuickTag(q.tag)"
          :disabled="isMeetingClosed"
          class="px-2 py-0.5 pointer-coarse:py-1.5 rounded-lg border disabled:opacity-40 transition flex items-center gap-1 shrink-0"
          :class="q.accent ? 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20' : 'border-slate-700 hover:bg-slate-800 text-slate-300'"
        >
          <component :is="q.icon" class="w-3 h-3" :class="q.iconClass" /> {{ q.label }}
        </button>
      </div>

      <div v-if="stagedAttachment" class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-sky-500/50 shadow-lg animate-fade-in">
        <div class="flex items-center gap-2.5 min-w-0">
          <img v-if="stagedAttachment.previewUrl" :src="stagedAttachment.previewUrl" class="w-10 h-10 rounded-lg object-cover border border-slate-700 shrink-0" />
          <div v-else class="p-2 rounded-lg bg-sky-500/20 text-sky-400 shrink-0">
            <FileText class="w-5 h-5" />
          </div>
          <div class="min-w-0">
            <p class="text-xs font-semibold text-slate-200 truncate">{{ stagedAttachment.name }}</p>
            <p class="text-[10px] text-slate-400 font-mono flex items-center gap-1">
              <span>{{ (stagedAttachment.size / 1024).toFixed(1) }} KB</span>
              <span class="text-emerald-400 font-medium">{{ t('composer.readyToSend') }}</span>
            </p>
          </div>
        </div>
        <button @click="stagedAttachment = null" class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-ink transition shrink-0" :title="t('composer.removeAttachment')">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="flex items-center gap-2">
        <input ref="fileInputRef" type="file" class="hidden" accept="image/*,video/*,.pdf,.doc,.docx,.txt" @change="onFileSelected" />

        <button
          @click="!isMeetingClosed && fileInputRef?.click()"
          :disabled="isBlocked || isUploadingFile"
          class="p-2.5 rounded-xl border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-sky-400 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
          :title="t('composer.attach')"
        >
          <Paperclip class="w-4 h-4" :class="{ 'animate-spin': isUploadingFile }" />
        </button>

        <button
          @click="emit('open-whiteboard')"
          :disabled="isBlocked || isWhiteboardOpen"
          class="p-2.5 rounded-xl border border-indigo-500/40 bg-indigo-950/40 hover:bg-indigo-900/60 text-indigo-300 hover:text-ink transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
          :title="t('composer.openWhiteboard')"
        >
          <Palette class="w-4 h-4 text-indigo-400" />
        </button>

        <div class="relative flex-1 min-w-0">
          <div
            v-if="isMentionMenuOpen && mentionCandidates.length"
            class="absolute bottom-full left-0 mb-2 w-72 sm:w-80 max-w-[calc(100vw-7rem)] bg-slate-900/95 border border-slate-700/80 rounded-xl shadow-2xl p-1.5 z-50 max-h-56 overflow-y-auto"
          >
            <div class="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800 mb-1 flex items-center justify-between">
              <span>{{ t('room.mentionMember') }}</span>
              <span class="text-[9px] text-slate-500">{{ t('composer.mentionNav') }}</span>
            </div>
            <button
              v-for="(cand, idx) in mentionCandidates"
              :key="cand.id"
              type="button"
              @mousedown.prevent="selectMentionCandidate(cand)"
              class="w-full flex items-center gap-2.5 px-2.5 py-1.5 pointer-coarse:py-2.5 rounded-lg text-left transition cursor-pointer text-xs"
              :class="idx === mentionMenuIndex ? 'bg-sky-600/30 text-ink ring-1 ring-sky-500' : 'hover:bg-slate-800 text-slate-200'"
            >
              <div class="w-6 h-6 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0 text-sm">{{ cand.avatar }}</div>
              <div class="flex-1 min-w-0">
                <div class="font-medium truncate flex items-center gap-1.5">
                  <span>{{ cand.name }}</span>
                  <span v-if="cand.isAi" class="text-[9px] px-1 py-0.2 rounded bg-sky-500/20 text-sky-300 font-bold">AI</span>
                  <span v-else-if="cand.subtitle === 'Host'" class="text-[9px] px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-medium">{{ t('composer.hostTag') }}</span>
                </div>
                <div class="text-[10px] text-slate-400 font-mono">{{ cand.handle }}</div>
              </div>
            </button>
          </div>

          <textarea
            ref="textareaRef"
            v-model="inputMessage"
            @input="onInput"
            @paste="onPaste"
            @keydown="onKeyDown"
            :disabled="isBlocked"
            enterkeyhint="send"
            :placeholder="isMeetingClosed
              ? lockedText || t('room.closedReadOnly')
              : isMuted ? t('room.mutedText') : aiEnabled ? t('composer.placeholderAi') : t('composer.placeholder')"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition resize-none min-h-[44px] max-h-32 overflow-y-auto disabled:opacity-50"
            rows="1"
          ></textarea>
        </div>

        <button
          v-if="!inputMessage.trim() && !stagedAttachment"
          @click="sendQuickThumbsUp"
          :disabled="isBlocked"
          class="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed text-sky-400 rounded-xl font-semibold shadow transition flex items-center justify-center shrink-0 min-h-[44px] min-w-[44px] cursor-pointer text-lg select-none"
          :title="t('composer.thumbsUp')"
        >
          👍
        </button>
        <button
          v-else
          @click="handleSend"
          :disabled="isBlocked || (mentionsMentor && (roomStore.aiCooldownRemaining > 0 || roomStore.isAnalyzing))"
          class="px-3.5 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow transition flex items-center justify-center gap-1.5 shrink-0 min-h-[44px] min-w-[44px] cursor-pointer"
          :title="mentionsMentor && roomStore.aiCooldownRemaining > 0 ? t('composer.cooldown', { seconds: roomStore.aiCooldownRemaining }) : t('composer.send')"
        >
          <span v-if="mentionsMentor && roomStore.aiCooldownRemaining > 0" class="text-xs font-mono text-amber-200">{{ roomStore.aiCooldownRemaining }}s</span>
          <Loader2 v-else-if="mentionsMentor && roomStore.isAnalyzing" class="w-4 h-4 animate-spin text-sky-200" />
          <template v-else>
            <Send class="w-4 h-4" />
            <span class="hidden sm:inline">{{ t('common.send') }}</span>
          </template>
        </button>
      </div>
    </div>
  </footer>
</template>
