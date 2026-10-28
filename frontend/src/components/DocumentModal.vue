<script setup lang="ts">
import { t } from '../i18n';
import { ref, computed } from 'vue';
import { FileText, Download, Copy, Check, X } from 'lucide-vue-next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps<{
  title: string;
  content: string;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const renderedContent = computed(() => {
  if (!props.content) return '';
  const rawHtml = marked.parse(props.content) as string;
  return DOMPurify.sanitize(rawHtml);
});

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
            {{ copied ? t('header.copied') : t('doc.copyText') }}
          </button>
          <button
            @click="downloadMarkdown"
            class="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition shadow"
          >
            <Download class="w-3.5 h-3.5" />
            {{ t('doc.downloadMd') }}
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
      <div 
        class="p-6 overflow-y-auto bg-slate-900/90 prose prose-sm prose-invert max-w-none text-slate-300 prose-td:border-slate-700 prose-th:bg-slate-800 prose-table:border-slate-700 markdown-body"
        v-html="renderedContent"
      >
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1.25rem 0;
  border: 1px solid #334155;
  border-radius: 0.5rem;
  overflow: hidden;
  display: block;
  overflow-x: auto;
}
:deep(th) {
  background-color: #1e293b;
  color: #38bdf8;
  font-weight: 600;
  text-align: left;
  padding: 0.625rem 0.875rem;
  border: 1px solid #334155;
  white-space: nowrap;
}
:deep(td) {
  padding: 0.5rem 0.875rem;
  border: 1px solid #334155;
  color: #cbd5e1;
}
:deep(tr:nth-child(even)) {
  background-color: rgba(30, 41, 59, 0.4);
}
:deep(tr:hover) {
  background-color: rgba(56, 189, 248, 0.05);
}
:deep(blockquote) {
  border-left: 3px solid #38bdf8;
  padding-left: 1rem;
  color: #94a3b8;
  font-style: italic;
  margin: 1rem 0;
}
</style>
