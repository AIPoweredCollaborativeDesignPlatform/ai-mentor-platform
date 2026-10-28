<script setup lang="ts">
import { t } from '../i18n';
import { ref } from 'vue';
import { ShieldCheck, CheckCircle2, AlertTriangle, ExternalLink, ChevronRight } from 'lucide-vue-next';

defineProps<{
  assetData: {
    claim?: string;
    verdict?: string;
    details?: string;
    references?: string[];
  };
}>();

const isReferencesOpen = ref(false);

const formatRefDisplay = (ref: string) => {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
};
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-emerald-500/30 rounded-2xl p-4 shadow-xl text-left">
    <div class="flex items-center gap-2 mb-2">
      <ShieldCheck class="w-5 h-5 text-emerald-400 shrink-0" />
      <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
        {{ t('fact.title') }}
      </h4>
      <span class="text-[10px] bg-emerald-500/20 text-emerald-300 font-mono px-2 py-0.5 rounded-full border border-emerald-500/30">
        {{ t('fact.verified') }}
      </span>
    </div>

    <!-- Verified Claim -->
    <div v-if="assetData?.claim" class="mb-2 p-2.5 bg-slate-900/80 rounded-xl border border-slate-800 text-xs text-slate-300">
      <span class="text-slate-500 font-medium">{{ t('fact.claim') }}</span> {{ assetData.claim }}
    </div>

    <!-- Verdict -->
    <div v-if="assetData?.verdict" class="flex items-center gap-1.5 mb-2 text-xs font-semibold text-emerald-400">
      <CheckCircle2 class="w-4 h-4 shrink-0" />
      <span>{{ assetData.verdict }}</span>
    </div>

    <!-- Details -->
    <div v-if="assetData?.details" class="text-xs text-slate-300 leading-relaxed mb-3 whitespace-pre-wrap">
      {{ assetData.details }}
    </div>

    <!-- References (Collapsible by default) -->
    <div v-if="assetData?.references?.length" class="pt-2 border-t border-slate-800/80">
      <button
        @click="isReferencesOpen = !isReferencesOpen"
        class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition cursor-pointer select-none mb-1 group"
        :title="t('fact.toggleRefs')"
      >
        <ChevronRight
          class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-200 transition-transform duration-200 shrink-0"
          :class="{ 'rotate-90': isReferencesOpen }"
        />
        <span>References & Standards ({{ assetData.references.length }})</span>
      </button>

      <ul v-show="isReferencesOpen" class="space-y-1.5 mt-2 pl-1">
        <li
          v-for="(ref, idx) in assetData.references"
          :key="idx"
          class="text-[11px] min-w-0"
        >
          <a
            :href="ref.startsWith('http') ? ref : `https://www.google.com/search?q=${encodeURIComponent(ref)}`"
            target="_blank"
            class="text-sky-400 hover:text-sky-300 hover:underline flex items-start gap-1.5 break-all max-w-full"
            :title="ref.startsWith('http') ? t('fact.visit') : t('fact.search')"
          >
            <ExternalLink class="w-3.5 h-3.5 shrink-0 mt-0.5 text-sky-400" />
            <span class="min-w-0 break-all">{{ formatRefDisplay(ref) }}</span>
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
