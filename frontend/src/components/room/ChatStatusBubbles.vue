<script setup lang="ts">
import { t } from '../../i18n';
import { computed } from 'vue';
import { X } from 'lucide-vue-next';
import { useRoomStore } from '../../stores/room';
import { AI_TYPING_UIDS, formatTypingText } from '../../utils/chat';
import { useRoomAi } from '../../composables/useRoomAi';

const roomStore = useRoomStore();
const { aiEnabled, aiName } = useRoomAi();

const humanTypers = computed(() => roomStore.typingUsers.filter(u => !AI_TYPING_UIDS.includes(u.uid)));
const isAiThinking = computed(() => aiEnabled.value && roomStore.isAnalyzing);

const bubble = 'flex items-center gap-3 px-3.5 py-2 rounded-2xl text-xs w-fit animate-fade-in my-2 ml-1';
const stopButton = 'ml-2 px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-white text-[11px] font-medium transition cursor-pointer flex items-center gap-1';
</script>

<template>
  <div v-if="isAiThinking" :class="[bubble, 'bg-slate-900/90 border border-sky-500/40 text-slate-200 shadow-xl']">
    <span class="text-base leading-none animate-pulse">✨</span>
    <span class="font-medium text-sky-300">{{ aiName }} is thinking...</span>
    <span class="flex gap-1 items-center ml-0.5">
      <span v-for="d in [0, 150, 300]" :key="d" class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" :style="{ animationDelay: `${d}ms` }"></span>
    </span>
    <button @click="roomStore.abortCurrentAiGeneration()" :class="stopButton" :title="t('status.interruptAi')">
      <X class="w-3 h-3" /> Stop
    </button>
  </div>

  <div v-if="humanTypers.length" :class="[bubble, 'gap-2.5 bg-slate-900/90 border border-slate-800 text-slate-300 shadow-sm']">
    <span class="text-base leading-none">{{ humanTypers[0].avatar || '💬' }}</span>
    <span class="font-medium text-slate-200">{{ formatTypingText(humanTypers) }}</span>
    <span class="flex gap-1 items-center ml-1">
      <span v-for="d in [0, 150, 300]" :key="d" class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" :style="{ animationDelay: `${d}ms` }"></span>
    </span>
  </div>

  <div v-if="aiEnabled && roomStore.isGenerating3D" :class="[bubble, 'bg-indigo-900/60 border border-indigo-500/50 text-indigo-200 shadow-xl']">
    <span class="text-base leading-none animate-pulse">🎨</span>
    <span class="font-medium text-indigo-100">{{ roomStore.generating3DStatus || t('status.generating3D') }}</span>
    <span class="flex gap-1 items-center ml-0.5">
      <span v-for="d in [0, 150, 300]" :key="d" class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" :style="{ animationDelay: `${d}ms` }"></span>
    </span>
    <button @click="roomStore.abortCurrentAiGeneration()" :class="stopButton" :title="t('status.cancel3D')">
      <X class="w-3 h-3" /> Stop
    </button>
  </div>
</template>
