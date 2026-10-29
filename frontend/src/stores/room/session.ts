import { ref } from 'vue';
import {
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  type Unsubscribe
} from 'firebase/firestore';
import { db } from '../../firebase/config';
import { currentLocale, t } from '../../i18n';
import type { MessageItem, Participant, RoomData, TypingUser } from '../../types';
import { roomCollection, roomDocRef, roomRef, type RoomContext } from './context';
import { createStudyRoom, joinStudyRoom, peekStudyRoom, type RoomPeek } from '../../services/session';

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

  const checkRoomExists = async (pin: string): Promise<RoomPeek> => {
    // Without a ready auth token the call is rejected, which would look like "room not found"
    await authStore.waitForAuthReady().catch(() => {});
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await peekStudyRoom(`room_${pin}`);
      } catch (e: any) {
        console.warn(`checkRoomExists attempt ${attempt} failed:`, e?.code || e);
        if (attempt < 3) await sleep(attempt * 500);
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
          session: data.session,
          language: data.language
        });
      }
      if (data.mentorConfig) mentorStore.config = data.mentorConfig;
      upsertMyRoomIndex(roomId, {
        roomId,
        pin: data.pin || roomId.replace('room_', ''),
        roomName: data.roomName || t('room.meetingPin', { pin: data.pin }),
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
          // The researcher (host) and observers are invisible to everyone in the room
          if (p.uid === authStore.uid || p.status === 'pending' || p.status === 'observer' || p.uid === currentRoom.value?.hostUid) return;
          const old = oldParts[p.uid];
          if (old) {
            if (!old.isOnline && p.isOnline) pushToast(t('toast.joinedTitle'), t('toast.backOnline', { name: p.displayName }), 'info');
            else if (old.isOnline && !p.isOnline) pushToast(t('toast.leftTitle'), t('toast.wentOffline', { name: p.displayName }), 'info');
            else if (old.status === 'approved' && p.status === 'kicked') pushToast(t('toast.removedTitle'), t('toast.removedText', { name: p.displayName }), 'warning');
          } else if (p.status === 'approved' && change.type === 'added') {
            const joinedAt = p.joinedAt || 0;
            if (myApprovedAt && joinedAt >= myApprovedAt - 2000 && now - joinedAt < 20000) {
              pushToast(t('toast.joinedTitle'), t('toast.joinedText', { name: p.displayName }), 'info');
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
          pushToast(t('toast.requestTitle'), t('toast.requestText', { name: p.displayName }), 'info', [
            { label: t('toast.approve'), type: 'primary', onClick: () => approveParticipant(p.uid) },
            { label: t('toast.decline'), type: 'danger', onClick: () => rejectParticipant(p.uid) }
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
  /**
   * The server picks a random never-used 4-digit PIN and creates the room (functions/src/rooms.js).
   * `asParticipant` (always, except staff who choose): the room has no host; the creator then joins
   * through the waiting room like everyone else. `profileId`: condition chosen at creation (staff only).
   */
  const createRoom = async (roomName?: string, roomEmoji?: string, opts: { asParticipant?: boolean; profileId?: string } = {}) => {
    await authStore.waitForAuthReady().catch(() => {});
    const created = await createStudyRoom({
      roomName: roomName?.trim() || '',
      roomEmoji: roomEmoji?.trim() || '💡',
      language: currentLocale.value,
      mentorConfig: { ...mentorStore.config },
      // Distinguishes rooms created by this redesign from the legacy site sharing the same database
      appVersion: __APP_VERSION__,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      asParticipant: Boolean(opts.asParticipant),
      profileId: opts.profileId || null
    });
    const { roomId, pin } = created;
    // The server decides: only study staff can be a room's (invisible) host; everyone else joins their own room
    if (created.hostUid) {
      myStatus.value = 'approved';
      upsertMyRoomIndex(roomId, {
        roomId,
        pin,
        roomName: created.roomName,
        roomEmoji: created.roomEmoji,
        hostUid: authStore.uid,
        role: 'host',
        createdAt: Date.now(),
        lastActive: Date.now()
      });
      startFirestoreListener(roomId);
    }
    return created;
  };

  /**
   * Join through the server (functions/src/session.js): it checks consent and the online limit and
   * approves directly. Returning members always get back in. The researcher (host) joins the same way.
   */
  const joinRoom = async (pin: string, displayName: string, avatar: string, consent: boolean, retry = false, asParticipant = false) => {
    await authStore.waitForAuthReady().catch(() => {});
    const roomId = `room_${pin}`;
    const result = await joinStudyRoom(roomId, displayName, avatar, consent, retry, asParticipant);
    if (result.status === 'approved') {
      myStatus.value = result.role === 'observer' ? 'observer' : 'approved';
      upsertMyRoomIndex(roomId, {
        roomId,
        pin,
        role: result.role === 'researcher' ? 'host' : 'participant',
        joinedAt: Date.now(),
        lastActive: Date.now()
      });
    }
    return result;
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
    pushToast(t('toast.approvedTitle'), t('toast.approvedText'), 'success');
  };

  const rejectParticipant = async (uid: string) => {
    if (!hostGuard()) return;
    await updateParticipant(uid, { status: 'rejected' }, 'reject');
    pushToast(t('toast.declinedTitle'), t('toast.declinedText'), 'warning');
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
    joinRoom,
    approveParticipant,
    rejectParticipant,
    muteParticipant,
    kickParticipant,
    syncMentorConfig,
    leaveRoom,
    updateParticipantWhiteboard,
    upsertMyRoomIndex
  };
}
