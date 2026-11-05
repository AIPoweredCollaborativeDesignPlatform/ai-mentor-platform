import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';

// Experiment flow callables (functions/src/session.js): joining is approved server-side.

export interface JoinResult {
  status: 'approved' | 'full' | 'ended' | 'not_found' | 'consent_required';
  role?: 'researcher' | 'participant' | 'observer';
  returning?: boolean;
  online?: number;
  max?: number;
}

/**
 * `retry` marks the automatic re-tries while a room is full (logged only once). Observers join
 * invisibly unless `asParticipant` (then they go through the normal nickname + consent flow).
 */
export async function joinStudyRoom(roomId: string, displayName: string, avatar: string, consent: boolean, retry = false, asParticipant = false): Promise<JoinResult> {
  const fn = httpsCallable<{ roomId: string; displayName: string; avatar: string; consent: boolean; retry: boolean; asParticipant: boolean }, JoinResult>(functions, 'joinStudyRoom');
  return (await fn({ roomId, displayName, avatar, consent, retry, asParticipant })).data;
}

/** Room documents are readable by members only; join pages ask the server whether a PIN exists. */
export type RoomPeek = { exists: boolean; roomName?: string; isHost?: boolean; language?: 'en' | 'zh-TW'; consentText?: string };

export async function peekStudyRoom(roomId: string): Promise<RoomPeek> {
  const fn = httpsCallable<{ roomId: string }, RoomPeek>(functions, 'peekStudyRoom');
  return (await fn({ roomId })).data;
}

export async function reopenStudySession(roomId: string): Promise<boolean> {
  const fn = httpsCallable<{ roomId: string }, { reopened: boolean }>(functions, 'reopenStudySession');
  return (await fn({ roomId })).data.reopened;
}

/** Name/avatar change in a room; the server announces it in the chat (system messages are server-only). */
export async function updateRoomProfile(roomId: string, displayName: string, avatar: string): Promise<void> {
  const fn = httpsCallable<{ roomId: string; displayName: string; avatar: string }, { changed: boolean }>(functions, 'updateRoomProfile');
  await fn({ roomId, displayName, avatar });
}

/** Room name/emoji change by the host; the server applies it and posts the notice. */
export async function updateStudyRoomDetails(roomId: string, roomName: string, roomEmoji: string): Promise<{ roomName: string; roomEmoji: string }> {
  const fn = httpsCallable<{ roomId: string; roomName: string; roomEmoji: string }, { roomName: string; roomEmoji: string }>(functions, 'updateStudyRoomDetails');
  return (await fn({ roomId, roomName, roomEmoji })).data;
}

/** "Change back" under the AI's automatic room name (functions/src/rooms.js revertAutoRoomName). */
export async function revertRoomName(roomId: string, messageId: string): Promise<void> {
  await httpsCallable<{ roomId: string; messageId: string }, { changed: boolean }>(functions, 'revertRoomName')({ roomId, messageId });
}

export async function endStudySession(roomId: string): Promise<boolean> {
  const fn = httpsCallable<{ roomId: string }, { ended: boolean }>(functions, 'endStudySession');
  return (await fn({ roomId })).data.ended;
}

export interface CreateRoomInput {
  roomName: string;
  roomEmoji: string;
  language: string;
  mentorConfig: unknown;
  appVersion: string;
  displayName: string;
  avatar: string;
  asParticipant: boolean;
  profileId: string | null;
}

export async function createStudyRoom(input: CreateRoomInput): Promise<{ roomId: string; pin: string; roomName: string; roomEmoji: string; hostUid: string }> {
  const fn = httpsCallable<CreateRoomInput, { roomId: string; pin: string; roomName: string; roomEmoji: string; hostUid: string }>(functions, 'createStudyRoom');
  return (await fn(input)).data;
}
