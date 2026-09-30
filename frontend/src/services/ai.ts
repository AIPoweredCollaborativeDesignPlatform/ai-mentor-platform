import { GoogleGenerativeAI } from '@google/generative-ai';
import type { MessageItem, MentorConfig } from '../types';

export interface AiActionResponse {
  shouldIntervene: boolean;
  aiMessage?: string;
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

export async function analyzeDialogueWithGemini(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean,
  abortSignal?: AbortSignal,
  whiteboardMemories?: WhiteboardMemoryItem[]
): Promise<AiActionResponse & { degradedFromPro?: boolean }> {
  const apiKey = getStoredGeminiApiKey();

  const langNames: Record<string, string> = {
    en: 'English',
    'zh-TW': 'Traditional Chinese (Traditional Chinese)',
    ja: 'Japanese (Japanese)',
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
    .slice(-15) // Keep last 15 messages for richer context
    .map((m) => `${m.senderName}: ${m.content}`)
    .join('\n');

  let whiteboardContext = '';
  if (whiteboardMemories && whiteboardMemories.length > 0) {
    const memoryLines = whiteboardMemories
      .slice(-6)
      .map((m) => `[Whiteboard Snapshot at ${m.timeFormatted || new Date(m.timestamp).toLocaleTimeString()}]: ${m.summary}`)
      .join('\n');
    whiteboardContext = `\n\nRecent Collaborative Whiteboard Evolution & Visual Milestones:\n${memoryLines}`;
  }

  const systemInstruction = `You are an expert AI Design Mentor & Product Strategy Facilitator in a collaborative design studio.
Respond in ${targetLang}.
Current Sensitivity: ${config.sensitivity}
Features Enabled: 3D=${config.enable3D}, Moodboard=${config.enableMoodboard}, FactRetrieval=${config.enableFactRetrieval}, ProcessIntervention=${config.enableProcessIntervention}
${whiteboardContext}

Role & Capabilities:
- Actively mentor and accelerate product, UI/UX, and industrial design collaboration.
- Determine if you should intervene:
  1. If @Mentor is explicitly mentioned or forced, you MUST intervene (shouldIntervene = true).
  2. If the user asks about the whiteboard/sketchpad, drawings, diagrams, or visual concepts, refer to the Whiteboard Evolution & Visual Milestones above.
  3. **Topic Drift & Focus Intervention**: If you observe the team drifting into off-topic chit-chat (e.g. gaming, gossip, unrelated banter) during an active design session, tactfully and constructively intervene with design facilitation advice to guide the team back to their creative design goals.
  4. If asked to summarize, produce a structured design summary with Objectives, Discussed Ideas, Consensus, and Next Steps.
  5. If asked to fact check or verify a specification/material/dimension, provide verified information with sources/context. IMPORTANT: For the "references" array, you MUST provide REAL, DIRECT web URLs (starting with http:// or https://) that link directly to the standard's official page, a Wikipedia page, or a trusted source.
  6. If asked for 3D model: The 3D engine generates watertight static 3D meshes for industrial/product prototypes. (Output basic static dimensions, do not output any animation fields).
  7. If asked for Moodboard:
     - Moodboards are universal design research and ideation tools for ANY design discipline (digital UI/UX, product design, consumer electronics, lifestyle goods, mobility, branding, fashion, architecture).
     - DO NOT default or bias towards furniture or interior design unless the user specifically and explicitly asked for furniture/interior!
     - Synthesize authentic multidisciplinary research aligned with the team's discussion:
       a) User Personas & Context of Use (real-world scenarios, human interactions, environment)
       b) Lifestyle & Activities (user behavior, daily tasks, lifestyle dynamics)
       c) Lighting & Atmospheric Mood (shadows, illumination, color temperature, tone)
       d) Materials & Surface Textures (tactile finishes, engineered composites, textiles, matte/gloss textures)
       e) Visual Style & Brand Culture (typography, graphics, aesthetic ethos, cultural references)
     - Provide keywords, color palette (hex + name), materials (name + feature), and 3-4 diverse concept images covering these distinct facets.
     - Image prompts MUST be concrete, vivid English visual descriptions specifically matching the category and title (e.g., if title is "Battle-worn Fuselage", prompt must strictly describe "scratched battle-worn aircraft metal fuselage plates, weathered rivets, industrial macro texture", NEVER a human face; if title is "Nomadic Engineer", prompt must describe "hardware engineer working on laptop at portable field workbench with tools", NEVER abstract bubbles).
     - Each image must include:
       { "title": string, "category": "Persona / Context" | "Activity / Lifestyle" | "Material & Texture" | "Color & Lighting", "prompt": string, "sourceUrl": string, "url": "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=600&height=400&nologo=true" }

Return ONLY a valid JSON object matching this schema:
{
  "shouldIntervene": true,
  "aiMessage": "A concise, inspiring explanation of your guidance or asset in ${targetLang}",
  "assetType": "parametric_3d" | "moodboard" | "summary" | "fact_check" | null,
  "assetData": {
    // For parametric_3d: { "title": string, "meshType": "group", "components": [ { "shape": "box"|"cylinder"|"sphere"|"torus", "dimensions": object, "position": object, "material": { "color": string, "roughness": number, "metalness": number } } ] }
    // For moodboard: { "title": string, "description": string, "keywords": string[], "images": [ { "title": string, "category": string, "prompt": string, "url": string } ], "palette": [ { "hex": string, "name": string } ], "materials": [ { "name": string, "feature": string } ] }
    // For summary: { "title": string, "content": string (Markdown formatted with ## Objectives, ## Key Ideas, ## Consensus, ## Action Items) }
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
