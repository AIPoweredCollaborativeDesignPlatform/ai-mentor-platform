<script setup lang="ts">
import { ref } from 'vue';
import { AlertCircle, ArrowLeft, Bell, BellOff, Box, Check, Copy, Edit3, Lock, Sliders, Sparkles, WifiOff } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';
import { useNotificationSound } from '../../composables/useNotificationSound';

const props = defineProps<{
  pin: string;
  isMeetingClosed: boolean;
  isSettingsOpen: boolean;
  isAssetsOpen: boolean;
}>();
const emit = defineEmits<{
  (e: 'toggle-settings'): void;
  (e: 'toggle-assets'): void;
  (e: 'open-profile'): void;
}>();

const authStore = useAuthStore();
const roomStore = useRoomStore();
const { isSoundMuted, toggleSoundMute } = useNotificationSound();

const copiedUrl = ref(false);
const copyInviteLink = () => {
  navigator.clipboard.writeText(`${window.location.origin}/#/waiting/room_${props.pin}`);
  copiedUrl.value = true;
  setTimeout(() => (copiedUrl.value = false), 2000);
};

const AI_STATUS_CLASS: Record<string, string> = {
  idle: 'bg-sky-950/50 border-sky-500/40 text-sky-300 hover:bg-sky-900/50',
  analyzing: 'bg-amber-950/60 border-amber-500/50 text-amber-300 animate-pulse',
  cooldown: 'bg-slate-900 border-slate-700 text-slate-400',
  error: 'bg-rose-950/60 border-rose-500/50 text-rose-300'
};

const pillButton = 'inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 transition cursor-pointer min-h-[36px]';
</script>

<template>
  <!-- Read-only notice when the host has closed the meeting -->
  <div
    v-if="isMeetingClosed"
    class="bg-amber-950/70 border-b border-amber-500/30 px-3 sm:px-4 py-2 text-center text-xs text-amber-300 flex items-center justify-center gap-1.5 shrink-0 z-40 relative"
  >
    <Lock class="w-3.5 h-3.5 text-amber-400 shrink-0" />
    <span class="truncate">Meeting closed by host (Read-only).</span>
    <button v-if="roomStore.isHost" @click="emit('toggle-settings')" class="underline font-semibold hover:text-white ml-1 cursor-pointer shrink-0">
      Reopen
    </button>
  </div>

  <header class="h-14 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-2.5 sm:px-5 flex items-center justify-between z-40 shrink-0 gap-2 relative">
    <div class="flex items-center gap-1.5 sm:gap-2 min-w-0">
      <router-link
        :to="authStore.isGoogleLinked ? '/dashboard' : '/'"
        class="p-2 sm:p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0"
        :title="authStore.isGoogleLinked ? 'Back to Dashboard' : 'Back to Home'"
      >
        <ArrowLeft class="w-4 h-4" />
      </router-link>

      <div class="min-w-0">
        <div
          class="flex items-center gap-1.5 cursor-pointer group"
          @click="emit('toggle-settings')"
          :title="roomStore.isHost ? 'Click to edit room name & avatar in Settings' : 'Room settings'"
        >
          <span class="text-base sm:text-lg select-none shrink-0 group-hover:scale-110 transition-transform">{{ roomStore.currentRoom?.roomEmoji || '💡' }}</span>
          <h1 class="font-bold text-xs sm:text-base text-white truncate max-w-[110px] xs:max-w-[160px] sm:max-w-xs group-hover:text-sky-300 transition-colors">
            {{ roomStore.currentRoom?.roomName || 'Meeting' }}
          </h1>
          <Edit3 v-if="roomStore.isHost" class="w-3 h-3 text-slate-500 group-hover:text-sky-400 hidden sm:inline transition-colors shrink-0" />
          <span class="font-mono text-[10px] sm:text-[11px] px-1.5 sm:px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-sky-400 shrink-0">
            {{ pin }}
          </span>
          <span v-if="isMeetingClosed" class="text-[9px] sm:text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded-full font-medium shrink-0">
            Archived
          </span>
        </div>
        <div class="text-[10px] sm:text-[11px] text-slate-400 flex items-center gap-1.5 sm:gap-2">
          <span class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            {{ roomStore.onlineParticipants.length }} / {{ roomStore.approvedParticipants.length }} Online
          </span>
          <span v-if="roomStore.isHost" class="text-amber-400 font-medium">● Host</span>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-1 sm:gap-1.5 shrink-0">
      <div
        v-if="!roomStore.isOnline"
        class="flex items-center gap-1 px-2 py-1 rounded-full bg-rose-950/80 border border-rose-500/50 text-[10px] text-rose-300 font-medium animate-pulse"
        title="Network offline"
      >
        <WifiOff class="w-3 h-3 text-rose-400" />
        <span class="hidden xs:inline">Offline</span>
      </div>

      <!-- AI status capsule -->
      <button
        @click="emit('toggle-settings')"
        class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition cursor-pointer"
        :class="AI_STATUS_CLASS[roomStore.aiStatus]"
        :title="'AI Mentor: ' + roomStore.aiStatusDetail + ' (Click to configure)'"
      >
        <Sparkles v-if="roomStore.aiStatus === 'idle'" class="w-3 h-3 text-sky-400" />
        <span v-else-if="roomStore.aiStatus === 'analyzing'" class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
        <span v-else-if="roomStore.aiStatus === 'cooldown'" class="text-[10px]">⏳</span>
        <AlertCircle v-else class="w-3 h-3 text-rose-400" />
        <span class="max-w-[130px] truncate text-[11px]">{{ roomStore.aiStatusDetail }}</span>
      </button>

      <button
        @click="emit('open-profile')"
        class="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition text-xs cursor-pointer min-h-[36px]"
        title="Change name or avatar"
      >
        <span class="text-sm">{{ authStore.avatar }}</span>
        <span class="hidden sm:inline font-medium truncate max-w-[80px]">{{ authStore.displayName }}</span>
        <Edit3 class="w-3 h-3 text-slate-400 hidden sm:inline" />
      </button>

      <button @click="copyInviteLink" :class="[pillButton, 'text-slate-200']" title="Copy invite link">
        <Check v-if="copiedUrl" class="w-3.5 h-3.5 text-emerald-400" />
        <Copy v-else class="w-3.5 h-3.5" />
        <span class="hidden sm:inline">{{ copiedUrl ? 'Copied!' : 'Invite' }}</span>
      </button>

      <button
        @click="toggleSoundMute"
        :class="[pillButton, isSoundMuted ? 'text-slate-500' : 'text-sky-400']"
        :title="isSoundMuted ? 'Notification sound: Muted (Click to unmute)' : 'Notification sound: Active (Click to mute)'"
      >
        <BellOff v-if="isSoundMuted" class="w-3.5 h-3.5" />
        <Bell v-else class="w-3.5 h-3.5" />
      </button>

      <button
        @click="emit('toggle-assets')"
        class="relative inline-flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border transition cursor-pointer min-h-[36px]"
        :class="isAssetsOpen ? 'border-amber-500/60 bg-amber-500/20 text-amber-300 shadow-xs' : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-amber-400 font-medium'"
        title="Assets Library"
      >
        <Box class="w-3.5 h-3.5" />
        <span class="hidden sm:inline">Assets</span>
      </button>

      <button
        @click="emit('toggle-settings')"
        class="relative inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg font-semibold shadow transition cursor-pointer min-h-[36px]"
        :class="isSettingsOpen ? 'bg-sky-500 text-white ring-2 ring-sky-400/40 shadow-md' : 'bg-sky-600 hover:bg-sky-500 text-white'"
        title="Room Settings & Members"
      >
        <Sliders class="w-3.5 h-3.5" />
        <span class="hidden sm:inline">Settings</span>
        <span
          v-if="roomStore.pendingParticipants.length > 0"
          class="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-slate-950 font-bold text-[9px] rounded-full flex items-center justify-center animate-bounce shadow-md"
        >
          {{ roomStore.pendingParticipants.length }}
        </span>
      </button>
    </div>
  </header>
</template>
