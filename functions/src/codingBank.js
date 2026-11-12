import { getFirestore } from 'firebase-admin/firestore';
import { codingBankErrors } from './i18n.js';
import { codingTarget, hasCodingMedia } from './codingMedia.js';

const rows = snapshot => snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
export const codingHuman = m => m.senderUid && !['ai_mentor', 'ai_mentor_3d', 'system'].includes(m.senderUid)
  && m.type === 'text' && String(m.content || '').trim() && m.status !== 'failed';

// Read only this caller's progress. No collection-group access or rules expansion needed.
async function submitted(db, refs, visits) {
  const ids = new Set();
  for (let start = 0; start < refs.length; start += 200) {
    const docs = await db.getAll(...refs.slice(start, start + 200), { fieldMask: visits ? ['status', 'source.sampledAt', 'updatedAt'] : ['status'] });
    for (const d of docs) if (d.data()?.status === 'submitted') {
      const id = d.ref.parent.parent.id;
      ids.add(id);
      if (visits) visits.push({ id, at: d.data().source?.sampledAt || d.data().updatedAt || 0 });
    }
  }
  return [...ids];
}

export async function loadCodingBank(uid, db = getFirestore(), roomIds = null) {
  const rooms = rows(await db.collection('rooms').select('deletedAt', 'roomName', 'name').get()).filter(r => !r.deletedAt && (!roomIds || roomIds.includes(r.id)));
  if (roomIds && rooms.length !== roomIds.length) throw new Error(codingBankErrors.request);
  const result = [];
  // Bounded parallelism across rooms; field masks omit prompts, board objects and asset blobs.
  for (let start = 0; start < rooms.length; start += 4) {
    const batch = await Promise.all(rooms.slice(start, start + 4).map(async room => {
      const base = db.collection('rooms').doc(room.id);
      const messages = rows(await base.collection('messages').orderBy('timestamp')
        .select('senderUid', 'senderName', 'timestamp', 'type', 'content', 'assetType', 'status', 'fileData', 'assetPayload', 'collage', 'whiteboardThumbnail', 'metadata.isPrivate', 'metadata.wasPublished').get());
      for (const m of messages) if (!hasCodingMedia(m)) { delete m.assetPayload; delete m.collage; }
      const targets = messages.filter(codingTarget);
      if (!targets.length) return { id: room.id, name: room.roomName || room.name || room.id, messages: [], logs: [], events: [], semantic: [], completed: [], detailedCompleted: [], selected: [] };
      const items = db.collection('codingRooms').doc(room.id).collection('items');
      const visits = [];
      const [logs, events, semantic, cases, completed, controls] = await Promise.all([
        db.collection('aiLogs').where('roomId', '==', room.id)
          .select('kind', 'error', 'visible', 'output.shouldIntervene', 'triggerMessageId').get(),
        base.collection('events').select('kind', 'at', 'data.message.type', 'data.message.assetType').get(),
        db.collection('codingSemantic').doc(room.id).collection('batches')
          .select('version', 'model', 'createdAt', 'targetIds', 'inputMessages', 'events').get(),
        items.select('replyId').get(),
        uid ? submitted(db, targets.map(m => items.doc(m.id).collection('ratings').doc(uid)), visits) : [],
        db.collection('codingQuestionControls').doc(room.id).collection('items').select('enabled').get(),
      ]);
      const targetIds = new Set(targets.map(m => m.id));
      const selected = cases.docs.filter(d => targetIds.has(d.id) && d.data().replyId).map(d => d.id);
      const detailedCompleted = uid ? await submitted(db, selected.map(id => items.doc(id).collection('detailedRatings').doc(uid))) : [];
      return { id: room.id, name: room.roomName || room.name || room.id, messages,
        logs: rows(logs), events: rows(events), semantic: rows(semantic), completed, detailedCompleted, selected,
        disabled: controls.docs.filter(d => d.data().enabled === false).map(d => d.id), visits, mediaPolicy: 'multimodal-v1' };
    }));
    result.push(...batch);
  }
  return { rooms: result };
}
