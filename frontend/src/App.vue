<script setup lang="ts">
import ToastContainer from './components/ToastContainer.vue';
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 selection:bg-sky-500 selection:text-white">
    <router-view />
    <ToastContainer />
  </div>
</template>
