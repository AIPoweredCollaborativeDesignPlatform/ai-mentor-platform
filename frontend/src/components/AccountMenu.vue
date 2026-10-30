<script setup lang="ts">
import { ref } from 'vue';
import { Check, ChevronDown, UserPlus, UserRound, X } from 'lucide-vue-next';
import { t } from '../i18n';
import { useAuthStore } from '../stores/auth';

/**
 * Account switcher (PageNav): remembered Google accounts, another account, or anonymous guest.
 * Firebase holds one signed-in account at a time, so switching signs in again with the chosen account
 * pre-selected, then reloads the page so every view starts clean with the new identity.
 */
const authStore = useAuthStore();
const open = ref(false);
const busy = ref(false);
const error = ref('');

const run = async (action: () => Promise<unknown>) => {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
    window.location.reload();
  } catch (e: any) {
    if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') error.value = e?.message || String(e);
    busy.value = false;
  }
};
const switchTo = (accountEmail?: string) => {
  if (accountEmail && authStore.isGoogleLinked && accountEmail === authStore.email) return (open.value = false);
  run(() => authStore.upgradeWithGoogle(accountEmail));
};
const toGuest = () => run(() => authStore.logoutGoogle());
</script>

<template>
  <div class="relative">
    <button type="button" class="page-nav-btn max-w-[11rem]" :title="t('acct.switch')" @click="open = !open">
      <UserRound class="w-3.5 h-3.5 shrink-0" />
      <span class="truncate hidden sm:inline">{{ authStore.isGoogleLinked ? authStore.accountName : t('acct.guest') }}</span>
      <ChevronDown class="w-3 h-3 shrink-0" />
    </button>
    <template v-if="open">
      <div class="fixed inset-0 z-40" @click="open = false"></div>
      <div class="absolute right-0 mt-1 z-50 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-700 bg-slate-950 shadow-xl p-1.5 text-xs">
        <p v-if="authStore.knownAccounts.length" class="px-2 pt-1 pb-1.5 text-[11px] text-slate-500">{{ t('acct.title') }}</p>
        <div v-for="a in authStore.knownAccounts" :key="a.email" class="group flex items-center gap-2 rounded-lg hover:bg-slate-800">
          <button type="button" class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left disabled:opacity-50" :disabled="busy" @click="switchTo(a.email)">
            <img v-if="a.photo" :src="a.photo" class="w-6 h-6 rounded-full shrink-0" referrerpolicy="no-referrer" alt="" />
            <UserRound v-else class="w-6 h-6 p-1 rounded-full bg-slate-800 text-slate-400 shrink-0" />
            <span class="min-w-0">
              <span class="block truncate text-slate-200">{{ a.name }}</span>
              <span class="block truncate text-[11px] text-slate-500">{{ a.email }}</span>
            </span>
            <Check v-if="authStore.isGoogleLinked && a.email === authStore.email" class="w-3.5 h-3.5 ml-auto text-sky-400 shrink-0" />
          </button>
          <button
            v-if="!(authStore.isGoogleLinked && a.email === authStore.email)"
            type="button"
            class="p-1.5 mr-1 rounded text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
            :title="t('acct.forget')"
            @click="authStore.forgetAccount(a.email)"
          >
            <X class="w-3 h-3" />
          </button>
        </div>
        <div v-if="authStore.knownAccounts.length" class="my-1 border-t border-slate-800"></div>
        <button type="button" class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 disabled:opacity-50" :disabled="busy" @click="switchTo()">
          <UserPlus class="w-4 h-4" /> {{ t('acct.other') }}
        </button>
        <button type="button" class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 disabled:opacity-50" :disabled="busy || !authStore.isGoogleLinked" @click="toGuest">
          <UserRound class="w-4 h-4" /> {{ authStore.isGoogleLinked ? t('acct.toGuest') : t('acct.isGuest') }}
        </button>
        <p v-if="error" class="px-2 pt-1 text-[11px] text-rose-400">{{ error }}</p>
      </div>
    </template>
  </div>
</template>
