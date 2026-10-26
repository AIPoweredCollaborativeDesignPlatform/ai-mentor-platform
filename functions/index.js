import { Readable } from 'node:stream';
import { initializeApp } from 'firebase-admin/app';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { getSystemConfig } from './src/config.js';
import { Anthropic, classifyError, createMessage, extractSvg, imageBlockFromDataUrl, parseJsonObject, responseText } from './src/claude.js';
import { PROMPT_VERSION, VISION_PROMPT, buildTranscript, mentorSystemPrompt, sketchToSvgPrompt, textToSvgPrompt } from './src/prompts.js';
import { generateImages } from './src/images.js';
import { generate3D, refineMeshy } from './src/mesh3d.js';
import { countWebSearches, logAiCall } from './src/log.js';

initializeApp();

// Set with `firebase functions:secrets:set <NAME>`; unused providers can be set to "none"
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const FAL_KEY = defineSecret('FAL_KEY');
const MESHY_API_KEY = defineSecret('MESHY_API_KEY');
const TRIPO_API_KEY = defineSecret('TRIPO_API_KEY');

const requireAuth = request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in (guest is fine) to use AI features.');
};

const FRIENDLY_ERRORS = {
  KEY_INVALID: 'The AI service key is not configured correctly. Please contact the study administrator.',
  QUOTA_EXCEEDED: 'The AI service is rate-limited right now. Please retry in a moment.',
  HIGH_DEMAND: 'The AI service is overloaded right now (high demand). Please retry.',
  NETWORK: 'Could not reach the AI service. Please retry.',
  BAD_REQUEST: 'The AI request was rejected. Please retry or rephrase.',
  PARSE_ERROR: 'The AI returned an unexpected format. Please retry.',
  UNKNOWN: 'The AI request failed. Please retry.'
};

const toHttpsError = (err, label) => {
  const category = classifyError(err);
  console.error(`[${label}] ${category}:`, err?.message || err);
  return new HttpsError('internal', FRIENDLY_ERRORS[category], { category });
};

/** Log entry shared by the smaller AI endpoints (images are recorded by size only). */
const baseLog = (request, kind, model) => ({
  kind,
  roomId: request.data?.roomId || null,
  callerUid: request.auth?.uid || null,
  model,
  promptVersion: PROMPT_VERSION
});

const meta = (model, response) => ({
  model,
  promptVersion: PROMPT_VERSION,
  usage: response?.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null
});

// ---------- AI Mentor ----------
export const mentorAnalyze = onCall(
  { secrets: [ANTHROPIC_API_KEY, FAL_KEY], timeoutSeconds: 180, memory: '512MiB', maxInstances: 20 },
  async request => {
    requireAuth(request);
    const { messages = [], participants = {}, whiteboardMemories = [], config = {}, forced = false, language = 'zh-TW', roomId = 'room' } = request.data || {};
    const sys = await getSystemConfig();
    const model = sys.models.mentor;
    const startedAt = Date.now();

    const systemPrompt = mentorSystemPrompt({ config, language, whiteboardMemories, participants, messages });
    const userPrompt = `Conversation transcript:\n${buildTranscript(messages, participants)}\n\n${forced ? 'The team explicitly asked the mentor (forced).' : 'Autonomous check (not explicitly asked).'}\nRespond with the JSON object only.`;
    const params = {
      model,
      max_tokens: 8000,
      output_config: { effort: sys.mentorEffort },
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    };
    const webSearch = config.enableFactRetrieval
      ? [{ type: sys.webSearchTool, name: 'web_search', max_uses: sys.webSearchMaxUses }]
      : null;

    // Everything the model saw and decided, including non-interventions (research plan §5)
    const log = {
      kind: 'mentor',
      roomId,
      callerUid: request.auth.uid,
      trigger: forced ? 'forced' : 'auto',
      triggerMessageId: messages.at(-1)?.id || null,
      model,
      promptVersion: PROMPT_VERSION,
      config,
      language,
      input: { systemPrompt, userPrompt, messageCount: messages.length },
      webSearchOffered: Boolean(webSearch),
      webSearchFallback: false
    };

    let response;
    try {
      try {
        response = await createMessage(ANTHROPIC_API_KEY.value(), webSearch ? { ...params, tools: webSearch } : params);
      } catch (err) {
        // A model/tool-version mismatch must not take the mentor down: retry without web search
        if (!(webSearch && err instanceof Anthropic.BadRequestError)) throw err;
        console.warn('[mentorAnalyze] web search rejected, retrying without tools:', err.message);
        log.webSearchFallback = true;
        response = await createMessage(ANTHROPIC_API_KEY.value(), params);
      }
      const rawText = responseText(response);
      const { assessment = null, ...result } = parseJsonObject(rawText);

      if (forced && !result.shouldIntervene) {
        result.shouldIntervene = true;
        result.aiMessage ||= language === 'en' ? 'How can I help your design discussion?' : '需要我協助你們的設計討論嗎？';
      }

      if (result.shouldIntervene && result.assetType === 'moodboard' && Array.isArray(result.assetData?.images)) {
        const urls = await generateImages(result.assetData.images.map(i => i.prompt || i.title || 'design concept'), {
          falKey: FAL_KEY.value(),
          model: sys.imageModel,
          folder: `moodboard/${roomId}`
        });
        result.assetData.images = result.assetData.images.map((img, i) => ({ ...img, url: urls[i], isAiGenerated: true }));
      }

      await logAiCall({
        ...log,
        output: { rawText, assessment, shouldIntervene: Boolean(result.shouldIntervene), assetType: result.assetType || null, result },
        webSearches: countWebSearches(response),
        usage: meta(model, response).usage,
        latencyMs: Date.now() - startedAt
      });
      // The assessment stays server-side; participants never receive it
      return { ...result, meta: meta(model, response) };
    } catch (err) {
      const category = classifyError(err);
      console.error('[mentorAnalyze]', category, err?.message || err);
      await logAiCall({ ...log, error: { category, message: String(err?.message || err).slice(0, 500) }, latencyMs: Date.now() - startedAt });
      // Autonomous checks fail silently; explicit requests get a visible, retryable message
      return forced
        ? { shouldIntervene: true, aiMessage: `⚠️ AI Mentor: ${FRIENDLY_ERRORS[category]}`, meta: meta(model, null) }
        : { shouldIntervene: false, meta: meta(model, null) };
    }
  }
);

export const whiteboardVision = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 20 },
  async request => {
    requireAuth(request);
    const sys = await getSystemConfig();
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.vision,
        max_tokens: 1000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(request.data?.imageDataUrl), { type: 'text', text: VISION_PROMPT }] }]
      });
      const summary = responseText(response).trim();
      await logAiCall({
        ...baseLog(request, 'whiteboard_vision', sys.models.vision),
        input: { imageBytes: String(request.data?.imageDataUrl || '').length, assetId: request.data?.assetId || null },
        output: { summary },
        usage: meta(sys.models.vision, response).usage
      });
      return { summary, meta: meta(sys.models.vision, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'whiteboard_vision', sys.models.vision), error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'whiteboardVision');
    }
  }
);

// ---------- Whiteboard SVG ----------
export const generateSvg = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, maxInstances: 20 },
  async request => {
    requireAuth(request);
    const sys = await getSystemConfig();
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: textToSvgPrompt(String(request.data?.prompt || '').slice(0, 2000)) }]
      });
      const svg = extractSvg(responseText(response));
      await logAiCall({ ...baseLog(request, 'text_to_svg', sys.models.svg), input: { prompt: request.data?.prompt || '' }, output: { svg }, usage: meta(sys.models.svg, response).usage });
      return { svg, meta: meta(sys.models.svg, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'text_to_svg', sys.models.svg), input: { prompt: request.data?.prompt || '' }, error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'generateSvg');
    }
  }
);

/** Hand-drawn strokes or an uploaded sketch photo → clean SVG. */
export const sketchToSvg = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, maxInstances: 20 },
  async request => {
    requireAuth(request);
    const { imageDataUrl, notes = '', language = 'zh-TW' } = request.data || {};
    const sys = await getSystemConfig();
    try {
      const response = await createMessage(ANTHROPIC_API_KEY.value(), {
        model: sys.models.svg,
        max_tokens: 8000,
        messages: [{ role: 'user', content: [imageBlockFromDataUrl(imageDataUrl), { type: 'text', text: sketchToSvgPrompt(String(notes).slice(0, 2000), language) }] }]
      });
      const svg = extractSvg(responseText(response));
      await logAiCall({ ...baseLog(request, 'sketch_to_svg', sys.models.svg), input: { notes, imageBytes: String(imageDataUrl || '').length }, output: { svg }, usage: meta(sys.models.svg, response).usage });
      return { svg, meta: meta(sys.models.svg, response) };
    } catch (err) {
      await logAiCall({ ...baseLog(request, 'sketch_to_svg', sys.models.svg), input: { notes }, error: { message: String(err?.message || err).slice(0, 500) } });
      throw toHttpsError(err, 'sketchToSvg');
    }
  }
);

// ---------- 3D ----------
const meshKeys = () => ({ meshy: MESHY_API_KEY.value(), tripo: TRIPO_API_KEY.value() });

export const generateModel3D = onCall(
  { secrets: [MESHY_API_KEY, TRIPO_API_KEY], timeoutSeconds: 540, memory: '512MiB', maxInstances: 10 },
  async request => {
    requireAuth(request);
    const sys = await getSystemConfig();
    const prompt = String(request.data?.prompt || '').trim().slice(0, 1000);
    if (!prompt) throw new HttpsError('invalid-argument', 'Missing 3D prompt');
    try {
      const result = await generate3D({ engine: sys.engine3D, prompt, keys: meshKeys() });
      await logAiCall({ ...baseLog(request, 'model_3d', sys.engine3D), input: { prompt }, output: result });
      return result;
    } catch (err) {
      console.error('[generateModel3D]', err?.message || err);
      await logAiCall({ ...baseLog(request, 'model_3d', sys.engine3D), input: { prompt }, error: { message: String(err?.message || err).slice(0, 500) } });
      throw new HttpsError('internal', err?.message || '3D generation failed');
    }
  }
);

export const refineModel3D = onCall(
  { secrets: [MESHY_API_KEY, TRIPO_API_KEY], timeoutSeconds: 540, memory: '512MiB', maxInstances: 10 },
  async request => {
    requireAuth(request);
    const { taskId, texturePrompt } = request.data || {};
    if (!taskId) throw new HttpsError('invalid-argument', 'Missing Meshy task id');
    try {
      const result = await refineMeshy({ previewTaskId: taskId, texturePrompt, keys: meshKeys() });
      await logAiCall({ ...baseLog(request, 'model_3d_refine', 'meshy'), input: { taskId, texturePrompt: texturePrompt || '' }, output: result });
      return result;
    } catch (err) {
      console.error('[refineModel3D]', err?.message || err);
      throw new HttpsError('internal', err?.message || '3D refinement failed');
    }
  }
);

// ---------- Legacy GLB download proxy (older chat messages still point at provider URLs) ----------
export const proxyGlb = onRequest({ invoker: 'public', memory: '256MiB', maxInstances: 10, cors: true }, async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');
  try {
    const upstream = await fetch(String(url));
    if (!upstream.ok) return res.status(upstream.status).send('Upstream Error: ' + upstream.statusText);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    if (filename) res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(String(filename))}"`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});
