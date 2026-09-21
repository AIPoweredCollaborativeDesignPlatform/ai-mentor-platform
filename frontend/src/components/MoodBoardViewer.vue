<script setup lang="ts">
import { ref } from 'vue';
import { Palette, Copy, Check } from 'lucide-vue-next';

defineProps<{
  assetData: any;
}>();

const copiedHex = ref<string | null>(null);
const previewImage = ref<string | null>(null);

const copyColor = (hex: string) => {
  navigator.clipboard.writeText(hex);
  copiedHex.value = hex;
  setTimeout(() => {
    copiedHex.value = null;
  }, 2000);
};

const openPreview = (url: string) => {
  previewImage.value = url;
};

const closePreview = () => {
  previewImage.value = null;
};
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-amber-500/30 rounded-2xl p-4 shadow-xl">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <Palette class="w-5 h-5 text-amber-400" />
        <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
          {{ assetData?.title || 'Visual Mood Board' }}
        </h4>
        <span class="text-[10px] bg-amber-500/20 text-amber-300 font-mono px-2 py-0.5 rounded-full border border-amber-500/30">
          AI Generated
        </span>
      </div>
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

    <!-- Image Slices Grid -->
    <div v-if="assetData?.slices?.length" class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
      <div
        v-for="(slice, i) in assetData.slices"
        :key="i"
        class="group relative rounded-xl overflow-hidden aspect-video bg-slate-900 border border-slate-800 cursor-pointer"
        @click="openPreview(slice.url)"
      >
        <img
          :src="slice.url"
          :alt="slice.caption"
          class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
          loading="lazy"
        />
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-end p-2 opacity-90">
          <p class="text-[11px] text-slate-200 truncate">{{ slice.caption }}</p>
        </div>
      </div>
    </div>

    <!-- Color Palette -->
    <div v-if="assetData?.palette?.length" class="mb-3">
      <h5 class="text-xs font-semibold text-slate-400 mb-1.5">Color Palette (click to copy HEX)</h5>
      <div class="grid grid-cols-4 gap-2">
        <button
          v-for="color in assetData.palette"
          :key="color.hex"
          @click="copyColor(color.hex)"
          class="flex flex-col items-center p-2 rounded-xl border border-slate-800 hover:border-slate-600 bg-slate-900/60 transition group text-center"
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
      <h5 class="text-xs font-semibold text-slate-400">Materials</h5>
      <div
        v-for="(mat, idx) in assetData.materials"
        :key="idx"
        class="text-xs bg-slate-900/60 border border-slate-800 rounded-lg p-2 flex justify-between items-center"
      >
        <span class="font-medium text-slate-200">{{ mat.name }}</span>
        <span class="text-slate-400 text-[11px]">{{ mat.feature }}</span>
      </div>
    </div>

    <!-- Fullscreen Image Preview Modal -->
    <div v-if="previewImage" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4" @click="closePreview">
      <button class="absolute top-4 right-4 p-2 text-white/70 hover:text-white bg-black/50 rounded-full" @click="closePreview">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
      <img :src="previewImage" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl" @click.stop />
    </div>
  </div>
</template>
