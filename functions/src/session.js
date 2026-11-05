import { createHash } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getSystemConfig } from './config.js';
import { createMessage, parseJsonObject, responseText } from './claude.js';
import { buildTranscript, PROMPT_VERSION, sessionMessagePrompt } from './prompts.js';
import { acquireLock, ensureRoomAi, fetchContext, postAiMessage, releaseLock, startPresence } from './engine.js';
import { writeEvent } from './events.js';
import { logAiCall } from './log.js';
import { cancelPendingExport, queueRoomExport } from './drive.js';
import { consentTextFor, localized, str } from './i18n.js';

/**
 * Experiment flow of a room (rooms/{id}.session, written only here):
 *   waiting → running (once `expected` participants are online; opening text + AI kickoff)
 *           → reminders / time-up while running (AI-written; the no-AI condition only gets a time-up system message)
 *           → ended (researcher presses End, or every participant offline for IDLE_END_MS)
 * The researcher is the room host: never counted, never shown to participants.
 * Timed steps run from a once-a-minute tick; AI messages run as sessionJobs/{id} so each fires once.
 */

const db = () => getFirestore();
const roomRef = roomId => db().doc(`rooms/${roomId}`);
const jobRef = id => db().doc(`sessionJobs/${id}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Clients heartbeat every 10s and mark others offline after 25s; a little slack for the server
export const ONLINE_MS = 30_000;
const IDLE_END_MS = 10 * 60_000;
const WAITING_TICK_MAX_AGE_MS = 7 * 24 * 3600_000;

export const isOnline = (p, now) => p.status === 'approved' && p.isOnline !== false && (p.lastSeen || p.joinedAt || 0) > now - ONLINE_MS;

async function onlineParticipants(roomId, hostUid, now = Date.now()) {
  const snap = await roomRef(roomId).collection('participants').where('status', '==', 'approved').get();
  return snap.docs.filter(d => d.id !== hostUid && isOnline(d.data(), now)).map(d => d.id);
}

const consentHash = text => createHash('sha256').update(text || '').digest('hex').slice(0, 16);

/**
 * Join without host approval. New participants must accept the consent text and fit under the
 * room's simultaneous-online limit; people who were already in the room always get back in.
 */
export async function joinRoom({ roomId, uid, displayName, avatar, consent, retry = false, observer = false, asParticipant = false }) {
  const sys = await getSystemConfig();
  const now = Date.now();
  let consentText = '';
  let hash = '';
  const name = String(displayName || '').trim().slice(0, 20) || 'Participant';
  const partRef = roomRef(roomId).collection('participants').doc(uid);

  const result = await db().runTransaction(async tx => {
    const roomSnap = await tx.get(roomRef(roomId));
    const room = roomSnap.data();
    if (!roomSnap.exists || room.deletedAt) return { status: 'not_found' };
    // The consent text shown in the room language is the one agreed to
    consentText = consentTextFor(sys, room.language);
    hash = consentHash(consentText);

    if (room.hostUid === uid) {
      tx.set(partRef, { uid, status: 'approved', isHost: true, isOnline: true, lastSeen: now }, { merge: true });
      return { status: 'approved', role: 'researcher' };
    }

    const mine = await tx.get(partRef);
    const returning = mine.exists && mine.data().status === 'approved' && Boolean(mine.data().consent);
    // Observers (and the administrator in rooms they did not create) watch invisibly unless they chose
    // to join as a participant; once someone took part in a room they stay a participant there
    if (observer && !asParticipant && !returning) {
      tx.set(partRef, { uid, displayName: 'Observer', avatar: '👁️', status: 'observer', isHost: false, isOnline: true, lastSeen: now }, { merge: true });
      tx.update(roomRef(roomId), { observerUids: FieldValue.arrayUnion(uid) });
      return { status: 'approved', role: 'observer' };
    }
    if (room.session?.phase === 'ended') return { status: 'ended' };
    if (!returning) {
      if (!consent) return { status: 'consent_required' };
      const max = room.session?.maxOnline || 0;
      if (max) {
        const parts = await tx.get(roomRef(roomId).collection('participants').where('status', '==', 'approved'));
        const online = parts.docs.filter(d => d.id !== room.hostUid && d.id !== uid && isOnline(d.data(), now)).length;
        if (online >= max) return { status: 'full', online, max };
      }
    }

    tx.set(partRef, {
      uid,
      displayName: returning ? mine.data().displayName : name,
      avatar: returning ? mine.data().avatar : String(avatar || '🙂').slice(0, 8),
      status: 'approved',
      isHost: false,
      isOnline: true,
      lastSeen: now,
      ...(returning ? {} : { joinedAt: now, consent: { agreedAt: now, textHash: hash } })
    }, { merge: true });
    tx.update(roomRef(roomId), { participantUids: FieldValue.arrayUnion(uid), lastActive: now });
    return { status: 'approved', role: 'participant', returning };
  });

  if (result.status === 'approved' && result.role === 'participant') {
    // Keep the exact consent text each participant agreed to
    if (!result.returning) await db().doc(`consentTexts/${hash}`).set({ text: consentText, firstUsedAt: now }, { merge: true }).catch(() => {});
    await writeEvent(roomId, { kind: result.returning ? 'participant_rejoined' : 'participant_joined', uid, role: 'participant', data: { displayName: name, ...(result.returning ? {} : { consentTextHash: hash }) } });
    await maybeStartSession(roomId);
  } else if (result.status === 'full' && !retry) {
    await writeEvent(roomId, { kind: 'join_blocked_full', uid, role: 'participant', data: { online: result.online, max: result.max } });
  }
  return result;
}

/** Opens the session once enough participants are online (called on join and on every tick). */
export async function maybeStartSession(roomId) {
  const room = (await roomRef(roomId).get()).data();
  if (room?.session?.phase !== 'waiting') return false;
  const online = await onlineParticipants(roomId, room.hostUid);
  if (online.length < (room.session.expected || 1)) return false;

  const started = await db().runTransaction(async tx => {
    const snap = await tx.get(roomRef(roomId));
    const s = snap.data()?.session;
    if (s?.phase !== 'waiting') return null;
    const now = Date.now();
    const next = { ...s, phase: 'running', startedAt: now, endsAt: s.taskMinutes ? now + s.taskMinutes * 60_000 : null, remindersSent: [], allOfflineSince: null };
    tx.update(roomRef(roomId), { session: next });
    return next;
  });
  if (!started) return false;
  await writeEvent(roomId, { kind: 'session_started', role: 'system', data: { participants: online, endsAt: started.endsAt, taskMinutes: started.taskMinutes } });
  await queueJob(roomId, 'kickoff');
  return true;
}

/** Researcher pressed End, or the room went idle. */
export async function endSession(roomId, endedBy) {
  let language;
  const ended = await db().runTransaction(async tx => {
    const snap = await tx.get(roomRef(roomId));
    const room = snap.data();
    if (!room || room.session?.phase === 'ended') return false;
    language = room.language;
    tx.update(roomRef(roomId), {
      session: { ...(room.session || {}), phase: 'ended', endedAt: Date.now(), endedBy },
      roomStatus: 'ended'
    });
    return true;
  });
  if (!ended) return false;
  await roomRef(roomId).collection('messages').add({
    senderUid: 'system', senderName: str('system', language), senderAvatar: '🛑', type: 'text', content: str('sessionEnded', language), timestamp: Date.now()
  });
  await writeEvent(roomId, { kind: 'session_ended', role: 'system', data: { endedBy } });
  await queueRoomExport(roomId);
  return true;
}

/**
 * Researcher reopens an ended room: it runs again (no new opening, reminders or time-up beyond what
 * is still ahead), and the pending upload waits for the next end.
 */
export async function reopenSession(roomId, by) {
  let language;
  const reopened = await db().runTransaction(async tx => {
    const snap = await tx.get(roomRef(roomId));
    const room = snap.data();
    if (room?.session?.phase !== 'ended') return false;
    language = room.language;
    const { endedAt, endedBy, ...rest } = room.session;
    tx.update(roomRef(roomId), {
      session: { ...rest, phase: 'running', allOfflineSince: null, reopenedAt: Date.now(), reopenCount: (rest.reopenCount || 0) + 1 },
      roomStatus: 'active'
    });
    return true;
  });
  if (!reopened) return false;
  await cancelPendingExport(roomId);
  await roomRef(roomId).collection('messages').add({
    senderUid: 'system', senderName: str('system', language), senderAvatar: '🔓', type: 'text', content: str('sessionReopened', language), timestamp: Date.now()
  });
  await writeEvent(roomId, { kind: 'session_reopened', role: 'system', data: { by } });
  return true;
}

/** Each job id is created once, so a reminder or time-up can never be posted twice. */
async function queueJob(roomId, kind, extra = {}) {
  const id = `${roomId}__${kind}${extra.minutes ? `_${extra.minutes}` : ''}`;
  try {
    await jobRef(id).create({ roomId, kind, ...extra, createdAt: Date.now() });
    return true;
  } catch (err) {
    if (err?.code === 6) return false; // ALREADY_EXISTS
    throw err;
  }
}

/** Once a minute: auto-start fallback, reminders, time-up and idle end for every open session. */
export async function sessionTick() {
  const snap = await db().collection('rooms').where('session.phase', 'in', ['waiting', 'running']).get();
  const now = Date.now();
  for (const doc of snap.docs) {
    const roomId = doc.id;
    const room = doc.data();
    const s = room.session;
    try {
      if (s.phase === 'waiting') {
        if (now - (s.createdAt || room.createdAt || 0) < WAITING_TICK_MAX_AGE_MS) await maybeStartSession(roomId);
        continue;
      }

      if (s.endsAt) {
        const due = (await reminderMinutes(roomId)).filter(m => !(s.remindersSent || []).includes(m) && now >= s.endsAt - m * 60_000 && now < s.endsAt);
        if (due.length) {
          // A late tick may find several due at once: only the most urgent one is posted
          await roomRef(roomId).update({ 'session.remindersSent': FieldValue.arrayUnion(...due) });
          await queueJob(roomId, 'reminder', { minutes: Math.min(...due) });
        }
        if (now >= s.endsAt && !s.timeUpAt) {
          await roomRef(roomId).update({ 'session.timeUpAt': now });
          await writeEvent(roomId, { kind: 'session_time_up', role: 'system' });
          await queueJob(roomId, 'time_up');
        }
      }

      const online = await onlineParticipants(roomId, room.hostUid, now);
      if (online.length) {
        if (s.allOfflineSince) await roomRef(roomId).update({ 'session.allOfflineSince': null });
      } else if (!s.allOfflineSince) {
        await roomRef(roomId).update({ 'session.allOfflineSince': now });
      } else if (now - s.allOfflineSince >= IDLE_END_MS) {
        await endSession(roomId, 'all_offline');
      }
    } catch (err) {
      console.error('[sessionTick]', roomId, err?.message || err);
    }
  }
}

async function reminderMinutes(roomId) {
  const roomAi = await ensureRoomAi(roomId);
  return (roomAi.profile?.session?.reminderMinutes || []).map(Number).filter(m => m > 0);
}

// ---------- AI-written session messages ----------

async function writeSessionMessage({ apiKey, roomId, room, profile, memory, kind, minutes }) {
  const sys = await getSystemConfig();
  const model = sys.models.mentor;
  const language = room.language || 'zh-TW';
  const { messages, participants } = await fetchContext(roomId);
  const system = sessionMessagePrompt({ kind, profile, language, minutesLeft: minutes });
  const user = `Recent conversation:\n${buildTranscript(messages, participants) || '(no messages yet)'}${
    memory?.summary ? `\n\nYour memory of the session so far: ${memory.summary}` : ''}`;
  const startedAt = Date.now();
  const log = { kind: `session_${kind}`, roomId, model, promptVersion: PROMPT_VERSION, profileId: profile.id || null, profileVersion: profile.version ?? null, mode: profile.mode, input: { systemPrompt: system, userPrompt: user } };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await createMessage(apiKey, { model, max_tokens: 1000, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: user }] });
      let text = responseText(response).trim();
      if (!text) throw new Error('Empty response');
      // Kickoff with AI-suggested briefs: {"message", "topics"} -> message + poll
      let topics = [];
      if (kind === 'kickoff' && profile.session?.taskMode === 'ai_suggest') {
        const out = parseJsonObject(text);
        if (!out.message) throw new Error('No message in kickoff JSON');
        text = String(out.message).trim();
        topics = (Array.isArray(out.topics) ? out.topics : []).map(s => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 4);
      }
      const usage = response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null;
      await logAiCall({ ...log, output: { text, topics }, usage, latencyMs: Date.now() - startedAt });
      return { text, topics, meta: { model, promptVersion: PROMPT_VERSION, usage, profileId: profile.id || null, profileVersion: profile.version ?? null, session: kind } };
    } catch (err) {
      lastErr = err;
      await sleep(attempt * 4000);
    }
  }
  await logAiCall({ ...log, error: { message: String(lastErr?.message || lastErr).slice(0, 500) }, latencyMs: Date.now() - startedAt });
  return null;
}

/** sessionJobs/{id} trigger: kickoff (opening text + topic), reminder or time_up. */
export async function runSessionJob(job, secrets) {
  const { roomId, kind, minutes } = job;
  const roomAi = await ensureRoomAi(roomId);
  const profile = roomAi.profile;
  const room = (await roomRef(roomId).get()).data() || {};
  if (room.session?.phase !== 'running') return;

  if (profile.mode === 'none') {
    // Control condition: nothing but a neutral time-up notice
    if (kind === 'time_up') {
      await roomRef(roomId).collection('messages').add({
        senderUid: 'system', senderName: str('system', room.language), senderAvatar: '⏰', type: 'text', content: str('timeUp', room.language), timestamp: Date.now()
      });
    }
    return;
  }

  // Wait briefly for a running mentor check so the two never interleave
  let locked = false;
  let stopTyping = null;
  for (let i = 0; !locked && i < 10; i++) {
    locked = await acquireLock(roomId);
    if (!locked) await sleep(3000);
  }
  try {
    // The AI is shown typing while it writes the message
    stopTyping = startPresence(roomId, 'text');
    const openingText = localized(profile.session?.openingText, room.language).trim();
    if (kind === 'kickoff' && openingText) {
      await postAiMessage(roomId, room, profile, { content: openingText, meta: { session: 'opening_text', profileId: profile.id || null, profileVersion: profile.version ?? null } });
    }
    const out = await writeSessionMessage({ apiKey: secrets.anthropic, roomId, room, profile, memory: roomAi.memory, kind, minutes });
    if (!out) return;
    if ((await roomRef(roomId).get()).data()?.session?.phase !== 'running') return;
    await postAiMessage(roomId, room, profile, { content: out.text, actionOptions: out.topics || [], meta: out.meta });
    await db().doc(`roomAi/${roomId}`).set({
      state: { lastInterventionAt: Date.now() },
      memory: { aiHistory: [...(roomAi.memory?.aiHistory || []), { at: Date.now(), type: `session_${kind}`, text: out.text.slice(0, 300) }].slice(-20) }
    }, { merge: true });
  } finally {
    await stopTyping?.();
    if (locked) await releaseLock(roomId);
  }
}
