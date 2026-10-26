<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import ProfileEditor from '../components/admin/ProfileEditor.vue';
import {
  DEFAULT_COST_INPUTS, MODE_LABELS, SEED_PROFILES, estimateCost, newProfile,
  type AiProfile, type CostInputs, type Prices
} from '../utils/aiProfiles';
import {
  assignRoomProfile, getSystemConfig, listProfiles, listStudyRooms, loadUsage, saveProfile, saveSystemConfig, type StudyRoom, type UsageRow
} from '../services/admin';

// Mirrors functions/src/config.js DEFAULT_SYSTEM_CONFIG for display before config/system exists
const SYSTEM_DEFAULTS = {
  models: { mentor: 'claude-haiku-5-5', vision: 'claude-haiku-5-5', svg: 'claude-sonnet-5-5' },
  memoryModel: 'claude-haiku-5-5',
  mentorEffort: 'low',
  engine3D: 'meshy',
  defaultProfileId: null as string | null,
  prices: {
    'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
    webSearchPerUse: 0.01,
    imagePerUnit: 0.003,
    model3DPerUnit: 0
  } as Prices
};
const MODEL_OPTIONS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

const authStore = useAuthStore();
const roomStore = useRoomStore();
const isAdmin = computed(() => authStore.isGoogleLinked && authStore.email === 'bb900114@gmail.com');

const tab = ref<'profiles' | 'rooms' | 'cost' | 'system'>('profiles');
const tabs = [
  { id: 'profiles', label: 'AI 條件設定檔' },
  { id: 'rooms', label: '房間指派' },
  { id: 'cost', label: '費用估算' },
  { id: 'system', label: '系統設定' }
] as const;

const profiles = ref<AiProfile[]>([]);
const system = ref<Record<string, any>>(structuredClone(SYSTEM_DEFAULTS));
const loading = ref(false);
const error = ref('');

const loadAll = async () => {
  loading.value = true;
  error.value = '';
  try {
    profiles.value = await listProfiles();
    const cfg = await getSystemConfig();
    system.value = {
      ...structuredClone(SYSTEM_DEFAULTS),
      ...cfg,
      models: { ...SYSTEM_DEFAULTS.models, ...(cfg.models || {}) },
      prices: { ...SYSTEM_DEFAULTS.prices, ...(cfg.prices || {}) }
    };
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await authStore.waitForAuthReady().catch(() => {});
  if (isAdmin.value) await loadAll();
});

// ---------- Profiles ----------
const editing = ref<AiProfile | null>(null);
const saving = ref(false);
const profileName = (id?: string | null) => profiles.value.find(p => p.id === id)?.name || '內建預設（Proactive）';

const onSaveProfile = async (p: AiProfile) => {
  saving.value = true;
  try {
    await saveProfile(p, authStore.email);
    editing.value = null;
    profiles.value = await listProfiles();
    roomStore.pushToast('已儲存', `「${p.name}」已存為新版本`, 'success');
  } catch (e: any) {
    roomStore.pushToast('儲存失敗', e?.message || String(e), 'error');
  } finally {
    saving.value = false;
  }
};

// Guarded so repeated clicks cannot create duplicate sets
const seeding = ref(false);
const seedProfiles = async () => {
  if (seeding.value || profiles.value.length) return;
  seeding.value = true;
  try {
    for (const p of SEED_PROFILES) await saveProfile(p, authStore.email);
    profiles.value = await listProfiles();
  } finally {
    seeding.value = false;
  }
};

// Archived profiles are hidden from lists; rooms keep their frozen snapshot, so nothing breaks
const archiveProfile = async (p: AiProfile) => {
  if (system.value.defaultProfileId === p.id) {
    roomStore.pushToast('無法封存', '這是新房間的預設設定檔，請先改設其他預設。', 'warning');
    return;
  }
  if (!window.confirm(`封存「${p.name}」v${p.version}？已指派此設定檔的房間不受影響。`)) return;
  await saveProfile({ ...p, archived: true } as AiProfile, authStore.email);
  profiles.value = await listProfiles();
};

const duplicate = (p: AiProfile) => {
  editing.value = { ...JSON.parse(JSON.stringify(p)), id: undefined, version: 0, name: `${p.name}（複本）` };
};

const setDefaultProfile = async (id: string) => {
  await saveSystemConfig({ defaultProfileId: id });
  system.value.defaultProfileId = id;
  roomStore.pushToast('已設定', `新房間預設使用「${profileName(id)}」`, 'success');
};

// ---------- Rooms ----------
const rooms = ref<StudyRoom[]>([]);
const roomsLoading = ref(false);
const pendingChoice = ref<Record<string, string>>({});
const loadRooms = async () => {
  roomsLoading.value = true;
  try {
    rooms.value = await listStudyRooms();
  } catch (e: any) {
    roomStore.pushToast('讀取房間失敗', e?.message || String(e), 'error');
  } finally {
    roomsLoading.value = false;
  }
};
watch(tab, t => t === 'rooms' && !rooms.value.length && loadRooms());

// One confirmation, as agreed for the study protocol
const assign = async (room: StudyRoom) => {
  const profileId = pendingChoice.value[room.roomId];
  const profile = profiles.value.find(p => p.id === profileId);
  if (!profile) return;
  const ok = window.confirm(`確定將房間 ${room.pin}（${room.roomName || ''}）改為「${profile.name}」v${profile.version}？\n\n房間會凍結此版本；之後修改設定檔不會影響它。`);
  if (!ok) return;
  try {
    await assignRoomProfile(room.roomId, profile.id!);
    roomStore.pushToast('已指派', `房間 ${room.pin} → ${profile.name} v${profile.version}`, 'success');
    await loadRooms();
  } catch (e: any) {
    roomStore.pushToast('指派失敗', e?.message || String(e), 'error');
  }
};

const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false }) : '—');

// ---------- Cost ----------
const costProfileId = ref<string>('');
const costInputs = ref<CostInputs>({ ...DEFAULT_COST_INPUTS });
const costProfile = computed(() => profiles.value.find(p => p.id === costProfileId.value) || newProfile({ name: 'Proactive (built-in)' }));
const estimate = computed(() =>
  estimateCost(costProfile.value, costInputs.value, system.value.prices, { mentor: system.value.models.mentor, memory: system.value.memoryModel })
);
const COST_INPUT_FIELDS: { key: keyof CostInputs; label: string }[] = [
  { key: 'sessionMinutes', label: '每場時長（分）' },
  { key: 'messagesPerMinute', label: '每分鐘訊息數' },
  { key: 'mentionsPerSession', label: '每場 @AI 次數' },
  { key: 'stallsPerSession', label: '每場停滯次數' },
  { key: 'moodboardsPerSession', label: '每場情緒板' },
  { key: 'models3DPerSession', label: '每場 3D 模型' },
  { key: 'webSearchesPerSession', label: '每場上網搜尋' },
  { key: 'sessions', label: '總場次' },
  { key: 'checkInputTokens', label: '每次判斷輸入 tokens' },
  { key: 'checkOutputTokens', label: '每次判斷輸出 tokens' }
];
const usd = (n: number) => `US$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

const usageDays = ref(7);
const usage = ref<UsageRow[]>([]);
const usageLoading = ref(false);
const loadActualUsage = async () => {
  usageLoading.value = true;
  try {
    usage.value = await loadUsage(Date.now() - usageDays.value * 86400_000);
  } catch (e: any) {
    roomStore.pushToast('讀取紀錄失敗', e?.message || String(e), 'error');
  } finally {
    usageLoading.value = false;
  }
};
const actual = computed(() => {
  const prices = system.value.prices;
  const byRoom: Record<string, number> = {};
  let total = 0;
  for (const u of usage.value) {
    const p = prices[u.model] || { inputPerMTok: 0, outputPerMTok: 0 };
    const cost = (u.input * p.inputPerMTok + u.output * p.outputPerMTok) / 1e6 + u.webSearches * (prices.webSearchPerUse || 0);
    total += cost;
    byRoom[u.roomId || '(no room)'] = (byRoom[u.roomId || '(no room)'] || 0) + cost;
  }
  return { total, byRoom: Object.entries(byRoom).sort((a, b) => b[1] - a[1]), calls: usage.value.length };
});

// ---------- System ----------
const savingSystem = ref(false);
const saveSystem = async () => {
  savingSystem.value = true;
  try {
    const { models, memoryModel, mentorEffort, engine3D, prices } = system.value;
    await saveSystemConfig({ models, memoryModel, mentorEffort, engine3D, prices });
    roomStore.pushToast('已儲存', '系統設定已更新（約 1 分鐘內生效）', 'success');
  } finally {
    savingSystem.value = false;
  }
};

const card = 'p-4 rounded-2xl border border-slate-800 bg-slate-900/70';
const select = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500';
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100">
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center gap-3">
      <router-link to="/" class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><ArrowLeft class="w-4 h-4" /></router-link>
      <h1 class="font-bold">研究設定後台</h1>
      <button v-if="isAdmin" @click="loadAll" class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400" title="重新整理">
        <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
      </button>
    </header>

    <div v-if="!isAdmin" class="max-w-md mx-auto mt-24 text-center text-sm text-slate-400 px-6">
      這個頁面只有研究管理者帳號可以使用。請先在首頁用 Google 帳號登入。
    </div>

    <main v-else class="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <nav class="flex gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit">
        <button
          v-for="t in tabs"
          :key="t.id"
          @click="tab = t.id"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition"
          :class="tab === t.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'"
        >
          {{ t.label }}
        </button>
      </nav>
      <p v-if="error" class="text-xs text-rose-400">{{ error }}</p>

      <!-- Profiles -->
      <section v-if="tab === 'profiles'" class="space-y-3">
        <div v-if="editing" :class="card">
          <ProfileEditor :profile="editing" :saving="saving" @save="onSaveProfile" @cancel="editing = null" />
        </div>
        <template v-else>
          <div class="flex flex-wrap items-center gap-2">
            <button @click="editing = newProfile({ name: '新設定檔' })" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold">＋ 新增設定檔</button>
            <button v-if="!profiles.length" @click="seedProfiles" :disabled="seeding" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">建立預設三組（無 AI／Reactive／Proactive）</button>
            <span class="text-[11px] text-slate-500">新房間預設：{{ profileName(system.defaultProfileId) }}</span>
          </div>
          <div v-for="p in profiles" :key="p.id" :class="card" class="flex flex-wrap items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-semibold">{{ p.name }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">v{{ p.version }}</span>
                <span v-if="system.defaultProfileId === p.id" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">預設</span>
              </div>
              <div class="text-xs text-slate-400 mt-0.5">{{ MODE_LABELS[p.mode] }} · 名稱「{{ p.displayName['zh-TW'] }}／{{ p.displayName.en }}」{{ p.shadowAssessment ? ' · 影子判斷' : '' }}</div>
              <div class="text-[11px] text-slate-500 mt-0.5">
                停頓 {{ p.triggers.pauseSeconds }}s · 至少 {{ p.triggers.minNewMessages }} 則 · 最多每 {{ p.triggers.maxMessagesBetweenChecks }} 則 · 停滯 {{ p.triggers.stallSeconds }}s · 冷卻 {{ p.triggers.cooldownSeconds }}s · 記憶每 {{ p.memory.updateEveryMessages }} 則
              </div>
              <div v-if="p.description" class="text-[11px] text-slate-500 mt-0.5">{{ p.description }}</div>
            </div>
            <div class="flex gap-1.5 shrink-0">
              <button @click="editing = p" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">編輯</button>
              <button @click="duplicate(p)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">複製</button>
              <button v-if="system.defaultProfileId !== p.id" @click="setDefaultProfile(p.id!)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">設為預設</button>
              <button @click="archiveProfile(p)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-rose-900/40 text-xs text-rose-300">封存</button>
            </div>
          </div>
        </template>
      </section>

      <!-- Rooms -->
      <section v-if="tab === 'rooms'" class="space-y-3">
        <div class="flex items-center gap-2">
          <p class="text-xs text-slate-400">只列出新版網站建立的房間。指派後房間會凍結該版本設定。</p>
          <button @click="loadRooms" class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': roomsLoading }" /></button>
        </div>
        <div v-if="roomsLoading && !rooms.length" class="text-xs text-slate-500 flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin" />讀取中…</div>
        <div v-for="r in rooms" :key="r.roomId" :class="card" class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-sm">{{ r.roomName || 'Meeting' }} <span class="font-mono text-xs text-sky-400">{{ r.pin }}</span>
              <span v-if="r.roomStatus === 'ended'" class="ml-1 text-[10px] text-amber-300">已結束</span>
            </div>
            <div class="text-[11px] text-slate-500">建立 {{ fmtTime(r.createdAt) }} · 最後活動 {{ fmtTime(r.lastActive) }}</div>
            <div class="text-[11px] text-slate-300 mt-0.5">
              目前：{{ r.assignment ? `${r.assignment.profileName || '—'} v${r.assignment.profileVersion}（${r.assignment.mode}）· ${fmtTime(r.assignment.assignedAt)} by ${r.assignment.assignedBy}` : '尚未指派' }}
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <select v-model="pendingChoice[r.roomId]" :class="select">
              <option value="" disabled>選擇設定檔…</option>
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
            </select>
            <button @click="assign(r)" :disabled="!pendingChoice[r.roomId]" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold disabled:opacity-40">指派</button>
          </div>
        </div>
      </section>

      <!-- Cost -->
      <section v-if="tab === 'cost'" class="grid lg:grid-cols-2 gap-4">
        <div :class="card" class="space-y-3">
          <h3 class="text-sm font-semibold">預估</h3>
          <select v-model="costProfileId" :class="[select, 'w-full']">
            <option value="">內建預設（Proactive）</option>
            <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
          </select>
          <div class="grid grid-cols-2 gap-2">
            <label v-for="f in COST_INPUT_FIELDS" :key="f.key" class="text-[11px] text-slate-400 space-y-0.5">
              <span>{{ f.label }}</span>
              <input type="number" min="0" v-model.number="costInputs[f.key]" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100" />
            </label>
          </div>
          <div class="pt-2 border-t border-slate-800 text-xs space-y-1">
            <div>每場約 {{ estimate.messages }} 則訊息 → AI 判斷約 {{ estimate.checks }} 次、記憶更新 {{ estimate.memoryUpdates }} 次</div>
            <div class="text-slate-400">判斷 {{ usd(estimate.parts.checks) }} · 記憶 {{ usd(estimate.parts.memory) }} · 搜尋 {{ usd(estimate.parts.webSearch) }} · 生圖 {{ usd(estimate.parts.images) }} · 3D {{ usd(estimate.parts.models3D) }}</div>
            <div class="text-base font-semibold text-emerald-300">每場 {{ usd(estimate.perSession) }} · 全部 {{ usd(estimate.total) }}</div>
            <p class="text-[10px] text-slate-500">估算採上限推估（每累積「至少幾則」就判斷一次）。價格在「系統設定」調整；3D 價格請依 Meshy/Tripo 方案填入。</p>
          </div>
        </div>
        <div :class="card" class="space-y-3">
          <h3 class="text-sm font-semibold">實際花費（依後台紀錄）</h3>
          <div class="flex items-center gap-2 text-xs">
            最近 <input type="number" min="1" v-model.number="usageDays" class="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1" /> 天
            <button @click="loadActualUsage" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700">計算</button>
            <Loader2 v-if="usageLoading" class="w-4 h-4 animate-spin text-slate-400" />
          </div>
          <div v-if="usage.length" class="text-xs space-y-1">
            <div class="text-base font-semibold text-emerald-300">{{ usd(actual.total) }}（{{ actual.calls }} 筆 AI 紀錄）</div>
            <div v-for="[room, cost] in actual.byRoom.slice(0, 15)" :key="room" class="flex justify-between text-slate-400">
              <span class="font-mono">{{ room }}</span><span>{{ usd(cost) }}</span>
            </div>
            <p class="text-[10px] text-slate-500">只計 Claude tokens 與網路搜尋；生圖與 3D 依服務商帳單為準。</p>
          </div>
        </div>
      </section>

      <!-- System -->
      <section v-if="tab === 'system'" :class="card" class="space-y-4">
        <div class="grid sm:grid-cols-2 gap-3 text-xs">
          <label class="space-y-1"><span class="text-slate-400">AI 導師判斷模型</span>
            <select v-model="system.models.mentor" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">長期記憶模型</span>
            <select v-model="system.memoryModel" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">白板截圖理解模型</span>
            <select v-model="system.models.vision" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">SVG 生成模型</span>
            <select v-model="system.models.svg" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">AI 導師思考深度（effort）</span>
            <select v-model="system.mentorEffort" :class="[select, 'w-full']"><option v-for="e in ['low', 'medium', 'high']" :key="e">{{ e }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">3D 引擎</span>
            <select v-model="system.engine3D" :class="[select, 'w-full']"><option value="meshy">Meshy</option><option value="tripo">Tripo</option></select>
          </label>
        </div>
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">價格（USD，用於費用估算）</h3>
          <div v-for="m in MODEL_OPTIONS" :key="m" class="flex items-center gap-2">
            <span class="w-40 font-mono text-slate-400">{{ m }}</span>
            輸入 <input type="number" step="0.01" v-model.number="system.prices[m].inputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" />
            輸出 <input type="number" step="0.01" v-model.number="system.prices[m].outputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /> / 百萬 tokens
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label>網路搜尋／次 <input type="number" step="0.001" v-model.number="system.prices.webSearchPerUse" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>生圖／張 <input type="number" step="0.001" v-model.number="system.prices.imagePerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>3D／個 <input type="number" step="0.01" v-model.number="system.prices.model3DPerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
          </div>
        </div>
        <p class="text-[11px] text-amber-300/80">正式實驗期間請勿更換模型；每則 AI 紀錄都會記下實際使用的模型。</p>
        <button @click="saveSystem" :disabled="savingSystem" class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold disabled:opacity-40">{{ savingSystem ? '儲存中…' : '儲存系統設定' }}</button>
      </section>
    </main>
  </div>
</template>
