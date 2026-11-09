// Persist IDs only: answers and conversations are always reloaded from the database.
export interface Visit { key: string; phase: number; ordinal: number }
export interface NavigationState { version: 1; history: Visit[]; position: number; queue: string[] }
export const navigationStorageKey = (uid: string) => `coding-navigation-v1:${uid}`;
export function restoreNavigation(raw: string | null, available: string[]): NavigationState | null {
  try {
    const saved = JSON.parse(raw || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.history) || !Array.isArray(saved.queue)
      || !Number.isInteger(saved.position) || saved.position < -1 || saved.position > saved.history.length) return null;
    const allowed = new Set(available);
    const valid = (v: Visit) => v && allowed.has(v.key) && [1, 2].includes(v.phase) && Number.isInteger(v.ordinal) && v.ordinal > 0;
    const history = saved.history.filter(valid) as Visit[];
    // Keep the current surviving item, or the closest previous one if it was removed.
    const position = saved.position === saved.history.length ? history.length
      : Math.max(-1, saved.history.slice(0, saved.position + 1).filter(valid).length - 1);
    const seen = new Set(history.map(v => v.key));
    const queue = [...new Set<string>(saved.queue.filter((k: unknown) => typeof k === 'string' && allowed.has(k) && !seen.has(k)))];
    const known = new Set([...seen, ...queue]);
    // Queue is consumed with pop(); append new candidates after the old remaining sequence.
    return { version: 1, history, position, queue: [...available.filter(k => !known.has(k)), ...queue] };
  } catch { return null; }
}
