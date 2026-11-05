<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t, type MessageKey } from '../../i18n';
import { useRoomStore } from '../../stores/room';
import { useRoomAi } from '../../composables/useRoomAi';
import type { DesignStage } from '../../types';

/**
 * Double Diamond display, drawn vertically in the empty margin beside the chat (no background).
 * Hidden where the margin is too narrow (phones, tablets, whiteboard open): the chat keeps all the space. Stage and milestones
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
// Details stay in the tooltip so the diagram itself carries almost no text
const hint = computed(() => [t('dd.title'), nextNode.value ? t('dd.next') + t(nextNode.value.label) : t('dd.allReached'), t('dd.hint')].join('\n'));

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
</script>

<template>
  <div v-if="visible" ref="root" class="absolute left-3 top-1/2 -translate-y-1/2 z-10 text-slate-400 select-none" :title="hint">
    <div v-if="wide" class="w-24">
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
          class="absolute left-12 -translate-y-1/2 text-[11px] whitespace-nowrap"
          :class="stage?.key === s.key ? 'text-sky-300 font-semibold' : ''"
          :style="{ top: `${s.y}px` }"
        >{{ t(s.label) }}</span>
      </div>
    </div>
  </div>
</template>
