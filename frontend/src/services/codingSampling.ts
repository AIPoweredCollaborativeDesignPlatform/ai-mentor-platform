import type { MessageItem } from '../types';
export type SamplingKind = 'intervention' | 'semantic' | 'tool' | 'random';
export interface SamplingEvent { kind: SamplingKind; ref: string }
export const humanText = (m: MessageItem) => !!m.senderUid && !['ai_mentor', 'ai_mentor_3d', 'system'].includes(m.senderUid) && m.type === 'text' && !!m.content?.trim() && m.status !== 'failed';
export function humanWindow(messages: MessageItem[], targetId: string) {
  const humans = messages.filter(humanText);
  const i = humans.findIndex(m => m.id === targetId);
  return i < 0 ? [] : humans.slice(Math.max(0, i - 5), i + 6);
}
export function atOrBefore(messages: MessageItem[], at: number) {
  let found = -1;
  messages.forEach((m, i) => { if (humanText(m) && m.timestamp <= at) found = i; });
  return found;
}
export function roundRobin<T extends { events?: SamplingEvent[] }>(items: T[], random = Math.random): T[] {
  const groups = (['intervention', 'semantic', 'tool', 'random'] as SamplingKind[]).map(kind => {
    const pool = items.filter(q => q.events?.some(e => e.kind === kind));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool;
  });
  const seen = new Set<T>(); const result: T[] = [];
  while (groups.some(g => g.length)) for (const group of groups) {
    let next = group.pop();
    while (next && seen.has(next)) next = group.pop();
    if (next) { seen.add(next); result.push(next); }
  }
  return result.reverse(); // The view consumes from the end.
}
