<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import {
  Sparkles,
  Users,
  LogIn,
  KeyRound,
  ShieldAlert,
  ArrowRight,
  LayoutDashboard,
  Database
} from 'lucide-vue-next';
import FirebaseConfigModal from '../components/FirebaseConfigModal.vue';

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const pinInput = ref('');
const inputName = ref(authStore.displayName);
const selectedAvatar = ref(authStore.avatar);
const errorMsg = ref('');
const isFirebaseModalOpen = ref(false);
const isLoading = ref(false);

const avatarChoices = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡'];

const selectAvatar = (av: string) => {
  selectedAvatar.value = av;
};

const handleSaveProfile = () => {
  if (inputName.value.trim()) {
    authStore.updateProfile(inputName.value.trim(), selectedAvatar.value);
  }
};

const handleCreateRoom = async () => {
  handleSaveProfile();
  isLoading.value = true;
  try {
    const newRoom = await roomStore.createRoom();
    router.push(`/room/${newRoom.roomId}`);
  } catch (err) {
    console.error(err);
  } finally {
    isLoading.value = false;
  }
};

const handleJoinRoom = async () => {
  handleSaveProfile();
  if (pinInput.value.trim().length !== 6) {
    errorMsg.value = '請輸入正確的 6 位數房間 PIN 碼';
    return;
  }
  errorMsg.value = '';
  const pin = pinInput.value.trim();
  isLoading.value = true;
  try {
    await roomStore.applyToJoin(pin);
    router.push(`/waiting/room_${pin}`);
  } catch (err) {
    console.error(err);
  } finally {
    isLoading.value = false;
  }
};

const handleGoogleSignIn = async () => {
  try {
    await authStore.upgradeWithGoogle();
  } catch (err: any) {
    if (err.code === 'auth/configuration-not-found' || err.message?.includes('api-key')) {
      isFirebaseModalOpen.value = true;
    } else {
      alert(`Google 登入提示: ${err.message || err}`);
    }
  }
};
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 relative">
    <!-- Top Right Cloud Config Button -->
    <div class="absolute top-4 right-4 sm:top-6 sm:right-6">
      <button
        @click="isFirebaseModalOpen = true"
        class="inline-flex items-center gap-1.5 text-xs px-3.5 py-1.5 rounded-xl border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition backdrop-blur-md shadow"
      >
        <Database class="w-3.5 h-3.5 text-sky-400" />
        <span>{{ authStore.isConfigured ? 'Firebase 已連線' : '配置 Firebase' }}</span>
        <span
          class="w-2 h-2 rounded-full"
          :class="authStore.isConfigured ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'"
        ></span>
      </button>
    </div>

    <!-- Brand / Header -->
    <div class="text-center max-w-xl mb-8">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-400 text-xs font-semibold mb-4">
        <Sparkles class="w-3.5 h-3.5" /> GCA 群體對話中介平台
      </div>
      <h1 class="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-3">
        AI Mentor 協作平台
      </h1>
      <p class="text-slate-400 text-sm sm:text-base leading-relaxed">
        讓未知的設計關係現形。AI 作為背景調解者，在群體認知出現落差時以可視化 3D 與意向板介入引導。
      </p>
    </div>

    <!-- Main Card -->
    <div class="w-full max-w-lg bg-slate-900/90 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
      <!-- 1. 混合式無感身分驗證 (Guest Onboarding) -->
      <section class="mb-8">
        <div class="flex items-center justify-between mb-3">
          <label class="text-xs font-bold uppercase tracking-wider text-slate-400">
            訪客身分設定
          </label>
          <span class="text-[11px] text-amber-400/90 flex items-center gap-1">
            <ShieldAlert class="w-3.5 h-3.5" /> 訪客資料僅存於本機
          </span>
        </div>

        <div class="flex items-center gap-3 mb-4">
          <div class="text-3xl p-2 bg-slate-800 rounded-2xl border border-slate-700">
            {{ selectedAvatar }}
          </div>
          <input
            v-model="inputName"
            type="text"
            placeholder="請輸入暱稱..."
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
          />
        </div>

        <!-- Avatar Picker -->
        <div class="flex items-center justify-between gap-1 p-2 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-4">
          <button
            v-for="av in avatarChoices"
            :key="av"
            @click="selectAvatar(av)"
            class="p-2 rounded-lg text-lg hover:scale-125 transition"
            :class="{ 'bg-sky-500/20 ring-2 ring-sky-400': selectedAvatar === av }"
          >
            {{ av }}
          </button>
        </div>

        <!-- Google Upgrade Button -->
        <div v-if="!authStore.isGoogleLinked" class="pt-2 border-t border-slate-800/60 flex items-center justify-between">
          <span class="text-xs text-slate-400">解鎖跨裝置專案大廳與歷史資產？</span>
          <button
            @click="handleGoogleSignIn"
            class="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 font-medium px-3 py-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 transition"
          >
            <LogIn class="w-3.5 h-3.5" /> 一鍵升級 Google
          </button>
        </div>
        <div v-else class="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
          <span class="text-emerald-400 flex items-center gap-1">
            ✓ 已綁定 Google 帳號 ({{ authStore.email }})
          </span>
          <router-link to="/dashboard" class="text-sky-400 hover:underline flex items-center gap-1 font-semibold">
            <LayoutDashboard class="w-3.5 h-3.5" /> 專案大廳
          </router-link>
        </div>
      </section>

      <hr class="border-slate-800 mb-8" />

      <!-- 2. 房間發起與加入 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <!-- 發起會議 (成為 Host) -->
        <button
          @click="handleCreateRoom"
          :disabled="isLoading"
          class="flex flex-col justify-between p-5 rounded-2xl bg-gradient-to-br from-sky-600 to-indigo-700 hover:from-sky-500 hover:to-indigo-600 text-white shadow-lg transition duration-200 text-left group disabled:opacity-50"
        >
          <div>
            <div class="p-2.5 bg-white/10 rounded-xl w-fit mb-3">
              <Users class="w-5 h-5 text-white" />
            </div>
            <h3 class="font-bold text-base mb-1">發起新會議</h3>
            <p class="text-xs text-sky-100 opacity-90 leading-relaxed">
              自動成為主持人，取得 6 位 PIN 碼並可審核受邀者
            </p>
          </div>
          <div class="mt-4 flex items-center gap-1 text-xs font-semibold text-white group-hover:translate-x-1 transition">
            {{ isLoading ? '建立中...' : '即刻建立' }} <ArrowRight class="w-3.5 h-3.5" />
          </div>
        </button>

        <!-- 輸入 PIN 碼加入 (等候室受邀者) -->
        <div class="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 flex flex-col justify-between">
          <div>
            <div class="p-2.5 bg-slate-800 rounded-xl w-fit mb-3">
              <KeyRound class="w-5 h-5 text-slate-300" />
            </div>
            <h3 class="font-bold text-base text-slate-100 mb-1">受邀加入會議</h3>
            <p class="text-xs text-slate-400 mb-3">
              輸入 6 位 PIN 碼進入等候室
            </p>
            <input
              v-model="pinInput"
              type="text"
              maxlength="6"
              placeholder="例如: 849201"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-center text-base tracking-widest font-mono text-white placeholder-slate-600 focus:outline-none focus:border-sky-500"
            />
            <p v-if="errorMsg" class="text-[11px] text-rose-400 mt-1">{{ errorMsg }}</p>
          </div>
          <button
            @click="handleJoinRoom"
            :disabled="isLoading"
            class="mt-4 w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition disabled:opacity-50"
          >
            {{ isLoading ? '申請中...' : '申請進入等候室' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Firebase Config Modal -->
    <FirebaseConfigModal
      :isOpen="isFirebaseModalOpen"
      @close="isFirebaseModalOpen = false"
    />
  </div>
</template>
