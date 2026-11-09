import assert from 'node:assert/strict';
import { loadCodingBank } from '../functions/src/codingBank.js';

const fixture = {
  'rooms/room_1234': { name: 'Test' },
  'rooms/room_9999': { deletedAt: 1 },
  'rooms/room_1234/messages/m1': { type: 'text', senderUid: 'human', timestamp: 1, content: 'Idea' },
  'rooms/room_1234/messages/a1': { type: 'text', senderUid: 'ai_mentor', timestamp: 2, content: 'Reply', assetPayload: 'large' },
  'aiLogs/log1': { roomId: 'room_1234', kind: 'mentor', triggerMessageId: 'm1', output: { shouldIntervene: true, rawText: 'private reasoning' }, input: { userPrompt: 'large prompt' } },
  'rooms/room_1234/events/e1': { kind: 'board_object_updated', at: 2, data: { fabric: 'large object' } },
  'codingRooms/room_1234/items/m1': { replyId: 'a1' },
  'codingRooms/room_1234/items/m1/ratings/me': { status: 'submitted' },
  'codingRooms/room_1234/items/m1/ratings/other': { status: 'draft' },
  'codingRooms/room_1234/items/m1/detailedRatings/me': { status: 'submitted' },
  'codingQuestionControls/room_1234/items/m1': { enabled: false, updatedBy: 'admin' },
};
const reads = [];
function project(data, fields) {
  if (!fields) return data;
  const out = {};
  for (const field of fields) {
    const keys = field.split('.');
    const value = keys.reduce((v, k) => v?.[k], data);
    if (value === undefined) continue;
    let target = out;
    for (const key of keys.slice(0, -1)) target = target[key] ||= {};
    target[keys.at(-1)] = value;
  }
  return out;
}
class Ref {
  constructor(path, fields, filter) { this.path = path; this.fields = fields; this.filter = filter; this.id = path.split('/').at(-1); }
  get parent() { return new Ref(this.path.split('/').slice(0, -1).join('/')); }
  collection(id) { return new Ref(`${this.path}/${id}`); }
  doc(id) { return new Ref(`${this.path}/${id}`); }
  select(...fields) { return new Ref(this.path, fields, this.filter); }
  where(key, op, value) { assert.equal(op, '=='); return new Ref(this.path, this.fields, [key, value]); }
  orderBy() { return this; }
  async get() {
    reads.push(this.path);
    const docs = Object.entries(fixture).filter(([path, data]) => path.startsWith(this.path + '/') && path.split('/').length === this.path.split('/').length + 1 && (!this.filter || data[this.filter[0]] === this.filter[1]));
    return { docs: docs.map(([path, data]) => ({ id: path.split('/').at(-1), data: () => project(data, this.fields) })) };
  }
}
const batches = [];
const db = {
  collection: path => new Ref(path),
  async getAll(...args) {
    const options = args.pop(); assert.ok(options.fieldMask.includes('status'));
    batches.push(args.map(r => r.path));
    return args.map(ref => ({ ref, data: () => fixture[ref.path] && project(fixture[ref.path], options.fieldMask) }));
  },
};
const bank = await loadCodingBank('me', db);
assert.equal(bank.rooms.length, 1);
assert.deepEqual(bank.rooms[0].completed, ['m1']);
assert.deepEqual(bank.rooms[0].disabled, ['m1']);
assert.deepEqual(bank.rooms[0].selected, ['m1']);
assert.deepEqual(bank.rooms[0].detailedCompleted, ['m1']);
assert.equal(batches.flat().every(path => path.endsWith('/me')), true);
assert.equal(batches.flat().length, 2); // Human target only; no reads for AI messages or other reviewers.
assert.equal(reads.some(path => path.includes('room_9999/')), false);
assert.equal(JSON.stringify(bank).includes('large'), false);
assert.equal(JSON.stringify(bank).includes('private reasoning'), false);
assert.equal(bank.rooms[0].logs[0].output.shouldIntervene, true);
assert.deepEqual(bank.rooms[0].visits, [{ id: 'm1', at: 0 }]);
fixture['codingQuestionControls/room_1234/items/m1'].enabled = true;
assert.deepEqual((await loadCodingBank('me', db)).rooms[0].disabled, []);
delete fixture['codingRooms/room_1234/items/m1/ratings/me'];
delete fixture['codingRooms/room_1234/items/m1/detailedRatings/me'];
assert.deepEqual((await loadCodingBank('me', db)).rooms[0].completed, []);
console.log('Coding bank tests passed: field projection, caller isolation, progress, missing answers, deleted rooms.');
