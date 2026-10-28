<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft, Loader2, Pause, Play } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import BoardReplayCanvas from '../components/admin/BoardReplayCanvas.vue';
import {
  KIND_GROUPS, describe, fmtOffset, groupOf, indexAt, loadEvents, loadFinalBoard, membersOf, stateAt, wasTruncated,
  type ReplayMessage, type ReplayObject, type ResearchEvent
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

const t0 = computed(() => events.value[0]?.at || 0);
const tEnd = computed(() => events.value.at(-1)?.at || 0);
const t = ref(0);
const members = computed(() => membersOf(events.value));
const who = (e: { uid: string | null; role: string }) => {
  if (e.role === 'ai') return 'AI';
  if (e.role === 'system') return '系統';
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
  return `${creator} · ${card?.metadata?.isPrivate ? '私人' : card ? '公開' : '—'}`;
};
const showBoard = (id: string) => {
  boardId.value = id;
  followBoard.value = false;
};
// Final objects, used only for objects whose stored event was cut short (older recordings)
const finalBoards = ref<Record<string, Map<string, ReplayObject>>>({});
watch(() => boardId.value, async id => {
  if (!id || finalBoards.value[id]) return;
  const needs = [...(state.value.boards.get(id)?.values() || [])].some(o => wasTruncated(o.fabric));
  if (needs) finalBoards.value = { ...finalBoards.value, [id]: await loadFinalBoard(roomId, id).catch(() => new Map()) };
});
const boardId = ref<string | null>(null);
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
  .filter(({ e }) => groups.value[groupOf(e.kind)] && !(hideObserver.value && (e.role === 'researcher' || e.role === 'observer'))));
const jumpTo = (e: ResearchEvent) => (t.value = e.at);
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

// The chat box follows new messages by scrolling itself only (the page stays put)
const chatRef = ref<HTMLElement | null>(null);
watch(() => state.value.messages.length, async () => {
  await nextTick();
  if (chatRef.value) chatRef.value.scrollTop = chatRef.value.scrollHeight;
});
const votersOf = (m: ReplayMessage, option: string) => Object.values(m.pollVotes || {}).filter(v => v?.option === option);
const aliasOfUid = (uid: string) => members.value.get(uid)?.alias || '?';
const isUrl = (u?: string) => Boolean(u && /^(https?:|data:image)/.test(u));
const ASSET_LABELS: Record<string, string> = {
  summary: '摘要', fact_check: '事實查核', moodboard: '情緒板', mesh_3d: '3D 模型', parametric_3d: '3D 預覽', image: '圖片', vector: '向量圖', text: '文字', contract: '文件'
};

const ROLE_CLASS: Record<string, string> = {
  participant: 'text-sky-300',
  researcher: 'text-violet-300',
  observer: 'text-violet-300',
  ai: 'text-amber-300',
  system: 'text-slate-400',
  unknown: 'text-slate-500'
};

onMounted(async () => {
  await authStore.waitForAuthReady().catch(() => {});
  await authStore.waitForRole();
  if (!isAdmin.value) {
    loading.value = false;
    return;
  }
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
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100">
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center gap-3">
      <router-link to="/admin" class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><ArrowLeft class="w-4 h-4" /></router-link>
      <h1 class="font-semibold text-sm">重播 <span class="font-mono text-sky-400">{{ roomId }}</span></h1>
      <span v-if="events.length" class="text-[11px] text-slate-500">{{ events.length }} 個事件 · 長度 {{ fmtOffset(tEnd - t0) }}</span>
      <div class="ml-auto flex flex-wrap gap-2 text-[11px]">
        <span v-for="m in members.values()" :key="m.uid" class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700">
          <b>{{ m.alias }}</b> {{ m.nickname }}
        </span>
      </div>
    </header>

    <div v-if="!isAdmin && !loading" class="text-center text-sm text-slate-400 mt-24">需要研究管理者或觀察員帳號。</div>
    <div v-else-if="loading" class="flex items-center justify-center gap-2 text-xs text-slate-400 mt-24"><Loader2 class="w-4 h-4 animate-spin" />讀取事件…</div>
    <div v-else-if="error" class="text-center text-sm text-rose-300 mt-24">{{ error }}</div>
    <div v-else-if="!events.length" class="text-center text-sm text-slate-400 mt-24">這個房間沒有事件紀錄（P4a 之前建立的房間不會有）。</div>

    <main v-else class="p-4 space-y-3 max-w-7xl mx-auto">
      <!-- Transport -->
      <div class="flex items-center gap-3 p-3 rounded-2xl border border-slate-800 bg-slate-900/70">
        <button @click="togglePlay" class="p-2 rounded-lg bg-sky-600 hover:bg-sky-500" :title="playing ? '暫停' : '播放'">
          <Pause v-if="playing" class="w-4 h-4" /><Play v-else class="w-4 h-4" />
        </button>
        <select v-model.number="speed" class="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs">
          <option :value="1">1×</option><option :value="5">5×</option><option :value="10">10×</option><option :value="30">30×</option><option :value="60">60×</option>
        </select>
        <span class="font-mono text-xs w-14 text-right">{{ fmtOffset(t - t0) }}</span>
        <input type="range" class="flex-1 accent-sky-500" :min="t0" :max="tEnd" :step="100" v-model.number="t" />
        <span class="font-mono text-xs text-slate-500 w-14">{{ fmtOffset(tEnd - t0) }}</span>
      </div>

      <div class="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
        <!-- Chat at t -->
        <section class="rounded-2xl border border-slate-800 bg-slate-900/70 flex flex-col h-[440px]">
          <h2 class="px-3 py-2 text-xs font-semibold text-slate-300 border-b border-slate-800">聊天（{{ state.messages.filter(m => !m.deleted).length }}）</h2>
          <div ref="chatRef" class="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
            <div v-for="m in state.messages" :key="m.id" :class="m.deleted ? 'opacity-40 line-through' : ''">
              <div class="text-[10px] text-slate-500">
                <b :class="ROLE_CLASS[m.senderUid?.startsWith('ai_mentor') ? 'ai' : m.senderUid === 'system' ? 'system' : 'participant']">
                  {{ who({ uid: m.senderUid, role: m.senderUid?.startsWith('ai_mentor') ? 'ai' : m.senderUid === 'system' ? 'system' : 'participant' }) }}
                </b>
                {{ m.senderName }} · {{ fmtOffset(m.timestamp - t0) }}
              </div>
              <button v-if="m.type === 'whiteboard_state'" @click="showBoard(m.id)" class="text-sky-300 hover:underline text-left">
                🖼 白板（{{ boardLabel(m.id) }}）— 點擊在右側檢視
              </button>
              <div v-else-if="m.content" class="replay-md text-slate-200" v-html="formatMessageText(m.content)"></div>

              <!-- Attached file -->
              <div v-if="m.fileData && m.type === 'file'" class="mt-1">
                <img v-if="m.fileData.type === 'image' && isUrl(m.fileData.url)" :src="m.fileData.url" class="max-h-40 rounded-lg border border-slate-700" />
                <a v-else-if="isUrl(m.fileData.url)" :href="m.fileData.url" target="_blank" rel="noopener" class="text-sky-400 hover:underline">📎 {{ m.fileData.name || '檔案' }}</a>
                <span v-else class="text-slate-400">📎 {{ m.fileData.name || '檔案' }}</span>
              </div>

              <!-- AI asset -->
              <div v-if="m.assetType" class="mt-1 p-2 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-1">
                <div class="text-[10px] font-semibold text-amber-300">{{ ASSET_LABELS[m.assetType] || m.assetType }}<template v-if="m.assetPayload?.title">：{{ m.assetPayload.title }}</template></div>
                <div v-if="m.assetType === 'summary' && m.assetPayload?.content" class="replay-md text-slate-200 max-h-64 overflow-y-auto" v-html="formatMessageText(m.assetPayload.content)"></div>
                <template v-else-if="m.assetType === 'fact_check'">
                  <div class="text-slate-200">主張：{{ m.assetPayload?.claim }}</div>
                  <div class="text-slate-200">結論：{{ m.assetPayload?.verdict }}</div>
                  <div v-if="m.assetPayload?.details" class="text-slate-400">{{ m.assetPayload.details }}</div>
                  <a v-for="r in m.assetPayload?.references || []" :key="r" :href="r" target="_blank" rel="noopener" class="block text-sky-400 hover:underline truncate">{{ r }}</a>
                </template>
                <template v-else-if="m.assetType === 'moodboard'">
                  <div v-if="m.assetPayload?.keywords?.length" class="text-slate-400">{{ m.assetPayload.keywords.join('、') }}</div>
                  <div class="grid grid-cols-4 gap-1">
                    <div v-for="(img, k) in m.assetPayload?.images || []" :key="k" class="aspect-[4/3] rounded bg-slate-800 overflow-hidden" :title="img.prompt || img.title">
                      <img v-if="isUrl(img.url)" :src="img.url" class="w-full h-full object-cover" />
                      <span v-else class="block p-1 text-[9px] text-slate-500">未產生</span>
                    </div>
                  </div>
                  <div v-if="m.assetPayload?.palette?.length" class="flex gap-1">
                    <span v-for="c in m.assetPayload.palette" :key="c.hex" class="w-4 h-4 rounded border border-slate-700" :style="{ background: c.hex }" :title="`${c.name} ${c.hex}`"></span>
                  </div>
                </template>
                <template v-else-if="m.assetType === 'mesh_3d' || m.assetType === 'parametric_3d'">
                  <img v-if="isUrl(m.assetPayload?.posterUrl)" :src="m.assetPayload.posterUrl" class="max-h-32 rounded" />
                  <a v-if="isUrl(m.assetPayload?.modelUrl)" :href="m.assetPayload.modelUrl" target="_blank" rel="noopener" class="text-sky-400 hover:underline">下載模型</a>
                  <div v-if="m.assetPayload?.isRefined" class="text-slate-400">已上色（refined）</div>
                </template>
                <pre v-else class="text-[10px] text-slate-400 whitespace-pre-wrap max-h-40 overflow-y-auto">{{ JSON.stringify(m.assetPayload, null, 1) }}</pre>
              </div>

              <!-- Poll with voters at this moment -->
              <div v-if="m.actionOptions?.length" class="mt-1 space-y-0.5">
                <div v-for="opt in m.actionOptions" :key="opt" class="flex items-center gap-2 text-[11px]">
                  <span class="px-1.5 py-0.5 rounded border border-slate-700 text-slate-200">{{ opt }}</span>
                  <span class="text-slate-400">{{ votersOf(m, opt).length }} 票<template v-if="votersOf(m, opt).length">（{{ votersOf(m, opt).map(v => aliasOfUid(v.uid)).join(', ') }}）</template></span>
                </div>
              </div>
              <div v-if="m.reactions && Object.values(m.reactions).some(u => u.length)" class="text-[10px] text-slate-400">
                <span v-for="(uids, emoji) in m.reactions" :key="emoji" v-show="uids.length" class="mr-1.5">{{ emoji }}{{ uids.length }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- Board at t -->
        <section class="rounded-2xl border border-slate-800 bg-slate-900/70 flex flex-col h-[440px]">
          <div class="px-3 py-2 border-b border-slate-800 flex items-center gap-2 overflow-x-auto">
            <h2 class="text-xs font-semibold text-slate-300 shrink-0">白板</h2>
            <button
              v-for="id in boardIds"
              :key="id"
              @click="pickBoard(id)"
              class="px-2 py-0.5 rounded-lg text-[10px] font-mono shrink-0 border"
              :class="id === boardId ? 'border-sky-400 bg-sky-500/15 text-sky-200' : 'border-slate-700 text-slate-400'"
              :title="id"
            >{{ boardLabel(id) }}</button>
            <label class="ml-auto flex items-center gap-1 text-[10px] text-slate-400 shrink-0"><input type="checkbox" v-model="followBoard" />跟隨最新變更</label>
          </div>
          <div class="flex-1 flex items-center justify-center overflow-hidden p-2">
            <BoardReplayCanvas v-if="boardId" :objects="boardObjects" :width="640" :height="380" />
            <p v-else class="text-xs text-slate-500">此時間點還沒有白板內容</p>
          </div>
        </section>
      </div>

      <!-- Timeline -->
      <section class="rounded-2xl border border-slate-800 bg-slate-900/70">
        <div class="px-3 py-2 border-b border-slate-800 flex flex-wrap items-center gap-3 text-[11px]">
          <h2 class="text-xs font-semibold text-slate-300">時間軸</h2>
          <label class="flex items-center gap-1 text-slate-400"><input type="checkbox" v-model="followTimeline" />時間軸跟著播放</label>
          <label class="flex items-center gap-1 text-violet-300"><input type="checkbox" v-model="hideObserver" />隱藏觀察者行為</label>
          <label v-for="g in KIND_GROUPS" :key="g.id" class="flex items-center gap-1 text-slate-300"><input type="checkbox" v-model="groups[g.id]" />{{ g.label }}</label>
        </div>
        <div ref="listRef" class="relative max-h-72 overflow-y-auto text-[11px] font-mono">
          <button
            v-for="{ e, i } in listed"
            :key="e.id"
            :data-current="i === idx"
            @click="jumpTo(e)"
            class="w-full text-left px-3 py-1 flex gap-3 hover:bg-slate-800/60"
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
.replay-md :deep(th), .replay-md :deep(td) { border: 1px solid #334155; padding: 2px 4px; }
.replay-md :deep(h1), .replay-md :deep(h2), .replay-md :deep(h3) { font-weight: 600; margin-top: 0.25rem; }
.replay-md :deep(ul) { list-style: disc; padding-left: 1rem; }
.replay-md :deep(ol) { list-style: decimal; padding-left: 1rem; }
</style>
