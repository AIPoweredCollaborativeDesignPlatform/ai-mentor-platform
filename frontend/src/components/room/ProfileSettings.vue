<script setup lang="ts">
import { t } from '../../i18n';
import { computed, ref, watch } from 'vue';
import { Check, Loader2, LogIn, UserRound } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';

/** My nickname and avatar in this room (settings drawer); the server announces the change to the room. */
const authStore = useAuthStore();
const roomStore = useRoomStore();

const AVATARS = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];
const editName = ref(authStore.displayName);
const editAvatar = ref(authStore.avatar);
// Follow changes made elsewhere (another tab, the server) while nothing is being edited
watch(() => [authStore.displayName, authStore.avatar] as const, ([name, avatar]) => {
  if (!changed.value) {
    editName.value = name;
    editAvatar.value = avatar;
  }
});
const changed = computed(() => editName.value.trim() !== authStore.displayName || editAvatar.value !== authStore.avatar);

const saved = ref(false);
const save = async () => {
  if (!editName.value.trim() || !changed.value) return;
  await roomStore.updateParticipantProfile(editName.value.trim(), editAvatar.value);
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
};

const isSigningIn = ref(false);
const signInWithGoogle = async () => {
  if (isSigningIn.value) return;
  isSigningIn.value = true;
  try {
    // Signing in replaces the anonymous uid; the server moves rooms the guest hosted (claimGuestRooms)
    await authStore.upgradeWithGoogle();
    roomStore.pushToast(t('profile.signedInTitle'), t('profile.signedInText', { name: authStore.accountName }), 'success');
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
      roomStore.pushToast(t('profile.signInFailedTitle'), err?.message || t('profile.signInFailedText'), 'error');
    }
  } finally {
    isSigningIn.value = false;
  }
};
</script>

<template>
  <section class="p-4 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-3 shadow-lg">
    <div class="flex items-center gap-2">
      <UserRound class="w-4 h-4 text-sky-400" />
      <h4 class="font-semibold text-sm text-slate-100">{{ t('profile.title') }}</h4>
    </div>
    <form @submit.prevent="save" class="flex items-center gap-2">
      <span class="text-2xl w-11 h-11 shrink-0 flex items-center justify-center bg-slate-800 rounded-xl border border-slate-700">{{ editAvatar }}</span>
      <input
        v-model="editName"
        type="text"
        maxlength="20"
        enterkeyhint="done"
        class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-sky-500 min-h-[44px]"
        :placeholder="t('profile.namePlaceholder')"
      />
      <button
        :disabled="!changed || !editName.trim()"
        class="shrink-0 px-3 min-h-[44px] rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition disabled:opacity-40 inline-flex items-center gap-1"
      >
        <Check v-if="saved" class="w-3.5 h-3.5" />{{ saved ? t('profile.saved') : t('profile.save') }}
      </button>
    </form>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="av in AVATARS"
        :key="av"
        type="button"
        @click="editAvatar = av"
        class="w-9 h-9 rounded-lg text-base flex items-center justify-center transition border"
        :class="editAvatar === av ? 'bg-sky-500/20 border-sky-400' : 'bg-slate-950 border-slate-800 hover:border-slate-700'"
      >
        {{ av }}
      </button>
    </div>

    <div v-if="!authStore.isGoogleLinked" class="pt-3 border-t border-slate-800">
      <p class="text-xs text-slate-400 mb-2">{{ t('profile.saveHint') }}</p>
      <button
        type="button"
        @click="signInWithGoogle"
        :disabled="isSigningIn"
        class="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-ink border border-slate-700 text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        <Loader2 v-if="isSigningIn" class="w-3.5 h-3.5 animate-spin text-sky-400" />
        <LogIn v-else class="w-3.5 h-3.5 text-sky-400" />
        <span>{{ isSigningIn ? t('common.signingIn') : t('common.signInWithGoogle') }}</span>
      </button>
    </div>
  </section>
</template>
