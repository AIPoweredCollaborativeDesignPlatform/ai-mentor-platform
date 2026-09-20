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
  ArrowRight,
  LayoutDashboard
} from 'lucide-vue-next';

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const pinInput = ref('');
const inputName = ref(authStore.displayName);
const selectedAvatar = ref(authStore.avatar);
const roomNameInput = ref('');
const errorMsg = ref('');
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
    const newRoom = await roomStore.createRoom(roomNameInput.value);
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
    errorMsg.value = 'Please enter a valid 6-digit room PIN';
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
    alert(`Sign-in error: ${err.message || err}`);
  }
};
</script>

<template>
  <div class="h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 overflow-hidden">
    <!-- Brand / Header -->
    <div class="text-center max-w-xl mb-5">
      <h1 class="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-1.5">
        <Sparkles class="w-5 h-5 sm:w-6 sm:h-6 inline-block text-sky-400 mr-1.5 -mt-1" />
        AI Mentor Platform
      </h1>
      <p class="text-slate-400 text-xs sm:text-sm">
        AI-assisted collaborative design meetings with real-time 3D visualization
      </p>
    </div>

    <!-- Main Card -->
    <div class="w-full max-w-lg bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-2xl backdrop-blur-xl">
      <!-- Guest Profile Setup -->
      <section class="mb-5">
        <div class="flex items-center gap-3 mb-3">
          <div class="text-2xl p-1.5 bg-slate-800 rounded-xl border border-slate-700">
            {{ selectedAvatar }}
          </div>
          <input
            v-model="inputName"
            type="text"
            placeholder="Enter your name..."
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
          />
        </div>

        <!-- Avatar Picker -->
        <div class="flex items-center justify-between gap-0.5 p-1.5 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-3">
          <button
            v-for="av in avatarChoices"
            :key="av"
            @click="selectAvatar(av)"
            class="p-1.5 rounded-lg text-base hover:scale-125 transition"
            :class="{ 'bg-sky-500/20 ring-2 ring-sky-400': selectedAvatar === av }"
          >
            {{ av }}
          </button>
        </div>

        <!-- Google Sign-in -->
        <div v-if="!authStore.isGoogleLinked" class="pt-2 border-t border-slate-800/60 flex items-center justify-between">
          <span class="text-xs text-slate-400">Sign in for cross-device sync</span>
          <button
            @click="handleGoogleSignIn"
            class="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 font-medium px-3 py-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 transition"
          >
            <LogIn class="w-3.5 h-3.5" /> Sign in with Google
          </button>
        </div>
        <div v-else class="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
          <span class="text-emerald-400 flex items-center gap-1">
            ✓ Signed in ({{ authStore.email }})
          </span>
          <router-link to="/dashboard" class="text-sky-400 hover:underline flex items-center gap-1 font-semibold">
            <LayoutDashboard class="w-3.5 h-3.5" /> Dashboard
          </router-link>
        </div>
      </section>

      <hr class="border-slate-800 mb-5" />

      <!-- Room Actions -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <!-- Create Room -->
        <div class="flex flex-col">
          <input
            v-model="roomNameInput"
            type="text"
            placeholder="Room name (optional)"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition mb-2"
          />
          <button
            @click="handleCreateRoom"
            :disabled="isLoading"
            class="flex-1 flex flex-col justify-between p-4 rounded-xl bg-gradient-to-br from-sky-600 to-indigo-700 hover:from-sky-500 hover:to-indigo-600 text-white shadow-lg transition text-left group disabled:opacity-50"
          >
            <div>
              <div class="p-2 bg-white/10 rounded-lg w-fit mb-2">
                <Users class="w-4 h-4 text-white" />
              </div>
              <h3 class="font-bold text-sm mb-0.5">Create Meeting</h3>
              <p class="text-[11px] text-sky-100 opacity-90">
                You'll be the host with a 6-digit PIN
              </p>
            </div>
            <div class="mt-3 flex items-center gap-1 text-xs font-semibold text-white group-hover:translate-x-1 transition">
              {{ isLoading ? 'Creating...' : 'Create Now' }} <ArrowRight class="w-3.5 h-3.5" />
            </div>
          </button>
        </div>

        <!-- Join Room -->
        <div class="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col justify-between">
          <div>
            <div class="p-2 bg-slate-800 rounded-lg w-fit mb-2">
              <KeyRound class="w-4 h-4 text-slate-300" />
            </div>
            <h3 class="font-bold text-sm text-slate-100 mb-0.5">Join Meeting</h3>
            <p class="text-[11px] text-slate-400 mb-2">
              Enter 6-digit PIN to request access
            </p>
            <input
              v-model="pinInput"
              type="text"
              maxlength="6"
              placeholder="e.g. 849201"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-center text-sm tracking-widest font-mono text-white placeholder-slate-600 focus:outline-none focus:border-sky-500"
            />
            <p v-if="errorMsg" class="text-[11px] text-rose-400 mt-1">{{ errorMsg }}</p>
          </div>
          <button
            @click="handleJoinRoom"
            :disabled="isLoading"
            class="mt-3 w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition disabled:opacity-50"
          >
            {{ isLoading ? 'Requesting...' : 'Request to Join' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
