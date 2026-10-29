<script setup lang="ts">
import { t } from '../../i18n';
import { computed } from 'vue';
import { Box, Eye, EyeOff, FileText, Image as ImageIcon, Lock, Palette, PenTool, ShieldCheck } from 'lucide-vue-next';
import type { MessageItem, Participant } from '../../types';

const props = defineProps<{
  msg: MessageItem;
  hidden: boolean;
  managing: boolean;
  thumbnail?: string;
  activeUsers?: Participant[];
}>();
const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'toggle-hide'): void;
}>();

type Kind = 'whiteboard' | 'image' | 'model' | 'moodboard' | 'document' | 'fact_check';

// Visual style per asset kind (hidden tiles all use the amber "hidden" style instead)
const KINDS: Record<Exclude<Kind, 'whiteboard' | 'image'>, { icon: any; color: string; badge: (m: MessageItem) => string; label: (m: MessageItem) => string }> = {
  model: { icon: Box, color: 'sky', badge: () => '3D', label: m => m.assetPayload?.title || t('tile.model') },
  moodboard: { icon: Palette, color: 'amber', badge: () => t('tile.moodboard'), label: m => m.assetPayload?.title || t('tile.moodboard') },
  document: {
    icon: FileText,
    color: 'violet',
    badge: m => (m.assetType === 'contract' ? t('tile.agreement') : t('tile.doc')),
    label: m => m.assetPayload?.title || t('tile.summary')
  },
  fact_check: { icon: ShieldCheck, color: 'emerald', badge: () => t('tile.verify'), label: m => m.assetPayload?.claim || m.assetPayload?.verdict || t('tile.factCheck') }
};

// Spelled out in full so Tailwind's scanner picks up every class. Asset kinds share one neutral style
// (P7: no colour coding that could draw attention to some AI outputs over others); the icon tells them apart.
const NEUTRAL = { tile: 'bg-slate-900 border-slate-800 hover:bg-slate-800', badge: 'bg-slate-900/90 text-slate-300 border-slate-700', icon: 'text-slate-400', text: 'text-slate-300' };
const COLOR_CLASSES: Record<string, { tile: string; badge: string; icon: string; text: string }> = {
  sky: NEUTRAL,
  amber: NEUTRAL,
  violet: NEUTRAL,
  emerald: NEUTRAL,
  hidden: { tile: 'bg-slate-950 border-amber-500/40 hover:border-amber-400', badge: 'bg-slate-950/90 text-amber-300 border-amber-500/50', icon: 'text-amber-400 opacity-70', text: 'text-amber-300' }
};

const kind = computed<Kind | null>(() => {
  const m = props.msg;
  if (m.type === 'whiteboard_state') return 'whiteboard';
  if (m.type === 'file' && m.fileData?.type === 'image') return 'image';
  if (m.type !== 'ai_asset') return null;
  if (m.assetType === 'mesh_3d' || m.assetType === 'parametric_3d') return 'model';
  if (m.assetType === 'moodboard') return 'moodboard';
  if (m.assetType === 'summary' || m.assetType === 'contract') return 'document';
  if (m.assetType === 'fact_check') return 'fact_check';
  return null;
});

const cardKind = computed(() => (kind.value && kind.value in KINDS ? KINDS[kind.value as keyof typeof KINDS] : null));
const colors = computed(() => COLOR_CLASSES[props.hidden ? 'hidden' : cardKind.value?.color || 'sky']);
const cardBadge = computed(() => {
  if (!cardKind.value) return '';
  if (!props.hidden) return cardKind.value.badge(props.msg);
  return kind.value === 'document' ? t('tile.hiddenDoc') : t('tile.hidden');
});

const onClick = () => {
  if (!props.managing) emit('open');
};
</script>

<template>
  <div v-if="kind" class="relative">
  <!-- Whiteboard -->
  <div v-if="kind === 'whiteboard'" class="relative aspect-square cursor-pointer transition group" @click="onClick" :title="hidden ? t('tile.editHiddenBoard') : t('tile.editBoard')">
    <div
      class="w-full h-full rounded-xl bg-slate-950 border-2 overflow-hidden shadow-md relative"
      :class="hidden ? 'border-amber-500/40 hover:border-amber-400' : 'border-slate-800 hover:border-slate-600'"
    >
      <img v-if="thumbnail" :src="thumbnail" class="w-full h-full object-cover group-hover:scale-105 transition duration-300 bg-white" />
      <div v-else class="w-full h-full bg-slate-900 flex flex-col items-center justify-center text-slate-400 gap-1.5 p-2 text-center">
        <Palette class="w-6 h-6 opacity-60 animate-pulse" :class="hidden ? 'text-amber-400' : 'text-slate-400'" />
        <span class="text-[9px] text-slate-300 font-medium">{{ t('tile.renderingThumb') }}</span>
      </div>

      <div
        class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-bold border flex items-center gap-1 z-10 shadow"
        :class="hidden ? 'bg-slate-950/90 text-amber-300 border-amber-500/50' : 'bg-slate-900/90 text-slate-300 border-slate-700'"
      >
        <Lock v-if="msg.metadata?.isPrivate" class="w-2.5 h-2.5 text-amber-400" />
        <Palette v-else class="w-2.5 h-2.5" :class="hidden ? 'text-amber-400' : 'text-slate-400'" />
        <span v-if="hidden">{{ msg.metadata?.isPrivate ? t('tile.hiddenPrivate') : t('tile.hidden') }}</span>
        <span v-else>{{ msg.metadata?.isPrivate ? 'Private' : 'Whiteboard' }}</span>
      </div>

      <div class="absolute bottom-1 left-1 right-1 bg-slate-950/85 px-1.5 py-0.5 rounded text-[8px] text-slate-300 font-medium truncate z-10 flex items-center gap-1">
        <span class="text-[9px]">{{ msg.metadata?.creatorAvatar || msg.senderAvatar || '🎨' }}</span>
        <span class="truncate">{{ msg.metadata?.creatorName || msg.senderName || t('tile.member') }}</span>
      </div>

      <div v-if="!managing && !hidden" class="absolute inset-0 bg-indigo-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
        <span class="bg-indigo-600 text-white px-2 py-0.5 rounded text-[9px] font-bold shadow flex items-center gap-1">
          <PenTool class="w-2.5 h-2.5" /> {{ t('tile.edit') }}
        </span>
      </div>
    </div>

    <!-- Avatars of members currently on this public board -->
    <div
      v-if="!hidden && !managing && !msg.metadata?.isPrivate && activeUsers?.length"
      class="absolute -top-2.5 -right-2.5 z-30 flex items-center -space-x-1.5 pointer-events-auto"
      :title="t('tile.onCanvas', { names: activeUsers.map(u => u.displayName).join(', ') })"
    >
      <div v-for="u in activeUsers.slice(0, 3)" :key="u.uid" class="relative">
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs bg-slate-800 border-2 border-sky-400 shadow-lg select-none ring-1 ring-slate-950" :title="u.displayName">
          {{ u.avatar || '👤' }}
        </span>
        <span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-slate-950 animate-pulse" />
      </div>
      <span
        v-if="activeUsers.length > 3"
        class="w-5 h-5 rounded-full bg-sky-600 text-white text-[9px] font-bold flex items-center justify-center border-2 border-slate-900 shadow-md ring-1 ring-slate-950"
      >
        +{{ activeUsers.length - 3 }}
      </span>
    </div>
  </div>

  <!-- Image -->
  <div
    v-else-if="kind === 'image'"
    class="aspect-square rounded-xl bg-slate-950 border overflow-hidden cursor-pointer transition group relative"
    :class="hidden ? 'border-amber-500/40 hover:border-amber-400' : 'border-slate-800 hover:border-slate-600'"
    @click="onClick"
    :title="hidden ? t('tile.viewHiddenImage') : t('tile.viewImage')"
  >
    <img :src="msg.fileData!.url" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" :class="{ 'opacity-70': hidden }" />
    <div
      class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-medium border flex items-center gap-1 z-10 shadow"
      :class="hidden ? 'bg-slate-950/90 text-amber-300 border-amber-500/50' : 'bg-slate-900/90 text-slate-300 border-slate-700/60'"
    >
      <ImageIcon class="w-2.5 h-2.5" :class="hidden ? 'text-amber-400' : 'text-slate-400'" />
      <span>{{ hidden ? 'Hidden' : 'Image' }}</span>
    </div>
    <div v-if="!managing && !hidden" class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
      <span class="bg-slate-800 text-slate-200 px-2 py-0.5 rounded text-[9px] font-medium shadow flex items-center gap-1">
        <Eye class="w-2.5 h-2.5" /> {{ t('tile.view') }}
      </span>
    </div>
  </div>

  <!-- 3D / moodboard / document / fact check card -->
  <div
    v-else-if="cardKind"
    class="aspect-square rounded-xl border flex flex-col items-center justify-center text-center p-2 cursor-pointer transition relative group"
    :class="colors.tile"
    @click="onClick"
    :title="cardKind.label(msg)"
  >
    <div class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[8px] font-bold border flex items-center gap-1" :class="colors.badge">
      <component :is="cardKind.icon" class="w-2.5 h-2.5" :class="colors.icon" />
      <span>{{ cardBadge }}</span>
    </div>
    <component :is="cardKind.icon" class="w-6 h-6 mb-1 mt-2" :class="colors.icon" />
    <span class="text-[9px] font-medium truncate w-full px-1" :class="colors.text">{{ cardKind.label(msg) }}</span>
  </div>

  <!-- Hide / unhide control (manage mode) -->
  <button
    v-if="managing"
    @click.stop="emit('toggle-hide')"
    class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded text-white text-[9px] font-bold shadow-md transition cursor-pointer flex items-center gap-0.5"
    :class="hidden ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'"
    :title="hidden ? t('tile.unhide') : t('tile.hide')"
  >
    <component :is="hidden ? Eye : EyeOff" class="w-2.5 h-2.5" />
    <span>{{ hidden ? 'Unhide' : 'Hide' }}</span>
  </button>
  </div>
</template>
