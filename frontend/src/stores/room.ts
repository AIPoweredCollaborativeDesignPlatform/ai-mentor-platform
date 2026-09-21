import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Participant, MessageItem, RoomData, ParticipantStatus, TypingUser } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';
import { db, isFirebaseConfigured } from '../firebase/config';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  increment,
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
  const isVerifyingAccess = ref(false);
  const toasts = ref<ToastMessage[]>([]);

  // AI Mentor States
  const isAnalyzing = ref(false); // For Gemini Text
  const isGenerating3D = ref(false); // For Meshy 3D Tasks
  const aiStatus = ref<'idle' | 'analyzing' | 'generating_asset' | 'cooldown' | 'error'>('idle');
  const aiStatusDetail = ref<string>('Ready');
  const generating3DStatus = ref<string>('');
  const aiCooldownRemaining = ref<number>(0);
  const lastAiCallTime = ref<number>(0);
  const typingUsers = ref<TypingUser[]>([]);

  let typingTimeout: any = null;
  let cooldownTimer: any = null;

  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { isOnline.value = true; });
    window.addEventListener('offline', () => { isOnline.value = false; });
  }

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
    currentRoom.value = null;
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
    let isInitialParticipantsLoad = true;
    const notifiedPending = new Set<string>();
    
    const partCol = collection(db, 'rooms', roomId, 'participants');
    const unsubPart = onSnapshot(partCol, (snapshot) => {
      const parts: Record<string, Participant> = {};
      const oldParts = currentRoom.value ? { ...currentRoom.value.participants } : {};

      snapshot.forEach(d => {
        const p = d.data() as Participant;
        if (p.status !== 'cancelled') {
          parts[p.uid] = p;
        }
        if (p.uid === authStore.uid) {
          myStatus.value = p.status;
        }
      });

      // Presence & Status Toasts for other users
      if (!isInitialParticipantsLoad && myStatus.value === 'approved' && currentRoom.value) {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added' || change.type === 'modified') {
            const p = change.doc.data() as Participant;
            if (p.uid !== authStore.uid && p.status !== 'pending') {
              const old = oldParts[p.uid];
              if (old) {
                if (!old.isOnline && p.isOnline) {
                  pushToast('Participant Joined', `${p.displayName} is back online`, 'info');
                } else if (old.isOnline && !p.isOnline) {
                  pushToast('Participant Left', `${p.displayName} went offline`, 'info');
                } else if (old.status === 'approved' && p.status === 'kicked') {
                  pushToast('Participant Removed', `${p.displayName} was removed by host`, 'warning');
                }
              } else if (p.status === 'approved' && change.type === 'added') {
                pushToast('Participant Joined', `${p.displayName} joined the meeting`, 'info');
              }
            }
          }
        });
      }

      if (!currentRoom.value) {
        currentRoom.value = {
          roomId,
          pin: roomId.replace('room_', ''),
          hostUid: '',
          createdAt: Date.now(),
          roomStatus: 'active',
          mentorConfig: { ...mentorStore.config },
          participants: parts,
          messages: []
        };
      } else {
        currentRoom.value.participants = parts;
      }

      // Alert host for new join requests, or recent ones on initial load
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          const p = change.doc.data() as Participant;
          if (isHost.value && p.status === 'pending' && p.uid !== authStore.uid) {
            if (!notifiedPending.has(p.uid)) {
              notifiedPending.add(p.uid);
              
              const isRecent = p.joinedAt ? (Date.now() - p.joinedAt < 10 * 60 * 1000) : false;
              if (!isInitialParticipantsLoad || isRecent) {
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
            }
          } else if (p.status !== 'pending') {
            notifiedPending.delete(p.uid);
          }
        }
      });
      isInitialParticipantsLoad = false;
      
      // Update local cache for Dashboard
      if (currentRoom.value) saveToStorage(currentRoom.value);
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
      // Retain pending local messages (user or AI) that have not yet synced to Firestore
      const pendingLocal = (currentRoom.value.messages || []).filter(
        local => !msgs.some(m => m.id === local.id || (m.senderUid === local.senderUid && Math.abs(m.timestamp - local.timestamp) < 3000))
      );
      currentRoom.value.messages = [...msgs, ...pendingLocal];
      
      // Update local cache for Dashboard
      saveToStorage(currentRoom.value);
    });
    unsubs.push(unsubMsg);

    // 4. Typing presence listener
    const typingCol = collection(db, 'rooms', roomId, 'typing');
    const unsubTyping = onSnapshot(typingCol, (snapshot) => {
      const active: TypingUser[] = [];
      const now = Date.now();
      snapshot.forEach(d => {
        const t = d.data() as TypingUser;
        // Don't show self, and ignore stale typing (> 5s)
        if (t.uid !== authStore.uid && (now - t.timestamp < 5000)) {
          active.push(t);
        }
      });
      typingUsers.value = active;
    });
    unsubs.push(unsubTyping);
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
    // Fetch current participant doc if it exists to preserve host status
    let isUserHost = false;
    let currentStatus: ParticipantStatus = 'pending';
    if (db) {
      try {
        const snap = await getDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid));
        if (snap.exists()) {
          const data = snap.data() as Participant;
          isUserHost = data.isHost || false;
          currentStatus = data.status || 'pending';
          if (isUserHost) {
            currentStatus = 'approved';
          }
        }
      } catch (e) {}
    }

    const applicant: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: currentStatus,
      isHost: isUserHost,
      isOnline: true,
      joinedAt: Date.now()
    };

    myStatus.value = currentStatus;

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

  // Send Message (Optimistic UI - immediate local rendering)
  const sendMessage = async (text: string) => {
    if (!currentRoom.value || !text.trim()) return;

    await setMyTyping(false);
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const optimisticMsg: MessageItem = {
      id: tempId,
      senderUid: authStore.uid,
      senderName: authStore.displayName,
      senderAvatar: authStore.avatar,
      type: 'text',
      content: text.trim(),
      timestamp: Date.now(),
      status: 'sending'
    };

    // 1. Immediately render in local stream
    currentRoom.value.messages.push(optimisticMsg);

    // 2. Persist to Firestore
    if (db) {
      try {
        const { status, id, ...payload } = optimisticMsg;
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), payload);
        optimisticMsg.status = 'delivered';
      } catch (e) {
        console.warn('[Firestore] sendMessage error:', e);
        optimisticMsg.status = 'failed';
        pushToast('Send Failed', 'Could not sync message to server. Click to retry.', 'error');
      }
    } else {
      optimisticMsg.status = 'delivered';
      saveToStorage(currentRoom.value);
    }

    // Call Mentor Agent
    await triggerMentorAgent(text);
  };

  // Retry sending a previously failed message
  const retrySendMessage = async (msg: MessageItem) => {
    if (!currentRoom.value || !db) return;
    msg.status = 'sending';
    try {
      const { status, id, ...payload } = msg;
      await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), payload);
      msg.status = 'delivered';
      pushToast('Sent', 'Message delivered successfully.', 'success');
    } catch (e) {
      msg.status = 'failed';
      pushToast('Retry Failed', 'Still unable to reach database. Check your network.', 'error');
    }
  };

  // Send File/Attachment Message (Optimistic UI)
  const sendFileMessage = async (
    fileData: { name: string; size: number; type: 'image' | 'video' | 'document'; url: string; mimeType?: string },
    caption = ''
  ) => {
    if (!currentRoom.value) return;

    await setMyTyping(false);
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const optimisticMsg: MessageItem = {
      id: tempId,
      senderUid: authStore.uid,
      senderName: authStore.displayName,
      senderAvatar: authStore.avatar,
      type: 'file',
      content: caption || '',
      timestamp: Date.now(),
      fileData,
      status: 'sending'
    };

    // 1. Immediately render in local stream
    currentRoom.value.messages.push(optimisticMsg);

    // 2. Persist to Firestore
    if (db) {
      try {
        const { status, id, ...payload } = optimisticMsg;
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), payload);
        optimisticMsg.status = 'delivered';
      } catch (e) {
        console.warn('[Firestore] sendFileMessage error:', e);
        optimisticMsg.status = 'failed';
        pushToast('Attachment Error', 'Attachment could not be saved to room database.', 'error');
      }
    } else {
      optimisticMsg.status = 'delivered';
      saveToStorage(currentRoom.value);
    }
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

  const setMyTyping = async (isTyping: boolean) => {
    if (!currentRoom.value || !db || !authStore.uid) return;
    const roomId = currentRoom.value.roomId;
    const typingRef = doc(db, 'rooms', roomId, 'typing', authStore.uid);

    clearTimeout(typingTimeout);
    if (isTyping) {
      try {
        await setDoc(typingRef, {
          uid: authStore.uid,
          displayName: authStore.displayName,
          avatar: authStore.avatar,
          timestamp: Date.now()
        });
        typingTimeout = setTimeout(() => {
          deleteDoc(typingRef).catch(() => {});
        }, 3000);
      } catch {}
    } else {
      try {
        await deleteDoc(typingRef);
      } catch {}
    }
  };

  const cancelJoinRequest = async (pin: string) => {
    const roomId = `room_${pin}`;
    myStatus.value = 'cancelled';
    if (db && authStore.uid) {
      try {
        await deleteDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid));
      } catch {
        try {
          await updateDoc(doc(db, 'rooms', roomId, 'participants', authStore.uid), {
            status: 'cancelled',
            isOnline: false
          });
        } catch {}
      }
    }
  };

  const transferHostOwnership = async (oldUid: string, newUid: string) => {
    if (!currentRoom.value) return;
    const roomId = currentRoom.value.roomId;
    currentRoom.value.hostUid = newUid;

    const newHostParticipant: Participant = {
      uid: newUid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'approved',
      isHost: true,
      isOnline: true,
      joinedAt: Date.now()
    };
    currentRoom.value.participants[newUid] = newHostParticipant;
    delete currentRoom.value.participants[oldUid];

    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', roomId), {
          hostUid: newUid
        });
        await setDoc(doc(db, 'rooms', roomId, 'participants', newUid), newHostParticipant);
        await deleteDoc(doc(db, 'rooms', roomId, 'participants', oldUid)).catch(() => {});
      } catch (e) {
        console.warn('[Host Transfer] failed:', e);
      }
    }
    saveToStorage(currentRoom.value);
  };

  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    const isForced = latestText.toLowerCase().includes('@mentor');

    // If not forced, check sensitivity and throttle: only scan every 5 messages
    if (!isForced) {
      if (mentorStore.config.sensitivity === 'Strict') return;
      const msgCount = currentRoom.value.messages.length;
      if (msgCount % 5 !== 0) {
        return; // Skip autonomous scan to conserve tokens
      }
    }

    // Mutex lock: Prevent concurrent or overlapping AI generations (prevents duplicate 3D API calls)
    if (isAnalyzing.value) {
      if (isForced) {
        pushToast('AI Busy', 'AI Mentor is currently generating another response. Please wait.', 'info');
      }
      return;
    }

    // Cooldown verification (8 seconds)
    const now = Date.now();
    const elapsed = now - lastAiCallTime.value;
    const COOLDOWN_MS = 8000;

    if (elapsed < COOLDOWN_MS) {
      if (isForced) {
        const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        aiStatus.value = 'cooldown';
        aiStatusDetail.value = `Cooling down (${remainingSec}s remaining)`;
        pushToast('AI Cooling Down', `Please wait ${remainingSec}s before requesting AI Mentor again.`, 'warning');
      }
      return;
    }

    const tierName = mentorStore.config.modelTier === 'pro' ? 'Pro' : 'Flash';
    isAnalyzing.value = true;
    if (isForced) {
      isAnalyzing.value = true;
      aiStatus.value = 'analyzing';
      aiStatusDetail.value = `Analyzing with Gemini ${tierName}...`;
      if (db && currentRoom.value) {
        setDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor'), {
          uid: 'ai_mentor',
          displayName: 'AI Mentor',
          avatar: '✨',
          timestamp: Date.now()
        }).catch(() => {});
      }
    }

    const { analyzeDialogueWithGemini } = await import('../services/ai');

    try {
      const response = await analyzeDialogueWithGemini(currentRoom.value.messages, mentorStore.config, isForced);
      if (response.shouldIntervene && response.aiMessage) {
        // Check if Meshy.ai or Tripo3D API key is configured for photorealistic curved 3D models
        const activeEngine = localStorage.getItem('ai_3d_engine') || 'meshy';
        const { getStoredMeshyApiKey, generate3DModelWithMeshy } = await import('../services/meshy');
        const { getStoredTripoApiKey, generate3DModelWithTripo } = await import('../services/tripo');
        const meshyKey = getStoredMeshyApiKey();
        const tripoKey = getStoredTripoApiKey();

        if (response.assetType === 'parametric_3d') {
          const prompt3D = response.assetData?.title || latestText.replace(/@mentor/gi, '').trim();

          // 3D Generation Background Task
          const run3DGeneration = async () => {
            if (isGenerating3D.value) {
              pushToast('AI Busy', 'A 3D model is already being generated.', 'info');
              return;
            }
            
            isGenerating3D.value = true;
            generating3DStatus.value = 'Initializing 3D generation...';
            
            let heartbeatInterval = setInterval(() => {
              if (db && currentRoom.value && isGenerating3D.value) {
                setDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor_3d'), {
                  uid: 'ai_mentor_3d',
                  displayName: 'AI Mentor (3D)',
                  avatar: '🎨',
                  timestamp: Date.now()
                }).catch(() => {});
              } else {
                clearInterval(heartbeatInterval);
              }
            }, 4000);
            
            try {
              const { reHostGlbToFirebaseStorage, isFirebaseStorageUrl, isBlobUrl } = await import('../services/glbProxy');

              if ((activeEngine === 'meshy' && meshyKey) || (!tripoKey && meshyKey)) {
                generating3DStatus.value = 'Generating 3D model via Meshy AI...';
                const meshyRes = await generate3DModelWithMeshy(prompt3D, meshyKey, (status) => {
                  generating3DStatus.value = status;
                });
                if (meshyRes.success && meshyRes.modelUrl) {
                  mentorStore.recordCheckpoint(
                    currentRoom.value?.messages.length || 0,
                    'Meshy AI Textured Mesh',
                    90
                  );

                  // Re-host GLB for CORS-safe WebGL loading
                  // Priority: Firebase Storage URL (permanent) > Original Meshy URL (poster only)
                  // Blob URLs are NOT stored in Firestore — they're session-only
                  let storedModelUrl = meshyRes.modelUrl;  // what gets saved to Firestore
                  let isStoredInteractive = false;

                  if (!isFirebaseStorageUrl(meshyRes.modelUrl) && meshyRes.taskId) {
                    const proxyRes = await reHostGlbToFirebaseStorage(
                      meshyRes.modelUrl,
                      meshyRes.taskId,
                      (status) => { generating3DStatus.value = status; }
                    );
                    if (proxyRes.success && proxyRes.firebaseUrl && proxyRes.isPermanent) {
                      // Got a permanent Firebase Storage URL — safe to store in Firestore
                      storedModelUrl = proxyRes.firebaseUrl;
                      isStoredInteractive = true;
                    } else if (proxyRes.success && proxyRes.firebaseUrl && isBlobUrl(proxyRes.firebaseUrl)) {
                      // Got a session-only Blob URL — don't store it; keep original for Firestore
                      // The current user will see interactive 3D via the blob URL in memory
                      // (The GLB component will handle this on the next render)
                      console.info('[room.ts] Blob URL obtained for current session; Meshy URL stored for Firestore.');
                    } else {
                      console.warn('[room.ts] GLB proxy failed, using original URL:', proxyRes.error);
                    }
                  }

                  await addAiMessage(
                    `${response.aiMessage}\n(Generated using Meshy AI text-to-3d neural engine)`,
                    'mesh_3d',
                    {
                      title: prompt3D,
                      provider: 'Meshy.ai v2 Text-to-3D',
                      taskId: meshyRes.taskId,
                      modelUrl: storedModelUrl,
                      originalModelUrl: meshyRes.modelUrl,
                      posterUrl: meshyRes.thumbnailUrl,
                      isRefined: false,
                      isInteractive: isStoredInteractive
                    }
                  );
                  return;
                }
              }
              
              if ((activeEngine === 'tripo' && tripoKey) || (!meshyKey && tripoKey)) {
                generating3DStatus.value = 'Generating 3D model via Tripo3D...';
                const tripoRes = await generate3DModelWithTripo(prompt3D, tripoKey, (status) => {
                  generating3DStatus.value = status;
                });
                if (tripoRes.success && tripoRes.modelUrl) {
                  mentorStore.recordCheckpoint(
                    currentRoom.value?.messages.length || 0,
                    'Tripo3D Textured Mesh',
                    90
                  );

                  // Re-host GLB for CORS-safe WebGL loading (same logic as Meshy path)
                  let storedModelUrl = tripoRes.modelUrl;
                  let isStoredInteractive = false;

                  if (!isFirebaseStorageUrl(tripoRes.modelUrl) && tripoRes.taskId) {
                    const proxyRes = await reHostGlbToFirebaseStorage(
                      tripoRes.modelUrl,
                      tripoRes.taskId,
                      (status) => { generating3DStatus.value = status; }
                    );
                    if (proxyRes.success && proxyRes.firebaseUrl && proxyRes.isPermanent) {
                      storedModelUrl = proxyRes.firebaseUrl;
                      isStoredInteractive = true;
                    } else if (proxyRes.success && proxyRes.firebaseUrl && isBlobUrl(proxyRes.firebaseUrl)) {
                      console.info('[room.ts] Blob URL for Tripo3D (session-only); Tripo URL stored for Firestore.');
                    } else {
                      console.warn('[room.ts] Tripo GLB proxy failed:', proxyRes.error);
                    }
                  }

                  await addAiMessage(
                    `${response.aiMessage}\n(Generated using Tripo3D neural engine)`,
                    'mesh_3d',
                    {
                      title: prompt3D,
                      provider: 'Tripo3D API',
                      taskId: tripoRes.taskId,
                      modelUrl: storedModelUrl,
                      originalModelUrl: tripoRes.modelUrl,
                      isRefined: false,
                      isInteractive: isStoredInteractive
                    }
                  );
                  return;
                }
              }
              
              // Fallback to parametric
              await addAiMessage(response.aiMessage || 'Fallback to parametric 3D structure.', 'parametric_3d', response.assetData);
            } catch (err: any) {
              console.warn('[3D Generation] Error:', err);
              await addAiMessage(response.aiMessage || 'Error generating 3D model, falling back to basic parametric 3D structure.', 'parametric_3d', response.assetData);
            } finally {
              isGenerating3D.value = false;
              generating3DStatus.value = '';
              if (db && currentRoom.value) {
                deleteDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor_3d')).catch(() => {});
              }
            }
          };

          // Fire and forget
          run3DGeneration();
        } else if (response.assetType === 'moodboard') {
          mentorStore.recordCheckpoint(currentRoom.value.messages.length, 'Generated Moodboard', 60);
          await addAiMessage(response.aiMessage || '', 'moodboard', response.assetData);
        } else if (response.assetType === 'summary') {
          mentorStore.recordCheckpoint(currentRoom.value.messages.length, 'Meeting Checkpoint Summary', 75);
          await addAiMessage(response.aiMessage || '', 'summary', response.assetData);
        } else if (response.assetType === 'fact_check') {
          mentorStore.recordCheckpoint(currentRoom.value.messages.length, 'Fact Check Verification', 50);
          await addAiMessage(response.aiMessage || '', 'fact_check', response.assetData);
        } else {
          mentorStore.recordCheckpoint(currentRoom.value.messages.length, 'Consensus guidance', 75);
          await addAiMessage(response.aiMessage || '', null);
        }
        aiStatus.value = 'idle';
        aiStatusDetail.value = `Ready (${tierName})`;
      } else {
        aiStatus.value = 'idle';
        aiStatusDetail.value = `Ready (${tierName})`;
      }
    } catch (e: any) {
      console.error('[AI] Agent error:', e);
      if (isForced) {
        aiStatus.value = 'error';
        aiStatusDetail.value = e?.message ? e.message.slice(0, 100) : 'Generation failed';
        pushToast('AI Mentor Error', aiStatusDetail.value, 'error');
      }
    } finally {
      isAnalyzing.value = false;
      lastAiCallTime.value = Date.now();
      aiCooldownRemaining.value = 8;
      aiStatus.value = 'cooldown';

      // Clear AI typing indicator
      if (db && currentRoom.value) {
        deleteDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor')).catch(() => {});
      }

      clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => {
        aiCooldownRemaining.value--;
        if (aiCooldownRemaining.value <= 0) {
          clearInterval(cooldownTimer);
          aiStatus.value = 'idle';
          aiStatusDetail.value = `Ready (${mentorStore.config.modelTier === 'pro' ? 'Pro' : 'Flash'})`;
        } else {
          aiStatusDetail.value = `Cooling down (${aiCooldownRemaining.value}s)`;
        }
      }, 1000);
    }
  };

  const addAiMessage = async (content: string, assetType?: any, assetPayload?: any) => {
    if (!currentRoom.value) return;
    const localId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const aiMsg: MessageItem = {
      id: localId,
      senderUid: 'ai_mentor',
      senderName: 'AI Mentor',
      senderAvatar: '✨',
      type: assetType ? 'ai_asset' : 'text',
      content,
      timestamp: Date.now(),
      assetType,
      assetPayload,
      status: 'delivered'
    };

    // 1. Immediately push locally so AI response appears in real time without refresh!
    currentRoom.value.messages.push(aiMsg);

    if (db) {
      try {
        const { id, status, ...payload } = aiMsg;
        const docRef = await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), payload);
        aiMsg.id = docRef.id;
        if (assetType) {
          await updateDoc(doc(db, 'rooms', currentRoom.value.roomId), {
            assetsCount: increment(1)
          });
        }
      } catch (e) {
        console.warn('[AI Message] Firestore addDoc failed:', e);
      }
    } else {
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

  // Refine & Colorize Meshy Model (Texturing)
  const refineMeshyModel = async (originalMsg: MessageItem, texturePrompt = '') => {
    if (!currentRoom.value || !originalMsg.assetPayload?.taskId) {
      pushToast('Cannot Refine', 'No valid Meshy task ID associated with this model.', 'warning');
      return;
    }

    if (isGenerating3D.value) {
      pushToast('AI Busy', 'Another 3D generation is currently in progress.', 'info');
      return;
    }

    const { getStoredMeshyApiKey, refineAndColorizeModelWithMeshy } = await import('../services/meshy');
    const meshyKey = getStoredMeshyApiKey();
    if (!meshyKey) {
      pushToast('Key Required', 'Please configure your Meshy API Key in Host Controls.', 'warning');
      return;
    }

    isGenerating3D.value = true;
    generating3DStatus.value = 'Refining & colorizing 3D model with Meshy...';

    if (db && currentRoom.value) {
      setDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor_3d'), {
        uid: 'ai_mentor_3d',
        displayName: 'AI Mentor (3D)',
        avatar: '🎨',
        timestamp: Date.now()
      }).catch(() => {});
    }

    let heartbeatInterval = setInterval(() => {
      if (db && currentRoom.value && isGenerating3D.value) {
        setDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor_3d'), {
          uid: 'ai_mentor_3d',
          displayName: 'AI Mentor (3D)',
          avatar: '🎨',
          timestamp: Date.now()
        }).catch(() => {});
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 4000);

    try {
      const res = await refineAndColorizeModelWithMeshy(
        originalMsg.assetPayload.taskId,
        texturePrompt || originalMsg.assetPayload.title || 'high quality realistic pbr textures',
        meshyKey,
        (status) => {
          generating3DStatus.value = status;
        }
      );

      if (res.success && res.modelUrl) {
        await addAiMessage(
          `✨ 我已經為「${originalMsg.assetPayload.title}」完成了全彩高解析 PBR 材質上色與精緻化！`,
          'mesh_3d',
          {
            title: `${originalMsg.assetPayload.title} (Colored / PBR)`,
            provider: 'Meshy.ai v2 Refine Engine',
            taskId: res.taskId,
            modelUrl: res.modelUrl,
            posterUrl: res.thumbnailUrl,
            isRefined: true
          }
        );
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
      if (db && currentRoom.value) {
        deleteDoc(doc(db, 'rooms', currentRoom.value.roomId, 'typing', 'ai_mentor_3d')).catch(() => {});
      }
    }
  };


  return {
    currentRoom,
    myStatus,
    isHost,
    isOnline,
    toasts,
    isAnalyzing,
    aiStatus,
    aiStatusDetail,
    isGenerating3D,
    generating3DStatus,
    aiCooldownRemaining,
    typingUsers,
    approvedParticipants,
    pendingParticipants,
    checkRoomExists,
    createRoom,
    applyToJoin,
    reapplyToJoin,
    cancelJoinRequest,
    transferHostOwnership,
    setMyTyping,
    approveParticipant,
    rejectParticipant,
    muteParticipant,
    kickParticipant,
    leaveRoom,
    endMeetingForAll,
    updateParticipantProfile,
    sendMessage,
    retrySendMessage,
    sendFileMessage,
    refineMeshyModel,
    addAiMessage,
    pushToast,
    removeToast,
    startFirestoreListener,
    stopListening,
    syncMentorConfig
  };
});
