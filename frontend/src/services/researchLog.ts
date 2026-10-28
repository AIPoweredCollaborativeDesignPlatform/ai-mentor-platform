import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase/config';

/**
 * Browser half of the research event log (rooms/{roomId}/events; the server half is
 * functions/src/events.js). Events are buffered and written in batches every few seconds and
 * whenever the page is hidden, so logging never slows the UI. Admin-read only (firestore.rules).
 */

export type ResearchRole = 'participant' | 'researcher' | 'observer';

interface PendingEvent {
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

const FLUSH_MS = 5000;

let roomId: string | null = null;
let uid = '';
let role: ResearchRole = 'participant';
let buffer: PendingEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
// Off while the session has ended (nothing is recorded until it is reopened)
let recording = true;

export function setRecording(on: boolean) {
  if (on && !recording && roomId) {
    recording = true;
    logEvent('room_enter', { resumed: true });
    return;
  }
  recording = on;
}

export function logEvent(kind: string, data: Record<string, unknown> = {}) {
  if (!roomId || !recording) return;
  buffer.push({ at: Date.now(), kind, data });
}

export async function flushResearchLog() {
  if (!roomId || !buffer.length) return;
  const events = buffer.splice(0, 400); // one batch holds at most 500 writes
  const target = roomId;
  const batch = writeBatch(db);
  for (const e of events) {
    batch.set(doc(collection(db, 'rooms', target, 'events')), {
      ...e,
      uid,
      role,
      source: 'client',
      serverAt: serverTimestamp()
    });
  }
  await batch.commit().catch(err => {
    console.warn('[researchLog] write failed', err);
    if (roomId === target) buffer.unshift(...events);
  });
}

const onVisibility = () => {
  logEvent(document.visibilityState === 'hidden' ? 'tab_hidden' : 'tab_visible');
  if (document.visibilityState === 'hidden') flushResearchLog();
};
const onBlur = () => logEvent('window_blur');
const onFocus = () => logEvent('window_focus');
const onPageHide = () => {
  logEvent('page_hide');
  flushResearchLog();
};

export function startResearchLog(target: string, myUid: string, myRole: ResearchRole) {
  if (roomId === target) return;
  stopResearchLog();
  roomId = target;
  uid = myUid;
  role = myRole;
  timer = setInterval(flushResearchLog, FLUSH_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pagehide', onPageHide);
  logEvent('room_enter', { userAgent: navigator.userAgent, viewport: { w: window.innerWidth, h: window.innerHeight } });
}

export async function stopResearchLog() {
  if (!roomId) return;
  logEvent('room_leave');
  await flushResearchLog();
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('pagehide', onPageHide);
  roomId = null;
  buffer = [];
}
