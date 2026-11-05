<script setup lang="ts">
import { t } from '../../i18n';
import { touchToolbarMsgId, useLongPress } from '../../composables/useLongPress';
import { computed, ref } from 'vue';
import {
  AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronUp, Copy, CornerUpLeft, Download, Eye, EyeOff,
  FileText, Loader2, Lock, Palette, Plus, RefreshCw, Sparkles, X
} from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';
import type { MessageItem } from '../../types';
import { formatMessageText, formatTime, highlightMentions, isMentioning, type MentionTarget } from '../../utils/chat';
import { useRoomAi } from '../../composables/useRoomAi';
import { revertRoomName } from '../../services/session';
import { model3DFromImage, sketchFromImage } from '../../services/ai';
import ParametricViewer3D from '../ParametricViewer3D.vue';
import ModelViewerGLB from '../ModelViewerGLB.vue';
import MoodBoardViewer from '../MoodBoardViewer.vue';
import FactCheckViewer from '../FactCheckViewer.vue';

const props = defineProps<{
  msg: MessageItem;
  isMeetingClosed: boolean;
  isResizing: boolean;
}>();
const emit = defineEmits<{
  (e: 'open-whiteboard', msg: MessageItem): void;
  (e: 'open-document', title: string, content: string): void;
  (e: 'open-pdf', title: string, url: string): void;
  (e: 'preview-media', url: string): void;
  (e: 'to-whiteboard', url: string): void;
  (e: 'reply', msg: MessageItem): void;
}>();

const authStore = useAuthStore();
const roomStore = useRoomStore();

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const COLLAPSE_AT = 260;

const msg = computed(() => props.msg);
const isMine = computed(() => msg.value.senderUid === authStore.uid);
// Touch screens: long press opens the hover toolbar
const isToolbarPinned = computed(() => touchToolbarMsgId.value === msg.value.id);
const longPress = useLongPress(() => (touchToolbarMsgId.value = msg.value.id));
const closeTouchToolbar = () => (touchToolbarMsgId.value = null);
const isAi = computed(() => msg.value.senderUid === 'ai_mentor');
const mentionsMe = computed(() => isMentioning(msg.value, authStore.displayName, authStore.uid));
const isAsset = (...types: string[]) => msg.value.type === 'ai_asset' && types.includes(msg.value.assetType || '');
const isHidden = computed(() => Boolean(msg.value.metadata?.isHidden));
const isFramelessMedia = computed(() =>
  msg.value.type === 'file' && !!msg.value.fileData && ['image', 'video'].includes(msg.value.fileData.type) && !msg.value.content
);
const showsText = computed(() => {
  const c = msg.value.content;
  return Boolean(c) && (!msg.value.type.startsWith('file') || !/^Shared (image|video|document):/.test(c));
});
const canAct = () => !props.isMeetingClosed && !roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted;

// Long human messages collapse; AI messages never do
const expanded = ref(false);
const isCollapsible = computed(() => !isAi.value && (msg.value.content?.length || 0) > COLLAPSE_AT);
const displayHtml = computed(() => {
  const text = isCollapsible.value && !expanded.value ? msg.value.content.slice(0, COLLAPSE_AT) + '...' : msg.value.content;
  return highlightMentions(formatMessageText(text), mentionTargets.value);
});

// @mentions of me, of the AI and of other members get their own colours
const { aiEnabled, aiName, aiModules } = useRoomAi();
const mentionTargets = computed<MentionTarget[]>(() => [
  ...roomStore.approvedParticipants.map(p => ({ name: p.displayName, kind: (p.uid === authStore.uid ? 'me' : 'member') as MentionTarget['kind'] })),
  ...(aiEnabled.value ? [{ name: aiName.value, kind: 'ai' as const }, { name: 'Mentor', kind: 'ai' as const }] : [])
]);

// AI suggestion card (Accept / Not now); every answer stays on the message for the study
const suggestionAnswers = computed(() => Object.values(msg.value.suggestion?.responses || {}));
const mySuggestionAnswer = computed(() => msg.value.suggestion?.responses?.[authStore.uid]?.choice);
const answeredBy = (choice: 'accept' | 'decline') => suggestionAnswers.value.filter(a => a.choice === choice).map(a => a.name).join(', ');
const suggestionSummary = computed(() => [
  answeredBy('accept') && t('msg.suggestAccepted', { names: answeredBy('accept') }),
  answeredBy('decline') && t('msg.suggestDeclined', { names: answeredBy('decline') })
].filter(Boolean).join(' · '));
const answerSuggestion = (choice: 'accept' | 'decline') => canAct() && !roomStore.isHost && roomStore.answerSuggestion(msg.value.id, choice);

// AI room name: switch back to the old one (server checks membership and posts the notice)
const reverting = ref(false);
const revertName = async () => {
  reverting.value = true;
  try {
    await revertRoomName(roomStore.currentRoom!.roomId, msg.value.id);
  } catch (e: any) {
    roomStore.pushToast(t('msg.renameRevertFailed'), e?.message || String(e), 'error');
  } finally {
    reverting.value = false;
  }
};

// Sketches from an image: a chat photo / sketch, or one of the AI's sketches
const canSketch = computed(() => aiModules.value.enableSketch !== false && aiEnabled.value);
const canMakeSketches = computed(() => canSketch.value && canAct() && !roomStore.isHost && roomStore.myStatus !== 'observer');
// Chat uploads are stored inline as compressed data URLs; generated images are Storage links
const isSketchSource = computed(() => msg.value.type === 'file' && msg.value.fileData?.type === 'image' && /^(https:|data:image\/)/.test(msg.value.fileData?.url || ''));
const sketching = ref(false);
const moreSketches = async (url: string) => {
  if (sketching.value) return;
  sketching.value = true;
  roomStore.pushToast(t('sketch.working'), t('sketch.workingText', { name: aiName.value }), 'info');
  try {
    await sketchFromImage(url, msg.value.type === 'file' ? msg.value.content.replace(/^Shared (image|video|document):.*$/, '') : '');
  } catch (e: any) {
    roomStore.pushToast(t('sketch.failed'), e?.message || String(e), 'error');
  } finally {
    sketching.value = false;
  }
};

// A sketch or photo -> a 3D model built from the image (takes a few minutes; arrives in the chat)
const can3d = computed(() => aiEnabled.value && aiModules.value.enable3D);
const making3d = ref(false);
const make3d = async (url: string) => {
  if (making3d.value) return;
  making3d.value = true;
  roomStore.pushToast(t('sketch.making3d'), t('sketch.making3dText', { name: aiName.value }), 'info');
  try {
    await model3DFromImage(url, msg.value.type === 'file' ? msg.value.content : '', msg.value.id);
  } catch (e: any) {
    roomStore.pushToast(t('sketch.make3dFailed'), e?.message || String(e), 'error');
  } finally {
    making3d.value = false;
  }
};

// Where a 3D model came from: the sketch / photo it was built from, or the description it was made from
const modelSourceImage = computed(() => {
  const id = msg.value.assetPayload?.sourceMessageId;
  const src = id ? roomStore.currentRoom?.messages.find(m => m.id === id) : null;
  if (!src) return '';
  return src.type === 'file' && src.fileData?.type === 'image' ? src.fileData.url : src.assetPayload?.images?.find((i: any) => i?.url)?.url || '';
});
const modelPrompt = computed(() => msg.value.assetPayload?.prompt3D || msg.value.assetPayload?.prompt || '');
const jumpToSource = () => {
  const id = msg.value.assetPayload?.sourceMessageId;
  document.getElementById('msg_' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

// Polls
const voters = (option: string) => Object.values(msg.value.pollVotes || {}).filter(v => v?.option === option);
const isMyVote = (option: string) => msg.value.pollVotes?.[authStore.uid]?.option === option;
const showCustomOption = ref(false);
const customOption = ref('');
const vote = (option: string) => canAct() && roomStore.votePollOption(msg.value.id, option);
const addCustomOption = async () => {
  const text = customOption.value.trim();
  if (!canAct() || !text) return;
  await roomStore.addCustomPollOption(msg.value.id, text);
  customOption.value = '';
  showCustomOption.value = false;
};

// Reactions
const reactionUids = (emoji: string) => msg.value.reactions?.[emoji] || [];
const reactedByMe = (emoji: string) => reactionUids(emoji).includes(authStore.uid);
const hasReactions = computed(() => Object.values(msg.value.reactions || {}).some(u => Array.isArray(u) && u.length > 0));

const copyContent = () => {
  if (!msg.value.content) return;
  navigator.clipboard.writeText(msg.value.content);
  roomStore.pushToast(t('msg.copiedTitle'), t('msg.copiedText'), 'success');
};

// Failed explicit requests are posted as "⚠️ AI Mentor: ..." (see functions/mentorAnalyze) and can be regenerated
const isRetryableAiFailure = computed(() => isAi.value && Boolean(msg.value.content?.startsWith('⚠️ AI Mentor')));
const isRetrying = ref(false);
const retryAi = async () => {
  isRetrying.value = true;
  try {
    await roomStore.retryAiMentorMessage(msg.value.id);
  } finally {
    isRetrying.value = false;
  }
};

const refineModel = (m: MessageItem, customPrompt?: string) => {
  if (!props.isMeetingClosed) roomStore.refineMeshyModel(m, customPrompt);
};

const isPdf = computed(() => {
  const f = msg.value.fileData;
  return !!f && (f.name.toLowerCase().endsWith('.pdf') || f.mimeType === 'application/pdf');
});

// v2 boards are live whenever they are public; v1 boards relied on the room-wide session flag
const isLiveBoard = computed(() =>
  msg.value.metadata?.boardV === 2 || !msg.value.metadata?.whiteboardJson
    ? !msg.value.metadata?.isPrivate
    : Boolean(roomStore.currentRoom?.whiteboardActive && !msg.value.metadata?.isPrivate)
);

const hiddenNotice = 'px-3.5 py-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-400 italic flex items-center gap-2 select-none';
</script>

<template>
  <!-- System status pill -->
  <div v-if="msg.senderUid === 'system'" class="flex flex-col items-center gap-1.5 my-2.5">
    <div class="px-3.5 py-1 rounded-full bg-slate-900/70 border border-slate-800/80 text-[11px] text-slate-400 font-medium shadow-xs text-center max-w-md">
      {{ msg.content }}
    </div>
    <!-- The AI named the room: anyone in it can switch back to the old name -->
    <button
      v-if="msg.metadata?.roomRename && !msg.metadata.roomRename.revertedAt && canAct() && !roomStore.isHost"
      type="button"
      @click="revertName"
      :disabled="reverting"
      class="px-3 py-1 pointer-coarse:py-1.5 rounded-full border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
    >
      {{ t('msg.renameRevert', { name: msg.metadata.roomRename.previousName }) }}
    </button>
  </div>

  <div v-else class="flex gap-2.5 group relative" :class="isMine ? 'flex-row-reverse' : ''">
    <div
      class="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0 select-none bg-slate-800 border border-slate-700"
    >
      <!-- The AI has a neutral line icon (no emoji or colour cue that could sway participants) -->
      <Bot v-if="isAi" class="w-4 h-4 text-slate-300" />
      <template v-else>{{ msg.senderAvatar }}</template>
    </div>

    <div
      v-on="longPress"
      @contextmenu="isToolbarPinned && $event.preventDefault()"
      class="flex flex-col min-w-0 group/msg relative pointer-coarse:[-webkit-touch-callout:none]"
      :class="[isMine ? 'items-end' : 'items-start', msg.type === 'ai_asset' ? 'w-full max-w-full sm:max-w-3xl' : 'max-w-[85%] sm:max-w-[75%] md:max-w-[70%]']"
    >
      <!-- Sender line: mine = [time] [name], others = [name] [time] [AI badge] -->
      <div class="flex items-center gap-1.5 mb-0.5 text-[11px] text-slate-400" :class="isMine ? 'flex-row-reverse' : ''">
        <span class="font-medium text-slate-300 truncate">{{ msg.senderName }}</span>
        <span class="text-[9px] text-slate-500/70 font-mono tracking-wider">{{ formatTime(msg.timestamp) }}</span>      </div>

      <!-- Frameless image/video without caption -->
      <div v-if="isFramelessMedia" class="rounded-2xl overflow-hidden max-w-sm shadow-md hover:shadow-xl transition">
        <div
          v-if="msg.fileData!.type === 'image' && isHidden"
          class="w-52 h-32 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col items-center justify-center p-3 text-center text-xs text-slate-400 select-none shadow"
        >
          <EyeOff class="w-5 h-5 text-slate-500 mb-1.5" />
          <span class="font-medium text-slate-300">{{ t('msg.imageHidden') }}</span>
        </div>
        <div
          v-else-if="msg.fileData!.type === 'image'"
          class="cursor-pointer group rounded-2xl overflow-hidden"
          @click="emit('preview-media', msg.fileData!.url)"
          :title="t('msg.clickExpand')"
        >
          <img :src="msg.fileData!.url" :alt="t('msg.attachment')" class="w-full h-auto max-h-72 object-cover pointer-events-none group-hover:scale-105 transition duration-300 rounded-2xl" loading="lazy" />
        </div>
        <div v-else class="rounded-2xl overflow-hidden">
          <video :src="msg.fileData!.url" controls class="w-full max-h-72 rounded-2xl" preload="metadata"></video>
        </div>
      </div>

      <!-- Bubble -->
      <div
        v-else
        class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words min-w-0 w-fit max-w-full transition-all duration-200"
        :class="[
          isMine ? 'bg-sky-900/40 border border-sky-800 text-slate-100 rounded-tr-xs' : '',
          !isMine && !isAi ? 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-xs' : '',
          isAi ? 'bg-slate-800/60 border border-slate-700 text-slate-100 rounded-tl-xs' : '',
          mentionsMe ? 'ring-1 ring-amber-500/70 bg-amber-950/30 border-amber-700' : '',
          msg.replyTo ? 'min-w-[180px] sm:min-w-[200px]' : '',
          msg.type === 'ai_asset' ? 'w-full' : ''
        ]"
      >
        <div v-if="mentionsMe" class="inline-flex items-center gap-1 mb-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 select-none">
          <span>{{ t('msg.mentioned') }}</span>
        </div>

        <div v-if="msg.replyTo" class="mb-2 px-2.5 py-1 rounded-lg bg-slate-800/50 border-l-2 border-sky-400 text-xs text-slate-300 select-none min-w-0 max-w-full overflow-hidden">
          <div class="font-semibold text-[10px] text-sky-300 truncate">{{ msg.replyTo.senderName }}</div>
          <div class="truncate text-[11px] opacity-80">{{ msg.replyTo.text }}</div>
        </div>

        <div v-if="showsText" class="break-words max-w-none message-content" :class="isMine ? 'text-slate-100' : 'text-slate-200'">
          <div v-html="displayHtml"></div>
          <button
            v-if="isCollapsible"
            @click="expanded = !expanded"
            class="mt-1 inline-flex items-center gap-0.5 text-xs text-sky-400 hover:text-sky-300 font-medium underline cursor-pointer"
          >
            <component :is="expanded ? ChevronUp : ChevronDown" class="w-3 h-3" />
            {{ expanded ? t('msg.showLess') : t('msg.showMore') }}
          </button>
        </div>

        <!-- Poll / decision options -->
        <div v-if="msg.actionOptions?.length" class="mt-3 p-2.5 rounded-xl bg-slate-950/70 border border-sky-500/25 shadow-inner">
          <div class="flex items-center justify-between gap-2 mb-2 px-1 text-[11px] font-semibold text-sky-300">
            <div class="flex items-center gap-1.5">
              <Sparkles class="w-3.5 h-3.5 text-sky-400" />
              <span>{{ t('msg.poll') }}</span>
            </div>
            <span class="text-[10px] text-slate-400 font-normal">{{ t('msg.voted', { count: Object.keys(msg.pollVotes || {}).length }) }}</span>
          </div>

          <div class="space-y-1.5">
            <div
              v-for="(option, idx) in msg.actionOptions"
              :key="idx"
              @click="vote(option)"
              class="group relative flex items-center justify-between p-2 rounded-lg border transition-all cursor-pointer text-xs"
              :class="isMyVote(option)
                ? 'bg-sky-500/20 border-sky-400 text-sky-100 ring-1 ring-sky-400/50 shadow-sm'
                : 'bg-slate-900/90 border-slate-800 hover:border-slate-700 text-slate-300 hover:bg-slate-800/80'"
            >
              <div class="flex items-center gap-2 min-w-0 pr-2">
                <div
                  class="w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition"
                  :class="isMyVote(option) ? 'border-sky-400 bg-sky-500 text-white' : 'border-slate-600 bg-slate-800'"
                >
                  <CheckCircle2 v-if="isMyVote(option)" class="w-3 h-3 text-slate-950 stroke-[3]" />
                </div>
                <span class="truncate font-medium">{{ option }}</span>
              </div>

              <div v-if="voters(option).length" class="flex items-center gap-1.5 shrink-0">
                <div class="flex -space-x-1.5 overflow-hidden py-0.5">
                  <span
                    v-for="voter in voters(option).slice(0, 4)"
                    :key="voter.uid"
                    :title="voter.name"
                    class="inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-900 bg-slate-800 text-[10px] select-none shadow-xs"
                  >
                    {{ voter.avatar || '👤' }}
                  </span>
                  <span
                    v-if="voters(option).length > 4"
                    class="inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-900 bg-slate-700 text-[9px] font-bold text-slate-200"
                  >
                    +{{ voters(option).length - 4 }}
                  </span>
                </div>
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full" :class="isMyVote(option) ? 'bg-sky-500/30 text-sky-200' : 'bg-slate-800 text-slate-400'">
                  {{ voters(option).length }}
                </span>
              </div>
            </div>
          </div>

          <div class="mt-2 pt-2 border-t border-slate-800/80">
            <button
              v-if="!showCustomOption"
              type="button"
              @click="showCustomOption = true"
              class="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 font-medium cursor-pointer transition px-1 py-0.5"
            >
              <Plus class="w-3.5 h-3.5" />
              <span>{{ t('msg.addOption') }}</span>
            </button>
            <div v-else class="flex items-center gap-1.5 mt-1">
              <input
                v-model="customOption"
                @keydown.enter.prevent="addCustomOption"
                type="text"
                :placeholder="t('msg.optionPlaceholder')"
                class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                autofocus
              />
              <button
                type="button"
                @click="addCustomOption"
                :disabled="!customOption.trim()"
                class="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition shadow"
              >
                {{ t('msg.addVote') }}
              </button>
              <button type="button" @click="showCustomOption = false" class="p-1 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 cursor-pointer">
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <!-- AI suggestion card -->
        <div v-if="msg.suggestion" class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            @click="answerSuggestion('accept')"
            class="px-3 py-1.5 pointer-coarse:py-2 rounded-lg border text-xs font-semibold transition"
            :class="mySuggestionAnswer === 'accept' ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10'"
          >
            {{ t('msg.suggestAccept') }}
          </button>
          <button
            type="button"
            @click="answerSuggestion('decline')"
            class="px-3 py-1.5 pointer-coarse:py-2 rounded-lg border text-xs font-semibold transition"
            :class="mySuggestionAnswer === 'decline' ? 'bg-slate-600 border-slate-600 text-white' : 'border-slate-600 text-slate-300 hover:bg-slate-800'"
          >
            {{ t('msg.suggestDecline') }}
          </button>
          <span v-if="suggestionSummary" class="text-[11px] text-slate-400">{{ suggestionSummary }}</span>
        </div>

        <!-- Attachment inside a captioned bubble -->
        <div v-if="msg.type === 'file' && msg.fileData" :class="{ 'mt-2': msg.content }">
          <div
            v-if="msg.fileData.type === 'image'"
            class="rounded-xl overflow-hidden max-w-sm cursor-pointer group shadow"
            @click="!isHidden && emit('preview-media', msg.fileData!.url)"
            :title="isHidden ? t('msg.imageHidden') : t('msg.clickExpand')"
          >
            <div v-if="isHidden" :class="hiddenNotice">
              <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
              <span>{{ t('msg.imageHidden') }}</span>
            </div>
            <img v-else :src="msg.fileData.url" :alt="t('msg.imageAttachment')" class="w-full h-auto max-h-64 object-cover pointer-events-none group-hover:scale-105 transition duration-300 rounded-xl" loading="lazy" />
          </div>

          <div v-else-if="msg.fileData.type === 'video'" class="rounded-xl overflow-hidden max-w-sm shadow">
            <video :src="msg.fileData.url" controls class="w-full max-h-64 rounded-xl" preload="metadata"></video>
          </div>

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
                v-if="isPdf"
                @click="emit('open-pdf', msg.fileData!.name, msg.fileData!.url)"
                class="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-xs transition shrink-0"
                :title="t('msg.previewPdf')"
              >
                <Eye class="w-3.5 h-3.5" /> {{ t('msg.preview') }}
              </button>
              <a :href="msg.fileData.url" :download="msg.fileData.name" class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-ink transition shrink-0" :title="t('msg.downloadDoc')">
                <Download class="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>

        <!-- AI assets -->
        <FactCheckViewer v-if="isAsset('fact_check')" :assetData="msg.assetPayload" />

        <div v-if="isAsset('parametric_3d', 'mesh_3d') && isHidden" :class="['mt-2 max-w-sm', hiddenNotice]">
          <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
          <span>{{ t('msg.modelHidden') }}</span>
        </div>
        <ParametricViewer3D v-else-if="isAsset('parametric_3d')" :assetData="msg.assetPayload" />
        <ModelViewerGLB v-else-if="isAsset('mesh_3d')" :assetData="msg.assetPayload" :message="msg" :isResizing="isResizing" :readOnly="isMeetingClosed" @refine="refineModel" />

        <!-- The model's source: the original sketch / photo (and the render it was built from), or its description -->
        <div v-if="isAsset('mesh_3d', 'parametric_3d') && (modelSourceImage || msg.assetPayload?.inputRender || modelPrompt)" class="mt-2 flex items-start gap-2 text-[11px] text-slate-400">
          <button v-if="modelSourceImage" type="button" @click="jumpToSource" class="shrink-0 text-center" :title="t('model.jumpToSource')">
            <img :src="modelSourceImage" class="w-14 h-14 object-cover rounded-lg border border-slate-700" />
            <span class="block mt-0.5">{{ t('model.source') }}</span>
          </button>
          <a v-if="msg.assetPayload?.inputRender" :href="msg.assetPayload.inputRender" target="_blank" rel="noopener" class="shrink-0 text-center" :title="t('model.renderHint')">
            <img :src="msg.assetPayload.inputRender" class="w-14 h-14 object-cover rounded-lg border border-slate-700" />
            <span class="block mt-0.5">{{ t('model.render') }}</span>
          </a>
          <details v-if="modelPrompt" class="min-w-0 flex-1">
            <summary class="cursor-pointer select-none pointer-coarse:py-1">{{ t('model.prompt') }}</summary>
            <p class="mt-1 text-slate-300 break-words">{{ modelPrompt }}</p>
          </details>
        </div>

        <MoodBoardViewer
          v-if="isAsset('moodboard', 'sketch')"
          :assetData="msg.assetPayload"
          :kind="isAsset('sketch') ? 'sketch' : 'moodboard'"
          :canSketch="canSketch"
          :can3d="can3d"
          @make-3d="make3d"
          @to-whiteboard="emit('to-whiteboard', $event)"
          @more-sketches="moreSketches"
          :layout="msg.collage"
          :editable="canAct() && !roomStore.isHost && roomStore.myStatus !== 'observer'"
          @arrange="(i, p) => roomStore.arrangeCollage(msg.id, i, p)"
        />

        <div v-if="isAsset('summary', 'contract')" class="mt-3 p-3 bg-slate-950/80 border border-slate-700 rounded-xl flex items-center justify-between">
          <div class="flex items-center gap-2">
            <FileText class="w-5 h-5 text-sky-400 shrink-0" />
            <span class="text-xs font-semibold text-slate-200 truncate">{{ msg.assetPayload?.title }}</span>
          </div>
          <button
            @click="emit('open-document', msg.assetPayload?.title, msg.assetPayload?.content)"
            class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium rounded-lg transition shrink-0 ml-2"
          >
            {{ t('msg.viewDocument') }}
          </button>
        </div>

        <!-- Whiteboard share card (greyed out when private or the session has ended) -->
        <template v-if="msg.type === 'whiteboard_state'">
          <div v-if="isHidden" :class="['mt-2 max-w-[250px]', hiddenNotice]">
            <EyeOff class="w-4 h-4 text-slate-500 shrink-0" />
            <span>{{ t('msg.boardHidden') }}</span>
          </div>
          <div
            v-else
            class="mt-2 rounded-xl overflow-hidden shadow-lg relative border transition max-w-[210px] sm:max-w-[250px] select-none cursor-pointer group"
            :class="!isLiveBoard
              ? 'border-slate-800 bg-slate-950/70 opacity-75 grayscale-[35%] hover:border-slate-700'
              : 'border-emerald-500/50 hover:border-emerald-400 bg-slate-900'"
            @click="emit('open-whiteboard', msg)"
          >
            <div class="relative w-full aspect-[4/3] bg-slate-950 flex items-center justify-center overflow-hidden">
              <img v-if="!msg.metadata?.isPrivate && msg.fileData?.url" :src="msg.fileData.url" class="w-full h-full object-cover transition duration-300 pointer-events-none group-hover:scale-105" />
              <div v-else-if="msg.metadata?.isPrivate" class="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 select-none p-4 text-center">
                <div class="w-10 h-10 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center mb-1.5 shadow-sm">
                  <Lock class="w-5 h-5 text-slate-400" />
                </div>
                <span class="text-xs font-semibold text-slate-300 tracking-wide">{{ t('msg.privateBoard') }}</span>
              </div>
              <div v-else class="text-slate-600 flex flex-col items-center">
                <Palette class="w-8 h-8 opacity-40" />
              </div>

              <div
                v-if="isLiveBoard"
                class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-full bg-emerald-500/90 text-white text-[9px] font-bold shadow flex items-center gap-1 animate-pulse"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-white"></span>
                <span>{{ t('msg.live') }}</span>
              </div>
              <div v-else class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-full bg-slate-800/90 text-slate-400 text-[9px] font-medium border border-slate-700/60 shadow flex items-center gap-1">
                <span>{{ msg.metadata?.isPrivate ? 'Private' : 'Ended' }}</span>
              </div>

              <div class="absolute inset-0 flex items-center justify-center bg-indigo-950/60 opacity-0 group-hover:opacity-100 transition z-10">
                <span class="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-lg text-xs font-bold shadow-lg flex items-center gap-1.5 transition">
                  <Palette class="w-3.5 h-3.5" />
                  {{ msg.metadata?.isPrivate ? t('msg.openPrivate') : (isLiveBoard ? t('msg.joinLive') : t('msg.openBoard')) }}
                </span>
              </div>
            </div>

            <div class="px-2.5 py-1.5 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px]">
              <span class="text-slate-300 font-medium truncate max-w-[140px]">{{ t('msg.boardOf', { name: msg.metadata?.creatorName || msg.senderName }) }}</span>
              <span v-if="msg.metadata?.isPrivate" class="text-slate-500 font-medium text-[9px] shrink-0">{{ t('msg.private') }}</span>
              <span v-else-if="isLiveBoard" class="text-emerald-400 font-semibold text-[9px] shrink-0">{{ t('msg.active') }}</span>
              <span v-else class="text-slate-500 text-[9px] shrink-0">{{ t('msg.ended') }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- An uploaded sketch or photo: the AI develops it into more idea sketches -->
      <div v-if="isSketchSource && (canMakeSketches || (can3d && canAct() && !roomStore.isHost && roomStore.myStatus !== 'observer'))" class="mt-1 flex gap-1.5" :class="isMine ? 'justify-end' : 'justify-start'">
        <button
          v-if="can3d"
          type="button"
          @click="make3d(msg.fileData!.url)"
          :disabled="making3d"
          class="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:py-1.5 rounded-lg border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          <Loader2 v-if="making3d" class="w-3 h-3 animate-spin" />
          {{ t('sketch.make3d') }}
        </button>
        <button
          v-if="canMakeSketches"
          type="button"
          @click="moreSketches(msg.fileData!.url)"
          :disabled="sketching"
          class="inline-flex items-center gap-1 px-2.5 py-1 pointer-coarse:py-1.5 rounded-lg border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          <Loader2 v-if="sketching" class="w-3 h-3 animate-spin" />
          {{ t('sketch.fromImage') }}
        </button>
      </div>

      <!-- Existing reactions stay in the flow; their size never changes on hover -->
      <div v-if="hasReactions" class="mt-1 flex flex-wrap items-center gap-1 select-none" :class="isMine ? 'justify-end' : 'justify-start'">
        <template v-for="emoji in REACTIONS" :key="emoji">
          <button
            v-if="reactionUids(emoji).length"
            @click.stop="!isMeetingClosed && roomStore.toggleMessageReaction(msg.id, emoji)"
            :disabled="isMeetingClosed"
            class="flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs transition active:scale-90 cursor-pointer disabled:cursor-default"
            :class="reactedByMe(emoji) ? 'bg-sky-500/30 border-sky-400/90 text-sky-200' : 'bg-slate-800/80 text-slate-300 border-slate-700/80 hover:bg-slate-700'"
            :title="reactedByMe(emoji) ? `Remove ${emoji}` : `React ${emoji}`"
          >
            <span>{{ emoji }}</span>
            <span class="text-[10px] font-bold" :class="reactedByMe(emoji) ? 'text-sky-300' : 'text-slate-400'">{{ reactionUids(emoji).length }}</span>
          </button>
        </template>
      </div>

      <!-- Hover toolbar: a floating overlay, so showing it never moves other messages -->
      <div
        v-if="!isMeetingClosed"
        data-touch-toolbar
        @click="closeTouchToolbar"
        class="absolute -top-3 z-20 flex items-center gap-0.5 px-1.5 py-0.5 pointer-coarse:-top-9 pointer-coarse:py-1 pointer-coarse:gap-1 rounded-full whitespace-nowrap bg-slate-900/95 border border-slate-700/80 shadow-md text-xs select-none transition-opacity duration-150"
        :class="[isMine ? 'left-0' : 'right-0', isToolbarPinned ? 'opacity-100' : 'opacity-0 pointer-events-none [@media(hover:hover)]:group-hover/msg:opacity-100 [@media(hover:hover)]:group-hover/msg:pointer-events-auto']"
      >
        <button
          v-for="emoji in REACTIONS"
          :key="emoji"
          @click.stop="roomStore.toggleMessageReaction(msg.id, emoji)"
          class="px-1.5 py-0.5 rounded-full transition active:scale-90 cursor-pointer"
          :class="reactedByMe(emoji) ? 'bg-sky-500/30 text-sky-200' : 'text-slate-400 hover:text-ink hover:bg-slate-800/60'"
          :title="reactedByMe(emoji) ? `Remove ${emoji}` : `React ${emoji}`"
        >
          {{ emoji }}
        </button>
        <div class="h-3.5 w-px bg-slate-700/80 mx-0.5"></div>
        <button @click.stop="emit('reply', msg)" class="p-1 rounded-full text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition cursor-pointer" :title="t('msg.reply')">
          <CornerUpLeft class="w-3.5 h-3.5" />
        </button>
        <button @click.stop="copyContent" class="p-1 rounded-full text-slate-400 hover:text-emerald-300 hover:bg-slate-800 transition cursor-pointer" :title="t('msg.copy')">
          <Copy class="w-3.5 h-3.5" />
        </button>
      </div>

      <div v-if="isRetryableAiFailure" class="flex items-center gap-2 mt-1.5">
        <button
          @click="retryAi"
          :disabled="isRetrying"
          class="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-indigo-600/90 hover:bg-indigo-600 text-white text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
        >
          <Loader2 v-if="isRetrying" class="w-3.5 h-3.5 animate-spin" />
          <RefreshCw v-else class="w-3.5 h-3.5 text-sky-300" />
          <span>{{ isRetrying ? t('msg.retrying') : t('msg.retry') }}</span>
        </button>
      </div>

      <div v-if="isMine && msg.status === 'failed'" class="flex items-center gap-1 mt-0.5 text-[10px]">
        <button @click="roomStore.retrySendMessage(msg)" class="text-rose-400 hover:underline flex items-center gap-1 font-medium cursor-pointer" :title="t('msg.retrySend')">
          <AlertCircle class="w-3 h-3 text-rose-400" />
          <span>{{ t('msg.sendFailed') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  border: 1px solid rgb(var(--c-n-400) / 0.2);
  padding: 0.35rem 0.5rem;
  text-align: left;
}
:deep(.message-content th) {
  background: rgb(var(--c-n-900) / 0.4);
  font-weight: 600;
}
</style>
