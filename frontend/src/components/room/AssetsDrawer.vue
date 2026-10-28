<script setup lang="ts">
import { t } from '../../i18n';
import { computed, ref, watch } from 'vue';
import { Box, EyeOff, Settings, X } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';
import type { MessageItem } from '../../types';
import { isDuplicateBoardPointer, isOwnBoard } from '../../utils/chat';
import { renderWhiteboardThumbnail } from '../../utils/whiteboardThumbnail';
import AssetTile from './AssetTile.vue';

const props = defineProps<{
  isOpen: boolean;
  topOffset: string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'open-whiteboard', msg: MessageItem): void;
  (e: 'open-document', title: string, content: string): void;
  (e: 'scroll-to', messageId: string): void;
}>();

const authStore = useAuthStore();
const roomStore = useRoomStore();

const activeTab = ref<'public' | 'personal'>('public');
const isManaging = ref(false);
watch(() => props.isOpen, open => {
  if (!open) isManaging.value = false;
});

const messages = computed(() => roomStore.currentRoom?.messages || []);
const newestFirst = (items: MessageItem[]) => [...items].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

// Public: shared/published boards (not private), AI assets and image attachments
const publicItems = computed(() =>
  newestFirst(messages.value.filter(m => {
    if (m.type === 'whiteboard_state') {
      return !m.metadata?.isPrivate && (m.metadata?.wasPublished || m.metadata?.isSharedPost) && !isDuplicateBoardPointer(m, messages.value);
    }
    return m.type === 'ai_asset' || (m.type === 'file' && m.fileData?.type === 'image');
  }))
);

// Personal: my own private boards only
const personalItems = computed(() =>
  newestFirst(messages.value.filter(m =>
    m.type === 'whiteboard_state' && isOwnBoard(m, authStore.uid) && m.metadata?.isPrivate && !isDuplicateBoardPointer(m, messages.value)
  ))
);

const tabItems = computed(() => (activeTab.value === 'public' ? publicItems.value : personalItems.value));
const visibleItems = computed(() => tabItems.value.filter(m => !m.metadata?.isHidden));
const hiddenItems = computed(() => tabItems.value.filter(m => m.metadata?.isHidden));
const countFor = (items: MessageItem[]) => (isManaging.value ? items.length : items.filter(m => !m.metadata?.isHidden).length);

// ---------- Whiteboard thumbnails ----------
// Stored thumbnails below ~3.5KB are known-bad (black) renders from older versions and get regenerated
const generatedThumbnails = ref<Record<string, string>>({});
const inFlight = new Set<string>();

const thumbnailFor = (m: MessageItem) => {
  if (generatedThumbnails.value[m.id]) return generatedThumbnails.value[m.id];
  const url = m.fileData?.url;
  if (!url || (url.startsWith('data:image/') && url.length < 3500)) return '';
  return url;
};

const generateThumbnail = async (m: MessageItem) => {
  const json = m.metadata?.whiteboardJson;
  if (!json || inFlight.has(m.id)) return;
  inFlight.add(m.id);
  try {
    const dataUrl = await renderWhiteboardThumbnail(json);
    if (!dataUrl) return;
    generatedThumbnails.value[m.id] = dataUrl;
    if (isOwnBoard(m, authStore.uid)) {
      await roomStore.updateCustomMessage(m.id, { fileData: { name: 'whiteboard.jpg', size: 0, type: 'image', url: dataUrl } });
    }
  } catch (e) {
    console.warn('Failed to generate draft thumbnail for msg', m.id, e);
  } finally {
    inFlight.delete(m.id);
  }
};

const ensureThumbnails = (items: MessageItem[]) => {
  items.forEach(m => {
    if (m.type === 'whiteboard_state' && m.metadata?.boardV !== 2 && m.metadata?.whiteboardJson && (!generatedThumbnails.value[m.id] || !thumbnailFor(m))) {
      generateThumbnail(m);
    }
  });
};
watch([tabItems, () => props.isOpen], ([items, open]) => open && ensureThumbnails(items), { immediate: true, deep: true });
// Personal drafts are pre-rendered in the background so the drawer opens instantly
watch(personalItems, ensureThumbnails, { immediate: true, deep: true });

const activeUsersOn = (assetId: string) =>
  Object.values(roomStore.currentRoom?.participants || {}).filter(
    p => p.status === 'approved' && p.isOnline !== false && p.activeWhiteboardId === assetId
  );

// Hiding applies to everyone in the room, so only the item's sender or the room host may do it (firestore.rules)
const canHide = (m: MessageItem) => roomStore.isHost || m.senderUid === authStore.uid;

const toggleHidden = async (m: MessageItem) => {
  const isHidden = !m.metadata?.isHidden;
  const metadata = { ...(m.metadata || {}), isHidden };
  m.metadata = metadata;
  await roomStore.updateCustomMessage(m.id, { metadata });
  roomStore.pushToast(
    isHidden ? t('assets.hiddenTitle') : t('assets.unhiddenTitle'),
    isHidden ? t('assets.hiddenText') : t('assets.unhiddenText'),
    'info'
  );
};

const openItem = (m: MessageItem) => {
  if (m.type === 'whiteboard_state') {
    emit('open-whiteboard', m);
    emit('close');
  } else if (m.assetType === 'summary' || m.assetType === 'contract') {
    emit('open-document', m.assetPayload?.title || (m.assetType === 'contract' ? t('assets.teamAgreement') : t('assets.executiveSummary')), m.assetPayload?.content || '');
  } else {
    emit('scroll-to', m.id);
  }
};
</script>

<template>
  <div
    class="fixed bottom-0 right-0 z-[100] w-full sm:w-80 bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out"
    :style="{ top: topOffset, height: `calc(100dvh - ${topOffset})` }"
    :class="isOpen ? 'translate-x-0' : 'translate-x-full'"
  >
    <div class="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
      <h2 class="text-base font-bold text-slate-100 flex items-center gap-2">
        <Box class="w-4 h-4 text-amber-400" />
        {{ t('assets.title') }}
      </h2>
      <div class="flex items-center gap-1.5">
        <button
          @click="isManaging = !isManaging"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1"
          :class="isManaging ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-slate-800 text-slate-400 hover:text-slate-200'"
          :title="t('assets.manageHidden')"
        >
          <Settings class="w-3.5 h-3.5" />
          <span>{{ isManaging ? t('assets.done') : t('assets.manage') }}</span>
        </button>
        <button @click="emit('close')" class="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>
    </div>

    <div class="px-4 pt-3 pb-1 bg-slate-950/60 border-b border-slate-800">
      <div class="flex items-center gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800">
        <button
          @click="activeTab = 'public'"
          class="flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition cursor-pointer text-center"
          :class="activeTab === 'public' ? 'bg-sky-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'"
        >
          {{ t('assets.public', { count: countFor(publicItems) }) }}
        </button>
        <button
          @click="activeTab = 'personal'"
          class="flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold transition cursor-pointer text-center"
          :class="activeTab === 'personal' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'"
        >
          {{ t('assets.personal', { count: countFor(personalItems) }) }}
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <div v-if="!visibleItems.length && !hiddenItems.length" class="text-center text-xs text-slate-500 py-10 px-4">
        <template v-if="activeTab === 'personal'">{{ t('assets.noPersonal') }}</template>
        <template v-else>{{ t('assets.noPublic') }}</template>
      </div>

      <div v-if="visibleItems.length" class="grid grid-cols-3 gap-2">
        <AssetTile
          v-for="m in visibleItems"
          :key="m.id"
          :msg="m"
          :hidden="false"
          :managing="isManaging && canHide(m)"
          :thumbnail="thumbnailFor(m)"
          :activeUsers="activeUsersOn(m.id)"
          @open="openItem(m)"
          @toggle-hide="toggleHidden(m)"
        />
      </div>

      <!-- Hidden items (manage mode only), still in chronological order -->
      <div v-if="isManaging && hiddenItems.length" class="pt-4 border-t border-slate-800/80">
        <div class="flex items-center justify-between mb-2.5 px-1 select-none">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
            <EyeOff class="w-3.5 h-3.5 text-amber-400/80" />
            <span>{{ t('assets.hiddenItems', { count: hiddenItems.length }) }}</span>
          </div>
          <span class="text-[10px] text-slate-500">{{ t('assets.chronological') }}</span>
        </div>
        <div class="grid grid-cols-3 gap-2 opacity-65 hover:opacity-100 transition-opacity">
          <AssetTile
            v-for="m in hiddenItems"
            :key="m.id"
            :msg="m"
            :hidden="true"
            :managing="isManaging && canHide(m)"
            :thumbnail="thumbnailFor(m)"
            @open="openItem(m)"
            @toggle-hide="toggleHidden(m)"
          />
        </div>
      </div>
    </div>
  </div>

  <div v-if="isOpen" @click="emit('close')" class="fixed inset-x-0 bottom-0 z-[90] bg-black/60 transition-opacity" :style="{ top: topOffset }"></div>
</template>
