<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, ChevronUp } from 'lucide-vue-next';
import { t, type MessageKey } from '../../i18n';
import { useRoomStore } from '../../stores/room';
import { useRoomAi } from '../../composables/useRoomAi';
import type { DesignStage } from '../../types';

/**
 * Double Diamond display above the chat. Stage and milestones come from the AI's assessments
 * (rooms/{id}.progress, functions/src/engine.js updateProgress); no percentages on purpose.
 */
const props = defineProps<{ compact: boolean }>();

const roomStore = useRoomStore();
const { aiEnabled } = useRoomAi();
const progress = computed(() => roomStore.currentRoom?.progress);
const visible = computed(() => aiEnabled.value && !!roomStore.currentRoom?.session);

const STAGES: { key: DesignStage; label: MessageKey; points: string }[] = [
  { key: 'discover', label: 'dd.discover', points: '2,20 60,2 60,38' },
  { key: 'define', label: 'dd.define', points: '60,2 118,20 60,38' },
  { key: 'develop', label: 'dd.develop', points: '122,20 180,2 180,38' },
  { key: 'deliver', label: 'dd.deliver', points: '180,2 238,20 180,38' }
];
const NODES: { x: number; label: MessageKey; reached: () => boolean }[] = [
  { x: 60, label: 'dd.nodePain', reached: () => !!progress.value?.milestones?.pain_points },
  { x: 120, label: 'dd.nodeProblem', reached: () => !!progress.value?.milestones?.problem_statement },
  { x: 180, label: 'dd.nodeIdeas', reached: () => !!progress.value?.milestones?.ideas },
  { x: 238, label: 'dd.nodeConcept', reached: () => !!(progress.value?.milestones?.concept_selected && progress.value?.milestones?.model3d) }
];

const stage = computed(() => STAGES.find(s => s.key === progress.value?.stage) || null);
const nextNode = computed(() => NODES.find(n => !n.reached()) || null);

// Remembered per browser; phones and portrait tablets start collapsed
const STORAGE_KEY = 'ai_mentor_progress_open';
const readOpen = () => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? !props.compact : v === 'true';
  } catch {
    return !props.compact;
  }
};
const open = ref(readOpen());
const toggle = () => {
  open.value = !open.value;
  try {
    localStorage.setItem(STORAGE_KEY, String(open.value));
  } catch {
    // private mode: keep it for this visit only
  }
};
</script>

<template>
  <div v-if="visible" class="shrink-0 border-b border-slate-800 bg-slate-900/60 text-slate-400">
    <button type="button" @click="toggle" class="w-full max-w-5xl mx-auto flex items-center gap-2 px-3 sm:px-5 py-1.5 pointer-coarse:py-2 text-[11px] text-left">
      <span class="font-semibold text-slate-300">{{ t('dd.title') }}</span>
      <span>{{ stage ? t(stage.label) : t('dd.notYet') }}</span>
      <span class="inline-flex gap-1" :title="t('dd.nodesHint')">
        <span v-for="n in NODES" :key="n.x" class="w-1.5 h-1.5 rounded-full" :class="n.reached() ? 'bg-emerald-500' : 'border border-slate-600'"></span>
      </span>
      <component :is="open ? ChevronUp : ChevronDown" class="w-3.5 h-3.5 ml-auto shrink-0" />
    </button>

    <div v-if="open" class="max-w-5xl mx-auto px-3 sm:px-5 pb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <div class="w-[240px] shrink-0">
        <svg viewBox="0 0 240 40" class="w-full h-10" role="img" :aria-label="t('dd.title')">
          <polygon
            v-for="s in STAGES"
            :key="s.key"
            :points="s.points"
            stroke-width="1"
            :class="stage?.key === s.key ? 'fill-sky-500/30 stroke-sky-400' : 'fill-transparent stroke-slate-600'"
          />
          <circle
            v-for="n in NODES"
            :key="n.x"
            :cx="n.x"
            cy="20"
            r="3.5"
            stroke-width="1.5"
            :class="n.reached() ? 'fill-emerald-500 stroke-emerald-500' : 'fill-slate-900 stroke-slate-500'"
          >
            <title>{{ t(n.label) }}</title>
          </circle>
        </svg>
        <div class="grid grid-cols-4 text-center text-[10px] leading-tight">
          <span v-for="s in STAGES" :key="s.key" :class="stage?.key === s.key ? 'text-sky-300 font-semibold' : ''">{{ t(s.label) }}</span>
        </div>
      </div>
      <div class="min-w-0 flex-1 text-[11px] leading-relaxed">
        <p v-if="nextNode">{{ t('dd.next') }}<span class="text-slate-200">{{ t(nextNode.label) }}</span></p>
        <p v-else class="text-emerald-300">{{ t('dd.allReached') }}</p>
        <p class="text-[10px] text-slate-500">{{ t('dd.hint') }}</p>
      </div>
    </div>
  </div>
</template>
