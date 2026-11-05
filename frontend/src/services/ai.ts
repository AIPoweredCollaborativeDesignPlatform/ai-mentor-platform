import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';
import { currentLocale, t, type MessageKey } from '../i18n';
import { useRoomStore } from '../stores/room';

// All model calls run in Cloud Functions (functions/index.js); models are chosen in config/system.

export interface SvgGenerationError {
  isAiError: true;
  category: 'KEY_INVALID' | 'HIGH_DEMAND' | 'QUOTA_EXCEEDED' | 'PARSE_ERROR' | 'NETWORK' | 'BAD_REQUEST' | 'UNKNOWN';
  title: string;
  suggestion: string;
  attempts: Array<{ model: string; error: string }>;
  rawMessage: string;
}

/** Resolves with the call result, or rejects as soon as `signal` aborts (the server call is simply ignored). */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('AI analysis aborted by user'));
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('AI analysis aborted by user')), { once: true });
    promise.then(resolve, reject);
  });
}

// Every call carries the room id so the server-side research log (aiLogs) can be grouped per session
async function call<Req extends object, Res>(name: string, data: Req, signal?: AbortSignal): Promise<Res> {
  const fn = httpsCallable<Req & { roomId?: string }, Res>(functions, name, { timeout: 540_000 });
  const result = await abortable(fn({ roomId: useRoomStore().currentRoom?.roomId, ...data }), signal);
  return result.data;
}

/** Forced mentor reply handled server-side; with `retryMessageId` the failed reply is replaced in place. */
export async function requestMentorResponse(roomId: string, retryMessageId?: string): Promise<void> {
  await call('mentorRespond', { roomId, retryMessageId });
}

export async function summarizeWhiteboardVisualSnapshot(imageDataUrl: string, assetId?: string): Promise<string> {
  if (!imageDataUrl) return '';
  try {
    const res = await call<{ imageDataUrl: string; assetId?: string }, { summary: string }>('whiteboardVision', { imageDataUrl, assetId });
    return res.summary || '';
  } catch (err) {
    console.warn('[Whiteboard Vision] failed:', err);
    return '';
  }
}

const SVG_ERROR_TEXT: Record<SvgGenerationError['category'], [MessageKey, MessageKey]> = {
  KEY_INVALID: ['svg.keyInvalidTitle', 'svg.keyInvalidText'],
  QUOTA_EXCEEDED: ['svg.quotaTitle', 'svg.quotaText'],
  HIGH_DEMAND: ['svg.overloadTitle', 'svg.overloadText'],
  PARSE_ERROR: ['svg.parseTitle', 'svg.parseText'],
  NETWORK: ['svg.networkTitle', 'svg.networkText'],
  BAD_REQUEST: ['svg.rejectedTitle', 'svg.rejectedText'],
  UNKNOWN: ['svg.unknownTitle', 'common.tryAgain']
};

// Whiteboard expects this structured error shape (see CollaborativeWhiteboard error toasts)
function toSvgError(err: any, model: string): SvgGenerationError {
  const category: SvgGenerationError['category'] = err?.details?.category || (err?.code === 'functions/unavailable' ? 'NETWORK' : 'UNKNOWN');
  const [titleKey, suggestionKey] = SVG_ERROR_TEXT[category] || SVG_ERROR_TEXT.UNKNOWN;
  const title = t(titleKey);
  const suggestion = t(suggestionKey);
  const message = err?.message || String(err);
  return { isAiError: true, category, title, suggestion, attempts: [{ model, error: message }], rawMessage: message };
}

export async function generateSvgForWhiteboard(prompt: string, _config?: unknown, abortSignal?: AbortSignal): Promise<string> {
  try {
    const res = await call<{ prompt: string }, { svg: string }>('generateSvg', { prompt }, abortSignal);
    return res.svg;
  } catch (err: any) {
    if (err?.message?.includes('aborted')) throw err;
    throw toSvgError(err, 'generateSvg');
  }
}

/** Whiteboard drawing → a clean sketch and a render via fal.ai; the server posts them to the chat. */
export async function sketchFromBoard(imageDataUrl: string, notes = ''): Promise<void> {
  await call<{ imageDataUrl: string; notes: string }, { ok: boolean }>('sketchFromBoard', { imageDataUrl, notes });
}

/** A sketch or photo → a 3D model built from the image itself (render + Meshy image-to-3D); posted to the chat. */
export async function model3DFromImage(imageUrl: string, notes = ''): Promise<void> {
  await call<{ imageUrl: string; notes: string }, { ok: boolean }>('model3DFromImage', { imageUrl, notes });
}

/** Uploaded sketch / photo or an AI sketch → more idea sketches; the server posts them to the chat. */
export async function sketchFromImage(imageUrl: string, notes = ''): Promise<void> {
  await call<{ imageUrl: string; notes: string }, { ok: boolean }>('sketchFromImage', { imageUrl, notes });
}

/** Hand-drawn strokes or an uploaded sketch image → SVG. */
export async function redrawSketchToSvg(imageDataUrl: string, notes = '', language: string = currentLocale.value, _tier?: string, abortSignal?: AbortSignal): Promise<string> {
  try {
    const res = await call<{ imageDataUrl: string; notes: string; language: string }, { svg: string }>(
      'sketchToSvg', { imageDataUrl, notes, language }, abortSignal
    );
    return res.svg;
  } catch (err: any) {
    if (err?.message?.includes('aborted')) throw err;
    throw toSvgError(err, 'sketchToSvg');
  }
}
