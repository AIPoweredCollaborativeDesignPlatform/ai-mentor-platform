<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useRoomStore } from '../stores/room';
import { useMentorStore } from '../stores/mentor';
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
  Power
} from 'lucide-vue-next';

import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const router = useRouter();
const showLeaveModal = ref(false);
const showEndAllModal = ref(false);

const handleLeaveMeeting = async () => {
  await roomStore.leaveRoom();
  showLeaveModal.value = false;
  emit('close');
  router.push('/dashboard');
};

const handleEndMeetingForAll = async () => {
  await roomStore.endMeetingForAll();
  showEndAllModal.value = false;
  emit('close');
  router.push('/dashboard');
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

const roomStore = useRoomStore();
const mentorStore = useMentorStore();

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
      class="relative w-full max-w-md bg-slate-900 border-l border-slate-800 h-full flex flex-col shadow-2xl transition-transform duration-300 z-10"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/60">
        <div class="flex items-center gap-2">
          <Sliders class="w-5 h-5 text-sky-400" />
          <h3 class="font-bold text-slate-100">Host Controls</h3>
        </div>
        <button
          @click="emit('close')"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-6">
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

        <!-- 3. AI Mentor Sensitivity -->
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
              @click="mentorStore.setSensitivity(s.id)"
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

        <!-- 4. Module Toggles -->
        <section>
          <h4 class="font-semibold text-sm text-slate-100 mb-3">
            AI Asset Modules
          </h4>

          <div class="space-y-2.5">
            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="mentorStore.toggleModule('enable3D')"
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
              @click="mentorStore.toggleModule('enableMoodboard')"
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
              @click="mentorStore.toggleModule('enableFactRetrieval')"
            >
              <div class="flex items-center gap-2.5">
                <Search class="w-4 h-4 text-emerald-400" />
                <span class="text-sm text-slate-200">Fact Retrieval</span>
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
              @click="mentorStore.toggleModule('enableProcessIntervention')"
            >
              <div class="flex items-center gap-2.5">
                <FileCheck2 class="w-4 h-4 text-purple-400" />
                <span class="text-sm text-slate-200">Summary & Document Drafts</span>
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

        <!-- 5. Meeting Session Actions -->
        <section class="space-y-2 pb-6">
          <h4 class="font-semibold text-sm text-slate-100 mb-2">Meeting Actions</h4>

          <!-- Leave Meeting -->
          <button
            @click="showLeaveModal = true"
            class="w-full py-2.5 px-3 rounded-xl border border-slate-700 bg-slate-950/60 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <LogOut class="w-4 h-4 text-amber-400" />
            <span>{{ roomStore.isHost ? 'Leave Meeting (Keep Active for Others)' : 'Leave Meeting' }}</span>
          </button>

          <!-- End Meeting for All (Host only) -->
          <button
            v-if="roomStore.isHost"
            @click="showEndAllModal = true"
            class="w-full py-2.5 px-3 rounded-xl border border-rose-900/60 bg-rose-950/30 hover:bg-rose-900/50 text-rose-300 hover:text-rose-100 text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <Power class="w-4 h-4 text-rose-400" />
            <span>End Meeting for Everyone</span>
          </button>
        </section>
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
        <h3 class="text-base font-bold text-rose-400 mb-2">End Meeting for Everyone?</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          This will close the meeting and disconnect all active participants. This action cannot be undone.
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
            End for All
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
