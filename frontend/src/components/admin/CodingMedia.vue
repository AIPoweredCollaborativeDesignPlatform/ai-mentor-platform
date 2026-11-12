<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import type { MessageItem } from '../../types';
import { t } from '../../i18n';
const failed = ref(new Set<string>());
const expanded = ref(''), preview = ref<HTMLDialogElement | null>(null);
watch(expanded, async value => { await nextTick(); if (value) preview.value?.showModal(); else preview.value?.close(); });
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
      <button v-for="item in images" :key="item.url" type="button" @click="expanded = item.url" class="block min-w-0 border border-slate-700 rounded-lg p-1" :aria-label="t('coding.openMedia')"><img v-if="!failed.has(item.url)" @error="failed.add(item.url)" :src="item.url" :alt="item.title || t('coding.mediaEvidence')" loading="lazy" class="max-h-96 w-full object-contain rounded"><p v-if="item.title" class="text-xs break-words mt-1">{{ item.title }}</p></button>
    </div>
    <p v-if="!images.length || images.some(item => failed.has(item.url))" class="text-xs text-amber-400">{{ t('coding.mediaMissing') }}</p>
    <p v-if="message.type === 'whiteboard_state'" class="text-xs text-amber-400">{{ t('coding.boardPreviewPolicy') }}</p>
    <dialog ref="preview" class="fixed inset-0 m-auto max-w-[96vw] max-h-[96dvh] rounded-xl border border-slate-700 bg-slate-950 text-slate-100 p-3 overflow-auto" :aria-label="t('coding.mediaEvidence')" @close="expanded = ''">
      <button type="button" class="block ml-auto border border-slate-700 rounded-lg px-3 py-2 mb-2" @click="expanded = ''">{{ t('coding.closeMedia') }}</button>
      <img v-if="expanded" :src="expanded" :alt="t('coding.mediaEvidence')" class="max-w-full max-h-[80dvh] object-contain">
    </dialog>
  </section>
</template>
