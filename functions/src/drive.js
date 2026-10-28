import { randomBytes } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Research data export to the study administrator's Google Drive (P4b).
 *  - OAuth (scope drive.file): the admin connects once from /#/admin; the refresh token lives in
 *    privateConfig/drive (no client access). drive.file only reaches files this app created, so the
 *    app creates its own root folder; the researcher may move that folder anywhere in Drive.
 *  - Each ended room is exported 10 minutes after it ended (roomExports/{roomId}, driven by the
 *    session clock) or on demand from /#/admin. If authorization is revoked or expires, exports wait
 *    as needs_auth and are re-queued automatically after reconnecting.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const REDIRECT_URI = 'https://ai-mentor-design.web.app/api/drive/callback';
const ROOT_FOLDER_NAME = 'AI Mentor 研究資料';
const EXPORT_DELAY_MS = 10 * 60_000;
const STALE_UPLOAD_MS = 15 * 60_000;
const STATE_TTL_MS = 10 * 60_000;

const db = () => getFirestore();
const privateRef = () => db().doc('privateConfig/drive');
const statusRef = () => db().doc('driveStatus/current');
const exportRef = roomId => db().doc(`roomExports/${roomId}`);

class NeedsAuthError extends Error {}

// ---------- OAuth ----------

/** Consent URL for the admin; `state` is single-use and expires after 10 minutes. */
export async function authUrl(clientId, email) {
  const state = randomBytes(24).toString('hex');
  await db().doc(`oauthStates/${state}`).set({ createdAt: Date.now(), email });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always returns a refresh token, also when reconnecting
    include_granted_scopes: 'true',
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Redirect target: stores the refresh token, ensures the root folder, re-queues waiting exports. */
export async function handleCallback({ code, state, error }, { clientId, clientSecret }) {
  if (error) throw new Error(`Google returned: ${error}`);
  const stateRef = db().doc(`oauthStates/${state || 'missing'}`);
  const stateSnap = await stateRef.get();
  await stateRef.delete().catch(() => {});
  if (!stateSnap.exists || Date.now() - stateSnap.data().createdAt > STATE_TTL_MS) throw new Error('This sign-in link has expired. Start again from the admin page.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
  });
  const tokens = await res.json();
  if (!res.ok || !tokens.refresh_token) throw new Error(`Token exchange failed: ${tokens.error_description || tokens.error || res.status}`);

  const previous = (await privateRef().get()).data() || {};
  await privateRef().set({ refreshToken: tokens.refresh_token, connectedAt: Date.now(), connectedBy: stateSnap.data().email, rootFolderId: previous.rootFolderId || null });
  const rootFolderId = await ensureRootFolder(tokens.access_token);
  await statusRef().set({ status: 'ok', connectedAt: Date.now(), connectedBy: stateSnap.data().email, rootFolderId, error: null });

  // Re-queue everything that waited for authorization
  const waiting = await db().collection('roomExports').where('status', '==', 'needs_auth').get();
  await Promise.all(waiting.docs.map(d => d.ref.update({ status: 'pending', dueAt: Date.now(), error: null })));
  return { requeued: waiting.size };
}

async function markNeedsAuth(message) {
  await statusRef().set({ status: 'needs_auth', error: message, updatedAt: Date.now() }, { merge: true });
}

async function accessToken({ clientId, clientSecret }) {
  const cfg = (await privateRef().get()).data();
  if (!cfg?.refreshToken) {
    await markNeedsAuth('Google Drive is not connected yet.');
    throw new NeedsAuthError('Google Drive is not connected');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: cfg.refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
  });
  const body = await res.json();
  if (res.ok) return body.access_token;
  if (body.error === 'invalid_grant') {
    await markNeedsAuth('Authorization expired or was revoked. Please reconnect Google Drive.');
    throw new NeedsAuthError('Drive authorization expired');
  }
  throw new Error(`Token refresh failed: ${body.error_description || body.error || res.status}`);
}

// ---------- Drive REST ----------

async function driveFetch(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 401) {
    await markNeedsAuth('Drive rejected the access token. Please reconnect Google Drive.');
    throw new NeedsAuthError('Drive returned 401');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Drive ${res.status}: ${body.error?.message || 'request failed'}`);
  return body;
}

const createFolder = (token, name, parentId) =>
  driveFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) })
  });

/** The app's own root folder; re-created if it was deleted (trashed folders count as gone). */
async function ensureRootFolder(token) {
  const cfg = (await privateRef().get()).data() || {};
  if (cfg.rootFolderId) {
    const existing = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${cfg.rootFolderId}?fields=id,trashed`).catch(() => null);
    if (existing?.id && !existing.trashed) return cfg.rootFolderId;
  }
  const folder = await createFolder(token, ROOT_FOLDER_NAME);
  await privateRef().set({ rootFolderId: folder.id }, { merge: true });
  await statusRef().set({ rootFolderId: folder.id }, { merge: true });
  return folder.id;
}

async function uploadFile(token, parentId, name, mimeType, content) {
  const boundary = `b${randomBytes(12).toString('hex')}`;
  const meta = JSON.stringify({ name, parents: [parentId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  return driveFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
}

// ---------- Export content ----------

// Firestore Timestamps → epoch ms (the replacer may see them before or after their toJSON())
const asMillis = v => {
  if (!v || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const sec = v._seconds ?? v.seconds;
  const ns = v._nanoseconds ?? v.nanoseconds;
  return typeof sec === 'number' && typeof ns === 'number' && Object.keys(v).length === 2 ? sec * 1000 + Math.round(ns / 1e6) : v;
};
const plain = value => JSON.parse(JSON.stringify(value, (_k, v) => asMillis(v)));
const jsonl = rows => rows.map(r => JSON.stringify(plain(r))).join('\n') + (rows.length ? '\n' : '');
const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dateTag = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10); // Taipei date
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

/** Builds every file of one room's export: [{ name, mimeType, content }]. */
export async function buildRoomExport(roomId) {
  const roomRef = db().doc(`rooms/${roomId}`);
  const [roomSnap, roomAiSnap, partSnap, msgSnap, eventSnap, logSnap] = await Promise.all([
    roomRef.get(),
    db().doc(`roomAi/${roomId}`).get(),
    roomRef.collection('participants').get(),
    roomRef.collection('messages').orderBy('timestamp').get(),
    roomRef.collection('events').orderBy('at').get(),
    db().collection('aiLogs').where('roomId', '==', roomId).get()
  ]);
  const room = roomSnap.data() || {};
  const roomAi = roomAiSnap.data() || {};

  // P01… in order of joining; the researcher (host) is R. Nicknames are kept next to the alias.
  const participants = partSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  const alias = new Map([[room.hostUid, 'R']]);
  participants.filter(p => p.uid !== room.hostUid).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
    .forEach((p, i) => alias.set(p.uid, `P${String(i + 1).padStart(2, '0')}`));
  const aliasOf = uid => alias.get(uid) || (uid?.startsWith('ai_mentor') ? 'AI' : uid === 'system' ? 'SYSTEM' : null);

  const consentHashes = [...new Set(participants.map(p => p.consent?.textHash).filter(Boolean))];
  const consentTexts = Object.fromEntries(await Promise.all(consentHashes.map(async h => [h, (await db().doc(`consentTexts/${h}`).get()).data()?.text || null])));

  const files = [];
  files.push({
    name: 'participants.csv',
    mimeType: 'text/csv',
    content: '﻿' + [
      ['alias', 'uid', 'nickname', 'role', 'joinedAt', 'consentAgreedAt', 'consentTextHash'].join(','),
      ...participants.sort((a, b) => (aliasOf(a.uid) || '').localeCompare(aliasOf(b.uid) || '')).map(p => [
        aliasOf(p.uid), p.uid, p.displayName, p.uid === room.hostUid ? 'researcher' : 'participant',
        p.joinedAt ? new Date(p.joinedAt).toISOString() : '', p.consent?.agreedAt ? new Date(p.consent.agreedAt).toISOString() : '', p.consent?.textHash || ''
      ].map(csvCell).join(','))
    ].join('\n') + '\n'
  });

  const events = eventSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.at - b.at);
  files.push({ name: 'events.jsonl', mimeType: 'application/x-ndjson', content: jsonl(events.map(e => ({ ...e, alias: aliasOf(e.uid) }))) });

  const boardCards = [];
  const messages = msgSnap.docs.map(d => {
    const m = { id: d.id, ...d.data() };
    if (m.type === 'whiteboard_state') boardCards.push(m);
    // Board thumbnails are exported as image files; keep the JSONL readable
    if (String(m.fileData?.url || '').startsWith('data:')) m.fileData = { ...m.fileData, url: '[exported as image]' };
    return { ...m, senderAlias: aliasOf(m.senderUid) };
  });
  files.push({ name: 'messages.jsonl', mimeType: 'application/x-ndjson', content: jsonl(messages) });

  const logs = logSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
  files.push({ name: 'ai_logs.jsonl', mimeType: 'application/x-ndjson', content: jsonl(logs) });

  files.push({
    name: 'session.json',
    mimeType: 'application/json',
    content: JSON.stringify(plain({
      roomId,
      pin: room.pin,
      roomName: room.roomName,
      createdAt: room.createdAt,
      language: room.language,
      appVersion: room.appVersion,
      session: room.session || null,
      profileId: roomAi.profileId || null,
      profileVersion: roomAi.profileVersion ?? null,
      profileAssignedAt: roomAi.assignedAt || null,
      profile: roomAi.profile || null,
      aiMemory: roomAi.memory || null,
      consentTexts,
      aliases: Object.fromEntries(alias),
      exportedAt: Date.now()
    }), null, 2)
  });

  // Final state and last thumbnail of each board
  for (const card of boardCards) {
    const objects = await roomRef.collection('boards').doc(card.id).collection('objects').get();
    files.push({
      name: `boards/${card.id}.json`,
      mimeType: 'application/json',
      content: JSON.stringify(plain({ boardId: card.id, creatorAlias: aliasOf(card.metadata?.creatorUid), isPrivate: card.metadata?.isPrivate ?? null, objects: objects.docs.map(d => ({ id: d.id, ...d.data() })) }))
    });
    const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(card.fileData?.url || '');
    if (m) files.push({ name: `boards/${card.id}.${m[2] === 'png' ? 'png' : 'jpg'}`, mimeType: m[1], content: Buffer.from(m[3], 'base64') });
  }

  const folderName = `${dateTag(room.createdAt || Date.now())}_${room.pin || roomId}_${safeName(roomAi.profile?.name || 'default')}`;
  return { folderName, files };
}

/** Uploads one room; records the result in roomExports/{roomId}. */
export async function exportRoom(roomId, oauth, { manual = false } = {}) {
  const claimed = await db().runTransaction(async tx => {
    const snap = await tx.get(exportRef(roomId));
    const cur = snap.data() || {};
    if (cur.status === 'uploading' && Date.now() - (cur.startedAt || 0) < STALE_UPLOAD_MS) return null;
    const attempts = (cur.attempts || 0) + 1;
    tx.set(exportRef(roomId), { status: 'uploading', startedAt: Date.now(), attempts, manual, error: null }, { merge: true });
    return attempts;
  });
  if (!claimed) return { status: 'already_uploading' };

  try {
    const token = await accessToken(oauth);
    const rootId = await ensureRootFolder(token);
    const { folderName, files } = await buildRoomExport(roomId);
    const folder = await createFolder(token, claimed > 1 ? `${folderName}_upload${claimed}` : folderName, rootId);
    let boardsFolderId = null;
    for (const f of files) {
      let parent = folder.id;
      let name = f.name;
      if (name.startsWith('boards/')) {
        boardsFolderId ||= (await createFolder(token, 'boards', folder.id)).id;
        parent = boardsFolderId;
        name = name.slice('boards/'.length);
      }
      await uploadFile(token, parent, name, f.mimeType, f.content);
    }
    const result = { status: 'done', finishedAt: Date.now(), folderId: folder.id, folderUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`, fileCount: files.length, error: null };
    await exportRef(roomId).set(result, { merge: true });
    return result;
  } catch (err) {
    const needsAuth = err instanceof NeedsAuthError;
    const fields = { status: needsAuth ? 'needs_auth' : 'error', error: String(err?.message || err).slice(0, 500), failedAt: Date.now() };
    await exportRef(roomId).set(fields, { merge: true });
    console.error('[drive.exportRoom]', roomId, err?.message || err);
    return fields;
  }
}

/** Called when a session ends: upload 10 minutes later (the room stays readable meanwhile). */
export const queueRoomExport = (roomId, endedAt = Date.now()) =>
  exportRef(roomId).set({ status: 'pending', dueAt: endedAt + EXPORT_DELAY_MS, queuedAt: Date.now(), attempts: 0, error: null }, { merge: true });

/** From the session clock: due exports, plus failed ones retried after 30 minutes (at most 5 tries). */
export async function runDueExports(oauth, max = 3) {
  const now = Date.now();
  const [pending, failed] = await Promise.all([
    // Single-field queries only (no composite index needed); due time is checked here
    db().collection('roomExports').where('status', '==', 'pending').get(),
    db().collection('roomExports').where('status', '==', 'error').limit(10).get()
  ]);
  const retry = failed.docs.filter(d => (d.data().attempts || 0) < 5 && now - (d.data().failedAt || 0) > 30 * 60_000);
  const due = pending.docs.filter(d => (d.data().dueAt || 0) <= now);
  for (const d of [...due, ...retry].slice(0, max)) {
    const r = await exportRoom(d.id, oauth);
    if (r.status === 'needs_auth') break; // every other upload would fail the same way
  }
}
