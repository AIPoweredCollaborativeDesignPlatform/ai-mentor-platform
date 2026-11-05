import { t as tr, type MessageKey } from '../i18n';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase/config';

/**
 * Research replay (P4b): rebuilds what a room looked like at any moment from its event log
 * (rooms/{roomId}/events, written by functions/src/events.js and services/researchLog.ts).
 * Everything is derived from events only, so the same code can later replay exported JSONL files.
 */

export interface ResearchEvent {
  id: string;
  at: number;
  kind: string;
  uid: string | null;
  role: 'participant' | 'researcher' | 'observer' | 'ai' | 'system' | 'unknown';
  source: 'server' | 'client';
  data: Record<string, any>;
}

export interface ReplayMessage {
  id: string;
  senderUid: string;
  senderName: string;
  type: string;
  content: string;
  timestamp: number;
  reactions?: Record<string, string[]>;
  actionOptions?: string[];
  pollVotes?: Record<string, { uid: string; name: string; option: string }>;
  assetType?: string | null;
  assetPayload?: any;
  fileData?: { name?: string; type?: string; url?: string; mimeType?: string } | null;
  metadata?: { isPrivate?: boolean; wasPublished?: boolean; creatorUid?: string; creatorName?: string } | null;
  deleted?: boolean;
}

export interface ReplayObject {
  id: string;
  z: number;
  fabric: Record<string, any>;
}

export interface Member {
  uid: string;
  alias: string;
  nickname: string;
}

/**
 * Final objects of a board (rooms/{id}/boards/{boardId}/objects, admin-readable). Rooms recorded
 * before 2026-10-28 cut long freehand paths out of their events; replay borrows those from here.
 */
export async function loadFinalBoard(roomId: string, boardId: string): Promise<Map<string, ReplayObject>> {
  const snap = await getDocs(collection(db, 'rooms', roomId, 'boards', boardId, 'objects'));
  return new Map(snap.docs.map(d => [d.id, { id: d.id, z: (d.data() as any).z ?? 0, fabric: (d.data() as any).fabric }]));
}

export const wasTruncated = (fabric: Record<string, any>) =>
  Object.values(fabric || {}).some(v => typeof v === 'string' && v.startsWith('[omitted '));

/**
 * One AI check from the research log (aiLogs, functions/src/mentor.js): what the AI noticed and decided,
 * including checks where it stayed silent and shadow checks of conditions where it cannot speak.
 */
export interface AiThought {
  id: string;
  at: number;
  /** tool = 3D model or sketch generation (with its error, if it failed) */
  kind: 'mentor' | 'memory_update' | 'tool';
  tool?: string;
  trigger: string;
  /** false = shadow check (the AI could not have spoken) */
  visible: boolean;
  spoke: boolean;
  assessment: Record<string, any> | null;
  aiMessage: string;
  error: string;
  rawText: string;
  memorySummary: string;
}

export async function loadAiThoughts(roomId: string): Promise<AiThought[]> {
  // A single equality filter needs no composite index; sorted here
  const snap = await getDocs(query(collection(db, 'aiLogs'), where('roomId', '==', roomId)));
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as any) }))
    .filter(x => ['mentor', 'memory_update', 'model_3d', 'sketch_brief', 'sketch_refine', 'sketch_variations'].includes(x.kind))
    .map(x => ({
      id: x.id,
      at: x.createdAt?.toMillis?.() ?? 0,
      kind: x.kind === 'mentor' || x.kind === 'memory_update' ? x.kind : 'tool',
      tool: x.kind,
      trigger: x.trigger || '',
      visible: x.visible !== false,
      spoke: x.visible !== false && Boolean(x.output?.shouldIntervene),
      assessment: x.output?.assessment || null,
      aiMessage: x.output?.result?.aiMessage || '',
      error: x.error ? `${x.error.category || ''} ${x.error.message || ''}`.trim() : '',
      rawText: x.output?.rawText || '',
      memorySummary: x.output?.memory?.summary || (x.kind === 'sketch_brief' ? x.output?.brief?.subject || '' : x.output?.provider || '')
    }))
    .sort((a, b) => a.at - b.at);
}

export async function loadEvents(roomId: string): Promise<ResearchEvent[]> {
  const snap = await getDocs(query(collection(db, 'rooms', roomId, 'events'), orderBy('at')));
  // Server and client clocks differ slightly; a stable sort keeps same-ms events in write order
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ResearchEvent, 'id'>) })).sort((a, b) => a.at - b.at);
}

// Name a member used on a message they sent themselves (not on system notices they triggered)
const ownName = (e: ResearchEvent) =>
  e.kind === 'message_created' && e.data?.message?.senderUid === e.uid ? e.data.message.senderName || '' : '';

/** Participants get P01, P02… in order of joining; the researcher is R, observers O1, O2…. */
export function membersOf(events: ResearchEvent[]): Map<string, Member> {
  const members = new Map<string, Member>();
  let n = 0;
  let o = 0;
  const add = (uid: string | null, role: string, nickname = '') => {
    if (!uid || members.has(uid) || (role !== 'participant' && role !== 'researcher' && role !== 'observer')) return;
    const alias = role === 'researcher' ? 'R' : role === 'observer' ? `O${++o}` : `P${String(++n).padStart(2, '0')}`;
    members.set(uid, { uid, alias, nickname });
  };
  for (const e of events) {
    if (e.kind === 'participant_joined') add(e.uid, 'participant', e.data?.displayName);
    else add(e.uid, e.role, ownName(e));
  }
  for (const e of events) {
    const m = e.uid ? members.get(e.uid) : undefined;
    if (m && !m.nickname) m.nickname = ownName(e);
  }
  return members;
}

export interface ReplayState {
  messages: ReplayMessage[];
  boards: Map<string, Map<string, ReplayObject>>;
}

/** State after applying events[0..upto] (inclusive). */
export function stateAt(events: ResearchEvent[], upto: number): ReplayState {
  const messages = new Map<string, ReplayMessage>();
  const boards = new Map<string, Map<string, ReplayObject>>();
  for (let i = 0; i <= upto && i < events.length; i++) {
    const e = events[i];
    const d = e.data || {};
    if (e.kind === 'message_created' || e.kind === 'message_updated') {
      const m = d.message || {};
      messages.set(d.messageId, {
        id: d.messageId,
        senderUid: m.senderUid,
        senderName: m.senderName,
        type: m.type || 'text',
        content: m.content || '',
        timestamp: m.timestamp || e.at,
        reactions: m.reactions,
        actionOptions: m.actionOptions,
        pollVotes: m.pollVotes,
        assetType: m.assetType || null,
        assetPayload: m.assetPayload,
        fileData: m.fileData || null,
        metadata: m.metadata || null
      });
    } else if (e.kind === 'message_deleted') {
      const m = messages.get(d.messageId);
      if (m) m.deleted = true;
    } else if (e.kind.startsWith('board_object_')) {
      if (!boards.has(d.boardId)) boards.set(d.boardId, new Map());
      const board = boards.get(d.boardId)!;
      if (e.kind === 'board_object_deleted') board.delete(d.objectId);
      else if (d.fabric) board.set(d.objectId, { id: d.objectId, z: d.z ?? 0, fabric: d.fabric });
    }
  }
  return {
    messages: [...messages.values()].sort((a, b) => a.timestamp - b.timestamp),
    boards
  };
}

/** Index of the last event at or before `t` (-1 if none). */
export function indexAt(events: ResearchEvent[], t: number) {
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].at <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const KIND_GROUPS: { id: string; label: MessageKey; match: (k: string) => boolean }[] = [
  { id: 'chat', label: 'rp.groupChat', match: k => k.startsWith('message_') },
  { id: 'board', label: 'rp.groupBoard', match: k => k.startsWith('board_object_') },
  { id: 'whiteboard_ui', label: 'rp.groupWbUi', match: k => k.startsWith('whiteboard_') },
  { id: 'attention', label: 'rp.groupAttention', match: k => ['tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'ai_message_viewed', 'page_hide'].includes(k) },
  { id: 'session', label: 'rp.groupSession', match: k => k.startsWith('session_') || k.startsWith('participant_') || k.startsWith('join_') || k.startsWith('room_') }
];

export const groupOf = (kind: string) => KIND_GROUPS.find(g => g.match(kind))?.id || 'session';

/** Time of the last real activity (chat, board, whiteboard use): later leave / time-up / end events are idle tail. */
export function lastActivityAt(events: ResearchEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (['chat', 'board', 'whiteboard_ui'].includes(groupOf(events[i].kind))) return events[i].at;
  }
  return events.at(-1)?.at || 0;
}

export interface ReplaySegment {
  start: number;
  /** Last activity in the segment (playback stops there) */
  end: number;
  /** Start of the next segment (events up to it belong here) */
  until: number;
}

/** A reopened session is replayed as separate parts: each reopen starts a new segment. */
export function segmentsOf(events: ResearchEvent[]): ReplaySegment[] {
  if (!events.length) return [];
  const starts = [0, ...events.flatMap((e, i) => (e.kind === 'session_reopened' && i > 0 ? [i] : []))];
  return starts.map((from, k) => {
    const to = starts[k + 1] ?? events.length;
    const part = events.slice(from, to);
    return { start: part[0].at, end: Math.max(part[0].at, lastActivityAt(part)), until: events[to]?.at ?? Infinity };
  });
}

export const fmtOffset = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** One-line description of an event for the timeline list. */
export function describe(e: ResearchEvent): string {
  const d = e.data || {};
  switch (e.kind) {
    case 'message_created': return tr('rp.msgCreated', { type: tr(d.messageType === 'whiteboard_state' ? 'rp.boardCard' : 'rp.message'), content: String(d.message?.content || '').slice(0, 80) });
    case 'message_updated': return tr('rp.msgUpdated', { keys: (d.changedKeys || []).join(', ') });
    case 'message_deleted': return tr('rp.msgDeleted');
    case 'board_object_created': return tr('rp.objCreated', { type: d.fabric?.type || tr('rp.object'), board: d.boardId });
    case 'board_object_updated': return tr('rp.objUpdated', { type: d.fabric?.type || tr('rp.object'), board: d.boardId });
    case 'board_object_deleted': return tr('rp.objDeleted', { board: d.boardId });
    case 'whiteboard_open': return tr('rp.wbOpen', { board: d.boardId, isNew: d.isNew ? tr('rp.new') : '' });
    case 'whiteboard_close': return tr('rp.wbClose', { board: d.boardId });
    case 'whiteboard_tool': return tr('rp.wbTool', { from: d.previous, to: d.tool });
    case 'ai_message_viewed': return tr('rp.aiViewed', { seconds: (d.dwellMs / 1000).toFixed(1) });
    case 'participant_joined': return tr('rp.joined', { name: d.displayName });
    case 'participant_rejoined': return tr('rp.rejoined');
    case 'join_blocked_full': return tr('rp.full', { online: d.online, max: d.max });
    case 'session_started': return tr('rp.started', { count: (d.participants || []).length });
    case 'session_time_up': return tr('rp.timeUp');
    case 'session_ended': return tr('rp.ended', { by: d.endedBy });
    case 'session_reopened': return tr('rp.reopened', { by: d.by });
    case 'room_enter': return tr('rp.enter');
    case 'room_leave': return tr('rp.leave');
    default: return e.kind;
  }
}
