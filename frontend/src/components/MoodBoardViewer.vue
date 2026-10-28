<script setup lang="ts">
import { t } from '../i18n';
import { ref } from 'vue';
import { Palette, Copy, Check, ExternalLink, Sparkles, X } from 'lucide-vue-next';

const props = defineProps<{
  assetData: any;
}>();

const copiedHex = ref<string | null>(null);
const selectedItem = ref<{
  url: string;
  title: string;
  category?: string;
  prompt?: string;
  sourceUrl?: string;
  isHero?: boolean;
} | null>(null);

// Built-in categories are stored in English; AI-written categories are already in the room language
const categoryLabel = (c: string) => (c === 'Hero Concept' ? t('mood.hero') : c === 'Reference' ? t('mood.reference') : c);

const copyColor = (hex: string) => {
  navigator.clipboard.writeText(hex);
  copiedHex.value = hex;
  setTimeout(() => {
    copiedHex.value = null;
  }, 2000);
};

// Deterministic seed ensures images never reroll or jump dynamically across renders
const getStableSeed = (str: string, index: number): number => {
  let hash = 0;
  const full = `${str || 'concept'}_${index}_stable_v2`;
  for (let i = 0; i < full.length; i++) {
    hash = (hash << 5) - hash + full.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash % 90000) + 10000;
};

const getImageUrl = (img: any, index: number) => {
  const seed = getStableSeed(img?.title || img?.caption || props.assetData?.title || 'design', index);
  if (typeof img === 'string') {
    if (img.includes('image.pollinations.ai/prompt/')) {
      const clean = img.replace(/&seed=\d+/, '').replace(/\?seed=\d+&?/, '?').replace(/&width=\d+/, '').replace(/&height=\d+/, '');
      const sep = clean.includes('?') ? '&' : '?';
      return `${clean}${sep}width=600&height=450&seed=${seed}&nologo=true`;
    }
    return img;
  }
  if (img?.url) {
    if (img.url.includes('image.pollinations.ai/prompt/')) {
      const clean = img.url.replace(/&seed=\d+/, '').replace(/\?seed=\d+&?/, '?').replace(/&width=\d+/, '').replace(/&height=\d+/, '');
      const sep = clean.includes('?') ? '&' : '?';
      return `${clean}${sep}width=600&height=450&seed=${seed}&nologo=true`;
    }
    return img.url;
  }
  // Generation failed server-side (e.g. image provider out of credit): show a neutral placeholder,
  // never images from another source, so the research record only contains what the AI produced
  return unavailableImage();
};

// In the room language; the research record keeps only images the AI actually produced
const unavailableImage = () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450"><rect width="600" height="450" fill="#0f172a"/>'
  + `<text x="300" y="225" fill="#64748b" font-family="system-ui,sans-serif" font-size="22" text-anchor="middle">${t('mood.unavailable')}</text></svg>`
);

const handleImgError = (e: Event, img: any) => {
  const target = e.target as HTMLImageElement;
  if (!target) return;
  const fallback = unavailableImage();
  if (target.src !== fallback) target.src = fallback;
};

const getSourceUrl = (img: any) => {
  if (img?.sourceUrl) return img.sourceUrl;
  const q = encodeURIComponent(img?.title || img?.caption || props.assetData?.title || 'design concept');
  return `https://unsplash.com/s/photos/${q}`;
};

const isHeroCard = (img: any, index: number) => {
  return index === 0 || img?.isAiGenerated || img?.isAiHero || img?.category === 'Hero Concept';
};

const openPreview = (img: any, index: number) => {
  selectedItem.value = {
    url: getImageUrl(img, index),
    title: img?.title || img?.caption || t('mood.conceptRef'),
    category: img?.category || (index === 0 ? 'Hero Concept' : 'Reference'),
    prompt: img?.prompt,
    sourceUrl: getSourceUrl(img),
    isHero: isHeroCard(img, index)
  };
};

const closePreview = () => {
  selectedItem.value = null;
};
</script>

<template>
  <div class="mt-3 bg-slate-900 border border-slate-800 rounded-2xl p-4">
    <!-- Header with strictly non-wrapping AI Generated pill -->
    <div class="flex items-center justify-between gap-2 mb-3 min-w-0">
      <div class="flex items-center gap-2 min-w-0">
        <Palette class="w-4 h-4 sm:w-5 sm:h-5 text-slate-400 shrink-0" />
        <h4 class="font-semibold text-slate-100 text-xs sm:text-sm tracking-wide truncate">
          {{ assetData?.title || t('mood.title') }}
        </h4>
      </div>
      <span class="text-[9px] sm:text-[10px] bg-slate-800 text-slate-400 font-mono px-2 py-0.5 rounded-full border border-slate-700 whitespace-nowrap shrink-0">
        {{ t('mood.aiGenerated') }}
      </span>
    </div>

    <!-- Keyword Tags -->
    <div v-if="assetData?.keywords?.length" class="flex flex-wrap gap-1.5 mb-3">
      <span
        v-for="(kw, idx) in assetData.keywords"
        :key="idx"
        class="text-xs bg-slate-800 border border-slate-700 text-slate-300 px-2.5 py-0.5 rounded-full"
      >
        #{{ kw }}
      </span>
    </div>

    <!-- Concept Imagery Grid -->
    <div v-if="(assetData?.images?.length || assetData?.slices?.length || assetData?.keywords?.length)" class="mb-3">
      <h5 class="text-xs font-semibold text-slate-400 mb-1.5 flex items-center justify-between">
        <span>{{ t('mood.imagery') }}</span>
      </h5>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div
          v-for="(img, i) in (assetData.images || assetData.slices || (assetData.keywords || ['concept']).slice(0, 4).map((kw: string) => ({ title: kw, caption: kw })))"
          :key="i"
          class="group relative rounded-xl overflow-hidden aspect-[4/3] bg-slate-900 border cursor-pointer shadow transition duration-300"
          :class="isHeroCard(img, i) ? 'border-slate-600 hover:border-slate-500' : 'border-slate-800 hover:border-slate-600'"
          @click="openPreview(img, i)"
        >
          <img
            :src="getImageUrl(img, i)"
            :alt="img?.title || img?.caption || 'Concept'"
            @error="handleImgError($event, img)"
            class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
            loading="lazy"
          />

          <!-- Top Row: Category / Hero Badge & Sleek Direct Source Link -->
          <div class="absolute top-1.5 left-1.5 right-1.5 flex items-center justify-between z-10 gap-1">
            <!-- Card 1: Dedicated Hero Concept Badge -->
            <span
              v-if="isHeroCard(img, i)"
              class="bg-indigo-950/85 text-indigo-300 px-1.5 py-0.5 rounded text-[8px] font-semibold border border-indigo-500/40 shadow-xs flex items-center gap-1 shrink-0"
            >
              <Sparkles class="w-2.5 h-2.5 text-indigo-400" />
              <span>{{ t('mood.hero') }}</span>
            </span>
            <!-- Other Cards: Specific Category Badge -->
            <span
              v-else-if="img?.category"
              class="bg-black/75 text-white px-1.5 py-0.5 rounded text-[8px] font-semibold border border-amber-500/30 shadow-xs truncate"
            >
              {{ categoryLabel(img.category) }}
            </span>
            <span v-else></span>

            <!-- Direct Image Source External Link Icon -->
            <a
              :href="getSourceUrl(img)"
              target="_blank"
              rel="noopener noreferrer"
              class="bg-black/75 hover:bg-slate-800 text-slate-300 hover:text-white p-1 rounded-md border border-slate-700/80 shadow-xs flex items-center justify-center transition shrink-0"
              @click.stop
              :title="t('mood.openRef', { url: getSourceUrl(img) })"
            >
              <ExternalLink class="w-2.5 h-2.5 sm:w-3 sm:h-3" />
            </a>
          </div>

          <!-- Title Overlay -->
          <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent flex items-end p-2 opacity-90">
            <p class="text-[11px] text-slate-200 font-medium truncate">{{ img?.title || img?.caption || t('mood.conceptRef') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Color Palette -->
    <div v-if="assetData?.palette?.length" class="mb-3">
      <h5 class="text-xs font-semibold text-slate-400 mb-1.5">{{ t('mood.palette') }}</h5>
      <div class="grid grid-cols-4 gap-2">
        <button
          v-for="color in assetData.palette"
          :key="color.hex"
          @click="copyColor(color.hex)"
          class="flex flex-col items-center p-2 rounded-xl border border-slate-800 hover:border-slate-600 bg-slate-900/60 transition group text-center cursor-pointer"
        >
          <div
            class="w-full h-8 rounded-lg mb-1.5 border border-white/10 shadow-inner"
            :style="{ backgroundColor: color.hex }"
          ></div>
          <span class="text-[11px] font-mono text-slate-200 flex items-center gap-1">
            {{ color.hex }}
            <Check v-if="copiedHex === color.hex" class="w-3 h-3 text-emerald-400" />
            <Copy v-else class="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 text-slate-400" />
          </span>
          <span class="text-[10px] text-slate-400 truncate w-full">{{ color.name }}</span>
        </button>
      </div>
    </div>

    <!-- Materials list -->
    <div v-if="assetData?.materials?.length" class="space-y-1.5">
      <h5 class="text-xs font-semibold text-slate-400">{{ t('mood.materials') }}</h5>
      <div
        v-for="(mat, idx) in assetData.materials"
        :key="idx"
        class="text-xs bg-slate-900/60 border border-slate-800 rounded-lg p-2 flex justify-between items-center"
      >
        <span class="font-medium text-slate-200">{{ mat.name }}</span>
        <span class="text-slate-400 text-[11px]">{{ mat.feature }}</span>
      </div>
    </div>

    <!-- Fullscreen Sleek Lightbox Preview Modal -->
    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="selectedItem"
        class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-4 sm:p-6 select-none"
        @click="closePreview"
      >
        <div
          class="relative max-w-4xl w-full max-h-[90vh] flex flex-col items-center bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden"
          @click.stop
        >
          <!-- Top Bar -->
          <div class="w-full flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950/70">
            <div class="flex items-center gap-2 min-w-0">
              <span
                v-if="selectedItem.isHero"
                class="bg-indigo-950 text-indigo-300 px-2 py-0.5 rounded text-xs font-semibold border border-indigo-500/40 flex items-center gap-1 shrink-0"
              >
                <Sparkles class="w-3 h-3 text-indigo-400" />
                <span>{{ t('mood.hero') }}</span>
              </span>
              <span
                v-else-if="selectedItem.category"
                class="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-xs font-semibold border border-slate-700 shrink-0"
              >
                {{ categoryLabel(selectedItem.category) }}
              </span>
              <h3 class="text-sm font-semibold text-slate-100 truncate">{{ selectedItem.title }}</h3>
            </div>

            <div class="flex items-center gap-2">
              <a
                v-if="selectedItem.sourceUrl"
                :href="selectedItem.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="px-2.5 py-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-ink text-xs font-medium flex items-center gap-1.5 transition"
                :title="t('mood.openSource')"
              >
                <span>{{ t('mood.viewSource') }}</span>
                <ExternalLink class="w-3 h-3" />
              </a>
              <button
                @click="closePreview"
                class="p-1.5 rounded-xl bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-300 transition cursor-pointer"
                :title="t('mood.closeLightbox')"
              >
                <X class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- Image Display Area -->
          <div class="flex-1 w-full max-h-[70vh] flex items-center justify-center p-2 bg-black/40 overflow-hidden">
            <img
              :src="selectedItem.url"
              :alt="selectedItem.title"
              class="max-w-full max-h-full object-contain rounded-lg shadow-xl"
            />
          </div>

          <!-- Bottom Prompt Description -->
          <div v-if="selectedItem.prompt" class="w-full px-4 py-2.5 border-t border-slate-800 bg-slate-950/80 text-xs text-slate-400 font-mono">
            <span class="text-indigo-400 font-semibold">{{ t('mood.visualPrompt') }}</span>
            <span>{{ selectedItem.prompt }}</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
