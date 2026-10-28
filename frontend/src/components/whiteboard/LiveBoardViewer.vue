<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { collection, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { Eye, Lock, X } from 'lucide-vue-next';
import { db } from '../../firebase/config';
import { useRoomStore } from '../../stores/room';
import BoardReplayCanvas from '../admin/BoardReplayCanvas.vue';
import type { ReplayObject } from '../../utils/replay';
import { t } from '../../i18n';

/**
 * Read-only live view of a board for the researcher and observers (any board, private drafts
 * included). It only listens: no presence, no cursor, so participants never see that someone watches.
 */
const props = defineProps<{ roomId: string; boardId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
defineExpose({ flush: () => {}, handleCloseRequest: () => emit('close') });

const roomStore = useRoomStore();
const card = computed(() => roomStore.currentRoom?.messages.find(m => m.id === props.boardId));
const creatorName = computed(() => {
  const uid = card.value?.metadata?.creatorUid;
  return (uid && roomStore.currentRoom?.participants[uid]?.displayName) || card.value?.senderName || '';
});

const objects = ref<ReplayObject[]>([]);
const error = ref('');
const box = ref<HTMLElement | null>(null);
const size = ref({ width: 640, height: 400 });

let unsub: Unsubscribe | null = null;
let resize: ResizeObserver | null = null;

onMounted(() => {
  unsub = onSnapshot(collection(db, 'rooms', props.roomId, 'boards', props.boardId, 'objects'), snap => {
    objects.value = snap.docs.map(d => ({ id: d.id, z: (d.data() as any).z ?? 0, fabric: (d.data() as any).fabric }));
  }, err => (error.value = err.message));
  resize = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) size.value = { width: Math.floor(width), height: Math.floor(height) };
  });
  if (box.value) resize.observe(box.value);
});
onBeforeUnmount(() => {
  unsub?.();
  resize?.disconnect();
});
</script>

<template>
  <div class="h-full flex flex-col bg-slate-900">
    <div class="h-11 px-3 flex items-center gap-2 border-b border-slate-800 text-xs text-slate-300 shrink-0">
      <Eye class="w-4 h-4 text-violet-300 shrink-0" />
      <span class="font-medium truncate">{{ card?.metadata?.title || card?.metadata?.name || t('live.whiteboard') }}</span>
      <span v-if="creatorName" class="text-slate-500 truncate">{{ t('live.by', { name: creatorName }) }}</span>
      <span v-if="card?.metadata?.isPrivate" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 text-[10px] shrink-0">
        <Lock class="w-3 h-3" /> {{ t('msg.private') }}
      </span>
      <span class="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 text-[10px] shrink-0">{{ t('live.readOnly') }}</span>
      <button class="ml-auto p-1.5 rounded-lg hover:bg-slate-800 text-slate-400" :title="t('common.close')" @click="emit('close')">
        <X class="w-4 h-4" />
      </button>
    </div>
    <div ref="box" class="flex-1 min-h-0 relative overflow-hidden">
      <p v-if="error" class="absolute inset-0 grid place-items-center text-xs text-rose-300 px-6 text-center">{{ error }}</p>
      <p v-else-if="!objects.length" class="absolute inset-0 grid place-items-center text-xs text-slate-500">{{ t('live.empty') }}</p>
      <BoardReplayCanvas :objects="objects" :width="size.width" :height="size.height" />
    </div>
  </div>
</template>
