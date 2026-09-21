<script setup lang="ts">
import { ShieldCheck, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-vue-next';

defineProps<{
  assetData: {
    claim?: string;
    verdict?: string;
    details?: string;
    references?: string[];
  };
}>();
</script>

<template>
  <div class="mt-3 bg-slate-950/80 border border-emerald-500/30 rounded-2xl p-4 shadow-xl text-left">
    <div class="flex items-center gap-2 mb-2">
      <ShieldCheck class="w-5 h-5 text-emerald-400 shrink-0" />
      <h4 class="font-semibold text-slate-100 text-sm tracking-wide">
        Fact Retrieval & Design Verification
      </h4>
      <span class="text-[10px] bg-emerald-500/20 text-emerald-300 font-mono px-2 py-0.5 rounded-full border border-emerald-500/30">
        AI Verified
      </span>
    </div>

    <!-- Verified Claim -->
    <div v-if="assetData?.claim" class="mb-2 p-2.5 bg-slate-900/80 rounded-xl border border-slate-800 text-xs text-slate-300">
      <span class="text-slate-500 font-medium">Claim / Topic:</span> {{ assetData.claim }}
    </div>

    <!-- Verdict -->
    <div v-if="assetData?.verdict" class="flex items-center gap-1.5 mb-2 text-xs font-semibold text-emerald-400">
      <CheckCircle2 class="w-4 h-4" />
      <span>{{ assetData.verdict }}</span>
    </div>

    <!-- Details -->
    <div v-if="assetData?.details" class="text-xs text-slate-300 leading-relaxed mb-3 whitespace-pre-wrap">
      {{ assetData.details }}
    </div>

    <!-- References -->
    <div v-if="assetData?.references?.length" class="pt-2 border-t border-slate-800/80">
      <h5 class="text-[11px] font-semibold text-slate-400 mb-1">References & Standards:</h5>
      <ul class="space-y-1.5">
        <li
          v-for="(ref, idx) in assetData.references"
          :key="idx"
          class="text-[11px]"
        >
          <a
            :href="ref.startsWith('http') ? ref : `https://www.google.com/search?q=${encodeURIComponent(ref)}`"
            target="_blank"
            class="text-sky-400 hover:text-sky-300 hover:underline flex items-start gap-1.5 break-words"
            :title="ref.startsWith('http') ? 'Visit Link' : 'Search on Google'"
          >
            <ExternalLink class="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span class="flex-1">{{ ref }}</span>
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
