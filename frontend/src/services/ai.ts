import { GoogleGenerativeAI } from '@google/generative-ai';
import type { MessageItem, MentorConfig } from '../types';

export interface AiActionResponse {
  shouldIntervene: boolean;
  aiMessage?: string;
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract';
  assetData?: any;
}

export async function analyzeDialogueWithGemini(
  messages: MessageItem[],
  config: MentorConfig,
  forced: boolean
): Promise<AiActionResponse> {
  // Use VITE_GEMINI_API_KEY if present, otherwise fallback to a default/empty or prompt
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
  if (!apiKey) {
    // If no real API key is provided, gracefully fallback to the smart heuristics mock
    console.warn('[AI] No VITE_GEMINI_API_KEY found, using local fallback.');
    return handleLocalFallback(messages, config, forced);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // Using gemini-2.5-flash as the fast, default model
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const latestMessage = messages[messages.length - 1];
  const fullText = messages.map(m => `${m.senderName}: ${m.content}`).join('\n');
  const hasMention = latestMessage.content.toLowerCase().includes('@mentor');
  
  if (config.sensitivity === 'Strict' && !hasMention && !forced) {
    return { shouldIntervene: false };
  }

  const systemInstruction = `You are an AI design mentor participating in a collaborative meeting.
Your role is to mediate conflicts, suggest directions, and provide concrete assets when needed.
The current sensitivity is ${config.sensitivity}.
You have access to generate the following assets:
${config.enable3D ? "- parametric_3d (JSON defining a 3D structure using cylinders/boxes)\n- mesh_3d (External URL to a GLB model)" : ""}
${config.enableMoodboard ? "- moodboard (JSON defining a color palette and reference images)" : ""}
${config.enableProcessIntervention ? "- summary (A text summary document of the meeting)" : ""}

Review the conversation history and the latest message.
Determine if you should intervene. If the user explicitly asks for something via @Mentor, you MUST intervene and generate the requested asset.
If you intervene, respond with a JSON object exactly matching this schema:
{
  "shouldIntervene": true,
  "aiMessage": "A friendly message explaining what you generated",
  "assetType": "parametric_3d" | "moodboard" | "summary" | null,
  "assetData": { ... asset specific data ... }
}
If you should not intervene, return {"shouldIntervene": false}.
Return ONLY the raw JSON object, no markdown blocks.`;

  const prompt = `System Instruction:\n${systemInstruction}\n\nConversation History:\n${fullText}\n\nAnalyze the conversation and return the JSON response.`;

  try {
    const result = await model.generateContent(prompt);
    let text = result.response.text();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(text) as AiActionResponse;
    return data;
  } catch (err) {
    console.error('[AI] Gemini generation failed:', err);
    return handleLocalFallback(messages, config, forced);
  }
}

// Smart Local Fallback for when no API key is present
function handleLocalFallback(messages: MessageItem[], config: MentorConfig, forced: boolean): AiActionResponse {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) return { shouldIntervene: false };

  const lower = latestMessage.content.toLowerCase();
  const hasMention = lower.includes('@mentor') || forced;
  
  if (config.sensitivity === 'Strict' && !hasMention) {
    return { shouldIntervene: false };
  }

  // 1. Check for Summary
  if (lower.includes('summarize') || lower.includes('summary')) {
    if (!config.enableProcessIntervention) return { shouldIntervene: false };
    return {
      shouldIntervene: true,
      aiMessage: "Here is a summary of the discussion so far based on the chat history.",
      assetType: 'summary',
      assetData: {
        title: "Meeting Summary",
        content: messages.map(m => `- **${m.senderName}**: ${m.content}`).join('\n')
      }
    };
  }

  // 2. Check for Moodboard
  if (lower.includes('mood') || lower.includes('style') || lower.includes('palette') || lower.includes('color')) {
    if (!config.enableMoodboard) return { shouldIntervene: false };
    return {
      shouldIntervene: true,
      aiMessage: "Based on the discussion, here is a visual mood board for reference:",
      assetType: 'moodboard',
      assetData: {
        title: "Visual Mood Board",
        keywords: ["Modern Minimal", "Warm Textures", "Diffused Light"],
        palette: [
          { hex: "#2D3748", name: "Dark Slate" },
          { hex: "#D97706", name: "Warm Amber" },
          { hex: "#E2E8F0", name: "Chalk White" }
        ],
        materials: [
          { name: "Natural Wood", feature: "Matte finish" },
          { name: "Anodized Aluminum", feature: "Low-reflection" }
        ],
        slices: [
          { url: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=600&q=80", caption: "Light & Volume" },
          { url: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=600&q=80", caption: "Organic Textures" }
        ]
      }
    };
  }

  // 3. Check for 3D Prototype
  if (lower.includes('3d') || lower.includes('model') || lower.includes('prototype') || lower.includes('car')) {
    if (!config.enable3D) return { shouldIntervene: false };
    return {
      shouldIntervene: true,
      aiMessage: "To help visualize the concept, here is a parametric 3D prototype based on your request:",
      assetType: 'parametric_3d',
      assetData: {
        title: "Parametric 3D Prototype",
        meshType: "group",
        components: [
          { shape: "box", dimensions: { width: 1.5, height: 0.5, depth: 3 }, position: { x: 0, y: 0.25, z: 0 }, material: { color: "#3B82F6", roughness: 0.4, metalness: 0.6 } },
          { shape: "cylinder", dimensions: { radiusTop: 0.4, radiusBottom: 0.4, height: 0.2 }, position: { x: -0.8, y: 0.4, z: 1 }, material: { color: "#1F2937", roughness: 0.9, metalness: 0.1 } },
          { shape: "cylinder", dimensions: { radiusTop: 0.4, radiusBottom: 0.4, height: 0.2 }, position: { x: 0.8, y: 0.4, z: 1 }, material: { color: "#1F2937", roughness: 0.9, metalness: 0.1 } },
          { shape: "cylinder", dimensions: { radiusTop: 0.4, radiusBottom: 0.4, height: 0.2 }, position: { x: -0.8, y: 0.4, z: -1 }, material: { color: "#1F2937", roughness: 0.9, metalness: 0.1 } },
          { shape: "cylinder", dimensions: { radiusTop: 0.4, radiusBottom: 0.4, height: 0.2 }, position: { x: 0.8, y: 0.4, z: -1 }, material: { color: "#1F2937", roughness: 0.9, metalness: 0.1 } }
        ],
        annotations: [
          { label: "Main Body", position: { x: 0, y: 1, z: 0 } },
          { label: "Wheelbase", position: { x: 0, y: 0.4, z: 1 } }
        ]
      }
    };
  }

  // Catch-all response for mentions
  if (hasMention) {
    return {
      shouldIntervene: true,
      aiMessage: "I'm here to help! Try asking me to 'generate a 3D prototype', 'create a moodboard', or 'summarize the discussion'.",
      assetType: undefined,
      assetData: undefined
    };
  }

  return { shouldIntervene: false };
}
