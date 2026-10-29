import { Readable } from 'node:stream';
import { initializeApp } from 'firebase-admin/app';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { getSystemConfig } from './src/config.js';
import { classifyError, createMessage, extractSvg, imageBlockFromDataUrl, responseText } from './src/claude.js';
import { PROMPT_VERSION, VISION_PROMPT, sketchToSvgPrompt, textToSvgPrompt } from './src/prompts.js';
import { refineMeshy } from './src/mesh3d.js';
import { logAiCall } from './src/log.js';
import { FRIENDLY_ERRORS } from './src/mentor.js';
import { assignProfileToRoom, ensureRoomAi, handleNewMessage, loadProfile, postAiMessage, runCheck } from './src/engine.js';
import { endSession, joinRoom, maybeStartSession, reopenSession, runSessionJob, sessionTick } from './src/session.js';
import { logBoardObjectChange, logMessageChange } from './src/events.js';
import { authUrl, exportRoom, handleCallback, runDueExports } from './src/drive.js';
import { createRoom, listPins, markRoomDeleted, updateMyProfile, updateRoomDetails } from './src/rooms.js';
import { consentTextFor, roomLanguage, str } from './src/i18n.js';
import { claimAnonymousRooms, isAdminToken, isObserverToken, listObservers, setObserver, syncRole } from './src/roles.js';

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
const engineSecrets = () => ({
  anthropic: ANTHROPIC_API_KEY.value(),
  fal: FAL_KEY.value(),
  meshy: MESHY_API_KEY.value(),
  tripo: TRIPO_API_KEY.value()
});
const ALL_SECRETS = [ANTHROPIC_API_KEY, FAL_KEY, MESHY_API_KEY, TRIPO_API_KEY];

// Handlers may wait up to stallSeconds for a pause/stall; concurrency lets waits share instances
export const onRoomMessage = onDocumentCreated(
  { document: 'rooms/{roomId}/messages/{messageId}', secrets: ALL_SECRETS, timeoutSeconds: 540, memory: '512MiB', cpu: 1, concurrency: 80, maxInstances: 20 },
  async event => {
    const msg = event.data?.data();
    if (!msg) return;
    await handleNewMessage(event.params.roomId, event.params.messageId, msg, engineSecrets());
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
    await runCheck(roomId, engineSecrets(), { reason: 'retry', forced: true, callerUid: request.auth.uid, retryMessageId });
    return { ok: true };
  }
);

// ---------- Study administration ----------
const requireAdmin = request => {
  if (!isAdminToken(request.auth?.token)) throw new HttpsError('permission-denied', 'Study administrator only');
};

// ---------- Roles (src/roles.js) ----------
/** Brings the caller's observer claim in line with the list; the browser refreshes its token when changed. */
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
  if ((d.profileId || d.asParticipant) && !observer) throw new HttpsError('permission-denied', 'Study staff only');
  try {
    return await createRoom(request.auth.uid, { ...d, asParticipant: d.asParticipant === true, profileId: d.profileId || null }, request.auth.token.email || request.auth.uid);
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

// ---------- Experiment flow (src/session.js) ----------
export const joinStudyRoom = onCall({ maxInstances: 20 }, async request => {
  requireAuth(request);
  const { roomId, displayName, avatar, consent, retry, asParticipant } = request.data || {};
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
  return joinRoom({
    roomId: String(roomId), uid: request.auth.uid, displayName, avatar, consent: consent === true, retry: retry === true,
    observer: isObserverToken(request.auth.token), asParticipant: asParticipant === true
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
/** Reopen an ended room: the room's researcher (host) or the study administrator. */
export const reopenStudySession = onCall({ maxInstances: 5 }, async request => {
  requireAuth(request);
  const { roomId } = request.data || {};
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId');
  const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data();
  if (!room) throw new HttpsError('not-found', 'Room not found');
  const token = request.auth.token;
  const isResearcher = room.hostUid === request.auth.uid;
  if (!isResearcher && !isAdminToken(token)) {
    throw new HttpsError('permission-denied', 'Only the researcher can reopen the session');
  }
  return { reopened: await reopenSession(String(roomId), isResearcher ? 'researcher' : 'admin') };
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
    if (job) await runSessionJob(job, { anthropic: ANTHROPIC_API_KEY.value() });
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
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.vision,
        max_tokens: 1000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(request.data?.imageDataUrl), { type: 'text', text: VISION_PROMPT }] }]
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

// ---------- Whiteboard SVG ----------
export const generateSvg = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, maxInstances: 20 },
  async request => {
    await requireRoomMember(request);
    const sys = await getSystemConfig();
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: textToSvgPrompt(String(request.data?.prompt || '').slice(0, 2000)) }]
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
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(imageDataUrl), { type: 'text', text: sketchToSvgPrompt(String(notes).slice(0, 2000), language) }] }]
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
const meshKeys = () => ({ meshy: MESHY_API_KEY.value(), tripo: TRIPO_API_KEY.value() });

export const refineModel3D = onCall(
  { secrets: [MESHY_API_KEY, TRIPO_API_KEY], timeoutSeconds: 540, memory: '512MiB', maxInstances: 10 },
  async request => {
    const room = await requireRoomMember(request);
    const { taskId, texturePrompt, roomId, title = '' } = request.data || {};
    if (!taskId) throw new HttpsError('invalid-argument', 'Missing Meshy task id');
    try {
      const result = await refineMeshy({ previewTaskId: taskId, texturePrompt, keys: meshKeys() });
      await logAiCall({ ...baseLog(request, 'model_3d_refine', 'meshy'), input: { taskId, texturePrompt: texturePrompt || '' }, output: result });
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
