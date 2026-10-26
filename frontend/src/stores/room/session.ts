import { ref } from 'vue';
import {
  arrayUnion,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  type Unsubscribe
} from 'firebase/firestore';
import { db } from '../../firebase/config';
import { currentLocale } from '../../i18n';
import type { MessageItem, Participant, ParticipantStatus, RoomData, TypingUser } from '../../types';
import { roomCollection, roomDocRef, roomRef, type RoomContext } from './context';

const HEARTBEAT_MS = 10000;
const PRESENCE_SWEEP_MS = 5000;
const STALE_PRESENCE_MS = 25000;
const STALE_TYPING_MS = 5000;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Room lifecycle: listeners, presence, joining, host actions and typing indicators. */
export function useRoomSession(ctx: RoomContext) {
  const { currentRoom, myStatus, isHost, authStore, mentorStore, pushToast } = ctx;

  const typingUsers = ref<TypingUser[]>([]);
  let unsubs: Unsubscribe[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let presenceSweepTimer: ReturnType<typeof setInterval> | null = null;

  const participantRef = (uid: string) => roomDocRef(currentRoom.value!.roomId, 'participants', uid);

  // Mirror of the room in users/{uid}/rooms so the Dashboard can list it
  const upsertMyRoomIndex = (roomId: string, fields: Record<string, any>) => {
    if (!authStore.uid) return;
    setDoc(doc(db, 'users', authStore.uid, 'rooms', roomId), fields, { merge: true }).catch(() => {});
  };

  // ---------- Presence ----------
  const sendHeartbeat = async () => {
    if (!authStore.uid || !currentRoom.value) return;
    try {
      await updateDoc(participantRef(authStore.uid), { isOnline: true, lastSeen: Date.now() });
    } catch {}
  };

  // Mark others offline when their heartbeat lapses; also drop stale typing indicators
  const checkStaleParticipants = () => {
    if (!currentRoom.value) return;
    const now = Date.now();
    Object.values(currentRoom.value.participants).forEach(p => {
      if (p.uid === authStore.uid || p.status !== 'approved' || p.isOnline === false) return;
      if (p.lastSeen && now - p.lastSeen > STALE_PRESENCE_MS) {
        p.isOnline = false;
        updateDoc(participantRef(p.uid), { isOnline: false }).catch(() => {});
      }
    });
    typingUsers.value = typingUsers.value.filter(u => now - u.timestamp < STALE_TYPING_MS);
  };

  const stopListening = () => {
    unsubs.forEach(u => u());
    unsubs = [];
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (presenceSweepTimer) clearInterval(presenceSweepTimer);
    heartbeatTimer = presenceSweepTimer = null;
    currentRoom.value = null;
  };

  const checkRoomExists = async (pin: string): Promise<{ exists: boolean; roomName?: string }> => {
    // Without a ready auth token the rules return permission-denied, which looks like "room not found"
    await authStore.waitForAuthReady().catch(() => {});
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const snap = await getDoc(roomRef(`room_${pin}`));
        if (snap.exists()) {
          const data = snap.data() as RoomData;
          return (data as any).deletedAt ? { exists: false } : { exists: true, roomName: data.roomName };
        }
        // Missing doc: retry once quickly in case the token handshake was still in flight
        if (attempt >= 2) break;
        await sleep(300);
      } catch (e: any) {
        console.warn(`checkRoomExists attempt ${attempt} failed:`, e?.code || e);
        if (attempt < 3) await sleep(attempt * 350);
      }
    }
    return { exists: false };
  };

  // ---------- Real-time listeners ----------
  const startFirestoreListener = (roomId: string) => {
    stopListening();

    // 1. Room document
    unsubs.push(onSnapshot(roomRef(roomId), snapshot => {
      if (!snapshot.exists()) return;
      const data = snapshot.data() as RoomData;
      if (!currentRoom.value) {
        currentRoom.value = { ...data, participants: {}, messages: [] };
      } else {
        Object.assign(currentRoom.value, {
          hostUid: data.hostUid,
          pin: data.pin,
          roomName: data.roomName,
          roomEmoji: data.roomEmoji,
          mentorConfig: data.mentorConfig,
          roomStatus: data.roomStatus,
          whiteboardActive: data.whiteboardActive ?? false,
          whiteboardHostUid: data.whiteboardHostUid || undefined,
          whiteboardHostName: data.whiteboardHostName || undefined,
          whiteboardState: data.whiteboardState || undefined,
          whiteboardThumbnail: data.whiteboardThumbnail || undefined,
          aiActiveTask: data.aiActiveTask ?? null,
          ai: data.ai,
          language: data.language
        });
      }
      if (data.mentorConfig) mentorStore.config = data.mentorConfig;
      upsertMyRoomIndex(roomId, {
        roomId,
        pin: data.pin || roomId.replace('room_', ''),
        roomName: data.roomName || `Meeting (${data.pin})`,
        roomEmoji: data.roomEmoji || '💡',
        hostUid: data.hostUid,
        lastActive: (data as any).lastActive || data.createdAt || Date.now(),
        updatedAt: Date.now()
      });
    }));

    // 2. Participants
    let isInitialLoad = true;
    let myApprovedAt = 0;
    const notifiedPending = new Set<string>();

    unsubs.push(onSnapshot(roomCollection(roomId, 'participants'), snapshot => {
      const parts: Record<string, Participant> = {};
      const oldParts = currentRoom.value ? { ...currentRoom.value.participants } : {};
      const now = Date.now();

      snapshot.forEach(d => {
        const p = d.data() as Participant;
        if (p.status !== 'cancelled') {
          if (p.uid !== authStore.uid && p.lastSeen && now - p.lastSeen > STALE_PRESENCE_MS) p.isOnline = false;
          parts[p.uid] = p;
        }
        if (p.uid === authStore.uid) {
          if (p.status === 'approved' && myStatus.value !== 'approved' && !myApprovedAt) myApprovedAt = Date.now();
          myStatus.value = p.status;
        }
      });

      // Presence toasts about other members (only after the initial load)
      if (!isInitialLoad && myStatus.value === 'approved' && currentRoom.value) {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'removed') return;
          const p = change.doc.data() as Participant;
          if (p.uid === authStore.uid || p.status === 'pending') return;
          const old = oldParts[p.uid];
          if (old) {
            if (!old.isOnline && p.isOnline) pushToast('Participant Joined', `${p.displayName} is back online`, 'info');
            else if (old.isOnline && !p.isOnline) pushToast('Participant Left', `${p.displayName} went offline`, 'info');
            else if (old.status === 'approved' && p.status === 'kicked') pushToast('Participant Removed', `${p.displayName} was removed by host`, 'warning');
          } else if (p.status === 'approved' && change.type === 'added') {
            const joinedAt = p.joinedAt || 0;
            if (myApprovedAt && joinedAt >= myApprovedAt - 2000 && now - joinedAt < 20000) {
              pushToast('Participant Joined', `${p.displayName} joined the meeting`, 'info');
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

      // Host: actionable toast for new (or recent, on first load) join requests
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') return;
        const p = change.doc.data() as Participant;
        if (p.status !== 'pending') {
          notifiedPending.delete(p.uid);
          return;
        }
        if (!isHost.value || p.uid === authStore.uid || notifiedPending.has(p.uid)) return;
        notifiedPending.add(p.uid);
        const isRecent = p.joinedAt ? Date.now() - p.joinedAt < 10 * 60 * 1000 : false;
        if (!isInitialLoad || isRecent) {
          pushToast('New join request', `${p.displayName} is waiting for approval`, 'info', [
            { label: 'Approve', type: 'primary', onClick: () => approveParticipant(p.uid) },
            { label: 'Decline', type: 'danger', onClick: () => rejectParticipant(p.uid) }
          ]);
        }
      });
      isInitialLoad = false;
    }));

    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    presenceSweepTimer = setInterval(checkStaleParticipants, PRESENCE_SWEEP_MS);

    // 3. Messages (keeps optimistic local messages until their server copy arrives)
    unsubs.push(onSnapshot(query(roomCollection(roomId, 'messages'), orderBy('timestamp', 'asc')), snapshot => {
      if (!currentRoom.value) return;
      const msgs: MessageItem[] = snapshot.docs.map(d => ({ id: d.id, ...d.data() }) as MessageItem);
      const pendingLocal = (currentRoom.value.messages || []).filter(
        local => !msgs.some(m => m.id === local.id || (m.senderUid === local.senderUid && Math.abs(m.timestamp - local.timestamp) < 3000))
      );
      currentRoom.value.messages = [...msgs, ...pendingLocal].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }));

    // 4. Typing indicators (excluding self and stale entries)
    unsubs.push(onSnapshot(roomCollection(roomId, 'typing'), snapshot => {
      const now = Date.now();
      typingUsers.value = snapshot.docs
        .map(d => d.data() as TypingUser)
        .filter(t => t.uid !== authStore.uid && now - t.timestamp < STALE_TYPING_MS)
        .sort((a, b) => a.uid.localeCompare(b.uid));
    }));
  };

  // ---------- Typing ----------
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastTypingTime = 0;

  const setMyTyping = async (isTyping: boolean) => {
    if (!currentRoom.value || !authStore.uid) return;
    const typingRef = roomDocRef(currentRoom.value.roomId, 'typing', authStore.uid);
    const scheduleClear = () => {
      typingTimeout = setTimeout(() => deleteDoc(typingRef).catch(() => {}), 3000);
    };

    clearTimeout(typingTimeout);
    if (!isTyping) {
      lastTypingTime = 0;
      await deleteDoc(typingRef).catch(() => {});
      return;
    }
    // Throttle Firestore writes: within 2s just extend the auto-clear timer
    if (Date.now() - lastTypingTime < 2000) {
      scheduleClear();
      return;
    }
    lastTypingTime = Date.now();
    try {
      await setDoc(typingRef, {
        uid: authStore.uid,
        displayName: authStore.displayName,
        avatar: authStore.avatar,
        timestamp: Date.now()
      });
      scheduleClear();
    } catch {}
  };

  // ---------- Create / join ----------
  const createRoom = async (roomName?: string, roomEmoji?: string) => {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const roomId = `room_${pin}`;
    const selectedEmoji = roomEmoji?.trim() || '💡';
    const displayRoomName = roomName?.trim() || `Meeting ${pin}`;
    const hostUser: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'approved',
      isHost: true,
      isOnline: true,
      joinedAt: Date.now()
    };
    const createdMsg: MessageItem = {
      id: `msg_${Date.now()}`,
      senderUid: 'system',
      senderName: 'System',
      senderAvatar: '🏛️',
      type: 'text',
      content: `${selectedEmoji} Room "${displayRoomName}" created · PIN: ${pin}`,
      timestamp: Date.now()
    };
    const newRoom: RoomData = {
      roomId,
      pin,
      roomName: displayRoomName,
      roomEmoji: selectedEmoji,
      hostUid: authStore.uid,
      createdAt: Date.now(),
      roomStatus: 'active',
      mentorConfig: { ...mentorStore.config },
      participants: { [authStore.uid]: hostUser },
      messages: [createdMsg]
    };

    currentRoom.value = newRoom;
    myStatus.value = 'approved';

    try {
      await setDoc(roomRef(roomId), {
        roomId,
        pin,
        roomName: displayRoomName,
        roomEmoji: selectedEmoji,
        hostUid: authStore.uid,
        participantUids: [authStore.uid],
        createdAt: Date.now(),
        lastActive: Date.now(),
        roomStatus: 'active',
        mentorConfig: mentorStore.config,
        assetsCount: 0,
        // Distinguishes rooms created by this redesign from the legacy site sharing the same database
        appVersion: __APP_VERSION__,
        // Language of AI replies in this room
        language: currentLocale.value
      });
      await setDoc(roomDocRef(roomId, 'participants', authStore.uid), hostUser);
      const { id, ...msgPayload } = createdMsg;
      await setDoc(roomDocRef(roomId, 'messages', id), msgPayload);
      upsertMyRoomIndex(roomId, {
        roomId,
        pin,
        roomName: displayRoomName,
        roomEmoji: selectedEmoji,
        hostUid: authStore.uid,
        role: 'host',
        createdAt: Date.now(),
        lastActive: Date.now()
      });
      startFirestoreListener(roomId);
    } catch (err) {
      console.warn('[Firestore] createRoom error:', err);
    }
    return newRoom;
  };

  const writeApplication = async (roomId: string, applicant: Participant) => {
    startFirestoreListener(roomId);
    await setDoc(roomDocRef(roomId, 'participants', authStore.uid), applicant);
    updateDoc(roomRef(roomId), { participantUids: arrayUnion(authStore.uid), lastActive: Date.now() }).catch(() => {});
  };

  const makeApplicant = (status: ParticipantStatus, isHostFlag: boolean): Participant => ({
    uid: authStore.uid,
    displayName: authStore.displayName,
    avatar: authStore.avatar,
    status,
    isHost: isHostFlag,
    isOnline: true,
    joinedAt: Date.now()
  });

  // Enter the waiting room (or straight in, if already approved / host)
  const applyToJoin = async (pin: string) => {
    const roomInfo = await checkRoomExists(pin);
    if (!roomInfo.exists) throw new Error('Room not found');

    const roomId = `room_${pin}`;
    let isUserHost = false;
    let currentStatus: ParticipantStatus = 'pending';
    try {
      const snap = await getDoc(roomDocRef(roomId, 'participants', authStore.uid));
      if (snap.exists()) {
        const data = snap.data() as Participant;
        isUserHost = data.isHost || false;
        currentStatus = isUserHost ? 'approved' : data.status || 'pending';
      }
    } catch {}

    myStatus.value = currentStatus;
    try {
      await writeApplication(roomId, makeApplicant(currentStatus, isUserHost));
      upsertMyRoomIndex(roomId, {
        roomId,
        pin,
        roomName: roomInfo.roomName || `Meeting ${pin}`,
        role: isUserHost ? 'host' : 'participant',
        joinedAt: Date.now(),
        lastActive: Date.now()
      });
    } catch (err) {
      console.warn('[Firestore] applyToJoin error:', err);
    }
  };

  // Re-apply after being kicked or rejected
  const reapplyToJoin = async (pin: string) => {
    myStatus.value = 'pending';
    const roomInfo = await checkRoomExists(pin);
    if (!roomInfo.exists || !authStore.uid) return;
    try {
      await writeApplication(`room_${pin}`, makeApplicant('pending', false));
    } catch (err) {
      console.warn('[Firestore] reapplyToJoin error:', err);
    }
  };

  const cancelJoinRequest = async (pin: string) => {
    myStatus.value = 'cancelled';
    if (!authStore.uid) return;
    const ref = roomDocRef(`room_${pin}`, 'participants', authStore.uid);
    try {
      await deleteDoc(ref);
    } catch {
      await updateDoc(ref, { status: 'cancelled', isOnline: false }).catch(() => {});
    }
  };

  // ---------- Host actions ----------
  const updateParticipant = async (uid: string, fields: Partial<Participant>, label: string) => {
    try {
      await updateDoc(participantRef(uid), fields);
    } catch (err) {
      console.error(`[Firestore] ${label} error:`, err);
    }
  };

  const hostGuard = () => Boolean(currentRoom.value && isHost.value);

  const approveParticipant = async (uid: string) => {
    if (!hostGuard()) return;
    await updateParticipant(uid, { status: 'approved', isOnline: true }, 'approve');
    pushToast('Member approved', 'The participant has been granted access', 'success');
  };

  const rejectParticipant = async (uid: string) => {
    if (!hostGuard()) return;
    await updateParticipant(uid, { status: 'rejected' }, 'reject');
    pushToast('Request declined', 'The join request has been declined', 'warning');
  };

  const muteParticipant = async (uid: string, muted: boolean) => {
    if (hostGuard()) await updateParticipant(uid, { isMuted: muted }, 'mute');
  };

  const kickParticipant = async (uid: string) => {
    if (hostGuard()) await updateParticipant(uid, { status: 'kicked' }, 'kick');
  };

  const syncMentorConfig = async () => {
    if (!hostGuard()) return;
    await updateDoc(roomRef(currentRoom.value!.roomId), { mentorConfig: mentorStore.config }).catch(console.warn);
  };

  const transferHostOwnership = async (oldUid: string, newUid: string) => {
    if (!currentRoom.value) return;
    const roomId = currentRoom.value.roomId;
    const newHost: Participant = {
      uid: newUid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'approved',
      isHost: true,
      isOnline: true,
      joinedAt: Date.now()
    };
    currentRoom.value.hostUid = newUid;
    currentRoom.value.participants[newUid] = newHost;
    delete currentRoom.value.participants[oldUid];
    try {
      await updateDoc(roomRef(roomId), { hostUid: newUid });
      await setDoc(roomDocRef(roomId, 'participants', newUid), newHost);
      await deleteDoc(roomDocRef(roomId, 'participants', oldUid)).catch(() => {});
    } catch (e) {
      console.warn('[Host Transfer] failed:', e);
    }
  };

  // ---------- Self ----------
  // Goes offline but stays a member of the room
  const leaveRoom = async () => {
    if (!currentRoom.value) return;
    if (authStore.uid) await updateParticipant(authStore.uid, { isOnline: false, activeWhiteboardId: null }, 'leave');
    stopListening();
  };

  const updateParticipantWhiteboard = async (activeWhiteboardId: string | null) => {
    if (!currentRoom.value) return;
    if (authStore.uid) {
      await updateDoc(participantRef(authStore.uid), { activeWhiteboardId: activeWhiteboardId || null, lastSeen: Date.now() })
        .catch(err => console.warn('Failed to update participant whiteboard presence:', err));
    }
    const me = currentRoom.value?.participants[authStore.uid];
    if (me) me.activeWhiteboardId = activeWhiteboardId || null;
  };

  return {
    typingUsers,
    sendHeartbeat,
    stopListening,
    checkRoomExists,
    startFirestoreListener,
    setMyTyping,
    createRoom,
    applyToJoin,
    reapplyToJoin,
    cancelJoinRequest,
    approveParticipant,
    rejectParticipant,
    muteParticipant,
    kickParticipant,
    syncMentorConfig,
    transferHostOwnership,
    leaveRoom,
    updateParticipantWhiteboard,
    upsertMyRoomIndex
  };
}
