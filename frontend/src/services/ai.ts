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

export async function analyzeDialogueWithGemini(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean,
  abortSignal?: AbortSignal
): Promise<AiActionResponse> {
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
    .slice(-15) // Keep last 15 messages for richer context
    .map((m) => `${m.senderName}: ${m.content}`)
    .join('\n');

  const systemInstruction = `You are an expert AI Design Mentor & Product Strategy Facilitator in a collaborative design studio.
Respond in ${targetLang}.
Current Sensitivity: ${config.sensitivity}
Features Enabled: 3D=${config.enable3D}, Moodboard=${config.enableMoodboard}, FactRetrieval=${config.enableFactRetrieval}, ProcessIntervention=${config.enableProcessIntervention}

Role & Capabilities:
- Actively mentor and accelerate product, UI/UX, and industrial design collaboration.
- Determine if you should intervene:
  1. If @Mentor is explicitly mentioned or forced, you MUST intervene (shouldIntervene = true).
  2. **Topic Drift & Focus Intervention**: If you observe the team drifting into off-topic chit-chat (e.g. gaming, gossip, unrelated banter) during an active design session, tactfully and constructively intervene with design facilitation advice to guide the team back to their creative design goals.
  3. If asked to summarize, produce a structured design summary with Objectives, Discussed Ideas, Consensus, and Next Steps.
  4. If asked to fact check or verify a specification/material/dimension, provide verified information with sources/context. IMPORTANT: For the "references" array, you MUST provide REAL, DIRECT web URLs (starting with http:// or https://) that link directly to the standard's official page, a Wikipedia page, or a trusted source.
  5. If asked for 3D model: The 3D engine generates watertight static 3D meshes for industrial/product prototypes. (Output basic static dimensions, do not output any animation fields).
  6. If asked for Moodboard, provide keywords, color palette, materials, and 2-4 concept image definitions with url: "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=600&height=400&nologo=true".

Return ONLY a valid JSON object matching this schema:
{
  "shouldIntervene": true,
  "aiMessage": "A concise, inspiring explanation of your guidance or asset in ${targetLang}",
  "assetType": "parametric_3d" | "moodboard" | "summary" | "fact_check" | null,
  "assetData": {
    // For parametric_3d: { "title": string, "meshType": "group", "components": [ { "shape": "box"|"cylinder"|"sphere"|"torus", "dimensions": object, "position": object, "material": { "color": string, "roughness": number, "metalness": number } } ] }
    // For moodboard: { "title": string, "description": string, "keywords": string[], "images": [ { "title": string, "prompt": string, "url": string } ], "palette": [ { "hex": string, "name": string } ], "materials": [ { "name": string, "feature": string } ] }
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

  // List models in order of verified availability and capability
  const modelsToTry = isPro
    ? ['gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
    : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

  let lastError = '';
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

      if (forced && !parsed.shouldIntervene) {
        parsed.shouldIntervene = true;
        if (!parsed.aiMessage) {
          parsed.aiMessage = 'Hello! I am your AI Design Mentor. How can I assist your design discussion?';
        }
      }
      return parsed;
    } catch (err: any) {
      if (err?.message?.includes('aborted')) throw err;
      lastError = err?.message || String(err);
      console.warn(`[AI] ${modelName} call failed:`, lastError);
    }
  }

  if (forced) {
    let friendlyReason = lastError;
    if (lastError.includes('404') || lastError.includes('not supported') || lastError.includes('API_KEY_INVALID')) {
      friendlyReason =
        'The configured Google Gemini API Key is invalid or does not have Generative Language API access. Please obtain a free key from Google AI Studio (https://aistudio.google.com/app/apikey) and configure it in Host Controls (⚙️).';
    } else if (lastError.includes('402 Payment Required') || lastError.includes('credits are depleted') || lastError.includes('RESOURCE_EXHAUSTED')) {
      friendlyReason =
        'Gemini API credits depleted or rate limit reached. Please try again shortly or configure a new key on Google AI Studio.';
    }
    return {
      shouldIntervene: true,
      aiMessage: `⚠️ AI Mentor (${isPro ? 'Pro' : 'Flash'}): ${friendlyReason}`
    };
  }

  return { shouldIntervene: false };
}
