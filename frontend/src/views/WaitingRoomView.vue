<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import { Clock, ShieldAlert, ArrowLeft } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const roomId = ref(route.params.roomId as string);
const pin = roomId.value.replace('room_', '');
let checkInterval: any = null;

const checkStatus = () => {
  const raw = localStorage.getItem(`ai_room_${pin}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const me = parsed.participants?.[authStore.uid];
      if (me) {
        if (me.status === 'approved') {
          roomStore.currentRoom = parsed;
          roomStore.myStatus = 'approved';
          router.replace(`/room/${roomId.value}`);
        } else if (me.status === 'rejected') {
          roomStore.myStatus = 'rejected';
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
};

watch(() => roomStore.myStatus, (newStatus) => {
  if (newStatus === 'approved') {
    router.replace(`/room/${roomId.value}`);
  }
});

onMounted(() => {
  roomStore.startFirestoreListener(roomId.value);
  checkStatus();
  checkInterval = setInterval(checkStatus, 1500);
});

onUnmounted(() => {
  if (checkInterval) clearInterval(checkInterval);
  roomStore.stopListening();
});
</script>

<template>
  <div class="h-screen flex items-center justify-center p-4 bg-slate-950">
    <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl text-center">
      <!-- Pending Status -->
      <div v-if="roomStore.myStatus !== 'rejected'">
        <div class="relative w-20 h-20 mx-auto mb-5 flex items-center justify-center">
          <div class="absolute inset-0 rounded-full bg-sky-500/20 animate-ping"></div>
          <div class="relative z-10 w-16 h-16 rounded-full bg-slate-800 border-2 border-sky-500/50 flex items-center justify-center text-3xl shadow-lg">
            {{ authStore.avatar }}
          </div>
        </div>

        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-semibold mb-3">
          <Clock class="w-3.5 h-3.5 animate-spin" /> Waiting Room
        </div>

        <h2 class="text-xl font-bold text-white mb-2">
          Waiting for host approval...
        </h2>
        <p class="text-sm text-slate-400 leading-relaxed mb-5">
          You've requested to join room <span class="font-mono text-sky-400 font-semibold">{{ pin }}</span>.<br />
          You'll be redirected automatically once the host approves.
        </p>

        <div class="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-5 text-left">
          <div class="text-xs text-slate-500 mb-1">Your identity</div>
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold text-slate-200">{{ authStore.displayName }}</span>
            <span class="text-xs text-amber-400 font-mono">Pending</span>
          </div>
        </div>

        <router-link
          to="/"
          class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
        >
          <ArrowLeft class="w-3.5 h-3.5" /> Cancel and go back
        </router-link>
      </div>

      <!-- Rejected Status -->
      <div v-else>
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center text-rose-400">
          <ShieldAlert class="w-7 h-7" />
        </div>
        <h2 class="text-lg font-bold text-white mb-2">Request Declined</h2>
        <p class="text-sm text-slate-400 mb-5">
          The host has declined your request to join this meeting.
        </p>
        <router-link
          to="/"
          class="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition inline-flex items-center gap-2"
        >
          <ArrowLeft class="w-4 h-4" /> Back to Home
        </router-link>
      </div>
    </div>
  </div>
</template>
