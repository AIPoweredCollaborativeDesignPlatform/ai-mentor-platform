import { getFirestore } from 'firebase-admin/firestore';
import { readBankVersion } from './codingBankVersions.js';
import { codingHuman } from './codingBank.js';

export const exportCsvCell = value => {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export async function buildCodingExport(versionId, db = getFirestore()) {
  const { meta, bank } = await readBankVersion(versionId, db);
  const startedAt = Date.now(), questions = [], answers = [];
  for (const room of bank.rooms) {
    const humans = room.messages.filter(codingHuman);
    for (let start = 0; start < humans.length; start += 5) await Promise.all(humans.slice(start, start + 5).map(async message => {
      const i = humans.findIndex(m => m.id === message.id);
      const revision = room.revisions[message.id] || '';
      const base = db.doc(`codingRooms/${room.id}/items/${message.id}${revision ? '/revisions/' + revision : ''}`);
      const [phase1, phase2, selected] = await Promise.all([base.collection('ratings').get(), base.collection('detailedRatings').get(), base.get()]);
      questions.push({ roomId: room.id, roomName: room.name, messageId: message.id, ratingRevision: revision || 'legacy',
        target: message, humanContext: humans.slice(Math.max(0, i - 5), i + 6),
        selectedReply: room.messages.find(m => m.id === selected.data()?.replyId) || null });
      for (const [stage, snapshot] of [[1, phase1], [2, phase2]]) for (const doc of snapshot.docs) answers.push({
        bankVersion: versionId, bankSequence: meta.sequence, roomId: room.id, messageId: message.id,
        ratingRevision: revision || 'legacy', reviewerUid: doc.id, stage, answer: doc.data(),
      });
    }));
  }
  questions.sort((a, b) => `${a.roomId}/${a.messageId}`.localeCompare(`${b.roomId}/${b.messageId}`));
  answers.sort((a, b) => `${a.roomId}/${a.messageId}/${a.stage}/${a.reviewerUid}`.localeCompare(`${b.roomId}/${b.messageId}/${b.stage}/${b.reviewerUid}`));
  const columns = ['bankVersion', 'bankSequence', 'roomId', 'messageId', 'ratingRevision', 'reviewerUid', 'stage', 'status', 'thinking', 'discussion', 'necessity', 'action', 'labels', 'scores', 'ambiguous', 'important', 'reason', 'updatedAt', 'source', 'viewContext', 'replyId'];
  const csv = '\uFEFF' + [columns.join(','), ...answers.map(row => columns.map(key => exportCsvCell(key in row ? row[key] : row.answer[key])).join(','))].join('\r\n');
  const summary = { versionId, sequence: meta.sequence, questionCount: questions.length, answerCount: answers.length, startedAt, completedAt: Date.now() };
  const { lastExport, ...version } = meta;
  return { summary, files: [
    { name: 'answers.csv', mimeType: 'text/csv', content: csv },
    { name: 'coding-data.json', mimeType: 'application/json', content: JSON.stringify({ summary, version, questions, answers }, null, 2) },
  ] };
}
