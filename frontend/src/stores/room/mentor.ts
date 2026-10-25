import { ref, type Ref } from 'vue';
import { deleteDoc, setDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem, TypingUser } from '../../types';
import { roomDocRef, roomRef, type RoomContext } from './context';

const COOLDOWN_SEC = 8;
const AUTO_SCAN_EVERY = 5; // autonomous analysis runs on every Nth message

type Messages = {
  addAiMessage: (content: string, assetType?: any, assetPayload?: any, actionOptions?: string[]) => Promise<void>;
  sendCustomMessage: (payload: Partial<MessageItem>) => Promise<string | undefined>;
  updateCustomMessage: (id: string, updates: Partial<MessageItem>) => Promise<void>;
};

const TASK_BY_COMMAND: [RegExp, string][] = [
  [/\/3d/, '3D Model Generation'],
  [/\/moodboard/, 'Moodboard Synthesis'],
  [/\/(fact|retrieve)/, 'Fact Retrieval'],
  [/\/summary/, 'Meeting Summary']
];

/** AI Mentor orchestration: when to call the model, AI presence indicators, and 3D generation. */
export function useRoomMentor(ctx: RoomContext, messages: Messages, typingUsers: Ref<TypingUser[]>) {
  const { currentRoom, authStore, mentorStore, pushToast } = ctx;

  const isAnalyzing = ref(false);
  const isGenerating3D = ref(false);
  const aiStatus = ref<'idle' | 'analyzing' | 'generating_asset' | 'cooldown' | 'error'>('idle');
  const aiStatusDetail = ref('Ready');
  const generating3DStatus = ref('');
  const aiCooldownRemaining = ref(0);
  const lastAiCallTime = ref(0);

  let abortController: AbortController | null = null;
  let cooldownTimer: ReturnType<typeof setInterval> | undefined;

  const roomId = () => currentRoom.value!.roomId;
  const setReady = () => {
    aiStatus.value = 'idle';
    aiStatusDetail.value = 'Ready';
  };

  // ---------- AI presence broadcast (typing doc + rooms.aiActiveTask) ----------
  const AI_TYPING = {
    text: { uid: 'ai_mentor', displayName: 'AI Mentor', avatar: '✨' },
    mesh: { uid: 'ai_mentor_3d', displayName: 'AI Mentor (3D)', avatar: '🎨' }
  };

  const setAiTyping = (kind: keyof typeof AI_TYPING, on: boolean, statusDetail?: string) => {
    if (!currentRoom.value) return;
    const ref = roomDocRef(roomId(), 'typing', AI_TYPING[kind].uid);
    if (on) setDoc(ref, { ...AI_TYPING[kind], ...(statusDetail ? { statusDetail } : {}), timestamp: Date.now() }).catch(() => {});
    else deleteDoc(ref).catch(() => {});
  };

  const setAiActiveTask = (task: { type: string; prompt: string } | null) => {
    if (!currentRoom.value) return;
    const aiActiveTask = task && {
      callerName: authStore.displayName || 'Participant',
      callerUid: authStore.uid,
      ...task,
      startedAt: Date.now()
    };
    updateDoc(roomRef(roomId()), { aiActiveTask }).catch(() => {});
  };

  const clearLocalAiTyping = () => {
    typingUsers.value = typingUsers.value.filter(u => u.uid !== 'ai_mentor' && u.uid !== 'ai_mentor_3d');
  };

  const abortCurrentAiGeneration = () => {
    abortController?.abort();
    abortController = null;
    isAnalyzing.value = false;
    isGenerating3D.value = false;
    setReady();
    generating3DStatus.value = '';
    clearLocalAiTyping();
    setAiTyping('text', false);
    setAiTyping('mesh', false);
    setAiActiveTask(null);
    pushToast('AI Stopped', 'AI Mentor generation has been stopped.', 'info');
  };

  const startCooldown = () => {
    lastAiCallTime.value = Date.now();
    aiCooldownRemaining.value = COOLDOWN_SEC;
    aiStatus.value = 'cooldown';
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      aiCooldownRemaining.value--;
      if (aiCooldownRemaining.value <= 0) {
        clearInterval(cooldownTimer);
        setReady();
      } else {
        aiStatusDetail.value = `Cooling down (${aiCooldownRemaining.value}s)`;
      }
    }, 1000);
  };

  // Keeps the 3D typing indicator alive while a long-running 3D task is in progress
  const keepMeshTypingAlive = () => {
    setAiTyping('mesh', true);
    const timer = setInterval(() => {
      if (currentRoom.value && isGenerating3D.value) setAiTyping('mesh', true);
      else clearInterval(timer);
    }, 4000);
  };

  // ---------- 3D generation ----------
  const rehostGlb = async (modelUrl: string, taskId?: string) => {
    const { reHostGlbToFirebaseStorage, isFirebaseStorageUrl } = await import('../../services/glbProxy');
    // Only a permanent Firebase Storage URL is safe to persist; otherwise keep the provider URL
    if (isFirebaseStorageUrl(modelUrl) || !taskId) return { storedModelUrl: modelUrl, isInteractive: false };
    const proxyRes = await reHostGlbToFirebaseStorage(modelUrl, taskId, status => { generating3DStatus.value = status; });
    if (proxyRes.success && proxyRes.firebaseUrl && proxyRes.isPermanent) {
      return { storedModelUrl: proxyRes.firebaseUrl, isInteractive: true };
    }
    if (!proxyRes.success) console.warn('[3D] GLB proxy failed, using original URL:', proxyRes.error);
    return { storedModelUrl: modelUrl, isInteractive: false };
  };

  const run3DGeneration = async (aiMessage: string, prompt3D: string, assetData: any) => {
    if (isGenerating3D.value) {
      pushToast('AI Busy', 'A 3D model is already being generated.', 'info');
      return;
    }
    isGenerating3D.value = true;
    generating3DStatus.value = 'Initializing 3D generation...';
    setAiActiveTask({ type: '3D Neural Mesh Generation', prompt: prompt3D.slice(0, 100) });
    keepMeshTypingAlive();

    try {
      const meshy = await import('../../services/meshy');
      const tripo = await import('../../services/tripo');
      const meshyKey = meshy.getStoredMeshyApiKey();
      const tripoKey = tripo.getStoredTripoApiKey();
      const activeEngine = localStorage.getItem('ai_3d_engine') || (window as any).__SHARED_HOST_3D_ENGINE__
        || currentRoom.value?.sharedApiKeys?.engine3D || 'meshy';

      // Preferred engine first; the other one only when the preferred has no key
      const engines = [
        { id: 'meshy', key: meshyKey, label: 'Meshy AI', provider: 'Meshy.ai v2 Text-to-3D', note: 'Meshy AI text-to-3d neural engine',
          run: () => meshy.generate3DModelWithMeshy(prompt3D, meshyKey, s => { generating3DStatus.value = s; }) },
        { id: 'tripo', key: tripoKey, label: 'Tripo3D', provider: 'Tripo3D API', note: 'Tripo3D neural engine',
          run: () => tripo.generate3DModelWithTripo(prompt3D, tripoKey, s => { generating3DStatus.value = s; }) }
      ];
      const ordered = activeEngine === 'tripo' ? [engines[1], engines[0]] : engines;

      for (const engine of ordered) {
        const other = engines.find(e => e !== engine)!;
        if (!engine.key || (engine.id !== activeEngine && other.key)) continue;
        generating3DStatus.value = `Generating 3D model via ${engine.label}...`;
        const res: any = await engine.run();
        if (!res.success || !res.modelUrl) continue;

        mentorStore.recordCheckpoint(currentRoom.value?.messages.length || 0, `${engine.label} Textured Mesh`, 90);
        const { storedModelUrl, isInteractive } = await rehostGlb(res.modelUrl, res.taskId);
        await messages.addAiMessage(`${aiMessage}\n(Generated using ${engine.note})`, 'mesh_3d', {
          title: prompt3D,
          provider: engine.provider,
          taskId: res.taskId,
          modelUrl: storedModelUrl,
          originalModelUrl: res.modelUrl,
          ...(res.thumbnailUrl ? { posterUrl: res.thumbnailUrl } : {}),
          isRefined: false,
          isInteractive
        });
        return;
      }
      await messages.addAiMessage(aiMessage || 'Fallback to parametric 3D structure.', 'parametric_3d', assetData);
    } catch (err) {
      console.warn('[3D Generation] Error:', err);
      await messages.addAiMessage(aiMessage || 'Error generating 3D model, falling back to basic parametric 3D structure.', 'parametric_3d', assetData);
    } finally {
      isGenerating3D.value = false;
      generating3DStatus.value = '';
      setAiTyping('mesh', false);
      setAiActiveTask(null);
    }
  };

  // ---------- Mentor analysis ----------
  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    const lowerText = latestText.toLowerCase();
    const isForced = lowerText.includes('@mentor');

    if (!isForced) {
      if (mentorStore.config.sensitivity === 'Strict') return;
      if (currentRoom.value.messages.length % AUTO_SCAN_EVERY !== 0) return;
    }

    // One analysis at a time (also prevents duplicate 3D API calls)
    if (isAnalyzing.value) {
      if (isForced) pushToast('AI Busy', 'AI Mentor is currently generating another response. Please wait.', 'info');
      return;
    }

    const elapsed = Date.now() - lastAiCallTime.value;
    if (elapsed < COOLDOWN_SEC * 1000) {
      if (isForced) {
        const remainingSec = Math.ceil((COOLDOWN_SEC * 1000 - elapsed) / 1000);
        aiStatus.value = 'cooldown';
        aiStatusDetail.value = `Cooling down (${remainingSec}s remaining)`;
        pushToast('AI Cooling Down', `Please wait ${remainingSec}s before requesting AI Mentor again.`, 'warning');
      }
      return;
    }

    const tierName = mentorStore.config.modelTier === 'pro' ? 'Pro' : 'Flash';
    isAnalyzing.value = true;
    abortController = new AbortController();
    if (isForced) {
      aiStatus.value = 'analyzing';
      aiStatusDetail.value = `Analyzing with Gemini ${tierName}...`;
    }

    const taskType = TASK_BY_COMMAND.find(([re]) => re.test(lowerText))?.[1] || 'AI Brainstorming';
    const cleanPrompt = latestText.replace(/@mentor/gi, '').replace(/\/(3d|moodboard|fact|retrieve|summary)/gi, '').trim().slice(0, 100);
    setAiTyping('text', true, `Brainstorming with Gemini ${tierName}...`);
    setAiActiveTask({ type: taskType, prompt: cleanPrompt || latestText.slice(0, 80) });

    try {
      const { analyzeDialogueWithGemini } = await import('../../services/ai');
      const response = await analyzeDialogueWithGemini(
        currentRoom.value.messages,
        mentorStore.config,
        isForced,
        abortController.signal,
        currentRoom.value.whiteboardMemories,
        currentRoom.value.participants
      );

      if (response.degradedFromPro) {
        await messages.sendCustomMessage({
          senderUid: 'system',
          senderName: 'System',
          content: '⚡ Note: Automatically switched from Gemini Pro to Flash due to free-tier quota limits.',
          type: 'text'
        });
      }

      if (response.shouldIntervene && response.aiMessage) {
        const msgCount = currentRoom.value.messages.length;
        const aiMessage = response.aiMessage;
        switch (response.assetType) {
          case 'parametric_3d': {
            const prompt3D = response.assetData?.prompt3D || response.assetData?.title || latestText.replace(/@mentor/gi, '').trim();
            run3DGeneration(aiMessage, prompt3D, response.assetData); // background task
            break;
          }
          case 'moodboard':
            mentorStore.recordCheckpoint(msgCount, 'Generated Moodboard', 60);
            await messages.addAiMessage(aiMessage, 'moodboard', response.assetData);
            break;
          case 'summary':
            mentorStore.recordCheckpoint(msgCount, 'Meeting Checkpoint Summary', 75);
            await messages.addAiMessage(aiMessage, 'summary', response.assetData);
            break;
          case 'fact_check':
            mentorStore.recordCheckpoint(msgCount, 'Fact Check Verification', 50);
            await messages.addAiMessage(aiMessage, 'fact_check', response.assetData);
            break;
          default:
            mentorStore.recordCheckpoint(msgCount, 'Consensus guidance', 75);
            await messages.addAiMessage(aiMessage, null, null, response.actionOptions);
        }
      }
      setReady();
    } catch (e: any) {
      console.error('[AI] Agent error:', e);
      if (isForced) {
        aiStatus.value = 'error';
        aiStatusDetail.value = e?.message ? e.message.slice(0, 100) : 'Generation failed';
        pushToast('AI Mentor Error', aiStatusDetail.value, 'error');
      }
    } finally {
      isAnalyzing.value = false;
      clearLocalAiTyping();
      setAiTyping('text', false);
      setAiTyping('mesh', false);
      if (!isGenerating3D.value) setAiActiveTask(null);
      startCooldown();
    }
  };

  const retryAiMentorMessage = async (messageId: string) => {
    if (!currentRoom.value || isAnalyzing.value) return;
    if (!currentRoom.value.messages.some(m => m.id === messageId)) return;

    isAnalyzing.value = true;
    try {
      const { analyzeDialogueWithGemini } = await import('../../services/ai');
      const response = await analyzeDialogueWithGemini(
        currentRoom.value.messages,
        { ...mentorStore.config, modelTier: 'flash' },
        true,
        undefined,
        currentRoom.value.whiteboardMemories,
        currentRoom.value.participants
      );
      if (response.shouldIntervene && response.aiMessage) {
        await messages.updateCustomMessage(messageId, {
          content: response.aiMessage,
          ...(response.assetType && response.assetData
            ? { type: 'ai_asset', assetPayload: { type: response.assetType, ...response.assetData } }
            : {})
        });
      }
    } catch (err) {
      console.error('Failed to retry AI Mentor message:', err);
    } finally {
      isAnalyzing.value = false;
    }
  };

  // Texturing pass for an existing Meshy model
  const refineMeshyModel = async (originalMsg: MessageItem, texturePrompt = '') => {
    if (!currentRoom.value || !originalMsg.assetPayload?.taskId) {
      pushToast('Cannot Refine', 'No valid Meshy task ID associated with this model.', 'warning');
      return;
    }
    if (isGenerating3D.value) {
      pushToast('AI Busy', 'Another 3D generation is currently in progress.', 'info');
      return;
    }
    const { getStoredMeshyApiKey, refineAndColorizeModelWithMeshy } = await import('../../services/meshy');
    const meshyKey = getStoredMeshyApiKey();
    if (!meshyKey) {
      pushToast('Key Required', 'Please configure your Meshy API Key in Host Controls.', 'warning');
      return;
    }

    isGenerating3D.value = true;
    generating3DStatus.value = 'Refining & colorizing 3D model with Meshy...';
    keepMeshTypingAlive();
    try {
      const { title, taskId } = originalMsg.assetPayload;
      const res = await refineAndColorizeModelWithMeshy(
        taskId,
        texturePrompt || title || 'high quality realistic pbr textures',
        meshyKey,
        status => { generating3DStatus.value = status; }
      );
      if (res.success && res.modelUrl) {
        await messages.addAiMessage(`✨ I have refined「${title}」with high-resolution color PBR textures and details.！`, 'mesh_3d', {
          title: `${title} (Colored / PBR)`,
          provider: 'Meshy.ai v2 Refine Engine',
          taskId: res.taskId,
          modelUrl: res.modelUrl,
          posterUrl: res.thumbnailUrl,
          isRefined: true
        });
        pushToast('3D Refined', 'Textures and colors have been applied successfully!', 'success');
      } else {
        pushToast('Refine Failed', res.error || 'Meshy texturing failed.', 'error');
      }
    } catch (err: any) {
      console.error('Meshy refine error:', err);
      pushToast('Refine Error', err.message || 'Error communicating with Meshy.', 'error');
    } finally {
      isGenerating3D.value = false;
      generating3DStatus.value = '';
      setAiTyping('mesh', false);
    }
  };

  return {
    isAnalyzing,
    isGenerating3D,
    aiStatus,
    aiStatusDetail,
    generating3DStatus,
    aiCooldownRemaining,
    triggerMentorAgent,
    abortCurrentAiGeneration,
    retryAiMentorMessage,
    refineMeshyModel
  };
}
