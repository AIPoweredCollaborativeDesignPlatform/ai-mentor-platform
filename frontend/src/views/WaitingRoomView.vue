<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import { Clock, ShieldAlert, ArrowLeft, RotateCcw, Sparkles, LogIn, Edit2, Check } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');

const isCheckingRoom = ref(true);
const roomExists = ref(true);
const targetRoomName = ref('');
const isEditingIdentity = ref(false);
const customName = ref(authStore.displayName);
const customAvatar = ref(authStore.avatar);

const avatarOptions = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];

let hasApplied = false;

// Random friendly English name generator if user is generic Guest
const generateFriendlyIdentity = () => {
  if (authStore.displayName === 'Guest' || !authStore.displayName) {
    const adjectives = ['Anonymous', 'Curious', 'Clever', 'Creative', 'Swift', 'Cosmic', 'Bold', 'Bright'];
    const nouns = ['Rocket', 'Falcon', 'Owl', 'Fox', 'Panda', 'Otter', 'Eagle', 'Dolphin'];
    const emojis = ['🚀', '🦅', '🦉', '🦊', '🐼', '🦦', '⚡', '🐬'];
    const randIdx = Math.floor(Math.random() * adjectives.length);
    const randName = `${adjectives[randIdx]} ${nouns[randIdx]}`;
    const randAvatar = emojis[randIdx];
    authStore.updateProfile(randName, randAvatar);
    customName.value = randName;
    customAvatar.value = randAvatar;
  }
};

const checkStatus = () => {
  if (!roomExists.value) return;

  if (roomStore.currentRoom) {
    targetRoomName.value = roomStore.currentRoom.roomName || targetRoomName.value;
    const me = roomStore.currentRoom.participants?.[authStore.uid];
    if (me) {
      if (me.status === 'approved') {
        roomStore.myStatus = 'approved';
        router.replace(`/room/${roomId.value}`);
      } else if (me.status === 'rejected') {
        roomStore.myStatus = 'rejected';
      } else if (me.status === 'kicked') {
        roomStore.myStatus = 'kicked';
      }
    } else {
      // User is not in participants list, auto-apply once auth is ready
      if (authStore.uid && !hasApplied) {
        hasApplied = true;
        roomStore.applyToJoin(pin).catch((err) => {
          console.error(err);
        });
      }
    }
  }
};

const handleSaveIdentity = () => {
  if (customName.value.trim()) {
    authStore.updateProfile(customName.value.trim(), customAvatar.value);
  }
  isEditingIdentity.value = false;
  // If already in room as pending, re-apply with new name
  if (hasApplied) {
    roomStore.applyToJoin(pin);
  }
};

const handleGoogleSignIn = async () => {
  try {
    await authStore.upgradeWithGoogle();
    customName.value = authStore.displayName;
    customAvatar.value = authStore.avatar;
    roomStore.applyToJoin(pin);
  } catch (err: any) {
    alert(`Sign-in error: ${err.message || err}`);
  }
};

const handleReapply = async () => {
  hasApplied = true;
  roomStore.myStatus = 'pending';
  await roomStore.reapplyToJoin(pin);
};

watch(() => roomStore.myStatus, (newStatus) => {
  if (newStatus === 'approved') {
    router.replace(`/room/${roomId.value}`);
  }
});

watch(() => roomStore.currentRoom, () => {
  checkStatus();
}, { deep: true });

watch(() => authStore.uid, (newUid) => {
  if (newUid && roomExists.value && !hasApplied) {
    checkStatus();
  }
});

onMounted(async () => {
  generateFriendlyIdentity();
  
  // Verify room exists first!
  const check = await roomStore.checkRoomExists(pin);
  isCheckingRoom.value = false;
  if (!check.exists) {
    roomExists.value = false;
    return;
  }
  targetRoomName.value = check.roomName || `Meeting ${pin}`;
  
  roomStore.startFirestoreListener(roomId.value);
  setTimeout(checkStatus, 600);
});

onUnmounted(() => {
  roomStore.stopListening();
});
</script>

<template>
  <div class="h-screen flex items-center justify-center p-4 bg-slate-950">
    <!-- Checking room loading state -->
    <div v-if="isCheckingRoom" class="text-center">
      <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
      <p class="text-xs text-slate-400">Verifying meeting room...</p>
    </div>

    <!-- Room Not Found State -->
    <div v-else-if="!roomExists" class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center">
      <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center text-rose-400">
        <ShieldAlert class="w-7 h-7" />
      </div>
      <h2 class="text-lg font-bold text-white mb-2">Meeting Not Found</h2>
      <p class="text-sm text-slate-400 mb-6 leading-relaxed">
        Meeting room <span class="font-mono text-rose-400 font-semibold">{{ pin }}</span> does not exist or has been ended.
      </p>
      <router-link
        to="/"
        class="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition inline-flex items-center gap-2 shadow"
      >
        <ArrowLeft class="w-4 h-4" /> Back to Home
      </router-link>
    </div>

    <!-- Main Card -->
    <div v-else class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl text-center">
      <!-- Pending Status -->
      <div v-if="roomStore.myStatus !== 'rejected' && roomStore.myStatus !== 'kicked'">
        <div class="relative w-20 h-20 mx-auto mb-4 flex items-center justify-center">
          <div class="absolute inset-0 rounded-full bg-sky-500/20 animate-ping"></div>
          <div class="relative z-10 w-16 h-16 rounded-full bg-slate-800 border-2 border-sky-500/50 flex items-center justify-center text-3xl shadow-lg">
            {{ authStore.avatar }}
          </div>
        </div>

        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-semibold mb-3">
          <Clock class="w-3.5 h-3.5 animate-spin" /> Waiting Room
        </div>

        <h2 class="text-xl font-bold text-white mb-1.5">
          Waiting for host approval...
        </h2>
        <p class="text-xs sm:text-sm text-slate-400 leading-relaxed mb-5">
          You've requested to join <span class="text-white font-semibold">"{{ targetRoomName || roomStore.currentRoom?.roomName || 'Meeting' }}"</span> (<span class="font-mono text-sky-400 font-semibold">{{ pin }}</span>).<br />
          You'll be redirected automatically once the host approves.
        </p>

        <!-- Identity Card with Edit Capability -->
        <div class="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800 mb-5 text-left">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-medium text-slate-400">Your Identity</span>
            <button
              v-if="!isEditingIdentity"
              @click="isEditingIdentity = true"
              class="text-[11px] text-sky-400 hover:text-sky-300 transition flex items-center gap-1"
            >
              <Edit2 class="w-3 h-3" /> Change
            </button>
          </div>

          <!-- Edit View -->
          <div v-if="isEditingIdentity" class="space-y-3 pt-1">
            <div class="flex items-center gap-2">
              <span class="text-2xl p-1 bg-slate-800 rounded-lg border border-slate-700 shrink-0">{{ customAvatar }}</span>
              <input
                v-model="customName"
                type="text"
                maxlength="20"
                class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                placeholder="Enter name..."
              />
            </div>
            <!-- Avatar Picker -->
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="av in avatarOptions"
                :key="av"
                @click="customAvatar = av"
                class="w-7 h-7 rounded-lg text-sm flex items-center justify-center transition border"
                :class="customAvatar === av ? 'bg-sky-500/20 border-sky-400' : 'bg-slate-900 border-slate-800 hover:border-slate-700'"
              >
                {{ av }}
              </button>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <button
                @click="isEditingIdentity = false"
                class="px-2.5 py-1 text-xs text-slate-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                @click="handleSaveIdentity"
                class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg transition flex items-center gap-1 shadow"
              >
                <Check class="w-3 h-3" /> Save
              </button>
            </div>
          </div>

          <!-- Normal Display View -->
          <div v-else class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xl">{{ authStore.avatar }}</span>
              <div>
                <span class="text-sm font-semibold text-slate-200">{{ authStore.displayName }}</span>
                <span v-if="authStore.isGoogleLinked" class="text-[10px] text-emerald-400 ml-2">● Google Verified</span>
              </div>
            </div>
            <span class="text-xs text-amber-400 font-mono bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">Pending</span>
          </div>

          <!-- Google Sign-in Option if Guest -->
          <div v-if="!authStore.isGoogleLinked && !isEditingIdentity" class="mt-3 pt-2.5 border-t border-slate-800/80">
            <button
              @click="handleGoogleSignIn"
              class="w-full py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium transition flex items-center justify-center gap-1.5"
            >
              <LogIn class="w-3.5 h-3.5 text-sky-400" /> Sign in with Google instead
            </button>
          </div>
        </div>

        <router-link
          to="/"
          class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
        >
          <ArrowLeft class="w-3.5 h-3.5" /> Cancel and go back
        </router-link>
      </div>

      <!-- Rejected or Kicked Status -->
      <div v-else>
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center text-rose-400">
          <ShieldAlert class="w-7 h-7" />
        </div>
        <h2 class="text-lg font-bold text-white mb-2">
          {{ roomStore.myStatus === 'kicked' ? 'Removed from Meeting' : 'Request Declined' }}
        </h2>
        <p class="text-sm text-slate-400 mb-6 leading-relaxed">
          {{ roomStore.myStatus === 'kicked'
            ? 'The host removed you from this meeting.'
            : 'The host has declined your request to join this meeting.' }}
        </p>
        <div class="flex flex-col sm:flex-row items-center justify-center gap-2.5">
          <button
            @click="handleReapply"
            class="w-full sm:w-auto px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition inline-flex items-center justify-center gap-1.5 shadow"
          >
            <RotateCcw class="w-3.5 h-3.5" /> Request to Join Again
          </button>
          <router-link
            to="/"
            class="w-full sm:w-auto px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition inline-flex items-center justify-center gap-1.5"
          >
            <ArrowLeft class="w-3.5 h-3.5" /> Back to Home
          </router-link>
        </div>
      </div>
    </div>
  </div>
</template>
