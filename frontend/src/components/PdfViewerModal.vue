<script setup lang="ts">
import { X, Download, FileText, ExternalLink } from 'lucide-vue-next';

const props = defineProps<{
  isOpen: boolean;
  title: string;
  pdfUrl: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const handleDownload = () => {
  const a = document.createElement('a');
  a.href = props.pdfUrl;
  a.download = props.title || 'document.pdf';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-xs animate-fade-in"
    @click="emit('close')"
  >
    <div
      class="relative w-full max-w-4xl h-[85vh] bg-slate-900 border border-slate-700/80 rounded-2xl flex flex-col shadow-2xl overflow-hidden"
      @click.stop
    >
      <!-- Header -->
      <div class="h-14 px-4 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="p-2 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 shrink-0">
            <FileText class="w-4 h-4" />
          </div>
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-white truncate max-w-sm sm:max-w-md">
              {{ title || 'PDF Document' }}
            </h3>
            <p class="text-[10px] text-slate-400">PDF In-App Viewer</p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            @click="handleDownload"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
            title="Download PDF"
          >
            <Download class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">Download</span>
          </button>
          <a
            :href="pdfUrl"
            target="_blank"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Open in new tab"
          >
            <ExternalLink class="w-4 h-4" />
          </a>
          <button
            @click="emit('close')"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </div>

      <!-- PDF Embedded View -->
      <div class="flex-1 w-full h-full bg-slate-950 p-1">
        <iframe
          :src="pdfUrl"
          class="w-full h-full rounded-xl border border-slate-800 bg-white"
          title="PDF Viewer"
        ></iframe>
      </div>
    </div>
  </div>
</template>
