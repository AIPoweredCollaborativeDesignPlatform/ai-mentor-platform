import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { updateDoc } from 'firebase/firestore';
import type { ParticipantStatus, RoomData, ToastMessage } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';
import { roomDocRef, roomRef, type PushToast, type RoomContext } from './room/context';
import { useRoomSession } from './room/session';
import { useRoomMessages } from './room/messages';
import { useRoomWhiteboard } from './room/whiteboard';
import { useRoomMentor } from './room/mentor';

export type { ToastMessage };

/**
 * Facade over the room sub-modules in ./room/. Components only use this store;
 * the returned API is the single public surface.
 */
export const useRoomStore = defineStore('room', () => {
  const authStore = useAuthStore();
  const mentorStore = useMentorStore();

  const currentRoom = ref<RoomData | null>(null);
  const myStatus = ref<ParticipantStatus>('pending');
  const toasts = ref<ToastMessage[]>([]);

  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);
  window.addEventListener('online', () => { isOnline.value = true; });
  window.addEventListener('offline', () => { isOnline.value = false; });

  const isHost = computed(() => currentRoom.value?.hostUid === authStore.uid);
  const participantsList = computed(() => (currentRoom.value ? Object.values(currentRoom.value.participants) : []));
  const approvedParticipants = computed(() => participantsList.value.filter(p => p.status === 'approved'));
  const pendingParticipants = computed(() => participantsList.value.filter(p => p.status === 'pending'));
  const onlineParticipants = computed(() => approvedParticipants.value.filter(p => p.isOnline !== false));

  // Toasts with actions stay until the user responds; others auto-dismiss after 6s
  const pushToast: PushToast = (title, description, type = 'info', actions) => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    toasts.value.push({ id, title, description, type, actions });
    if (!actions?.length) setTimeout(() => removeToast(id), 6000);
  };
  const removeToast = (id: string) => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  };

  const ctx: RoomContext = { currentRoom, myStatus, isHost, authStore, mentorStore, pushToast };
  const session = useRoomSession(ctx);
  const messages = useRoomMessages(ctx, session.setMyTyping);
  const whiteboard = useRoomWhiteboard(ctx, messages);
  const mentor = useRoomMentor(ctx, messages, session.typingUsers);

  const sendMessage = async (text: string, replyTo?: { id: string; senderName: string; text: string }) => {
    if (!currentRoom.value || !text.trim()) return;
    await messages.sendTextMessage(text, replyTo);
    await mentor.triggerMentorAgent(text);
  };

  const endMeetingForAll = async () => {
    if (!currentRoom.value || !isHost.value) return;
    try {
      await updateDoc(roomRef(currentRoom.value.roomId), { roomStatus: 'ended' });
      await messages.postSystemMessage('Meeting has been ended by the host', '🛑');
    } catch (err) {
      console.error(err);
    }
    session.stopListening();
  };

  const updateParticipantProfile = async (newName: string, newAvatar: string) => {
    if (!currentRoom.value) return;
    const oldName = currentRoom.value.participants[authStore.uid]?.displayName || authStore.displayName;
    authStore.updateProfile(newName, newAvatar);
    if (!authStore.uid) return;
    try {
      await updateDoc(roomDocRef(currentRoom.value.roomId, 'participants', authStore.uid), { displayName: newName, avatar: newAvatar });
      await messages.postSystemMessage(`${oldName} updated profile to ${newName} ${newAvatar}`, '✏️');
    } catch (e) {
      console.error(e);
    }
  };

  const updateRoomInfo = async (name: string, emoji: string) => {
    if (!currentRoom.value) return;
    const cleanName = name.trim() || 'Meeting';
    const cleanEmoji = emoji.trim() || '💡';
    const changed = currentRoom.value.roomName !== cleanName || currentRoom.value.roomEmoji !== cleanEmoji;
    currentRoom.value.roomName = cleanName;
    currentRoom.value.roomEmoji = cleanEmoji;

    try {
      const fields = { roomName: cleanName, roomEmoji: cleanEmoji, updatedAt: Date.now() };
      await updateDoc(roomRef(currentRoom.value.roomId), fields);
      session.upsertMyRoomIndex(currentRoom.value.roomId, fields);
      if (changed) {
        await messages.sendCustomMessage({
          senderUid: 'system',
          senderName: 'System',
          content: `Room details updated to ${cleanEmoji} ${cleanName}`
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to update room info in Firestore:', err);
    }
  };

  return {
    currentRoom,
    myStatus,
    isHost,
    isOnline,
    toasts,
    approvedParticipants,
    pendingParticipants,
    onlineParticipants,
    pushToast,
    removeToast,

    typingUsers: session.typingUsers,
    sendHeartbeat: session.sendHeartbeat,
    checkRoomExists: session.checkRoomExists,
    startFirestoreListener: session.startFirestoreListener,
    stopListening: session.stopListening,
    createRoom: session.createRoom,
    applyToJoin: session.applyToJoin,
    reapplyToJoin: session.reapplyToJoin,
    cancelJoinRequest: session.cancelJoinRequest,
    transferHostOwnership: session.transferHostOwnership,
    setMyTyping: session.setMyTyping,
    approveParticipant: session.approveParticipant,
    rejectParticipant: session.rejectParticipant,
    muteParticipant: session.muteParticipant,
    kickParticipant: session.kickParticipant,
    leaveRoom: session.leaveRoom,
    syncMentorConfig: session.syncMentorConfig,
    updateParticipantWhiteboard: session.updateParticipantWhiteboard,
    endMeetingForAll,
    updateParticipantProfile,
    updateRoomInfo,

    sendMessage,
    sendCustomMessage: messages.sendCustomMessage,
    updateCustomMessage: messages.updateCustomMessage,
    retrySendMessage: messages.retrySendMessage,
    sendFileMessage: messages.sendFileMessage,
    addAiMessage: messages.addAiMessage,
    toggleMessageReaction: messages.toggleMessageReaction,
    votePollOption: messages.votePollOption,
    addCustomPollOption: messages.addCustomPollOption,

    startWhiteboardSession: whiteboard.startWhiteboardSession,
    syncWhiteboardState: whiteboard.syncWhiteboardState,
    endWhiteboardSession: whiteboard.endWhiteboardSession,
    makeWhiteboardPrivate: whiteboard.makeWhiteboardPrivate,
    recordWhiteboardSnapshotMemory: whiteboard.recordWhiteboardSnapshotMemory,

    isAnalyzing: mentor.isAnalyzing,
    aiStatus: mentor.aiStatus,
    aiStatusDetail: mentor.aiStatusDetail,
    isGenerating3D: mentor.isGenerating3D,
    generating3DStatus: mentor.generating3DStatus,
    aiCooldownRemaining: mentor.aiCooldownRemaining,
    abortCurrentAiGeneration: mentor.abortCurrentAiGeneration,
    retryAiMentorMessage: mentor.retryAiMentorMessage,
    refineMeshyModel: mentor.refineMeshyModel
  };
});
