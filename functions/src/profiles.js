import { getFirestore } from 'firebase-admin/firestore';
import { getSystemConfig } from './config.js';

/**
 * Experiment condition profile. Stored in aiProfiles/{id} (edited from /#/admin, versioned);
 * a room keeps a frozen snapshot in roomAi/{roomId}.profile so later edits never affect it.
 * The timing values below are placeholders until literature-backed values are entered.
 */
export const DEFAULT_PROFILE = {
  name: 'Proactive (built-in default)',
  description: 'Fallback used when no profile has been assigned.',
  version: 0,
  mode: 'proactive', // 'none' | 'reactive' | 'proactive'
  language: 'zh-TW', // room language: participant UI, AI replies and system messages (src/i18n.js)
  shadowAssessment: true,
  displayName: { 'zh-TW': 'AI 導師', en: 'AI Mentor' },
  persona: 'A calm, neutral design mentor who supports the team\'s own decisions, keeps track of what was agreed, and speaks briefly.',
  triggers: {
    pauseSeconds: 8, // quiet time after the last message before an automatic check
    minNewMessages: 3, // new messages needed for a pause-triggered check
    maxMessagesBetweenChecks: 12, // forces a check during long uninterrupted discussion
    stallSeconds: 90, // silence after activity that counts as a stall
    cooldownSeconds: 180 // minimum gap between proactive interventions (Do et al. 2023 stepped in every 8 min; see _claude工作區/時間參數文獻.md)
  },
  memory: {
    updateEveryMessages: 15,
    updateOnWhiteboardShare: true
  },
  modules: {
    enable3D: true,
    enableMoodboard: true,
    enableFactRetrieval: true,
    enableSummary: true,
    enableWhiteboardAi: true
  },
  // Experiment flow (src/session.js): the session opens itself once expectedParticipants are online
  session: {
    expectedParticipants: 3,
    maxParticipants: 3, // simultaneous online participants (the researcher is not counted)
    // Both may be a plain string (older profiles) or { 'zh-TW', en }; the room language picks one
    openingText: '', // posted verbatim by the AI at the start
    taskDescription: '', // the design task; the AI opens the topic from it and keeps it in mind
    taskMinutes: 30, // 0 = no time limit (no reminders, no time-up message)
    reminderMinutes: [5] // minutes before the end at which the AI writes a reminder
  },
  // Chat tone: 1 formal ... 5 very casual; maxSentences caps every chat message (assets are not limited)
  style: { casualness: 4, maxSentences: 2 },
  // With a time limit, the first share of the time leans divergent (src/prompts.js pacing)
  facilitation: { divergeShare: 0.5 },
  // Overrides of src/prompts.js PROMPT_DEFAULTS, by block; empty = built-in text
  prompts: {},
  rationale: {}
};

const merge = (base, override) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
};

/** Profile document merged over defaults so older profiles gain new fields safely. */
export async function loadProfile(profileId) {
  if (!profileId) return { id: null, ...DEFAULT_PROFILE };
  const snap = await getFirestore().doc(`aiProfiles/${profileId}`).get();
  return snap.exists ? { id: profileId, ...merge(DEFAULT_PROFILE, snap.data()) } : { id: null, ...DEFAULT_PROFILE };
}

export async function loadDefaultProfile() {
  const sys = await getSystemConfig();
  return loadProfile(sys.defaultProfileId);
}

/** The only AI facts participants' browsers receive (rooms/{id}.ai): no mode, no persona, no condition id. */
export const publicAiView = profile => ({
  enabled: profile.mode !== 'none',
  displayName: profile.displayName,
  modules: profile.mode === 'none'
    ? { enable3D: false, enableMoodboard: false, enableFactRetrieval: false, enableSummary: false, enableWhiteboardAi: false }
    : profile.modules
});
