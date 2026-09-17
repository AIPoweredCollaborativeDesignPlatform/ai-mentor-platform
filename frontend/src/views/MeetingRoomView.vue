<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
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
  Users,
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
  if (!inputMessage.value.trim()) return;
  const text = inputMessage.value;
  inputMessage.value = '';
  await roomStore.sendMessage(text);
  scrollToBottom();
};

const insertQuickTag = (tag: string) => {
  inputMessage.value = inputMessage.value ? `${inputMessage.value} ${tag} ` : `${tag} `;
};

// Simulate demo participant request for Host to test approval flow
const simulateApplicant = () => {
  if (!roomStore.currentRoom) return;
  const fakeUid = `guest_${Math.floor(Math.random() * 1000)}`;
  const names = ['林設計師', '陳客戶代表', '黃工程師', '張專案經理'];
  const avatars = ['👩‍🎨', '👨‍💼', '👷‍♂️', '👩‍💻'];
  const idx = Math.floor(Math.random() * names.length);

  roomStore.currentRoom.participants[fakeUid] = {
    uid: fakeUid,
    displayName: names[idx],
    avatar: avatars[idx],
    status: 'pending',
    isHost: false,
    joinedAt: Date.now()
  };
  roomStore.pushToast('新成員等候核准', `${names[idx]} 正在等候室申請加入`, 'warning');
};

onMounted(() => {
  // Ensure room state is loaded
  if (!roomStore.currentRoom) {
    const loaded = localStorage.getItem(`ai_room_${pin}`);
    if (loaded) {
      roomStore.currentRoom = JSON.parse(loaded);
    } else {
      roomStore.createRoom();
    }
  }
  scrollToBottom();
});
</script>

<template>
  <div class="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
    <!-- Top Navigation Bar -->
    <header class="h-16 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-10 shrink-0">
      <div class="flex items-center gap-3">
        <router-link
          to="/"
          class="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
          title="回首頁"
        >
          <ArrowLeft class="w-5 h-5" />
        </router-link>

        <div>
          <div class="flex items-center gap-2">
            <h1 class="font-bold text-base sm:text-lg text-white">AI Mentor 協同會議</h1>
            <span class="font-mono text-xs px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-sky-400">
              PIN: {{ pin }}
            </span>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-2">
            <span>在線: {{ roomStore.approvedParticipants.length }} 人</span>
            <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● 您是會議主持人</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="flex items-center gap-2">
        <!-- Test helper button for demo -->
        <button
          v-if="roomStore.isHost"
          @click="simulateApplicant"
          class="hidden sm:inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 transition"
          title="模擬一名新成員進入等候室以測試審核"
        >
          + 模擬成員申請
        </button>

        <button
          @click="copyInviteLink"
          class="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
        >
          <Check v-if="copiedUrl" class="w-3.5 h-3.5 text-emerald-400" />
          <Copy v-else class="w-3.5 h-3.5" />
          <span>{{ copiedUrl ? '已複製連結' : '複製邀請網址' }}</span>
        </button>

        <!-- Host Drawer Toggle Button -->
        <button
          @click="isDrawerOpen = true"
          class="relative inline-flex items-center gap-1.5 text-xs px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold shadow transition"
        >
          <Sliders class="w-3.5 h-3.5" />
          <span>控制台</span>
          <!-- Pending Badge -->
          <span
            v-if="roomStore.pendingParticipants.length > 0"
            class="absolute -top-1 -right-1 w-5 h-5 bg-amber-500 text-slate-950 font-bold text-[10px] rounded-full flex items-center justify-center animate-bounce shadow-md"
          >
            {{ roomStore.pendingParticipants.length }}
          </span>
        </button>
      </div>
    </header>

    <!-- Chat Stream Area -->
    <main
      ref="chatContainerRef"
      class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 max-w-4xl w-full mx-auto"
    >
      <div
        v-for="msg in roomStore.currentRoom?.messages"
        :key="msg.id"
        class="flex gap-3"
        :class="msg.senderUid === authStore.uid ? 'flex-row-reverse' : ''"
      >
        <!-- Avatar -->
        <div
          class="w-9 h-9 rounded-2xl flex items-center justify-center text-lg shrink-0 select-none shadow-md"
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
          <div class="flex items-center gap-1.5 mb-1 text-xs text-slate-400">
            <span class="font-medium text-slate-300">{{ msg.senderName }}</span>
            <span
              v-if="msg.senderUid === 'ai_mentor'"
              class="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/30 px-1.5 py-0.2 rounded-md font-mono"
            >
              GCA Mediator
            </span>
          </div>

          <!-- Bubble Content -->
          <div
            class="px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow"
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
                檢視完整文件
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Bottom Input & Triggers Bar -->
    <footer class="border-t border-slate-800 bg-slate-900/90 backdrop-blur-md p-3 sm:p-4 shrink-0">
      <div class="max-w-4xl mx-auto space-y-2">
        <!-- Quick Action Badges -->
        <div class="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs text-slate-400">
          <span class="text-[11px] text-slate-500 shrink-0">快捷調用:</span>
          <button
            @click="insertQuickTag('@Mentor')"
            class="px-2 py-0.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition flex items-center gap-1 shrink-0"
          >
            <Sparkles class="w-3 h-3" /> @Mentor
          </button>
          <button
            @click="insertQuickTag('請生成 3D 圓形茶几尺寸量體模型')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <Box class="w-3 h-3 text-sky-400" /> 3D 茶几原型
          </button>
          <button
            @click="insertQuickTag('需要現代極簡木質金屬的視覺意向板')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <Palette class="w-3 h-3 text-amber-400" /> 視覺意向板
          </button>
          <button
            @click="insertQuickTag('請總結目前為止的討論共識與會議紀錄')"
            class="px-2 py-0.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition flex items-center gap-1 shrink-0"
          >
            <FileText class="w-3 h-3 text-purple-400" /> 彙整會議紀要
          </button>
        </div>

        <!-- Input Bar -->
        <div class="flex items-center gap-2">
          <input
            v-model="inputMessage"
            @keydown.enter="handleSend"
            type="text"
            placeholder="輸入訊息參與討論，或使用 @Mentor 尋求設計視覺化引導..."
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
          />
          <button
            @click="handleSend"
            class="px-4 py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl font-semibold shadow transition flex items-center gap-1.5 shrink-0"
          >
            <Send class="w-4 h-4" />
            <span class="hidden sm:inline">發送</span>
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
