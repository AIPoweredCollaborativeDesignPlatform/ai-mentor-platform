<script setup lang="ts">
import { t } from '../../i18n';
import { ref, watch } from 'vue';
import { Loader2, LogIn, X } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { useRoomStore } from '../../stores/room';

const props = defineProps<{ isOpen: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const authStore = useAuthStore();
const roomStore = useRoomStore();

const AVATARS = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];
const editName = ref(authStore.displayName);
const editAvatar = ref(authStore.avatar);
watch(() => props.isOpen, open => {
  if (!open) return;
  editName.value = authStore.displayName;
  editAvatar.value = authStore.avatar;
});

const save = () => {
  if (editName.value.trim()) roomStore.updateParticipantProfile(editName.value.trim(), editAvatar.value);
  emit('close');
};

const isSigningIn = ref(false);
const signInWithGoogle = async () => {
  if (isSigningIn.value) return;
  isSigningIn.value = true;
  try {
    // Signing in replaces the anonymous uid; the server moves rooms the guest hosted (claimGuestRooms)
    await authStore.upgradeWithGoogle();
    roomStore.pushToast(t('profile.signedInTitle'), t('profile.signedInText', { name: authStore.displayName }), 'success');
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
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
    <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-bold text-white">{{ t('profile.title') }}</h3>
        <button @click="emit('close')" class="text-slate-400 hover:text-white">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="space-y-3 mb-5">
        <div class="flex items-center gap-3">
          <span class="text-3xl p-1.5 bg-slate-800 rounded-xl border border-slate-700">{{ editAvatar }}</span>
          <input
            v-model="editName"
            type="text"
            maxlength="20"
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
            :placeholder="t('profile.namePlaceholder')"
          />
        </div>

        <div class="flex flex-wrap gap-2 pt-1">
          <button
            v-for="av in AVATARS"
            :key="av"
            @click="editAvatar = av"
            class="w-8 h-8 rounded-lg text-base flex items-center justify-center transition border"
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
            class="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Loader2 v-if="isSigningIn" class="w-3.5 h-3.5 animate-spin text-sky-400" />
            <LogIn v-else class="w-3.5 h-3.5 text-sky-400" />
            <span>{{ isSigningIn ? t('common.signingIn') : t('common.signInWithGoogle') }}</span>
          </button>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <button @click="emit('close')" class="px-4 py-2 rounded-xl text-xs text-slate-400 hover:text-white transition">{{ t('common.cancel') }}</button>
        <button @click="save" class="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold shadow transition">{{ t('profile.save') }}</button>
      </div>
    </div>
  </div>
</template>
