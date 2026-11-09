import assert from 'node:assert/strict';
import { restoreNavigation, navigationStorageKey } from '../frontend/src/services/codingNavigation.ts';

const state = { version: 1, history: [
  { key: 'r/1', phase: 1, ordinal: 1 }, { key: 'r/2', phase: 1, ordinal: 2 }, { key: 'r/3', phase: 1, ordinal: 3 },
], position: 2, queue: ['r/5', 'r/4'] };
const restore = (s, available = ['r/1', 'r/2', 'r/3', 'r/4', 'r/5']) => restoreNavigation(JSON.stringify(s), available);
const resumed = restore(state);
assert.equal(resumed.position, 2);
assert.equal(resumed.history[resumed.position - 1].key, 'r/2'); // Refresh on Q3, Previous still points at Q2.
assert.equal(restore({ ...state, position: 1 }).history[2].key, 'r/3'); // Forward history survives reentry too.
assert.equal(resumed.queue.pop(), 'r/4'); // Stable remaining order.
assert.deepEqual(restore(state, ['r/1', 'r/3', 'r/4', 'r/6']).queue, ['r/6', 'r/4']);
assert.equal(restore(state, ['r/1', 'r/2', 'r/4']).position, 1); // Current removed.
assert.equal(restore({ ...state, position: 3 }).position, 3); // Finished: Previous opens last item.
assert.equal(restore({ ...state, history: [{ key: 'r/1', phase: 2, ordinal: 1 }], position: 0 }).history[0].phase, 2);
assert.notEqual(navigationStorageKey('alice'), navigationStorageKey('bob'));
assert.notEqual(navigationStorageKey('alice', 'v1'), navigationStorageKey('alice', 'v2'));
assert.equal(restoreNavigation('{broken', []), null);
assert.equal(restore({ ...state, version: 9 }), null);
assert.equal(restore({ ...state, position: 99 }), null);
assert.deepEqual(restore(state, []).history, []);
console.log('Navigation tests passed: refresh, backward/forward, order, deleted/disabled candidates, exhausted, stages, account isolation, invalid storage.');
