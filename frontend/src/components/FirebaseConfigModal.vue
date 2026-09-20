<!-- This component is no longer used. Firebase config is hardcoded. -->
<script setup lang="ts">
defineProps<{ isOpen: boolean }>();
defineEmits<{ (e: 'close'): void }>();
</script>
<template>
  <div v-if="false"></div>
</template>
