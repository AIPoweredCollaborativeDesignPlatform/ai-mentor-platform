export type ParticipantStatus = 'pending' | 'approved' | 'rejected' | 'kicked' | 'left';

export interface Participant {
  uid: string;
  displayName: string;
  avatar: string;
  status: ParticipantStatus;
  isHost?: boolean;
  isMuted?: boolean;
  joinedAt?: number;
}

export type SensitivityLevel = 'Strict' | 'Conservative' | 'Exploratory';

export interface MentorConfig {
  sensitivity: SensitivityLevel;
  enable3D: boolean;
  enableMoodboard: boolean;
  enableFactRetrieval: boolean;
  enableProcessIntervention: boolean;
}

export interface ToastMessage {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
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
  assetType?: 'parametric_3d' | 'mesh_3d' | 'moodboard' | 'summary' | 'contract';
  assetPayload?: any;
}

export interface RoomData {
  roomId: string;
  pin: string;
  roomName?: string;
  hostUid: string;
  createdAt: number;
  mentorConfig: MentorConfig;
  participants: Record<string, Participant>;
  messages: MessageItem[];
}
