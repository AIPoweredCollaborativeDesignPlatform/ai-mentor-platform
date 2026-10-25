import { ref, type Ref } from 'vue';
import { deleteDoc, setDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem, TypingUser } from '../../types';
import { roomDocRef, roomRef, type RoomContext } from './context';

const COOLDOWN_SEC = 8;
const AUTO_SCAN_EVERY = 5; // autonomous analysis runs on every Nth message

type Messages = {
  addAiMessage: (content: string, assetType?: any, assetPayload?: any, actionOptions?: string[], aiMeta?: unknown) => Promise<void>;
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

  /** Runs a server-side 3D job, showing `status` meanwhile. Returns false if another job is running. */
  const withMeshJob = async (status: string, job: () => Promise<void>) => {
    if (isGenerating3D.value) {
      pushToast('AI Busy', 'A 3D model is already being generated.', 'info');
      return;
    }
    isGenerating3D.value = true;
    generating3DStatus.value = status;
    keepMeshTypingAlive();
    try {
      await job();
    } finally {
      isGenerating3D.value = false;
      generating3DStatus.value = '';
      setAiTyping('mesh', false);
    }
  };

  // ---------- 3D generation (falls back to the instant parametric preview on failure) ----------
  const run3DGeneration = (aiMessage: string, prompt3D: string, assetData: any, aiMeta?: unknown) =>
    withMeshJob('Generating 3D model (about 1–3 minutes)...', async () => {
      setAiActiveTask({ type: '3D Neural Mesh Generation', prompt: prompt3D.slice(0, 100) });
      try {
        const { generateModel3D } = await import('../../services/model3d');
        const res = await generateModel3D(prompt3D);
        mentorStore.recordCheckpoint(currentRoom.value?.messages.length || 0, `${res.provider} Mesh`, 90);
        await messages.addAiMessage(aiMessage, 'mesh_3d', {
          title: prompt3D,
          provider: res.provider,
          taskId: res.taskId,
          modelUrl: res.modelUrl,
          originalModelUrl: res.originalModelUrl,
          ...(res.thumbnailUrl ? { posterUrl: res.thumbnailUrl } : {}),
          isRefined: false,
          isInteractive: true
        }, undefined, aiMeta);
      } catch (err) {
        console.warn('[3D Generation] Error, using parametric preview:', err);
        await messages.addAiMessage(aiMessage || 'Showing a basic parametric 3D structure.', 'parametric_3d', assetData, undefined, aiMeta);
      } finally {
        setAiActiveTask(null);
      }
    });

  // ---------- Mentor analysis ----------
  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    const lowerText = latestText.toLowerCase();
    const isForced = lowerText.includes('@mentor');

    if (!isForced) {
      if (mentorStore.config.sensitivity === 'Strict') return;
      if (currentRoom.value.messages.length % AUTO_SCAN_EVERY !== 0) return;
    }

    // One analysis at a time (also prevents duplicate 3D jobs)
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

    isAnalyzing.value = true;
    abortController = new AbortController();
    if (isForced) {
      aiStatus.value = 'analyzing';
      aiStatusDetail.value = 'AI Mentor is thinking...';
    }

    const taskType = TASK_BY_COMMAND.find(([re]) => re.test(lowerText))?.[1] || 'AI Brainstorming';
    const cleanPrompt = latestText.replace(/@mentor/gi, '').replace(/\/(3d|moodboard|fact|retrieve|summary)/gi, '').trim().slice(0, 100);
    setAiTyping('text', true, 'AI Mentor is thinking...');
    setAiActiveTask({ type: taskType, prompt: cleanPrompt || latestText.slice(0, 80) });

    try {
      const { analyzeDialogue } = await import('../../services/ai');
      const response = await analyzeDialogue(
        currentRoom.value.messages,
        mentorStore.config,
        isForced,
        abortController.signal,
        currentRoom.value.whiteboardMemories,
        currentRoom.value.participants,
        currentRoom.value.roomId
      );

      if (response.shouldIntervene && response.aiMessage) {
        const msgCount = currentRoom.value.messages.length;
        const { aiMessage, assetData, meta } = response;
        const CHECKPOINTS: Record<string, [string, number]> = {
          moodboard: ['Generated Moodboard', 60],
          summary: ['Meeting Checkpoint Summary', 75],
          fact_check: ['Fact Check Verification', 50]
        };
        if (response.assetType === 'parametric_3d') {
          const prompt3D = assetData?.prompt3D || assetData?.title || latestText.replace(/@mentor/gi, '').trim();
          run3DGeneration(aiMessage, prompt3D, assetData, meta); // background task
        } else if (response.assetType && CHECKPOINTS[response.assetType]) {
          mentorStore.recordCheckpoint(msgCount, ...CHECKPOINTS[response.assetType]);
          await messages.addAiMessage(aiMessage, response.assetType, assetData, undefined, meta);
        } else {
          mentorStore.recordCheckpoint(msgCount, 'Consensus guidance', 75);
          await messages.addAiMessage(aiMessage, null, null, response.actionOptions, meta);
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
      if (!isGenerating3D.value) setAiActiveTask(null);
      startCooldown();
    }
  };

  // Regenerates a failed AI reply in place
  const retryAiMentorMessage = async (messageId: string) => {
    if (!currentRoom.value || isAnalyzing.value) return;
    if (!currentRoom.value.messages.some(m => m.id === messageId)) return;

    isAnalyzing.value = true;
    try {
      const { analyzeDialogue } = await import('../../services/ai');
      const response = await analyzeDialogue(
        currentRoom.value.messages,
        mentorStore.config,
        true,
        undefined,
        currentRoom.value.whiteboardMemories,
        currentRoom.value.participants,
        currentRoom.value.roomId
      );
      if (response.shouldIntervene && response.aiMessage) {
        await messages.updateCustomMessage(messageId, {
          content: response.aiMessage,
          ...(response.assetType && response.assetData
            ? { type: 'ai_asset', assetType: response.assetType as MessageItem['assetType'], assetPayload: response.assetData }
            : {}),
          ...(response.meta ? { metadata: { ai: response.meta } } : {})
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
    const { title, taskId } = originalMsg.assetPayload || {};
    if (!currentRoom.value || !taskId) {
      pushToast('Cannot Refine', 'No valid Meshy task ID associated with this model.', 'warning');
      return;
    }
    await withMeshJob('Refining & colorizing 3D model (about 1–3 minutes)...', async () => {
      try {
        const { refineModel3D } = await import('../../services/model3d');
        const res = await refineModel3D(taskId, texturePrompt || title || 'high quality realistic pbr textures');
        await messages.addAiMessage(`✨ Refined「${title}」with color PBR textures and details.`, 'mesh_3d', {
          title: `${title} (Colored / PBR)`,
          provider: res.provider,
          taskId: res.taskId,
          modelUrl: res.modelUrl,
          originalModelUrl: res.originalModelUrl,
          posterUrl: res.thumbnailUrl,
          isRefined: true,
          isInteractive: true
        });
        pushToast('3D Refined', 'Textures and colors have been applied successfully!', 'success');
      } catch (err: any) {
        console.error('Meshy refine error:', err);
        pushToast('Refine Failed', err?.message || 'Meshy texturing failed.', 'error');
      }
    });
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
