import type { ComputedRef, Ref } from 'vue';
import { collection, doc } from 'firebase/firestore';
import { db } from '../../firebase/config';
import type { ParticipantStatus, RoomData, ToastMessage } from '../../types';
import type { useAuthStore } from '../auth';

export type PushToast = (
  title: string,
  description: string,
  type?: ToastMessage['type'],
  actions?: ToastMessage['actions']
) => void;

/** Shared state and helpers handed to every room sub-module. */
export interface RoomContext {
  currentRoom: Ref<RoomData | null>;
  myStatus: Ref<ParticipantStatus>;
  isHost: ComputedRef<boolean>;
  authStore: ReturnType<typeof useAuthStore>;
  pushToast: PushToast;
}

export const roomRef = (roomId: string) => doc(db, 'rooms', roomId);
export const roomDocRef = (roomId: string, sub: string, id: string) => doc(db, 'rooms', roomId, sub, id);
export const roomCollection = (roomId: string, sub: string) => collection(db, 'rooms', roomId, sub);

export const tempId = (prefix = 'temp') =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

/** Firestore rejects `undefined` field values. */
export const stripUndefined = <T extends Record<string, any>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
