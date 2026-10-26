import { collection, deleteDoc, doc, onSnapshot, setDoc, writeBatch, type Unsubscribe } from 'firebase/firestore';
import { db } from '../firebase/config';

/** rooms/{roomId}/boards/{boardId}/objects/{id} */
export interface ObjectDoc {
  z: number;
  fabric: Record<string, any>;
  updatedBy: string;
  updatedAt: number;
}

export interface RemoteChange {
  type: 'added' | 'modified' | 'removed';
  id: string;
  data?: ObjectDoc;
}

/** rooms/{roomId}/boards/{boardId}/presence/{uid} */
export interface PresenceDoc {
  uid: string;
  name: string;
  color: string;
  x: number | null;
  y: number | null;
  /** Points of the stroke being drawn (flattened x,y pairs, canvas coordinates) */
  live?: { points: number[]; color: string; width: number } | null;
  /** Ids of objects this user is moving or editing */
  editing?: string[];
  at: number;
}

const PRESENCE_THROTTLE_MS = 80;
export const PRESENCE_STALE_MS = 15_000;

/**
 * Firestore channel of one board: each object is its own document (last writer wins per object),
 * presence is one small document per viewer. Our own writes are filtered out of the listener
 * (hasPendingWrites), so remote changes are only ever other people's edits.
 */
export function createBoardSync(roomId: string, boardId: string, uid: string) {
  const objects = collection(db, 'rooms', roomId, 'boards', boardId, 'objects');
  const presenceCol = collection(db, 'rooms', roomId, 'boards', boardId, 'presence');
  const unsubs: Unsubscribe[] = [];

  const docOf = (id: string, z: number, fabric: Record<string, any>): ObjectDoc => ({ z, fabric, updatedBy: uid, updatedAt: Date.now() });

  const listenObjects = (onInitial: (docs: Map<string, ObjectDoc>) => void, onChanges: (changes: RemoteChange[]) => void, onError: (e: Error) => void) => {
    let first = true;
    unsubs.push(onSnapshot(objects, snap => {
      if (first) {
        first = false;
        const all = new Map<string, ObjectDoc>();
        snap.docs.forEach(d => all.set(d.id, d.data() as ObjectDoc));
        onInitial(all);
        return;
      }
      const changes: RemoteChange[] = [];
      snap.docChanges().forEach(c => {
        if (c.doc.metadata.hasPendingWrites) return;
        changes.push({ type: c.type, id: c.doc.id, data: c.type === 'removed' ? undefined : (c.doc.data() as ObjectDoc) });
      });
      if (changes.length) onChanges(changes);
    }, onError));
  };

  const writeObject = (id: string, z: number, fabric: Record<string, any>) =>
    setDoc(doc(objects, id), docOf(id, z, fabric)).catch(e => console.warn('[whiteboard] write failed', e));

  const deleteObject = (id: string) => deleteDoc(doc(objects, id)).catch(e => console.warn('[whiteboard] delete failed', e));

  /** Writes and deletes in batches of 400 (Firestore allows 500 per batch). */
  const commit = async (writes: { id: string; z: number; fabric: Record<string, any> }[], deletes: string[] = []) => {
    const ops = [...writes.map(w => ({ kind: 'set' as const, ...w })), ...deletes.map(id => ({ kind: 'del' as const, id }))];
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      for (const op of ops.slice(i, i + 400)) {
        if (op.kind === 'set') batch.set(doc(objects, op.id), docOf(op.id, op.z, op.fabric));
        else batch.delete(doc(objects, op.id));
      }
      await batch.commit().catch(e => console.warn('[whiteboard] batch failed', e));
    }
  };

  // ---------- presence ----------
  let pending: Partial<PresenceDoc> = {};
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPresenceAt = 0;
  let base: Pick<PresenceDoc, 'uid' | 'name' | 'color'> | null = null;

  const flushPresence = () => {
    presenceTimer = undefined;
    lastPresenceAt = Date.now();
    if (!base) return;
    const data = { ...base, ...pending, at: Date.now() };
    pending = {};
    setDoc(doc(presenceCol, uid), data, { merge: true }).catch(() => {});
  };

  const updatePresence = (patch: Partial<PresenceDoc>, immediate = false) => {
    Object.assign(pending, patch);
    if (immediate) {
      clearTimeout(presenceTimer);
      flushPresence();
      return;
    }
    if (presenceTimer) return;
    presenceTimer = setTimeout(flushPresence, Math.max(0, PRESENCE_THROTTLE_MS - (Date.now() - lastPresenceAt)));
  };

  const startPresence = (me: Pick<PresenceDoc, 'uid' | 'name' | 'color'>, onPresence: (others: PresenceDoc[]) => void) => {
    base = me;
    updatePresence({ x: null, y: null, live: null, editing: [] }, true);
    unsubs.push(onSnapshot(presenceCol, snap => {
      const now = Date.now();
      onPresence(snap.docs.map(d => d.data() as PresenceDoc).filter(p => p.uid !== uid && now - (p.at || 0) < PRESENCE_STALE_MS));
    }, () => {}));
  };

  const stop = async () => {
    unsubs.splice(0).forEach(u => u());
    clearTimeout(presenceTimer);
    if (base) await deleteDoc(doc(presenceCol, uid)).catch(() => {});
    base = null;
  };

  return { listenObjects, writeObject, deleteObject, commit, updatePresence, startPresence, stop };
}

export type BoardSync = ReturnType<typeof createBoardSync>;
