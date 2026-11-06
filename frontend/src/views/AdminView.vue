<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Check, CheckCheck, ChevronDown, Loader2, MessageSquare, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import ProfileEditor from '../components/admin/ProfileEditor.vue';
import {
  DEFAULT_COST_INPUTS, SEED_PROFILES, modeLabel, estimateCost, newProfile,
  type AiProfile, type CostInputs, type Prices
} from '../utils/aiProfiles';
import {
  assignRoomProfile, deleteStudyRoom, listRoomCreators, exportRoomNow, getDriveAuthUrl, getDriveStatus, getSystemConfig, listProfiles, listStudyRooms, loadUsage,
  listAdmins, listObservers, listRoomPins, saveProfile, saveSystemConfig, setAdmin, setObserver,
  getApiKeyStatus, setApiKey, testApiKeys, type ApiKeyStatus, type ApiProvider, type ApiTestResult, type DriveStatus, type StudyObserver, type RoomPins, type StudyRoom, type UsageRow
} from '../services/admin';
import { DEFAULT_CONSENT_TEXT, DEFAULT_CONSENT_TEXT_ZH } from '../constants/consent';
import { intlLocale, t, type MessageKey } from '../i18n';
import PageNav from '../components/PageNav.vue';
import { endStudySession, reopenStudySession } from '../services/session';
import { DEFAULT_NOTIFICATION_VOLUME, playChime } from '../composables/useNotificationSound';

// Mirrors functions/src/config.js DEFAULT_SYSTEM_CONFIG for display before config/system exists
const SYSTEM_DEFAULTS = {
  models: { mentor: 'claude-haiku-5-5', vision: 'claude-haiku-5-5', svg: 'claude-sonnet-5-5' },
  memoryModel: 'claude-haiku-5-5',
  mentorEffort: 'low',
  engine3D: 'meshy',
  notificationVolume: DEFAULT_NOTIFICATION_VOLUME,
  meshy: { aiModel: 'meshy-7.1', geometryResolution: 'standard', autoRefine: false, imageTexture: true, textureResolution: '2k', enablePbr: true },
  sketchModel: 'fal-ai/flux/dev',
  sketchRefineModel: 'fal-ai/flux/dev/image-to-image',
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
// Meshy credits per request (docs.meshy.ai/en/api/pricing, checked 2026-10-30)
const MESHY_MODELS = [
  { id: 'meshy-6-lite', label: 'adm.meshyLite', credits: 5 },
  { id: 'meshy-6', label: 'adm.meshy6', credits: 20 },
  { id: 'meshy-7.1', label: 'adm.meshy71', credits: 20 }
] as const;

const authStore = useAuthStore();
const roomStore = useRoomStore();
const isAdmin = computed(() => authStore.isAdmin);
// Observers only see the rooms tab (status, uploads, replays), without any action buttons
const canView = computed(() => authStore.isObserver);

type AdminTab = 'profiles' | 'rooms' | 'cost' | 'system';
// The tab lives in the URL (?tab=rooms), so reloading or coming back from a replay keeps it
const route = useRoute();
const router = useRouter();
const TAB_IDS: AdminTab[] = ['profiles', 'rooms', 'cost', 'system'];
const tab = ref<AdminTab>(TAB_IDS.includes(route.query.tab as AdminTab) ? (route.query.tab as AdminTab) : 'profiles');
watch(tab, id => router.replace({ query: { ...route.query, tab: id } }));

// Last loaded lists are shown at once from this browser, then refreshed in the background
const CACHE_KEY = 'ai_mentor_admin_cache';
const readCache = (): { rooms?: StudyRoom[]; pins?: RoomPins; profiles?: AiProfile[] } => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
};
const writeCache = (part: ReturnType<typeof readCache>) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), ...part }));
  } catch {}
};
const cached = readCache();
const ALL_TABS = [
  { id: 'profiles', label: 'adm.tabProfiles' },
  { id: 'rooms', label: 'adm.tabRooms' },
  { id: 'cost', label: 'adm.tabCost' },
  { id: 'system', label: 'adm.tabSystem' }
] as const;
const tabs = computed(() => (isAdmin.value ? ALL_TABS : ALL_TABS.filter(tb => tb.id === 'rooms')));

const profiles = ref<AiProfile[]>(cached.profiles || []);
watch(profiles, list => writeCache({ profiles: list }));
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
      meshy: { ...SYSTEM_DEFAULTS.meshy, ...(cfg.meshy || {}) },
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
  if (canView.value && !isAdmin.value) tab.value = 'rooms';
  if (canView.value && tab.value === 'rooms') loadRoomsTab();
  if (isAdmin.value) await Promise.all([loadAll(), loadObservers(), loadAdmins(), loadApiKeys()]);
  else if (canView.value) await loadAll();
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
const rooms = ref<StudyRoom[]>(cached.rooms || []);
const roomsLoading = ref(false);
const pendingChoice = ref<Record<string, string>>({});
const loadRooms = async () => {
  roomsLoading.value = true;
  try {
    const [list] = await Promise.all([listStudyRooms(), loadDrive()]);
    // Creator account (or anonymous guest), looked up by the server
    const creators = await listRoomCreators(list.map(r => r.roomId)).catch(() => ({} as Record<string, StudyRoom['creator']>));
    list.forEach(r => (r.creator = creators[r.roomId]));
    rooms.value = list;
    writeCache({ rooms: rooms.value });
  } catch (e: any) {
    roomStore.pushToast(t('adm.loadRoomsFailed'), e?.message || String(e), 'error');
  } finally {
    roomsLoading.value = false;
  }
};
// Every visit refreshes; the cached list stays on screen meanwhile
let roomsFetched = false;
const loadRoomsTab = () => {
  if (roomsFetched) return;
  roomsFetched = true;
  loadRooms();
  loadPins();
};
watch(tab, id => id === 'rooms' && canView.value && loadRoomsTab());

// Filter by condition, first few rooms only (PIN list stays reachable), batch delete
const roomFilter = ref<string>('all');
const roomFilters = computed(() => {
  const seen = new Map<string, string>();
  for (const r of rooms.value) {
    const id = r.assignment?.profileId || '';
    if (!seen.has(id)) seen.set(id, r.assignment ? r.assignment.profileName || '—' : t('adm.notAssigned'));
  }
  return [...seen].map(([id, name]) => ({ id, name, count: rooms.value.filter(r => (r.assignment?.profileId || '') === id).length }));
});
const filteredRooms = computed(() => (roomFilter.value === 'all' ? rooms.value : rooms.value.filter(r => (r.assignment?.profileId || '') === roomFilter.value)));
const ROOMS_PREVIEW = 5;
const showAllRooms = ref(false);
const visibleRooms = computed(() => (showAllRooms.value ? filteredRooms.value : filteredRooms.value.slice(0, ROOMS_PREVIEW)));
const isRunning = (r: StudyRoom) => r.session?.phase === 'running';

const manageRooms = ref(false);
const selectedRooms = ref(new Set<string>());
const toggleRoomSelect = (r: StudyRoom) => {
  if (!manageRooms.value || isRunning(r)) return;
  const next = new Set(selectedRooms.value);
  next.has(r.roomId) ? next.delete(r.roomId) : next.add(r.roomId);
  selectedRooms.value = next;
};
const selectable = computed(() => filteredRooms.value.filter(r => !isRunning(r)));
const toggleSelectAllRooms = () => {
  selectedRooms.value = selectedRooms.value.size === selectable.value.length ? new Set() : new Set(selectable.value.map(r => r.roomId));
};
const exitManage = () => {
  manageRooms.value = false;
  selectedRooms.value = new Set();
};
const deletingRooms = ref(false);
const deleteSelectedRooms = async () => {
  const ids = [...selectedRooms.value];
  if (!ids.length || !window.confirm(t('adm.deleteManyConfirm', { count: ids.length }))) return;
  deletingRooms.value = true;
  // One at a time, keeping the server's reason for any room it refuses
  const failed = new Map<string, string>();
  for (const id of ids) {
    await deleteStudyRoom(id).catch((e: any) => failed.set(id, e?.message || String(e)));
  }
  // The page stays as it was (manage mode, filter, expanded list); only the deleted cards go
  rooms.value = rooms.value.filter(r => !ids.includes(r.roomId) || failed.has(r.roomId));
  writeCache({ rooms: rooms.value });
  selectedRooms.value = new Set(failed.keys());
  deletingRooms.value = false;
  if (failed.size) {
    const [id, reason] = [...failed][0];
    roomStore.pushToast(t('adm.deleteFailed'), t('adm.deleteManyFailedReason', { count: failed.size, room: id.slice(5), reason }), 'error');
  }
  // Confirm against the server quietly (PIN list included), without the loading state
  refreshRoomsQuietly();
};
const refreshRoomsQuietly = async () => {
  try {
    const list = await listStudyRooms();
    const creators = Object.fromEntries(rooms.value.map(r => [r.roomId, r.creator]));
    list.forEach(r => (r.creator = creators[r.roomId]));
    rooms.value = list;
    writeCache({ rooms: list });
  } catch {
    // the next visit refreshes anyway
  }
  loadPins();
};

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
const fmtShort = (ms?: number) => (ms ? new Date(ms).toLocaleString(intlLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

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
const meshyCost = computed(() => {
  const m = system.value.meshy || {};
  const preview = (MESHY_MODELS.find(x => x.id === m.aiModel)?.credits ?? 20) + (m.aiModel === 'meshy-7.1' && m.geometryResolution !== 'standard' ? 5 : 0);
  const refine = m.textureResolution === '8k' ? 15 : 10;
  return { preview, refine: m.autoRefine ? refine : 0 };
});
// 2k / 4k geometry only on meshy-7.1; 4k / 8k textures not on meshy-6-lite
watch(() => system.value.meshy?.aiModel, model => {
  if (!system.value.meshy) return;
  if (model !== 'meshy-7.1') system.value.meshy.geometryResolution = 'standard';
  if (model === 'meshy-6-lite') system.value.meshy.textureResolution = '2k';
});
const savingSystem = ref(false);
const saveSystem = async () => {
  savingSystem.value = true;
  try {
    const { models, memoryModel, mentorEffort, engine3D, meshy, sketchModel, sketchRefineModel, notificationVolume, prices, consentText, consentTextZh } = system.value;
    await saveSystemConfig({ models, memoryModel, mentorEffort, engine3D, meshy, sketchModel, sketchRefineModel, notificationVolume, prices, consentText, consentTextZh });
    roomStore.pushToast(t('adm.saved'), t('adm.systemSaved'), 'success');
  } finally {
    savingSystem.value = false;
  }
};

// ---------- PINs (functions/src/rooms.js): deleted rooms never give their PIN back ----------
const pins = ref<RoomPins | null>(cached.pins || null);
const pinsLoading = ref(false);
const pinView = ref<'inUse' | 'ended' | 'invalid' | 'free'>('inUse');
const loadPins = async () => {
  pinsLoading.value = true;
  try {
    pins.value = await listRoomPins();
    writeCache({ pins: pins.value });
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
const UPLOAD_LABELS: Record<string, { text: MessageKey; cls: string }> = {
  pending: { text: 'adm.upPending', cls: 'text-slate-300' },
  uploading: { text: 'adm.upUploading', cls: 'text-sky-300' },
  done: { text: 'adm.upDone', cls: 'text-emerald-300' },
  error: { text: 'adm.upError', cls: 'text-rose-300' },
  needs_auth: { text: 'adm.upNeedsAuth', cls: 'text-amber-300' },
  reopened: { text: 'adm.upReopened', cls: 'text-slate-400' }
};

const creatorLabel = (r: StudyRoom) =>
  !r.creator ? '' : r.creator.email || t(r.creator.anonymous ? 'adm.creatorAnon' : 'adm.creatorUnknown');
const uploadLabel = (r: StudyRoom) => `Drive ${UPLOAD_LABELS[r.upload!.status] ? t(UPLOAD_LABELS[r.upload!.status].text) : r.upload!.status}`;
// Full details stay available on hover; the card shows the short line
const roomDetail = (r: StudyRoom) => [
  t('adm.created', { at: fmtTime(r.createdAt) }),
  t('adm.lastActive', { at: fmtTime(r.lastActive) }),
  r.assignment ? `${fmtTime(r.assignment.assignedAt)} by ${r.assignment.assignedBy}` : ''
].filter(Boolean).join(' · ');

const PHASE_LABELS: Record<string, MessageKey> = { waiting: 'adm.phaseWaiting', running: 'adm.phaseRunning', ended: 'adm.phaseEnded' };

const card = 'p-4 rounded-2xl border border-slate-800 bg-slate-900/70';
const select = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500';
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100 pt-safe px-safe">
    <header class="h-14 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center gap-3">
      <h1 class="font-bold">{{ t('adm.title') }}</h1>
      <PageNav><router-link v-if="canView" to="/admin/coding" class="page-nav-btn">{{ t('coding.title') }}</router-link>
        <button v-if="isAdmin" @click="loadAll" class="page-nav-btn" :title="t('adm.refresh')">
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
        </button>
      </PageNav>
    </header>

    <div v-if="!canView" class="max-w-md mx-auto mt-24 text-center text-sm text-slate-400 px-6">
      {{ t('adm.noAccess') }}
    </div>

    <main v-else class="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <nav class="flex gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit max-w-full overflow-x-auto no-scrollbar">
        <button
          v-for="tb in tabs"
          :key="tb.id"
          @click="tab = tb.id"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition shrink-0 whitespace-nowrap"
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
            <div class="flex flex-wrap gap-1.5 w-full sm:w-auto sm:shrink-0">
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

        <!-- Filter by condition, batch management -->
        <div v-if="rooms.length" class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="f in [{ id: 'all', name: t('adm.filterAll'), count: rooms.length }, ...roomFilters]"
            :key="f.id"
            @click="roomFilter = f.id"
            class="px-2.5 py-1 rounded-lg text-[11px] font-semibold"
            :class="roomFilter === f.id ? 'bg-sky-600 text-white' : 'border border-slate-700 text-slate-400 hover:text-slate-200'"
          >
            {{ f.name }} {{ f.count }}
          </button>
          <div v-if="isAdmin" class="ml-auto flex items-center gap-1.5">
            <template v-if="manageRooms">
              <button @click="toggleSelectAllRooms" class="px-2.5 py-1 rounded-lg border border-slate-700 text-xs inline-flex items-center gap-1">
                <CheckCheck class="w-3.5 h-3.5 text-sky-400" />
                {{ selectedRooms.size && selectedRooms.size === selectable.length ? t('dash.deselectAll') : t('dash.selectAll') }}
              </button>
              <button @click="deleteSelectedRooms" :disabled="!selectedRooms.size || deletingRooms" class="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-40">
                <Trash2 class="w-3.5 h-3.5" /> {{ t('adm.deleteN', { count: selectedRooms.size }) }}
              </button>
              <button @click="exitManage" class="px-2.5 py-1 rounded-lg border border-slate-700 text-xs text-slate-400">{{ t('wb.done') }}</button>
            </template>
            <button v-else @click="manageRooms = true" class="px-2.5 py-1 rounded-lg border border-slate-700 text-xs text-slate-300 inline-flex items-center gap-1">
              <SlidersHorizontal class="w-3.5 h-3.5 text-sky-400" /> {{ t('dash.manage') }}
            </button>
          </div>
        </div>
        <p v-if="manageRooms" class="text-[11px] text-slate-500">{{ t('adm.manageHint') }}</p>

        <div
          v-for="r in visibleRooms"
          :key="r.roomId"
          :class="[card, selectedRooms.has(r.roomId) ? '!border-sky-500/80 ring-1 ring-sky-500/40' : '']"
          class="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          <!-- Manage mode only adds a checkbox; the card and its actions stay as they are -->
          <button
            v-if="manageRooms"
            type="button"
            @click="toggleRoomSelect(r)"
            :disabled="isRunning(r)"
            :title="isRunning(r) ? t('adm.manageHint') : ''"
            class="shrink-0 -m-2 p-2 pointer-coarse:p-3 disabled:opacity-30"
          >
            <span
              class="w-4 h-4 rounded border flex items-center justify-center"
              :class="selectedRooms.has(r.roomId) ? 'bg-sky-500 border-sky-400 text-white' : 'border-slate-600 bg-slate-950'"
            ><Check v-if="selectedRooms.has(r.roomId)" class="w-3 h-3 stroke-[3]" /></span>
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-semibold text-sm truncate">{{ r.roomName || 'Meeting' }}</span>
              <span class="font-mono text-xs text-sky-400 shrink-0">{{ r.pin }}</span>
              <span
                v-if="r.session || r.roomStatus === 'ended'"
                class="shrink-0 px-1.5 py-0.5 rounded text-[10px]"
                :class="r.session?.phase === 'running' ? 'bg-emerald-500/15 text-emerald-300' : r.session?.phase === 'waiting' ? 'bg-slate-800 text-slate-400' : 'bg-amber-500/15 text-amber-300'"
                :title="r.session?.endedBy ? (r.session.endedBy === 'all_offline' ? t('adm.allOffline') : t('adm.endedByResearcher')) : ''"
              >{{ r.session ? (PHASE_LABELS[r.session.phase] ? t(PHASE_LABELS[r.session.phase]) : r.session.phase) : t('adm.phaseEnded') }}</span>
            </div>
            <div
              class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400"
              :title="roomDetail(r)"
            >
              <span v-if="r.messageCount !== undefined" class="inline-flex items-center gap-1"><MessageSquare class="w-3 h-3" />{{ t('adm.messageCount', { count: r.messageCount }) }}</span>
              <span :class="r.assignment ? 'text-slate-300' : 'text-amber-300'">{{ r.assignment ? `${r.assignment.profileName || '—'} v${r.assignment.profileVersion} · ${r.assignment.mode}` : t('adm.notAssigned') }}</span>
              <span>{{ t('adm.lastActiveShort', { at: fmtShort(r.lastActive) }) }}</span>
              <span v-if="r.creator" class="truncate max-w-full" :class="r.creator.email ? '' : 'text-slate-500'">{{ t('adm.createdBy', { who: creatorLabel(r) }) }}</span>
              <template v-if="r.upload">
                <a v-if="r.upload.folderUrl" :href="r.upload.folderUrl" target="_blank" rel="noopener" @click.stop class="hover:underline" :class="UPLOAD_LABELS[r.upload.status]?.cls">{{ uploadLabel(r) }}</a>
                <span v-else :class="UPLOAD_LABELS[r.upload.status]?.cls" :title="r.upload.error || (r.upload.dueAt ? t('adm.dueAt', { at: fmtTime(r.upload.dueAt) }) : '')">{{ uploadLabel(r) }}</span>
              </template>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
            <template v-if="isAdmin">
            <select v-model="pendingChoice[r.roomId]" :class="[select, 'flex-1 min-w-0 sm:flex-none sm:w-36']">
              <option value="" disabled>{{ t('adm.chooseProfile') }}</option>
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} v{{ p.version }}</option>
            </select>
            <button @click="assign(r)" :disabled="!pendingChoice[r.roomId]" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('adm.assign') }}</button>
            <button v-if="r.session" @click="uploadNow(r)" :disabled="exporting[r.roomId]" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs disabled:opacity-40">
              {{ exporting[r.roomId] ? t('adm.uploading') : t('adm.uploadDrive') }}
            </button>
            <!-- End and Reopen share one width so the row does not shift -->
            <button v-if="r.session && r.session.phase !== 'ended'" @click="endOrReopen(r, true)" class="w-20 px-2 py-1.5 rounded-lg border border-rose-800 text-rose-200 hover:bg-rose-900/40 text-xs">{{ t('common.end') }}</button>
            <button v-else-if="r.session" @click="endOrReopen(r, false)" class="w-20 px-2 py-1.5 rounded-lg border border-emerald-800 text-emerald-200 hover:bg-emerald-900/40 text-xs">{{ t('common.reopen') }}</button>
            </template>
            <router-link :to="`/waiting/${r.roomId}?as=observer`" class="adm-link inline-flex items-center px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs" :title="t('adm.enterObserverHint')">{{ t('adm.enterObserver') }}</router-link>
            <router-link v-if="r.session" :to="`/admin/replay/${r.roomId}`" class="adm-link inline-flex items-center px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs">{{ t('adm.replay') }}</router-link>
          </div>
        </div>
        <button
          v-if="filteredRooms.length > ROOMS_PREVIEW"
          @click="showAllRooms = !showAllRooms"
          class="w-full py-2 rounded-xl border border-dashed border-slate-700 text-xs text-slate-400 hover:text-slate-200 inline-flex items-center justify-center gap-1"
        >
          <ChevronDown class="w-3.5 h-3.5 transition" :class="showAllRooms ? 'rotate-180' : ''" />
          {{ showAllRooms ? t('adm.collapseRooms') : t('adm.showAllRooms', { count: filteredRooms.length }) }}
        </button>

        <div :class="card" class="space-y-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold">{{ t('adm.pins') }}</h3>
            <span class="text-[11px] text-slate-500">{{ t('adm.pinsHint') }}</span>
            <button @click="loadPins" :disabled="pinsLoading" class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': pinsLoading }" /></button>
          </div>
          <template v-if="pins">
            <div class="flex flex-wrap gap-1.5">
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
          <div class="flex flex-wrap items-center gap-2 text-xs">
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
        <!-- Idea sketches (fal.ai, functions/src/images.js); fixed during a study run, recorded with every sketch -->
        <div class="space-y-2 text-xs p-3 rounded-xl border border-slate-800">
          <h3 class="text-sm font-semibold">{{ t('adm.sketchTitle') }}</h3>
          <p class="text-[11px] text-slate-500">{{ t('adm.sketchHint') }}</p>
          <div class="grid sm:grid-cols-2 gap-3">
            <label class="space-y-1"><span class="text-slate-400">{{ t('adm.sketchModel') }}</span>
              <input v-model.trim="system.sketchModel" :class="[select, 'w-full font-mono']" />
            </label>
            <label class="space-y-1"><span class="text-slate-400">{{ t('adm.sketchRefineModel') }}</span>
              <input v-model.trim="system.sketchRefineModel" :class="[select, 'w-full font-mono']" />
            </label>
          </div>
        </div>
        <!-- Meshy detail (functions/src/mesh3d.js); fixed during a study run, recorded with every model -->
        <div v-if="system.engine3D === 'meshy'" class="space-y-2 text-xs p-3 rounded-xl border border-slate-800">
          <h3 class="text-sm font-semibold">{{ t('adm.meshyTitle') }}</h3>
          <p class="text-[11px] text-slate-500">{{ t('adm.meshyHint') }}</p>
          <div class="grid sm:grid-cols-2 gap-3">
            <label class="space-y-1"><span class="text-slate-400">{{ t('adm.meshyModel') }}</span>
              <select v-model="system.meshy.aiModel" :class="[select, 'w-full']">
                <option v-for="m in MESHY_MODELS" :key="m.id" :value="m.id">{{ t(m.label) }}</option>
              </select>
            </label>
            <label class="space-y-1"><span class="text-slate-400">{{ t('adm.meshyGeometry') }}</span>
              <select v-model="system.meshy.geometryResolution" :class="[select, 'w-full']" :disabled="system.meshy.aiModel !== 'meshy-7.1'">
                <option value="standard">{{ t('adm.meshyGeoStandard') }}</option>
                <option value="2k">{{ t('adm.meshyGeo2k') }}</option>
                <option value="4k">{{ t('adm.meshyGeo4k') }}</option>
              </select>
            </label>
          </div>
          <label class="flex items-start gap-2 pt-1">
            <input type="checkbox" v-model="system.meshy.autoRefine" class="mt-0.5" />
            <span><span class="text-slate-200">{{ t('adm.meshyAutoRefine') }}</span> <span class="block text-[11px] text-slate-500">{{ t('adm.meshyAutoRefineHint') }}</span></span>
          </label>
          <label class="flex items-start gap-2 pt-1">
            <input type="checkbox" v-model="system.meshy.imageTexture" class="mt-0.5" />
            <span><span class="text-slate-200">{{ t('adm.meshyImageTexture') }}</span> <span class="block text-[11px] text-slate-500">{{ t('adm.meshyImageTextureHint') }}</span></span>
          </label>
          <div class="grid sm:grid-cols-2 gap-3">
            <label class="space-y-1"><span class="text-slate-400">{{ t('adm.meshyTexture') }}</span>
              <select v-model="system.meshy.textureResolution" :class="[select, 'w-full']">
                <option value="2k">2K</option>
                <option value="4k" :disabled="system.meshy.aiModel === 'meshy-6-lite'">4K</option>
                <option value="8k" :disabled="system.meshy.aiModel === 'meshy-6-lite'">{{ t('adm.meshyTex8k') }}</option>
              </select>
            </label>
            <label class="flex items-center gap-2 sm:pt-5">
              <input type="checkbox" v-model="system.meshy.enablePbr" />
              <span class="text-slate-300">{{ t('adm.meshyPbr') }}</span>
            </label>
          </div>
          <p class="text-[11px] text-sky-300/80">{{ t('adm.meshyCost', { preview: meshyCost.preview, refine: meshyCost.refine }) }}</p>
        </div>
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.prices') }}</h3>
          <div v-for="m in MODEL_OPTIONS" :key="m" class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="w-full sm:w-40 font-mono text-slate-400 truncate">{{ m }}</span>
            {{ t('adm.priceIn') }} <input type="number" step="0.01" v-model.number="system.prices[m].inputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" />
            {{ t('adm.priceOut') }} <input type="number" step="0.01" v-model.number="system.prices[m].outputPerMTok" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /> {{ t('adm.perMTok') }}
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label>{{ t('adm.priceSearch') }} <input type="number" step="0.001" v-model.number="system.prices.webSearchPerUse" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>{{ t('adm.priceImage') }} <input type="number" step="0.001" v-model.number="system.prices.imagePerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
            <label>{{ t('adm.price3d') }} <input type="number" step="0.01" v-model.number="system.prices.model3DPerUnit" class="w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1" /></label>
          </div>
        </div>
        <!-- Message chime volume for every room and participant (composables/useNotificationSound.ts) -->
        <div class="space-y-1.5 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.volumeTitle') }}</h3>
          <div class="flex items-center gap-3">
            <input type="range" min="0" max="100" step="5" v-model.number="system.notificationVolume" class="flex-1 min-w-0 accent-sky-500 pointer-coarse:h-8" />
            <span class="w-10 text-right font-mono">{{ system.notificationVolume }}</span>
            <button type="button" @click="playChime(system.notificationVolume)" class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800">{{ t('adm.volumeTest') }}</button>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('adm.volumeHint') }}</p>
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
              <input v-model="apiDrafts[k.provider]" type="password" autocomplete="off" :placeholder="t('api.newKey')" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 font-mono" />
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
            <span class="font-mono text-slate-300 min-w-0 truncate">{{ a.email }}</span>
            <span class="text-[11px] text-slate-500">{{ fmtTime(a.addedAt) }}</span>
            <button v-if="authStore.isPrimaryAdmin" @click="changeAdmin(a.email, false)" :disabled="adminBusy" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">{{ t('adm.remove') }}</button>
          </div>
          <form v-if="authStore.isPrimaryAdmin" @submit.prevent="changeAdmin(adminEmail, true)" class="flex items-center gap-2">
            <input v-model="adminEmail" type="email" placeholder="name@gmail.com" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1.5" />
            <button :disabled="adminBusy || !adminEmail.trim()" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40">{{ t('adm.add') }}</button>
          </form>
        </div>
        <div class="space-y-2 text-xs">
          <h3 class="text-sm font-semibold">{{ t('adm.observers') }}</h3>
          <p class="text-[11px] text-slate-500">{{ t('adm.observersHint') }}</p>
          <div v-for="o in observers" :key="o.email" class="flex items-center gap-2">
            <span class="font-mono text-slate-300 min-w-0 truncate">{{ o.email }}</span>
            <span class="text-[11px] text-slate-500">{{ fmtTime(o.addedAt) }}</span>
            <button @click="changeObserver(o.email, false)" :disabled="observerBusy" class="ml-auto px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] disabled:opacity-40">{{ t('adm.remove') }}</button>
          </div>
          <p v-if="!observers.length" class="text-[11px] text-slate-500">{{ t('adm.noObservers') }}</p>
          <form @submit.prevent="changeObserver(observerEmail, true)" class="flex items-center gap-2">
            <input v-model="observerEmail" type="email" placeholder="name@gmail.com" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1.5" />
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

<style scoped>
/* Touch screens: every control at least 40px, checkboxes larger */
@media (pointer: coarse) {
  button, select, input:not([type='checkbox']), .adm-link { min-height: 2.5rem; }
  button { min-width: 2.5rem; }
}
</style>
