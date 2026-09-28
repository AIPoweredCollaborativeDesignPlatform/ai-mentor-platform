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

  const modelsToTry = isPro
    ? ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.6-flash']
    : ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];

  let lastError = '';
  let accumulatedErrors = [];
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
      accumulatedErrors.push(`${modelName}: ${lastError.substring(0, 80)}...`);
      console.warn(`[AI] ${modelName} call failed:`, lastError);
    }
  }

  if (forced) {
    let friendlyReason = lastError;
    if (lastError.includes('404') || lastError.includes('not supported') || lastError.includes('API_KEY_INVALID') || lastError.includes('is not found for API version')) {
      friendlyReason =
        'The configured Google Gemini API Key is invalid or does not have Generative Language API access. DO NOT use your Firebase Web API Key. Please obtain a dedicated free Gemini API key from Google AI Studio (https://aistudio.google.com/app/apikey) and configure it in Host Controls (⚙️).';
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
  // Verified working models: gemini-3.5-flash is stable and avoids 503 high-demand spikes
  const modelsToTry = config.modelTier === 'pro' 
    ? ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash']
    : ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-lite-latest'];

  const attempts: Array<{ model: string; error: string }> = [];

  for (const modelName of modelsToTry) {
    if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(systemInstruction);

      if (abortSignal?.aborted) throw new Error('AI analysis aborted by user');

      let text = result.response.text();
      // Clean up markdown code fences
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

  // Determine root cause from attempts
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
