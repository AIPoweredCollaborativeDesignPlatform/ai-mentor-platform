<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import {
  Sliders,
  Send,
  Sparkles,
  Copy,
  Check,
  ArrowLeft,
  Box,
  Palette,
  FileText,
  Edit3,
  X
} from 'lucide-vue-next';

import ParametricViewer3D from '../components/ParametricViewer3D.vue';
import ModelViewerGLB from '../components/ModelViewerGLB.vue';
import MoodBoardViewer from '../components/MoodBoardViewer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';
import AlertModal from '../components/AlertModal.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');

const isDrawerOpen = ref(false);
const inputMessage = ref('');
const copiedUrl = ref(false);
const chatContainerRef = ref<HTMLDivElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const showScrollFab = ref(false);

const isVerifyingAccess = ref(true);
const isScrolling = ref(false);
let scrollbarTimer: any = null;

// Profile Edit Modal
const isEditProfileOpen = ref(false);
const editName = ref(authStore.displayName);
const editAvatar = ref(authStore.avatar);
const avatarChoices = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];

// Alert Modal state
const alertModal = ref({
  isOpen: false,
  title: '',
  message: '',
  type: 'info' as 'warning'|'info'|'error',
  onConfirm: () => {}
});

// Document Modal state
const isDocModalOpen = ref(false);
const docModalTitle = ref('');
const docModalContent = ref('');

const openDocument = (title: string, content: string) => {
  docModalTitle.value = title;
  docModalContent.value = content;
  isDocModalOpen.value = true;
};

const copyInviteLink = () => {
  const url = `${window.location.origin}/#/waiting/${roomId.value}`;
  navigator.clipboard.writeText(url);
  copiedUrl.value = true;
  setTimeout(() => (copiedUrl.value = false), 2000);
};

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
    }
  });
};

const handleScroll = () => {
  if (chatContainerRef.value) {
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.value;
    showScrollFab.value = scrollHeight - (scrollTop + clientHeight) > 100;
  }
  isScrolling.value = true;
  clearTimeout(scrollbarTimer);
  scrollbarTimer = setTimeout(() => {
    isScrolling.value = false;
  }, 3000);
};

const adjustTextarea = () => {
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
      const newHeight = Math.min(textareaRef.value.scrollHeight, 128);
      textareaRef.value.style.height = `${Math.max(newHeight, 44)}px`;
    }
  });
};

watch(inputMessage, () => {
  adjustTextarea();
});

const handleSend = async () => {
  const me = roomStore.currentRoom?.participants?.[authStore.uid];
  if (me?.isMuted) return;

  if (!inputMessage.value.trim()) return;
  const text = inputMessage.value;
  inputMessage.value = '';
  
  if (textareaRef.value) {
    textareaRef.value.style.height = '44px';
  }

  await roomStore.sendMessage(text);
  scrollToBottom();
};

const insertQuickTag = (tag: string) => {
  inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
  adjustTextarea();
};

const handleUnload = () => {
  roomStore.leaveRoom();
};

const handleSaveProfile = () => {
  if (editName.value.trim()) {
    roomStore.updateParticipantProfile(editName.value.trim(), editAvatar.value);
  }
  isEditProfileOpen.value = false;
};

// Watch for muted state to trigger Toast
watch(
  () => roomStore.currentRoom?.participants?.[authStore.uid]?.isMuted,
  (newVal, oldVal) => {
    if (newVal === true && oldVal === false) {
      roomStore.pushToast('Microphone Muted', 'You have been muted by the host.', 'warning');
    }
  }
);

// Watch for kicked state
watch(() => roomStore.myStatus, (newStatus) => {
  if (newStatus === 'kicked') {
    alertModal.value = {
      isOpen: true,
      title: 'Removed from Meeting',
      message: 'You have been removed from the meeting by the host.',
      type: 'warning',
      onConfirm: () => {
        alertModal.value.isOpen = false;
        router.replace(`/waiting/room_${pin}`);
      }
    };
  }
});

// Watch for meeting ended by host
watch(() => roomStore.currentRoom?.roomStatus, (status) => {
  if (status === 'ended') {
    alertModal.value = {
      isOpen: true,
      title: 'Meeting Ended',
      message: 'The host has ended this meeting for everyone.',
      type: 'info',
      onConfirm: () => {
        alertModal.value.isOpen = false;
        router.replace('/dashboard');
      }
    };
  }
});

watch(() => roomStore.currentRoom?.messages, () => {
  scrollToBottom();
}, { deep: true });

onMounted(async () => {
  window.addEventListener('beforeunload', handleUnload);

  // 1. Verify meeting exists
  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    roomStore.pushToast('Meeting Not Found', `Meeting room ${pin} does not exist.`, 'error');
    router.replace('/');
    return;
  }

  // 2. Start listener
  roomStore.startFirestoreListener(roomId.value);

  // 3. Security Access Verification
  // Wait slightly for Firestore snapshot sync
  setTimeout(() => {
    const isHost = roomStore.currentRoom?.hostUid === authStore.uid;
    const me = roomStore.currentRoom?.participants?.[authStore.uid];

    if (!isHost && me?.status !== 'approved') {
      // Direct access denied! Redirect to waiting room
      roomStore.stopListening();
      router.replace(`/waiting/room_${pin}`);
      return;
    }

    isVerifyingAccess.value = false;
    scrollToBottom();
  }, 600);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleUnload);
  clearTimeout(scrollbarTimer);
  roomStore.stopListening();
});
</script>

<template>
  <!-- Access verification loading screen -->
  <div v-if="isVerifyingAccess" class="h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-400">
    <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mb-3"></div>
    <p class="text-xs">Verifying credentials & permissions...</p>
  </div>

  <div v-else class="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
    <!-- Top Navigation Bar -->
    <header class="h-14 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-3 sm:px-5 flex items-center justify-between z-10 shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <router-link
          to="/dashboard"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0"
          title="Back to Dashboard"
        >
          <ArrowLeft class="w-4 h-4" />
        </router-link>

        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="font-bold text-sm sm:text-base text-white truncate">
              {{ roomStore.currentRoom?.roomName || 'Meeting' }}
            </h1>
            <span class="font-mono text-[11px] px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-sky-400 shrink-0">
              {{ pin }}
            </span>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-2">
            <span>Members: {{ roomStore.approvedParticipants.length }}</span>
            <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● Host</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- User Profile Pill (Click to edit) -->
        <button
          @click="isEditProfileOpen = true"
          class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition text-xs"
          title="Change name or avatar"
        >
          <span>{{ authStore.avatar }}</span>
          <span class="hidden md:inline font-medium truncate max-w-[80px]">{{ authStore.displayName }}</span>
          <Edit3 class="w-3 h-3 text-slate-400" />
        </button>

        <button
          @click="copyInviteLink"
          class="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
        >
          <Check v-if="copiedUrl" class="w-3 h-3 text-emerald-400" />
          <Copy v-else class="w-3 h-3" />
          <span class="hidden sm:inline">{{ copiedUrl ? 'Copied!' : 'Copy Invite' }}</span>
        </button>

        <!-- Controls Drawer Button -->
        <button
          @click="isDrawerOpen = true"
          class="relative inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold shadow transition"
        >
          <Sliders class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Settings</span>
          <!-- Pending Badge -->
          <span
            v-if="roomStore.pendingParticipants.length > 0"
            class="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-slate-950 font-bold text-[9px] rounded-full flex items-center justify-center animate-bounce shadow-md"
          >
            {{ roomStore.pendingParticipants.length }}
          </span>
        </button>
      </div>
    </header>

    <!-- Chat Stream Area with 3-second fading scrollbar -->
    <main
      ref="chatContainerRef"
      @scroll="handleScroll"
      class="flex-1 overflow-y-auto p-3 sm:p-5 space-y-3 max-w-4xl w-full mx-auto relative custom-scrollbar"
      :class="{ 'is-scrolling': isScrolling }"
    >
      <div
        v-for="msg in roomStore.currentRoom?.messages"
        :key="msg.id"
      >
        <!-- Centered Subtle System Status Pill -->
        <div v-if="msg.senderUid === 'system'" class="flex justify-center my-2.5">
          <div class="px-3.5 py-1 rounded-full bg-slate-900/70 border border-slate-800/80 text-[11px] text-slate-400 font-medium shadow-xs text-center max-w-md">
            {{ msg.content }}
          </div>
        </div>

        <!-- Normal User or AI Chat Bubble -->
        <div
          v-else
          class="flex gap-2.5"
          :class="msg.senderUid === authStore.uid ? 'flex-row-reverse' : ''"
        >
          <!-- Avatar -->
          <div
            class="w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0 select-none shadow"
            :class="{
              'bg-sky-500/20 border border-sky-400/40': msg.senderUid === 'ai_mentor',
              'bg-slate-800 border border-slate-700': msg.senderUid !== 'ai_mentor'
            }"
          >
            {{ msg.senderAvatar }}
          </div>

          <!-- Message Body -->
          <div
            class="max-w-2xl flex flex-col min-w-0"
            :class="msg.senderUid === authStore.uid ? 'items-end' : 'items-start'"
          >
            <!-- Sender info -->
            <div class="flex items-center gap-1.5 mb-0.5 text-[11px] text-slate-400">
              <span class="font-medium text-slate-300 truncate">{{ msg.senderName }}</span>
              <span
                v-if="msg.senderUid === 'ai_mentor'"
                class="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-1.5 py-0.2 rounded-md font-mono"
              >
                AI Mentor
              </span>
            </div>

            <!-- Bubble Content -->
            <div
              class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed shadow whitespace-pre-wrap break-words min-w-0 max-w-full"
              :class="{
                'bg-sky-600 text-white rounded-tr-xs': msg.senderUid === authStore.uid,
                'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-xs': msg.senderUid !== authStore.uid && msg.senderUid !== 'ai_mentor',
                'bg-slate-900 border border-sky-500/40 text-sky-100 rounded-tl-xs shadow-sky-950/30': msg.senderUid === 'ai_mentor'
              }"
            >
              {{ msg.content }}

              <!-- Embedded 3D Parametric Viewer -->
              <ParametricViewer3D
                v-if="msg.type === 'ai_asset' && msg.assetType === 'parametric_3d'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded GLB Model Viewer -->
              <ModelViewerGLB
                v-if="msg.type === 'ai_asset' && msg.assetType === 'mesh_3d'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded Visual Moodboard -->
              <MoodBoardViewer
                v-if="msg.type === 'ai_asset' && msg.assetType === 'moodboard'"
                :assetData="msg.assetPayload"
              />

              <!-- Embedded Document Trigger -->
              <div
                v-if="msg.type === 'ai_asset' && (msg.assetType === 'summary' || msg.assetType === 'contract')"
                class="mt-3 p-3 bg-slate-950/80 border border-slate-700 rounded-xl flex items-center justify-between"
              >
                <div class="flex items-center gap-2">
                  <FileText class="w-5 h-5 text-sky-400 shrink-0" />
                  <span class="text-xs font-semibold text-slate-200 truncate">{{ msg.assetPayload?.title }}</span>
                </div>
                <button
                  @click="openDocument(msg.assetPayload?.title, msg.assetPayload?.content)"
                  class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium rounded-lg transition shrink-0 ml-2"
                >
                  View Document
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Scroll to bottom FAB -->
      <button
        v-show="showScrollFab"
        @click="scrollToBottom"
        class="sticky bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-full bg-slate-800 border border-slate-700 shadow-xl text-sky-400 hover:text-white transition z-20 animate-fade-in opacity-90 hover:opacity-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
      </button>
    </main>

    <!-- Bottom Input & Triggers Bar -->
    <footer class="border-t border-slate-800 bg-slate-900/90 backdrop-blur-md p-2.5 sm:p-3 shrink-0">
      <div class="max-w-4xl mx-auto space-y-1.5">
        <!-- Quick Action Badges -->
        <div class="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-[11px] text-slate-400">
          <button
            @click="insertQuickTag('@Mentor')"
            class="px-2 py-0.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition flex items-center gap-1 shrink-0"
          >
            <Sparkles class="w-3 h-3" /> @Mentor
          </button>
          <button
            @click="insertQuickTag('@Mentor generate a 3D prototype')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <Box class="w-3 h-3 text-sky-400" /> 3D Prototype
          </button>
          <button
            @click="insertQuickTag('@Mentor create a visual mood board')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <Palette class="w-3 h-3 text-amber-400" /> Mood Board
          </button>
          <button
            @click="insertQuickTag('@Mentor summarize the discussion so far')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <FileText class="w-3 h-3 text-purple-400" /> Summary
          </button>
        </div>

        <!-- Input Bar with auto-expanding textarea -->
        <div class="flex items-center gap-2">
          <textarea
            ref="textareaRef"
            v-model="inputMessage"
            @input="adjustTextarea"
            @keydown.enter.exact.prevent="handleSend"
            :disabled="roomStore.currentRoom?.participants[authStore.uid]?.isMuted"
            :placeholder="roomStore.currentRoom?.participants[authStore.uid]?.isMuted ? 'You have been muted by the host.' : 'Type a message (Shift+Enter for new line)...'"
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition resize-none min-h-[44px] max-h-32 overflow-y-auto"
            rows="1"
          ></textarea>
          <button
            @click="handleSend"
            :disabled="roomStore.currentRoom?.participants[authStore.uid]?.isMuted"
            class="px-3.5 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow transition flex items-center gap-1.5 shrink-0"
          >
            <Send class="w-4 h-4" />
            <span class="hidden sm:inline">Send</span>
          </button>
        </div>
      </div>
    </footer>

    <!-- Host Control Drawer -->
    <HostControlDrawer
      :isOpen="isDrawerOpen"
      @close="isDrawerOpen = false"
    />

    <!-- Document Preview Modal -->
    <DocumentModal
      :isOpen="isDocModalOpen"
      :title="docModalTitle"
      :content="docModalContent"
      @close="isDocModalOpen = false"
    />

    <!-- Alert Modal for Kicks & System Notifications -->
    <AlertModal
      :isOpen="alertModal.isOpen"
      :title="alertModal.title"
      :message="alertModal.message"
      :type="alertModal.type"
      @confirm="alertModal.onConfirm"
    />

    <!-- Profile Edit Modal -->
    <div v-if="isEditProfileOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-bold text-white">Update Profile</h3>
          <button @click="isEditProfileOpen = false" class="text-slate-400 hover:text-white">
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="space-y-3 mb-5">
          <div class="flex items-center gap-3">
            <span class="text-3xl p-1.5 bg-slate-800 rounded-xl border border-slate-700">{{ editAvatar }}</span>
            <input
              v-model="editName"
              type="text"
              maxlength="20"
              class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
              placeholder="Your name"
            />
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button
              v-for="av in avatarChoices"
              :key="av"
              @click="editAvatar = av"
              class="w-8 h-8 rounded-lg text-base flex items-center justify-center transition border"
              :class="editAvatar === av ? 'bg-sky-500/20 border-sky-400' : 'bg-slate-950 border-slate-800 hover:border-slate-700'"
            >
              {{ av }}
            </button>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button
            @click="isEditProfileOpen = false"
            class="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white transition"
          >
            Cancel
          </button>
          <button
            @click="handleSaveProfile"
            class="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold shadow transition"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.12) transparent;
  transition: scrollbar-color 0.4s ease;
}

.custom-scrollbar.is-scrolling {
  scrollbar-color: rgba(148, 163, 184, 0.55) transparent;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.12);
  border-radius: 9999px;
  transition: background 0.4s ease;
}

.custom-scrollbar.is-scrolling::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.55);
}
</style>
