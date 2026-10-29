import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ParticipantStatus, RoomData, ToastMessage } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';
import { type PushToast, type RoomContext } from './room/context';
import { endStudySession, updateRoomProfile, updateStudyRoomDetails } from '../services/session';
import { t } from '../i18n';
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
  // Room name / emoji: the host, whoever created the room (also as a participant), or the administrator
  const canEditRoomDetails = computed(() => isHost.value || (!!authStore.uid && currentRoom.value?.createdBy === authStore.uid) || authStore.isAdmin);
  const participantsList = computed(() => (currentRoom.value ? Object.values(currentRoom.value.participants) : []));
  // The researcher (host) is an invisible observer: never listed or counted
  const approvedParticipants = computed(() => participantsList.value.filter(p => p.status === 'approved' && p.uid !== currentRoom.value?.hostUid));
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
  const whiteboard = useRoomWhiteboard(ctx);
  const mentor = useRoomMentor(ctx, session.typingUsers);

  const sendMessage = async (text: string, replyTo?: { id: string; senderName: string; text: string }) => {
    if (!currentRoom.value || !text.trim()) return;
    // Whether the AI responds is decided server-side when the message is stored
    await messages.sendTextMessage(text, replyTo);
  };

  // The server ends the session (status, notice, event log); the room stays open read-only
  const endMeetingForAll = async () => {
    if (!currentRoom.value || !(isHost.value || authStore.isAdmin)) return;
    try {
      await endStudySession(currentRoom.value.roomId);
    } catch (err: any) {
      pushToast(t('toast.endFailed'), err?.message || t('common.tryAgain'), 'error');
    }
  };

  const updateParticipantProfile = async (newName: string, newAvatar: string) => {
    if (!currentRoom.value) return;
    authStore.updateProfile(newName, newAvatar);
    if (!authStore.uid) return;
    try {
      // The server updates the record and announces participants' changes (the researcher and observers stay invisible)
      await updateRoomProfile(currentRoom.value.roomId, newName, newAvatar);
    } catch (e) {
      console.error(e);
    }
  };

  const updateRoomInfo = async (name: string, emoji: string) => {
    if (!currentRoom.value) return;
    const cleanName = name.trim() || t('room.defaultName');
    const cleanEmoji = emoji.trim() || '💡';
    currentRoom.value.roomName = cleanName;
    currentRoom.value.roomEmoji = cleanEmoji;

    try {
      // Applied and announced by the server (system messages are server-only)
      const saved = await updateStudyRoomDetails(currentRoom.value.roomId, cleanName, cleanEmoji);
      session.upsertMyRoomIndex(currentRoom.value.roomId, { ...saved, updatedAt: Date.now() });
    } catch (err) {
      console.error('Failed to update room info in Firestore:', err);
    }
  };

  return {
    currentRoom,
    myStatus,
    isHost,
    canEditRoomDetails,
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
    joinRoom: session.joinRoom,
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
    toggleMessageReaction: messages.toggleMessageReaction,
    votePollOption: messages.votePollOption,
    addCustomPollOption: messages.addCustomPollOption,

    createBoard: whiteboard.createBoard,
    deleteEmptyDraft: whiteboard.deleteEmptyDraft,
    setBoardPrivacy: whiteboard.setBoardPrivacy,
    updateBoardThumbnail: whiteboard.updateBoardThumbnail,
    markBoardMigrated: whiteboard.markBoardMigrated,
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
