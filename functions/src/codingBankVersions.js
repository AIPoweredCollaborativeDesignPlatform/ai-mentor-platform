import { codingTarget, mediaWindow, mediaEvidence, hasCodingMedia } from './codingMedia.js';
import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { loadCodingBank, codingHuman } from './codingBank.js';
import { codingBankErrors } from './i18n.js';
import { chooseQuestions } from './codingSelection.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, key) => { throw new HttpsError(code, codingBankErrors[key]); };
const versionRef = (db, id) => db.collection('codingBankVersions').doc(id);
const itemRef = (db, room, message, revision = '') => {
  const ref = db.doc(`codingRooms/${room}/items/${message}`);
  return revision ? ref.collection('revisions').doc(revision) : ref;
};
function currentSemanticBatch(batch, humans) {
  if (batch.version !== 'coding-events-v1' || !Array.isArray(batch.targetIds) || !batch.targetIds.length) return false;
  const start = humans.findIndex(m => m.id === batch.targetIds[0]);
  if (start < 0) return false;
  const targets = humans.slice(start, start + 30).map(m => m.id);
  const context = humans.slice(Math.max(0, start - 5), start + 35).map(m => ({ id: m.id, content: m.content.slice(0, 4000) }));
  return JSON.stringify(targets) === JSON.stringify(batch.targetIds) && Array.isArray(batch.inputMessages)
    && context.length === batch.inputMessages.length
    && context.every((message, i) => message.id === batch.inputMessages[i]?.id && message.content === batch.inputMessages[i]?.content);
}
// Preserve immutable source data, excluding reviewer-specific progress and live availability.
export function snapshotBank(live, previous, versionId, resetAnswers = false) {
  const before = new Map((previous?.rooms || []).map(r => [r.id, r]));
  const counts = { questions: 0, added: 0, changed: 0, reused: 0, removed: 0, semanticCovered: 0 };
  const present = new Set();
  const rooms = live.rooms.map(room => {
    const { completed, detailedCompleted, visits, disabled, selected, ...source } = room;
    const humans = room.messages.filter(room.mediaPolicy ? codingTarget : codingHuman);
    const fingerprints = {}, revisions = {};
    const old = before.get(room.id);
    const covered = new Set();
    source.semantic = room.semantic.filter(batch => currentSemanticBatch(batch, room.messages.filter(codingHuman)));
    for (const batch of source.semantic) {
      for (const id of batch.targetIds || []) covered.add(id);
    }
    humans.forEach((m, i) => {
      present.add(`${room.id}/${m.id}`);
      // Changes to any human text, identity, order, or timestamp in the ±5 window need a new judgment.
      fingerprints[m.id] = room.mediaPolicy && mediaWindow(room.messages, m.id).some(hasCodingMedia) ? hash({ policy: 'multimodal-v1', evidence: mediaWindow(room.messages, m.id).map(mediaEvidence), target: m.id }) : hash({ policy: 'human-before-after-5-v1', target: m.id,
        messages: humans.slice(Math.max(0, i - 5), i + 6).map(x => [x.id, x.senderUid, x.senderName || '', x.timestamp, x.content]) });
      if (resetAnswers) { revisions[m.id] = versionId; counts.added++; }
      else if (!previous) { revisions[m.id] = ''; counts.reused++; } // First snapshot establishes the legacy baseline.
      else if (old?.fingerprints?.[m.id] === fingerprints[m.id]) { revisions[m.id] = old.revisions[m.id]; counts.reused++; }
      else { revisions[m.id] = versionId; if (old?.fingerprints?.[m.id]) counts.changed++; else counts.added++; }
      if (covered.has(m.id)) counts.semanticCovered++;
      counts.questions++;
    });
    return { ...source, fingerprints, revisions };
  });
  for (const room of previous?.rooms || []) for (const id of Object.keys(room.fingerprints || {})) if (!present.has(`${room.id}/${id}`)) counts.removed++;
  return { bank: { rooms }, counts, roomCount: rooms.filter(r => Object.keys(r.fingerprints).length).length };
}

// Keep each Firestore document well below 1 MiB, including multibyte text.
export function snapshotParts(bank) {
  const json = JSON.stringify(bank);
  const parts = []; let part = '', bytes = 0;
  for (const character of json) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 350000) { parts.push(part); part = ''; bytes = 0; }
    part += character; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}
export async function readBankVersion(id, db = getFirestore()) {
  const ref = versionRef(db, id), meta = (await ref.get()).data();
  if (!meta || meta.status !== 'ready' || meta.deletedAt) fail('failed-precondition', 'unavailable');
  const parts = (await ref.collection('parts').orderBy('index').get()).docs;
  if (parts.length !== meta.parts) fail('data-loss', 'incomplete');
  const json = parts.map(d => d.data().payload).join('');
  if (hash(json) !== meta.digest) fail('data-loss', 'incomplete');
  return { meta: { id, ...meta }, bank: JSON.parse(json) };
}
export async function listBankVersions(db = getFirestore()) {
  const [state, versions] = await Promise.all([db.doc('codingBankState/current').get(), db.collection('codingBankVersions').orderBy('sequence', 'desc').get()]);
  return { activeVersion: state.data()?.activeVersion || '', versions: versions.docs.map(d => ({ id: d.id, ...d.data() })) };
}
export async function setBankDeleted(uid, id, deleted, db = getFirestore()) {
  const stateRef = db.doc('codingBankState/current'), ref = versionRef(db, id);
  await db.runTransaction(async tx => {
    const [state, version] = await Promise.all([tx.get(stateRef), tx.get(ref)]);
    if (version.data()?.status !== 'ready' || (deleted && state.data()?.activeVersion === id)) fail('failed-precondition', 'unavailable');
    tx.set(ref, { deletedAt: deleted ? Date.now() : 0, deletedBy: uid }, { merge: true });
    if (deleted && state.data()?.latestVersion === id) tx.set(stateRef, { latestVersion: state.data()?.activeVersion || '' }, { merge: true });
  });
  return { deleted };
}
export async function estimateQuestions(roomIds = null, db = getFirestore()) {
  if (roomIds && (!Array.isArray(roomIds) || !roomIds.length || !roomIds.every(id => /^room_\d{4,6}$/.test(id)))) fail('invalid-argument', 'request');
  const live = await loadCodingBank(null, db, roomIds);
  const available = live.rooms.reduce((sum, room) => sum + room.messages.filter(m => codingTarget(m) && !(room.disabled || []).includes(m.id)).length, 0);
  return { available, recommended: Math.min(60, available) };
}
export async function createBankVersion(uid, requestId, note = '', db = getFirestore(), resetAnswers = false, selection = null, questionCount = null) {
  if (questionCount !== null && (!Number.isInteger(questionCount) || questionCount < 1)) fail('invalid-argument', 'request');
  if (selection && (!/^[a-zA-Z0-9-]{16,80}$/.test(selection.baseVersion || '') || !Array.isArray(selection.roomIds)
    || !selection.roomIds.length || selection.roomIds.length > 100 || new Set(selection.roomIds).size !== selection.roomIds.length
    || !selection.roomIds.every(id => typeof id === 'string' && /^room_\d{4,6}$/.test(id)))) fail('invalid-argument', 'request');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId) || typeof note !== 'string' || note.length > 300) fail('invalid-argument', 'request');
  const ref = versionRef(db, requestId), stateRef = db.doc('codingBankState/current');
  const reservation = await db.runTransaction(async tx => {
    const [current, existing] = await Promise.all([tx.get(stateRef), tx.get(ref)]);
    if (existing.data()?.status === 'ready') return { ready: { id: ref.id, ...existing.data() } };
    const state = current.data() || {};
    if (state.buildUntil > Date.now()) fail('aborted', 'building');
    const sequence = (state.sequence || 0) + 1;
    const meta = { sequence, status: 'building', createdBy: uid, startedAt: Date.now(), note, parentVersion: selection?.baseVersion || state.latestVersion || '', resetAnswers,
      questionCount, ...(selection ? { addedRoomIds: selection.roomIds, mode: 'append-rooms' } : {}) };
    tx.set(stateRef, { sequence, buildId: ref.id, buildUntil: Date.now() + 10 * 60000 }, { merge: true });
    tx.set(ref, meta);
    return { meta };
  });
  if (reservation.ready) return reservation.ready;
  try {
    const previous = reservation.meta.parentVersion ? (await readBankVersion(reservation.meta.parentVersion, db)).bank : null;
    const selectedRooms = reservation.meta.addedRoomIds || null;
    if (selectedRooms?.some(id => previous.rooms.some(room => room.id === id && Object.keys(room.fingerprints || {}).length))) fail('failed-precondition', 'request');
    const live = await loadCodingBank(null, db, selectedRooms);
    if (selectedRooms && live.rooms.some(room => !room.messages.some(codingTarget))) fail('failed-precondition', 'request');
    const { bank, counts } = snapshotBank(live, selectedRooms ? { rooms: [] } : previous, ref.id, reservation.meta.resetAnswers);
    if (reservation.meta.questionCount !== null) for (const room of bank.rooms) {
      const disabled = live.rooms.find(r => r.id === room.id)?.disabled || [];
      for (const id of disabled) { delete room.fingerprints[id]; delete room.revisions[id]; }
    }
    const availableQuestions = bank.rooms.reduce((sum, room) => sum + Object.keys(room.fingerprints).length, 0);
    if (reservation.meta.questionCount !== null) {
      try { chooseQuestions(bank, reservation.meta.questionCount, ref.id); } catch { fail('invalid-argument', 'request'); }
      counts.questions = 0; counts.added = 0; counts.changed = 0; counts.reused = 0; counts.semanticCovered = 0;
      for (const room of bank.rooms) for (const id of room.questionIds) {
        counts.questions++;
        const old = selectedRooms ? null : previous?.rooms.find(r => r.id === room.id);
        if (room.revisions[id] !== ref.id) counts.reused++;
        else if (old?.fingerprints[id]) counts.changed++; else counts.added++;
        if (room.semantic.some(b => b.targetIds?.includes(id))) counts.semanticCovered++;
      }
      counts.removed = selectedRooms ? 0 : (previous?.rooms || []).reduce((sum, old) => sum + Object.keys(old.fingerprints).filter(id => !bank.rooms.find(r => r.id === old.id)?.fingerprints[id]).length, 0);
    }
    if (selectedRooms) {
      bank.rooms.unshift(...previous.rooms.filter(room => !selectedRooms.includes(room.id)));
      for (const room of previous.rooms) {
        const humans = room.messages.filter(m => (room.mediaPolicy ? codingTarget(m) : codingHuman(m)) && (!room.questionIds || room.questionIds.includes(m.id)));
        counts.questions += humans.length; counts.reused += humans.length;
        const covered = new Set(room.semantic.filter(b => currentSemanticBatch(b, room.messages.filter(codingHuman))).flatMap(b => b.targetIds));
        counts.semanticCovered += humans.filter(m => covered.has(m.id)).length;
      }
    }
    const roomCount = bank.rooms.filter(r => Object.keys(r.fingerprints).length).length;
    const parts = snapshotParts(bank);
    for (let start = 0; start < parts.length; start += 20) {
      const batch = db.batch();
      parts.slice(start, start + 20).forEach((payload, i) => batch.set(ref.collection('parts').doc(String(start + i).padStart(6, '0')), { index: start + i, payload }));
      await batch.commit();
    }
    // A retry of an interrupted build may produce fewer parts than the earlier attempt.
    const staleParts = (await ref.collection('parts').get()).docs.filter(d => d.data().index >= parts.length);
    for (let start = 0; start < staleParts.length; start += 100) {
      const cleanup = db.batch();
      staleParts.slice(start, start + 100).forEach(d => cleanup.delete(d.ref));
      await cleanup.commit();
    }
    const ready = { ...reservation.meta, availableQuestions, status: 'ready', completedAt: Date.now(), counts, roomCount, parts: parts.length,
      digest: hash(parts.join('')), samplingPolicy: 'event-round-robin-v2', contextPolicy: bank.rooms.some(r => r.mediaPolicy) ? 'mixed-multimodal-v1' : 'human-before-after-5-v1' };
    await db.runTransaction(async tx => {
      const state = (await tx.get(stateRef)).data();
      if (state?.buildId !== ref.id) fail('aborted', 'building');
      tx.set(ref, ready);
      tx.set(stateRef, { latestVersion: ref.id, buildUntil: 0, buildId: '' }, { merge: true });
    });
    return { id: ref.id, ...ready };
  } catch (error) {
    await db.runTransaction(async tx => {
      const [current, version] = await Promise.all([tx.get(stateRef), tx.get(ref)]);
      if (version.data()?.status !== 'ready') tx.set(ref, { status: 'failed' }, { merge: true });
      if (current.data()?.buildId === ref.id) tx.set(stateRef, { buildUntil: 0, buildId: '' }, { merge: true });
    });
    throw error;
  }
}
export async function activateBankVersion(uid, id, db = getFirestore()) {
  const stateRef = db.doc('codingBankState/current');
  await db.runTransaction(async tx => {
    const meta = (await tx.get(versionRef(db, id))).data();
    if (meta?.status !== 'ready' || meta.deletedAt) fail('failed-precondition', 'unavailable');
    tx.set(stateRef, { activeVersion: id, activatedBy: uid, activatedAt: Date.now() }, { merge: true });
    tx.set(stateRef.collection('activations').doc(), { versionId: id, by: uid, at: Date.now() });
  });
  return { activeVersion: id };
}
async function readMany(db, refs) {
  const docs = [];
  for (let i = 0; i < refs.length; i += 200) docs.push(...await db.getAll(...refs.slice(i, i + 200)));
  return docs;
}
export async function loadVersionedBank(uid, requested, admin, db = getFirestore()) {
  if (requested === 'live' && !admin) fail('permission-denied', 'admin');
  const activeVersion = (await db.doc('codingBankState/current').get()).data()?.activeVersion || '';
  const id = requested === 'live' ? '' : requested || activeVersion;
  if (!id) return { ...await loadCodingBank(uid, db), version: null, activeVersion };
  const { bank, meta } = await readBankVersion(id, db);
  for (let i = 0; i < bank.rooms.length; i += 4) await Promise.all(bank.rooms.slice(i, i + 4).map(async room => {
    const targets = room.messages.filter(m => (room.mediaPolicy ? codingTarget(m) : codingHuman(m)) && (!room.questionIds || room.questionIds.includes(m.id)));
    const refs = targets.map(m => itemRef(db, room.id, m.id, room.revisions[m.id]));
    const [cases, ratings, controls] = await Promise.all([
      readMany(db, refs), readMany(db, refs.map(ref => ref.collection('ratings').doc(uid))),
      db.collection(`codingQuestionControls/${room.id}/items`).get(),
    ]);
    room.selected = []; room.completed = []; room.visits = [];
    cases.forEach((doc, index) => { if (doc.data()?.replyId && room.messages.some(m => m.id === doc.data().replyId)) room.selected.push(targets[index].id); });
    ratings.forEach((doc, index) => { const a = doc.data(); if (a?.status === 'submitted') {
      room.completed.push(targets[index].id); room.visits.push({ id: targets[index].id, at: a.source?.sampledAt || a.updatedAt || 0 });
    } });
    const details = await readMany(db, room.selected.map(message => itemRef(db, room.id, message, room.revisions[message]).collection('detailedRatings').doc(uid)));
    room.detailedCompleted = details.flatMap((doc, index) => doc.data()?.status === 'submitted' ? [room.selected[index]] : []);
    room.disabled = controls.docs.filter(d => d.data().enabled === false).map(d => d.id);
  }));
  return { ...bank, version: meta, activeVersion };
}
