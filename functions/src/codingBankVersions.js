import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { loadCodingBank, codingHuman } from './codingBank.js';
import { codingBankErrors } from './i18n.js';

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
export function snapshotBank(live, previous, versionId) {
  const before = new Map((previous?.rooms || []).map(r => [r.id, r]));
  const counts = { questions: 0, added: 0, changed: 0, reused: 0, removed: 0, semanticCovered: 0 };
  const present = new Set();
  const rooms = live.rooms.map(room => {
    const { completed, detailedCompleted, visits, disabled, selected, ...source } = room;
    const humans = room.messages.filter(codingHuman);
    const fingerprints = {}, revisions = {};
    const old = before.get(room.id);
    const covered = new Set();
    source.semantic = room.semantic.filter(batch => currentSemanticBatch(batch, humans));
    for (const batch of source.semantic) {
      for (const id of batch.targetIds || []) covered.add(id);
    }
    humans.forEach((m, i) => {
      present.add(`${room.id}/${m.id}`);
      // Changes to any human text, identity, order, or timestamp in the ±5 window need a new judgment.
      fingerprints[m.id] = hash({ policy: 'human-before-after-5-v1', target: m.id,
        messages: humans.slice(Math.max(0, i - 5), i + 6).map(x => [x.id, x.senderUid, x.senderName || '', x.timestamp, x.content]) });
      if (!previous) { revisions[m.id] = ''; counts.reused++; } // First snapshot establishes the legacy baseline.
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
  if (!meta || meta.status !== 'ready') fail('failed-precondition', 'unavailable');
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
export async function createBankVersion(uid, requestId, note = '', db = getFirestore()) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId) || typeof note !== 'string' || note.length > 300) fail('invalid-argument', 'request');
  const ref = versionRef(db, requestId), stateRef = db.doc('codingBankState/current');
  const reservation = await db.runTransaction(async tx => {
    const [current, existing] = await Promise.all([tx.get(stateRef), tx.get(ref)]);
    if (existing.data()?.status === 'ready') return { ready: { id: ref.id, ...existing.data() } };
    const state = current.data() || {};
    if (state.buildUntil > Date.now()) fail('aborted', 'building');
    const sequence = (state.sequence || 0) + 1;
    const meta = { sequence, status: 'building', createdBy: uid, startedAt: Date.now(), note, parentVersion: state.latestVersion || '' };
    tx.set(stateRef, { sequence, buildId: ref.id, buildUntil: Date.now() + 10 * 60000 }, { merge: true });
    tx.set(ref, meta);
    return { meta };
  });
  if (reservation.ready) return reservation.ready;
  try {
    const previous = reservation.meta.parentVersion ? (await readBankVersion(reservation.meta.parentVersion, db)).bank : null;
    const live = await loadCodingBank(null, db);
    const { bank, counts, roomCount } = snapshotBank(live, previous, ref.id);
    const parts = snapshotParts(bank);
    for (let start = 0; start < parts.length; start += 100) {
      const batch = db.batch();
      parts.slice(start, start + 100).forEach((payload, i) => batch.set(ref.collection('parts').doc(String(start + i).padStart(6, '0')), { index: start + i, payload }));
      await batch.commit();
    }
    // A retry of an interrupted build may produce fewer parts than the earlier attempt.
    const staleParts = (await ref.collection('parts').get()).docs.filter(d => d.data().index >= parts.length);
    for (let start = 0; start < staleParts.length; start += 100) {
      const cleanup = db.batch();
      staleParts.slice(start, start + 100).forEach(d => cleanup.delete(d.ref));
      await cleanup.commit();
    }
    const ready = { ...reservation.meta, status: 'ready', completedAt: Date.now(), counts, roomCount, parts: parts.length,
      digest: hash(parts.join('')), samplingPolicy: 'event-round-robin-v2', contextPolicy: 'human-before-after-5-v1' };
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
    if (meta?.status !== 'ready') fail('failed-precondition', 'unavailable');
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
    const targets = room.messages.filter(codingHuman);
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
