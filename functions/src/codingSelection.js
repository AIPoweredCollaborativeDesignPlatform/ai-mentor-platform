import { hasCodingMedia } from './codingMedia.js';
import { createHash } from 'node:crypto';
export const targetIds = room => Object.keys(room.fingerprints || {});
export function chooseQuestions(bank, count, seed) {
  const candidates = bank.rooms.flatMap(room => {
    const ids = targetIds(room), eligible = new Set(ids);
    const anchorAt = at => { let found = null; for (const m of room.messages) if (eligible.has(m.id) && m.timestamp <= at) found = m.id; return found; };
    const intervention = new Set(room.logs.filter(log => log.kind === 'mentor' && !log.error && log.visible !== false && log.output?.shouldIntervene === true).map(log => anchorAt(room.messages.find(m => m.id === log.triggerMessageId)?.timestamp)));
    const semantic = new Set(room.semantic.flatMap(batch => (batch.events || []).map(e => e.messageId)));
    const tool = new Set(room.events.filter(e => /board|whiteboard|imageboard|moodboard|model_?3d/i.test(e.kind || '')).map(e => anchorAt(e.at)));
    for (const m of room.messages) if (hasCodingMedia(m)) tool.add(anchorAt(m.timestamp));
    return ids.map(id => ({ room, id, kinds: new Set(['random', ...(intervention.has(id) ? ['intervention'] : []), ...(semantic.has(id) ? ['semantic'] : []), ...(tool.has(id) ? ['tool'] : [])]), rank: createHash('sha256').update(`${seed}/${room.id}/${id}`).digest('hex') }));
  });
  if (!Number.isInteger(count) || count < 1 || count > candidates.length) throw new RangeError('question-count');
  const groups = ['intervention', 'semantic', 'tool', 'random'].map(kind => candidates.filter(item => item.kinds.has(kind)).sort((a, b) => a.rank.localeCompare(b.rank)));
  const selected = new Set();
  while (selected.size < count) for (const group of groups) {
    let item = group.shift();
    while (item && selected.has(`${item.room.id}/${item.id}`)) item = group.shift();
    if (item) selected.add(`${item.room.id}/${item.id}`);
    if (selected.size === count) break;
  }
  for (const room of bank.rooms) {
    const ids = targetIds(room).filter(id => selected.has(`${room.id}/${id}`));
    room.questionIds = ids;
    room.fingerprints = Object.fromEntries(ids.map(id => [id, room.fingerprints[id]]));
    room.revisions = Object.fromEntries(ids.map(id => [id, room.revisions[id]]));
  }
  return bank;
}
