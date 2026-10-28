<script setup lang="ts">
import { Languages } from 'lucide-vue-next';
import { currentLocale, isRoomLocale, setLocale, t } from '../i18n';

/** 中文 / EN toggle for pages outside rooms; hidden while a room's language is in charge. */
const toggle = () => setLocale(currentLocale.value === 'zh-TW' ? 'en' : 'zh-TW');
</script>

<template>
  <button
    v-if="!isRoomLocale"
    type="button"
    @click="toggle"
    class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 transition"
    :title="t('common.switchLanguage')"
  >
    <Languages class="w-3.5 h-3.5" />
    {{ currentLocale === 'zh-TW' ? 'EN' : '中文' }}
  </button>
</template>
