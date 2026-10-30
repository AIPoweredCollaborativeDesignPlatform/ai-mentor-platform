<script setup lang="ts">
import { t } from '../../i18n';
import { computed } from 'vue';
import { Bot, Box, X } from 'lucide-vue-next';
import { useRoomStore } from '../../stores/room';
import { useAuthStore } from '../../stores/auth';
import { AI_TYPING_UIDS, formatTypingText } from '../../utils/chat';
import { useRoomAi } from '../../composables/useRoomAi';

const roomStore = useRoomStore();
const { aiEnabled, aiName } = useRoomAi();

const humanTypers = computed(() => roomStore.typingUsers.filter(u => !AI_TYPING_UIDS.includes(u.uid)));
const authStore = useAuthStore();
// A room-wide AI task (someone @mentioned the AI) or the AI's own check; shown as one chip
const activeTask = computed(() => (aiEnabled.value ? roomStore.currentRoom?.aiActiveTask : null));
const isAiThinking = computed(() => aiEnabled.value && (roomStore.isAnalyzing || Boolean(activeTask.value)));
const canStopTask = computed(() => !activeTask.value || activeTask.value.callerUid === authStore.uid || roomStore.isHost);

// One row of fixed height, always reserved: statuses appear and disappear without moving the chat
const chip = 'flex items-center gap-1.5 shrink-0 animate-fade-in';
const stopButton = 'ml-1 px-1.5 py-0.5 pointer-coarse:py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-rose-200 text-[10px] font-medium transition cursor-pointer flex items-center gap-0.5';
</script>

<template>
  <div class="h-7 shrink-0 w-full max-w-5xl mx-auto px-3 sm:px-5 flex items-center gap-4 overflow-x-auto no-scrollbar text-[11px] text-slate-400" aria-live="polite">
    <div v-if="humanTypers.length" :class="chip">
      <span class="text-sm leading-none">{{ humanTypers[0].avatar || '💬' }}</span>
      <span class="truncate max-w-[60vw] sm:max-w-none">{{ formatTypingText(humanTypers) }}</span>
      <span class="flex gap-0.5 items-center">
        <span v-for="d in [0, 150, 300]" :key="d" class="w-1 h-1 rounded-full bg-slate-500 animate-pulse" :style="{ animationDelay: `${d}ms` }"></span>
      </span>
    </div>

    <div v-if="isAiThinking" :class="chip">
      <Bot class="w-3.5 h-3.5 text-slate-500" />
      <span>{{ activeTask?.callerName ? t('composer.aiRespondingTo', { name: aiName, caller: activeTask.callerName }) : t('status.aiThinking', { name: aiName }) }}</span>
      <button v-if="canStopTask" @click="roomStore.abortCurrentAiGeneration()" :class="stopButton" :title="t('status.interruptAi')">
        <X class="w-3 h-3" /> {{ t('common.stop') }}
      </button>
    </div>

    <div v-if="aiEnabled && roomStore.isGenerating3D" :class="chip">
      <Box class="w-3.5 h-3.5 text-slate-500" />
      <span>{{ roomStore.generating3DStatus || t('status.generating3D') }}</span>
      <button @click="roomStore.abortCurrentAiGeneration()" :class="stopButton" :title="t('status.cancel3D')">
        <X class="w-3 h-3" /> {{ t('common.stop') }}
      </button>
    </div>
  </div>
</template>
