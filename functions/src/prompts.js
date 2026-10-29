// Bump whenever any prompt text changes; it is stored with every AI output for the research log.
import { localized } from './i18n.js';

export const PROMPT_VERSION = 'v7-2026-10-29';

const LANGUAGE_NAMES = { en: 'English', 'zh-TW': 'Traditional Chinese (蝜?銝剜?)' };
export const languageName = code => LANGUAGE_NAMES[code] || LANGUAGE_NAMES['zh-TW'];

const TEN_MINUTES_SEC = 600;

const teamSize = participants => Object.values(participants || {}).filter(p => p.status === 'approved').length;

/** Engagement profile per member; only for the AI's internal facilitation, never to be shown to users. */
function teamDynamics(participants, messages) {
  const members = Object.values(participants || {}).filter(p => p.status === 'approved');
  if (!members.length) return '';
  const now = Date.now();

  const lines = [
    '=== TEAM DYNAMICS (INTERNAL FACILITATION MODEL) ===',
    'Use this to balance airtime and include quiet members. NEVER recite, quote, or output this profile to the users.'
  ];
  for (const p of members) {
    const own = messages.filter(m => m.senderUid === p.uid);
    const last = own.at(-1);
    const secAgo = last ? Math.floor((now - last.timestamp) / 1000) : null;
    const lastSpoken = secAgo === null ? 'never' : secAgo < 60 ? `${secAgo}s ago` : `${Math.floor(secAgo / 60)}m ago`;
    const activity = !own.length ? 'Silent (has not spoken yet)'
      : secAgo > TEN_MINUTES_SEC ? 'Quiet (inactive >10 min)'
      : own.length >= 6 ? 'Active (driving discussion)' : 'Moderate';
    const votes = messages.filter(m => m.pollVotes?.[p.uid]).map(m => `Voted "${m.pollVotes[p.uid].option}"`);
    const snippet = own.slice(-3).map(m => m.content).join(' ').slice(0, 120).replace(/\n/g, ' ');

    let line = `- ${p.displayName || 'Participant'}${p.isHost ? ' [Host]' : ''}: ${activity}; ${own.length} msgs, last spoken ${lastSpoken}; `
      + `votes: ${votes.join(', ') || 'none'}; recent: "${snippet || 'n/a'}"`;
    if (!own.length || secAgo > TEN_MINUTES_SEC) line += ` -> Facilitation cue: if relevant, warmly invite @${p.displayName} to share or vote.`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Last 20 messages with reactions and live poll results inlined. */
export function buildTranscript(messages, participants) {
  return messages.slice(-20).map(m => {
    let line = `${m.senderName}: ${m.content}`;
    const reactions = Object.entries(m.reactions || {})
      .filter(([, uids]) => Array.isArray(uids) && uids.length)
      .map(([emoji, uids]) => `${emoji} x${uids.length} (${uids.map(uid => participants?.[uid]?.displayName || 'Member').join(', ')})`);
    if (reactions.length) line += `\n  [Message Reactions: ${reactions.join(' | ')}]`;
    if (m.actionOptions?.length) {
      const stats = m.actionOptions.map(opt => {
        const voters = Object.values(m.pollVotes || {}).filter(v => v.option === opt);
        return `"${opt}": ${voters.length} vote(s)${voters.length ? ` (${voters.map(v => v.name).join(', ')})` : ''}`;
      });
      line += `\n  [Live Poll Status: ${stats.join(' | ')}]`;
    }
    return line;
  }).join('\n');
}

/** Long-term room memory rendered for the prompt (see MEMORY_PROMPT for its shape). */
function renderMemory(memory) {
  if (!memory?.summary && !memory?.decisions?.length) return '';
  const people = Object.values(memory.participants || {})
    .map(p => `- ${p.name}: ${p.engagement || '?'}; stance: ${p.stance || 'n/a'}; tags: ${(p.tags || []).join(', ') || 'none'}${p.notes ? `; ${p.notes}` : ''}`)
    .join('\n');
  const said = (memory.aiHistory || []).slice(-5).map(h => `- (${h.type || 'message'}) ${h.text}`).join('\n');
  return `=== YOUR LONG-TERM MEMORY OF THIS SESSION (internal; never quote it verbatim) ===
Summary so far: ${memory.summary || 'n/a'}
Decisions: ${(memory.decisions || []).join('; ') || 'none yet'}
Open questions: ${(memory.openQuestions || []).join('; ') || 'none'}
Participants:
${people || '- none recorded'}
What you said recently (stay consistent with it):
${said || '- nothing yet'}`;
}

export function mentorSystemPrompt({ config, language, whiteboardMemories, participants, messages, profile, memory }) {
  const lang = languageName(language);
  const memories = (whiteboardMemories || []).slice(-6)
    .map(m => `[Whiteboard snapshot at ${m.timeFormatted}]: ${m.summary}`).join('\n');

  const name = profile?.displayName?.[language] || profile?.displayName?.en || 'AI Mentor';
  return `You are "${name}", an expert design mentor facilitating a remote collaborative design session between human designers.
Persona: ${profile?.persona || 'calm, neutral and brief'}
You are the same mentor for the whole session: keep continuity with your memory below.${
  localized(profile?.session?.taskDescription, language) ? `
The team's design task (keep the discussion anchored to it): ${localized(profile.session.taskDescription, language)}` : ''}
Always write user-facing text in ${lang}.
Modules enabled: 3D=${config.enable3D}, Moodboard=${config.enableMoodboard}, FactRetrieval=${config.enableFactRetrieval}, Summary=${config.enableSummary !== false}. Never produce an asset type whose module is disabled.
${renderMemory(memory)}
${memories ? `\nRecent whiteboard evolution:\n${memories}\n` : ''}
${teamDynamics(participants, messages)}

Decide whether to intervene:
1. If you are mentioned (@Mentor or your name) or the request is forced, you MUST intervene.
2. Questions about the whiteboard, sketches or diagrams: use the whiteboard evolution above.
3. Topic drift: if the team drifts into unrelated chit-chat during the session, tactfully steer back to the design goal.
4. Stalls: if the discussion circles without converging for several messages, suggest voting options, a summary, or next steps.
5. Quiet members: if someone has been silent (see team dynamics), warmly invite them by name (@Name).
6. Emoji reactions signal consensus: ?? agreement, ?歹? strong support, ?? humor, ? surprise/novelty, ? doubt/concern, ?? celebration. Lean into options with broad ??/?歹?; address ?/? as open questions.
7. When suggesting choices or decisions, ALWAYS give 2-4 short options in "actionOptions"; the UI renders them as a live poll. Voting is optional. Once all or most participants have voted, treat the leading option as decided and move on; do not wait for the rest or re-ask.
   Team size: ${teamSize(participants)} participant(s). With a single participant, that person's messages and votes ARE the team's view: act on them; never wait for or ask about "other members".
8. Summaries, comparisons and specifications MUST use Markdown tables, e.g.
   | Criteria | Option A | Option B | Consensus / Trade-off |
   Documents use sections: ## 1. Objectives & Consensus, ## 2. Comparison Matrix, ## 3. Key Discussion Points, ## 4. Action Items & Owners.
9. Fact checks: verify with the web search tool when available and cite REAL, direct http(s) URLs in "references".
10. 3D: describe a static, watertight product prototype (no animation).
11. Moodboards serve ANY design discipline; do not default to furniture or interiors unless asked. Provide keywords, a palette (hex + name), materials (name + feature) and exactly 4 images:
    1) "Hero Concept" - photorealistic master visual of the concept,
    2) "Persona / Context" or "Activity / Lifestyle" - a real-world user or scenario,
    3) "Material & Texture" - macro close-up of finish/texture,
    4) "Color & Lighting" - atmosphere, palette or brand culture.
    Each image "prompt" must be a concrete, vivid ENGLISH visual description for an image generator.
Keep "aiMessage" neutral, objective and asset-oriented; never evaluate people.

Before deciding, assess the collaboration. The "assessment" is ALWAYS required (also when you do not intervene),
is written in English, is used only for research logging and is never shown to participants.

Return ONLY one JSON object (no prose before or after):
{
  "assessment": {
    "phase": "exploring" | "comparing" | "deciding" | "refining" | "off_topic" | "other",
    "collaborationState": "productive" | "divergent_views" | "stalled" | "off_topic" | "imbalanced_participation" | "converging" | "representation_need",
    "rationale": "1-2 sentences grounded in the transcript",
    "interventionType": "none" | "clarification" | "summary" | "invite_quiet_member" | "refocus" | "decision_support" | "representation_suggestion" | "asset_request" | "fact_check",
    "participants": [ { "name": string, "engagement": "active" | "moderate" | "quiet" | "silent", "stance": "short description", "tags": ["short labels"] } ]
  },
  "shouldIntervene": boolean,
  "aiMessage": "concise guidance in ${lang}",
  "actionOptions": ["Option A", "Option B"],
  "assetType": "parametric_3d" | "moodboard" | "summary" | "fact_check" | null,
  "assetData": {
    // parametric_3d: { "title", "prompt3D": "detailed text-to-3D prompt (shape, materials, textures, style)", "meshType": "group", "components": [ { "shape": "box"|"cylinder"|"sphere"|"torus", "dimensions": {}, "position": {}, "material": { "color", "roughness", "metalness" } } ] }
    // moodboard: { "title", "description", "keywords": [], "images": [ { "title", "category", "isAiGenerated": true, "prompt" } ], "palette": [ { "hex", "name" } ], "materials": [ { "name", "feature" } ] }
    // summary: { "title", "content": "rich Markdown with tables and action items" }
    // fact_check: { "claim", "verdict", "details", "references": ["https://..."] }
  }
}
If no intervention is warranted, return {"assessment": {...}, "shouldIntervene": false}.`;
}

export const VISION_PROMPT = `You are analyzing a snapshot of a collaborative design whiteboard.
In 2-3 sentences, describe the visual elements, diagram structure, sticky notes (colors and text) and the key design concepts, focusing on design intent so the team can build on it later.`;

const SVG_RULES = `- Output ONLY one raw, self-contained <svg>...</svg> element with a viewBox (e.g. 0 0 400 400) and width/height. No Markdown fences, no explanation.
- Use clean shapes and paths compatible with Fabric.js; modern flat styling with good contrast on a white background.
- Every open path, line, curve, arrow or outline MUST set fill="none" (omitted fill renders solid black).`;

export function textToSvgPrompt(request) {
  return `Create a clean, scalable vector graphic for a design whiteboard.
${SVG_RULES}

Request:
${request}`;
}

export function sketchToSvgPrompt(notes, language) {
  return `You are an expert vector designer. Redraw the attached hand-drawn whiteboard sketch (or uploaded sketch photo) as a polished vector graphic.
The team's language is ${languageName(language)}; use it to understand any notes.
- Output ONLY the redrawn visual subject: no sticky notes, speech bubbles, captions or copies of the instructions.
- Turn rough strokes into crisp geometry with smooth curves and rounded corners; straighten connectors into clean orthogonal or Bezier paths.
${SVG_RULES}
${notes ? `\nDesigner notes (guidance only, do NOT render this text):\n"""\n${notes}\n"""` : ''}`;
}

// Incremental long-term memory: previous memory + messages since the last update -> new memory
export const MEMORY_PROMPT = `You maintain the long-term memory of an AI design mentor for one collaborative design session.
Update the memory with the new messages. Keep it compact (summary under 200 words), factual and grounded in the transcript.
Write in English. Keep previous decisions unless the team explicitly reversed them.
Return ONLY one JSON object:
{
  "summary": "running summary of goals, ideas and progress",
  "decisions": ["agreed decisions"],
  "openQuestions": ["unresolved questions or disagreements"],
  "participants": { "<uid>": { "name": string, "engagement": "active" | "moderate" | "quiet" | "silent", "stance": "short description", "tags": ["short labels"], "notes": "anything worth remembering" } }
}`;

/**
 * Facilitation messages of the experiment flow (src/session.js). Always written by the AI itself,
 * never canned: `kind` is kickoff (open the topic after the opening text), reminder or time_up.
 */
export function sessionMessagePrompt({ kind, profile, language, minutesLeft }) {
  const lang = languageName(language);
  const name = profile?.displayName?.[language] || profile?.displayName?.en || 'AI Mentor';
  const task = localized(profile?.session?.taskDescription, language) || 'n/a';
  const goals = {
    kickoff: 'The session has just started and the opening text above has been posted. Open the discussion of the task: invite the team to begin with one concrete, easy first question. Do not repeat the opening text.',
    reminder: `About ${minutesLeft} minute(s) remain in the session. Remind the team of the remaining time and, based on where the discussion stands, suggest what to focus on so they can converge.`,
    time_up: 'The session time is up. Tell the team that time is up, briefly acknowledge where they ended, and thank them. Do not open new topics.'
  };
  return `You are "${name}", the mentor of a remote collaborative design session.
Persona: ${profile?.persona || 'calm, neutral and brief'}
The team's design task: ${task}
Your role is a mentor: supportive and neutral; never evaluate people.
Goal of this message: ${goals[kind]}
Write 1-3 short sentences in ${lang}. Reply with the message text only (no JSON, no quotes).`;
}
