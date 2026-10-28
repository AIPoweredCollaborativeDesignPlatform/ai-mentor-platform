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
export async function peekStudyRoom(roomId: string): Promise<{ exists: boolean; roomName?: string; isHost?: boolean }> {
  const fn = httpsCallable<{ roomId: string }, { exists: boolean; roomName?: string; isHost?: boolean }>(functions, 'peekStudyRoom');
  return (await fn({ roomId })).data;
}

export async function reopenStudySession(roomId: string): Promise<boolean> {
  const fn = httpsCallable<{ roomId: string }, { reopened: boolean }>(functions, 'reopenStudySession');
  return (await fn({ roomId })).data.reopened;
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
