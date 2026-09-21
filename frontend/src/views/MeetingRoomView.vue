<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
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
  FileText
} from 'lucide-vue-next';

import ParametricViewer3D from '../components/ParametricViewer3D.vue';
import ModelViewerGLB from '../components/ModelViewerGLB.vue';
import MoodBoardViewer from '../components/MoodBoardViewer.vue';
import DocumentModal from '../components/DocumentModal.vue';
import HostControlDrawer from '../components/HostControlDrawer.vue';

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

const handleSend = async () => {
  if (roomStore.currentRoom?.participants[authStore.uid]?.isMuted) return;
  if (!inputMessage.value.trim()) return;
  const text = inputMessage.value;
  inputMessage.value = '';
  await roomStore.sendMessage(text);
  scrollToBottom();
};

const insertQuickTag = (tag: string) => {
  inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
};

const handleUnload = () => {
  roomStore.leaveRoom();
};

watch(
  () => roomStore.myStatus,
  (newStatus) => {
    if (newStatus === 'kicked') {
      alert('You have been removed from the meeting by the host.');
      router.push('/');
    } else if (newStatus === 'left') {
      router.push('/');
    }
  }
);

onMounted(() => {
  window.addEventListener('beforeunload', handleUnload);
  roomStore.startFirestoreListener(roomId.value);
  // Ensure room state is loaded
  if (!roomStore.currentRoom) {
    const loaded = localStorage.getItem(`ai_room_${pin}`);
    if (loaded) {
      roomStore.currentRoom = JSON.parse(loaded);
    } else {
      roomStore.createRoom();
    }
  }
  if (roomStore.myStatus !== 'approved' && !roomStore.isHost) {
    router.push('/');
    return;
  }
  scrollToBottom();
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleUnload);
  roomStore.stopListening();
});
</script>

<template>
  <div class="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
    <!-- Top Navigation Bar -->
    <header class="h-14 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-3 sm:px-5 flex items-center justify-between z-10 shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <router-link
          to="/"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0"
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
            <span>Online: {{ roomStore.approvedParticipants.length }}</span>
            <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● Host</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          @click="copyInviteLink"
          class="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
        >
          <Check v-if="copiedUrl" class="w-3 h-3 text-emerald-400" />
          <Copy v-else class="w-3 h-3" />
          <span class="hidden sm:inline">{{ copiedUrl ? 'Copied!' : 'Copy Invite' }}</span>
        </button>

        <!-- Host Drawer Toggle Button -->
        <button
          @click="isDrawerOpen = true"
          class="relative inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold shadow transition"
        >
          <Sliders class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Controls</span>
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

    <!-- Chat Stream Area -->
    <main
      ref="chatContainerRef"
      class="flex-1 overflow-y-auto p-3 sm:p-5 space-y-3 max-w-4xl w-full mx-auto"
    >
      <div
        v-for="msg in roomStore.currentRoom?.messages"
        :key="msg.id"
        class="flex gap-2.5"
        :class="msg.senderUid === authStore.uid ? 'flex-row-reverse' : ''"
      >
        <!-- Avatar -->
        <div
          class="w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0 select-none shadow"
          :class="{
            'bg-sky-500/20 border border-sky-400/40': msg.senderUid === 'ai_mentor',
            'bg-slate-800 border border-slate-700': msg.senderUid !== 'ai_mentor' && msg.senderUid !== 'system',
            'bg-indigo-500/20 text-indigo-300': msg.senderUid === 'system'
          }"
        >
          {{ msg.senderAvatar }}
        </div>

        <!-- Message Body -->
        <div
          class="max-w-2xl flex flex-col"
          :class="msg.senderUid === authStore.uid ? 'items-end' : 'items-start'"
        >
          <!-- Sender info -->
          <div class="flex items-center gap-1.5 mb-0.5 text-[11px] text-slate-400">
            <span class="font-medium text-slate-300">{{ msg.senderName }}</span>
            <span
              v-if="msg.senderUid === 'ai_mentor'"
              class="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-1.5 py-0.2 rounded-md font-mono"
            >
              AI Mentor
            </span>
          </div>

          <!-- Bubble Content -->
          <div
            class="px-3.5 py-2 rounded-2xl text-sm leading-relaxed shadow"
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
                <FileText class="w-5 h-5 text-sky-400" />
                <span class="text-xs font-semibold text-slate-200">{{ msg.assetPayload?.title }}</span>
              </div>
              <button
                @click="openDocument(msg.assetPayload?.title, msg.assetPayload?.content)"
                class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium rounded-lg transition"
              >
                View Document
              </button>
            </div>
          </div>
        </div>
      </div>
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

        <!-- Input Bar -->
        <div class="flex items-center gap-2">
          <textarea
            v-model="inputMessage"
            @keydown.enter.prevent.exact="handleSend"
            @keydown.shift.enter.exact="inputMessage += '\n'"
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
  </div>
</template>
