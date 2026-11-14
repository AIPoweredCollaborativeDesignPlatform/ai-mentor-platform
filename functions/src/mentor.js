import { getSystemConfig } from './config.js';
import { Anthropic, classifyError, createMessage, parseJsonObject, responseText } from './claude.js';
import { PROMPT_VERSION, buildTranscript, memoryPrompt, mentorSystemPrompt } from './prompts.js';
import { generateImages, generateSketches, sketchesFromImage } from './images.js';
import { imageBlock, sketchBrief } from './sketchBrief.js';
import { countWebSearches, logAiCall } from './log.js';

// Attempts at getting a valid JSON reply before the error is shown in the chat
const PARSE_ATTEMPTS = 3;

export const FRIENDLY_ERRORS = {
  KEY_INVALID: 'The AI service key is not configured correctly. Please contact the study administrator.',
  QUOTA_EXCEEDED: 'The AI service is rate-limited right now. Please retry in a moment.',
  HIGH_DEMAND: 'The AI service is overloaded right now (high demand). Please retry.',
  NETWORK: 'Could not reach the AI service. Please retry.',
  BAD_REQUEST: 'The AI request was rejected. Please retry or rephrase.',
  PARSE_ERROR: 'The AI got tangled up for a moment. Please ask again.',
  UNKNOWN: 'The AI request failed. Please retry.'
};

const usageOf = response => (response?.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null);

/**
 * One mentor analysis: builds the prompt from the frozen profile, long-term memory and recent
 * transcript, calls Claude, generates moodboard images if needed, and writes the research log.
 * Never throws; on failure returns { error }.
 */
export async function analyze({ apiKey, falKey, roomId, room, messages, participants, profile, memory, forced, reason, callerUid, visible, note = '', rosterNote = '', requiredTool = null }) {
  const sys = await getSystemConfig();
  const model = sys.models.mentor;
  const language = room.language || 'zh-TW';
  const modules = profile.modules || {};
  const startedAt = Date.now();

  const systemPrompt = mentorSystemPrompt({
    config: modules,
    language,
    whiteboardMemories: room.whiteboardMemories || [],
    participants,
    messages,
    profile,
    memory,
    session: room.session,
    progress: room.progress,
    // A room without a given name gets one from the AI once (proactive condition; engine.js)
    roomNaming: profile.mode === 'proactive' && Boolean(room.nameIsDefault) && !room.autoNamedAt
  });
  // `note` replaces the generic trigger line for system-initiated responses (e.g. a settled poll)
  const userPrompt = `Conversation transcript:\n${buildTranscript(messages, participants)}\n\n${rosterNote ? `${rosterNote}\n` : ''}${
    note || (forced ? 'You were explicitly asked by a participant (forced).' : `Automatic check (reason: ${reason}).`)
  }\nRespond with the JSON object only.`;

  // A tool tag (composer button) fixes the asset type, unless that module is off
  const allowed = { parametric_3d: modules.enable3D, moodboard: modules.enableMoodboard, sketch: modules.enableSketch !== false, fact_check: modules.enableFactRetrieval, summary: modules.enableSummary !== false };
  const tool = requiredTool && allowed[requiredTool] ? requiredTool : null;
  const toolLine = tool ? `\nThe participant attached the "${tool}" tool tag to their message: reply with assetType "${tool}", built from their message and the conversation.` : '';

  const params = {
    model,
    max_tokens: 8000,
    output_config: { effort: sys.mentorEffort },
    system: systemPrompt,
    messages: [{ role: 'user', content: [...recentImageBlocks(messages, forced), { type: 'text', text: userPrompt + toolLine }] }]
  };
  const tools = modules.enableFactRetrieval ? [{ type: sys.webSearchTool, name: 'web_search', max_uses: sys.webSearchMaxUses }] : null;

  // Everything the model saw and decided, including non-interventions (research plan §5)
  const log = {
    kind: 'mentor',
    roomId,
    callerUid: callerUid || null,
    trigger: forced && !['poll_settled', 'suggestion_accepted'].includes(reason) ? 'forced' : reason,
    visible, // false = shadow assessment (no-AI / reactive conditions, or cooldown)
    triggerMessageId: messages.at(-1)?.id || null,
    profileId: profile.id || null,
    profileVersion: profile.version ?? null,
    mode: profile.mode,
    model,
    promptVersion: PROMPT_VERSION,
    language,
    input: { systemPrompt, userPrompt, messageCount: messages.length, requiredTool: tool, imagesSeen: params.messages[0].content.filter(b => b.type === 'text' && b.text.startsWith('[image id=')).map(b => b.text.slice(10, b.text.indexOf(']'))) },
    webSearchOffered: Boolean(tools),
    webSearchFallback: false
  };

  try {
    let response, rawText, parsed;
    // A reply that is not valid JSON is retried quietly; the team only sees an error if every attempt fails
    for (let attempt = 1; ; attempt++) {
      try {
        response = await createMessage(apiKey, tools && !log.webSearchFallback ? { ...params, tools } : params);
      } catch (err) {
        // A model/tool-version mismatch must not take the mentor down: retry without web search
        if (!(tools && !log.webSearchFallback && err instanceof Anthropic.BadRequestError)) throw err;
        log.webSearchFallback = true;
        response = await createMessage(apiKey, params);
      }
      rawText = responseText(response);
      try {
        parsed = parseJsonObject(rawText);
        // A tool tag that was ignored counts as a failed attempt too
        if (tool && parsed.assetType !== tool && attempt < PARSE_ATTEMPTS) throw new Error(`Expected assetType ${tool}, got ${parsed.assetType}`);
        break;
      } catch (err) {
        if (attempt >= PARSE_ATTEMPTS) throw err;
        log.parseRetries = attempt;
        console.warn('[mentor.analyze] unparsable reply, retrying', attempt, err?.message || err);
      }
    }
    const { assessment = null, ...result } = parsed;

    if (forced && !result.shouldIntervene) {
      result.shouldIntervene = true;
      result.aiMessage ||= language === 'en' ? 'How can I help your design discussion?' : '需要我協助你們的設計討論嗎？';
    }
    // Disabled modules never produce assets, whatever the model returned
    if (result.assetType && !allowed[result.assetType]) {
      result.assetType = null;
      result.assetData = null;
    }

    if (visible && result.shouldIntervene && result.assetType === 'moodboard' && Array.isArray(result.assetData?.images)) {
      const urls = await generateImages(result.assetData.images.map(i => i.prompt || i.title || 'design concept'), {
        falKey,
        model: sys.imageModel,
        folder: `moodboard/${roomId}`
      });
      result.assetData.images = result.assetData.images.map((img, i) => ({ ...img, url: urls[i], isAiGenerated: true }));
    }

    // Idea sketches: shown with the same collage as moodboards (assetData.images), the first one large
    // Sketches based on an image of the conversation: Claude reads the image with the discussion, fal redraws it
    const sourceImage = result.assetType === 'sketch' && result.assetData?.fromImage ? messages.find(m => m.id === result.assetData.fromImage)?.imageUrl : null;
    if (visible && result.shouldIntervene && sourceImage) {
      const mode = result.assetData.mode === 'refine' ? 'refine' : 'variations';
      const brief = await sketchBrief({ apiKey, roomId, roomAi: { profile, memory }, image: sourceImage, notes: String(result.assetData.description || '').slice(0, 300), kind: mode === 'refine' ? 'refineSketch' : 'variations' });
      const items = brief?.items?.length ? brief.items : (result.assetData.sketches || []).map(s => ({ title: s.title || '', prompt: s.prompt || s.title || 'product idea' }));
      const urls = items.length ? await sketchesFromImage(sourceImage, items.slice(0, 4), mode, { falKey, model: sys.sketchRefineModel, folder: `sketch/${roomId}` }) : [];
      result.assetData.images = items.slice(0, 4).map((s, i) => ({ title: s.title || '', prompt: s.prompt || '', url: urls[i], size: i === 0 ? 'large' : 'medium', isAiGenerated: true }));
      result.assetData.model = sys.sketchRefineModel;
      result.assetData.sourceMessageId = result.assetData.fromImage;
    } else if (visible && result.shouldIntervene && result.assetType === 'sketch' && Array.isArray(result.assetData?.sketches)) {
      const sketches = result.assetData.sketches.slice(0, 4);
      const urls = await generateSketches(sketches.map(s => s.prompt || s.title || 'product idea'), { falKey, model: sys.sketchModel, folder: `sketch/${roomId}` });
      result.assetData.images = sketches.map((s, i) => ({ title: s.title || '', prompt: s.prompt || '', url: urls[i], size: i === 0 ? 'large' : 'medium', isAiGenerated: true }));
      result.assetData.model = sys.sketchModel;
    }

    const meta = { model, promptVersion: PROMPT_VERSION, usage: usageOf(response), profileId: profile.id || null, profileVersion: profile.version ?? null };
    await logAiCall({
      ...log,
      output: { rawText, assessment, shouldIntervene: Boolean(result.shouldIntervene), assetType: result.assetType || null, result },
      webSearches: countWebSearches(response),
      usage: meta.usage,
      latencyMs: Date.now() - startedAt
    });
    return { result, assessment, meta };
  } catch (err) {
    const category = classifyError(err);
    console.error('[mentor.analyze]', category, err?.message || err);
    await logAiCall({ ...log, error: { category, message: String(err?.message || err).slice(0, 500) }, latencyMs: Date.now() - startedAt });
    return { error: { category, message: FRIENDLY_ERRORS[category] } };
  }
}

// Images the mentor looks at itself: a mention sees up to 3 from the last 30 messages, an automatic check up to 2 from the last 8
function recentImageBlocks(messages, forced) {
  const pool = messages.slice(forced ? -30 : -8).filter(m => m.imageUrl).slice(forced ? -3 : -2);
  const blocks = [];
  for (const m of pool) {
    try {
      const block = imageBlock(m.imageUrl);
      blocks.push({ type: 'text', text: `[image id=${m.id}] shared by ${m.senderName}:` }, block);
    } catch {
      // An unsupported image is simply left out
    }
  }
  return blocks.length ? [{ type: 'text', text: 'Images shared recently in the conversation (oldest first):' }, ...blocks] : [];
}

/** Incremental long-term memory update; returns the new memory or null on failure. */
export async function updateMemory({ apiKey, roomId, previous, messages, participants, profile }) {
  const sys = await getSystemConfig();
  const model = sys.memoryModel;
  const startedAt = Date.now();
  const userPrompt = `Previous memory (JSON):\n${JSON.stringify(previous || {})}\n\nParticipant ids: ${
    Object.entries(participants || {}).map(([uid, p]) => `${uid}=${p.displayName}`).join(', ')
  }\n\nNew messages:\n${buildTranscript(messages, participants)}`;
  try {
    const response = await createMessage(apiKey, {
      model,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: memoryPrompt(profile?.prompts),
      messages: [{ role: 'user', content: userPrompt }]
    });
    const next = parseJsonObject(responseText(response));
    const memory = {
      summary: next.summary || '',
      decisions: next.decisions || [],
      openQuestions: next.openQuestions || [],
      participants: next.participants || {},
      aiHistory: previous?.aiHistory || [],
      version: (previous?.version || 0) + 1,
      updatedAt: Date.now()
    };
    await logAiCall({ kind: 'memory_update', roomId, model, promptVersion: PROMPT_VERSION, input: { previous, userPrompt }, output: { memory }, usage: usageOf(response), latencyMs: Date.now() - startedAt });
    return memory;
  } catch (err) {
    console.error('[mentor.updateMemory]', err?.message || err);
    await logAiCall({ kind: 'memory_update', roomId, model, error: { message: String(err?.message || err).slice(0, 500) } });
    return null;
  }
}
