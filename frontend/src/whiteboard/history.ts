/** Snapshot of one object: null = it did not exist. */
export type ObjectState = { z: number; fabric: Record<string, any> } | null;

export interface HistoryEntry {
  before: Map<string, ObjectState>;
  after: Map<string, ObjectState>;
}

const LIMIT = 100;

/**
 * Per-user undo/redo: only my own operations are recorded, so undoing never reverts what others did.
 * Applying an entry writes the stored states back through the normal sync path.
 */
export function createHistory(apply: (states: Map<string, ObjectState>) => Promise<void> | void) {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];

  const record = (before: Map<string, ObjectState>, after: Map<string, ObjectState>) => {
    const changed = [...after.keys()].some(id => JSON.stringify(before.get(id) ?? null) !== JSON.stringify(after.get(id) ?? null));
    if (!changed) return;
    undoStack.push({ before, after });
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
  };

  const undo = async () => {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push(entry);
    await apply(entry.before);
  };

  const redo = async () => {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push(entry);
    await apply(entry.after);
  };

  return {
    record,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0
  };
}
