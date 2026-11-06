import { collection, doc, getDoc, getDocs, getDocsFromServer, orderBy, query, runTransaction } from 'firebase/firestore';
import { db } from '../firebase/config';
import type { MessageItem } from '../types';

export const codingOptions = {
  thinking: ['diverge', 'converge', 'iterate', 'reflect'],
  discussion: ['effective', 'creativeDetour', 'misunderstanding', 'stalled', 'offTopic'],
  necessity: ['unnecessary', 'optional', 'worthwhile', 'urgent'],
  action: ['silent', 'clarify', 'connect', 'refocus', 'compare'],
} as const;
export type CodingField = keyof typeof codingOptions;
export interface CodingSource {
  roomId: string;
  messageId: string;
  messageTimestamp: number;
  contextMessageIds: string[];
  sampledAt: number;
  samplingMethod: 'random-human-message-v1' | 'researcher-selection';
}
export interface CodingAnswer {
  thinking: string;
  discussion: string[];
  necessity: string;
  action: string[];
  ambiguous: boolean;
  important: boolean;
  reason: string;
  status: 'draft' | 'submitted';
  revision: number;
  schemaVersion: 2;
  updatedAt: number;
  source?: CodingSource;
}
export const emptyCoding = (): CodingAnswer => ({
  thinking: '', discussion: [], necessity: '', action: [], ambiguous: false,
  important: false, reason: '', status: 'draft', revision: 0, schemaVersion: 2, updatedAt: 0,
});
export async function codingRooms() {
  const snapshot = await getDocsFromServer(collection(db, 'rooms'));
  return snapshot.docs.filter(d => !d.data().deletedAt).map(d => ({ id: d.id, name: String(d.data().roomName || d.id) }));
}
export async function codingMessages(roomId: string): Promise<MessageItem[]> {
  const snapshot = await getDocsFromServer(query(collection(db, 'rooms', roomId, 'messages'), orderBy('timestamp')));
  return snapshot.docs.map(d => ({ ...d.data(), id: d.id } as MessageItem));
}
export interface CodingQuestion { roomId: string; messages: MessageItem[]; index: number }
export async function buildCodingQueue(rooms: { id: string }[]): Promise<CodingQuestion[]> {
  const candidates: CodingQuestion[] = [];
  for (let start = 0; start < rooms.length; start += 5) {
    await Promise.all(rooms.slice(start, start + 5).map(async room => {
      const messages = await codingMessages(room.id);
      messages.forEach((message, index) => {
        if (!['ai_mentor', 'ai_mentor_3d', 'system'].includes(message.senderUid)) {
          candidates.push({ roomId: room.id, messages, index });
        }
      });
    }));
  }
  // Shuffle individual human-message cutoffs, so large rooms receive proportional weight.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates;
}
const ratingRef = (roomId: string, messageId: string, uid: string) =>
  doc(db, 'codingRooms', roomId, 'items', messageId, 'ratings', uid);
export async function loadCoding(roomId: string, messageId: string, uid: string): Promise<CodingAnswer> {
  const snapshot = await getDoc(ratingRef(roomId, messageId, uid));
  return snapshot.exists() ? normalizeCoding(snapshot.data()) : emptyCoding();
}
function normalizeCoding(data: Record<string, any>): CodingAnswer {
  return { ...emptyCoding(), ...data, schemaVersion: 2,
    discussion: Array.isArray(data.discussion) ? data.discussion : data.discussion ? [data.discussion] : [],
    action: Array.isArray(data.action) ? data.action : data.action ? [data.action] : [],
  };
}
export async function saveCoding(roomId: string, messageId: string, uid: string, answer: CodingAnswer): Promise<CodingAnswer> {
  const ref = ratingRef(roomId, messageId, uid);
  return runTransaction(db, async tx => {
    const current = await tx.get(ref);
    if ((current.data()?.revision || 0) !== answer.revision) throw new Error('coding-conflict');
    const saved = { ...answer, reason: answer.ambiguous || answer.important ? answer.reason.trim() : '', revision: answer.revision + 1, updatedAt: Date.now() };
    tx.set(ref, saved);
    return saved;
  });
}

export const detailedOptions = {
  design_stage: ['discover', 'define', 'develop', 'deliver', 'uncertain'],
  thinking_mode: ['divergent', 'convergent', 'iterative', 'reflective', 'uncertain'],
  design_behavior: ['NEED', 'REFRAME', 'IDEATE', 'ELABORATE', 'CRITIQUE', 'EXTERNALIZE', 'DECIDE', 'REFLECT', 'SOCIAL'],
  collaboration_behavior: ['PROPOSE', 'UPTAKE', 'BUILD_ON', 'CHALLENGE', 'CLARIFY', 'INTEGRATE', 'RATIFY', 'PROCESS_NEGOTIATION'],
  collaboration_situation: ['effective', 'true_off_topic', 'productive_detour', 'premature_convergence_risk', 'unresolved_misunderstanding', 'constructive_disagreement', 'true_stall', 'transition_readiness', 'explicit_pause'],
  intervention_level: ['0_no_intervention', '1_optional', '2_warranted', '3_urgent'],
  mentor_strategy: ['SILENCE', 'REFOCUS', 'ASK_OPEN_QUESTION', 'CLARIFY', 'CONNECT_IDEAS', 'OFFER_METHOD', 'SUMMARIZE', 'INVITE_COMPARISON', 'SUGGEST_REPRESENTATION', 'ASK_PERMISSION', 'RESPECT_PAUSE', 'FACT_CHECK'],
} as const;
export const scoreFields = ['stageFit', 'creativeAutonomy', 'contextualRelevance', 'interactionalSupport', 'clarity', 'nonRedundancy', 'grounding'] as const;
export type DetailField = keyof typeof detailedOptions;
export type ScoreField = typeof scoreFields[number];
export const isMultiple = (field: string) => ['design_behavior', 'collaboration_behavior', 'collaboration_situation', 'mentor_strategy', 'discussion', 'action'].includes(field);
export interface DetailedAnswer {
  labels: Record<DetailField, string[]>;
  scores: Record<ScoreField, number>;
  replyId: string;
  ambiguous: boolean;
  important: boolean;
  reason: string;
  status: 'draft' | 'submitted';
  revision: number;
  schemaVersion: 1;
  updatedAt: number;
}
export const emptyDetailed = (replyId = ''): DetailedAnswer => ({
  labels: { design_stage: [], thinking_mode: [], design_behavior: [], collaboration_behavior: [], collaboration_situation: [], intervention_level: [], mentor_strategy: [] },
  scores: { stageFit: 0, creativeAutonomy: 0, contextualRelevance: 0, interactionalSupport: 0, clarity: 0, nonRedundancy: 0, grounding: 0 },
  replyId, ambiguous: false, important: false, reason: '', status: 'draft', revision: 0, schemaVersion: 1, updatedAt: 0,
});
export interface CodingCase { replyId: string; selectedBy: string; selectedAt: number }
const caseRef = (roomId: string, messageId: string) => doc(db, 'codingRooms', roomId, 'items', messageId);
export async function loadCodingCase(roomId: string, messageId: string): Promise<CodingCase | null> {
  const snapshot = await getDoc(caseRef(roomId, messageId));
  return snapshot.exists() ? snapshot.data() as CodingCase : null;
}
export async function openCodingCase(roomId: string, messageId: string, replyId: string, uid: string) {
  // Once opened, the target AI reply stays fixed for every reviewer.
  await runTransaction(db, async tx => {
    const ref = caseRef(roomId, messageId);
    if ((await tx.get(ref)).exists()) return;
    tx.set(ref, { replyId, selectedBy: uid, selectedAt: Date.now() });
  });
}
export async function loadDetailed(roomId: string, messageId: string, uid: string, replyId: string): Promise<DetailedAnswer> {
  const snapshot = await getDoc(doc(caseRef(roomId, messageId), 'detailedRatings', uid));
  return snapshot.exists() ? snapshot.data() as DetailedAnswer : emptyDetailed(replyId);
}
export async function saveDetailed(roomId: string, messageId: string, uid: string, answer: DetailedAnswer) {
  const ref = doc(caseRef(roomId, messageId), 'detailedRatings', uid);
  return runTransaction(db, async tx => {
    const current = await tx.get(ref);
    if ((current.data()?.revision || 0) !== answer.revision) throw new Error('coding-conflict');
    const saved = { ...answer, reason: answer.ambiguous || answer.important ? answer.reason.trim() : '', revision: answer.revision + 1, updatedAt: Date.now() };
    tx.set(ref, saved);
    return saved;
  });
}
export async function reviewCoding(roomId: string, messageId: string) {
  const snapshot = await getDocs(collection(caseRef(roomId, messageId), 'ratings'));
  const answers = snapshot.docs.map(d => normalizeCoding(d.data())).filter(a => a.status === 'submitted');
  const signatures = answers.map(a => JSON.stringify([a.thinking, [...a.discussion].sort(), a.necessity, [...a.action].sort()]));
  return { count: answers.length, flagged: answers.some(a => a.ambiguous || a.important), disagreement: new Set(signatures).size > 1 };
}
