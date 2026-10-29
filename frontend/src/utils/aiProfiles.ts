// Client copy of the profile shape used by functions/src/profiles.js (keep the two in sync).
import { t, type MessageKey } from '../i18n';

export type AiMode = 'none' | 'reactive' | 'proactive';

export interface AiProfile {
  id?: string;
  name: string;
  description: string;
  version: number;
  mode: AiMode;
  /** Room language: participant UI, AI replies and system messages */
  language: 'zh-TW' | 'en';
  shadowAssessment: boolean;
  displayName: { 'zh-TW': string; en: string };
  persona: string;
  triggers: {
    pauseSeconds: number;
    minNewMessages: number;
    maxMessagesBetweenChecks: number;
    stallSeconds: number;
    cooldownSeconds: number;
  };
  memory: { updateEveryMessages: number; updateOnWhiteboardShare: boolean };
  modules: { enable3D: boolean; enableMoodboard: boolean; enableFactRetrieval: boolean; enableSummary: boolean; enableWhiteboardAi: boolean };
  /** Experiment flow (functions/src/session.js) */
  session: {
    expectedParticipants: number;
    maxParticipants: number;
    /** Per language; the room language picks one */
    openingText: Localized;
    taskDescription: Localized;
    /** 0 = no time limit */
    taskMinutes: number;
    /** Minutes before the end at which the AI writes a reminder */
    reminderMinutes: number[];
  };
  /** Optional basis / literature per field path, e.g. rationale['triggers.pauseSeconds'] */
  rationale: Record<string, string>;
  updatedAt?: number;
  updatedBy?: string;
}

export type Localized = { 'zh-TW': string; en: string };

export const MODES: AiMode[] = ['none', 'reactive', 'proactive'];
const MODE_KEYS: Record<AiMode, [MessageKey, MessageKey]> = {
  none: ['mode.none', 'mode.noneShort'],
  reactive: ['mode.reactive', 'mode.reactiveShort'],
  proactive: ['mode.proactive', 'mode.proactiveShort']
};
export const modeLabel = (mode: AiMode, short = false) => t(MODE_KEYS[mode]?.[short ? 1 : 0] || 'mode.proactive');

const base = (): AiProfile => ({
  name: '',
  description: '',
  version: 0,
  mode: 'proactive',
  language: 'zh-TW',
  shadowAssessment: true,
  displayName: { 'zh-TW': 'AI 導師', en: 'AI Mentor' },
  persona: 'A calm, neutral design mentor who supports the team\'s own decisions, keeps track of what was agreed, and speaks briefly.',
  triggers: { pauseSeconds: 8, minNewMessages: 3, maxMessagesBetweenChecks: 12, stallSeconds: 90, cooldownSeconds: 180 },
  memory: { updateEveryMessages: 15, updateOnWhiteboardShare: true },
  modules: { enable3D: true, enableMoodboard: true, enableFactRetrieval: true, enableSummary: true, enableWhiteboardAi: true },
  session: { expectedParticipants: 3, maxParticipants: 3, openingText: { 'zh-TW': '', en: '' }, taskDescription: { 'zh-TW': '', en: '' }, taskMinutes: 30, reminderMinutes: [5] },
  rationale: {}
});

export const newProfile = (overrides: Partial<AiProfile> = {}): AiProfile => ({ ...base(), ...overrides });

/** Profiles saved before a field existed get its default (mirrors the server-side merge). */
// Older profiles stored one opening text / task description for both languages
const localizedOf = (v: unknown): Localized => {
  if (typeof v === 'string') return { 'zh-TW': v, en: v };
  const l = (v || {}) as Partial<Localized>;
  return { 'zh-TW': l['zh-TW'] || '', en: l.en || '' };
};
export const withDefaults = (p: AiProfile): AiProfile => {
  const session = { ...base().session, ...(p.session || {}) };
  return { ...base(), ...p, session: { ...session, openingText: localizedOf(session.openingText), taskDescription: localizedOf(session.taskDescription) } };
};

/** Starting set for a study; timing values are placeholders until set from the literature. */
export const SEED_PROFILES: AiProfile[] = [
  newProfile({ name: '無 AI 對照', description: '參與者完全看不到 AI；背景影子判斷仍記錄「AI 會在何時介入」。', mode: 'none' }),
  newProfile({ name: 'Reactive', description: 'DIS 條件 A：只在被 @ 時回應，其餘為影子判斷。', mode: 'reactive' }),
  newProfile({ name: 'Proactive', description: 'DIS 條件 B：依對話狀態主動介入。', mode: 'proactive' })
];

export interface FieldMeta {
  path: string;
  label: MessageKey;
  unit?: MessageKey;
  help: MessageKey;
  min?: number;
  max?: number;
}

export const TIMING_FIELDS: FieldMeta[] = [
  { path: 'triggers.pauseSeconds', label: 'field.pause', unit: 'unit.seconds', help: 'field.pauseHelp', min: 0, max: 120 },
  { path: 'triggers.minNewMessages', label: 'field.minNew', unit: 'unit.messages', help: 'field.minNewHelp', min: 1, max: 50 },
  { path: 'triggers.maxMessagesBetweenChecks', label: 'field.maxBetween', unit: 'unit.messages', help: 'field.maxBetweenHelp', min: 0, max: 100 },
  { path: 'triggers.stallSeconds', label: 'field.stall', unit: 'unit.seconds', help: 'field.stallHelp', min: 0, max: 600 },
  { path: 'triggers.cooldownSeconds', label: 'field.cooldown', unit: 'unit.seconds', help: 'field.cooldownHelp', min: 0, max: 900 },
  { path: 'memory.updateEveryMessages', label: 'field.memory', unit: 'unit.messages', help: 'field.memoryHelp', min: 0, max: 200 }
];

export const getPath = (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj);
export const setPath = (obj: any, path: string, value: unknown) => {
  const keys = path.split('.');
  const last = keys.pop()!;
  keys.reduce((o, k) => (o[k] ||= {}), obj)[last] = value;
};

// ---------- Cost estimate ----------
export interface Prices {
  [model: string]: any;
  webSearchPerUse: number;
  imagePerUnit: number;
  model3DPerUnit: number;
}

export interface CostInputs {
  sessionMinutes: number;
  messagesPerMinute: number;
  mentionsPerSession: number;
  /** AI polls that reach a majority; each one makes the AI follow up (engine.js handlePollVote) */
  settledPollsPerSession: number;
  stallsPerSession: number;
  moodboardsPerSession: number;
  models3DPerSession: number;
  webSearchesPerSession: number;
  sessions: number;
  checkInputTokens: number;
  checkOutputTokens: number;
  memoryInputTokens: number;
  memoryOutputTokens: number;
}

export const DEFAULT_COST_INPUTS: CostInputs = {
  sessionMinutes: 35,
  messagesPerMinute: 4,
  mentionsPerSession: 6,
  settledPollsPerSession: 3,
  stallsPerSession: 3,
  moodboardsPerSession: 1,
  models3DPerSession: 1,
  webSearchesPerSession: 3,
  sessions: 40,
  checkInputTokens: 7000,
  checkOutputTokens: 800,
  memoryInputTokens: 4000,
  memoryOutputTokens: 700
};

const tokenCost = (prices: Prices, model: string, input: number, output: number) => {
  const p = prices[model] || { inputPerMTok: 0, outputPerMTok: 0 };
  return (input * p.inputPerMTok + output * p.outputPerMTok) / 1_000_000;
};

/**
 * Rough per-session estimate. Automatic checks are bounded by the pause rule (at most one per
 * minNewMessages messages) and the max-messages rule; shadow checks cost the same as visible ones.
 */
export function estimateCost(profile: AiProfile, inputs: CostInputs, prices: Prices, models: { mentor: string; memory: string }) {
  const messages = inputs.sessionMinutes * inputs.messagesPerMinute;
  const runsChecks = profile.mode === 'proactive' || profile.shadowAssessment;
  const t = profile.triggers;
  const autoChecks = runsChecks ? Math.ceil(messages / Math.max(1, t.minNewMessages)) + (t.stallSeconds ? inputs.stallsPerSession : 0) : 0;
  const mentionChecks = profile.mode === 'none' ? 0 : inputs.mentionsPerSession + (inputs.settledPollsPerSession || 0);
  const checks = autoChecks + mentionChecks;
  const memoryUpdates = profile.memory.updateEveryMessages ? Math.floor(messages / profile.memory.updateEveryMessages) : 0;
  const visibleAssets = profile.mode === 'none' ? 0 : 1;

  const parts = {
    checks: checks * tokenCost(prices, models.mentor, inputs.checkInputTokens, inputs.checkOutputTokens),
    memory: memoryUpdates * tokenCost(prices, models.memory, inputs.memoryInputTokens, inputs.memoryOutputTokens),
    webSearch: visibleAssets * inputs.webSearchesPerSession * (prices.webSearchPerUse || 0),
    images: visibleAssets * inputs.moodboardsPerSession * 4 * (prices.imagePerUnit || 0),
    models3D: visibleAssets * inputs.models3DPerSession * (prices.model3DPerUnit || 0)
  };
  const perSession = Object.values(parts).reduce((a, b) => a + b, 0);
  return { messages, checks, memoryUpdates, parts, perSession, total: perSession * inputs.sessions };
}
