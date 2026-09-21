<script setup lang="ts">
import { AlertTriangle, Info, CheckCircle } from 'lucide-vue-next';

defineProps<{
  isOpen: boolean;
  title: string;
  message: string;
  type?: 'warning' | 'info' | 'error';
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
}>();
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
    <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
      <div
        class="mx-auto w-12 h-12 rounded-full mb-4 flex items-center justify-center"
        :class="{
          'bg-amber-500/20 text-amber-500 border border-amber-500/50': type === 'warning' || !type,
          'bg-rose-500/20 text-rose-500 border border-rose-500/50': type === 'error',
          'bg-sky-500/20 text-sky-500 border border-sky-500/50': type === 'info'
        }"
      >
        <AlertTriangle v-if="type === 'warning' || !type" class="w-6 h-6" />
        <Info v-else-if="type === 'info'" class="w-6 h-6" />
        <CheckCircle v-else class="w-6 h-6" />
      </div>

      <h3 class="text-lg font-bold text-white mb-2">{{ title }}</h3>
      <p class="text-sm text-slate-400 mb-6">{{ message }}</p>

      <button
        @click="emit('confirm')"
        class="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition border border-slate-700"
      >
        Confirm
      </button>
    </div>
  </div>
</template>
