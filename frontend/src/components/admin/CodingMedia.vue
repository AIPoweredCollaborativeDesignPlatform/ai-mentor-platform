<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MessageItem } from '../../types';
import { t } from '../../i18n';
const failed = ref(new Set<string>());
const props = defineProps<{ message: MessageItem }>();
const safe = (url: unknown): url is string => typeof url === 'string' && (/^https:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url));
const images = computed(() => {
  const m = props.message, payload = m.assetPayload || {};
  const items: { url: string; title: string }[] = [];
  const add = (url: unknown, title = '') => { if (safe(url) && !items.some(i => i.url === url)) items.push({ url, title }); };
  if (m.fileData?.type === 'image') add(m.fileData.url, m.fileData.name);
  add((m as any).whiteboardThumbnail);
  for (const image of payload.images || payload.slices || payload.sketches || []) add(typeof image === 'string' ? image : image.url || image.imageUrl, image.title || image.caption || '');
  if (props.message.assetType === 'image') add(payload.url);
  add(payload.imageUrl); add(payload.thumbnailUrl); add(payload.thumbnail); add(payload.inputRender);
  return items;
});
</script>
<template>
  <section class="mt-3 space-y-2">
    <p class="text-xs text-slate-400">{{ t('coding.mediaEvidence') }}</p>
    <div class="grid gap-2" :class="images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
      <a v-for="item in images" :key="item.url" :href="item.url" target="_blank" rel="noopener noreferrer" class="block min-w-0 border border-slate-700 rounded-lg p-1" :aria-label="t('coding.openMedia')"><img v-if="!failed.has(item.url)" @error="failed.add(item.url)" :src="item.url" :alt="item.title || t('coding.mediaEvidence')" loading="lazy" class="max-h-96 w-full object-contain rounded"><p v-if="item.title" class="text-xs break-words mt-1">{{ item.title }}</p></a>
    </div>
    <p v-if="!images.length || images.some(item => failed.has(item.url))" class="text-xs text-amber-400">{{ t('coding.mediaMissing') }}</p>
    <p v-if="message.type === 'whiteboard_state'" class="text-xs text-amber-400">{{ t('coding.boardPreviewPolicy') }}</p>
  </section>
</template>
