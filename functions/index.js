import { Readable } from 'node:stream';
import { initializeApp } from 'firebase-admin/app';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentDeleted, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getSystemConfig } from './src/config.js';
import { classifyError, createMessage, extractSvg, imageBlockFromDataUrl, parseJsonObject, responseText } from './src/claude.js';
import { PROFILE_DRAFT_PROMPT, PROMPT_DEFAULTS, PROMPT_PLACEHOLDERS, PROMPT_VERSION, sketchToSvgPrompt, textToSvgPrompt, visionPrompt } from './src/prompts.js';
import { refineMeshy } from './src/mesh3d.js';
import { refineSketch } from './src/images.js';
import { logAiCall } from './src/log.js';
import { FRIENDLY_ERRORS } from './src/mentor.js';
import { assignProfileToRoom, ensureRoomAi, handleNewMessage, handlePollVote, handleSuggestionAnswer, loadProfile, postAiMessage, runCheck } from './src/engine.js';
import { endSession, joinRoom, maybeStartSession, reopenSession, runSessionJob, sessionTick } from './src/session.js';
import { logBoardObjectChange, logMessageChange } from './src/events.js';
import { authUrl, exportRoom, handleCallback, runDueExports } from './src/drive.js';
import { createRoom, listPins, markRoomDeleted, revertAutoRoomName, updateMyProfile, updateRoomDetails } from './src/rooms.js';
import { consentTextFor, roomLanguage, str } from './src/i18n.js';
import { keyStatus, resolveKeys, setKeyOverride, testProviders } from './src/apiKeys.js';
import { claimAnonymousRooms, isAdminToken, isObserverToken, isPrimaryAdminToken, listAdmins, listObservers, setAdmin, setObserver, syncRole } from './src/roles.js';

initializeApp();

// Set with `firebase functions:secrets:set <NAME>`; unused providers can be set to "none"
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const FAL_KEY = defineSecret('FAL_KEY');
const MESHY_API_KEY = defineSecret('MESHY_API_KEY');
const TRIPO_API_KEY = defineSecret('TRIPO_API_KEY');
// OAuth client (Google Cloud Console → Credentials) used to upload research data to the admin's Drive
const GOOGLE_OAUTH_CLIENT_ID = defineSecret('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret('GOOGLE_OAUTH_CLIENT_SECRET');
const oauthSecrets = () => ({ clientId: GOOGLE_OAUTH_CLIENT_ID.value(), clientSecret: GOOGLE_OAUTH_CLIENT_SECRET.value() });

const requireAuth = request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in (guest is fine) to use AI features.');
};

/**
 * AI endpoints cost money per call and anyone can get a guest account: the caller must be the room's
 * host, an approved participant, or study staff. Returns the room document.
 */
const requireRoomMember = async request => {
  requireAuth(request);
  const roomId = String(request.data?.roomId || '');
  if (!/^room_\d{4,6}$/.test(roomId)) throw new HttpsError('invalid-argument', 'Missing roomId');
  const db = getFirestore();
  const [roomSnap, me] = await Promise.all([db.doc(`rooms/${roomId}`).get(), db.doc(`rooms/${roomId}/participants/${request.auth.uid}`).get()]);
  const room = roomSnap.data();
  if (!room) throw new HttpsError('not-found', 'Room not found');
  if (room.hostUid !== request.auth.uid && me.data()?.status !== 'approved' && !isObserverToken(request.auth.token)) {
    throw new HttpsError('permission-denied', 'Room members only');
  }
  return room;
};

/** Prompt overrides of the profile frozen into the room (roomAi/{roomId}.profile.prompts). */
const roomPrompts = async roomId => (await getFirestore().doc(`roomAi/${roomId}`).get()).data()?.profile?.prompts || {};

const toHttpsError = (err, label) => {
  const category = classifyError(err);
  console.error(`[${label}] ${category}:`, err?.message || err);
  return new HttpsError('internal', FRIENDLY_ERRORS[category], { category });
};

/** Log entry shared by the smaller AI endpoints (images are recorded by size only). */
const baseLog = (request, kind, model) => ({
  kind,
  roomId: request.data?.roomId || null,
  callerUid: request.auth?.uid || null,
  model,
  promptVersion: PROMPT_VERSION
});

const meta = (model, response) => ({
  model,
  promptVersion: PROMPT_VERSION,
  usage: response?.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null
});

// ---------- AI Mentor (server-side activity manager; see src/engine.js) ----------
// Keys in use: an override set on the admin page (src/apiKeys.js), else the Functions secret.
// Only functions that mount ALL_SECRETS may read every secret.
const secretValues = () => ({
  anthropic: ANTHROPIC_API_KEY.value(),
  fal: FAL_KEY.value(),
  meshy: MESHY_API_KEY.value(),
  tripo: TRIPO_API_KEY.value()
});
const engineSecrets = () => resolveKeys(secretValues());
const anthropicKey = async () => (await resolveKeys({ anthropic: ANTHROPIC_API_KEY.value() })).anthropic;
const ALL_SECRETS = [ANTHROPIC_API_KEY, FAL_KEY, MESHY_API_KEY, TRIPO_API_KEY];

// Handlers may wait up to stallSeconds for a pause/stall; concurrency lets waits share instances
export const onRoomMessage = onDocumentCreated(
  { document: 'rooms/{roomId}/messages/{messageId}', secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '512MiB', cpu: 1, concurrency: 80, maxInstances: 20 },
  async event => {
    const msg = event.data?.data();
    if (!msg) return;
    await handleNewMessage(event.params.roomId, event.params.messageId, msg, await engineSecrets());
  }
);

// Answers to the AI's polls and suggestion cards: a settled poll or an accepted offer makes the AI follow up
// (engine.js handlePollVote / handleSuggestionAnswer)
export const onPollVote = onDocumentUpdated(
  { document: 'rooms/{roomId}/messages/{messageId}', secrets: ALL_SECRETS, timeoutSeconds: 300, memory: '512MiB', cpu: 1, concurrency: 80, maxInstances: 10 },
  async event => {
    const { roomId, messageId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (after?.suggestion) return handleSuggestionAnswer(roomId, messageId, before, after, await engineSecrets());
    return handlePollVote(roomId, messageId, before, after, await engineSecrets());
  }
);

// New rooms from this site get the default profile snapshot immediately
export const onRoomCreated = onDocumentCreated({ document: 'rooms/{roomId}', maxInstances: 10 }, async event => {
  if (event.data?.data()?.appVersion) await ensureRoomAi(event.params.roomId);
});

/** Explicit request from the UI (e.g. Retry on a failed reply): runs a forced check server-side. */
export const mentorRespond = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '512MiB', maxInstances: 20 },
  async request => {
    await requireRoomMember(request);
    const { roomId, retryMessageId = null } = request.data || {};
    // A retry may only replace an AI message
    if (retryMessageId) {
      const target = (await getFirestore().doc(`rooms/${roomId}/messages/${String(retryMessageId)}`).get()).data();
      if (target?.senderUid !== 'ai_mentor') throw new HttpsError('invalid-argument', 'Not an AI message');
    }
    await runCheck(roomId, await engineSecrets(), { reason: 'retry', forced: true, callerUid: request.auth.uid, retryMessageId });
    return { ok: true };
  }
);

// ---------- Study administration ----------
const requireAdmin = request => {
  if (!isAdminToken(request.auth?.token)) throw new HttpsError('permission-denied', 'Study administrator only');
};

// ---------- Roles (src/roles.js) ----------
/** Brings the caller's role claim in line with the lists; the browser refreshes its token when changed. */
export const syncMyRole = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  return syncRole(request.auth.uid, request.auth.token);
});

export const listStudyObservers = onCall({ maxInstances: 2 }, async request => {
  requireAdmin(request);
  return { observers: await listObservers() };
});

export const setStudyObserver = onCall({ maxInstances: 2 }, async request => {
  requireAdmin(request);
  const { email, add } = request.data || {};
  try {
    return await setObserver(email, add !== false, request.auth.token.email);
  } catch (err) {
    throw new HttpsError('invalid-argument', err?.message || String(err));
  }
});

// ---------- AI provider keys (src/apiKeys.js) ----------
export const getApiKeyStatus = onCall({ secrets: ALL_SECRETS, maxInstances: 2 }, async request => {
  requireAdmin(request);
  return { keys: await keyStatus(secretValues()) };
});

/** Empty `key` removes the admin override (the Functions secret is used again). */
export const setApiKey = onCall({ secrets: ALL_SECRETS, maxInstances: 2 }, async request => {
  requireAdmin(request);
  const { provider, key } = request.data || {};
  try {
    await setKeyOverride(String(provider || ''), key, request.auth.token.email);
  } catch (err) {
    throw new HttpsError('invalid-argument', err?.message || String(err));
  }
  return { keys: await keyStatus(secretValues()) };
});

export const testApiKeys = onCall({ secrets: ALL_SECRETS, timeoutSeconds: 60, maxInstances: 2 }, async request => {
  requireAdmin(request);
  const only = Array.isArray(request.data?.providers) && request.data.providers.length ? request.data.providers.map(String) : undefined;
  return { results: await testProviders(secretValues(), only) };
});

// Additional administrators: any administrator can see the list, only the primary one can change it
export const listStudyAdmins = onCall({ maxInstances: 2 }, async request => {
  requireAdmin(request);
  return { admins: await listAdmins() };
});

export const setStudyAdmin = onCall({ maxInstances: 2 }, async request => {
  if (!isPrimaryAdminToken(request.auth?.token)) throw new HttpsError('permission-denied', 'Primary administrator only');
  const { email, add } = request.data || {};
  try {
    return await setAdmin(email, add !== false, request.auth.token.email);
  } catch (err) {
    throw new HttpsError('invalid-argument', err?.message || String(err));
  }
});

/** After a guest signs in with Google: moves rooms the guest account hosted to the Google account. */
export const claimGuestRooms = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  try {
    return await claimAnonymousRooms(request.auth.uid, request.data?.anonIdToken);
  } catch (err) {
    throw new HttpsError('permission-denied', err?.message || String(err));
  }
});

/** Whether a room exists and its name, for the join pages (room documents are readable by members only). */
export const peekStudyRoom = onCall({ maxInstances: 20 }, async request => {
  requireAuth(request);
  const roomId = String(request.data?.roomId || '');
  if (!/^room_\d{4,6}$/.test(roomId)) return { exists: false };
  const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data();
  if (!room || room.deletedAt) return { exists: false };
  // The join page shows the consent text in the room language
  const language = roomLanguage(room.language);
  return { exists: true, roomName: room.roomName || '', isHost: room.hostUid === request.auth.uid, language, consentText: consentTextFor(await getSystemConfig(), language) };
});

/** Assigns (or re-assigns) a condition profile to a room; the room keeps a frozen snapshot. */
export const assignRoomProfile = onCall({ maxInstances: 5 }, async request => {
  requireAdmin(request);
  const { roomId, profileId } = request.data || {};
  if (!roomId || !profileId) throw new HttpsError('invalid-argument', 'Missing roomId or profileId');
  const profile = await loadProfile(profileId);
  if (!profile.id) throw new HttpsError('not-found', 'Profile not found');
  await assignProfileToRoom(roomId, profile, request.auth.token.email);
  await maybeStartSession(roomId);
  return { profileId: profile.id, profileVersion: profile.version };
});

// ---------- Rooms and PINs (src/rooms.js) ----------
/** Every new room: a random never-used PIN. Administrator and observers may pick the condition or join as a participant. */
export const createStudyRoom = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  const d = request.data || {};
  const observer = isObserverToken(request.auth.token);
  if (d.profileId && !observer) throw new HttpsError('permission-denied', 'Study staff only');
  // Only study staff can create a room as its invisible host; everyone else takes part in their own room
  const asParticipant = observer ? d.asParticipant === true : true;
  try {
    return await createRoom(request.auth.uid, { ...d, asParticipant, profileId: d.profileId || null }, request.auth.token.email || request.auth.uid);
  } catch (err) {
    throw new HttpsError('internal', err?.message || String(err));
  }
});

export const onRoomDeleted = onDocumentDeleted({ document: 'rooms/{roomId}', maxInstances: 5 }, event => markRoomDeleted(event.params.roomId));

const ROOM_ID = /^room_\d{4,6}$/;

/** Name/avatar change inside a room (announces it to the chat for participants). */
export const updateRoomProfile = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  const roomId = String(request.data?.roomId || '');
  if (!ROOM_ID.test(roomId)) throw new HttpsError('invalid-argument', 'Missing roomId');
  try {
    return await updateMyProfile(roomId, request.auth.uid, request.data || {});
  } catch (err) {
    throw new HttpsError('permission-denied', err?.message || String(err));
  }
});

/** Room name/emoji change by the host (announced to the chat). */
export const updateStudyRoomDetails = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  const roomId = String(request.data?.roomId || '');
  if (!ROOM_ID.test(roomId)) throw new HttpsError('invalid-argument', 'Missing roomId');
  try {
    return await updateRoomDetails(roomId, request.auth.uid, isAdminToken(request.auth.token), request.data || {});
  } catch (err) {
    throw new HttpsError('permission-denied', err?.message || String(err));
  }
});

/** "Change back" under the AI's automatic room name (src/rooms.js revertAutoRoomName). */
export const revertRoomName = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  const roomId = String(request.data?.roomId || '');
  const messageId = String(request.data?.messageId || '');
  if (!ROOM_ID.test(roomId) || !messageId) throw new HttpsError('invalid-argument', 'Missing roomId or messageId');
  try {
    return await revertAutoRoomName(roomId, messageId, request.auth.uid, isObserverToken(request.auth.token));
  } catch (err) {
    throw new HttpsError('permission-denied', err?.message || String(err));
  }
});

/** Admin room list "Delete": marks the room deleted (it leaves the lists and can no longer be joined);
 *  messages, boards, logs and the Drive export are kept for the study. A running session must be ended first. */
export const adminDeleteRoom = onCall({ maxInstances: 2 }, async request => {
  requireAdmin(request);
  const roomId = String(request.data?.roomId || '');
  if (!ROOM_ID.test(roomId)) throw new HttpsError('invalid-argument', 'Missing roomId');
  const ref = getFirestore().doc(`rooms/${roomId}`);
  const room = (await ref.get()).data();
  if (!room) throw new HttpsError('not-found', 'Room not found');
  if (room.session?.phase === 'running') throw new HttpsError('failed-precondition', 'End the session first');
  await ref.update({ deletedAt: Date.now(), deletedBy: request.auth.token.email });
  return { ok: true };
});

export const listRoomPins = onCall({ maxInstances: 2 }, async request => {
  if (!isObserverToken(request.auth?.token)) throw new HttpsError('permission-denied', 'Study staff only');
  return listPins();
});

/** Who created each room: the Google account (email) or an anonymous guest. Study staff only. */
export const listRoomCreators = onCall({ maxInstances: 2 }, async request => {
  if (!isObserverToken(request.auth?.token)) throw new HttpsError('permission-denied', 'Study staff only');
  const roomIds = (Array.isArray(request.data?.roomIds) ? request.data.roomIds : []).map(String).filter(id => /^room_\d{4,6}$/.test(id)).slice(0, 100);
  const db = getFirestore();
  const rooms = await Promise.all(roomIds.map(async id => [id, (await db.doc(`rooms/${id}`).get()).data()]));
  const uidOf = room => room?.createdBy || room?.hostUid || '';
  const uids = [...new Set(rooms.map(([, r]) => uidOf(r)).filter(Boolean))];
  const users = uids.length ? (await getAuth().getUsers(uids.map(uid => ({ uid })))).users : [];
  const byUid = new Map(users.map(u => [u.uid, u]));
  return Object.fromEntries(rooms.map(([id, r]) => {
    const u = byUid.get(uidOf(r));
    return [id, { email: u?.email || null, anonymous: Boolean(u) && !u.email, unknown: !u }];
  }));
});

/** Built-in prompt blocks for the admin editor (profiles store only the blocks they override). */
export const getPromptDefaults = onCall({ maxInstances: 2 }, async request => {
  requireAdmin(request);
  return { version: PROMPT_VERSION, defaults: PROMPT_DEFAULTS, placeholders: PROMPT_PLACEHOLDERS };
});

/** Profile editor: fills name, persona, expertise and tone from one sentence; the admin reviews before saving. */
const placeholdersOf = s => [...new Set(String(s).match(/\{\{\w+\}\}/g) || [])].sort().join(',');
const samePlaceholders = (a, b) => placeholdersOf(a) === placeholdersOf(b);
// Chinese text gets full-width punctuation even if the model slips (only next to CJK, so 3.5 or URLs stay intact)
const CJK = '[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]';
const FULL = { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；', '(': '（', ')': '）' };
const toFull = text => String(text)
  .replace(new RegExp(`(${CJK})[ \t]*([,.?!:;)])`, 'g'), (_, c, p) => c + FULL[p])
  .replace(new RegExp(`([,?!:;(])[ \t]*(?=${CJK})`, 'g'), (_, p) => FULL[p])
  .replace(new RegExp(`"(?=${CJK})([^"]*?)"`, 'g'), '「$1」');
// Twice, so runs like "）!" are caught too
const fullWidth = text => toFull(toFull(text));
const localizedPair = v => ({ 'zh-TW': fullWidth(String(v?.['zh-TW'] || '').slice(0, 2000)), en: String(v?.en || '').slice(0, 2000) });
const DRAFT_MODEL = 'claude-sonnet-5-5';
// Blocks the one-sentence fill may rewrite in the character's voice; the rest (format, rules for assets) stays built-in
const DRAFT_BLOCKS = ['role', 'designThinking', 'style', 'sessionMessage', 'sessionKickoff', 'sessionKickoffTopics', 'sessionReminder', 'sessionTimeUp'];

export const draftAiProfile = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, maxInstances: 2 }, async request => {
  requireAdmin(request);
  const text = String(request.data?.text || '').trim().slice(0, 500);
  if (!text) throw new HttpsError('invalid-argument', 'Describe the AI in one sentence.');
  const wantTask = request.data?.taskMode !== 'ai_suggest';
  // Fixed and independent of the mentor model, which must stay unchanged during a study run
  const model = DRAFT_MODEL;
  try {
    const response = await createMessage(await anthropicKey(), {
      model,
      max_tokens: 12000,
      output_config: { effort: 'medium' },
      system: PROFILE_DRAFT_PROMPT,
      messages: [{ role: 'user', content: `Character: ${text}\n\n${wantTask ? 'Write a task brief (taskDescription).' : 'No task brief (taskDescription stays empty).'}\n\nBlocks to rewrite (JSON, key -> current text):\n${JSON.stringify(Object.fromEntries(DRAFT_BLOCKS.map(k => [k, PROMPT_DEFAULTS[k]])), null, 1)}` }]
    });
    const out = parseJsonObject(responseText(response));
    const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
    const draft = {
      displayName: { 'zh-TW': fullWidth(String(out.displayName?.['zh-TW'] || '').slice(0, 30)), en: String(out.displayName?.en || '').slice(0, 30) },
      persona: String(out.persona || '').slice(0, 1500),
      expertise: String(out.expertise || '').slice(0, 200),
      casualness: clamp(out.casualness, 1, 5, 3),
      maxSentences: clamp(out.maxSentences, 1, 8, 2),
      openingText: localizedPair(out.openingText),
      taskDescription: wantTask ? localizedPair(out.taskDescription) : { 'zh-TW': '', en: '' },
      // A rewritten block is kept only if it uses exactly the built-in placeholders
      prompts: Object.fromEntries(DRAFT_BLOCKS
        .filter(k => typeof out.prompts?.[k] === 'string' && out.prompts[k].trim() && samePlaceholders(out.prompts[k], PROMPT_DEFAULTS[k]))
        .map(k => [k, out.prompts[k].trim().slice(0, 6000)]))
    };
    await logAiCall({ kind: 'profile_draft', uid: request.auth.uid, model, promptVersion: PROMPT_VERSION, input: { text }, output: { draft } });
    return draft;
  } catch (err) {
    await logAiCall({ kind: 'profile_draft', uid: request.auth.uid, model, input: { text }, error: { message: String(err?.message || err).slice(0, 500) } });
    throw toHttpsError(err, 'draftAiProfile');
  }
});

// ---------- Experiment flow (src/session.js) ----------
export const joinStudyRoom = onCall({ maxInstances: 20 }, async request => {
  requireAuth(request);
  const { roomId, displayName, avatar, consent, retry, asParticipant, viewOnly } = request.data || {};
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
  return joinRoom({
    roomId: String(roomId), uid: request.auth.uid, displayName, avatar, consent: consent === true, retry: retry === true,
    observer: isObserverToken(request.auth.token), asParticipant: asParticipant === true, viewOnly: viewOnly === true
  });
});

/** End button: the room's researcher (host) or the study administrator. */
export const endStudySession = onCall({ maxInstances: 10 }, async request => {
  requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
  const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data();
  if (!room) throw new HttpsError('not-found', 'Room not found');
  const token = request.auth.token;
  if (room.hostUid !== request.auth.uid && !isAdminToken(token)) {
    throw new HttpsError('permission-denied', 'Only the researcher can end the session');
  }
  return { ended: await endSession(roomId, room.hostUid === request.auth.uid ? 'researcher' : 'admin') };
});

// Session timing every minute, then due Drive exports (src/drive.js)
/**
 * Reopen an ended room: the room's researcher (host) or the study administrator; in a room created
 * by a participant (no researcher), also any approved participant.
 */
export const reopenStudySession = onCall({ maxInstances: 5 }, async request => {
  requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
  const db = getFirestore();
  const room = (await db.doc(`rooms/${roomId}`).get()).data();
  if (!room) throw new HttpsError('not-found', 'Room not found');
  const token = request.auth.token;
  const isResearcher = Boolean(room.hostUid) && room.hostUid === request.auth.uid;
  let by = isResearcher ? 'researcher' : 'admin';
  if (!isResearcher && !isAdminToken(token)) {
    const me = room.hostUid ? null : (await db.doc(`rooms/${roomId}/participants/${request.auth.uid}`).get()).data();
    if (me?.status !== 'approved') throw new HttpsError('permission-denied', 'Only the researcher can reopen the session');
    by = 'participant';
  }
  return { reopened: await reopenSession(String(roomId), by) };
});

export const sessionClock = onSchedule(
  { schedule: 'every 1 minutes', timeoutSeconds: 540, memory: '512MiB', maxInstances: 1, secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET] },
  async () => {
    await sessionTick();
    await runDueExports(oauthSecrets());
  }
);

// ---------- Google Drive export (src/drive.js) ----------
export const driveAuthUrl = onCall({ maxInstances: 2, secrets: [GOOGLE_OAUTH_CLIENT_ID] }, async request => {
  requireAdmin(request);
  return { url: await authUrl(GOOGLE_OAUTH_CLIENT_ID.value(), request.auth.token.email) };
});

/** OAuth redirect target, served at /api/drive/callback through a Hosting rewrite. */
export const driveOAuthCallback = onRequest(
  { invoker: 'public', maxInstances: 2, secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET] },
  async (req, res) => {
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
      + `<body style="font-family:system-ui;background:#020617;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0">`
      + `<div style="max-width:28rem;padding:2rem;text-align:center"><h1 style="font-size:1.2rem">${title}</h1><p style="color:#94a3b8">${text}</p>`
      + `<a href="/#/admin" style="color:#38bdf8">Back to admin</a></div></body>`;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    try {
      const { requeued } = await handleCallback({ code: String(req.query.code || ''), state: String(req.query.state || ''), error: req.query.error }, oauthSecrets());
      res.status(200).send(page('Google Drive connected', `Research data will be uploaded automatically.${requeued ? ` ${requeued} waiting room(s) were queued again.` : ''}`));
    } catch (err) {
      console.error('[driveOAuthCallback]', err?.message || err);
      res.status(400).send(page('Could not connect Google Drive', esc(err?.message || err)));
    }
  }
);

/** Manual upload button in /#/admin (also used to re-upload a room). */
export const exportRoomNow = onCall(
  { timeoutSeconds: 540, memory: '512MiB', maxInstances: 3, secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET] },
  async request => {
    requireAdmin(request);
    const { roomId } = request.data || {};
    if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
    return exportRoom(String(roomId), oauthSecrets(), { manual: true });
  }
);

export const onSessionJob = onDocumentCreated(
  { document: 'sessionJobs/{jobId}', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, maxInstances: 10 },
  async event => {
    const job = event.data?.data();
    if (job) await runSessionJob(job, { anthropic: await anthropicKey() });
  }
);

// ---------- Research event log (src/events.js) ----------
export const logMessageEvent = onDocumentWritten({ document: 'rooms/{roomId}/messages/{messageId}', maxInstances: 20 }, event =>
  logMessageChange(event.params.roomId, event.params.messageId, event.data?.before?.data(), event.data?.after?.data())
);

export const logBoardEvent = onDocumentWritten({ document: 'rooms/{roomId}/boards/{boardId}/objects/{objectId}', maxInstances: 20 }, event =>
  logBoardObjectChange(event.params.roomId, event.params.boardId, event.params.objectId, event.data?.before?.data(), event.data?.after?.data())
);

export const whiteboardVision = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 20 },
  async request => {
    await requireRoomMember(request);
    const sys = await getSystemConfig();
    const prompts = await roomPrompts(request.data.roomId);
    try {
      const response = await createMessage(await anthropicKey(), {
        model: sys.models.vision,
        max_tokens: 1000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(request.data?.imageDataUrl), { type: 'text', text: visionPrompt(prompts) }] }]
      });
      const summary = responseText(response).trim();
      await logAiCall({
        ...baseLog(request, 'whiteboard_vision', sys.models.vision),
        input: { imageBytes: String(request.data?.imageDataUrl || '').length, assetId: request.data?.assetId || null },
        output: { summary },
        usage: meta(sys.models.vision, response).usage
      });
      return { summary, meta: meta(sys.models.vision, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'whiteboard_vision', sys.models.vision), error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'whiteboardVision');
    }
  }
);

// ---------- Whiteboard drawing -> clean sketch and render (fal.ai image-to-image), posted to the chat ----------
export const sketchFromBoard = onCall(
  { secrets: ALL_SECRETS, timeoutSeconds: 180, maxInstances: 10 },
  async request => {
    await requireRoomMember(request);
    const roomId = request.data.roomId;
    const imageDataUrl = String(request.data?.imageDataUrl || '');
    if (!imageDataUrl.startsWith('data:image/')) throw new HttpsError('invalid-argument', 'Missing drawing');
    const roomAi = await ensureRoomAi(roomId);
    if (roomAi.profile?.mode === 'none' || roomAi.profile?.modules?.enableSketch === false) throw new HttpsError('failed-precondition', 'Sketches are off in this room');
    const sys = await getSystemConfig();
    const notes = String(request.data?.notes || '').slice(0, 300);
    const secrets = await engineSecrets();
    const urls = await refineSketch(imageDataUrl, notes, { falKey: secrets.fal, model: sys.sketchRefineModel, folder: `sketch/${roomId}` });
    await logAiCall({ ...baseLog(request, 'sketch_refine', sys.sketchRefineModel), input: { imageBytes: imageDataUrl.length, notes }, output: { urls } });
    if (!urls.some(Boolean)) throw new HttpsError('internal', 'Sketch generation failed');
    const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data() || {};
    const titles = room.language === 'en' ? ['Clean sketch', 'Render'] : ['乾淨草圖', '渲染圖'];
    await postAiMessage(roomId, room, roomAi.profile, {
      content: str('sketchRefined', room.language),
      assetType: 'sketch',
      assetPayload: { title: titles[0], fromBoard: true, model: sys.sketchRefineModel, images: urls.map((url, i) => ({ title: titles[i], url, size: i === 0 ? 'large' : 'medium', isAiGenerated: true })) },
      meta: { model: sys.sketchRefineModel, callerUid: request.auth.uid }
    });
    return { ok: true };
  }
);

// ---------- Whiteboard SVG ----------
export const generateSvg = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, maxInstances: 20 },
  async request => {
    await requireRoomMember(request);
    const sys = await getSystemConfig();
    const prompts = await roomPrompts(request.data.roomId);
    try {
      const response = await createMessage(await anthropicKey(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: textToSvgPrompt(String(request.data?.prompt || '').slice(0, 2000), prompts) }]
      });
      const svg = extractSvg(responseText(response));
      await logAiCall({ ...baseLog(request, 'text_to_svg', sys.models.svg), input: { prompt: request.data?.prompt || '' }, output: { svg }, usage: meta(sys.models.svg, response).usage });
      return { svg, meta: meta(sys.models.svg, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'text_to_svg', sys.models.svg), input: { prompt: request.data?.prompt || '' }, error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'generateSvg');
    }
  }
);

/** Hand-drawn strokes or an uploaded sketch photo → clean SVG. */
export const sketchToSvg = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, maxInstances: 20 },
  async request => {
    await requireRoomMember(request);
    const { imageDataUrl, notes = '', language = 'zh-TW' } = request.data || {};
    const sys = await getSystemConfig();
    const prompts = await roomPrompts(request.data.roomId);
    try {
      const response = await createMessage(await anthropicKey(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(imageDataUrl), { type: 'text', text: sketchToSvgPrompt(String(notes).slice(0, 2000), language, prompts) }] }]
      });
      const svg = extractSvg(responseText(response));
      await logAiCall({ ...baseLog(request, 'sketch_to_svg', sys.models.svg), input: { notes, imageBytes: String(imageDataUrl || '').length }, output: { svg }, usage: meta(sys.models.svg, response).usage });
      return { svg, meta: meta(sys.models.svg, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'sketch_to_svg', sys.models.svg), input: { notes }, error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'sketchToSvg');
    }
  }
);

// ---------- 3D ----------
const meshKeys = () => resolveKeys({ meshy: MESHY_API_KEY.value(), tripo: TRIPO_API_KEY.value() });

export const refineModel3D = onCall(
  { secrets: [MESHY_API_KEY, TRIPO_API_KEY], timeoutSeconds: 540, memory: '512MiB', maxInstances: 10 },
  async request => {
    const room = await requireRoomMember(request);
    const { taskId, texturePrompt, roomId, title = '' } = request.data || {};
    if (!taskId) throw new HttpsError('invalid-argument', 'Missing Meshy task id');
    try {
      const { meshy } = await getSystemConfig();
      const result = await refineMeshy({ previewTaskId: taskId, texturePrompt, keys: await meshKeys(), meshy });
      await logAiCall({ ...baseLog(request, 'model_3d_refine', 'meshy'), input: { taskId, texturePrompt: texturePrompt || '', meshy }, output: result });
      // The refined model is posted as an AI message by the server (browsers cannot post as the AI)
      const name = String(title).slice(0, 200);
      await postAiMessage(roomId, room, (await ensureRoomAi(roomId)).profile || {}, {
        content: str('refinedMessage', room.language, { title: name }),
        assetType: 'mesh_3d',
        assetPayload: {
          title: str('refinedTitle', room.language, { title: name }),
          provider: result.provider,
          taskId: result.taskId,
          modelUrl: result.modelUrl,
          originalModelUrl: result.originalModelUrl,
          posterUrl: result.thumbnailUrl || null,
          isRefined: true,
          isInteractive: true
        },
        meta: { kind: 'model_3d_refine', requestedBy: request.auth.uid }
      });
      return result;
    } catch (err) {
      console.error('[refineModel3D]', err?.message || err);
      throw new HttpsError('internal', err?.message || '3D refinement failed');
    }
  }
);

// ---------- Legacy GLB download proxy (older chat messages still point at provider URLs) ----------
// Only https model hosts, so the endpoint cannot be used as an open proxy or to reach internal addresses
const PROXY_HOSTS = ['meshy.ai', 'tripo3d.ai', 'tripo3d.com', 'amazonaws.com', 'cloudfront.net', 'firebasestorage.googleapis.com', 'storage.googleapis.com', 'firebasestorage.app'];
const proxyAllowed = raw => {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && PROXY_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

export const proxyGlb = onRequest({ invoker: 'public', memory: '256MiB', maxInstances: 10, cors: true }, async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');
  if (!proxyAllowed(url)) return res.status(403).send('Host not allowed');
  try {
    const upstream = await fetch(String(url), { redirect: 'error' });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream error');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    if (filename) res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(String(filename))}"`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('[proxyGlb]', err?.message || err);
    res.status(500).send('Proxy failed');
  }
});
