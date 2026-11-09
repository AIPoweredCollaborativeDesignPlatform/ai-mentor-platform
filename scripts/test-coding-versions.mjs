import assert from 'node:assert/strict';
import { snapshotBank, snapshotParts, createBankVersion, activateBankVersion, loadVersionedBank, readBankVersion } from '../functions/src/codingBankVersions.js';

const human = (id, timestamp = 1) => ({ id, senderUid: 'human', senderName: 'Designer', type: 'text', content: id, timestamp });
const room = { id: 'room_1234', name: 'Test', messages: Array.from({ length: 12 }, (_, i) => human(`m${i}`, i)), semantic: [], logs: [], events: [], completed: ['m1'], visits: [{ id: 'm1', at: 3 }], disabled: ['m1'] };
const baseline = snapshotBank({ rooms: [room] }, null, 'baseline');
assert.equal(baseline.counts.questions, 12);
assert.equal(baseline.bank.rooms[0].completed, undefined); // Snapshots never freeze one reviewer's status.
assert.equal(baseline.bank.rooms[0].disabled, undefined); // Availability is a live admin control.
assert.equal(baseline.bank.rooms[0].revisions.m1, ''); // Legacy answers retained.
const analyzed = { ...room, semantic: [{ version: 'coding-events-v1', targetIds: room.messages.map(m => m.id), inputMessages: room.messages.map(m => ({ id: m.id, content: m.content })), events: [] }] };
assert.equal(snapshotBank({ rooms: [analyzed] }, null, 'analysis').counts.semanticCovered, 12);
const reorderedCache = structuredClone(analyzed);
reorderedCache.semantic[0].inputMessages = reorderedCache.semantic[0].inputMessages.map(m => ({ content: m.content, id: m.id }));
assert.equal(snapshotBank({ rooms: [reorderedCache] }, null, 'analysis').counts.semanticCovered, 12); // Firestore may reorder map keys.
assert.equal(snapshotBank({ rooms: [{ ...analyzed, messages: [...room.messages, human('extra', 20)] }] }, null, 'analysis').counts.semanticCovered, 0); // Appended context invalidates old partial-batch coverage.
const newRoom = { ...room, id: 'room_5678', messages: [human('n1')] };
const latest = { rooms: [{ ...room, messages: [...room.messages, human('m12', 12), { ...human('ai', 13), senderUid: 'ai_mentor' }] }, newRoom] };
const updated = snapshotBank(latest, baseline.bank, 'version2');
assert.equal(updated.counts.added, 2);
assert.equal(updated.counts.changed, 5); // Last five earlier windows gain the new human message.
assert.equal(updated.bank.rooms[0].revisions.m1, '');
assert.equal(updated.bank.rooms[0].revisions.m11, 'version2');
assert.equal(updated.bank.rooms[0].fingerprints.ai, undefined);
const same = snapshotBank(latest, updated.bank, 'version3');
assert.equal(same.counts.changed, 0);
assert.equal(same.bank.rooms[0].revisions.m11, 'version2');
const edited = structuredClone(latest); edited.rooms[0].messages[1].content = 'changed';
assert.ok(snapshotBank(edited, updated.bank, 'edited').counts.changed > 0);
assert.equal(snapshotBank({ rooms: [] }, updated.bank, 'removed').counts.removed, 14);
const big = { text: '漢字🙂'.repeat(150000) }, parts = snapshotParts(big);
assert.ok(parts.length > 1 && parts.every(p => Buffer.byteLength(p) <= 350000));
assert.deepEqual(JSON.parse(parts.join('')), big);

// Exercise complete create / activate / read flows against a deterministic in-memory Firestore.
const records = new Map([
  ['rooms/room_1234', { name: 'Test' }],
  ['rooms/room_1234/messages/m1', human('m1')],
  ['codingRooms/room_1234/items/m1/ratings/me', { status: 'submitted', source: { sampledAt: 5 } }],
]);
let auto = 0;
class Ref {
  constructor(path, sort) { this.path = path; this.sort = sort; this.id = path.split('/').at(-1); }
  get parent() { return new Ref(this.path.split('/').slice(0, -1).join('/')); }
  doc(id = `auto${++auto}`) { return new Ref(`${this.path}/${id}`); }
  collection(id) { return this.doc(id); }
  select() { return this; }
  where() { return this; }
  orderBy(key) { return new Ref(this.path, key); }
  async get() {
    if (this.path.split('/').length % 2 === 0) return snap(this.path);
    const docs = [...records.keys()].filter(path => path.startsWith(this.path + '/') && path.split('/').length === this.path.split('/').length + 1).map(snap);
    if (this.sort) docs.sort((a, b) => (a.data()[this.sort] || 0) - (b.data()[this.sort] || 0));
    return { docs };
  }
  async set(data, opts) { records.set(this.path, { ...(opts?.merge ? records.get(this.path) : {}), ...structuredClone(data) }); }
}
function snap(path) { return { ref: new Ref(path), id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) }; }
const db = {
  doc: path => new Ref(path), collection: path => new Ref(path),
  getAll: async (...refs) => refs.filter(r => r instanceof Ref).map(r => snap(r.path)),
  async runTransaction(fn) { const actions = []; const result = await fn({ get: ref => ref.get(), set: (ref, data, opts) => actions.push(() => ref.set(data, opts)) }); for (const action of actions) await action(); return result; },
  batch() { const actions = []; return { set: (ref, data) => actions.push(() => ref.set(data)), delete: ref => actions.push(() => records.delete(ref.path)), commit: async () => { for (const action of actions) await action(); } }; },
};
const first = await createBankVersion('admin', 'version-00000000001', 'baseline', db);
assert.equal(first.sequence, 1);
assert.equal((await createBankVersion('admin', first.id, 'retry', db)).sequence, 1); // Idempotent retries.
assert.equal(records.get('codingBankState/current').activeVersion, undefined); // Creation does not change the live assignment.
await activateBankVersion('admin', first.id, db);
assert.deepEqual((await loadVersionedBank('me', undefined, false, db)).rooms[0].completed, ['m1']);
records.set('rooms/room_1234/messages/m2', human('m2', 2));
assert.equal((await loadVersionedBank('me', undefined, false, db)).rooms[0].messages.length, 1); // Active snapshot stays frozen.
const second = await createBankVersion('admin', 'version-00000000002', '', db);
assert.equal(second.counts.added, 1);
assert.equal(second.counts.changed, 1);
await activateBankVersion('admin', second.id, db);
const secondBank = await loadVersionedBank('me', undefined, false, db);
assert.deepEqual(secondBank.rooms[0].completed, []); // Changed context cannot count the old answer.
assert.equal(records.get('codingRooms/room_1234/items/m1/ratings/me').status, 'submitted'); // Original answers untouched.
await activateBankVersion('admin', first.id, db);
assert.deepEqual((await loadVersionedBank('me', undefined, false, db)).rooms[0].completed, ['m1']);
await assert.rejects(loadVersionedBank('me', 'live', false, db));
records.set('codingBankVersions/not-ready', { status: 'building' });
await assert.rejects(activateBankVersion('admin', 'not-ready', db));
records.set(`codingBankVersions/${first.id}/parts/000000`, { index: 0, payload: 'corrupt' });
await assert.rejects(readBankVersion(first.id, db));
console.log('Version tests passed: latest rooms/messages, context changes, unchanged answer reuse, immutable snapshots, Unicode chunking, idempotency, activation/rollback, failed version protection, observer access, integrity.');
