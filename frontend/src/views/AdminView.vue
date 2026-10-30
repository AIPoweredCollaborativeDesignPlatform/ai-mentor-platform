<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Loader2, RefreshCw, Trash2 } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import ProfileEditor from '../components/admin/ProfileEditor.vue';
import {
  DEFAULT_COST_INPUTS, SEED_PROFILES, modeLabel, estimateCost, newProfile,
  type AiProfile, type CostInputs, type Prices
} from '../utils/aiProfiles';
import {
  assignRoomProfile, deleteStudyRoom, exportRoomNow, getDriveAuthUrl, getDriveStatus, getSystemConfig, listProfiles, listStudyRooms, loadUsage,
  listAdmins, listObservers, listRoomPins, saveProfile, saveSystemConfig, setAdmin, setObserver,
  getApiKeyStatus, setApiKey, testApiKeys, type ApiKeyStatus, type ApiProvider, type ApiTestResult, type DriveStatus, type StudyObserver, type RoomPins, type StudyRoom, type UsageRow
} from '../services/admin';
import { DEFAULT_CONSENT_TEXT, DEFAULT_CONSENT_TEXT_ZH } from '../constants/consent';
import { intlLocale, t, type MessageKey } from '../i18n';
import PageNav from '../components/PageNav.vue';
import { endStudySession, reopenStudySession } from '../services/session';

// Mirrors functions/src/config.js DEFAULT_SYSTEM_CONFIG for display before config/system exists
const SYSTEM_DEFAULTS = {
  models: { mentor: 'claude-haiku-5-5', vision: 'claude-haiku-5-5', svg: 'claude-sonnet-5-5' },
  memoryModel: 'claude-haiku-5-5',
  mentorEffort: 'low',
  engine3D: 'meshy',
  defaultProfileId: null as string | null,
  consentText: DEFAULT_CONSENT_TEXT,
  consentTextZh: DEFAULT_CONSENT_TEXT_ZH,
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
  { id: 'profiles', label: 'adm.tabProfiles' },
  { id: 'rooms', label: 'adm.tabRooms' },
  { id: 'cost', label: 'adm.tabCost' },
  { id: 'system', label: 'adm.tabSystem' }
] as const;
const tabs = computed(() => (isAdmin.value ? ALL_TABS : ALL_TABS.filter(tb => tb.id === 'rooms')));

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
  if (isAdmin.value) await Promise.all([loadAll(), loadObservers(), loadAdmins(), loadApiKeys()]);
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
  if (!add && !window.confirm(t('adm.removeObserverConfirm', { email }))) return;
  observerBusy.value = true;
  try {
    const res = await setObserver(email.trim(), add);
    roomStore.pushToast(add ? t('adm.observerAdded') : t('adm.observerRemoved'), add && !res.applied ? t('adm.observerPending', { email: res.email }) : res.email, 'success');
    observerEmail.value = '';
    await loadObservers();
  } catch (e: any) {
    roomStore.pushToast(t('adm.actionFailed'), e?.message || String(e), 'error');
  } finally {
    observerBusy.value = false;
  }
};

// ---------- AI provider keys ----------
const API_NAMES: Record<ApiProvider, string> = { anthropic: 'Claude', fal: 'fal.ai', meshy: 'Meshy', tripo: 'Tripo' };
const API_SOURCES: Record<ApiKeyStatus['source'], MessageKey> = { admin: 'api.sourceAdmin', secret: 'api.sourceSecret', none: 'api.sourceNone' };
const apiKeys = ref<ApiKeyStatus[]>([]);
const apiDrafts = ref<Partial<Record<ApiProvider, string>>>({});
const apiResults = ref<Partial<Record<ApiProvider, ApiTestResult>>>({});
const apiTesting = ref(new Set<ApiProvider>());
const apiBusy = ref(false);
// "✓ 412 ms claude-… 12+3 tokens" / "✗ 380 ms HTTP 401: Invalid API key"
const apiResultLine = (p: ApiProvider) => {
  const r = apiResults.value[p];
  if (!r) return null;
  const text = [r.ok ? '✓' : '✗', r.ms ? `${r.ms} ms` : '', r.detail || '', r.usage || ''].filter(Boolean).join(' ');
  return { text, cls: r.ok ? 'text-emerald-300' : r.skipped ? 'text-slate-500' : 'text-rose-300' };
};
const loadApiKeys = async () => {
  apiKeys.value = await getApiKeyStatus().catch(() => []);
};
const runApiTest = async (providers?: ApiProvider[]) => {
  const list = providers || apiKeys.value.map(k => k.provider);
  list.forEach(p => apiTesting.value.add(p));
  try {
    for (const r of await testApiKeys(providers)) apiResults.value[r.provider] = r;
  } catch (e: any) {
    roomStore.pushToast(t('adm.actionFailed'), e?.message || String(e), 'error');
  } finally {
    list.forEach(p => apiTesting.value.delete(p));
  }
};
const updateApiKey = async (provider: ApiProvider, key: string) => {
  apiBusy.value = true;
  try {
    apiKeys.value = await setApiKey(provider, key);
    apiDrafts.value[provider] = '';
    delete apiResults.value[provider];
    await runApiTest([provider]); // show right away whether the new key works
  } catch (e: any) {
    roomStore.pushToast(t('adm.actionFailed'), e?.message || String(e), 'error');
  } finally {
    apiBusy.value = false;
  }
};
const saveApiKey = (provider: ApiProvider) => updateApiKey(provider, apiDrafts.value[provider]?.trim() || '');
const clearApiKey = (provider: ApiProvider) => {
  if (window.confirm(t('api.revertConfirm', { name: API_NAMES[provider] }))) updateApiKey(provider, '');
};

// ---------- Administrators (added by the primary administrator; same rights except this list) ----------
const admins = ref<StudyObserver[]>([]);
const adminEmail = ref('');
const adminBusy = ref(false);
const loadAdmins = async () => {
  admins.value = await listAdmins().catch(() => []);
};
const changeAdmin = async (email: string, add: boolean) => {
  if (!email.trim()) return;
  if (!window.confirm(t(add ? 'adm.addAdminConfirm' : 'adm.removeAdminConfirm', { email: email.trim() }))) return;
  adminBusy.value = true;
  try {
    const res = await setAdmin(email.trim(), add);
    roomStore.pushToast(add ? t('adm.adminAdded') : t('adm.adminRemoved'), add && !res.applied ? t('adm.observerPending', { email: res.email }) : res.email, 'success');
    adminEmail.value = '';
    await Promise.all([loadAdmins(), loadObservers()]);
  } catch (e: any) {
    roomStore.pushToast(t('adm.actionFailed'), e?.message || String(e), 'error');
  } finally {
    adminBusy.value = false;
  }
};

// ---------- Profiles ----------
const editing = ref<AiProfile | null>(null);
const saving = ref(false);
const profileName = (id?: string | null) => profiles.value.find(p => p.id === id)?.name || t('adm.builtinDefault');

const onSaveProfile = async (p: AiProfile) => {
  saving.value = true;
  try {
    await saveProfile(p, authStore.email);
    editing.value = null;
    profiles.value = await listProfiles();
    roomStore.pushToast(t('adm.saved'), t('adm.savedProfile', { name: p.name }), 'success');
  } catch (e: any) {
    roomStore.pushToast(t('adm.saveFailed'), e?.message || String(e), 'error');
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
    roomStore.pushToast(t('adm.cannotArchive'), t('adm.cannotArchiveText'), 'warning');
    return;
  }
  if (!window.confirm(t('adm.archiveConfirm', { name: p.name, version: p.version }))) return;
  await saveProfile({ ...p, archived: true } as AiProfile, authStore.email);
  profiles.value = await listProfiles();
};

const duplicate = (p: AiProfile) => {
  editing.value = { ...JSON.parse(JSON.stringify(p)), id: undefined, version: 0, name: t('adm.copySuffix', { name: p.name }) };
};

const setDefaultProfile = async (id: string) => {
  await saveSystemConfig({ defaultProfileId: id });
  system.value.defaultProfileId = id;
  roomStore.pushToast(t('adm.defaultSet'), t('adm.defaultSetText', { name: profileName(id) }), 'success');
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
    roomStore.pushToast(t('adm.loadRoomsFailed'), e?.message || String(e), 'error');
  } finally {
    roomsLoading.value = false;
  }
};
watch(tab, t => {
  if (t !== 'rooms') return;
  if (!rooms.value.length) loadRooms();
  if (!pins.value) loadPins();
});

// One confirmation, as agreed for the study protocol
const assign = async (room: StudyRoom) => {
  const profileId = pendingChoice.value[room.roomId];
  const profile = profiles.value.find(p => p.id === profileId);
  if (!profile) return;
  const ok = window.confirm(t('adm.assignConfirm', { pin: room.pin, name: room.roomName || '', profile: profile.name, version: profile.version }));
  if (!ok) return;
  try {
    await assignRoomProfile(room.roomId, profile.id!);
    roomStore.pushToast(t('adm.assigned'), t('adm.assignedText', { pin: room.pin, profile: profile.name, version: profile.version }), 'success');
    await loadRooms();
  } catch (e: any) {
    roomStore.pushToast(t('adm.assignFailed'), e?.message || String(e), 'error');
  }
};

const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString(intlLocale(), { hour12: false }) : '—');

// ---------- Cost ----------
const costProfileId = ref<string>('');
const costInputs = ref<CostInputs>({ ...DEFAULT_COST_INPUTS });
const costProfile = computed(() => profiles.value.find(p => p.id === costProfileId.value) || newProfile({ name: 'Proactive (built-in)' }));
const estimate = computed(() =>
  estimateCost(costProfile.value, costInputs.value, system.value.prices, { mentor: system.value.models.mentor, memory: system.value.memoryModel })
);
const COST_INPUT_FIELDS: { key: keyof CostInputs; label: MessageKey }[] = [
  { key: 'sessionMinutes', label: 'adm.costMinutes' },
  { key: 'messagesPerMinute', label: 'adm.costMsgs' },
  { key: 'mentionsPerSession', label: 'adm.costMentions' },
  { key: 'settledPollsPerSession', label: 'adm.costPolls' },
  { key: 'stallsPerSession', label: 'adm.costStalls' },
  { key: 'moodboardsPerSession', label: 'adm.costMoodboards' },
  { key: 'models3DPerSession', label: 'adm.costModels' },
  { key: 'webSearchesPerSession', label: 'adm.costSearches' },
  { key: 'sessions', label: 'adm.costSessions' },
  { key: 'checkInputTokens', label: 'adm.costIn' },
  { key: 'checkOutputTokens', label: 'adm.costOut' }
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
    roomStore.pushToast(t('adm.loadLogsFailed'), e?.message || String(e), 'error');
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
    const { models, memoryModel, mentorEffort, engine3D, prices, consentText, consentTextZh } = system.value;
    await saveSystemConfig({ models, memoryModel, mentorEffort, engine3D, prices, consentText, consentTextZh });
    roomStore.pushToast(t('adm.saved'), t('adm.systemSaved'), 'success');
  } finally {
    savingSystem.value = false;
  }
};

// ---------- PINs (functions/src/rooms.js): deleted rooms never give their PIN back ----------
const pins = ref<RoomPins | null>(null);
const pinsLoading = ref(false);
const pinView = ref<'inUse' | 'ended' | 'invalid' | 'free'>('inUse');
const loadPins = async () => {
  pinsLoading.value = true;
  try {
    pins.value = await listRoomPins();
  } catch (e: any) {
    roomStore.pushToast(t('adm.loadPinsFailed'), e?.message || String(e), 'error');
  } finally {
    pinsLoading.value = false;
  }
};
const PIN_TABS = [
  { id: 'inUse', label: 'adm.pinInUse' },
  { id: 'ended', label: 'adm.pinEnded' },
  { id: 'invalid', label: 'adm.pinInvalid' },
  { id: 'free', label: 'adm.pinFree' }
] as const;

const drive = ref<DriveStatus | null>(null);
const loadDrive = async () => {
  drive.value = await getDriveStatus().catch(() => null);
};
const connectDrive = async () => {
  try {
    window.location.href = await getDriveAuthUrl();
  } catch (e: any) {
    roomStore.pushToast(t('adm.authFailed'), e?.message || String(e), 'error');
  }
};
const exporting = ref<Record<string, boolean>>({});
const uploadNow = async (room: StudyRoom) => {
  if (room.upload?.status === 'done' && !window.confirm(t('adm.reuploadConfirm'))) return;
  exporting.value[room.roomId] = true;
  try {
    const res = await exportRoomNow(room.roomId);
    if (res.status === 'done') roomStore.pushToast(t('adm.uploaded'), t('adm.uploadedFiles', { count: res.fileCount ?? 0 }), 'success');
    else roomStore.pushToast(t('adm.uploadFailed'), res.error || res.status, 'error');
    await Promise.all([loadRooms(), loadDrive()]);
  } catch (e: any) {
    roomStore.pushToast(t('adm.uploadFailed'), e?.message || String(e), 'error');
  } finally {
    exporting.value[room.roomId] = false;
  }
};
// Rooms created "as a participant" have no researcher: the administrator ends / reopens them here
const endOrReopen = async (room: StudyRoom, end: boolean) => {
  if (!window.confirm(t(end ? 'adm.endConfirm' : 'adm.reopenConfirm', { pin: room.pin, name: room.roomName || '' }))) return;
  try {
    await (end ? endStudySession(room.roomId) : reopenStudySession(room.roomId));
    await loadRooms();
  } catch (e: any) {
    roomStore.pushToast(end ? t('adm.endFailed') : t('adm.reopenFailed'), e?.message || String(e), 'error');
  }
};
const removeRoom = async (room: StudyRoom) => {
  if (!window.confirm(t('adm.deleteConfirm', { pin: room.pin, name: room.roomName || '' }))) return;
  try {
    await deleteStudyRoom(room.roomId);
    rooms.value = rooms.value.filter(r => r.roomId !== room.roomId);
  } catch (e: any) {
    const running = e?.code === 'functions/failed-precondition';
    roomStore.pushToast(t('adm.deleteFailed'), running ? t('adm.deleteRunning') : e?.message || String(e), 'error');
  }
};
const UPLOAD_LABELS: Record<string, { text: MessageKey; cls: string }> = {
  pending: { text: 'adm.upPending', cls: 'text-slate-300' },
  uploading: { text: 'adm.upUploading', cls: 'text-sky-300' },
  done: { text: 'adm.upDone', cls: 'text-emerald-300' },
  error: { text: 'adm.upError', cls: 'text-rose-300' },
  needs_auth: { text: 'adm.upNeedsAuth', cls: 'text-amber-300' },
  reopened: { text: 'adm.upReopened', cls: 'text-slate-400' }
};

const PHASE_LABELS: Record<string, MessageKey> = { waiting: 'adm.phaseWaiting', running: 'adm.phaseRunning', ended: 'adm.phaseEnded' };

const card = 'p-4 rounded-2xl border border-slate-800 bg-slate-900/70';
const select = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500';
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100">
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center gap-3">
      <h1 class="font-bold">{{ t('adm.title') }}</h1>
      <PageNav>
        <button v-if="isAdmin" @click="loadAll" class="page-nav-btn" :title="t('adm.refresh')">
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
        </button>
      </PageNav>
    </header>

    <div v-if="!canView" class="max-w-md mx-auto mt-24 text-center text-sm text-slate-400 px-6">
      {{ t('adm.noAccess') }}
    </div>

    <main v-else class="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <nav class="flex gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit">
        <button
          v-for="tb in tabs"
          :key="tb.id"
          @click="tab = tb.id"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition"
          :class="tab === tb.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'"
        >
          {{ t(tb.label) }}
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
            <button @click="editing = newProfile({ name: t('adm.newProfileName') })" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">{{ t('adm.newProfile') }}</button>
            <button v-if="!profiles.length" @click="seedProfiles" :disabled="seeding" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.seed') }}</button>
            <span class="text-[11px] text-slate-500">{{ t('adm.newRoomDefault', { name: profileName(system.defaultProfileId) }) }}</span>
          </div>
          <div v-for="p in profiles" :key="p.id" :class="card" class="flex flex-wrap items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-semibold">{{ p.name }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">v{{ p.version }}</span>
                <span v-if="system.defaultProfileId === p.id" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{{ t('adm.default') }}</span>
              </div>
              <div class="text-xs text-slate-400 mt-0.5">{{ t('adm.profileMeta', { mode: modeLabel(p.mode), zh: p.displayName['zh-TW'], en: p.displayName.en }) }}{{ t('adm.languageTag', { lang: p.language || 'zh-TW' }) }}{{ p.shadowAssessment ? t('adm.shadow') : '' }}</div>
              <div class="text-[11px] text-slate-500 mt-0.5">
                {{ t('adm.timingSummary', { pause: p.triggers.pauseSeconds, min: p.triggers.minNewMessages, max: p.triggers.maxMessagesBetweenChecks, stall: p.triggers.stallSeconds, cooldown: p.triggers.cooldownSeconds, memory: p.memory.updateEveryMessages }) }}
              </div>
              <div v-if="p.description" class="text-[11px] text-slate-500 mt-0.5">{{ p.description }}</div>
            </div>
            <div class="flex gap-1.5 shrink-0">
              <button @click="editing = p" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.edit') }}</button>
              <button @click="duplicate(p)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.duplicate') }}</button>
              <button v-if="system.defaultProfileId !== p.id" @click="setDefaultProfile(p.id!)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.setDefault') }}</button>
              <button @click="archiveProfile(p)" class="px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-rose-900/40 text-xs text-rose-300">{{ t('adm.archive') }}</button>
            </div>
          </div>
        </template>
      </section>

      <!-- Rooms -->
      <section v-if="tab === 'rooms'" class="space-y-3">
        <div class="flex items-center gap-2">
          <p class="text-xs text-slate-400">{{ t('adm.roomsHint') }}</p>
          <button @click="loadRooms" class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': roomsLoading }" /></button>
        </div>
        <div v-if="roomsLoading && !rooms.length" class="text-xs text-slate-500 flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin" />{{ t('adm.loading') }}</div>
        <div :class="card" class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1 text-xs space-y-0.5">
            <div class="text-sm font-semibold">{{ t('adm.driveTitle') }}</div>
            <div v-if="!drive" class="text-slate-400">{{ t('adm.driveNone') }}</div>
            <div v-else-if="drive.status === 'needs_auth'" class="text-amber-300">{{ t('adm.driveNeedsAuth', { error: drive.error || '' }) }}</div>
            <div v-else class="text-emerald-300">{{ t('adm.driveConnected', { account: drive.driveAccount || t('adm.unknown'), at: fmtTime(drive.connectedAt) }) }}</div>
            <div v-if="drive?.status === 'ok' && drive.driveAccount && system.driveAccount && drive.driveAccount !== system.driveAccount" class="text-amber-300">{{ t('adm.driveWrongAccount', { account: system.driveAccount }) }}</div>
            <div v-if="drive?.rootFolderId && drive.rootInConfiguredFolder === false" class="text-amber-300/90">{{ t('adm.driveRoot') }}</div>
            <a v-if="drive?.rootFolderId" :href="`https://drive.google.com/drive/folders/${drive.rootFolderId}`" target="_blank" rel="noopener" class="text-sky-400 hover:underline">{{ t('adm.openDriveFolder') }}</a>
          </div>
          <!-- Only when there is no working connection; a connected Drive needs no button -->
          <button v-if="isAdmin && drive?.status !== 'ok'" @click="connectDrive" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white">
            {{ !drive ? t('adm.driveConnect') : t('adm.driveReauth') }}
          </button>
        </div>

        <div v-for="r in rooms" :key="r.roomId" :class="card" class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-sm">{{ r.roomName || 'Meeting' }} <span class="font-mono text-xs text-sky-400">{{ r.pin }}</span>
              <span v-if="r.session" class="ml-1 text-[10px]" :class="r.session.phase === 'running' ? 'text-emerald-300' : r.session.phase === 'ended' ? 'text-amber-300' : 'text-slate-400'">
                {{ PHASE_LABELS[r.session.phase] ? t(PHASE_LABELS[r.session.phase]) : r.session.phase }}<template v-if="r.session.phase === 'waiting'">{{ t('adm.opensAt', { count: r.session.expected }) }}</template><template v-if="r.session.endedBy"> · {{ r.session.endedBy === 'all_offline' ? t('adm.allOffline') : t('adm.endedByResearcher') }}</template>
              </span>
              <span v-else-if="r.roomStatus === 'ended'" class="ml-1 text-[10px] text-amber-300">{{ t('adm.phaseEnded') }}</span>
            </div>
            <div class="text-[11px] text-slate-500">{{ t('adm.created', { at: fmtTime(r.createdAt) }) }} · {{ t('adm.lastActive', { at: fmtTime(r.lastActive) }) }}</div>
            <div class="text-[11px] text-slate-300 mt-0.5">
              {{ t('adm.current', { value: r.assignment ? `${r.assignment.profileName || '—'} v${r.assignment.profileVersion} (${r.assignment.mode}) · ${fmtTime(r.assignment.assignedAt)} by ${r.assignment.assignedBy}` : t('adm.notAssigned') }) }}
            </div>
            <div v-if="r.upload" class="text-[11px] mt-0.5">
              <span :class="UPLOAD_LABELS[r.upload.status]?.cls">{{ t('adm.drivePrefix', { status: UPLOAD_LABELS[r.upload.status] ? t(UPLOAD_LABELS[r.upload.status].text) : r.upload.status }) }}</span>
              <span v-if="r.upload.status === 'pending' && r.upload.dueAt" class="text-slate-500">{{ t('adm.dueAt', { at: fmtTime(r.upload.dueAt) }) }}</span>
              <a v-if="r.upload.folderUrl" :href="r.upload.folderUrl" target="_blank" rel="noopener" class="ml-1 text-sky-400 hover:underline">{{ t('adm.folder') }}</a>
              <span v-if="r.upload.error" class="ml-1 text-rose-300/80">{{ r.upload.error }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <template v-if="isAdmin">
            <select v-model="pendingChoice[r.roomId]" :class="select">
              <option value="" disabled>{{ t('adm.chooseProfile') }}</option>
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
            </select>
            <button @click="assign(r)" :disabled="!pendingChoice[r.roomId]" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('adm.assign') }}</button>
            <button v-if="r.session" @click="uploadNow(r)" :disabled="exporting[r.roomId]" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs disabled:opacity-40">
              {{ exporting[r.roomId] ? t('adm.uploading') : t('adm.uploadDrive') }}
            </button>
            <button v-if="r.session && r.session.phase !== 'ended'" @click="endOrReopen(r, true)" class="px-3 py-1.5 rounded-lg border border-rose-800 text-rose-200 hover:bg-rose-900/40 text-xs">{{ t('common.end') }}</button>
            <button v-else-if="r.session" @click="endOrReopen(r, false)" class="px-3 py-1.5 rounded-lg border border-emerald-800 text-emerald-200 hover:bg-emerald-900/40 text-xs">{{ t('common.reopen') }}</button>
            <button
              @click="removeRoom(r)"
              :disabled="r.session?.phase === 'running'"
              :title="r.session?.phase === 'running' ? t('adm.deleteRunning') : t('adm.deleteHint')"
              class="p-1.5 rounded-lg border border-slate-700 text-rose-300 hover:bg-rose-900/40 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
            </template>
            <router-link v-if="r.session" :to="`/admin/replay/${r.roomId}`" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.replay') }}</router-link>
          </div>
        </div>

        <div :class="card" class="space-y-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold">{{ t('adm.pins') }}</h3>
            <span class="text-[11px] text-slate-500">{{ t('adm.pinsHint') }}</span>
            <button @click="loadPins" :disabled="pinsLoading" class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': pinsLoading }" /></button>
          </div>
          <template v-if="pins">
            <div class="flex gap-1.5">
              <button
                v-for="pt in PIN_TABS"
                :key="pt.id"
                @click="pinView = pt.id"
                class="px-2.5 py-1 rounded-lg text-[11px] font-semibold"
                :class="pinView === pt.id ? 'bg-sky-600 text-white' : 'border border-slate-700 text-slate-400 hover:text-slate-200'"
              >
                {{ t(pt.label) }} {{ pins[pt.id].length }}
              </button>
            </div>
            <div v-if="pinView === 'free'" class="max-h-48 overflow-y-auto font-mono text-[11px] text-slate-400 leading-relaxed">{{ pins.free.join(' ') }}</div>
            <div v-else class="max-h-60 overflow-y-auto text-[11px] text-slate-400 space-y-0.5">
              <div v-for="p in pins[pinView]" :key="p.pin">
                <span class="font-mono text-sky-400">{{ p.pin }}</span> · {{ p.roomName || '—' }} · {{ t('adm.pinCreated', { at: fmtTime(p.createdAt || undefined) }) }}
                <template v-if="pinView === 'invalid'"> · {{ p.reason === 'never_created' ? t('adm.pinNeverCreated') : t('adm.pinDeleted', { at: fmtTime(p.deletedAt || undefined) }) }}</template>
                <template v-else> · {{ t('adm.lastActive', { at: fmtTime(p.lastActive || undefined) }) }}</template>
              </div>
              <div v-if="!pins[pinView].length" class="text-slate-500">{{ t('adm.none') }}</div>
            </div>
          </template>
          <div v-else-if="pinsLoading" class="text-xs text-slate-500 flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin" />{{ t('adm.loading') }}</div>
        </div>
      </section>

      <!-- Cost -->
      <section v-if="tab === 'cost'" class="grid lg:grid-cols-2 gap-4">
        <div :class="card" class="space-y-3">
          <h3 class="text-sm font-semibold">{{ t('adm.estimate') }}</h3>
          <select v-model="costProfileId" :class="[select, 'w-full']">
            <option value="">{{ t('adm.builtinDefault') }}</option>
            <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
          </select>
          <div class="grid grid-cols-2 gap-2">
            <label v-for="f in COST_INPUT_FIELDS" :key="f.key" class="text-[11px] text-slate-400 space-y-0.5">
              <span>{{ t(f.label) }}</span>
              <input type="number" min="0" v-model.number="costInputs[f.key]" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100" />
            </label>
          </div>
          <div class="pt-2 border-t border-slate-800 text-xs space-y-1">
            <div>{{ t('adm.estimateLine', { messages: estimate.messages, checks: estimate.checks, memory: estimate.memoryUpdates }) }}</div>
            <div class="text-slate-400">{{ t('adm.estimateParts', { checks: usd(estimate.parts.checks), memory: usd(estimate.parts.memory), search: usd(estimate.parts.webSearch), images: usd(estimate.parts.images), models: usd(estimate.parts.models3D) }) }}</div>
            <div class="text-base font-semibold text-emerald-300">{{ t('adm.estimateTotal', { per: usd(estimate.perSession), total: usd(estimate.total) }) }}</div>
            <p class="text-[10px] text-slate-500">{{ t('adm.estimateNote') }}</p>
          </div>
        </div>
        <div :class="card" class="space-y-3">
          <h3 class="text-sm font-semibold">{{ t('adm.actual') }}</h3>
          <div class="flex items-center gap-2 text-xs">
            {{ t('adm.lastDays1') }} <input type="number" min="1" v-model.number="usageDays" class="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1" /> {{ t('adm.lastDays2') }}
            <button @click="loadActualUsage" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700">{{ t('adm.compute') }}</button>
            <Loader2 v-if="usageLoading" class="w-4 h-4 animate-spin text-slate-400" />
          </div>
          <div v-if="usage.length" class="text-xs space-y-1">
            <div class="text-base font-semibold text-emerald-300">{{ t('adm.actualTotal', { total: usd(actual.total), count: actual.calls }) }}</div>
            <div v-for="[room, cost] in actual.byRoom.slice(0, 15)" :key="room" class="flex justify-between text-slate-400">
              <span class="font-mono">{{ room }}</span><span>{{ usd(cost) }}</span>
            </div>
            <p class="text-[10px] text-slate-500">{{ t('adm.actualNote') }}</p>
          </div>
        </div>
      </section>

      <!-- System -->
      <section v-if="tab === 'system'" :class="card" class="space-y-4">
        <div class="grid sm:grid-cols-2 gap-3 text-xs">
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.modelMentor') }}</span>
            <select v-model="system.models.mentor" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.modelMemory') }}</span>
            <select v-model="system.memoryModel" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.modelVision') }}</span>
            <select v-model="system.models.vision" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.modelSvg') }}</span>
            <select v-model="system.models.svg" :class="[select, 'w-full']"><option v-for="m in MODEL_OPTIONS" :key="m">{{ m }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.effort') }}</span>
            <select v-model="system.mentorEffort" :class="[select, 'w-full']"><option v-for="e in ['low', 'medium', 'high']" :key="e">{{ e }}</option></select>
          </label>
          <label class="space-y-1"><span class="text-slate-400">{{ t('adm.engine3d') }}</span>
            <select v-model="system.engine3D" :class="[select, 'w-full']"><option value="meshy">Meshy</option><option value="tripo">Tripo</option></select>
          </label>
        </div>
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.prices') }}</h3>
          <div v-for="m in MODEL_OPTIONS" :key="m" class="flex items-center gap-2">
            <span class="w-40 font-mono text-slate-400">{{ m }}</span>
            {{ t('adm.priceIn') }} <input type="number" step="0.01" v-model.number="system.prices[m].inputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" />
            {{ t('adm.priceOut') }} <input type="number" step="0.01" v-model.number="system.prices[m].outputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /> {{ t('adm.perMTok') }}
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label>{{ t('adm.priceSearch') }} <input type="number" step="0.001" v-model.number="system.prices.webSearchPerUse" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>{{ t('adm.priceImage') }} <input type="number" step="0.001" v-model.number="system.prices.imagePerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>{{ t('adm.price3d') }} <input type="number" step="0.01" v-model.number="system.prices.model3DPerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
          </div>
        </div>
        <!-- AI provider keys: status, replace / revert to the Functions secret, quick test -->
        <div class="space-y-2 text-xs">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold">{{ t('api.title') }}</h3>
            <button @click="runApiTest()" :disabled="apiTesting.size > 0" class="ml-auto px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 disabled:opacity-40">{{ t('api.testAll') }}</button>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('api.hint') }}</p>
          <div v-for="k in apiKeys" :key="k.provider" class="p-2.5 rounded-lg border border-slate-800 space-y-1.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold w-24">{{ API_NAMES[k.provider] }}</span>
              <span class="text-[11px]" :class="k.source === 'none' ? 'text-amber-300' : 'text-slate-400'">
                {{ t(API_SOURCES[k.source]) }}<template v-if="k.last4"> · ••••{{ k.last4 }}</template><template v-if="k.source === 'admin' && k.updatedAt"> · {{ fmtTime(k.updatedAt) }}</template>
              </span>
              <span v-if="apiResultLine(k.provider)" class="text-[11px]" :class="apiResultLine(k.provider)!.cls">{{ apiResultLine(k.provider)!.text }}</span>
              <button @click="runApiTest([k.provider])" :disabled="apiTesting.has(k.provider)" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">
                <Loader2 v-if="apiTesting.has(k.provider)" class="w-3 h-3 animate-spin inline" /> {{ t('api.test') }}
              </button>
            </div>
            <form @submit.prevent="saveApiKey(k.provider)" class="flex items-center gap-2">
              <input v-model="apiDrafts[k.provider]" type="password" autocomplete="off" :placeholder="t('api.newKey')" class="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 font-mono" />
              <button :disabled="apiBusy || !apiDrafts[k.provider]?.trim()" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('api.save') }}</button>
              <button v-if="k.source === 'admin'" type="button" @click="clearApiKey(k.provider)" :disabled="apiBusy" class="px-2 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 disabled:opacity-40">{{ t('api.revert') }}</button>
            </form>
          </div>
        </div>
        <!-- Administrators: everyone with admin rights sees the list, only the primary administrator edits it -->
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.admins') }}</h3>
          <p class="text-[11px] text-slate-500">{{ t('adm.adminsHint') }}</p>
          <div class="flex items-center gap-2">
            <span class="font-mono text-slate-300">bb900114@gmail.com</span>
            <span class="text-[11px] text-slate-500">{{ t('adm.primaryAdmin') }}</span>
          </div>
          <div v-for="a in admins" :key="a.email" class="flex items-center gap-2">
            <span class="font-mono text-slate-300">{{ a.email }}</span>
            <span class="text-[11px] text-slate-500">{{ fmtTime(a.addedAt) }}</span>
            <button v-if="authStore.isPrimaryAdmin" @click="changeAdmin(a.email, false)" :disabled="adminBusy" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">{{ t('adm.remove') }}</button>
          </div>
          <form v-if="authStore.isPrimaryAdmin" @submit.prevent="changeAdmin(adminEmail, true)" class="flex items-center gap-2">
            <input v-model="adminEmail" type="email" placeholder="name@gmail.com" class="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5" />
            <button :disabled="adminBusy || !adminEmail.trim()" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('adm.add') }}</button>
          </form>
        </div>
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.observers') }}</h3>
          <p class="text-[11px] text-slate-500">{{ t('adm.observersHint') }}</p>
          <div v-for="o in observers" :key="o.email" class="flex items-center gap-2">
            <span class="font-mono text-slate-300">{{ o.email }}</span>
            <span class="text-[11px] text-slate-500">{{ fmtTime(o.addedAt) }}</span>
            <button @click="changeObserver(o.email, false)" :disabled="observerBusy" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">{{ t('adm.remove') }}</button>
          </div>
          <p v-if="!observers.length" class="text-[11px] text-slate-500">{{ t('adm.noObservers') }}</p>
          <form @submit.prevent="changeObserver(observerEmail, true)" class="flex items-center gap-2">
            <input v-model="observerEmail" type="email" placeholder="name@gmail.com" class="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5" />
            <button :disabled="observerBusy || !observerEmail.trim()" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('adm.add') }}</button>
          </form>
        </div>
        <label class="block space-y-1 text-xs">
          <span class="text-sm font-semibold">{{ t('adm.consent') }}</span>
          <span class="block text-[11px] text-slate-400">{{ t('adm.consentZh') }}</span>
          <textarea v-model="system.consentTextZh" rows="5" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"></textarea>
          <span class="block text-[11px] text-slate-400">{{ t('adm.consentEn') }}</span>
          <textarea v-model="system.consentText" rows="5" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"></textarea>
          <span class="text-[11px] text-slate-500">{{ t('adm.consentNote') }}</span>
        </label>
        <p class="text-[11px] text-amber-300/80">{{ t('adm.noModelChange') }}</p>
        <button @click="saveSystem" :disabled="savingSystem" class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ savingSystem ? t('pe.saving') : t('adm.saveSystem') }}</button>
      </section>
    </main>
  </div>
</template>
