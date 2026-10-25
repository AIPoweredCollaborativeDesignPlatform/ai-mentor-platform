import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';
import { currentLocale } from '../i18n';
import type { MentorConfig, MessageItem, Participant } from '../types';

// All model calls run in Cloud Functions (functions/index.js); models are chosen in config/system.

export interface AiCallMeta {
  model: string;
  promptVersion: string;
  usage: { input: number; output: number } | null;
}

export interface AiActionResponse {
  shouldIntervene: boolean;
  aiMessage?: string;
  actionOptions?: string[];
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract' | 'fact_check' | null;
  assetData?: any;
  meta?: AiCallMeta;
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

const MAX_CONTEXT_MESSAGES = 60;

/** Resolves with the call result, or rejects as soon as `signal` aborts (the server call is simply ignored). */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('AI analysis aborted by user'));
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('AI analysis aborted by user')), { once: true });
    promise.then(resolve, reject);
  });
}

async function call<Req, Res>(name: string, data: Req, signal?: AbortSignal): Promise<Res> {
  const fn = httpsCallable<Req, Res>(functions, name, { timeout: 540_000 });
  const result = await abortable(fn(data), signal);
  return result.data;
}

// Only what the prompt needs; attachments (data URLs) are never sent
const toContextMessage = (m: MessageItem) => ({
  senderUid: m.senderUid,
  senderName: m.senderName,
  content: (m.content || '').slice(0, 1500),
  timestamp: m.timestamp,
  reactions: m.reactions || {},
  actionOptions: m.actionOptions || [],
  pollVotes: m.pollVotes || {}
});

export async function analyzeDialogue(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean,
  abortSignal?: AbortSignal,
  whiteboardMemories?: WhiteboardMemoryItem[],
  participants?: Record<string, Participant>,
  roomId?: string
): Promise<AiActionResponse> {
  const slimParticipants = Object.fromEntries(
    Object.entries(participants || {}).map(([uid, p]) => [uid, { uid, displayName: p.displayName, isHost: !!p.isHost, status: p.status }])
  );
  return call('mentorAnalyze', {
    messages: messages.filter(m => m.senderUid !== 'system').slice(-MAX_CONTEXT_MESSAGES).map(toContextMessage),
    participants: slimParticipants,
    whiteboardMemories: (whiteboardMemories || []).slice(-6),
    config,
    forced,
    language: currentLocale.value,
    roomId
  }, abortSignal);
}

export async function summarizeWhiteboardVisualSnapshot(imageDataUrl: string): Promise<string> {
  if (!imageDataUrl) return '';
  try {
    const res = await call<{ imageDataUrl: string }, { summary: string }>('whiteboardVision', { imageDataUrl });
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
