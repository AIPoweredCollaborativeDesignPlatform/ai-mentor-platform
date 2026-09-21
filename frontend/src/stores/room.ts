import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Participant, MessageItem, RoomData, ParticipantStatus } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';
import { db, isFirebaseConfigured } from '../firebase/config';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  onSnapshot,
  query,
  orderBy,
  type Unsubscribe
} from 'firebase/firestore';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description: string;
  actions?: { label: string; type?: 'primary' | 'danger'; onClick: () => void }[];
}

export const useRoomStore = defineStore('room', () => {
  const currentRoom = ref<RoomData | null>(null);
  const myStatus = ref<ParticipantStatus>('pending');
  const toasts = ref<ToastMessage[]>([]);
  const isAnalyzing = ref(false);

  const authStore = useAuthStore();
  const mentorStore = useMentorStore();

  let unsubs: Unsubscribe[] = [];

  const isHost = computed(() => {
    return currentRoom.value?.hostUid === authStore.uid;
  });

  const participantsList = computed(() => {
    return currentRoom.value ? Object.values(currentRoom.value.participants) : [];
  });

  const approvedParticipants = computed(() => {
    return participantsList.value.filter(p => p.status === 'approved');
  });

  const pendingParticipants = computed(() => {
    return participantsList.value.filter(p => p.status === 'pending');
  });

  const pushToast = (
    title: string,
    description: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
    actions?: { label: string; type?: 'primary' | 'danger'; onClick: () => void }[]
  ) => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    toasts.value.push({ id, title, description, type, actions });
    // Don't auto-dismiss if there are actions, wait for user interaction
    if (!actions || actions.length === 0) {
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, 6000);
    }
  };

  const removeToast = (id: string) => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  };

  // Detach listeners
  const stopListening = () => {
    unsubs.forEach(u => u());
    unsubs = [];
  };

  const checkRoomExists = async (pin: string): Promise<{ exists: boolean; roomName?: string }> => {
    const roomId = `room_${pin}`;
    if (db) {
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId));
        if (snap.exists()) {
          const data = snap.data() as RoomData;
          return { exists: true, roomName: data.roomName };
        }
      } catch (e) {
        console.warn('checkRoomExists firestore check failed:', e);
      }
    }
    const local = localStorage.getItem(`ai_room_${pin}`);
    if (local) {
      try {
        const data = JSON.parse(local);
        return { exists: true, roomName: data.roomName };
      } catch {}
    }
    return { exists: false };
  };

  // Real-time Firestore Listener for Room, Participants, and Messages
  const startFirestoreListener = (roomId: string) => {
    if (!db) return;
    stopListening();

    // 1. Room Doc listener
    const roomRef = doc(db, 'rooms', roomId);
    const unsubRoom = onSnapshot(roomRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as RoomData;
        if (!currentRoom.value) {
          currentRoom.value = {
            ...data,
            participants: {},
            messages: []
          };
        } else {
          currentRoom.value.hostUid = data.hostUid;
          currentRoom.value.pin = data.pin;
          currentRoom.value.roomName = data.roomName;
          currentRoom.value.mentorConfig = data.mentorConfig;
          currentRoom.value.roomStatus = data.roomStatus;
        }
        if (data.mentorConfig) {
          mentorStore.config = data.mentorConfig;
        }
      }
    });
    unsubs.push(unsubRoom);

    // 2. Participants Collection listener
    const partCol = collection(db, 'rooms', roomId, 'participants');
    const unsubPart = onSnapshot(partCol, (snapshot) => {
      if (!currentRoom.value) return;
      const parts: Record<string, Participant> = {};

      snapshot.forEach(d => {
        const p = d.data() as Participant;
        parts[p.uid] = p;

        // Check my own status
        if (p.uid === authStore.uid) {
          myStatus.value = p.status;
        }

        // Trigger Host Toast for new pending applicants
        if (isHost.value && p.status === 'pending' && !currentRoom.value?.participants[p.uid]) {
          pushToast(
            'New join request',
            `${p.displayName} is waiting for approval`,
            'info',
            [
              { label: 'Approve', type: 'primary', onClick: () => approveParticipant(p.uid) },
              { label: 'Decline', type: 'danger', onClick: () => rejectParticipant(p.uid) }
            ]
          );
        }
      });
      currentRoom.value.participants = parts;
    });
    unsubs.push(unsubPart);

    // Mark current participant online
    if (authStore.uid) {
      updateDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid), {
        isOnline: true
      }).catch(() => {});
    }

    // 3. Messages Collection listener (real-time stream)
    const msgCol = query(collection(db, 'rooms', roomId, 'messages'), orderBy('timestamp', 'asc'));
    const unsubMsg = onSnapshot(msgCol, (snapshot) => {
      if (!currentRoom.value) return;
      const msgs: MessageItem[] = [];
      snapshot.forEach(d => {
        msgs.push({ id: d.id, ...d.data() } as MessageItem);
      });
      currentRoom.value.messages = msgs;
    });
    unsubs.push(unsubMsg);
  };

  // Create room as Host
  const createRoom = async (roomName?: string) => {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const roomId = `room_${pin}`;
    const hostUser: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'approved',
      isHost: true,
      isOnline: true,
      joinedAt: Date.now()
    };

    const displayRoomName = roomName?.trim() || `Meeting ${pin}`;

    const newRoom: RoomData = {
      roomId,
      pin,
      roomName: displayRoomName,
      hostUid: authStore.uid,
      createdAt: Date.now(),
      roomStatus: 'active',
      mentorConfig: { ...mentorStore.config },
      participants: { [authStore.uid]: hostUser },
      messages: [
        {
          id: `msg_${Date.now()}`,
          senderUid: 'system',
          senderName: 'System',
          senderAvatar: '🏛️',
          type: 'text',
          content: `Room "${displayRoomName}" created · PIN: ${pin}`,
          timestamp: Date.now()
        }
      ]
    };

    currentRoom.value = newRoom;
    myStatus.value = 'approved';

    if (db) {
      try {
        await setDoc(doc(db, 'rooms', roomId), {
          roomId,
          pin,
          roomName: displayRoomName,
          hostUid: authStore.uid,
          createdAt: Date.now(),
          roomStatus: 'active',
          mentorConfig: mentorStore.config
        });
        await setDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid), hostUser);
        await addDoc(collection(db, 'rooms', roomId, 'messages'), newRoom.messages[0]);
        startFirestoreListener(roomId);
      } catch (err) {
        console.warn('[Firestore] createRoom fallback:', err);
      }
    }

    saveToStorage(newRoom);
    return newRoom;
  };

  // Join room as Participant (enters Waiting Room)
  const applyToJoin = async (pin: string) => {
    const roomInfo = await checkRoomExists(pin);
    if (!roomInfo.exists) {
      throw new Error('Room not found');
    }

    const roomId = `room_${pin}`;
    const applicant: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'pending', // Waiting Room status
      isHost: false,
      isOnline: true,
      joinedAt: Date.now()
    };

    myStatus.value = 'pending';

    if (db) {
      try {
        startFirestoreListener(roomId);
        await setDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid), applicant);
      } catch (err) {
        console.warn('[Firestore] applyToJoin fallback:', err);
      }
    } else {
      // Local fallback
      const existing = loadFromStorage(pin);
      const room: RoomData = existing || {
        roomId,
        pin,
        roomName: roomInfo.roomName || `Meeting ${pin}`,
        hostUid: 'host_default',
        createdAt: Date.now(),
        roomStatus: 'active',
        mentorConfig: { ...mentorStore.config },
        participants: {},
        messages: []
      };
      room.participants[authStore.uid] = applicant;
      currentRoom.value = room;
      saveToStorage(room);
    }
  };

  // Re-apply to join (after being kicked or rejected)
  const reapplyToJoin = async (pin: string) => {
    return applyToJoin(pin);
  };

  // Host Action: Approve participant
  const approveParticipant = async (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;

    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', uid), {
          status: 'approved',
          isOnline: true
        });
        const participant = currentRoom.value.participants[uid];
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), {
          senderUid: 'system',
          senderName: 'System',
          senderAvatar: '👋',
          type: 'text',
          content: `${participant?.displayName || 'New member'} joined the meeting`,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('[Firestore] approve error:', err);
      }
    } else {
      // Local fallback
      const participant = currentRoom.value.participants[uid];
      if (participant) {
        participant.status = 'approved';
        participant.isOnline = true;
        currentRoom.value.messages.push({
          id: `sys_${Date.now()}`,
          senderUid: 'system',
          senderName: 'System',
          senderAvatar: '👋',
          type: 'text',
          content: `${participant.displayName} joined the meeting`,
          timestamp: Date.now()
        });
        saveToStorage(currentRoom.value);
      }
    }
    pushToast('Member approved', 'The participant has been granted access', 'success');
  };

  // Host Action: Reject participant
  const rejectParticipant = async (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;

    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', uid), {
          status: 'rejected'
        });
      } catch (err) {
        console.error('[Firestore] reject error:', err);
      }
    } else {
      const participant = currentRoom.value.participants[uid];
      if (participant) {
        participant.status = 'rejected';
        saveToStorage(currentRoom.value);
      }
    }
    pushToast('Request declined', 'The join request has been declined', 'warning');
  };

  // Update Mentor Config on Firestore
  const syncMentorConfig = async () => {
    if (!currentRoom.value) return;
    if (db && isHost.value) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId), {
          mentorConfig: mentorStore.config
        });
      } catch (e) {
        console.warn(e);
      }
    }
  };

  // Send Message
  const sendMessage = async (text: string) => {
    if (!currentRoom.value || !text.trim()) return;

    const newMsg: Omit<MessageItem, 'id'> = {
      senderUid: authStore.uid,
      senderName: authStore.displayName,
      senderAvatar: authStore.avatar,
      type: 'text',
      content: text.trim(),
      timestamp: Date.now()
    };

    if (db) {
      try {
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), newMsg);
      } catch (e) {
        console.warn('[Firestore] sendMessage error:', e);
      }
    } else {
      currentRoom.value.messages.push({ id: `msg_${Date.now()}`, ...newMsg });
      saveToStorage(currentRoom.value);
    }

    // Call Mentor Agent
    await triggerMentorAgent(text);
  };

  // Mute Participant (Host Action)
  const muteParticipant = async (uid: string, muted: boolean) => {
    if (!currentRoom.value || !isHost.value) return;
    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', uid), {
          isMuted: muted
        });
      } catch (err) {
        console.error(err);
      }
    } else {
      const p = currentRoom.value.participants[uid];
      if (p) p.isMuted = muted;
      saveToStorage(currentRoom.value);
    }
  };

  // Kick Participant (Host Action)
  const kickParticipant = async (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;
    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', uid), {
          status: 'kicked'
        });
      } catch (err) {
        console.error(err);
      }
    } else {
      const p = currentRoom.value.participants[uid];
      if (p) p.status = 'kicked';
      saveToStorage(currentRoom.value);
    }
  };

  // Leave Room (Sets participant offline, stays member of the room)
  const leaveRoom = async () => {
    if (!currentRoom.value) return;
    if (db && authStore.uid) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', authStore.uid), {
          isOnline: false
        });
      } catch (err) {
        console.error(err);
      }
    } else if (currentRoom.value.participants[authStore.uid]) {
      currentRoom.value.participants[authStore.uid].isOnline = false;
      saveToStorage(currentRoom.value);
    }
    stopListening();
  };

  // End Meeting for All (Host action)
  const endMeetingForAll = async () => {
    if (!currentRoom.value || !isHost.value) return;
    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId), {
          roomStatus: 'ended'
        });
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), {
          senderUid: 'system',
          senderName: 'System',
          senderAvatar: '🛑',
          type: 'text',
          content: 'Meeting has been ended by the host',
          timestamp: Date.now()
        });
      } catch (err) {
        console.error(err);
      }
    } else {
      currentRoom.value.roomStatus = 'ended';
      saveToStorage(currentRoom.value);
    }
    stopListening();
  };

  // Update Participant Profile in Room
  const updateParticipantProfile = async (newName: string, newAvatar: string) => {
    if (!currentRoom.value) return;
    const oldName = currentRoom.value.participants[authStore.uid]?.displayName || authStore.displayName;
    authStore.updateProfile(newName, newAvatar);

    if (db && authStore.uid) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', authStore.uid), {
          displayName: newName,
          avatar: newAvatar
        });
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), {
          senderUid: 'system',
          senderName: 'System',
          senderAvatar: '✏️',
          type: 'text',
          content: `${oldName} updated profile to ${newName} ${newAvatar}`,
          timestamp: Date.now()
        });
      } catch (e) {
        console.error(e);
      }
    } else {
      const p = currentRoom.value.participants[authStore.uid];
      if (p) {
        p.displayName = newName;
        p.avatar = newAvatar;
      }
      currentRoom.value.messages.push({
        id: `sys_${Date.now()}`,
        senderUid: 'system',
        senderName: 'System',
        senderAvatar: '✏️',
        type: 'text',
        content: `${oldName} updated profile to ${newName} ${newAvatar}`,
        timestamp: Date.now()
      });
      saveToStorage(currentRoom.value);
    }
  };

  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    isAnalyzing.value = true;
    
    // Lazy import the AI service to keep bundle clean
    const { analyzeDialogueWithGemini } = await import('../services/ai');
    
    try {
      const isForced = latestText.toLowerCase().includes('@mentor');
      const response = await analyzeDialogueWithGemini(currentRoom.value.messages, mentorStore.config, isForced);
      
      if (response.shouldIntervene && response.aiMessage) {
        await addAiMessage(response.aiMessage, response.assetType, response.assetData);
      }
    } catch (e) {
      console.error('[AI] Agent error:', e);
    } finally {
      isAnalyzing.value = false;
    }
  };

  const addAiMessage = async (content: string, assetType?: any, assetPayload?: any) => {
    if (!currentRoom.value) return;
    const aiMsg: Omit<MessageItem, 'id'> = {
      senderUid: 'ai_mentor',
      senderName: 'AI Mentor',
      senderAvatar: '✨',
      type: assetType ? 'ai_asset' : 'text',
      content,
      timestamp: Date.now(),
      assetType,
      assetPayload
    };

    if (db) {
      try {
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), aiMsg);
      } catch (e) {
        console.warn(e);
      }
    } else {
      currentRoom.value.messages.push({ id: `ai_${Date.now()}`, ...aiMsg });
      saveToStorage(currentRoom.value);
    }
  };

  const saveToStorage = (room: RoomData) => {
    localStorage.setItem(`ai_room_${room.pin}`, JSON.stringify(room));
    localStorage.setItem('ai_last_room_pin', room.pin);
  };

  const loadFromStorage = (pin: string): RoomData | null => {
    const raw = localStorage.getItem(`ai_room_${pin}`);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  };

  return {
    currentRoom,
    myStatus,
    isHost,
    toasts,
    isAnalyzing,
    approvedParticipants,
    pendingParticipants,
    checkRoomExists,
    createRoom,
    applyToJoin,
    reapplyToJoin,
    approveParticipant,
    rejectParticipant,
    muteParticipant,
    kickParticipant,
    leaveRoom,
    endMeetingForAll,
    updateParticipantProfile,
    sendMessage,
    addAiMessage,
    pushToast,
    removeToast,
    startFirestoreListener,
    stopListening,
    syncMentorConfig
  };
});
