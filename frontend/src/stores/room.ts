import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Participant, MessageItem, RoomData, ParticipantStatus } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';
import { db, isFirebaseConfigured } from '../firebase/config';
import {
  doc,
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
  type: 'info' | 'success' | 'warning';
  title: string;
  description: string;
}

export const useRoomStore = defineStore('room', () => {
  const currentRoom = ref<RoomData | null>(null);
  const myStatus = ref<ParticipantStatus>('approved');
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

  const pushToast = (title: string, description: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    toasts.value.push({ id, title, description, type });
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id);
    }, 6000);
  };

  const removeToast = (id: string) => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  };

  // Detach listeners
  const stopListening = () => {
    unsubs.forEach(u => u());
    unsubs = [];
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
          currentRoom.value.mentorConfig = data.mentorConfig;
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
          pushToast('新成員等候審核', `${p.displayName} 正在等候室申請加入`, 'warning');
        }
      });
      currentRoom.value.participants = parts;
    });
    unsubs.push(unsubPart);

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
  const createRoom = async () => {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const roomId = `room_${pin}`;
    const hostUser: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'approved',
      isHost: true,
      joinedAt: Date.now()
    };

    const newRoom: RoomData = {
      roomId,
      pin,
      hostUid: authStore.uid,
      createdAt: Date.now(),
      mentorConfig: { ...mentorStore.config },
      participants: { [authStore.uid]: hostUser },
      messages: [
        {
          id: `msg_${Date.now()}`,
          senderUid: 'system',
          senderName: '系統',
          senderAvatar: '🏛️',
          type: 'text',
          content: `會議室已建立！PIN 碼為 ${pin}。受邀成員輸入 PIN 進入等候室後，需經主持人核准方可加入對話。`,
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
          hostUid: authStore.uid,
          createdAt: Date.now(),
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
    const roomId = `room_${pin}`;
    const applicant: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'pending', // Waiting Room status
      isHost: false,
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
        hostUid: 'host_default',
        createdAt: Date.now(),
        mentorConfig: { ...mentorStore.config },
        participants: {},
        messages: []
      };
      room.participants[authStore.uid] = applicant;
      currentRoom.value = room;
      saveToStorage(room);
    }
  };

  // Host Action: Approve participant
  const approveParticipant = async (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;

    if (db) {
      try {
        await updateDoc(doc(db, 'rooms', currentRoom.value.roomId, 'participants', uid), {
          status: 'approved'
        });
        const participant = currentRoom.value.participants[uid];
        await addDoc(collection(db, 'rooms', currentRoom.value.roomId, 'messages'), {
          senderUid: 'system',
          senderName: '系統',
          senderAvatar: '👋',
          type: 'text',
          content: `歡迎 ${participant?.displayName || '新成員'} 加入設計協同會議！`,
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
        currentRoom.value.messages.push({
          id: `sys_${Date.now()}`,
          senderUid: 'system',
          senderName: '系統',
          senderAvatar: '👋',
          type: 'text',
          content: `歡迎 ${participant.displayName} 加入設計協同會議！`,
          timestamp: Date.now()
        });
        saveToStorage(currentRoom.value);
      }
    }
    pushToast('成員核准成功', '受邀者已獲准進入協作會議室', 'success');
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
    pushToast('成員審核', '已婉拒該加入申請', 'warning');
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

  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    isAnalyzing.value = true;

    try {
      const res = await fetch('http://localhost:8000/api/mentor/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: currentRoom.value.roomId,
          messages: currentRoom.value.messages,
          mentorConfig: mentorStore.config,
          forcedTrigger: latestText.includes('@Mentor') || latestText.includes('@mentor')
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.shouldIntervene && data.aiMessage) {
          await addAiMessage(data.aiMessage, data.assetType, data.assetData);
        }
      } else {
        throw new Error('Backend offline');
      }
    } catch {
      // Local fallback simulation logic
      handleLocalMentorResponse(latestText);
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

  const handleLocalMentorResponse = (text: string) => {
    if (!currentRoom.value) return;
    const lower = text.toLowerCase();
    const config = mentorStore.config;

    const isMentioned = lower.includes('@mentor');
    if (config.sensitivity === 'Strict' && !isMentioned) return;

    if (lower.includes('3d') || lower.includes('模型') || lower.includes('桌') || lower.includes('椅') || isMentioned) {
      if (!config.enable3D) return;
      const isChair = lower.includes('椅') || lower.includes('chair');
      const sample3D = isChair
        ? {
            title: '人體工學椅原型 (Parametric Chair)',
            meshType: 'group',
            components: [
              { shape: 'box', dimensions: { width: 1.2, height: 0.15, depth: 1.2 }, position: { x: 0, y: 0.8, z: 0 }, material: { color: '#4B5563', roughness: 0.7, metalness: 0.1 } },
              { shape: 'box', dimensions: { width: 1.2, height: 1.4, depth: 0.12 }, position: { x: 0, y: 1.5, z: -0.55 }, material: { color: '#374151', roughness: 0.6, metalness: 0.1 } },
              { shape: 'cylinder', dimensions: { radiusTop: 0.08, radiusBottom: 0.08, height: 0.8 }, position: { x: 0, y: 0.4, z: 0 }, material: { color: '#9CA3AF', roughness: 0.3, metalness: 0.8 } }
            ],
            annotations: [
              { label: '座高: 450mm', position: { x: 0.8, y: 0.8, z: 0 } },
              { label: '椅背: 105°', position: { x: 0.8, y: 1.5, z: -0.5 } }
            ]
          }
        : {
            title: '原木圓形茶几量體 (Parametric Table)',
            meshType: 'group',
            components: [
              { shape: 'cylinder', dimensions: { radiusTop: 1.2, radiusBottom: 1.2, height: 0.12 }, position: { x: 0, y: 1.0, z: 0 }, material: { color: '#B45309', roughness: 0.8, metalness: 0.05 } },
              { shape: 'cylinder', dimensions: { radiusTop: 0.06, radiusBottom: 0.06, height: 1.0 }, position: { x: -0.6, y: 0.5, z: -0.4 }, material: { color: '#1F2937', roughness: 0.2, metalness: 0.9 } },
              { shape: 'cylinder', dimensions: { radiusTop: 0.06, radiusBottom: 0.06, height: 1.0 }, position: { x: 0.6, y: 0.5, z: -0.4 }, material: { color: '#1F2937', roughness: 0.2, metalness: 0.9 } },
              { shape: 'cylinder', dimensions: { radiusTop: 0.06, radiusBottom: 0.06, height: 1.0 }, position: { x: 0, y: 0.5, z: 0.5 }, material: { color: '#1F2937', roughness: 0.2, metalness: 0.9 } }
            ],
            annotations: [
              { label: '桌面直徑: 1200mm', position: { x: 0, y: 1.2, z: 0 } },
              { label: '桌高: 520mm', position: { x: 0.8, y: 0.5, z: 0 } }
            ]
          };

      addAiMessage(
        '為促進概念具象化，依據剛才的尺寸與體量討論，即時生成以下參數化 3D 幾何原型供全體同步檢視：',
        'parametric_3d',
        sample3D
      );
      return;
    }

    if (lower.includes('意向') || lower.includes('風格') || lower.includes('材質') || lower.includes('moodboard')) {
      if (!config.enableMoodboard) return;
      addAiMessage(
        '為促進概念具象化，提取當前對話關鍵字，彙整以下視覺意向板與色彩材質標註：',
        'moodboard',
        {
          title: '視覺意向板 (Visual Mood Board)',
          keywords: ['現代極簡', '消光黑鋁', '溫潤胡桃木', '漫射柔光'],
          palette: [
            { hex: '#2D3748', name: '深岩灰' },
            { hex: '#D97706', name: '琥珀暖木' },
            { hex: '#E2E8F0', name: '冷白底襯' },
            { hex: '#94A3B8', name: '霧面鋁鈦' }
          ],
          materials: [
            { name: '天然黑胡桃實木', feature: '開孔消光漆處理' },
            { name: '陽極氧化鋁', feature: '超細噴砂低反射' }
          ],
          slices: [
            { url: 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=600&q=80', caption: '光影與體量' },
            { url: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=600&q=80', caption: '有機曲線與質感' }
          ]
        }
      );
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
    createRoom,
    applyToJoin,
    approveParticipant,
    rejectParticipant,
    sendMessage,
    addAiMessage,
    pushToast,
    removeToast,
    startFirestoreListener,
    stopListening,
    syncMentorConfig
  };
});
