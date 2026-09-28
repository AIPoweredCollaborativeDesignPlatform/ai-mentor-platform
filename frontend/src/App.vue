<script setup lang="ts">
import ToastContainer from './components/ToastContainer.vue';
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 selection:bg-sky-500 selection:text-white">
    <ToastContainer />
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    
    <!-- Unified hidden version number -->
    <div class="fixed bottom-1 right-2 text-[9px] text-slate-500/20 pointer-events-none select-none z-50 font-mono">
    v1.9.4 (2026-09-29 03:15:00)
  </div>
  </div>
</template>
