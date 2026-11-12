import { collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, orderBy, query, runTransaction, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { humanText, atOrBefore, roundRobin, type SamplingEvent } from './codingSampling';
import { db, functions } from '../firebase/config';
import type { MessageItem } from '../types';

export const codingOptions = {
  thinking: ['diverge', 'converge', 'iterate', 'reflect', 'cannotJudge'],
  discussion: ['effective', 'creativeDetour', 'misunderstanding', 'stalled', 'offTopic', 'cannotJudge'],
  necessity: ['unnecessary', 'optional', 'worthwhile', 'urgent', 'cannotJudge'],
  action: ['silent', 'clarify', 'connect', 'refocus', 'compare', 'cannotJudge'],
} as const;
export type CodingField = keyof typeof codingOptions;
export interface CodingSource {
  bankVersion?: string;
  roomId: string;
  messageId: string;
  messageTimestamp: number;
  contextMessageIds: string[];
  sampledAt: number;
  samplingMethod: 'random-human-message-v1' | 'researcher-selection' | 'event-round-robin-v2';
  events?: SamplingEvent[];
  contextPolicy?: 'human-before-after-5-v1';
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
  viewContext?: { policy: string; messageIds: string[]; bankVersion?: string };
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
export interface CodingQuestion { roomId: string; messages: MessageItem[]; index: number; events?: SamplingEvent[]; revision?: string }
export interface CodingBankVersion { resetAnswers?: boolean; id: string; sequence: number; status: string; startedAt: number; completedAt?: number; note: string; parentVersion: string; roomCount?: number; counts?: { questions: number; added: number; changed: number; reused: number; removed: number; semanticCovered: number } }
export async function manageCodingBank(data: { action: 'list' | 'create' | 'activate' | 'reset'; requestId?: string; note?: string; versionId?: string }) {
  return (await httpsCallable<typeof data, { versions?: CodingBankVersion[]; activeVersion?: string; version?: CodingBankVersion }>(functions, 'manageCodingBank', { timeout: 540000 })(data)).data;
}
export interface CodingCloudExport { folderUrl: string; answerCount: number; questionCount: number; completedAt: number }
export async function exportCodingBankToDrive(versionId: string) {
  return (await httpsCallable<{ versionId: string }, CodingCloudExport>(functions, 'exportCodingBank', { timeout: 540000 })({ versionId })).data;
}
export const codingQuestionKey = (roomId: string, messageId: string) => `${roomId}/${messageId}`;
interface CodingRoomData {
  id: string; name: string; messages: MessageItem[];
  logs: Record<string, any>[]; events: Record<string, any>[]; semantic: Record<string, any>[];
  completed: string[]; detailedCompleted: string[]; selected: string[];
  disabled?: string[];
  visits?: { id: string; at: number }[];
  revisions?: Record<string, string>;
}
export async function fetchCodingBank(versionId?: string) {
  const fetch = httpsCallable<{ versionId?: string }, { rooms: CodingRoomData[]; version?: CodingBankVersion; activeVersion?: string }>(functions, 'getCodingBank', { timeout: 120000 });
  const { data } = await fetch(versionId ? { versionId } : {});
  const keys = (field: 'completed' | 'detailedCompleted' | 'selected') => data.rooms.flatMap(r => r[field].map(id => codingQuestionKey(r.id, id)));
  const allQuestions = buildCodingQueue(data.rooms);
  const eligible = new Set(allQuestions.map(q => codingQuestionKey(q.roomId, q.messages[q.index].id)));
  const disabled = new Set(data.rooms.flatMap(r => (r.disabled || []).map(id => codingQuestionKey(r.id, id))).filter(key => eligible.has(key)));
  const active = (key: string) => !disabled.has(key);
  return { rooms: data.rooms.map(r => ({ id: r.id, name: r.name })), allQuestions, disabled, version: data.version || null, activeVersion: data.activeVersion || '',
    previousVisits: data.rooms.flatMap(r => (r.visits || []).map(v => ({ key: codingQuestionKey(r.id, v.id), at: v.at }))).filter(v => active(v.key)).sort((a, b) => a.at - b.at),
    queue: allQuestions.filter(q => active(codingQuestionKey(q.roomId, q.messages[q.index].id))),
    progress: { completed: keys('completed').filter(active), detailedCompleted: keys('detailedCompleted').filter(active), selected: keys('selected').filter(active) } };
}

const controlRef = (roomId: string, messageId: string) => doc(db, 'codingQuestionControls', roomId, 'items', messageId);
export async function isCodingQuestionEnabled(roomId: string, messageId: string) {
  return (await getDocFromServer(controlRef(roomId, messageId))).data()?.enabled !== false;
}
export async function setCodingQuestionEnabled(roomId: string, messageId: string, enabled: boolean, uid: string) {
  await setDoc(controlRef(roomId, messageId), { enabled, updatedBy: uid, updatedAt: Date.now() });
}
export interface CodingRatingRow { uid: string; phase: number; answer: CodingAnswer | DetailedAnswer }
export async function listCodingRatings(roomId: string, messageId: string, revision = ''): Promise<CodingRatingRow[]> {
  const base = caseRef(roomId, messageId, revision);
  const snapshots = await Promise.all(['ratings', 'detailedRatings'].map(name => getDocsFromServer(collection(base, name))));
  return snapshots.flatMap((snapshot, i) => snapshot.docs.map(d => ({ uid: d.id, phase: i + 1,
    answer: i === 0 ? normalizeCoding(d.data()) : d.data() as DetailedAnswer })));
}
function buildCodingQueue(rooms: CodingRoomData[]): CodingQuestion[] {
  const candidates: CodingQuestion[] = [];
  for (const room of rooms) {
    const { messages } = room;
    const snapshots = (records: Record<string, any>[]) => ({ docs: records.map(record => ({ id: record.id, data: () => record })) });
    const logs = snapshots(room.logs), events = snapshots(room.events), semantic = snapshots(room.semantic);
    const byIndex = new Map<number, CodingQuestion>();
    const add = (index: number, kind: SamplingEvent['kind'], ref: string) => {
      if (index < 0 || !humanText(messages[index])) return;
      let q = byIndex.get(index);
      if (!q) { q = { roomId: room.id, messages, index, events: [], revision: room.revisions?.[messages[index].id] || '' }; byIndex.set(index, q); }
      if (!q.events!.some(e => e.kind === kind && e.ref === ref)) q.events!.push({ kind, ref });
    };
    messages.forEach((m, i) => { if (humanText(m)) add(i, 'random', `rooms/${room.id}/messages/${m.id}`); });
    logs.docs.forEach(d => {
      const log = d.data();
      if (log.kind !== 'mentor' || log.error || log.visible === false || log.output?.shouldIntervene !== true) return;
      // Anchor to the last input message, never the log completion / AI response time.
      const triggerIndex = messages.findIndex(m => m.id === log.triggerMessageId);
      if (triggerIndex < 0) return;
      const anchor = atOrBefore(messages.slice(0, triggerIndex + 1), messages[triggerIndex].timestamp);
      add(anchor, 'intervention', `aiLogs/${d.id}`);
    });
    events.docs.forEach(d => {
      const e = d.data(); const kind = String(e.kind || '');
      const m = e.data?.message;
      const asset = m?.assetType;
      if (/board|whiteboard|imageboard|moodboard|model_?3d|model_3d|mesh_3d/i.test(kind)
          || ['moodboard', 'mesh_3d', 'parametric_3d'].includes(asset)
          || m?.type === 'whiteboard_state') {
        if (Number.isFinite(e.at)) add(atOrBefore(messages, e.at), 'tool', `rooms/${room.id}/events/${d.id}`);
      }
    });
    // Legacy rooms may have tool cards but no event log.
    messages.forEach(m => { if (m.type === 'whiteboard_state' || ['moodboard', 'mesh_3d', 'parametric_3d'].includes(m.assetType || ''))
      add(atOrBefore(messages, m.timestamp), 'tool', `rooms/${room.id}/messages/${m.id}`); });
    semantic.docs.forEach(d => {
      const batch = d.data();
      // Ignore caches whose source text has since been edited or removed.
      if (batch.version !== 'coding-events-v1' || !Array.isArray(batch.inputMessages)
        || !batch.inputMessages.every((x: any) => messages.some(m => humanText(m) && m.id === x.id && m.content.slice(0, 4000) === x.content))) return;
      for (const e of batch.events || []) add(messages.findIndex(m => m.id === e.messageId), 'semantic', `codingSemantic/${room.id}/batches/${d.id}#${e.kind}`);
    });
    candidates.push(...byIndex.values());
  }
  return roundRobin(candidates);
}
export async function prepareSemanticQueue(rooms: { id: string }[]) {
  const prepare = httpsCallable<{ roomId: string; offset: number }, { nextOffset: number | null }>(functions, 'prepareCodingSemantic', { timeout: 180000 });
  for (const room of rooms) {
    let offset: number | null = 0;
    while (offset !== null) { const result: { data: { nextOffset: number | null } } = await prepare({ roomId: room.id, offset }); offset = result.data.nextOffset; }
  }
}

const ratingRef = (roomId: string, messageId: string, uid: string, revision = '') =>
  doc(caseRef(roomId, messageId, revision), 'ratings', uid);
export async function loadCoding(roomId: string, messageId: string, uid: string, revision = ''): Promise<CodingAnswer> {
  const snapshot = await getDoc(ratingRef(roomId, messageId, uid, revision));
  return snapshot.exists() ? normalizeCoding(snapshot.data()) : emptyCoding();
}
function normalizeCoding(data: Record<string, any>): CodingAnswer {
  return { ...emptyCoding(), ...data, schemaVersion: 2,
    discussion: Array.isArray(data.discussion) ? data.discussion : data.discussion ? [data.discussion] : [],
    action: Array.isArray(data.action) ? data.action : data.action ? [data.action] : [],
  };
}
export async function saveCoding(roomId: string, messageId: string, uid: string, answer: CodingAnswer, revision = ''): Promise<CodingAnswer> {
  const ref = ratingRef(roomId, messageId, uid, revision);
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
  bankVersion?: string;
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
const caseRef = (roomId: string, messageId: string, revision = '') => revision
  ? doc(db, 'codingRooms', roomId, 'items', messageId, 'revisions', revision) : doc(db, 'codingRooms', roomId, 'items', messageId);
export async function loadCodingCase(roomId: string, messageId: string, revision = ''): Promise<CodingCase | null> {
  const snapshot = await getDoc(caseRef(roomId, messageId, revision));
  return snapshot.exists() ? snapshot.data() as CodingCase : null;
}
export async function openCodingCase(roomId: string, messageId: string, replyId: string, uid: string, revision = '') {
  // Once opened, the target AI reply stays fixed for every reviewer.
  await runTransaction(db, async tx => {
    const ref = caseRef(roomId, messageId, revision);
    if ((await tx.get(ref)).exists()) return;
    tx.set(ref, { replyId, selectedBy: uid, selectedAt: Date.now() });
  });
}
export async function loadDetailed(roomId: string, messageId: string, uid: string, replyId: string, revision = ''): Promise<DetailedAnswer> {
  const snapshot = await getDoc(doc(caseRef(roomId, messageId, revision), 'detailedRatings', uid));
  return snapshot.exists() ? snapshot.data() as DetailedAnswer : emptyDetailed(replyId);
}
export async function saveDetailed(roomId: string, messageId: string, uid: string, answer: DetailedAnswer, revision = '') {
  const ref = doc(caseRef(roomId, messageId, revision), 'detailedRatings', uid);
  return runTransaction(db, async tx => {
    const current = await tx.get(ref);
    if ((current.data()?.revision || 0) !== answer.revision) throw new Error('coding-conflict');
    const saved = { ...answer, reason: answer.ambiguous || answer.important ? answer.reason.trim() : '', revision: answer.revision + 1, updatedAt: Date.now() };
    tx.set(ref, saved);
    return saved;
  });
}
export async function reviewCoding(roomId: string, messageId: string, revision = '') {
  const snapshot = await getDocs(collection(caseRef(roomId, messageId, revision), 'ratings'));
  const answers = snapshot.docs.map(d => normalizeCoding(d.data())).filter(a => a.status === 'submitted');
  const signatures = answers.map(a => JSON.stringify([a.thinking, [...a.discussion].sort(), a.necessity, [...a.action].sort()]));
  return { count: answers.length, flagged: answers.some(a => a.ambiguous || a.important), disagreement: new Set(signatures).size > 1 };
}
