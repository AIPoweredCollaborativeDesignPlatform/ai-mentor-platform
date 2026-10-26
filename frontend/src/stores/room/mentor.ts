import { computed, ref, type Ref } from 'vue';
import { deleteDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem, TypingUser } from '../../types';
import { roomDocRef, roomRef, type RoomContext } from './context';

type Messages = {
  addAiMessage: (content: string, assetType?: any, assetPayload?: any, actionOptions?: string[], aiMeta?: unknown) => Promise<void>;
};

/**
 * Client view of the AI mentor. When and whether the AI speaks is decided server-side
 * (functions/src/engine.js, triggered by each new message); the browser only shows the
 * AI's presence, can stop a running reply, retry a failed one, and refine 3D models.
 */
export function useRoomMentor(ctx: RoomContext, messages: Messages, typingUsers: Ref<TypingUser[]>) {
  const { currentRoom, pushToast } = ctx;

  const isAnalyzing = computed(() => typingUsers.value.some(u => u.uid === 'ai_mentor'));
  const isGenerating3D = computed(() => typingUsers.value.some(u => u.uid === 'ai_mentor_3d'));
  const isRefining = ref(false);
  const aiStatus = computed<'idle' | 'analyzing'>(() => (isAnalyzing.value ? 'analyzing' : 'idle'));
  const aiStatusDetail = computed(() => (isAnalyzing.value ? 'AI is thinking...' : 'Ready'));
  const generating3DStatus = computed(() => (isGenerating3D.value || isRefining.value ? 'Generating 3D model (about 1–3 minutes)...' : ''));
  // Kept for UI compatibility; pacing is now handled by the server-side cooldown
  const aiCooldownRemaining = ref(0);

  /** Asks the server to discard the reply in progress (checked before it posts). */
  const abortCurrentAiGeneration = () => {
    if (!currentRoom.value) return;
    const roomId = currentRoom.value.roomId;
    updateDoc(roomRef(roomId), { aiAbortAt: Date.now(), aiActiveTask: null }).catch(() => {});
    deleteDoc(roomDocRef(roomId, 'typing', 'ai_mentor')).catch(() => {});
    pushToast('AI Stopped', 'The AI reply in progress has been stopped.', 'info');
  };

  const retryAiMentorMessage = async (messageId: string) => {
    if (!currentRoom.value) return;
    try {
      const { requestMentorResponse } = await import('../../services/ai');
      await requestMentorResponse(currentRoom.value.roomId, messageId);
    } catch (err) {
      console.error('Failed to retry AI message:', err);
      pushToast('Retry Failed', 'Could not reach the AI service. Please try again.', 'error');
    }
  };

  // Texturing pass for an existing Meshy model (explicit user action from the 3D viewer)
  const refineMeshyModel = async (originalMsg: MessageItem, texturePrompt = '') => {
    const { title, taskId } = originalMsg.assetPayload || {};
    if (!currentRoom.value || !taskId) {
      pushToast('Cannot Refine', 'No valid Meshy task ID associated with this model.', 'warning');
      return;
    }
    if (isGenerating3D.value || isRefining.value) {
      pushToast('AI Busy', 'A 3D model is already being generated.', 'info');
      return;
    }
    isRefining.value = true;
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
    } finally {
      isRefining.value = false;
    }
  };

  return {
    isAnalyzing,
    isGenerating3D,
    aiStatus,
    aiStatusDetail,
    generating3DStatus,
    aiCooldownRemaining,
    abortCurrentAiGeneration,
    retryAiMentorMessage,
    refineMeshyModel
  };
}
