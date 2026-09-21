export type ParticipantStatus = 'pending' | 'approved' | 'rejected' | 'kicked' | 'left' | 'cancelled';

export interface Participant {
  uid: string;
  displayName: string;
  avatar: string;
  status: ParticipantStatus;
  isHost?: boolean;
  isMuted?: boolean;
  isOnline?: boolean;
  lastSeen?: number;
  joinedAt?: number;
}

export type SensitivityLevel = 'Strict' | 'Conservative' | 'Exploratory';

export interface MentorConfig {
  sensitivity: SensitivityLevel;
  modelTier?: 'flash' | 'pro';
  meetingLanguage?: 'en' | 'zh-TW' | 'ja' | 'ko';
  enable3D: boolean;
  enableMoodboard: boolean;
  enableFactRetrieval: boolean;
  enableProcessIntervention: boolean;
}

export interface TypingUser {
  uid: string;
  displayName: string;
  avatar: string;
  timestamp: number;
}

export interface ToastMessage {
  id: string;
  title: string;
  description: string;
  type: 'info' | 'success' | 'warning' | 'error';
  actions?: {
    label: string;
    onClick: () => void;
    type?: 'primary' | 'danger';
  }[];
}

export interface MessageItem {
  id: string;
  senderUid: string;
  senderName: string;
  senderAvatar: string;
  type: 'text' | 'file' | 'ai_asset';
  content: string;
  timestamp: number;
  status?: 'sending' | 'delivered' | 'failed';
  fileData?: {
    name: string;
    size: number;
    type: 'image' | 'video' | 'document';
    url: string;
    mimeType?: string;
  };
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract' | 'fact_check';
  assetPayload?: any;
}

export interface RoomData {
  roomId: string;
  pin: string;
  roomName?: string;
  hostUid: string;
  createdAt: number;
  roomStatus?: 'active' | 'ended';
  mentorConfig: MentorConfig;
  participants: Record<string, Participant>;
  messages: MessageItem[];
  assetsCount?: number;
}

export type AnimationMotionType = 'harmonic' | 'bounce' | 'pendulum' | 'spin' | 'pulse' | 'wave';

export interface ComponentAnimation {
  type: AnimationMotionType;
  axis?: 'x' | 'y' | 'z' | 'all';
  amplitude?: number;
  frequency?: number;
  phase?: number;
  damping?: number;
  acceleration?: number;
}

export interface ParametricComponent {
  shape: 'box' | 'cylinder' | 'sphere' | 'torus';
  dimensions?: Record<string, number>;
  position?: { x?: number; y?: number; z?: number };
  material?: {
    color?: string;
    roughness?: number;
    metalness?: number;
  };
  animation?: ComponentAnimation;
}
