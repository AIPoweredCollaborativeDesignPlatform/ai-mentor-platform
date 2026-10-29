export type ParticipantStatus = 'pending' | 'approved' | 'rejected' | 'kicked' | 'left' | 'cancelled' | 'observer';

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
  activeWhiteboardId?: string | null;
  consent?: { agreedAt: number; textHash: string };
}

export type SensitivityLevel = 'Strict' | 'Conservative' | 'Exploratory';

export interface MentorConfig {
  sensitivity: SensitivityLevel;
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
  type: 'text' | 'file' | 'ai_asset' | 'whiteboard_state';
  content: string;
  actionOptions?: string[];
  pollVotes?: Record<string, { uid: string; name: string; avatar: string; option: string }>;
  timestamp: number;
  status?: 'sending' | 'delivered' | 'failed';
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
  };
  fileData?: {
    name: string;
    size: number;
    type: 'image' | 'video' | 'document';
    url: string;
    mimeType?: string;
  };
  metadata?: any;
  assetType?: 'parametric_3d' | 'mesh_3d' | 'image' | 'text' | 'vector' | 'fact_check' | 'moodboard' | 'summary' | 'contract';
  assetPayload?: any;
  reactions?: Record<string, string[]>;
}

export interface RoomData {
  roomId: string;
  pin: string;
  roomName?: string;
  roomEmoji?: string;
  hostUid: string;
  /** Who created the room (also when it has no host because the creator joined as a participant) */
  createdBy?: string;
  createdAt: number;
  roomStatus?: 'active' | 'ended';
  mentorConfig: MentorConfig;
  participants: Record<string, Participant>;
  messages: MessageItem[];
  assetsCount?: number;
  whiteboardActive?: boolean;
  whiteboardHostUid?: string;
  whiteboardHostName?: string;
  whiteboardState?: string;
  whiteboardThumbnail?: string;
  whiteboardMemories?: Array<{ timestamp: number; timeFormatted: string; summary: string; assetId?: string }>;
  aiActiveTask?: {
    callerName: string;
    callerUid: string;
    type: string;
    prompt: string;
    startedAt: number;
  } | null;
  deletedAt?: number;
  appVersion?: string;
  language?: 'en' | 'zh-TW';
  aiAbortAt?: number;
  /** Participant-safe view of the room's AI condition (set server-side; see functions/src/profiles.js) */
  ai?: RoomAiView;
  /** Experiment flow, written only by Cloud Functions (functions/src/session.js) */
  session?: RoomSession;
}

export interface RoomSession {
  phase: 'waiting' | 'running' | 'ended';
  /** Online participants needed to open the session (the researcher is not counted) */
  expected: number;
  /** Simultaneous online participants allowed; 0 = no limit */
  maxOnline: number;
  /** 0 = no time limit */
  taskMinutes: number;
  createdAt?: number;
  startedAt?: number;
  endsAt?: number | null;
  timeUpAt?: number;
  endedAt?: number;
  endedBy?: string;
}

export interface RoomAiView {
  enabled: boolean;
  displayName: Record<string, string>;
  modules: {
    enable3D: boolean;
    enableMoodboard: boolean;
    enableFactRetrieval: boolean;
    enableSummary: boolean;
    enableWhiteboardAi: boolean;
  };
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
