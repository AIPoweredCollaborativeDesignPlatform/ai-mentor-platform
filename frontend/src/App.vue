<script setup lang="ts">
import ToastContainer from './components/ToastContainer.vue';

// Injected at build time by vite.config.ts (version from package.json, Asia/Taipei build time)
const versionLabel = `v${__APP_VERSION__} (${__BUILD_TIME__})`;
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 selection:bg-sky-500 selection:text-white">
    <ToastContainer />
    <!-- No <transition> here: an out-in transition hangs when a view swaps its root element (e.g. MeetingRoomView's
         "Verifying" → room layout), leaving the old view on screen after navigation -->
    <router-view />

    
    <!-- Unified hidden version number -->
    <div class="fixed bottom-1 right-2 text-[9px] text-slate-500/25 pointer-events-none select-none z-50 font-mono">
      {{ versionLabel }}
    </div>
  </div>
</template>
