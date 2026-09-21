<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import { useMentorStore } from '../stores/mentor';
import { db } from '../firebase/config';
import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';
import type { SensitivityLevel } from '../types';
import {
  Sliders,
  Users,
  CheckCircle,
  XCircle,
  ShieldCheck,
  Box,
  Palette,
  Search,
  FileCheck2,
  X,
  MicOff,
  Mic,
  UserMinus,
  LogOut,
  Power,
  RotateCcw,
  AlertTriangle,
  LogIn,
  Unlock,
  Zap,
  Cpu,
  Globe,
  Check
} from 'lucide-vue-next';

import { ref, onMounted, onUnmounted } from 'vue';
import { getStoredTripoApiKey, setStoredTripoApiKey } from '../services/tripo';
import { getStoredMeshyApiKey, setStoredMeshyApiKey } from '../services/meshy';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();
const mentorStore = useMentorStore();

const showLeaveModal = ref(false);
const showEndAllModal = ref(false);
const showAnonWarningModal = ref(false);
const pendingAction = ref<'leave' | 'end'>('leave');

// 3D AI Engine settings (stored in localStorage)
const selected3DEngine = ref<'meshy' | 'tripo' | 'threejs'>(
  (localStorage.getItem('ai_3d_engine') as any) || 'meshy'
);
const meshyApiKey = ref(getStoredMeshyApiKey());
const tripoApiKey = ref(getStoredTripoApiKey());
const engineSavedMsg = ref('');

const handleSelectEngine = (engine: 'meshy' | 'tripo' | 'threejs') => {
  selected3DEngine.value = engine;
  localStorage.setItem('ai_3d_engine', engine);
  engineSavedMsg.value = `Active 3D Engine: ${engine === 'meshy' ? 'Meshy.ai' : engine === 'tripo' ? 'Tripo3D' : 'Three.js'}`;
  setTimeout(() => (engineSavedMsg.value = ''), 2500);
};

const handleSaveMeshyKey = () => {
  setStoredMeshyApiKey(meshyApiKey.value);
  if (meshyApiKey.value) selected3DEngine.value = 'meshy';
  localStorage.setItem('ai_3d_engine', selected3DEngine.value);
  engineSavedMsg.value = meshyApiKey.value ? 'Meshy AI Key saved!' : 'Meshy Key removed';
  setTimeout(() => (engineSavedMsg.value = ''), 2500);
};

const handleSaveTripoKey = () => {
  setStoredTripoApiKey(tripoApiKey.value);
  if (tripoApiKey.value) selected3DEngine.value = 'tripo';
  localStorage.setItem('ai_3d_engine', selected3DEngine.value);
  engineSavedMsg.value = tripoApiKey.value ? 'Tripo3D Key saved!' : 'Tripo3D Key removed';
  setTimeout(() => (engineSavedMsg.value = ''), 2500);
};

const handleGoogleSignIn = async () => {
  try {
    const res = await authStore.upgradeWithGoogle();
    if (res.previousAnonUid && roomStore.currentRoom) {
      await roomStore.transferHostOwnership(res.previousAnonUid, authStore.uid);
    } else if (roomStore.currentRoom && db) {
      await updateDoc(doc(db, 'rooms', roomStore.currentRoom.roomId), {
        hostUid: authStore.uid
      });
      roomStore.currentRoom.hostUid = authStore.uid;
    }
    roomStore.pushToast('Signed In', `Signed in as ${authStore.displayName}`, 'success');
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user') {
      console.warn('Google sign-in error:', err);
      roomStore.pushToast('Sign-In Failed', err?.message || 'Could not complete Google Sign-in', 'error');
    }
  }
};

const handleSelectModelTier = async (tier: 'flash' | 'pro') => {
  mentorStore.setModelTier(tier);
  await roomStore.syncMentorConfig();
};

const handleSelectMeetingLanguage = async (lang: 'en' | 'zh-TW' | 'ja' | 'ko') => {
  mentorStore.setMeetingLanguage(lang);
  await roomStore.syncMentorConfig();
};

const handleSelectSensitivity = async (level: SensitivityLevel) => {
  mentorStore.setSensitivity(level);
  await roomStore.syncMentorConfig();
};

const handleToggleModule = async (moduleKey: 'enable3D' | 'enableMoodboard' | 'enableFactRetrieval' | 'enableProcessIntervention') => {
  mentorStore.toggleModule(moduleKey);
  await roomStore.syncMentorConfig();
};

const triggerLeaveFlow = () => {
  if (roomStore.isHost && !authStore.isGoogleLinked) {
    pendingAction.value = 'leave';
    showAnonWarningModal.value = true;
  } else {
    showLeaveModal.value = true;
  }
};

const triggerEndFlow = () => {
  if (!authStore.isGoogleLinked) {
    pendingAction.value = 'end';
    showAnonWarningModal.value = true;
  } else {
    showEndAllModal.value = true;
  }
};

const proceedAfterAnonWarning = () => {
  showAnonWarningModal.value = false;
  if (pendingAction.value === 'leave') {
    showLeaveModal.value = true;
  } else {
    showEndAllModal.value = true;
  }
};

const handleLeaveMeeting = async () => {
  await roomStore.leaveRoom();
  showLeaveModal.value = false;
  emit('close');
  router.push(authStore.isGoogleLinked ? '/dashboard' : '/');
};

const handleEndMeetingForAll = async () => {
  await roomStore.endMeetingForAll();
  showEndAllModal.value = false;
  emit('close');
};

const handleReopenMeeting = async () => {
  if (!roomStore.currentRoom) return;
  roomStore.currentRoom.roomStatus = 'active';
  if (db) {
    try {
      await updateDoc(doc(db, 'rooms', roomStore.currentRoom.roomId), {
        roomStatus: 'active'
      });
      await addDoc(collection(db, 'rooms', roomStore.currentRoom.roomId, 'messages'), {
        senderUid: 'system',
        senderName: 'System',
        senderAvatar: '🔓',
        type: 'text',
        content: 'Meeting has been reopened by the host',
        timestamp: Date.now()
      });
    } catch (e) {
      console.error(e);
    }
  }
  emit('close');
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.isOpen) {
    emit('close');
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});


const sensitivities: { id: SensitivityLevel; name: string; desc: string }[] = [
  { id: 'Strict', name: 'Strict', desc: 'Only responds when @Mentor is mentioned' },
  { id: 'Conservative', name: 'Conservative (Default)', desc: 'Intervenes on divergence, stagnation, or visual needs' },
  { id: 'Exploratory', name: 'Exploratory', desc: 'Proactively suggests variations and references' }
];
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs">
    <!-- Backdrop overlay for click-outside -->
    <div class="absolute inset-0" @click="emit('close')"></div>

    <div
      class="relative w-full max-w-md bg-slate-900 border-l border-slate-800 h-[100dvh] flex flex-col shadow-2xl transition-transform duration-300 z-10"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/80">
        <div class="flex items-center gap-2">
          <Sliders class="w-5 h-5 text-sky-400" />
          <h3 class="font-bold text-slate-100">Host Controls</h3>
        </div>
        <button
          @click="emit('close')"
          class="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
          title="Close drawer"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-6">
        <!-- Anonymous Host Google Sign-in banner -->
        <div
          v-if="roomStore.isHost && !authStore.isGoogleLinked"
          class="p-3.5 rounded-2xl bg-amber-950/30 border border-amber-500/40 flex items-center justify-between gap-3 shadow-lg"
        >
          <div class="space-y-0.5">
            <p class="text-xs font-bold text-amber-300 flex items-center gap-1.5">
              <AlertTriangle class="w-3.5 h-3.5 text-amber-400" />
              Hosting Anonymously
            </p>
            <p class="text-[11px] text-slate-400 leading-tight">
              Sign in to save this room to your permanent Dashboard
            </p>
          </div>
          <button
            @click="handleGoogleSignIn"
            class="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0 flex items-center gap-1.5 shadow transition"
          >
            <LogIn class="w-3.5 h-3.5" /> Sign in
          </button>
        </div>

        <!-- 1. Waiting Room Approval List -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <Users class="w-4 h-4 text-amber-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                Pending Requests
              </h4>
            </div>
            <span
              class="text-xs px-2 py-0.5 rounded-full font-bold"
              :class="roomStore.pendingParticipants.length > 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' : 'bg-slate-800 text-slate-500'"
            >
              {{ roomStore.pendingParticipants.length }} pending
            </span>
          </div>

          <div v-if="roomStore.pendingParticipants.length === 0" class="text-xs text-slate-500 italic p-3 bg-slate-950/50 rounded-xl border border-slate-800/80 text-center">
            No pending requests
          </div>

          <div v-else class="space-y-2">
            <div
              v-for="p in roomStore.pendingParticipants"
              :key="p.uid"
              class="flex items-center justify-between p-3 rounded-xl bg-amber-950/20 border border-amber-500/30"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-2xl">{{ p.avatar }}</span>
                <div>
                  <h5 class="text-sm font-medium text-slate-100">{{ p.displayName }}</h5>
                  <p class="text-[11px] text-amber-400/80">Waiting for approval...</p>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  @click="roomStore.approveParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition"
                >
                  <CheckCircle class="w-3.5 h-3.5" /> Approve
                </button>
                <button
                  @click="roomStore.rejectParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs transition"
                >
                  <XCircle class="w-3.5 h-3.5" /> Decline
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. Approved Members -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <ShieldCheck class="w-4 h-4 text-emerald-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                Members ({{ roomStore.approvedParticipants.length }})
              </h4>
            </div>
          </div>

          <div class="space-y-2">
            <div
              v-for="p in roomStore.approvedParticipants"
              :key="p.uid"
              class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-xl">{{ p.avatar }}</span>
                <span class="text-sm text-slate-200 font-medium">{{ p.displayName }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  v-if="p.isHost"
                  class="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  :class="p.isOnline !== false ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'"
                >
                  👑 Host {{ p.isOnline !== false ? '' : '(Offline)' }}
                </span>
                <span
                  v-else
                  class="text-[10px] flex items-center gap-1 font-medium"
                  :class="p.isOnline !== false ? 'text-emerald-400' : 'text-slate-500'"
                >
                  {{ p.isOnline !== false ? '● Online' : '○ Offline' }}
                </span>

                <div v-if="!p.isHost" class="flex items-center gap-1">
                  <button
                    @click="roomStore.muteParticipant(p.uid, !p.isMuted)"
                    class="p-1.5 rounded bg-slate-800 hover:bg-slate-700 transition"
                    :title="p.isMuted ? 'Unmute' : 'Mute'"
                  >
                    <MicOff v-if="p.isMuted" class="w-3.5 h-3.5 text-rose-400" />
                    <Mic v-else class="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button
                    @click="roomStore.kickParticipant(p.uid)"
                    class="p-1.5 rounded bg-slate-800 hover:bg-rose-900/50 transition"
                    title="Remove from meeting"
                  >
                    <UserMinus class="w-3.5 h-3.5 text-rose-400" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <hr class="border-slate-800" />

        <!-- 3. AI Model Selection (Flash vs Pro) -->
        <section>
          <div class="flex items-center justify-between mb-1">
            <h4 class="font-semibold text-sm text-slate-100 flex items-center gap-2">
              <Cpu class="w-4 h-4 text-sky-400" />
              AI Model Tier
            </h4>
            <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
              Host Controlled
            </span>
          </div>
          <p class="text-xs text-slate-400 mb-3">
            Choose the Gemini engine powering AI Mentor
          </p>

          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              @click="handleSelectModelTier('flash')"
              class="p-2.5 rounded-xl border text-left transition flex flex-col gap-1"
              :class="mentorStore.config.modelTier !== 'pro'
                ? 'bg-sky-950/40 border-sky-500 text-sky-100 ring-1 ring-sky-500/40'
                : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold flex items-center gap-1">
                  <Zap class="w-3.5 h-3.5 text-amber-400" /> Gemini Flash
                </span>
                <span
                  v-if="mentorStore.config.modelTier !== 'pro'"
                  class="w-2 h-2 rounded-full bg-sky-400"
                ></span>
              </div>
              <p class="text-[10px] text-slate-400">Ultra-fast generation & real-time response</p>
            </button>

            <button
              type="button"
              @click="handleSelectModelTier('pro')"
              class="p-2.5 rounded-xl border text-left transition flex flex-col gap-1"
              :class="mentorStore.config.modelTier === 'pro'
                ? 'bg-purple-950/40 border-purple-500 text-purple-100 ring-1 ring-purple-500/40'
                : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold flex items-center gap-1">
                  <Cpu class="w-3.5 h-3.5 text-purple-400" /> Gemini Pro
                </span>
                <span
                  v-if="mentorStore.config.modelTier === 'pro'"
                  class="w-2 h-2 rounded-full bg-purple-400"
                ></span>
              </div>
              <p class="text-[10px] text-slate-400">Complex reasoning & deep design critique</p>
            </button>
          </div>

          <!-- 3.1 3D Generation Engine (Meshy.ai & Tripo3D) -->
          <div class="mt-3 p-3 bg-slate-950/70 rounded-xl border border-slate-800 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Box class="w-3.5 h-3.5 text-indigo-400" />
                3D AI Mesh Engine
              </span>
              <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                {{ selected3DEngine === 'meshy' ? 'Meshy.ai' : selected3DEngine === 'tripo' ? 'Tripo3D' : 'Three.js' }}
              </span>
            </div>

            <!-- Engine Selector Pills -->
            <div class="grid grid-cols-3 gap-1.5 p-1 bg-slate-900 rounded-lg border border-slate-800">
              <button
                type="button"
                @click="handleSelectEngine('meshy')"
                :class="[
                  'py-1 text-[11px] font-medium rounded-md transition text-center',
                  selected3DEngine === 'meshy'
                    ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                ]"
              >
                Meshy.ai
              </button>
              <button
                type="button"
                @click="handleSelectEngine('tripo')"
                :class="[
                  'py-1 text-[11px] font-medium rounded-md transition text-center',
                  selected3DEngine === 'tripo'
                    ? 'bg-sky-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                ]"
              >
                Tripo3D
              </button>
              <button
                type="button"
                @click="handleSelectEngine('threejs')"
                :class="[
                  'py-1 text-[11px] font-medium rounded-md transition text-center',
                  selected3DEngine === 'threejs'
                    ? 'bg-purple-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                ]"
              >
                Three.js
              </button>
            </div>

            <!-- Meshy AI Input -->
            <div v-if="selected3DEngine === 'meshy'" class="space-y-1.5">
              <p class="text-[11px] text-slate-400 leading-relaxed">
                Connect your <strong>Meshy.ai</strong> API key to generate high-res organic 3D models with PBR textures:
              </p>
              <div class="flex items-center gap-2">
                <input
                  v-model="meshyApiKey"
                  @change="handleSaveMeshyKey"
                  type="password"
                  placeholder="Meshy API Key (msy_...)"
                  class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  @click="handleSaveMeshyKey"
                  class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shrink-0 transition"
                >
                  Save
                </button>
              </div>
            </div>

            <!-- Tripo3D Input -->
            <div v-else-if="selected3DEngine === 'tripo'" class="space-y-1.5">
              <p class="text-[11px] text-slate-400 leading-relaxed">
                Connect your <strong>Tripo3D</strong> API key to generate smooth neural meshes:
              </p>
              <div class="flex items-center gap-2">
                <input
                  v-model="tripoApiKey"
                  @change="handleSaveTripoKey"
                  type="password"
                  placeholder="Tripo3D Key (tsk_...)"
                  class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 font-mono"
                />
                <button
                  @click="handleSaveTripoKey"
                  class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0 transition"
                >
                  Save
                </button>
              </div>
            </div>

            <!-- Three.js Notice -->
            <div v-else class="text-[11px] text-slate-400 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
              ⚡ Using built-in Three.js lightweight geometric primitives. No external API key required.
            </div>

            <p v-if="engineSavedMsg" class="text-[10px] text-emerald-400 flex items-center gap-1">
              <Check class="w-3 h-3" /> {{ engineSavedMsg }}
            </p>
          </div>
        </section>

        <!-- Room Working Language (Host Controlled) -->
        <section>
          <div class="flex items-center justify-between mb-1">
            <h4 class="font-semibold text-sm text-slate-100 flex items-center gap-2">
              <Globe class="w-4 h-4 text-emerald-400" />
              Room Working Language
            </h4>
            <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
              AI Responds In
            </span>
          </div>
          <p class="text-xs text-slate-400 mb-2.5">
            AI Mentor will generate all insights, summaries, and critiques in this language
          </p>

          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="lang in ([
                { id: 'en', label: 'English' },
                { id: 'zh-TW', label: '繁體中文' },
                { id: 'ja', label: '日本語' },
                { id: 'ko', label: '한국어' }
              ] as const)"
              :key="lang.id"
              type="button"
              @click="handleSelectMeetingLanguage(lang.id)"
              class="p-2 rounded-xl border text-left transition flex items-center justify-between text-xs font-medium"
              :class="(mentorStore.config.meetingLanguage || 'en') === lang.id
                ? 'bg-emerald-950/40 border-emerald-500 text-emerald-100'
                : 'bg-slate-950/50 border-slate-800 text-slate-300 hover:border-slate-700'"
            >
              <span>{{ lang.label }}</span>
              <span
                v-if="(mentorStore.config.meetingLanguage || 'en') === lang.id"
                class="w-1.5 h-1.5 rounded-full bg-emerald-400"
              ></span>
            </button>
          </div>
        </section>

        <!-- 4. AI Mentor Sensitivity -->
        <section>
          <h4 class="font-semibold text-sm text-slate-100 mb-1 flex items-center gap-2">
            <Sliders class="w-4 h-4 text-sky-400" />
            AI Mentor Sensitivity
          </h4>
          <p class="text-xs text-slate-400 mb-3">
            Control when the AI intervenes in the conversation
          </p>

          <div class="space-y-2">
            <div
              v-for="s in sensitivities"
              :key="s.id"
              @click="handleSelectSensitivity(s.id)"
              class="p-3 rounded-xl border cursor-pointer transition flex flex-col gap-1"
              :class="mentorStore.config.sensitivity === s.id
                ? 'bg-sky-950/40 border-sky-500 text-sky-100 shadow-sm'
                : 'bg-slate-950/50 border-slate-800 text-slate-300 hover:border-slate-700'"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold">{{ s.name }}</span>
                <span
                  class="w-3 h-3 rounded-full border"
                  :class="mentorStore.config.sensitivity === s.id ? 'bg-sky-400 border-sky-300' : 'border-slate-600'"
                ></span>
              </div>
              <p class="text-xs opacity-75">{{ s.desc }}</p>
            </div>
          </div>
        </section>

        <!-- 5. Module Toggles -->
        <section>
          <h4 class="font-semibold text-sm text-slate-100 mb-3">
            AI Asset Modules
          </h4>

          <div class="space-y-2.5">
            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="handleToggleModule('enable3D')"
            >
              <div class="flex items-center gap-2.5">
                <Box class="w-4 h-4 text-sky-400" />
                <span class="text-sm text-slate-200">3D Prototype (Code-to-3D / GLB)</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enable3D ? 'bg-sky-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enable3D ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="handleToggleModule('enableMoodboard')"
            >
              <div class="flex items-center gap-2.5">
                <Palette class="w-4 h-4 text-amber-400" />
                <span class="text-sm text-slate-200">Visual Mood Board</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableMoodboard ? 'bg-amber-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableMoodboard ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="handleToggleModule('enableFactRetrieval')"
            >
              <div class="flex items-center gap-2.5">
                <Search class="w-4 h-4 text-emerald-400" />
                <span class="text-sm text-slate-200">Fact Retrieval & Verification</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableFactRetrieval ? 'bg-emerald-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableFactRetrieval ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="handleToggleModule('enableProcessIntervention')"
            >
              <div class="flex items-center gap-2.5">
                <FileCheck2 class="w-4 h-4 text-purple-400" />
                <span class="text-sm text-slate-200">Executive Meeting Summary</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableProcessIntervention ? 'bg-purple-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableProcessIntervention ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>
          </div>
        </section>

        <hr class="border-slate-800" />

        <!-- Anonymous Host Claim Warning -->
        <div v-if="roomStore.isHost && !authStore.isGoogleLinked" class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl mb-4 text-left">
          <div class="flex items-center gap-2 text-amber-400 font-semibold text-xs mb-1">
            <AlertTriangle class="w-4 h-4 shrink-0" />
            <span>Anonymous Host</span>
          </div>
          <p class="text-[11px] text-slate-300 leading-relaxed mb-2.5">
            You are hosting as an anonymous guest. Link your Google account to keep this meeting in your history and reclaim host privileges later.
          </p>
          <button
            @click="handleGoogleSignIn"
            class="w-full py-1.5 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow"
          >
            <LogIn class="w-3.5 h-3.5" /> Sign in with Google to Save Room
          </button>
        </div>

        <hr class="border-slate-800" />

        <!-- 5. Meeting Session Actions -->
        <section class="space-y-2 pb-6">
          <h4 class="font-semibold text-sm text-slate-100 mb-2">Meeting Actions</h4>

          <!-- Reopen Meeting (If Ended & Host) -->
          <button
            v-if="roomStore.isHost && roomStore.currentRoom?.roomStatus === 'ended'"
            @click="handleReopenMeeting"
            class="w-full py-2.5 px-3 rounded-xl border border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 hover:text-emerald-100 text-xs font-semibold transition flex items-center justify-center gap-2 shadow"
          >
            <Unlock class="w-4 h-4 text-emerald-400" />
            <span>Reopen Meeting (Enable Chat)</span>
          </button>

          <!-- Leave Meeting -->
          <button
            @click="triggerLeaveFlow"
            class="w-full py-2.5 px-3 rounded-xl border border-slate-700 bg-slate-950/60 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <LogOut class="w-4 h-4 text-amber-400" />
            <span>{{ roomStore.isHost ? 'Leave Meeting (Keep Active for Others)' : 'Leave Meeting' }}</span>
          </button>

          <!-- End Meeting for All (Host only) -->
          <button
            v-if="roomStore.isHost && roomStore.currentRoom?.roomStatus !== 'ended'"
            @click="triggerEndFlow"
            class="w-full py-2.5 px-3 rounded-xl border border-rose-900/60 bg-rose-950/30 hover:bg-rose-900/50 text-rose-300 hover:text-rose-100 text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <Power class="w-4 h-4 text-rose-400" />
            <span>Close Meeting (Read-Only Archive)</span>
          </button>
        </section>
      </div>
    </div>

    <!-- Anonymous Host Warning Modal -->
    <div v-if="showAnonWarningModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-amber-500/40 rounded-2xl p-6 shadow-2xl text-center">
        <div class="w-12 h-12 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center mx-auto mb-3">
          <AlertTriangle class="w-6 h-6" />
        </div>
        <h3 class="text-base font-bold text-white mb-2">Save This Room First?</h3>
        <p class="text-xs text-slate-300 mb-5 leading-relaxed">
          You are not signed in. If you leave now, you will <strong class="text-amber-400">permanently lose host privileges</strong> and cannot access this meeting again. Would you like to sign in with Google?
        </p>
        <div class="space-y-2">
          <button
            @click="handleGoogleSignIn"
            class="w-full py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition shadow flex items-center justify-center gap-1.5"
          >
            <LogIn class="w-3.5 h-3.5" /> Sign in with Google (Save Room)
          </button>
          <div class="flex gap-2 pt-1">
            <button
              @click="showAnonWarningModal = false"
              class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-semibold transition"
            >
              Cancel
            </button>
            <button
              @click="proceedAfterAnonWarning"
              class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-rose-950/60 text-rose-400 border border-slate-700 text-xs font-semibold transition"
            >
              Leave Anyway
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirm Leave Modal -->
    <div v-if="showLeaveModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
        <h3 class="text-base font-bold text-white mb-2">Leave Meeting?</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          {{ roomStore.isHost
            ? 'You will leave the meeting, but other members can continue chatting. You can rejoin anytime from your Dashboard.'
            : 'Are you sure you want to leave this meeting? You can rejoin later.' }}
        </p>
        <div class="flex gap-2">
          <button
            @click="showLeaveModal = false"
            class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
          >
            Cancel
          </button>
          <button
            @click="handleLeaveMeeting"
            class="flex-1 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition shadow"
          >
            Confirm Leave
          </button>
        </div>
      </div>
    </div>

    <!-- Confirm End for All Modal -->
    <div v-if="showEndAllModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
        <h3 class="text-base font-bold text-rose-400 mb-2">Close Meeting for Everyone?</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          This will set the meeting to read-only archive mode. Members will be able to review past messages and assets, but messaging will be disabled. As host, you can reopen it anytime.
        </p>
        <div class="flex gap-2">
          <button
            @click="showEndAllModal = false"
            class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
          >
            Cancel
          </button>
          <button
            @click="handleEndMeetingForAll"
            class="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow"
          >
            Close Meeting
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
