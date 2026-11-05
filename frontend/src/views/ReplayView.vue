<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft, Loader2, Pause, Play } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
// `t` is the playback time in this view
import { intlLocale, t as tr, type MessageKey } from '../i18n';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import BoardReplayCanvas from '../components/admin/BoardReplayCanvas.vue';
import {
  KIND_GROUPS, describe, fmtOffset, groupOf, indexAt, loadAiThoughts, loadEvents, segmentsOf, loadFinalBoard, membersOf, stateAt, wasTruncated,
  type AiThought, type ReplayMessage, type ReplayObject, type ResearchEvent
} from '../utils/replay';
import { formatMessageText } from '../utils/chat';

/** Admin-only replay of one room from its research event log (/#/admin/replay/:roomId). */
const route = useRoute();
const authStore = useAuthStore();
const roomId = route.params.roomId as string;
// Administrator and observers (firestore.rules isObserver())
const isAdmin = computed(() => authStore.isObserver);

const events = ref<ResearchEvent[]>([]);
const loading = ref(true);
const error = ref('');

// A reopened session plays as separate parts; each stops at its own last activity
const segments = computed(() => segmentsOf(events.value));
const segIndex = ref(0);
const segment = computed(() => segments.value[segIndex.value] || { start: 0, end: 0, until: Infinity });
const t0 = computed(() => segment.value.start);
// The idle tail after the last activity stays in the event list (greyed)
const tEnd = computed(() => segment.value.end);
const pickSegment = (i: number) => {
  playing.value = false;
  clearInterval(timer);
  segIndex.value = i;
  t.value = t0.value;
};
// Messages from an earlier part show their clock time instead of an offset
const timeLabel = (at: number) => (at < t0.value ? new Date(at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : fmtOffset(at - t0.value));
const t = ref(0);
const members = computed(() => membersOf(events.value));
const who = (e: { uid: string | null; role: string }) => {
  if (e.role === 'ai') return 'AI';
  if (e.role === 'system') return tr('rp.system');
  const m = e.uid ? members.value.get(e.uid) : undefined;
  return m ? m.alias : e.role === 'unknown' ? '—' : e.role;
};

// Option: leave the researcher's and observers' own actions out of the timeline
const hideObserver = ref(true);
const idx = computed(() => indexAt(events.value, t.value));
const state = computed(() => stateAt(events.value, idx.value));

// ---------- Boards ----------
// Every board that exists at this moment: from its objects or its chat card, private ones included
const boardCards = computed(() => new Map(state.value.messages.filter(m => m.type === 'whiteboard_state').map(m => [m.id, m])));
const boardIds = computed(() => [...new Set([...boardCards.value.keys(), ...state.value.boards.keys()])]);
const boardLabel = (id: string) => {
  const card = boardCards.value.get(id);
  const creator = card?.metadata?.creatorUid ? aliasOfUid(card.metadata.creatorUid) : '?';
  return `${creator} · ${card?.metadata?.isPrivate ? tr('rp.private') : card ? tr('rp.public') : '—'}`;
};
const showBoard = (id: string) => {
  boardId.value = id;
  followBoard.value = false;
};
const boardId = ref<string | null>(null);
// Final objects, used only for objects whose stored event was cut short (older recordings)
const finalBoards = ref<Record<string, Map<string, ReplayObject>>>({});
watch(() => boardId.value, async id => {
  if (!id || finalBoards.value[id]) return;
  const needs = [...(state.value.boards.get(id)?.values() || [])].some(o => wasTruncated(o.fabric));
  if (needs) finalBoards.value = { ...finalBoards.value, [id]: await loadFinalBoard(roomId, id).catch(() => new Map()) };
});
watch(boardIds, ids => {
  if (!boardId.value || !ids.includes(boardId.value)) boardId.value = ids[0] || null;
});
// Follow the board that was last changed, unless one was picked by hand
const followBoard = ref(true);
watch(idx, i => {
  if (!followBoard.value) return;
  for (let j = i; j >= 0 && j > i - 50; j--) {
    const e = events.value[j];
    if (e?.kind.startsWith('board_object_')) {
      boardId.value = e.data.boardId;
      return;
    }
  }
});
const boardObjects = computed(() => {
  if (!boardId.value) return [];
  const final = finalBoards.value[boardId.value];
  return [...(state.value.boards.get(boardId.value)?.values() || [])]
    .map(o => (wasTruncated(o.fabric) && final?.get(o.id) ? final.get(o.id)! : o))
    .filter(o => !wasTruncated(o.fabric));
});
const pickBoard = (id: string) => {
  boardId.value = id;
  followBoard.value = false;
};

// ---------- Playback ----------
const playing = ref(false);
const speed = ref(10);
let timer: ReturnType<typeof setInterval> | undefined;
const TICK_MS = 100;
const togglePlay = () => {
  playing.value = !playing.value;
  clearInterval(timer);
  if (!playing.value) return;
  if (t.value >= tEnd.value) t.value = t0.value;
  timer = setInterval(() => {
    t.value = Math.min(tEnd.value, t.value + TICK_MS * speed.value);
    if (t.value >= tEnd.value) {
      playing.value = false;
      clearInterval(timer);
    }
  }, TICK_MS);
};
onUnmounted(() => clearInterval(timer));

// ---------- Event list ----------
const groups = ref<Record<string, boolean>>(Object.fromEntries(KIND_GROUPS.map(g => [g.id, g.id !== 'board'])));
const listed = computed(() => events.value.map((e, i) => ({ e, i }))
  .filter(({ e }) => e.at >= segment.value.start && e.at < segment.value.until && groups.value[groupOf(e.kind)] && !(hideObserver.value && (e.role === 'researcher' || e.role === 'observer'))));
const jumpTo = (e: ResearchEvent) => (t.value = Math.min(e.at, tEnd.value));
const listRef = ref<HTMLElement | null>(null);
const followTimeline = ref(true);
watch(idx, async () => {
  await nextTick();
  // Only the timeline box scrolls (scrollIntoView would also move the page)
  const box = listRef.value;
  const row = box?.querySelector<HTMLElement>('[data-current="true"]');
  if (!box || !row || !followTimeline.value) return;
  const top = row.offsetTop; // box is position: relative
  if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 2;
});

// ---------- AI background thinking (aiLogs) ----------
const thoughts = ref<AiThought[]>([]);
const thoughtsError = ref('');
const showSilent = ref(true);
const showMemory = ref(false);
const segThoughts = computed(() => thoughts.value.filter(th =>
  th.at >= segment.value.start && th.at < segment.value.until &&
  (th.kind === 'mentor' ? showSilent.value || th.spoke : th.kind === 'tool' ? true : showMemory.value)));
const thoughtsSoFar = computed(() => segThoughts.value.filter(th => th.at <= t.value).length);
const currentThoughtId = computed(() => segThoughts.value.filter(th => th.at <= t.value).at(-1)?.id || null);
const jumpToThought = (th: AiThought) => (t.value = Math.min(Math.max(th.at, t0.value), tEnd.value));
const thoughtBadge = (th: AiThought): { label: MessageKey; cls: string } =>
  th.kind === 'tool' ? { label: th.error ? 'rp.aiToolFailed' : 'rp.aiTool', cls: th.error ? 'border-rose-500/50 text-rose-300' : 'border-slate-600 text-slate-300' }
  : th.kind === 'memory_update' ? { label: 'rp.aiMemory', cls: 'border-slate-600 text-slate-300' }
  : th.error ? { label: 'rp.aiFailed', cls: 'border-rose-500/50 text-rose-300' }
  : th.spoke ? { label: 'rp.aiSpoke', cls: 'border-emerald-500/50 text-emerald-300' }
  : th.visible ? { label: 'rp.aiSilent', cls: 'border-slate-600 text-slate-300' }
  : { label: 'rp.aiShadow', cls: 'border-sky-500/50 text-sky-300' };
const TRIGGERS: Record<string, MessageKey> = {
  pause: 'rp.trigPause', stall: 'rp.trigStall', max_messages: 'rp.trigMax', forced: 'rp.trigMention',
  poll_settled: 'rp.trigPoll', suggestion_accepted: 'rp.trigAccepted'
};
// Shadow checks log "pause (shadow)" etc.
const triggerLabel = (trigger: string) => {
  const base = String(trigger || '').split(' ')[0];
  return TRIGGERS[base] ? tr(TRIGGERS[base]) : trigger;
};
const STAGE_KEYS: Record<string, MessageKey> = { discover: 'dd.discover', define: 'dd.define', develop: 'dd.develop', deliver: 'dd.deliver' };
const stageLabel = (s: string) => (STAGE_KEYS[s] ? tr(STAGE_KEYS[s]) : s);
const NOTE_KEYS: Record<string, MessageKey> = { observation: 'rp.aiObservation', teamNeed: 'rp.aiNeed', decision: 'rp.aiDecision' };
// The AI's own notes first; fields of older prompt versions are shown as they were stored
const noteRows = (th: AiThought): [string, string][] => {
  const a = th.assessment || {};
  const rows: [string, string][] = Object.keys(NOTE_KEYS).filter(k => a[k]).map(k => [tr(NOTE_KEYS[k]), String(a[k])]);
  for (const [k, v] of Object.entries(a)) {
    if (k in NOTE_KEYS || k === 'stage' || k === 'participants' || k === 'milestones' || v === null || v === '') continue;
    rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  }
  const reached = Object.entries(a.milestones || {}).filter(([, v]) => v).map(([k]) => k);
  if (reached.length) rows.push([tr('rp.aiMilestones'), reached.join(', ')]);
  if (Array.isArray(a.participants) && a.participants.length) {
    rows.push([tr('rp.aiPeople'), a.participants.map((p: any) => `${p.name}: ${p.engagement || '?'}${p.stance ? ` (${p.stance})` : ''}`).join('; ')]);
  }
  return rows;
};
const thoughtRef = ref<HTMLElement | null>(null);
watch(currentThoughtId, async () => {
  await nextTick();
  const box = thoughtRef.value;
  const row = box?.querySelector<HTMLElement>('[data-current="true"]');
  if (!box || !row || !followTimeline.value) return;
  if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop - 8;
});

// The chat box follows new messages by scrolling itself only (the page stays put)
const chatRef = ref<HTMLElement | null>(null);
watch(() => state.value.messages.length, async () => {
  await nextTick();
  if (chatRef.value) chatRef.value.scrollTop = chatRef.value.scrollHeight;
});
const votersOf = (m: ReplayMessage, option: string) => Object.values(m.pollVotes || {}).filter(v => v?.option === option);
const aliasOfUid = (uid: string) => members.value.get(uid)?.alias || '?';
const isUrl = (u?: string) => Boolean(u && /^(https?:|data:image)/.test(u));
const ASSET_KEYS: Record<string, MessageKey> = {
  summary: 'rp.assetSummary', fact_check: 'rp.assetFact', moodboard: 'rp.assetMood', sketch: 'rp.assetSketch', mesh_3d: 'rp.assetMesh', parametric_3d: 'rp.assetParam',
  image: 'rp.assetImage', vector: 'rp.assetVector', text: 'rp.assetText', contract: 'rp.assetContract'
};
const assetLabel = (type?: string) => (type && ASSET_KEYS[type] ? tr(ASSET_KEYS[type]) : type || '');

const ROLE_CLASS: Record<string, string> = {
  participant: 'text-sky-300',
  researcher: 'text-violet-300',
  observer: 'text-violet-300',
  ai: 'text-amber-300',
  system: 'text-slate-400',
  unknown: 'text-slate-500'
};

// Board canvas follows its box, so it fits a phone as well as a desktop
const boardBox = ref<HTMLElement | null>(null);
const boardSize = ref({ w: 0, h: 0 });
const boardObserver = new ResizeObserver(([entry]) => {
  const w = Math.floor(entry.contentRect.width);
  const h = Math.floor(entry.contentRect.height);
  if (w !== boardSize.value.w || h !== boardSize.value.h) boardSize.value = { w, h };
});
watch(boardBox, (el, old) => {
  if (old) boardObserver.unobserve(old);
  if (el) boardObserver.observe(el);
});
onUnmounted(() => boardObserver.disconnect());

onMounted(async () => {
  await authStore.waitForAuthReady().catch(() => {});
  await authStore.waitForRole();
  if (!isAdmin.value) {
    loading.value = false;
    return;
  }
  // The AI log is optional: the replay still works if it cannot be read
  loadAiThoughts(roomId)
    .then(list => (thoughts.value = list))
    .catch(e => (thoughtsError.value = tr('rp.aiLoadFailed', { error: e?.message || String(e) })));
  try {
    events.value = await loadEvents(roomId);
    t.value = t0.value;
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100 pt-safe px-safe">
    <header class="min-h-14 py-2 border-b border-slate-800 bg-slate-900/90 px-4 flex flex-wrap items-center gap-x-3 gap-y-1">
      <router-link to="/admin?tab=rooms" class="p-1.5 pointer-coarse:p-2.5 rounded-lg hover:bg-slate-800 text-slate-400"><ArrowLeft class="w-4 h-4" /></router-link>
      <h1 class="font-semibold text-sm">{{ tr('rp.title') }} <span class="font-mono text-sky-400">{{ roomId }}</span></h1>
      <span v-if="events.length" class="text-[11px] text-slate-500">{{ tr('rp.eventsLength', { count: events.length, length: fmtOffset(tEnd - t0) }) }}</span>
      <span v-if="segments.length > 1" class="flex gap-1">
        <button
          v-for="(s, i) in segments"
          :key="s.start"
          @click="pickSegment(i)"
          class="px-2 py-0.5 pointer-coarse:py-1.5 rounded-lg text-[11px] border"
          :class="i === segIndex ? 'border-sky-400 bg-sky-500/15 text-sky-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'"
        >{{ tr('rp.segment', { n: i + 1 }) }}</button></span>
      <ThemeSwitch class="ml-auto" />
      <LocaleSwitch />
      <div class="flex flex-wrap gap-2 text-[11px]">
        <span v-for="m in members.values()" :key="m.uid" class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700">
          <b>{{ m.alias }}</b> {{ m.nickname }}
        </span>
      </div>
    </header>

    <div v-if="!isAdmin && !loading" class="text-center text-sm text-slate-400 mt-24">{{ tr('rp.noAccess') }}</div>
    <div v-else-if="loading" class="flex items-center justify-center gap-2 text-xs text-slate-400 mt-24"><Loader2 class="w-4 h-4 animate-spin" />{{ tr('rp.loading') }}</div>
    <div v-else-if="error" class="text-center text-sm text-rose-300 mt-24">{{ error }}</div>
    <div v-else-if="!events.length" class="text-center text-sm text-slate-400 mt-24">{{ tr('rp.noEvents') }}</div>

    <main v-else class="p-3 sm:p-4 space-y-3 max-w-7xl mx-auto">
      <!-- Transport -->
      <div class="sticky top-[env(safe-area-inset-top)] z-10 flex items-center gap-2 sm:gap-3 p-3 rounded-2xl border border-slate-800 bg-slate-900 shadow-lg">
        <button @click="togglePlay" class="p-2 pointer-coarse:p-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white" :title="playing ? tr('rp.pause') : tr('rp.play')">
          <Pause v-if="playing" class="w-4 h-4" /><Play v-else class="w-4 h-4" />
        </button>
        <select v-model.number="speed" class="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 pointer-coarse:py-2 text-xs">
          <option :value="1">1×</option><option :value="5">5×</option><option :value="10">10×</option><option :value="30">30×</option><option :value="60">60×</option>
        </select>
        <span class="font-mono text-xs w-12 sm:w-14 text-right shrink-0">{{ fmtOffset(t - t0) }}</span>
        <input type="range" class="flex-1 min-w-0 accent-sky-500 pointer-coarse:h-8" :min="t0" :max="tEnd" :step="100" v-model.number="t" />
        <span class="font-mono text-xs text-slate-500 w-14 hidden xs:inline">{{ fmtOffset(tEnd - t0) }}</span>
      </div>

      <div class="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
        <!-- Chat at t -->
        <section class="rounded-2xl border border-slate-800 bg-slate-900/70 flex flex-col h-[60dvh] min-h-[300px] lg:h-[440px]">
          <h2 class="px-3 py-2 text-xs font-semibold text-slate-300 border-b border-slate-800">{{ tr('rp.chat', { count: state.messages.filter(m => !m.deleted).length }) }}</h2>
          <div ref="chatRef" class="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
            <div v-for="m in state.messages" :key="m.id" :class="m.deleted ? 'opacity-40 line-through' : ''">
              <div class="text-[10px] text-slate-500">
                <b :class="ROLE_CLASS[m.senderUid?.startsWith('ai_mentor') ? 'ai' : m.senderUid === 'system' ? 'system' : 'participant']">
                  {{ who({ uid: m.senderUid, role: m.senderUid?.startsWith('ai_mentor') ? 'ai' : m.senderUid === 'system' ? 'system' : 'participant' }) }}
                </b>
                {{ m.senderName }} · {{ timeLabel(m.timestamp) }}
              </div>
              <button v-if="m.type === 'whiteboard_state'" @click="showBoard(m.id)" class="text-sky-300 hover:underline text-left">
                {{ tr('rp.boardInChat', { label: boardLabel(m.id) }) }}
              </button>
              <div v-else-if="m.content" class="replay-md text-slate-200" v-html="formatMessageText(m.content)"></div>

              <!-- Attached file -->
              <div v-if="m.fileData && m.type === 'file'" class="mt-1">
                <img v-if="m.fileData.type === 'image' && isUrl(m.fileData.url)" :src="m.fileData.url" class="max-h-40 rounded-lg border border-slate-700" />
                <a v-else-if="isUrl(m.fileData.url)" :href="m.fileData.url" target="_blank" rel="noopener" class="text-sky-400 hover:underline">📎 {{ m.fileData.name || tr('rp.file') }}</a>
                <span v-else class="text-slate-400">📎 {{ m.fileData.name || tr('rp.file') }}</span>
              </div>

              <!-- AI asset -->
              <div v-if="m.assetType" class="mt-1 p-2 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-1">
                <div class="text-[10px] font-semibold text-amber-300">{{ assetLabel(m.assetType) }}<template v-if="m.assetPayload?.title">: {{ m.assetPayload.title }}</template></div>
                <div v-if="m.assetType === 'summary' && m.assetPayload?.content" class="replay-md text-slate-200 max-h-64 overflow-y-auto" v-html="formatMessageText(m.assetPayload.content)"></div>
                <template v-else-if="m.assetType === 'fact_check'">
                  <div class="text-slate-200">{{ tr('rp.claim', { text: m.assetPayload?.claim || '' }) }}</div>
                  <div class="text-slate-200">{{ tr('rp.verdict', { text: m.assetPayload?.verdict || '' }) }}</div>
                  <div v-if="m.assetPayload?.details" class="text-slate-400">{{ m.assetPayload.details }}</div>
                  <a v-for="r in m.assetPayload?.references || []" :key="r" :href="r" target="_blank" rel="noopener" class="block text-sky-400 hover:underline truncate">{{ r }}</a>
                </template>
                <template v-else-if="m.assetType === 'moodboard' || m.assetType === 'sketch'">
                  <div v-if="m.assetPayload?.keywords?.length" class="text-slate-400">{{ m.assetPayload.keywords.join(', ') }}</div>
                  <div class="grid grid-cols-3 xs:grid-cols-4 gap-1">
                    <div v-for="(img, k) in m.assetPayload?.images || []" :key="k" class="aspect-[4/3] rounded bg-slate-800 overflow-hidden" :title="img.prompt || img.title">
                      <img v-if="isUrl(img.url)" :src="img.url" class="w-full h-full object-cover" />
                      <span v-else class="block p-1 text-[9px] text-slate-500">{{ tr('rp.notGenerated') }}</span>
                    </div>
                  </div>
                  <div v-if="m.assetPayload?.palette?.length" class="flex gap-1">
                    <span v-for="c in m.assetPayload.palette" :key="c.hex" class="w-4 h-4 rounded border border-slate-700" :style="{ background: c.hex }" :title="`${c.name} ${c.hex}`"></span>
                  </div>
                </template>
                <template v-else-if="m.assetType === 'mesh_3d' || m.assetType === 'parametric_3d'">
                  <img v-if="isUrl(m.assetPayload?.posterUrl)" :src="m.assetPayload.posterUrl" class="max-h-32 rounded" />
                  <a v-if="isUrl(m.assetPayload?.modelUrl)" :href="m.assetPayload.modelUrl" target="_blank" rel="noopener" class="text-sky-400 hover:underline">{{ tr('rp.downloadModel') }}</a>
                  <div v-if="m.assetPayload?.isRefined" class="text-slate-400">{{ tr('rp.refined') }}</div>
                </template>
                <pre v-else class="text-[10px] text-slate-400 whitespace-pre-wrap max-h-40 overflow-y-auto">{{ JSON.stringify(m.assetPayload, null, 1) }}</pre>
              </div>

              <!-- Poll with voters at this moment -->
              <div v-if="m.actionOptions?.length" class="mt-1 space-y-0.5">
                <div v-for="opt in m.actionOptions" :key="opt" class="flex items-center gap-2 text-[11px]">
                  <span class="px-1.5 py-0.5 rounded border border-slate-700 text-slate-200">{{ opt }}</span>
                  <span class="text-slate-400">{{ tr('rp.votes', { count: votersOf(m, opt).length }) }}<template v-if="votersOf(m, opt).length"> ({{ votersOf(m, opt).map(v => aliasOfUid(v.uid)).join(', ') }})</template></span>
                </div>
              </div>
              <div v-if="m.reactions && Object.values(m.reactions).some(u => u.length)" class="text-[10px] text-slate-400">
                <span v-for="(uids, emoji) in m.reactions" :key="emoji" v-show="uids.length" class="mr-1.5">{{ emoji }}{{ uids.length }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- Board at t -->
        <section class="rounded-2xl border border-slate-800 bg-slate-900/70 flex flex-col h-[50dvh] min-h-[280px] lg:h-[440px]">
          <div class="px-3 py-2 border-b border-slate-800 flex items-center gap-2 overflow-x-auto no-scrollbar">
            <h2 class="text-xs font-semibold text-slate-300 shrink-0">{{ tr('rp.boards') }}</h2>
            <button
              v-for="id in boardIds"
              :key="id"
              @click="pickBoard(id)"
              class="px-2 py-0.5 pointer-coarse:py-1.5 rounded-lg text-[10px] font-mono shrink-0 border"
              :class="id === boardId ? 'border-sky-400 bg-sky-500/15 text-sky-200' : 'border-slate-700 text-slate-400'"
              :title="id"
            >{{ boardLabel(id) }}</button>
            <label class="ml-auto flex items-center gap-1 text-[10px] text-slate-400 shrink-0"><input type="checkbox" v-model="followBoard" />{{ tr('rp.followBoard') }}</label>
          </div>
          <div ref="boardBox" class="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden p-2">
            <BoardReplayCanvas v-if="boardId && boardSize.w > 0" :objects="boardObjects" :width="boardSize.w" :height="boardSize.h" />
            <p v-else class="text-xs text-slate-500">{{ tr('rp.noBoardYet') }}</p>
          </div>
        </section>
      </div>

      <!-- AI background thinking: every check up to this moment, also the silent and shadow ones (aiLogs) -->
      <section class="rounded-2xl border border-amber-500/30 bg-slate-900/70">
        <div class="px-3 py-2 border-b border-slate-800 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
          <h2 class="text-xs font-semibold text-amber-300">{{ tr('rp.aiThinking', { count: thoughtsSoFar }) }}</h2>
          <label class="flex items-center gap-1 text-slate-400"><input type="checkbox" v-model="showSilent" />{{ tr('rp.aiShowSilent') }}</label>
          <label class="flex items-center gap-1 text-slate-400"><input type="checkbox" v-model="showMemory" />{{ tr('rp.aiShowMemory') }}</label>
          <span class="text-slate-500">{{ tr('rp.aiHint') }}</span>
          <span v-if="thoughtsError" class="text-rose-300">{{ thoughtsError }}</span>
        </div>
        <div ref="thoughtRef" class="relative max-h-[50dvh] lg:max-h-80 overflow-y-auto divide-y divide-slate-800 text-xs">
          <p v-if="!segThoughts.length" class="p-3 text-slate-500">{{ tr('rp.aiNone') }}</p>
          <div
            v-for="th in segThoughts"
            :key="th.id"
            :data-current="th.id === currentThoughtId"
            class="px-3 py-2 space-y-1"
            :class="[th.at > t ? 'opacity-40' : '', th.id === currentThoughtId ? 'bg-amber-500/5' : '']"
          >
            <button type="button" @click="jumpToThought(th)" class="flex flex-wrap items-center gap-2 text-[10px] text-left pointer-coarse:py-1">
              <span class="font-mono text-slate-500">{{ fmtOffset(th.at - t0) }}</span>
              <span class="px-1.5 py-px rounded border" :class="thoughtBadge(th).cls">{{ tr(thoughtBadge(th).label) }}</span>
              <span class="text-slate-500">{{ triggerLabel(th.trigger) }}</span>
              <span v-if="th.assessment?.stage" class="text-sky-300">{{ stageLabel(th.assessment.stage) }}</span>
            </button>
            <template v-if="th.kind === 'mentor'">
              <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                <template v-for="row in noteRows(th)" :key="row[0]">
                  <dt class="text-slate-500">{{ row[0] }}</dt>
                  <dd class="text-slate-200 break-words">{{ row[1] }}</dd>
                </template>
              </dl>
              <p v-if="th.spoke && th.aiMessage" class="text-amber-200">→ {{ th.aiMessage }}</p>
              <p v-if="th.error" class="text-rose-300">{{ th.error }}</p>
              <details class="text-[10px] text-slate-400">
                <summary class="cursor-pointer select-none pointer-coarse:py-1">{{ tr('rp.aiRaw') }}</summary>
                <pre class="mt-1 whitespace-pre-wrap max-h-60 overflow-y-auto">{{ th.rawText || '—' }}</pre>
              </details>
            </template>
            <template v-else>
              <p v-if="th.kind === 'tool'" class="text-[10px] text-slate-500 font-mono">{{ th.tool }}</p>
              <p class="text-slate-300">{{ th.memorySummary || '—' }}</p>
              <p v-if="th.error" class="text-rose-300 break-words">{{ th.error }}</p>
            </template>
          </div>
        </div>
      </section>

      <!-- Timeline -->
      <section class="rounded-2xl border border-slate-800 bg-slate-900/70">
        <div class="px-3 py-2 border-b border-slate-800 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
          <h2 class="text-xs font-semibold text-slate-300">{{ tr('rp.timeline') }}</h2>
          <label class="flex items-center gap-1 text-slate-400"><input type="checkbox" v-model="followTimeline" />{{ tr('rp.followTimeline') }}</label>
          <label class="flex items-center gap-1 text-violet-300"><input type="checkbox" v-model="hideObserver" />{{ tr('rp.hideObserver') }}</label>
          <label v-for="g in KIND_GROUPS" :key="g.id" class="flex items-center gap-1 text-slate-300"><input type="checkbox" v-model="groups[g.id]" />{{ tr(g.label) }}</label>
        </div>
        <div ref="listRef" class="relative max-h-[50dvh] lg:max-h-72 overflow-y-auto text-[11px] font-mono">
          <button
            v-for="{ e, i } in listed"
            :key="e.id"
            :data-current="i === idx"
            @click="jumpTo(e)"
            class="w-full text-left px-3 py-1 pointer-coarse:py-2 flex gap-2 sm:gap-3 hover:bg-slate-800/60"
            :class="[i === idx ? 'bg-sky-500/15' : '', i > idx ? 'opacity-40' : '']"
          >
            <span class="text-slate-500 w-12 shrink-0">{{ fmtOffset(e.at - t0) }}</span>
            <span class="w-8 shrink-0 font-bold" :class="ROLE_CLASS[e.role]">{{ who(e) }}</span>
            <span class="w-4 shrink-0 text-slate-600" :title="e.source">{{ e.source === 'client' ? '◦' : '•' }}</span>
            <span class="truncate text-slate-300 font-sans">{{ describe(e) }}</span>
          </button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.replay-md :deep(table) { border-collapse: collapse; margin: 0.25rem 0; font-size: 10px; }
.replay-md :deep(th), .replay-md :deep(td) { border: 1px solid rgb(var(--c-n-700)); padding: 2px 4px; }
.replay-md :deep(h1), .replay-md :deep(h2), .replay-md :deep(h3) { font-weight: 600; margin-top: 0.25rem; }
.replay-md :deep(ul) { list-style: disc; padding-left: 1rem; }
.replay-md :deep(ol) { list-style: decimal; padding-left: 1rem; }
</style>
