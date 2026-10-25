import { GoogleGenerativeAI } from '@google/generative-ai';
import type { MessageItem, MentorConfig, Participant } from '../types';

export interface AiActionResponse {
  shouldIntervene: boolean;
  aiMessage?: string;
  actionOptions?: string[];
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract' | 'fact_check';
  assetData?: any;
}

export function getStoredGeminiApiKey(): string {
  return (
    localStorage.getItem('ai_gemini_api_key') ||
    (window as any).__SHARED_GEMINI_KEY__ ||
    (window as any).__SHARED_HOST_GEMINI_KEY__ ||
    import.meta.env.VITE_GEMINI_API_KEY ||
    ''
  );
}

export function setStoredGeminiApiKey(key: string) {
  if (key) {
    localStorage.setItem('ai_gemini_api_key', key.trim());
    (window as any).__SHARED_GEMINI_KEY__ = key.trim();
  } else {
    localStorage.removeItem('ai_gemini_api_key');
    delete (window as any).__SHARED_GEMINI_KEY__;
  }
}

export const FLASH_CORE_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
];

export interface WhiteboardMemoryItem {
  timestamp: number;
  timeFormatted: string;
  summary: string;
  assetId?: string;
}

export async function summarizeWhiteboardVisualSnapshot(
  base64DataUrl: string,
  apiKey: string = getStoredGeminiApiKey(),
  abortSignal?: AbortSignal
): Promise<string> {
  if (!apiKey || !base64DataUrl) return '';
  const genAI = new GoogleGenerativeAI(apiKey);

  const matches = base64DataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!matches) return '';
  const mimeType = matches[1];
  const base64Data = matches[2];

  const modelsToTry = [
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite-image'
  ];

  const prompt = `You are an expert design AI analyzing a collaborative whiteboard sketchpad snapshot.
Describe the visual elements, diagram structures, flowcharts, UI wireframes, sticky notes (colors and text), and key design concepts concisely in 2 to 3 sentences. Focus on high-level architecture and design intent so the team can recall and build upon it later.`;

  for (const modelName of modelsToTry) {
    if (abortSignal?.aborted) return '';
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: base64Data,
            mimeType
          }
        }
      ]);
      const text = result.response.text();
      if (text && text.trim()) {
        return text.trim();
      }
    } catch (err: any) {
      console.warn(`[Whiteboard Vision] Model ${modelName} failed:`, err?.message || err);
    }
  }
  return '';
}

function buildParticipantDynamicsContext(
  participants?: Record<string, Participant>,
  messages: MessageItem[] = []
): string {
  if (!participants || Object.keys(participants).length === 0) return '';
  const now = Date.now();
  const participantList = Object.values(participants).filter((p) => p.status === 'approved');
  if (participantList.length === 0) return '';

  const lines: string[] = [];
  lines.push('\n=== TEAM DYNAMICS & PARTICIPANT BACKGROUND PROFILES (INTERNAL FACILITATION MODEL) ===');
  lines.push('*NOTICE FOR AI FACILITATOR: The following section provides an algorithmic background model of participant engagement, airtime balance, and stated preferences in this room. Use this model to adapt your tone, synthesize diverse perspectives, and proactively include quiet members. NEVER recite, quote, or output this diagnostic profiling text directly to the users.*');

  for (const p of participantList) {
    const userMsgs = messages.filter((m) => m.senderUid === p.uid);
    const count = userMsgs.length;
    const lastMsg = count > 0 ? userMsgs[userMsgs.length - 1] : null;
    const secAgo = lastMsg ? Math.floor((now - lastMsg.timestamp) / 1000) : null;
    const timeText = secAgo !== null ? (secAgo < 60 ? `${secAgo}s ago` : `${Math.floor(secAgo / 60)}m ago`) : 'Never spoken';

    let activityStatus = 'Moderate';
    if (count === 0) activityStatus = 'Silent (Has not spoken yet in this session)';
    else if (secAgo !== null && secAgo > 600) activityStatus = 'Quiet (Inactive for >10 mins)';
    else if (count >= 6) activityStatus = 'Active (Driving discussion)';

    // Extract recent poll stances from user
    const pollStances: string[] = [];
    for (const m of messages) {
      if (m.pollVotes && m.pollVotes[p.uid]) {
        pollStances.push(`Voted "${m.pollVotes[p.uid].option}"`);
      }
    }

    const sampleWords = userMsgs
      .slice(-3)
      .map((m) => m.content)
      .join(' ')
      .slice(0, 120)
      .replace(/\n/g, ' ');

    let desc = `- ${p.displayName || 'Participant'} (${p.avatar || '👤'})${p.isHost ? ' [Host]' : ' [Member]'}:
  * Activity: ${activityStatus} (${count} msgs, last spoken: ${timeText})
  * Stance / Poll Votes: ${pollStances.length > 0 ? pollStances.join(', ') : 'No poll votes yet'}
  * Key Concerns/Snippet: "${sampleWords || 'No messages yet'}"`;

    if (count === 0 || (secAgo !== null && secAgo > 600)) {
      desc += `\n  * Facilitation Cue: Silent member. If relevant, warmly mention them by name (@${p.displayName}) to invite their perspective or vote.`;
    }
    lines.push(desc);
  }

  return lines.join('\n');
}

export async function analyzeDialogueWithGemini(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean,
  abortSignal?: AbortSignal,
  whiteboardMemories?: WhiteboardMemoryItem[],
  participants?: Record<string, Participant>
): Promise<AiActionResponse & { degradedFromPro?: boolean }> {
  const apiKey = getStoredGeminiApiKey();

  const langNames: Record<string, string> = {
    en: 'English',
    'zh-TW': 'Traditional Chinese (繁體中文)',
    ja: 'Japanese (日本語)',
    ko: 'Korean (한국어)'
  };
  const targetLang = langNames[config.meetingLanguage || 'zh-TW'] || 'Traditional Chinese';

  if (!apiKey) {
    if (forced) {
      return {
        shouldIntervene: true,
        aiMessage:
          '💡 [AI Mentor]: Please configure a free Google AI Studio Gemini API Key in Host Controls (⚙️) to enable live AI reasoning and parametric synthesis. (Get a key at https://aistudio.google.com/app/apikey).'
      };
    }
    return { shouldIntervene: false };
  }

  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const hasMention = forced || (latestMessage ? latestMessage.content.toLowerCase().includes('@mentor') : false);

  if (config.sensitivity === 'Strict' && !hasMention && !forced) {
    return { shouldIntervene: false };
  }

  const fullText = messages
    .slice(-20) // Keep last 20 messages for richer context
    .map((m) => {
      let line = `${m.senderName}: ${m.content}`;
      if (m.reactions && Object.keys(m.reactions).length > 0) {
        const reactionParts: string[] = [];
        for (const [emoji, uids] of Object.entries(m.reactions)) {
          if (Array.isArray(uids) && uids.length > 0) {
            const names = uids.map(uid => participants?.[uid]?.displayName || 'Member');
            reactionParts.push(`${emoji} x${uids.length} (${names.join(', ')})`);
          }
        }
        if (reactionParts.length > 0) {
          line += `\n  [Message Reactions: ${reactionParts.join(' | ')}]`;
        }
      }
      if (m.actionOptions && m.actionOptions.length > 0) {
        const voteStats = m.actionOptions.map((opt) => {
          const voters = Object.values(m.pollVotes || {}).filter((v) => v.option === opt);
          if (voters.length > 0) {
            return `"${opt}": ${voters.length} vote(s) (${voters.map((v) => `${v.avatar} ${v.name}`).join(', ')})`;
          }
          return `"${opt}": 0 votes`;
        });
        line += `\n  [Live Poll Status: ${voteStats.join(' | ')}]`;
      }
      return line;
    })
    .join('\n');

  let whiteboardContext = '';
  if (whiteboardMemories && whiteboardMemories.length > 0) {
    const memoryLines = whiteboardMemories
      .slice(-6)
      .map((m) => `[Whiteboard Snapshot at ${m.timeFormatted || new Date(m.timestamp).toLocaleTimeString()}]: ${m.summary}`)
      .join('\n');
    whiteboardContext = `\n\nRecent Collaborative Whiteboard Evolution & Visual Milestones:\n${memoryLines}`;
  }

  const dynamicsContext = buildParticipantDynamicsContext(participants, messages);

  const systemInstruction = `You are an expert AI Design Mentor & Product Strategy Facilitator in a collaborative design studio.
Respond in ${targetLang}.
Current Sensitivity: ${config.sensitivity}
Features Enabled: 3D=${config.enable3D}, Moodboard=${config.enableMoodboard}, FactRetrieval=${config.enableFactRetrieval}, ProcessIntervention=${config.enableProcessIntervention}
${whiteboardContext}
${dynamicsContext}

Role & Capabilities:
- Actively mentor and accelerate product, UI/UX, and industrial design collaboration.
- Determine if you should intervene:
  1. If @Mentor is explicitly mentioned or forced, you MUST intervene (shouldIntervene = true).
  2. If the user asks about the whiteboard/sketchpad, drawings, diagrams, or visual concepts, refer to the Whiteboard Evolution & Visual Milestones above.
  3. **Topic Drift & Focus Intervention**: If you observe the team drifting into off-topic chit-chat (e.g. gaming, gossip, unrelated banter) during an active design session, tactfully and constructively intervene with design facilitation advice to guide the team back to their creative design goals.
  4. **Stall & Progress Detection**: If you notice the discussion is circling the same topic without reaching a conclusion for several messages, proactively intervene and suggest actionable voting options, summaries, or next steps to push the team forward.
  5. **Silent Member Inclusion**: If a specific team member has not spoken or contributed in a while (noted in the Team Dynamics profile above), warmly and politely invite them by name (@MemberName) to share their thoughts or vote.
  6. **Message Emoji Reactions & Consensus Understanding**:
     - Participants react to messages using emoji reactions:
       * 👍: Agreement, approval, sign-off, consensus, or acknowledgment.
       * ❤️: Enthusiastic support, favorite concept, deep resonance, or high alignment.
       * 😂: Humor, amusement, witty remark, or lighthearted enjoyment.
       * 😮: Surprise, novelty, curiosity, unexpected breakthrough, or intrigue.
       * 😢: Hesitation, skepticism, doubt, difficulty, or concern.
       * 🎉: Celebration, triumph, milestone completion, or congratulations.
     - Carefully factor these emotional and agreement signals in [Message Reactions] into your assessment of team consensus. If an option or proposal receives widespread 👍 or ❤️, lean into it as the favored direction; if a message sparks 😢 or 😮, acknowledge the potential hesitation or question and help explore solutions.
  7. **Interactive Actions (actionOptions) & Polls**: If you are suggesting options, votes, or decisions, ALWAYS provide 2 to 4 concise, actionable choices in the "actionOptions" array (e.g. ["Vote Option A", "Vote Option B", "Need more time"]). The frontend will render these as interactive poll cards with real-time voter avatars. If poll results are present in the transcript, acknowledge the team's tendency (e.g., "Seeing that the majority voted for...").
  8. **Summary & Document Generation (Visual Tables & Matrices)**:
     - When asked to summarize, evaluate options, compare concepts, or provide specifications, **ALWAYS format them as rich Markdown Tables ('| Header 1 | Header 2 |') or visual matrices**.
     - Do NOT output pure unbroken paragraphs. Users rely on structured visual tables and matrices to make decisions.
     - If discussing a Decision Matrix, Pugh Matrix, or Criteria Evaluation, explicitly construct a Markdown Table with evaluation criteria, options, and verdicts:
       | Criteria / Dimension | Option A | Option B | Consensus / Tradeoff |
       | :--- | :--- | :--- | :--- |
       | Feasibility / Cost | ... | ... | ... |
       | Aesthetic / UX | ... | ... | ... |
     - Document structure should include:
       ## 1. Objectives & Design Consensus
       ## 2. Comparative Matrix & Evaluation Table
       ## 3. Key Discussion Points
       ## 4. Immediate Action Items & Ownership
  9. If asked to fact check or verify a specification/material/dimension, provide verified information with sources/context. IMPORTANT: For the "references" array, you MUST provide REAL, DIRECT web URLs (starting with http:// or https://) that link directly to the standard's official page, a Wikipedia page, or a trusted source.
  10. If asked for 3D model: The 3D engine generates watertight static 3D meshes for industrial/product prototypes. (Output basic static dimensions, do not output any animation fields).
  11. If asked for Moodboard:
     - Moodboards are universal design research and ideation tools for ANY design discipline (digital UI/UX, product design, consumer electronics, lifestyle goods, mobility, branding, fashion, architecture).
     - DO NOT default or bias towards furniture or interior design unless the user specifically and explicitly asked for furniture/interior!
     - Synthesize authentic multidisciplinary research aligned with the team's discussion:
       a) User Personas & Context of Use (real-world scenarios, human interactions, environment)
       b) Lifestyle & Activities (user behavior, daily tasks, lifestyle dynamics)
       c) Lighting & Atmospheric Mood (shadows, illumination, color temperature, tone)
       d) Materials & Surface Textures (tactile finishes, engineered composites, textiles, matte/gloss textures)
       e) Visual Style & Brand Culture (typography, graphics, aesthetic ethos, cultural references)
     - Provide keywords, color palette (hex + name), materials (name + feature), and 4 diverse concept images:
       * Card 1 MUST ALWAYS be the "Hero Concept" (category: "Hero Concept", isAiGenerated: true) — an inspiring master visual concept with a dedicated, photorealistic prompt (e.g. "photorealistic industrial design concept of ..., octane render, 8k, studio lighting, hyper-detailed").
       * Card 2: User Persona / Context of Use or Lifestyle & Activity (authentic real-world user or scenario, e.g. "engineer in field workshop").
       * Card 3: Material, Texture & Finish (macro close-up texture, e.g. "weathered aircraft fuselage metal plates with rivets, industrial macro texture").
       * Card 4: Atmospheric Lighting, Palette or Brand Culture (cinematic volumetric lighting or brand aesthetic).
     - Image prompts MUST be concrete, vivid English visual descriptions specifically matching the category and title.
     - Each image must include:
       { "title": string, "category": "Hero Concept" | "Persona / Context" | "Activity / Lifestyle" | "Material & Texture" | "Color & Lighting", "isAiGenerated": boolean, "prompt": string, "sourceUrl": string, "url": "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=600&height=450&nologo=true" }

Return ONLY a valid JSON object matching this schema:
{
  "shouldIntervene": true,
  "aiMessage": "A concise, inspiring explanation of your guidance or asset in ${targetLang}",
  "actionOptions": ["Option A", "Option B"], // Optional array of short strings for interactive voting/choices buttons
  "assetType": "parametric_3d" | "moodboard" | "summary" | "fact_check" | null,
  "assetData": {
    // For parametric_3d: { "title": string, "prompt3D": "Highly detailed text-to-3D prompt describing the physical product, shape, materials, textures, style, and lighting for Meshy/Tripo engines", "meshType": "group", "components": [ { "shape": "box"|"cylinder"|"sphere"|"torus", "dimensions": object, "position": object, "material": { "color": string, "roughness": number, "metalness": number } } ] }
    // For moodboard: { "title": string, "description": string, "keywords": string[], "images": [ { "title": string, "category": string, "isAiGenerated": boolean, "prompt": string, "sourceUrl": string, "url": string } ], "palette": [ { "hex": string, "name": string } ], "materials": [ { "name": string, "feature": string } ] }
    // For summary: { "title": string, "content": string (Rich Markdown with ## Sections, Markdown Tables | Col 1 | Col 2 |, and bulleted Action Items) }
    // For fact_check: { "claim": string, "verdict": string, "details": string, "references": string[] }
  }
}

If no intervention is warranted, return:
{ "shouldIntervene": false }`;

  const prompt = `System Instruction:\n${systemInstruction}\n\nConversation Transcript:\n${fullText}\n\nProvide the JSON response:`;

  if (abortSignal?.aborted) {
    throw new Error('AI analysis aborted by user');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const isPro = config.modelTier === 'pro';

  // 2026/09 verified available list: Flash models are standard free tier. Pro models fail with 429 limit:0 in free tier.
  const modelsToTry = isPro
    ? ['gemini-3.1-pro-preview', ...FLASH_CORE_MODELS]
    : FLASH_CORE_MODELS;

  let lastError = '';
  let accumulatedErrors = [];
  let degradedFromPro = false;

  for (const modelName of modelsToTry) {
    if (abortSignal?.aborted) {
      throw new Error('AI analysis aborted by user');
    }

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });
      const result = await model.generateContent(prompt);

      if (abortSignal?.aborted) {
        throw new Error('AI analysis aborted by user');
      }

      let text = result.response.text();
      const match = text.match(/\{[\s\S]*\}/);
      const cleanText = match ? match[0] : text;
      const parsed = JSON.parse(cleanText) as AiActionResponse;

      if (isPro && !modelName.includes('pro')) {
        degradedFromPro = true;
      }

      if (forced && !parsed.shouldIntervene) {
        parsed.shouldIntervene = true;
        if (!parsed.aiMessage) {
          parsed.aiMessage = 'Hello! I am your AI Design Mentor. How can I assist your design discussion?';
        }
      }

      return {
        ...parsed,
        degradedFromPro
      };
    } catch (err: any) {
      if (err?.message?.includes('aborted')) throw err;
      lastError = err?.message || String(err);
      accumulatedErrors.push(`${modelName}: ${lastError.substring(0, 80)}...`);
      console.warn(`[AI] ${modelName} call failed:`, lastError);
    }
  }

  if (forced) {
    let friendlyReason = lastError;
    if (lastError.includes('404') || lastError.includes('not supported') || lastError.includes('API_KEY_INVALID') || lastError.includes('is not found for API version')) {
      friendlyReason =
        'The configured Google Gemini API Key is invalid or does not have Generative Language API access. Please obtain a free Gemini API key from Google AI Studio (https://aistudio.google.com/app/apikey) and configure it in Host Controls (⚙️).';
    } else if (lastError.includes('429') || lastError.includes('Quota exceeded') || lastError.includes('credits are depleted') || lastError.includes('RESOURCE_EXHAUSTED')) {
      friendlyReason =
        'Gemini API request limit reached or experiencing high traffic. Please click Retry below to reconnect with Gemini Flash.';
    } else if (lastError.includes('503') || lastError.includes('high demand') || lastError.includes('Service Unavailable')) {
      friendlyReason =
        'Gemini servers are currently experiencing high demand. Please click Retry below to try again.';
    }
    return {
      shouldIntervene: true,
      aiMessage: `⚠️ AI Mentor (${isPro ? 'Pro' : 'Flash'}): ${friendlyReason}`
    };
  }

  return { shouldIntervene: false };
}

export interface SvgGenerationError {
  isAiError: true;
  category: 'KEY_INVALID' | 'HIGH_DEMAND' | 'QUOTA_EXCEEDED' | 'PARSE_ERROR' | 'NETWORK' | 'UNKNOWN';
  title: string;
  suggestion: string;
  attempts: Array<{ model: string; error: string }>;
  rawMessage: string;
}

export async function generateSvgForWhiteboard(
  prompt: string,
  config: MentorConfig,
  abortSignal?: AbortSignal
): Promise<string> {
  const apiKey = getStoredGeminiApiKey();
  if (!apiKey) {
    const err: SvgGenerationError = {
      isAiError: true,
      category: 'KEY_INVALID',
      title: 'Missing API Key',
      suggestion: 'Please configure your Google Gemini API Key in Host Controls (⚙️).',
      attempts: [],
      rawMessage: 'API Key missing in local configuration.'
    };
    throw err;
  }

  const systemInstruction = `You are an expert vector graphics AI assistant. 
Your task is to generate a clean, scalable SVG based on the user's request.
Requirements:
1. ONLY return the raw, unescaped, valid SVG string.
2. DO NOT include markdown formatting, backticks (\`\`\`xml or \`\`\`svg), or any explanatory text.
3. Use a standard viewBox (e.g. 0 0 400 400).
4. Use clear, simple shapes and paths compatible with web and Fabric.js.
5. Apply professional, modern, flat-design styling.

User Request:
${prompt}`;

  if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelsToTry = FLASH_CORE_MODELS;

  const attempts: Array<{ model: string; error: string }> = [];

  for (const modelName of modelsToTry) {
    if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(systemInstruction);

      if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');

      let text = result.response.text();
      text = text.replace(/```xml/gi, '').replace(/```svg/gi, '').replace(/```/g, '').trim();
      
      const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
      if (!svgMatch) {
        throw new Error('AI responded, but output did not contain a valid <svg> element.');
      }
      return svgMatch[0];
    } catch (err: any) {
      if (err?.message?.includes('aborted')) throw err;
      const errMsg = err?.message || String(err);
      attempts.push({ model: modelName, error: errMsg });
      console.warn(`[Gemini SVG] Model ${modelName} failed:`, errMsg);
    }
  }

  const allErrorsText = attempts.map(a => `${a.model}: ${a.error}`).join(' | ');
  let category: SvgGenerationError['category'] = 'UNKNOWN';
  let title = 'AI Vector Generation Failed';
  let suggestion = 'All fallback models failed to generate vector graphics. Please try again.';

  if (allErrorsText.includes('API_KEY_INVALID') || allErrorsText.includes('API key not valid') || allErrorsText.includes('does not have Generative Language API access')) {
    category = 'KEY_INVALID';
    title = 'Invalid Gemini API Key';
    suggestion = 'Please verify your Gemini API Key in Host Controls (⚙️). Ensure it has Generative Language access.';
  } else if (allErrorsText.includes('429') || allErrorsText.includes('Quota exceeded') || allErrorsText.includes('RESOURCE_EXHAUSTED')) {
    category = 'QUOTA_EXCEEDED';
    title = 'API Quota Exceeded';
    suggestion = 'Your Gemini API key has reached its request or token quota. Please wait a moment or update your key.';
  } else if (allErrorsText.includes('503') || allErrorsText.includes('high demand') || allErrorsText.includes('Service Unavailable')) {
    category = 'HIGH_DEMAND';
    title = 'Server Experiencing High Demand';
    suggestion = 'Google Gemini servers are currently under temporary load spikes. Please click Retry in a few seconds.';
  } else if (allErrorsText.includes('valid <svg> element')) {
    category = 'PARSE_ERROR';
    title = 'SVG Format Error';
    suggestion = 'The model returned text that could not be parsed as SVG. Try a more specific prompt (e.g., "flat blue star icon").';
  } else if (allErrorsText.includes('Failed to fetch') || allErrorsText.includes('NetworkError')) {
    category = 'NETWORK';
    title = 'Network Connection Error';
    suggestion = 'Unable to reach Google Gemini API servers. Please check your internet connection.';
  }

  const structuredError: SvgGenerationError = {
    isAiError: true,
    category,
    title,
    suggestion,
    attempts,
    rawMessage: allErrorsText
  };

  throw structuredError;
}

export async function redrawSketchToSvg(
  base64DataUrl: string,
  extraContextText: string = '',
  meetingLanguage: string = 'zh-TW',
  modelTier: 'flash' | 'pro' = 'flash',
  abortSignal?: AbortSignal
): Promise<string> {
  const apiKey = getStoredGeminiApiKey();
  if (!apiKey) {
    const err: SvgGenerationError = {
      isAiError: true,
      category: 'KEY_INVALID',
      title: 'Missing API Key',
      suggestion: 'Please configure your Google Gemini API Key in Host Controls (⚙️).',
      attempts: [],
      rawMessage: 'API Key missing in local configuration.'
    };
    throw err;
  }

  const matches = base64DataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid image data for sketch redraw.');
  }
  const mimeType = matches[1];
  const base64Data = matches[2];

  const langNames: Record<string, string> = {
    en: 'English',
    'zh-TW': 'Traditional Chinese (繁體中文)',
    ja: 'Japanese (日本語)',
    ko: 'Korean (한국어)'
  };
  const targetLang = langNames[meetingLanguage || 'zh-TW'] || 'Traditional Chinese';

  const systemInstruction = `You are an elite vector graphic designer and digital whiteboard architect.
Analyze the provided user whiteboard sketch image and the accompanying user design notes or instructions.
The user and team's active workspace language is: ${targetLang}. Use this to understand the linguistic meaning and intent of any instructions or sketch context.

CRITICAL INSTRUCTIONS & CORE REQUIREMENTS:
1. PURE GRAPHIC ONLY (NO STICKY NOTES, NO EXPLANATORY TEXT):
   - The user provided text explanations and/or sticky notes explaining what they want drawn.
   - You must output ONLY the redrawn visual graphic, artwork, icon, or diagram itself.
   - DO NOT render, reproduce, or draw any sticky notes, post-it note squares, note cards, speech bubbles, or explanatory text in the output SVG!
   - DO NOT copy or include the user's instructions or descriptive text into the output SVG graphic!
   - The final SVG must strictly contain ONLY the clean, polished visual subject/illustration.

2. Intent & Geometry:
   - Recognize rough hand-drawn strokes and shapes (boxes, circles, curves, silhouettes, icons, characters, components) and transform them into crisp, beautiful vector paths and primitives with smooth geometry and elegant corner radii (e.g. rx="8" ry="8").
   - Align hand-drawn arrows or connectors into clean orthogonal or flowing Bezier paths with balanced proportions.
   - Optimize lines, symmetry, visual weights, and padding to produce a world-class vector asset.

3. Visual Styling & Color:
   - Use a modern, aesthetic color palette with cohesive fills, distinct stroke colors, and appropriate stroke widths.
   - Ensure the vector artwork looks stunning and has high contrast against light/white backgrounds.
   - CRITICAL SVG RULE FOR STROKES & CURVES: For all lines, curves, strokes, connectors, arrows, and outlines, you MUST explicitly specify fill="none". Never omit fill on open paths or curves, because SVG defaults omitted fill to solid black, which turns curved lines into solid black rectangles. Only use color fills on intentional closed shapes.

4. Strict Output Constraints:
   - Output ONLY the raw, self-contained <svg>...</svg> element.
   - Include appropriate viewBox (e.g. viewBox="0 0 500 400") and width/height attributes.
   - DO NOT wrap in Markdown code blocks (\`\`\`xml or \`\`\`svg).
   - DO NOT output any conversational text, explanations, or preamble.

${extraContextText ? `USER'S DESIGN INSTRUCTIONS & EXPLANATION (Use ONLY as guidance for what visual to draw, DO NOT render these in the SVG):\n"""\n${extraContextText}\n"""\n` : ''}`;

  if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');

  const genAI = new GoogleGenerativeAI(apiKey);
  // Whiteboard AI Redraw strictly uses fast Gemini Flash models
  const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', ...FLASH_CORE_MODELS];

  const attempts: Array<{ model: string; error: string }> = [];

  for (const modelName of modelsToTry) {
    if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        systemInstruction,
        {
          inlineData: {
            data: base64Data,
            mimeType
          }
        }
      ]);

      if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');

      let text = result.response.text();
      text = text.replace(/```xml/gi, '').replace(/```svg/gi, '').replace(/```html/gi, '').replace(/```/g, '').trim();

      const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
      if (!svgMatch) {
        throw new Error('AI responded, but output did not contain a valid <svg> element.');
      }
      return svgMatch[0];
    } catch (err: any) {
      if (err?.message?.includes('aborted')) throw err;
      const errMsg = err?.message || String(err);
      attempts.push({ model: modelName, error: errMsg });
      console.warn(`[Gemini Sketch Redraw] Model ${modelName} failed:`, errMsg);
    }
  }

  const allErrorsText = attempts.map(a => `${a.model}: ${a.error}`).join(' | ');
  let category: SvgGenerationError['category'] = 'UNKNOWN';
  let title = 'AI Sketch Redraw Failed';
  let suggestion = 'All fallback models failed to redraw sketch. Please check your sketch and try again.';

  if (allErrorsText.includes('API_KEY_INVALID') || allErrorsText.includes('API key not valid') || allErrorsText.includes('does not have Generative Language API access')) {
    category = 'KEY_INVALID';
    title = 'Invalid Gemini API Key';
    suggestion = 'Please verify your Gemini API Key in Host Controls (⚙️). Ensure it has Generative Language access.';
  } else if (allErrorsText.includes('429') || allErrorsText.includes('Quota exceeded') || allErrorsText.includes('RESOURCE_EXHAUSTED')) {
    category = 'QUOTA_EXCEEDED';
    title = 'API Quota Exceeded';
    suggestion = 'Your Gemini API key has reached its request or token quota. Please wait a moment or update your key.';
  } else if (allErrorsText.includes('503') || allErrorsText.includes('high demand') || allErrorsText.includes('Service Unavailable')) {
    category = 'HIGH_DEMAND';
    title = 'Server Experiencing High Demand';
    suggestion = 'Google Gemini servers are currently under temporary load spikes. Please retry in a few moments.';
  } else if (allErrorsText.includes('valid <svg> element')) {
    category = 'PARSE_ERROR';
    title = 'SVG Format Error';
    suggestion = 'The model did not return a valid SVG. Please try again with a cleaner selection.';
  } else if (allErrorsText.includes('Failed to fetch') || allErrorsText.includes('NetworkError')) {
    category = 'NETWORK';
    title = 'Network Connection Error';
    suggestion = 'Unable to reach Google Gemini API servers. Please check your internet connection.';
  }

  const structuredError: SvgGenerationError = {
    isAiError: true,
    category,
    title,
    suggestion,
    attempts,
    rawMessage: allErrorsText
  };

  throw structuredError;
}
