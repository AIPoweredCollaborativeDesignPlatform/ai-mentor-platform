import Anthropic from '@anthropic-ai/sdk';

let client = null;
export const getClient = apiKey => (client ||= new Anthropic({ apiKey }));

const MAX_PAUSE_CONTINUATIONS = 3;

/**
 * messages.create with server-tool continuation: a web-search turn can stop with `pause_turn`,
 * in which case the partial assistant turn is sent back so Claude can finish.
 */
export async function createMessage(apiKey, params) {
  const messages = [...params.messages];
  let response;
  for (let i = 0; i <= MAX_PAUSE_CONTINUATIONS; i++) {
    response = await getClient(apiKey).messages.create({ ...params, messages });
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined to respond to this request.');
  }
  return response;
}

export const responseText = response =>
  response.content.filter(b => b.type === 'text').map(b => b.text).join('');

/** Extracts the outermost JSON object from model text (tolerates code fences and citations around it). */
export function parseJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('AI response did not contain JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export function extractSvg(text) {
  const match = text.replace(/```(xml|svg|html)?/gi, '').match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) throw new Error('AI responded, but output did not contain a valid <svg> element.');
  return match[0];
}

/** Splits a data URL into an Anthropic base64 image block. */
export function imageBlockFromDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Unsupported image data (expected PNG, JPEG, GIF or WebP data URL)');
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

/** Maps SDK errors to a short user-facing category; never leaks keys or raw payloads. */
export function classifyError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'KEY_INVALID';
  if (err instanceof Anthropic.RateLimitError) return 'QUOTA_EXCEEDED';
  if (err instanceof Anthropic.InternalServerError) return 'HIGH_DEMAND';
  if (err instanceof Anthropic.APIConnectionError) return 'NETWORK';
  if (err instanceof Anthropic.BadRequestError) return 'BAD_REQUEST';
  if (/svg|JSON/.test(err?.message || '')) return 'PARSE_ERROR';
  return 'UNKNOWN';
}

export { Anthropic };
