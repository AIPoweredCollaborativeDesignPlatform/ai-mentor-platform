import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';

// Experiment flow callables (functions/src/session.js): joining is approved server-side.

export interface JoinResult {
  status: 'approved' | 'full' | 'ended' | 'not_found' | 'consent_required';
  role?: 'researcher' | 'participant';
  returning?: boolean;
  online?: number;
  max?: number;
}

/** `retry` marks the automatic re-tries while a room is full (logged only once). */
export async function joinStudyRoom(roomId: string, displayName: string, avatar: string, consent: boolean, retry = false): Promise<JoinResult> {
  const fn = httpsCallable<{ roomId: string; displayName: string; avatar: string; consent: boolean; retry: boolean }, JoinResult>(functions, 'joinStudyRoom');
  return (await fn({ roomId, displayName, avatar, consent, retry })).data;
}

export async function reopenStudySession(roomId: string): Promise<boolean> {
  const fn = httpsCallable<{ roomId: string }, { reopened: boolean }>(functions, 'reopenStudySession');
  return (await fn({ roomId })).data.reopened;
}

export async function endStudySession(roomId: string): Promise<boolean> {
  const fn = httpsCallable<{ roomId: string }, { ended: boolean }>(functions, 'endStudySession');
  return (await fn({ roomId })).data.ended;
}
