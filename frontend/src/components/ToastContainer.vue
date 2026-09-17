<script setup lang="ts">
import { useRoomStore } from '../stores/room';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-vue-next';

const roomStore = useRoomStore();
</script>

<template>
  <div class="fixed top-5 right-5 z-50 flex flex-col gap-3 max-w-sm pointer-events-none">
    <transition-group
      enter-active-class="transform ease-out duration-300 transition"
      enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
      enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
      leave-active-class="transition ease-in duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-for="toast in roomStore.toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-3 p-4 rounded-xl shadow-2xl border backdrop-blur-md transition-all"
        :class="{
          'bg-emerald-950/85 border-emerald-500/40 text-emerald-100': toast.type === 'success',
          'bg-amber-950/85 border-amber-500/40 text-amber-100': toast.type === 'warning',
          'bg-slate-900/90 border-slate-700 text-slate-100': toast.type === 'info'
        }"
      >
        <div class="mt-0.5 shrink-0">
          <CheckCircle2 v-if="toast.type === 'success'" class="w-5 h-5 text-emerald-400" />
          <AlertCircle v-else-if="toast.type === 'warning'" class="w-5 h-5 text-amber-400" />
          <Info v-else class="w-5 h-5 text-sky-400" />
        </div>
        <div class="flex-1 text-sm">
          <h4 class="font-semibold">{{ toast.title }}</h4>
          <p class="text-xs mt-0.5 opacity-90">{{ toast.description }}</p>
        </div>
        <button
          @click="roomStore.removeToast(toast.id)"
          class="text-slate-400 hover:text-slate-200 transition"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </transition-group>
  </div>
</template>
