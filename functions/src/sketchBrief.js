import { getSystemConfig } from './config.js';
import { createMessage, imageBlockFromDataUrl, parseJsonObject, responseText } from './claude.js';
import { SKETCH_BRIEF_PROMPT, buildTranscript, languageName } from './prompts.js';
import { fetchContext } from './engine.js';
import { localized } from './i18n.js';
import { logAiCall } from './log.js';

const TASKS = {
  variations: 'Write 3 items: (1) the same idea, more resolved; (2) a bolder variation of its form and proportions; (3) a different mechanism, joint or way of use. All three stay the same kind of product for the same users and needs.',
  refine: 'Write 2 items describing the same object faithfully: (1) for a clean presentation sketch; (2) for a realistic render (also name plausible materials and finishes).',
  refineSketch: 'Write 3 items describing the same design faithfully, cleaned up and resolved, each from a different view (three-quarter, front, side). Keep its form, parts and proportions.'
};

export const imageBlock = image => (image.startsWith('data:') ? imageBlockFromDataUrl(image) : { type: 'image', source: { type: 'url', url: image } });

/**
 * Before fal draws anything, Claude looks at the shared image together with the conversation and writes
 * prompts that keep the sketches on the team's topic. Returns { subject, items: [{ title, prompt }] }
 * or null (the caller then falls back to generic prompts).
 */
export async function sketchBrief({ apiKey, roomId, roomAi, image, notes = '', kind }) {
  const sys = await getSystemConfig();
  const model = sys.models.svg;
  const startedAt = Date.now();
  try {
    const { room, messages, participants } = await fetchContext(roomId);
    const language = room.language || 'zh-TW';
    const profile = roomAi?.profile || {};
    const context = [
      `Design task: ${localized(profile.session?.taskDescription, language) || 'not fixed; see the conversation'}`,
      room.roomName ? `Room name: ${room.roomName}` : '',
      room.progress?.stage ? `Double Diamond stage: ${room.progress.stage}` : '',
      roomAi?.memory?.summary ? `Summary of the session so far: ${roomAi.memory.summary}` : '',
      notes ? `Note added to the image: ${notes}` : '',
      `Recent conversation:\n${buildTranscript(messages.slice(-30), participants) || '(none)'}`
    ].filter(Boolean).join('\n\n');
    const response = await createMessage(apiKey, {
      model,
      max_tokens: 2000,
      output_config: { effort: 'medium' },
      system: SKETCH_BRIEF_PROMPT.replace('{{lang}}', languageName(language)),
      messages: [{ role: 'user', content: [imageBlock(image), { type: 'text', text: `${context}\n\nTask: ${TASKS[kind]}` }] }]
    });
    const out = parseJsonObject(responseText(response));
    const items = (Array.isArray(out.items) ? out.items : [])
      .map(i => ({ title: String(i?.title || '').slice(0, 40), prompt: String(i?.prompt || '').slice(0, 1200) }))
      .filter(i => i.prompt);
    const brief = items.length ? { subject: String(out.subject || '').slice(0, 400), items } : null;
    await logAiCall({ kind: 'sketch_brief', roomId, model, input: { kind, notes, context }, output: { brief }, latencyMs: Date.now() - startedAt });
    return brief;
  } catch (err) {
    await logAiCall({ kind: 'sketch_brief', roomId, model, input: { kind, notes }, error: { message: String(err?.message || err).slice(0, 500) } });
    return null;
  }
}
