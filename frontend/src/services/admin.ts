import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, runTransaction, setDoc, where
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase/config';
import type { AiProfile } from '../utils/aiProfiles';

// Study-admin data access; Firestore rules restrict these collections to the admin account.

export async function listProfiles(): Promise<AiProfile[]> {
  const snap = await getDocs(collection(db, 'aiProfiles'));
  return snap.docs
    .map(d => ({ ...(d.data() as AiProfile & { archived?: boolean }), id: d.id }))
    .filter(p => !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves as a new version and archives that version under aiProfiles/{id}/versions. */
export async function saveProfile(profile: AiProfile, editorEmail: string): Promise<AiProfile> {
  const { id, ...data } = profile;
  const ref = id ? doc(db, 'aiProfiles', id) : doc(collection(db, 'aiProfiles'));
  return runTransaction(db, async tx => {
    const current = await tx.get(ref);
    const version = ((current.data()?.version as number) || 0) + 1;
    const saved = { ...data, version, updatedAt: Date.now(), updatedBy: editorEmail };
    tx.set(ref, saved);
    tx.set(doc(db, 'aiProfiles', ref.id, 'versions', String(version)), saved);
    return { ...saved, id: ref.id };
  });
}

export interface StudyRoom {
  roomId: string;
  pin: string;
  roomName?: string;
  createdAt?: number;
  lastActive?: number;
  roomStatus?: string;
  appVersion?: string;
  assignment?: { profileId: string | null; profileVersion: number; profileName?: string; mode?: string; assignedAt?: number; assignedBy?: string };
}

/** Rooms created by the redesigned site (they carry appVersion), newest first. */
export async function listStudyRooms(max = 100): Promise<StudyRoom[]> {
  const snap = await getDocs(query(collection(db, 'rooms'), orderBy('appVersion'), limit(max)));
  const rooms = snap.docs.map(d => ({ ...(d.data() as any), roomId: d.id }) as StudyRoom).filter(r => !(r as any).deletedAt);
  await Promise.all(rooms.map(async r => {
    const ai = await getDoc(doc(db, 'roomAi', r.roomId));
    const data = ai.data();
    if (data) {
      r.assignment = {
        profileId: data.profileId,
        profileVersion: data.profileVersion,
        profileName: data.profile?.name,
        mode: data.profile?.mode,
        assignedAt: data.assignedAt,
        assignedBy: data.assignedBy
      };
    }
  }));
  return rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function assignRoomProfile(roomId: string, profileId: string) {
  const fn = httpsCallable<{ roomId: string; profileId: string }, { profileId: string; profileVersion: number }>(functions, 'assignRoomProfile');
  return (await fn({ roomId, profileId })).data;
}

export async function getSystemConfig(): Promise<Record<string, any>> {
  return (await getDoc(doc(db, 'config', 'system'))).data() || {};
}

export async function saveSystemConfig(patch: Record<string, any>) {
  await setDoc(doc(db, 'config', 'system'), patch, { merge: true });
}

export interface UsageRow {
  roomId: string | null;
  kind: string;
  model: string;
  input: number;
  output: number;
  webSearches: number;
  createdAt: number;
}

/** Token usage recorded in aiLogs since `sinceMs` (used for actual-cost reporting). */
export async function loadUsage(sinceMs: number, max = 2000): Promise<UsageRow[]> {
  const snap = await getDocs(query(collection(db, 'aiLogs'), where('createdAt', '>=', new Date(sinceMs)), orderBy('createdAt', 'desc'), limit(max)));
  return snap.docs.map(d => {
    const x = d.data();
    return {
      roomId: x.roomId || null,
      kind: x.kind,
      model: x.model || '',
      input: x.usage?.input || 0,
      output: x.usage?.output || 0,
      webSearches: x.webSearches || 0,
      createdAt: x.createdAt?.toMillis?.() || 0
    };
  });
}
