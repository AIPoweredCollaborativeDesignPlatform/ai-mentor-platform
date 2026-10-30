<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Home, Settings2 } from 'lucide-vue-next';
import { t } from '../i18n';
import { useAuthStore } from '../stores/auth';
import AccountMenu from './AccountMenu.vue';
import LocaleSwitch from './LocaleSwitch.vue';
import ThemeSwitch from './ThemeSwitch.vue';

/**
 * The same top-right cluster on the home, dashboard and admin pages:
 * [page actions (slot)] [Home] [Admin, staff only] [account] [day/night] [language]. The link to the current page is left out.
 */
const route = useRoute();
const authStore = useAuthStore();
const showHome = computed(() => route.path !== '/');
const showAdmin = computed(() => authStore.isObserver && route.path !== '/admin');
</script>

<template>
  <div class="fixed top-3 right-3 z-40 flex items-center gap-1.5">
    <slot />
    <router-link v-if="showHome" to="/" class="page-nav-btn">
      <Home class="w-3.5 h-3.5" /> {{ t('common.home') }}
    </router-link>
    <router-link v-if="showAdmin" to="/admin" class="page-nav-btn">
      <Settings2 class="w-3.5 h-3.5" /> {{ t('common.adminPanel') }}
    </router-link>
    <AccountMenu />
    <ThemeSwitch />
    <LocaleSwitch />
  </div>
</template>

<style>
/* Shared look of every button in the cluster (also used by page actions passed through the slot) */
.page-nav-btn {
  @apply inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-300 hover:bg-slate-800 transition disabled:opacity-50;
}
</style>
