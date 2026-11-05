import { computed, ref, type Ref } from 'vue';
import { deleteDoc, updateDoc } from 'firebase/firestore';
import type { MessageItem, TypingUser } from '../../types';
import { roomDocRef, roomRef, type RoomContext } from './context';
import { t } from '../../i18n';

/**
 * Client view of the AI mentor. When and whether the AI speaks is decided server-side
 * (functions/src/engine.js, triggered by each new message); the browser only shows the
 * AI's presence, can stop a running reply, retry a failed one, and refine 3D models.
 */
export function useRoomMentor(ctx: RoomContext, typingUsers: Ref<TypingUser[]>) {
  const { currentRoom, pushToast } = ctx;

  const isAnalyzing = computed(() => typingUsers.value.some(u => u.uid === 'ai_mentor'));
  const isGenerating3D = computed(() => typingUsers.value.some(u => u.uid === 'ai_mentor_3d'));
  const isRefining = ref(false);
  const aiStatus = computed<'idle' | 'analyzing'>(() => (isAnalyzing.value ? 'analyzing' : 'idle'));
  const aiStatusDetail = computed(() => (isAnalyzing.value ? t('ai.thinking') : t('ai.ready')));
  const generating3DStatus = computed(() => (isGenerating3D.value || isRefining.value ? t('ai.generating3D') : ''));
  // Kept for UI compatibility; pacing is now handled by the server-side cooldown
  const aiCooldownRemaining = ref(0);

  /** Asks the server to discard the reply in progress (checked before it posts). */
  const abortCurrentAiGeneration = () => {
    if (!currentRoom.value) return;
    const roomId = currentRoom.value.roomId;
    updateDoc(roomRef(roomId), { aiAbortAt: Date.now(), aiActiveTask: null }).catch(() => {});
    deleteDoc(roomDocRef(roomId, 'typing', 'ai_mentor')).catch(() => {});
    pushToast(t('ai.stoppedTitle'), t('ai.stoppedText'), 'info');
  };

  const retryAiMentorMessage = async (messageId: string) => {
    if (!currentRoom.value) return;
    try {
      const { requestMentorResponse } = await import('../../services/ai');
      await requestMentorResponse(currentRoom.value.roomId, messageId);
    } catch (err) {
      console.error('Failed to retry AI message:', err);
      pushToast(t('toast.retryFailed'), t('ai.retryFailedText'), 'error');
    }
  };

  // Texturing pass for an existing Meshy model (explicit user action from the 3D viewer)
  const refineMeshyModel = async (originalMsg: MessageItem, texturePrompt = '') => {
    const { title, taskId, textureVia } = originalMsg.assetPayload || {};
    if (!currentRoom.value || !taskId) {
      pushToast(t('ai.cannotRefineTitle'), t('ai.cannotRefineText'), 'warning');
      return;
    }
    if (isGenerating3D.value || isRefining.value) {
      pushToast(t('ai.busyTitle'), t('ai.busy3D'), 'info');
      return;
    }
    isRefining.value = true;
    try {
      const { refineModel3D } = await import('../../services/model3d');
      // The server posts the refined model to the chat as an AI message
      await refineModel3D(currentRoom.value.roomId, taskId, texturePrompt || title || 'high quality realistic pbr textures', title || '', textureVia || '');
      pushToast(t('ai.refinedToastTitle'), t('ai.refinedToastText'), 'success');
    } catch (err: any) {
      console.error('Meshy refine error:', err);
      pushToast(t('ai.refineFailedTitle'), err?.message || t('ai.refineFailedText'), 'error');
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
