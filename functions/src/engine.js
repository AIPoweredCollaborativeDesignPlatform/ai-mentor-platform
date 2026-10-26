import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { analyze, updateMemory } from './mentor.js';
import { generate3D } from './mesh3d.js';
import { getSystemConfig } from './config.js';
import { loadDefaultProfile, loadProfile, publicAiView } from './profiles.js';
import { logAiCall } from './log.js';

/**
 * Server-side AI activity manager: one decision-maker per room.
 *  - every participant message updates counters in roomAi/{roomId}.state
 *  - @mention → immediate response (unless the condition has no visible AI)
 *  - otherwise a check runs when the chat pauses (pauseSeconds, ≥ minNewMessages),
 *    after maxMessagesBetweenChecks, or after stallSeconds of silence
 *  - automatic checks are visible only in 'proactive' mode outside the cooldown;
 *    all other checks run as invisible shadow assessments (if enabled) for the research log
 * roomAi/{roomId} is server/admin-only; participants only see rooms/{id}.ai (publicAiView).
 */

const db = () => getFirestore();
const roomAiRef = roomId => db().doc(`roomAi/${roomId}`);
const roomRef = roomId => db().doc(`rooms/${roomId}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCK_MS = 150_000;
const CONTEXT_MESSAGES = 60;
const AI_UIDS = new Set(['ai_mentor', 'ai_mentor_3d', 'system']);

const EMPTY_STATE = { msgsSinceCheck: 0, msgsSinceMemory: 0, lastCheckAt: 0, lastInterventionAt: 0, lastMessageId: null, lastMessageAt: 0, lastStallMessageId: null, lockUntil: 0 };

/** Snapshots a profile into a room (frozen) and publishes the participant-safe view. */
export async function assignProfileToRoom(roomId, profile, assignedBy) {
  await roomAiRef(roomId).set({
    profileId: profile.id || null,
    profileVersion: profile.version ?? 0,
    profile,
    assignedAt: Date.now(),
    assignedBy: assignedBy || 'system'
  }, { merge: true });
  await roomRef(roomId).set({ ai: publicAiView(profile) }, { merge: true });
  await logAiCall({ kind: 'profile_assigned', roomId, profileId: profile.id || null, profileVersion: profile.version ?? 0, mode: profile.mode, assignedBy: assignedBy || 'system' });
}

export async function ensureRoomAi(roomId) {
  const snap = await roomAiRef(roomId).get();
  if (snap.exists && snap.data().profile) return snap.data();
  await assignProfileToRoom(roomId, await loadDefaultProfile(), 'system-default');
  return (await roomAiRef(roomId).get()).data();
}

export { loadProfile };

async function fetchContext(roomId) {
  const [roomSnap, msgSnap, partSnap] = await Promise.all([
    roomRef(roomId).get(),
    roomRef(roomId).collection('messages').orderBy('timestamp', 'desc').limit(CONTEXT_MESSAGES).get(),
    roomRef(roomId).collection('participants').get()
  ]);
  const messages = msgSnap.docs.reverse().map(d => {
    const m = d.data();
    return { id: d.id, senderUid: m.senderUid, senderName: m.senderName, content: String(m.content || '').slice(0, 1500), timestamp: m.timestamp, reactions: m.reactions || {}, actionOptions: m.actionOptions || [], pollVotes: m.pollVotes || {} };
  }).filter(m => m.senderUid !== 'system');
  const participants = Object.fromEntries(partSnap.docs.map(d => {
    const p = d.data();
    return [d.id, { uid: d.id, displayName: p.displayName, isHost: !!p.isHost, status: p.status }];
  }));
  return { room: roomSnap.data() || {}, messages, participants };
}

const isMentioned = (content, profile) => {
  const text = String(content || '').toLowerCase();
  const names = ['@mentor', ...Object.values(profile.displayName || {}).map(n => `@${String(n).toLowerCase()}`)];
  return names.some(n => text.includes(n));
};

// ---------- AI presence (typing doc must be refreshed: clients drop entries older than 5s) ----------
function startPresence(roomId, kind, task) {
  const uid = kind === 'mesh' ? 'ai_mentor_3d' : 'ai_mentor';
  const typingRef = roomRef(roomId).collection('typing').doc(uid);
  const write = () => typingRef.set({ uid, displayName: kind === 'mesh' ? 'AI (3D)' : 'AI', avatar: kind === 'mesh' ? '🎨' : '✨', timestamp: Date.now() }).catch(() => {});
  write();
  const timer = setInterval(write, 3000);
  if (task) roomRef(roomId).update({ aiActiveTask: { callerName: task.callerName || '', callerUid: task.callerUid || '', type: task.type, prompt: task.prompt || '', startedAt: Date.now() } }).catch(() => {});
  return async () => {
    clearInterval(timer);
    await typingRef.delete().catch(() => {});
    if (task) await roomRef(roomId).update({ aiActiveTask: null }).catch(() => {});
  };
}

async function acquireLock(roomId) {
  return db().runTransaction(async tx => {
    const snap = await tx.get(roomAiRef(roomId));
    const state = { ...EMPTY_STATE, ...(snap.data()?.state || {}) };
    if (state.lockUntil > Date.now()) return false;
    tx.set(roomAiRef(roomId), { state: { ...state, lockUntil: Date.now() + LOCK_MS } }, { merge: true });
    return true;
  });
}
const releaseLock = roomId => roomAiRef(roomId).set({ state: { lockUntil: 0 } }, { merge: true });

async function postAiMessage(roomId, room, profile, { content, assetType = null, assetPayload = null, actionOptions = [], meta }, replaceMessageId) {
  const language = room.language || 'zh-TW';
  const fields = {
    senderUid: 'ai_mentor',
    senderName: profile.displayName?.[language] || profile.displayName?.en || 'AI Mentor',
    senderAvatar: '✨',
    type: assetType ? 'ai_asset' : 'text',
    content,
    actionOptions: actionOptions || [],
    ...(assetType ? { assetType, assetPayload } : {}),
    metadata: { ai: meta || null }
  };
  const messages = roomRef(roomId).collection('messages');
  if (replaceMessageId) {
    await messages.doc(replaceMessageId).update(fields);
  } else {
    await messages.add({ ...fields, timestamp: Date.now() });
  }
  await roomRef(roomId).update({
    lastActive: Date.now(),
    lastMessage: { content: assetType ? '✨ AI Asset Generated' : String(content).slice(0, 100), senderName: fields.senderName, senderUid: 'ai_mentor', timestamp: Date.now() },
    ...(assetType ? { assetsCount: FieldValue.increment(1) } : {})
  }).catch(() => {});
}

/** Runs one check. `forced` = explicit mention or retry; otherwise reason is pause | stall | max_messages. */
export async function runCheck(roomId, secrets, { reason, forced = false, callerUid = null, callerName = '', retryMessageId = null }) {
  const roomAi = await ensureRoomAi(roomId);
  const profile = roomAi.profile;
  const state = { ...EMPTY_STATE, ...(roomAi.state || {}) };
  const cooldownOver = Date.now() - (state.lastInterventionAt || 0) >= (profile.triggers?.cooldownSeconds || 0) * 1000;
  const visible = forced ? profile.mode !== 'none' : profile.mode === 'proactive' && cooldownOver;
  const shadow = !visible && profile.shadowAssessment;

  if (!visible && !shadow) {
    await logAiCall({ kind: 'trigger_skip', roomId, reason: forced ? 'mention_in_no_ai_condition' : reason, detail: profile.mode === 'proactive' ? 'cooldown' : `mode=${profile.mode}`, mode: profile.mode });
    return;
  }

  // One check at a time per room; explicit requests wait briefly for a running check
  let locked = await acquireLock(roomId);
  for (let i = 0; !locked && forced && i < 10; i++) {
    await sleep(3000);
    locked = await acquireLock(roomId);
  }
  if (!locked) {
    await logAiCall({ kind: 'trigger_skip', roomId, reason, detail: 'check_already_running', mode: profile.mode });
    return;
  }

  const startedAt = Date.now();
  const stopPresence = visible && forced
    ? startPresence(roomId, 'text', { type: 'AI Mentor', callerName, callerUid, prompt: '' })
    : null;
  let pending3D = null;

  try {
    const { room, messages, participants } = await fetchContext(roomId);
    const out = await analyze({
      apiKey: secrets.anthropic,
      falKey: secrets.fal,
      roomId,
      room,
      messages,
      participants,
      profile,
      memory: roomAi.memory,
      forced,
      reason: shadow ? `${reason} (shadow${profile.mode === 'proactive' ? ', cooldown' : ''})` : reason,
      callerUid,
      visible
    });

    const latestRoom = (await roomRef(roomId).get()).data() || {};
    const aborted = (latestRoom.aiAbortAt || 0) > startedAt;
    const stateUpdate = { msgsSinceCheck: 0, lastCheckAt: Date.now() };
    const memoryUpdate = {};

    if (aborted) {
      await logAiCall({ kind: 'trigger_skip', roomId, reason, detail: 'aborted_by_user' });
    } else if (out.error) {
      if (visible && forced) await postAiMessage(roomId, room, profile, { content: `⚠️ AI Mentor: ${out.error.message}` }, retryMessageId);
    } else if (visible && out.result.shouldIntervene && out.result.aiMessage) {
      const { aiMessage, assetType, assetData, actionOptions } = out.result;
      if (assetType === 'parametric_3d') {
        // The mesh is generated after the lock is released; the instant parametric preview is the fallback
        pending3D = { aiMessage, assetData, prompt: assetData?.prompt3D || assetData?.title || 'product prototype', meta: out.meta, room };
      } else {
        await postAiMessage(roomId, room, profile, { content: aiMessage, assetType, assetPayload: assetData, actionOptions, meta: out.meta }, retryMessageId);
      }
      stateUpdate.lastInterventionAt = Date.now();
      memoryUpdate.aiHistory = [...(roomAi.memory?.aiHistory || []), { at: Date.now(), type: assetType || 'message', text: String(aiMessage).slice(0, 300) }].slice(-20);
    }

    // Long-term memory refresh
    const every = profile.memory?.updateEveryMessages || 0;
    if (every && state.msgsSinceMemory >= every) {
      const recent = messages.slice(-Math.min(state.msgsSinceMemory, CONTEXT_MESSAGES));
      const memory = await updateMemory({ apiKey: secrets.anthropic, roomId, previous: { ...(roomAi.memory || {}), ...memoryUpdate }, messages: recent, participants });
      if (memory) {
        Object.assign(memoryUpdate, memory);
        stateUpdate.msgsSinceMemory = 0;
      }
    }
    await roomAiRef(roomId).set({ state: stateUpdate, ...(Object.keys(memoryUpdate).length ? { memory: memoryUpdate } : {}) }, { merge: true });
  } finally {
    await stopPresence?.();
    await releaseLock(roomId);
  }

  if (pending3D) await run3D(roomId, profile, secrets, pending3D);
}

async function run3D(roomId, profile, secrets, { aiMessage, assetData, prompt, meta, room }) {
  const sys = await getSystemConfig();
  const stop = startPresence(roomId, 'mesh', { type: '3D Model Generation', prompt: String(prompt).slice(0, 100) });
  try {
    const res = await generate3D({ engine: sys.engine3D, prompt, keys: { meshy: secrets.meshy, tripo: secrets.tripo } });
    await logAiCall({ kind: 'model_3d', roomId, model: sys.engine3D, input: { prompt }, output: res });
    await postAiMessage(roomId, room, profile, {
      content: aiMessage,
      assetType: 'mesh_3d',
      assetPayload: { title: prompt, provider: res.provider, taskId: res.taskId, modelUrl: res.modelUrl, originalModelUrl: res.originalModelUrl, ...(res.thumbnailUrl ? { posterUrl: res.thumbnailUrl } : {}), isRefined: false, isInteractive: true },
      meta
    });
  } catch (err) {
    console.warn('[engine.run3D] falling back to parametric preview:', err?.message || err);
    await logAiCall({ kind: 'model_3d', roomId, model: sys.engine3D, input: { prompt }, error: { message: String(err?.message || err).slice(0, 500) } });
    await postAiMessage(roomId, room, profile, { content: aiMessage, assetType: 'parametric_3d', assetPayload: assetData, meta });
  } finally {
    await stop();
  }
}

/** Entry point for each new chat message (Firestore trigger). */
export async function handleNewMessage(roomId, messageId, msg, secrets) {
  if (AI_UIDS.has(msg.senderUid)) return;
  const room = (await roomRef(roomId).get()).data();
  if (!room?.appVersion) return; // legacy site rooms keep their own client-side AI

  const roomAi = await ensureRoomAi(roomId);
  const profile = roomAi.profile;
  const t = profile.triggers || {};

  const state = await db().runTransaction(async tx => {
    const snap = await tx.get(roomAiRef(roomId));
    const s = { ...EMPTY_STATE, ...(snap.data()?.state || {}) };
    s.msgsSinceCheck += 1;
    s.msgsSinceMemory += 1;
    s.lastMessageId = messageId;
    s.lastMessageAt = msg.timestamp || Date.now();
    tx.set(roomAiRef(roomId), { state: s }, { merge: true });
    return s;
  });

  if (isMentioned(msg.content, profile)) {
    return runCheck(roomId, secrets, { reason: 'mention', forced: true, callerUid: msg.senderUid, callerName: msg.senderName });
  }
  if (t.maxMessagesBetweenChecks && state.msgsSinceCheck >= t.maxMessagesBetweenChecks) {
    return runCheck(roomId, secrets, { reason: 'max_messages' });
  }

  // Wait for a pause; a newer message supersedes this handler (it will run its own wait)
  const latestState = async () => ({ ...EMPTY_STATE, ...((await roomAiRef(roomId).get()).data()?.state || {}) });
  const pauseMs = (t.pauseSeconds || 0) * 1000;
  await sleep(pauseMs);
  let s = await latestState();
  if (s.lastMessageId !== messageId) return;
  if (s.msgsSinceCheck >= (t.minNewMessages || 1)) {
    await runCheck(roomId, secrets, { reason: 'pause' });
  } else {
    await logAiCall({ kind: 'trigger_skip', roomId, reason: 'pause', detail: `below_min_new_messages (${s.msgsSinceCheck}/${t.minNewMessages})`, mode: profile.mode });
  }

  // Stall: continued silence after this message
  const stallMs = (t.stallSeconds || 0) * 1000;
  if (!stallMs || stallMs <= pauseMs) return;
  await sleep(stallMs - pauseMs);
  s = await latestState();
  if (s.lastMessageId !== messageId || s.lastStallMessageId === messageId) return;
  await roomAiRef(roomId).set({ state: { lastStallMessageId: messageId } }, { merge: true });
  await runCheck(roomId, secrets, { reason: 'stall' });
}
