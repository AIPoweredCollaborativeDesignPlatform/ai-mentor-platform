<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Diamond } from 'lucide-vue-next';
import { t, type MessageKey } from '../../i18n';
import { useRoomStore } from '../../stores/room';
import { useRoomAi } from '../../composables/useRoomAi';
import type { DesignStage } from '../../types';

/**
 * Double Diamond display, drawn vertically in the empty margin beside the chat (no background).
 * Where the margin is too narrow it folds into a small button with a popover. Stage and milestones
 * come from the AI's assessments (rooms/{id}.progress, functions/src/engine.js updateProgress).
 * The parent must be position: relative; this component takes no space in the layout.
 */
const roomStore = useRoomStore();
const { aiEnabled } = useRoomAi();
const progress = computed(() => roomStore.currentRoom?.progress);
const visible = computed(() => aiEnabled.value && !!roomStore.currentRoom?.session);

// Vertical diamonds in a 40 x 240 box: discover / define, then develop / deliver
const STAGES: { key: DesignStage; label: MessageKey; points: string; y: number }[] = [
  { key: 'discover', label: 'dd.discover', points: '20,2 38,60 2,60', y: 36 },
  { key: 'define', label: 'dd.define', points: '2,60 38,60 20,118', y: 84 },
  { key: 'develop', label: 'dd.develop', points: '20,122 38,180 2,180', y: 156 },
  { key: 'deliver', label: 'dd.deliver', points: '2,180 38,180 20,238', y: 204 }
];
const NODES: { y: number; label: MessageKey; reached: () => boolean }[] = [
  { y: 60, label: 'dd.nodePain', reached: () => !!progress.value?.milestones?.pain_points },
  { y: 120, label: 'dd.nodeProblem', reached: () => !!progress.value?.milestones?.problem_statement },
  { y: 180, label: 'dd.nodeIdeas', reached: () => !!progress.value?.milestones?.ideas },
  { y: 236, label: 'dd.nodeConcept', reached: () => !!(progress.value?.milestones?.concept_selected && progress.value?.milestones?.model3d) }
];
const stage = computed(() => STAGES.find(s => s.key === progress.value?.stage) || null);
const nextNode = computed(() => NODES.find(n => !n.reached()) || null);

// Width of the margin left of the centred chat column (max-w-5xl = 1024px)
const root = ref<HTMLElement | null>(null);
const margin = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  const parent = root.value?.parentElement;
  if (!parent) return;
  observer = new ResizeObserver(([e]) => (margin.value = (e.contentRect.width - 1024) / 2));
  observer.observe(parent);
});
onUnmounted(() => observer?.disconnect());
const RAIL_WIDTH = 132;
const wide = computed(() => margin.value >= RAIL_WIDTH);
const open = ref(false);
</script>

<template>
  <div v-if="visible" ref="root" class="absolute top-3 left-3 z-10 text-slate-400">
    <button
      v-if="!wide"
      type="button"
      @click="open = !open"
      class="inline-flex items-center gap-1.5 px-2 py-1 pointer-coarse:py-1.5 rounded-full border border-slate-700 bg-slate-950/80 text-[11px]"
      :title="t('dd.title')"
    >
      <Diamond class="w-3.5 h-3.5" :class="stage ? 'text-sky-400' : ''" />
      <span>{{ stage ? t(stage.label) : t('dd.notYet') }}</span>
    </button>

    <div
      v-if="wide || open"
      :class="wide ? 'w-[120px]' : 'mt-1.5 w-[200px] p-3 rounded-xl border border-slate-700 bg-slate-950/95 shadow-xl'"
    >
      <div class="text-[11px] font-semibold text-slate-300 mb-1.5">{{ t('dd.title') }}</div>
      <div class="relative h-[240px]">
        <svg viewBox="0 0 40 240" class="absolute left-0 top-0 w-10 h-[240px]" role="img" :aria-label="t('dd.title')">
          <polygon
            v-for="s in STAGES"
            :key="s.key"
            :points="s.points"
            stroke-width="1"
            :class="stage?.key === s.key ? 'fill-sky-500/30 stroke-sky-400' : 'fill-transparent stroke-slate-600'"
          />
          <circle
            v-for="n in NODES"
            :key="n.y"
            cx="20"
            :cy="n.y"
            r="3.5"
            stroke-width="1.5"
            :class="n.reached() ? 'fill-emerald-500 stroke-emerald-500' : 'fill-slate-950 stroke-slate-500'"
          >
            <title>{{ t(n.label) }}</title>
          </circle>
        </svg>
        <span
          v-for="s in STAGES"
          :key="s.key"
          class="absolute left-12 -translate-y-1/2 text-[11px]"
          :class="stage?.key === s.key ? 'text-sky-300 font-semibold' : ''"
          :style="{ top: `${s.y}px` }"
        >{{ t(s.label) }}</span>
      </div>
      <p class="mt-2 text-[10px] leading-snug">
        <template v-if="nextNode">{{ t('dd.next') }}<span class="text-slate-200">{{ t(nextNode.label) }}</span></template>
        <span v-else class="text-emerald-300">{{ t('dd.allReached') }}</span>
      </p>
      <p class="mt-1 text-[10px] leading-snug text-slate-500">{{ t('dd.hint') }}</p>
    </div>
  </div>
</template>
