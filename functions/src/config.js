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
  engine3D: 'meshy',
  // Only for Anthropic keys not scoped to a workspace (Console > Settings > Workspaces > ID)
  anthropicWorkspaceId: null,
  // Profile snapshotted into new rooms (aiProfiles/{id}); null = built-in DEFAULT_PROFILE
  defaultProfileId: null,
  memoryModel: 'claude-haiku-5-5',
  // USD, editable from /#/admin for the cost estimator (prices change; verify against vendor pages)
  prices: {
    'claude-haiku-5-5': { inputPerMTok: 0.10, outputPerMTok: 0.50 },
    'claude-sonnet-5-5': { inputPerMTok: 2.00, outputPerMTok: 10.00 },
    'claude-opus-5-5': { inputPerMTok: 4.00, outputPerMTok: 20.00 },
    webSearchPerUse: 0.01,
    imagePerUnit: 0.003,
    model3DPerUnit: 0
  }
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
