import { GoogleGenerativeAI } from '@google/generative-ai';
import type { MessageItem, MentorConfig } from '../types';

export interface AiActionResponse {
  shouldIntervene: boolean;
  aiMessage?: string;
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract' | 'fact_check';
  assetData?: any;
}

export async function analyzeDialogueWithGemini(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean
): Promise<AiActionResponse> {
  // Use VITE_GEMINI_API_KEY if present, or fallback if placed in VITE_FIREBASE_API_KEY
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || 
    (import.meta.env.VITE_FIREBASE_API_KEY?.startsWith('AQ.') ? import.meta.env.VITE_FIREBASE_API_KEY : '');

  if (!apiKey) {
    if (forced) {
      return {
        shouldIntervene: true,
        aiMessage: "AI Mentor is currently offline: No Gemini API Key configured. Please configure VITE_GEMINI_API_KEY to activate live AI generation."
      };
    }
    return { shouldIntervene: false };
  }

  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const fullText = messages.map(m => `${m.senderName}: ${m.content}`).join('\n');
  const hasMention = forced || (latestMessage ? latestMessage.content.toLowerCase().includes('@mentor') : false);
  
  if (config.sensitivity === 'Strict' && !hasMention && !forced) {
    return { shouldIntervene: false };
  }

  const langNames: Record<string, string> = {
    'en': 'English',
    'zh-TW': 'Traditional Chinese (繁體中文)',
    'ja': 'Japanese (日本語)',
    'ko': 'Korean (한국어)'
  };
  const targetLang = langNames[config.meetingLanguage || 'en'] || 'English';

  const systemInstruction = `You are an AI collaborative design mentor participating in a design meeting.
Your role is to facilitate design consensus, provide design critique, fact-check specifications, and generate concrete assets when requested.
The current sensitivity level is: ${config.sensitivity}.
Active capabilities:
${config.enable3D ? "- 3D Parametric model generation (assetType: 'parametric_3d')\n" : ""}
${config.enableMoodboard ? "- Visual Mood Board creation with concept imagery (assetType: 'moodboard')\n" : ""}
${config.enableFactRetrieval ? "- Fact Retrieval & Specification Verification (assetType: 'fact_check')\n" : ""}
${config.enableProcessIntervention ? "- Structured Meeting Summary & Decision Tracking (assetType: 'summary')\n" : ""}

MANDATORY LANGUAGE REQUIREMENT:
The meeting working language is: ${targetLang}.
You MUST generate ALL conversational text, titles, descriptions, analysis, and recommendations strictly in ${targetLang}.

Review the conversation history and the latest user request.
Determine if you should intervene.
- If @Mentor is explicitly mentioned or forced, you MUST intervene (shouldIntervene = true).
- If asked to summarize, produce a structured design summary with Objectives, Discussed Ideas, Consensus, and Next Steps.
- If asked to fact check or verify a specification/material/dimension, provide verified information with sources/context. IMPORTANT: For the "references" array, you MUST provide REAL, DIRECT web URLs (starting with http:// or https://) that link directly to the standard's official page, a Wikipedia page, or a trusted source. DO NOT just output the name of the standard.
- If asked for 3D model: Note that the 3D generation engine ONLY produces STATIC meshes. DO NOT claim to add animations, motion, physics, or rigging to the 3D model. If the user asks for animation, explicitly tell them that the current 3D engine only supports static models. (Output basic static dimensions, do not output any animation fields).
- If asked for Moodboard, provide keywords, color palette, materials, and 2-4 concept image definitions with url: "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=600&height=400&nologo=true".

Return ONLY a valid JSON object matching this schema:
{
  "shouldIntervene": true,
  "aiMessage": "A concise, professional explanation of your guidance or asset in ${targetLang}",
  "assetType": "parametric_3d" | "moodboard" | "summary" | "fact_check" | null,
  "assetData": {
    // For parametric_3d: { "title": string, "meshType": "group", "components": [ { "shape": "box"|"cylinder"|"sphere"|"torus", "dimensions": object, "position": object, "material": { "color": string, "roughness": number, "metalness": number }, "animation": { "type": "harmonic"|"bounce"|"pendulum"|"spin"|"pulse"|"wave", "axis": "x"|"y"|"z", "amplitude": number, "frequency": number, "phase"?: number, "damping"?: number, "acceleration"?: number } } ] }
    // For moodboard: { "title": string, "description": string, "keywords": string[], "images": [ { "title": string, "prompt": string, "url": string } ], "palette": [ { "hex": string, "name": string } ], "materials": [ { "name": string, "feature": string } ] }
    // For summary: { "title": string, "content": string (Markdown formatted with ## Objectives, ## Key Ideas, ## Consensus, ## Action Items) }
    // For fact_check: { "claim": string, "verdict": string, "details": string, "references": string[] }
  }
}

If no intervention is warranted, return:
{ "shouldIntervene": false }`;

  const prompt = `System Instruction:\n${systemInstruction}\n\nConversation Transcript:\n${fullText}\n\nProvide the JSON response:`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const isPro = config.modelTier === 'pro';
  
  // List models in order of verified availability and capability
  const modelsToTry = isPro
    ? [
        'gemini-3.1-pro-preview',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash'
      ]
    : [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite'
      ];

  let lastError = '';
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });
      const result = await model.generateContent(prompt);
      let text = result.response.text();
      const match = text.match(/\{[\s\S]*\}/);
      const cleanText = match ? match[0] : text;
      const parsed = JSON.parse(cleanText) as AiActionResponse;
      
      if (forced && !parsed.shouldIntervene) {
        parsed.shouldIntervene = true;
        if (!parsed.aiMessage) {
          parsed.aiMessage = "Hello! I am your AI Design Mentor. How can I assist your design discussion?";
        }
      }
      return parsed;
    } catch (err: any) {
      lastError = err?.message || String(err);
      console.warn(`[AI] ${modelName} call failed:`, lastError);
    }
  }

  if (forced) {
    let friendlyReason = lastError;
    if (lastError.includes('402 Payment Required') || lastError.includes('credits are depleted')) {
      friendlyReason = 'Gemini API credits depleted (402 Payment Required). Please top up or generate a new key on Google AI Studio.';
    }
    return {
      shouldIntervene: true,
      aiMessage: `AI Mentor could not connect to Gemini models (${isPro ? 'Pro' : 'Flash'}). Reason: ${friendlyReason}`
    };
  }

  return { shouldIntervene: false };
}
