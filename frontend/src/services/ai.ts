import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';
import { currentLocale } from '../i18n';
import { useRoomStore } from '../stores/room';
import type { MentorConfig } from '../types';

// All model calls run in Cloud Functions (functions/index.js); models are chosen in config/system.

export interface AiCallMeta {
  model: string;
  promptVersion: string;
  usage: { input: number; output: number } | null;
}

export interface WhiteboardMemoryItem {
  timestamp: number;
  timeFormatted: string;
  summary: string;
  assetId?: string;
}

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

const SVG_ERROR_TEXT: Record<SvgGenerationError['category'], [string, string]> = {
  KEY_INVALID: ['AI service not configured', 'Please ask the study administrator to check the AI service key.'],
  QUOTA_EXCEEDED: ['AI service busy', 'The AI service is rate-limited. Please retry in a moment.'],
  HIGH_DEMAND: ['AI service overloaded', 'The AI service is under heavy load. Please retry in a few seconds.'],
  PARSE_ERROR: ['SVG Format Error', 'The AI output could not be parsed as SVG. Try a more specific prompt (e.g. "flat blue star icon").'],
  NETWORK: ['Network Connection Error', 'Unable to reach the AI service. Please check your connection.'],
  BAD_REQUEST: ['Request rejected', 'The AI rejected this request. Please try a different prompt.'],
  UNKNOWN: ['AI Vector Generation Failed', 'Please try again.']
};

// Whiteboard expects this structured error shape (see CollaborativeWhiteboard error toasts)
function toSvgError(err: any, model: string): SvgGenerationError {
  const category: SvgGenerationError['category'] = err?.details?.category || (err?.code === 'functions/unavailable' ? 'NETWORK' : 'UNKNOWN');
  const [title, suggestion] = SVG_ERROR_TEXT[category] || SVG_ERROR_TEXT.UNKNOWN;
  const message = err?.message || String(err);
  return { isAiError: true, category, title, suggestion, attempts: [{ model, error: message }], rawMessage: message };
}

export async function generateSvgForWhiteboard(prompt: string, _config?: MentorConfig, abortSignal?: AbortSignal): Promise<string> {
  try {
    const res = await call<{ prompt: string }, { svg: string }>('generateSvg', { prompt }, abortSignal);
    return res.svg;
  } catch (err: any) {
    if (err?.message?.includes('aborted')) throw err;
    throw toSvgError(err, 'generateSvg');
  }
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

/**
 * @deprecated Keys now live server-side. Kept only so the legacy whiteboard's "key configured?" guard passes;
 * remove together with that component in P3.
 */
export const getStoredGeminiApiKey = () => 'server';
