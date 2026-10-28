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
  session?: { phase: string; expected: number; maxOnline: number; taskMinutes: number; startedAt?: number; endedAt?: number; endedBy?: string };
  upload?: RoomExport;
  assignment?: { profileId: string | null; profileVersion: number; profileName?: string; mode?: string; assignedAt?: number; assignedBy?: string };
}

/** Rooms created by the redesigned site (they carry appVersion), newest first. */
export async function listStudyRooms(max = 100): Promise<StudyRoom[]> {
  const snap = await getDocs(query(collection(db, 'rooms'), orderBy('appVersion'), limit(max)));
  const rooms = snap.docs.map(d => ({ ...(d.data() as any), roomId: d.id }) as StudyRoom).filter(r => !(r as any).deletedAt);
  await Promise.all(rooms.map(async r => {
    const exp = await getDoc(doc(db, 'roomExports', r.roomId));
    if (exp.exists()) r.upload = exp.data() as RoomExport;
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

// ---------- Google Drive export (functions/src/drive.js) ----------
export interface RoomExport {
  status: 'pending' | 'uploading' | 'done' | 'error' | 'needs_auth' | 'reopened';
  dueAt?: number;
  attempts?: number;
  finishedAt?: number;
  folderUrl?: string;
  fileCount?: number;
  error?: string | null;
}

export interface DriveStatus {
  status: 'ok' | 'needs_auth';
  connectedAt?: number;
  connectedBy?: string;
  /** Google account whose Drive receives the data */
  driveAccount?: string | null;
  rootFolderId?: string;
  /** false: the app folder sits in My Drive and should be moved into the study folder by hand */
  rootInConfiguredFolder?: boolean;
  error?: string | null;
}

export async function getDriveStatus(): Promise<DriveStatus | null> {
  return ((await getDoc(doc(db, 'driveStatus', 'current'))).data() as DriveStatus) || null;
}

/** Google consent page for connecting (or reconnecting) the study Drive. */
export async function getDriveAuthUrl() {
  const fn = httpsCallable<void, { url: string }>(functions, 'driveAuthUrl');
  return (await fn()).data.url;
}

export async function exportRoomNow(roomId: string) {
  const fn = httpsCallable<{ roomId: string }, RoomExport & { status: string }>(functions, 'exportRoomNow');
  return (await fn({ roomId })).data;
}

export interface PinRow {
  pin: string;
  roomName: string;
  createdAt: number | null;
  lastActive: number | null;
  reason?: 'deleted' | 'never_created';
  deletedAt?: number | null;
}
export interface RoomPins {
  inUse: PinRow[];
  ended: PinRow[];
  invalid: PinRow[];
  free: string[];
}

export async function listRoomPins(): Promise<RoomPins> {
  const fn = httpsCallable<void, RoomPins>(functions, 'listRoomPins');
  return (await fn()).data;
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

// ---------- Observers (functions/src/roles.js) ----------
export interface StudyObserver {
  email: string;
  addedAt: number;
  addedBy: string;
}

export async function listObservers(): Promise<StudyObserver[]> {
  const fn = httpsCallable<void, { observers: StudyObserver[] }>(functions, 'listStudyObservers');
  return (await fn()).data.observers;
}

/** `applied` is false when the account has not signed in yet; the role is then set on their first sign-in. */
export async function setObserver(email: string, add: boolean) {
  const fn = httpsCallable<{ email: string; add: boolean }, { email: string; applied: boolean }>(functions, 'setStudyObserver');
  return (await fn({ email, add })).data;
}
