<script setup lang="ts">
import { Moon, Sun } from 'lucide-vue-next';
import { t } from '../i18n';
import { currentTheme, setTheme } from '../theme';

/** Day / night toggle; available everywhere (the theme does not change the experiment condition). */
const toggle = () => setTheme(currentTheme.value === 'dark' ? 'light' : 'dark');
</script>

<template>
  <button
    type="button"
    @click="toggle"
    class="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition"
    :title="currentTheme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
    :aria-label="currentTheme === 'dark' ? t('common.themeLight') : t('common.themeDark')"
  >
    <Sun v-if="currentTheme === 'dark'" class="w-3.5 h-3.5" />
    <Moon v-else class="w-3.5 h-3.5" />
  </button>
</template>
