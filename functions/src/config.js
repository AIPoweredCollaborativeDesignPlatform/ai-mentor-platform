import { getFirestore } from 'firebase-admin/firestore';

// Defaults used when config/system has no override. Editable later from the observer panel.
// Keep models fixed during an experiment run: every AI message records the model that produced it.
export const DEFAULT_SYSTEM_CONFIG = {
  models: {
    mentor: 'claude-haiku-5-5',
    vision: 'claude-haiku-5-5',
    svg: 'claude-sonnet-5-5'
  },
  mentorEffort: 'low',
  // Basic web search works on every current model; the 20260209 variant needs Sonnet/Opus
  webSearchTool: 'web_search_20250305',
  webSearchMaxUses: 3,
  imageModel: 'fal-ai/flux/schnell',
  engine3D: 'meshy'
};

let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

const merge = (base, override) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
};

export async function getSystemConfig() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const snap = await getFirestore().doc('config/system').get().catch(() => null);
  cached = merge(DEFAULT_SYSTEM_CONFIG, snap?.exists ? snap.data() : {});
  cachedAt = Date.now();
  return cached;
}
