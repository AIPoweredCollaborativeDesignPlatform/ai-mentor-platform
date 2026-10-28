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
  assignRoomProfile, exportRoomNow, getDriveAuthUrl, getDriveStatus, getSystemConfig, listProfiles, listStudyRooms, loadUsage,
  listObservers, purgeLegacyRooms, saveProfile, saveSystemConfig, setObserver, type DriveStatus, type StudyObserver, type LegacyRoom, type StudyRoom, type UsageRow
} from '../services/admin';
import { DEFAULT_CONSENT_TEXT } from '../constants/consent';

// Mirrors functions/src/config.js DEFAULT_SYSTEM_CONFIG for display before config/system exists
const SYSTEM_DEFAULTS = {
  models: { mentor: 'claude-haiku-5-5', vision: 'claude-haiku-5-5', svg: 'claude-sonnet-5-5' },
  memoryModel: 'claude-haiku-5-5',
  mentorEffort: 'low',
  engine3D: 'meshy',
  defaultProfileId: null as string | null,
  consentText: DEFAULT_CONSENT_TEXT,
  driveAccount: '0800guava@gmail.com',
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
const isAdmin = computed(() => authStore.isAdmin);
// Observers only see the rooms tab (status, uploads, replays), without any action buttons
const canView = computed(() => authStore.isObserver);

const tab = ref<'profiles' | 'rooms' | 'cost' | 'system'>('profiles');
const ALL_TABS = [
  { id: 'profiles', label: 'AI 條件設定檔' },
  { id: 'rooms', label: '房間指派' },
  { id: 'cost', label: '費用估算' },
  { id: 'system', label: '系統設定' }
] as const;
const tabs = computed(() => (isAdmin.value ? ALL_TABS : ALL_TABS.filter(t => t.id === 'rooms')));

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
  await authStore.waitForRole();
  if (isAdmin.value) await Promise.all([loadAll(), loadObservers()]);
  else if (canView.value) {
    tab.value = 'rooms';
    await loadAll();
  }
});

// ---------- Observers ----------
const observers = ref<StudyObserver[]>([]);
const observerEmail = ref('');
const observerBusy = ref(false);
const loadObservers = async () => {
  observers.value = await listObservers().catch(() => []);
};
const changeObserver = async (email: string, add: boolean) => {
  if (!email.trim()) return;
  if (!add && !window.confirm(`移除觀察員 ${email}？`)) return;
  observerBusy.value = true;
  try {
    const res = await setObserver(email.trim(), add);
    roomStore.pushToast(add ? '已加入觀察員' : '已移除觀察員', add && !res.applied ? `${res.email} 尚未登入過，第一次登入時生效` : res.email, 'success');
    observerEmail.value = '';
    await loadObservers();
  } catch (e: any) {
    roomStore.pushToast('操作失敗', e?.message || String(e), 'error');
  } finally {
    observerBusy.value = false;
  }
};

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
    [rooms.value] = await Promise.all([listStudyRooms(), loadDrive()]);
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
    const { models, memoryModel, mentorEffort, engine3D, prices, consentText } = system.value;
    await saveSystemConfig({ models, memoryModel, mentorEffort, engine3D, prices, consentText });
    roomStore.pushToast('已儲存', '系統設定已更新（約 1 分鐘內生效）', 'success');
  } finally {
    savingSystem.value = false;
  }
};

// ---------- Legacy site rooms ----------
const legacyRooms = ref<LegacyRoom[] | null>(null);
const legacyBusy = ref(false);
const listLegacy = async () => {
  legacyBusy.value = true;
  try {
    legacyRooms.value = (await purgeLegacyRooms(true)).rooms || [];
  } catch (e: any) {
    roomStore.pushToast('讀取失敗', e?.message || String(e), 'error');
  } finally {
    legacyBusy.value = false;
  }
};
const deleteLegacy = async () => {
  const n = legacyRooms.value?.length || 0;
  if (!n || !window.confirm(`永久刪除舊站的 ${n} 個房間（含訊息、白板、成員等所有子資料）？

此動作無法復原。`)) return;
  legacyBusy.value = true;
  try {
    const res = await purgeLegacyRooms(false);
    roomStore.pushToast('已刪除', `舊站房間 ${res.deleted} 個、使用者房間索引 ${res.indexEntries} 筆`, 'success');
    legacyRooms.value = null;
  } catch (e: any) {
    roomStore.pushToast('刪除失敗', e?.message || String(e), 'error');
  } finally {
    legacyBusy.value = false;
  }
};

// ---------- Google Drive export ----------
const drive = ref<DriveStatus | null>(null);
const loadDrive = async () => {
  drive.value = await getDriveStatus().catch(() => null);
};
const connectDrive = async () => {
  try {
    window.location.href = await getDriveAuthUrl();
  } catch (e: any) {
    roomStore.pushToast('無法開始授權', e?.message || String(e), 'error');
  }
};
const exporting = ref<Record<string, boolean>>({});
const uploadNow = async (room: StudyRoom) => {
  if (room.upload?.status === 'done' && !window.confirm('這個房間已上傳過。要再上傳一份（新資料夾）嗎？')) return;
  exporting.value[room.roomId] = true;
  try {
    const res = await exportRoomNow(room.roomId);
    if (res.status === 'done') roomStore.pushToast('已上傳', `${res.fileCount} 個檔案`, 'success');
    else roomStore.pushToast('上傳失敗', res.error || res.status, 'error');
    await Promise.all([loadRooms(), loadDrive()]);
  } catch (e: any) {
    roomStore.pushToast('上傳失敗', e?.message || String(e), 'error');
  } finally {
    exporting.value[room.roomId] = false;
  }
};
const UPLOAD_LABELS: Record<string, { text: string; cls: string }> = {
  pending: { text: '等待上傳', cls: 'text-slate-300' },
  uploading: { text: '上傳中', cls: 'text-sky-300' },
  done: { text: '已上傳', cls: 'text-emerald-300' },
  error: { text: '上傳失敗', cls: 'text-rose-300' },
  needs_auth: { text: '需要重新授權', cls: 'text-amber-300' },
  reopened: { text: '房間已重開，結束後再上傳', cls: 'text-slate-400' }
};

const PHASE_LABELS: Record<string, string> = { waiting: '等待開場', running: '進行中', ended: '已結束' };

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

    <div v-if="!canView" class="max-w-md mx-auto mt-24 text-center text-sm text-slate-400 px-6">
      這個頁面只有研究管理者與觀察員帳號可以使用。請先在首頁用 Google 帳號登入。
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
        <div :class="card" class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1 text-xs space-y-0.5">
            <div class="text-sm font-semibold">Google Drive 研究資料</div>
            <div v-if="!drive" class="text-slate-400">尚未連接。房間結束 10 分鐘後的自動上傳會先排隊，連接後自動補傳。</div>
            <div v-else-if="drive.status === 'needs_auth'" class="text-amber-300">需要重新授權：{{ drive.error }}</div>
            <div v-else class="text-emerald-300">已連接 Drive 帳號 {{ drive.driveAccount || '（未知）' }}（{{ fmtTime(drive.connectedAt) }}）</div>
            <div v-if="drive?.status === 'ok' && drive.driveAccount && system.driveAccount && drive.driveAccount !== system.driveAccount" class="text-amber-300">注意：預定的 Drive 帳號是 {{ system.driveAccount }}，請按「重新連接」改選該帳號。</div>
            <div v-if="drive?.rootFolderId && drive.rootInConfiguredFolder === false" class="text-amber-300/90">「AI Mentor 研究資料」建在雲端硬碟根目錄（權限不允許直接寫進指定資料夾），請把它拖進研究資料夾；拖過去後上傳照常。</div>
            <a v-if="drive?.rootFolderId" :href="`https://drive.google.com/drive/folders/${drive.rootFolderId}`" target="_blank" rel="noopener" class="text-sky-400 hover:underline">開啟「AI Mentor 研究資料」資料夾</a>
          </div>
          <button v-if="isAdmin" @click="connectDrive" class="px-3 py-1.5 rounded-lg text-xs font-semibold" :class="drive?.status === 'ok' ? 'border border-slate-700 hover:bg-slate-800' : 'bg-sky-600 hover:bg-sky-500'">
            {{ !drive ? '連接 Google Drive' : drive.status === 'ok' ? '重新連接' : '重新授權' }}
          </button>
        </div>

        <div v-for="r in rooms" :key="r.roomId" :class="card" class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-sm">{{ r.roomName || 'Meeting' }} <span class="font-mono text-xs text-sky-400">{{ r.pin }}</span>
              <span v-if="r.session" class="ml-1 text-[10px]" :class="r.session.phase === 'running' ? 'text-emerald-300' : r.session.phase === 'ended' ? 'text-amber-300' : 'text-slate-400'">
                {{ PHASE_LABELS[r.session.phase] || r.session.phase }}<template v-if="r.session.phase === 'waiting'">（{{ r.session.expected }} 人開場）</template><template v-if="r.session.endedBy">・{{ r.session.endedBy === 'all_offline' ? '全員離線' : '研究者結束' }}</template>
              </span>
              <span v-else-if="r.roomStatus === 'ended'" class="ml-1 text-[10px] text-amber-300">已結束</span>
            </div>
            <div class="text-[11px] text-slate-500">建立 {{ fmtTime(r.createdAt) }} · 最後活動 {{ fmtTime(r.lastActive) }}</div>
            <div class="text-[11px] text-slate-300 mt-0.5">
              目前：{{ r.assignment ? `${r.assignment.profileName || '—'} v${r.assignment.profileVersion}（${r.assignment.mode}）· ${fmtTime(r.assignment.assignedAt)} by ${r.assignment.assignedBy}` : '尚未指派' }}
            </div>
            <div v-if="r.upload" class="text-[11px] mt-0.5">
              <span :class="UPLOAD_LABELS[r.upload.status]?.cls">Drive：{{ UPLOAD_LABELS[r.upload.status]?.text || r.upload.status }}</span>
              <span v-if="r.upload.status === 'pending' && r.upload.dueAt" class="text-slate-500">（預定 {{ fmtTime(r.upload.dueAt) }}）</span>
              <a v-if="r.upload.folderUrl" :href="r.upload.folderUrl" target="_blank" rel="noopener" class="ml-1 text-sky-400 hover:underline">資料夾</a>
              <span v-if="r.upload.error" class="ml-1 text-rose-300/80">{{ r.upload.error }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <template v-if="isAdmin">
            <select v-model="pendingChoice[r.roomId]" :class="select">
              <option value="" disabled>選擇設定檔…</option>
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
            </select>
            <button @click="assign(r)" :disabled="!pendingChoice[r.roomId]" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold disabled:opacity-40">指派</button>
            <button v-if="r.session" @click="uploadNow(r)" :disabled="exporting[r.roomId]" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs disabled:opacity-40">
              {{ exporting[r.roomId] ? '上傳中…' : '上傳 Drive' }}
            </button>
            </template>
            <router-link v-if="r.session" :to="`/admin/replay/${r.roomId}`" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">重播</router-link>
          </div>
        </div>

        <div v-if="isAdmin" :class="card" class="space-y-2 border-rose-900/50">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-rose-200">舊站房間</h3>
            <span class="text-[11px] text-slate-500">ai-mentor-web.web.app 建立的房間（沒有 appVersion）</span>
            <button @click="listLegacy" :disabled="legacyBusy" class="ml-auto px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs disabled:opacity-40">列出</button>
          </div>
          <template v-if="legacyRooms">
            <p class="text-xs text-slate-300">共 {{ legacyRooms.length }} 個</p>
            <div class="max-h-48 overflow-y-auto text-[11px] text-slate-400 space-y-0.5">
              <div v-for="l in legacyRooms" :key="l.roomId">{{ l.roomId }} · {{ l.roomName || '—' }} · 最後活動 {{ fmtTime(l.lastActive || undefined) }}</div>
            </div>
            <button v-if="legacyRooms.length" @click="deleteLegacy" :disabled="legacyBusy" class="px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-600 text-xs font-semibold disabled:opacity-40">
              {{ legacyBusy ? '刪除中…' : `永久刪除這 ${legacyRooms.length} 個房間` }}
            </button>
          </template>
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
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">觀察員</h3>
          <p class="text-[11px] text-slate-500">用 Google 帳號登入後，可隱形唯讀進入任何實驗房（看得到所有白板，含私人草稿）、看本頁房間狀態與重播；不能改設定檔、Drive 與同意書。也可以選擇以一般參與者身分加入。</p>
          <div v-for="o in observers" :key="o.email" class="flex items-center gap-2">
            <span class="font-mono text-slate-300">{{ o.email }}</span>
            <span class="text-[11px] text-slate-500">{{ fmtTime(o.addedAt) }}</span>
            <button @click="changeObserver(o.email, false)" :disabled="observerBusy" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">移除</button>
          </div>
          <p v-if="!observers.length" class="text-[11px] text-slate-500">尚無觀察員</p>
          <form @submit.prevent="changeObserver(observerEmail, true)" class="flex items-center gap-2">
            <input v-model="observerEmail" type="email" placeholder="name@gmail.com" class="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5" />
            <button :disabled="observerBusy || !observerEmail.trim()" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold disabled:opacity-40">加入</button>
          </form>
        </div>
        <label class="block space-y-1 text-xs">
          <span class="text-sm font-semibold">研究同意書（參加者進房前必須勾選同意；建議用英文）</span>
          <textarea v-model="system.consentText" rows="6" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"></textarea>
          <span class="text-[11px] text-slate-500">每位參加者的同意紀錄會保存同意當下的文字版本，修改不影響已同意者的紀錄。</span>
        </label>
        <p class="text-[11px] text-amber-300/80">正式實驗期間請勿更換模型；每則 AI 紀錄都會記下實際使用的模型。</p>
        <button @click="saveSystem" :disabled="savingSystem" class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold disabled:opacity-40">{{ savingSystem ? '儲存中…' : '儲存系統設定' }}</button>
      </section>
    </main>
  </div>
</template>
