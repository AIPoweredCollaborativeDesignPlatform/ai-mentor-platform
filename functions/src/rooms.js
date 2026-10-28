import { getFirestore } from 'firebase-admin/firestore';
import { assignProfileToRoom, loadProfile } from './engine.js';
import { loadDefaultProfile } from './profiles.js';
import { roomLanguage, str } from './i18n.js';

/**
 * Room creation and the 4-digit PIN registry. Rooms are created only here (firestore.rules forbids
 * browser creates), so every PIN goes through roomPins/{roomId} (server-only). A PIN is used once:
 * when its room is deleted the registry entry stays (marked deletedAt) and the PIN is never handed
 * out again. New rooms get a random PIN from the free ones.
 */

const db = () => getFirestore();
const PIN_MIN = 1000;
const PIN_MAX = 9999;
const FOUR_DIGIT = /^room_\d{4}$/;

/** Every 4-digit room id that is taken: existing rooms (also those from before the registry) and registry entries. */
async function takenRoomIds() {
  const [rooms, pins] = await Promise.all([db().collection('rooms').select().get(), db().collection('roomPins').select().get()]);
  return new Set([...rooms.docs, ...pins.docs].map(d => d.id).filter(id => FOUR_DIGIT.test(id)));
}

async function reservePin(uid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await takenRoomIds();
    const free = [];
    for (let n = PIN_MIN; n <= PIN_MAX; n++) if (!taken.has(`room_${n}`)) free.push(String(n));
    if (!free.length) throw new Error('No free room PIN left');
    const pin = free[Math.floor(Math.random() * free.length)];
    try {
      // create() fails if someone reserved the same PIN meanwhile → pick again
      await db().doc(`roomPins/room_${pin}`).create({ pin, reservedBy: uid, reservedAt: Date.now() });
      return pin;
    } catch (err) {
      if (err?.code !== 6) throw err; // 6 = ALREADY_EXISTS
    }
  }
  throw new Error('Could not reserve a room PIN, please try again');
}

/**
 * Creates a study room. The creator is the researcher (host) unless `asParticipant` (administrator
 * and observers only): then the room has no researcher, the creator joins like everyone else
 * (nickname + consent) and End / Reopen are left to the administrator.
 */
export async function createRoom(uid, { roomName, roomEmoji, language, mentorConfig, appVersion, displayName, avatar, asParticipant = false, profileId = null }, by) {
  const pin = await reservePin(uid);
  const roomId = `room_${pin}`;
  const now = Date.now();
  const emoji = String(roomEmoji || '').trim().slice(0, 8) || '💡';
  const name = String(roomName || '').trim().slice(0, 60) || `Meeting ${pin}`;

  // The profile (chosen or default) sets the room language: UI, AI replies, system messages.
  // It is assigned right after the room doc is written; the onRoomCreated fallback then finds it done
  // (or, if the fallback ran first, this assignment replaces the default).
  const profile = profileId ? await loadProfile(profileId) : await loadDefaultProfile();
  if (profileId && !profile.id) throw new Error('Profile not found');
  const lang = roomLanguage(profile.language || language);

  const roomDoc = db().doc(`rooms/${roomId}`);
  const batch = db().batch();
  batch.set(roomDoc, {
    roomId, pin, roomName: name, roomEmoji: emoji,
    hostUid: asParticipant ? '' : uid,
    createdBy: uid,
    participantUids: asParticipant ? [] : [uid],
    createdAt: now, lastActive: now, roomStatus: 'active',
    mentorConfig: mentorConfig || null, assetsCount: 0,
    appVersion: String(appVersion || ''), language: lang
  });
  if (!asParticipant) {
    batch.set(roomDoc.collection('participants').doc(uid), {
      uid, displayName: String(displayName || 'Host').slice(0, 40), avatar: String(avatar || '💡').slice(0, 8),
      status: 'approved', isHost: true, isOnline: true, joinedAt: now
    });
  }
  batch.set(roomDoc.collection('messages').doc(`msg_${now}`), {
    senderUid: 'system', senderName: str('system', lang), senderAvatar: '🏛️', type: 'text',
    content: str('roomCreated', lang, { emoji, name, pin }), timestamp: now
  });
  batch.update(db().doc(`roomPins/${roomId}`), { createdAt: now });
  await batch.commit();
  await assignProfileToRoom(roomId, profile, profileId ? by : 'system-default');
  return { roomId, pin, roomName: name, roomEmoji: emoji, hostUid: asParticipant ? '' : uid };
}

/** A deleted room keeps its registry entry, so its PIN is never reused. */
export async function markRoomDeleted(roomId) {
  if (!FOUR_DIGIT.test(roomId)) return;
  await db().doc(`roomPins/${roomId}`).set({ pin: roomId.slice(5), deletedAt: Date.now() }, { merge: true });
}

/** For /#/admin: every 4-digit PIN as in use / ended / invalid (deleted or never created) / free. */
export async function listPins() {
  const [rooms, pins] = await Promise.all([
    db().collection('rooms').select('roomName', 'session', 'roomStatus', 'deletedAt', 'createdAt', 'lastActive').get(),
    db().collection('roomPins').get()
  ]);
  const roomById = new Map(rooms.docs.filter(d => FOUR_DIGIT.test(d.id)).map(d => [d.id, d.data()]));
  const pinById = new Map(pins.docs.map(d => [d.id, d.data()]));
  const inUse = [], ended = [], invalid = [];
  for (const id of new Set([...roomById.keys(), ...pinById.keys()])) {
    const room = roomById.get(id);
    const reg = pinById.get(id) || {};
    const row = { pin: id.slice(5), roomName: room?.roomName || '', createdAt: room?.createdAt || reg.createdAt || reg.reservedAt || null, lastActive: room?.lastActive || null };
    if (!room || room.deletedAt) invalid.push({ ...row, reason: room ? 'deleted' : reg.deletedAt ? 'deleted' : 'never_created', deletedAt: room?.deletedAt || reg.deletedAt || null });
    else if (room.session?.phase === 'ended' || room.roomStatus === 'ended') ended.push(row);
    else inUse.push(row);
  }
  const byPin = (a, b) => a.pin.localeCompare(b.pin);
  const taken = new Set([...roomById.keys(), ...pinById.keys()]);
  const free = [];
  for (let n = PIN_MIN; n <= PIN_MAX; n++) if (!taken.has(`room_${n}`)) free.push(String(n));
  return { inUse: inUse.sort(byPin), ended: ended.sort(byPin), invalid: invalid.sort(byPin), free };
}

// ---------- Changes that post a chat notice (system messages are written only by the server) ----------
const systemNotice = (roomId, language, content, avatar) =>
  db().collection(`rooms/${roomId}/messages`).add({
    senderUid: 'system', senderName: str('system', language), senderAvatar: avatar, type: 'text', content, timestamp: Date.now()
  });

/**
 * A member changes their name or avatar in a room. Participants' changes are announced in the chat;
 * the researcher (host) and observers stay invisible.
 */
export async function updateMyProfile(roomId, uid, { displayName, avatar }) {
  const roomSnap = await db().doc(`rooms/${roomId}`).get();
  const room = roomSnap.data();
  if (!room) throw new Error('Room not found');
  const partRef = db().doc(`rooms/${roomId}/participants/${uid}`);
  const me = (await partRef.get()).data();
  if (!me || !['approved', 'observer'].includes(me.status)) throw new Error('Not a member of this room');
  const name = String(displayName || '').trim().slice(0, 20) || me.displayName || 'Participant';
  const icon = String(avatar || '').trim().slice(0, 8) || me.avatar || '🙂';
  if (name === me.displayName && icon === me.avatar) return { changed: false };
  await partRef.update({ displayName: name, avatar: icon });
  const silent = room.hostUid === uid || me.status === 'observer';
  if (!silent) {
    await systemNotice(roomId, room.language, str('profileUpdated', room.language, { old: me.displayName || '', name, avatar: icon }), '✏️');
  }
  return { changed: true };
}

/** The room's host renames the room or changes its emoji; the change is announced in the chat. */
export async function updateRoomDetails(roomId, uid, isAdmin, { roomName, roomEmoji }) {
  const ref = db().doc(`rooms/${roomId}`);
  const room = (await ref.get()).data();
  if (!room) throw new Error('Room not found');
  if (room.hostUid !== uid && !isAdmin) throw new Error('Only the room host can change the room details');
  const name = String(roomName || '').trim().slice(0, 60) || room.roomName;
  const emoji = String(roomEmoji || '').trim().slice(0, 8) || room.roomEmoji || '💡';
  if (name === room.roomName && emoji === room.roomEmoji) return { roomName: name, roomEmoji: emoji, changed: false };
  await ref.update({ roomName: name, roomEmoji: emoji, updatedAt: Date.now() });
  await systemNotice(roomId, room.language, str('detailsUpdated', room.language, { emoji, name }), '📝');
  return { roomName: name, roomEmoji: emoji, changed: true };
}
