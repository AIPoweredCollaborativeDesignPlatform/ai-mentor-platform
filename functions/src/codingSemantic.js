import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { createMessage, responseText, parseJsonObject } from './claude.js';
import { CODING_EVENT_PROMPT, CODING_EVENT_VERSION } from './prompts.js';
import { getSystemConfig } from './config.js';

// Offline research sampling only. Never feed these results back to the live Mentor.
export async function generateCodingSemanticBatch(roomId, offset, apiKey) {
  const db = getFirestore();
  const snapshot = await db.collection(`rooms/${roomId}/messages`).orderBy('timestamp').get();
  const humans = snapshot.docs.map(d => ({ id: d.id, ...d.data() })).filter(m =>
    m.senderUid && !['ai_mentor', 'ai_mentor_3d', 'system'].includes(m.senderUid)
    && m.type === 'text' && String(m.content || '').trim() && m.status !== 'failed');
  const targets = humans.slice(offset, offset + 30);
  if (!targets.length) return { nextOffset: null, count: 0 };
  const context = humans.slice(Math.max(0, offset - 5), offset + 35).map(m => ({ id: m.id, content: String(m.content).slice(0, 4000) }));
  const model = (await getSystemConfig()).models.mentor;
  const input = JSON.stringify({ targets: targets.map(m => m.id), context });
  const hash = createHash('sha256').update(CODING_EVENT_VERSION + model + input).digest('hex');
  const ref = db.doc(`codingSemantic/${roomId}/batches/${hash}`);
  const cached = await ref.get();
  if (!cached.exists) {
    const response = await createMessage(apiKey, { model, max_tokens: 4000, system: CODING_EVENT_PROMPT, messages: [{ role: 'user', content: input }] });
    const output = parseJsonObject(responseText(response));
    const kinds = ['idea', 'branch', 'difficulty', 'shift', 'comparison'];
    if (!Array.isArray(output.events)) throw new Error('Invalid semantic event result');
    const events = output.events.filter(e => targets.some(m => m.id === e.messageId) && kinds.includes(e.kind))
      .map(e => ({ messageId: e.messageId, kind: e.kind }));
    await ref.set({ version: CODING_EVENT_VERSION, model, createdAt: Date.now(),
      inputMessages: context, targetIds: targets.map(m => m.id), events });
  }
  return { nextOffset: offset + 30 < humans.length ? offset + 30 : null, count: targets.length };
}
