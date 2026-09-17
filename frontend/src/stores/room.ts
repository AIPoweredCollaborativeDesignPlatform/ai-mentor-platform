import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Participant, MessageItem, RoomData, ParticipantStatus } from '../types';
import { useAuthStore } from './auth';
import { useMentorStore } from './mentor';

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
    }, 5000);
  };

  const removeToast = (id: string) => {
    toasts.value = toasts.value.filter(t => t.id !== id);
  };

  // Create room as Host
  const createRoom = () => {
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
      participants: {
        [authStore.uid]: hostUser
      },
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
    saveToStorage(newRoom);
    return newRoom;
  };

  // Join room as Participant (enters Waiting Room)
  const applyToJoin = (pin: string) => {
    const existing = loadFromStorage(pin);
    const roomId = existing ? existing.roomId : `room_${pin}`;

    const newRoom: RoomData = existing || {
      roomId,
      pin,
      hostUid: 'host_default',
      createdAt: Date.now(),
      mentorConfig: { ...mentorStore.config },
      participants: {},
      messages: []
    };

    const applicant: Participant = {
      uid: authStore.uid,
      displayName: authStore.displayName,
      avatar: authStore.avatar,
      status: 'pending', // Waiting Room status
      isHost: false,
      joinedAt: Date.now()
    };

    newRoom.participants[authStore.uid] = applicant;
    currentRoom.value = newRoom;
    myStatus.value = 'pending';
    saveToStorage(newRoom);
    return newRoom;
  };

  // Host Action: Approve participant
  const approveParticipant = (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;
    const participant = currentRoom.value.participants[uid];
    if (participant) {
      participant.status = 'approved';
      pushToast('成員核准通知', `${participant.displayName} 已獲准進入會議室`, 'success');

      // Add system announcement message
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
  };

  // Host Action: Reject participant
  const rejectParticipant = (uid: string) => {
    if (!currentRoom.value || !isHost.value) return;
    const participant = currentRoom.value.participants[uid];
    if (participant) {
      participant.status = 'rejected';
      pushToast('成員審核', `已婉拒 ${participant.displayName} 的加入申請`, 'warning');
      saveToStorage(currentRoom.value);
    }
  };

  // Add Message and trigger Mentor Agent
  const sendMessage = async (text: string) => {
    if (!currentRoom.value || !text.trim()) return;

    const newMsg: MessageItem = {
      id: `msg_${Date.now()}`,
      senderUid: authStore.uid,
      senderName: authStore.displayName,
      senderAvatar: authStore.avatar,
      type: 'text',
      content: text.trim(),
      timestamp: Date.now()
    };

    currentRoom.value.messages.push(newMsg);
    saveToStorage(currentRoom.value);

    // Call Mentor Agent (Backend or local simulated agent)
    await triggerMentorAgent(text);
  };

  const triggerMentorAgent = async (latestText: string) => {
    if (!currentRoom.value) return;
    isAnalyzing.value = true;

    try {
      // Attempt backend API call
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
          addAiMessage(data.aiMessage, data.assetType, data.assetData);
        }
      } else {
        throw new Error('Backend offline');
      }
    } catch {
      // Fallback local simulation logic
      handleLocalMentorResponse(latestText);
    } finally {
      isAnalyzing.value = false;
    }
  };

  const handleLocalMentorResponse = (text: string) => {
    if (!currentRoom.value) return;
    const lower = text.toLowerCase();
    const config = mentorStore.config;

    const isMentioned = lower.includes('@mentor');
    if (config.sensitivity === 'Strict' && !isMentioned) return;

    // Trigger 3D chair/table or general parametric
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

  const addAiMessage = (content: string, assetType?: any, assetPayload?: any) => {
    if (!currentRoom.value) return;
    const aiMsg: MessageItem = {
      id: `ai_${Date.now()}`,
      senderUid: 'ai_mentor',
      senderName: 'AI Mentor',
      senderAvatar: '✨',
      type: assetType ? 'ai_asset' : 'text',
      content,
      timestamp: Date.now(),
      assetType,
      assetPayload
    };
    currentRoom.value.messages.push(aiMsg);
    saveToStorage(currentRoom.value);
  };

  // LocalStorage sync helpers
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
    removeToast
  };
});
