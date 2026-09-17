<script setup lang="ts">
import { ref } from 'vue';
import { FileText, Download, Copy, Check, X } from 'lucide-vue-next';

const props = defineProps<{
  title: string;
  content: string;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const copied = ref(false);

const copyText = () => {
  navigator.clipboard.writeText(props.content);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
};

const downloadMarkdown = () => {
  const blob = new Blob([props.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.title.replace(/\s+/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(url);
};
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
    <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/60">
        <div class="flex items-center gap-2">
          <FileText class="w-5 h-5 text-sky-400" />
          <h3 class="font-semibold text-slate-100">{{ title }}</h3>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="copyText"
            class="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            <Check v-if="copied" class="w-3.5 h-3.5 text-emerald-400" />
            <Copy v-else class="w-3.5 h-3.5" />
            {{ copied ? '已複製' : '複製內文' }}
          </button>
          <button
            @click="downloadMarkdown"
            class="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition shadow"
          >
            <Download class="w-3.5 h-3.5" />
            下載 .md
          </button>
          <button
            @click="emit('close')"
            class="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition ml-1"
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </div>

      <!-- Markdown Content Body -->
      <div class="p-6 overflow-y-auto font-mono text-sm text-slate-300 leading-relaxed whitespace-pre-wrap bg-slate-900/90">
        {{ content }}
      </div>
    </div>
  </div>
</template>
