import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/**
 * Research event log: rooms/{roomId}/events/{autoId}, one document per event, admin-read only.
 * Server events (chat, whiteboard objects, session flow) are written here; browser events
 * (window focus, whiteboard open/close, tools, AI messages read) come from the client in batches
 * with the same shape and source: 'client'. P4b exports this collection to Drive.
 */

const AI_UIDS = new Set(['ai_mentor', 'ai_mentor_3d']);
const MAX_STRING = 20_000;
// Whiteboard objects are kept whole (freehand paths are long strings) so the board can be replayed;
// the object document itself is already below Firestore's 1 MiB limit
const BOARD_MAX_STRING = 900_000;

// Host, observers and whether the room belongs to this site, cached per instance. A uid the cache
// does not know yet (someone who just joined) refreshes it, at most every few seconds.
const roomCache = new Map();
const CACHE_MS = 5 * 60_000;
const REFRESH_MS = 3_000;

export async function roomInfo(roomId, uid = null) {
  const hit = roomCache.get(roomId);
  const known = hit && (!uid || AI_UIDS.has(uid) || uid === 'system' || hit.members.has(uid));
  if (hit && Date.now() - hit.at < CACHE_MS && (known || Date.now() - hit.at < REFRESH_MS)) return hit;
  const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data() || {};
  const observers = new Set(room.observerUids || []);
  const members = new Set([room.hostUid, ...observers, ...(room.participantUids || [])].filter(Boolean));
  const info = { at: Date.now(), hostUid: room.hostUid || null, observers, members, tracked: Boolean(room.appVersion) };
  roomCache.set(roomId, info);
  return info;
}

/** Someone who joined a room as a participant stays one even if they later become an observer. */
export const roleOf = (info, uid) =>
  !uid ? 'unknown'
    : AI_UIDS.has(uid) ? 'ai'
    : uid === 'system' ? 'system'
    : uid === info.hostUid ? 'researcher'
    : info.observers?.has(uid) ? 'observer'
    : 'participant';

/** Replaces very long strings (data URLs, big SVGs) so an event stays far below the 1 MiB doc limit. */
export function compact(value, depth = 0, max = MAX_STRING) {
  if (typeof value === 'string') return value.length > max ? `[omitted ${value.length} chars]` : value;
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(v => compact(v, depth + 1, max));
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, compact(v, depth + 1, max)]));
}

// Nothing participants do is recorded after the session ended (until it is reopened)
const phaseCache = new Map();
const PHASE_CACHE_MS = 10_000;
async function sessionEnded(roomId) {
  const hit = phaseCache.get(roomId);
  if (hit && Date.now() - hit.at < PHASE_CACHE_MS) return hit.ended;
  const room = (await getFirestore().doc(`rooms/${roomId}`).get()).data() || {};
  const ended = room.session?.phase === 'ended';
  phaseCache.set(roomId, { at: Date.now(), ended });
  return ended;
}

export async function writeEvent(roomId, { kind, uid = null, role, data = {}, at = Date.now(), maxString = MAX_STRING }) {
  try {
    const info = role ? null : await roomInfo(roomId, uid);
    await getFirestore().collection(`rooms/${roomId}/events`).add({
      at,
      serverAt: FieldValue.serverTimestamp(),
      source: 'server',
      kind,
      uid,
      role: role || roleOf(info, uid),
      data: compact(data, 0, maxString)
    });
  } catch (err) {
    console.error('[events] write failed:', kind, err?.message || err);
  }
}

const changeType = (before, after) => (!before ? 'created' : !after ? 'deleted' : 'updated');

const changedKeys = (before, after) =>
  [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));

/** Every create/update/delete of a chat message (including reactions, poll votes and board cards). */
export async function logMessageChange(roomId, messageId, before, after) {
  const info = await roomInfo(roomId);
  if (!info.tracked || await sessionEnded(roomId)) return;
  const type = changeType(before, after);
  const doc = after || before;
  const uid = type === 'updated' ? null : doc.senderUid; // updates (reactions, votes) do not say who made them
  await writeEvent(roomId, {
    kind: `message_${type}`,
    uid,
    role: uid ? roleOf(info, uid) : 'unknown',
    at: type === 'created' ? doc.timestamp || Date.now() : Date.now(),
    data: {
      messageId,
      messageType: doc.type || 'text',
      ...(type === 'updated' ? { changedKeys: changedKeys(before, after) } : {}),
      ...(type === 'deleted' ? {} : { message: after })
    }
  });
}

/** Every whiteboard object change; the stored fabric JSON allows replaying the board. */
export async function logBoardObjectChange(roomId, boardId, objectId, before, after) {
  const info = await roomInfo(roomId);
  if (!info.tracked || await sessionEnded(roomId)) return;
  const type = changeType(before, after);
  const uid = after?.updatedBy || null; // deletes carry no author
  await writeEvent(roomId, {
    kind: `board_object_${type}`,
    uid,
    role: uid ? roleOf(info, uid) : 'unknown',
    at: after?.updatedAt || Date.now(),
    data: { boardId, objectId, z: after?.z ?? null, fabric: after?.fabric ?? null },
    maxString: BOARD_MAX_STRING
  });
}
