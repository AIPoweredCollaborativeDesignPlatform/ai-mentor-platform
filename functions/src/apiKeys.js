import { getFirestore } from 'firebase-admin/firestore';
import { createMessage } from './claude.js';
import { getSystemConfig } from './config.js';

/**
 * AI provider keys. Each key comes from a Functions secret (set with `firebase functions:secrets:set`),
 * and the administrator can override it from the admin page. Overrides live in privateConfig/apiKeys,
 * which has no Firestore rule and is therefore server-only; browsers only ever see the last 4 characters.
 */
export const PROVIDERS = ['anthropic', 'fal', 'meshy', 'tripo'];

const ref = () => getFirestore().doc('privateConfig/apiKeys');
const CACHE_MS = 30_000;
let cache = { at: 0, data: {} };

const usable = key => Boolean(key && key !== 'none');

async function overrides() {
  if (Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), data: (await ref().get()).data() || {} };
  return cache.data;
}

/** `secrets`: { provider: secret value }. Returns the key each provider should use (override first). */
export async function resolveKeys(secrets) {
  const o = await overrides().catch(() => ({}));
  return Object.fromEntries(PROVIDERS.map(p => [p, usable(o[p]?.key) ? o[p].key : secrets[p]]));
}

/** What the admin page shows: where each key comes from and its last 4 characters. */
export async function keyStatus(secrets) {
  const o = await overrides();
  return PROVIDERS.map(p => {
    const override = usable(o[p]?.key) ? o[p] : null;
    const key = override ? override.key : secrets[p];
    return {
      provider: p,
      source: override ? 'admin' : usable(secrets[p]) ? 'secret' : 'none',
      last4: usable(key) ? String(key).slice(-4) : '',
      updatedAt: override?.updatedAt || null,
      updatedBy: override?.updatedBy || null
    };
  });
}

/** Sets (or, with an empty key, removes) the admin override for one provider. */
export async function setKeyOverride(provider, key, by) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider');
  const value = String(key || '').trim();
  if (value.length > 500) throw new Error('Key too long');
  await ref().set({ [provider]: value ? { key: value, updatedAt: Date.now(), updatedBy: by } : null }, { merge: true });
  cache.at = 0;
}

const TEST_TIMEOUT_MS = 20_000;

async function timedFetch(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: the status code is enough
  }
  return { res, body };
}

const errorText = (res, body) => `HTTP ${res.status}${body?.message || body?.detail || body?.error ? `: ${String(body.message || body.detail?.toString?.() || body.error).slice(0, 160)}` : ''}`;

/** One lightweight authenticated request per provider; nothing is generated or billed (Claude: a few tokens). */
const TESTS = {
  async anthropic(key) {
    const sys = await getSystemConfig();
    const response = await createMessage(key, { model: sys.models.mentor, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] });
    return { ok: true, detail: sys.models.mentor, usage: response.usage ? `${response.usage.input_tokens}+${response.usage.output_tokens} tokens` : '' };
  },
  async fal(key) {
    // Status of a request id that does not exist: 401/403 means the key is refused, anything else that it was accepted
    const { res, body } = await timedFetch('https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status', { Authorization: `Key ${key}` });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: errorText(res, body) };
    return { ok: true, detail: 'key accepted' };
  },
  async meshy(key) {
    const { res, body } = await timedFetch('https://api.meshy.ai/openapi/v2/text-to-3d?page_size=1', { Authorization: `Bearer ${key}` });
    return res.ok ? { ok: true, detail: 'key accepted' } : { ok: false, detail: errorText(res, body) };
  },
  async tripo(key) {
    const { res, body } = await timedFetch('https://api.tripo3d.ai/v2/openapi/user/balance', { Authorization: `Bearer ${key}` });
    if (!res.ok || body?.code) return { ok: false, detail: errorText(res, body) };
    return { ok: true, detail: body?.data?.balance != null ? `balance ${body.data.balance}` : 'key accepted' };
  }
};

/** Tests the given providers (default: all) with the keys currently in use. */
export async function testProviders(secrets, only = PROVIDERS) {
  const keys = await resolveKeys(secrets);
  return Promise.all(only.filter(p => PROVIDERS.includes(p)).map(async provider => {
    if (!usable(keys[provider])) return { provider, ok: false, skipped: true, ms: 0, detail: 'no key' };
    const started = Date.now();
    try {
      const out = await TESTS[provider](keys[provider]);
      return { provider, ...out, ms: Date.now() - started };
    } catch (err) {
      return { provider, ok: false, ms: Date.now() - started, detail: String(err?.status ? `HTTP ${err.status}: ${err.message}` : err?.message || err).slice(0, 200) };
    }
  }));
}
