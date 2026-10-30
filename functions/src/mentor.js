import { getSystemConfig } from './config.js';
import { Anthropic, classifyError, createMessage, parseJsonObject, responseText } from './claude.js';
import { PROMPT_VERSION, buildTranscript, memoryPrompt, mentorSystemPrompt } from './prompts.js';
import { generateImages } from './images.js';
import { countWebSearches, logAiCall } from './log.js';

export const FRIENDLY_ERRORS = {
  KEY_INVALID: 'The AI service key is not configured correctly. Please contact the study administrator.',
  QUOTA_EXCEEDED: 'The AI service is rate-limited right now. Please retry in a moment.',
  HIGH_DEMAND: 'The AI service is overloaded right now (high demand). Please retry.',
  NETWORK: 'Could not reach the AI service. Please retry.',
  BAD_REQUEST: 'The AI request was rejected. Please retry or rephrase.',
  PARSE_ERROR: 'The AI returned an unexpected format. Please retry.',
  UNKNOWN: 'The AI request failed. Please retry.'
};

const usageOf = response => (response?.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null);

/**
 * One mentor analysis: builds the prompt from the frozen profile, long-term memory and recent
 * transcript, calls Claude, generates moodboard images if needed, and writes the research log.
 * Never throws; on failure returns { error }.
 */
export async function analyze({ apiKey, falKey, roomId, room, messages, participants, profile, memory, forced, reason, callerUid, visible, note = '', rosterNote = '' }) {
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
    session: room.session
  });
  // `note` replaces the generic trigger line for system-initiated responses (e.g. a settled poll)
  const userPrompt = `Conversation transcript:\n${buildTranscript(messages, participants)}\n\n${rosterNote ? `${rosterNote}\n` : ''}${
    note || (forced ? 'You were explicitly asked by a participant (forced).' : `Automatic check (reason: ${reason}).`)
  }\nRespond with the JSON object only.`;

  const params = {
    model,
    max_tokens: 8000,
    output_config: { effort: sys.mentorEffort },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  const tools = modules.enableFactRetrieval ? [{ type: sys.webSearchTool, name: 'web_search', max_uses: sys.webSearchMaxUses }] : null;

  // Everything the model saw and decided, including non-interventions (research plan §5)
  const log = {
    kind: 'mentor',
    roomId,
    callerUid: callerUid || null,
    trigger: forced && reason !== 'poll_settled' ? 'forced' : reason,
    visible, // false = shadow assessment (no-AI / reactive conditions, or cooldown)
    triggerMessageId: messages.at(-1)?.id || null,
    profileId: profile.id || null,
    profileVersion: profile.version ?? null,
    mode: profile.mode,
    model,
    promptVersion: PROMPT_VERSION,
    language,
    input: { systemPrompt, userPrompt, messageCount: messages.length },
    webSearchOffered: Boolean(tools),
    webSearchFallback: false
  };

  try {
    let response;
    try {
      response = await createMessage(apiKey, tools ? { ...params, tools } : params);
    } catch (err) {
      // A model/tool-version mismatch must not take the mentor down: retry without web search
      if (!(tools && err instanceof Anthropic.BadRequestError)) throw err;
      log.webSearchFallback = true;
      response = await createMessage(apiKey, params);
    }
    const rawText = responseText(response);
    const { assessment = null, ...result } = parseJsonObject(rawText);

    if (forced && !result.shouldIntervene) {
      result.shouldIntervene = true;
      result.aiMessage ||= language === 'en' ? 'How can I help your design discussion?' : '需要我協助你們的設計討論嗎？';
    }
    // Disabled modules never produce assets, whatever the model returned
    const allowed = { parametric_3d: modules.enable3D, moodboard: modules.enableMoodboard, fact_check: modules.enableFactRetrieval, summary: modules.enableSummary !== false };
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
