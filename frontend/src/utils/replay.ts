import { collection, getDocs, orderBy, query } from 'firebase/firestore';
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

export const KIND_GROUPS: { id: string; label: string; match: (k: string) => boolean }[] = [
  { id: 'chat', label: '聊天', match: k => k.startsWith('message_') },
  { id: 'board', label: '白板物件', match: k => k.startsWith('board_object_') },
  { id: 'whiteboard_ui', label: '白板開關／工具', match: k => k.startsWith('whiteboard_') },
  { id: 'attention', label: '注意力（分頁／視窗／閱讀 AI）', match: k => ['tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'ai_message_viewed', 'page_hide'].includes(k) },
  { id: 'session', label: '流程（加入／開場／提醒／結束）', match: k => k.startsWith('session_') || k.startsWith('participant_') || k.startsWith('join_') || k.startsWith('room_') }
];

export const groupOf = (kind: string) => KIND_GROUPS.find(g => g.match(kind))?.id || 'session';

export const fmtOffset = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** One-line description of an event for the timeline list. */
export function describe(e: ResearchEvent): string {
  const d = e.data || {};
  switch (e.kind) {
    case 'message_created': return `${d.messageType === 'whiteboard_state' ? '白板卡片' : '訊息'}：${String(d.message?.content || '').slice(0, 80)}`;
    case 'message_updated': return `訊息更新（${(d.changedKeys || []).join(', ')}）`;
    case 'message_deleted': return '訊息刪除';
    case 'board_object_created': return `新增 ${d.fabric?.type || '物件'}（${d.boardId}）`;
    case 'board_object_updated': return `修改 ${d.fabric?.type || '物件'}（${d.boardId}）`;
    case 'board_object_deleted': return `刪除物件（${d.boardId}）`;
    case 'whiteboard_open': return `開啟白板 ${d.boardId}${d.isNew ? '（新）' : ''}`;
    case 'whiteboard_close': return `關閉白板 ${d.boardId}`;
    case 'whiteboard_tool': return `換工具：${d.previous} → ${d.tool}`;
    case 'ai_message_viewed': return `閱讀 AI 訊息 ${(d.dwellMs / 1000).toFixed(1)} 秒`;
    case 'participant_joined': return `加入（${d.displayName}）`;
    case 'participant_rejoined': return '重新加入';
    case 'join_blocked_full': return `房間已滿被擋（${d.online}/${d.max}）`;
    case 'session_started': return `開場（${(d.participants || []).length} 人）`;
    case 'session_time_up': return '時間到';
    case 'session_ended': return `結束（${d.endedBy}）`;
    case 'room_enter': return '進入房間';
    case 'room_leave': return '離開房間';
    default: return e.kind;
  }
}
