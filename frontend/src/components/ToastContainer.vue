<script setup lang="ts">
import { useRoomStore } from '../stores/room';
import { Info, CheckCircle, AlertCircle, X } from 'lucide-vue-next';

const roomStore = useRoomStore();
</script>

<template>
  <div class="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
    <transition-group name="toast">
      <div
        v-for="toast in roomStore.toasts"
        :key="toast.id"
        class="pointer-events-auto w-full rounded-xl shadow-2xl p-4 border backdrop-blur-md flex flex-col gap-3 transition-all duration-300 transform"
        :class="{
          'bg-slate-900/90 border-slate-700': toast.type === 'info',
          'bg-emerald-950/90 border-emerald-800 text-emerald-100': toast.type === 'success',
          'bg-rose-950/90 border-rose-800 text-rose-100': toast.type === 'error'
        }"
      >
        <div class="flex items-start gap-3">
          <Info v-if="toast.type === 'info'" class="w-5 h-5 text-sky-400 shrink-0" />
          <CheckCircle v-else-if="toast.type === 'success'" class="w-5 h-5 text-emerald-400 shrink-0" />
          <AlertCircle v-else class="w-5 h-5 text-rose-400 shrink-0" />
          
          <div class="flex-1 flex flex-col">
            <h4 class="text-sm font-bold text-white">{{ toast.title }}</h4>
            <p class="text-[11px] text-slate-300">{{ toast.description }}</p>
          </div>
          
          <button @click="roomStore.removeToast(toast.id)" class="text-white/50 hover:text-white transition mt-0.5">
            <X class="w-4 h-4" />
          </button>
        </div>

        <div v-if="toast.actions?.length" class="flex gap-2 justify-end mt-1">
          <button
            v-for="action in toast.actions"
            :key="action.label"
            @click="() => { action.onClick(); roomStore.removeToast(toast.id); }"
            class="px-3 py-1.5 rounded-lg text-xs font-semibold transition shadow-sm border"
            :class="{
              'bg-sky-600 hover:bg-sky-500 text-white border-sky-500': action.type === 'primary' || !action.type,
              'bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border-rose-500/30': action.type === 'danger'
            }"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-20px) scale(0.95);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.95);
}
</style>
