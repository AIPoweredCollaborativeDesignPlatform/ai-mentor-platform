<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Eye, Loader2, LogIn, ShieldAlert, UserPlus, Users } from 'lucide-vue-next';
import { DEFAULT_CONSENT_TEXT, DEFAULT_CONSENT_TEXT_ZH } from '../constants/consent';
import { setRoomLocale, t } from '../i18n';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';

/**
 * Entry to a study room (functions/src/session.js): nickname + consent, then the server approves
 * directly. Returning members and the researcher are let in without the form. When the room is
 * full the request is retried every few seconds, so a free seat is taken automatically.
 * Observers (and the administrator, outside rooms they created) first choose: watch invisibly, or
 * join as a participant (nickname + consent, counted like everyone else).
 */
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const roomId = route.params.roomId as string;
const pin = roomId.replace('room_', '');

type View = 'checking' | 'choose' | 'not_found' | 'form' | 'joining' | 'full' | 'ended' | 'error';
const view = ref<View>('checking');
const roomName = ref('');
const consentText = ref('');
const agreed = ref(false);
const errorText = ref('');
const fullInfo = ref({ online: 0, max: 0 });
const asParticipant = ref(false);

const ADJECTIVES = ['Curious', 'Clever', 'Creative', 'Swift', 'Cosmic', 'Bold', 'Bright', 'Calm'];
const NOUNS = ['Rocket', 'Falcon', 'Owl', 'Fox', 'Panda', 'Otter', 'Eagle', 'Dolphin'];
const AVATARS = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡', '🦅', '🐬'];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

// Always a nickname: the Google account name is never used in study rooms
const nickname = ref(`${pick(ADJECTIVES)} ${pick(NOUNS)}`);
const avatar = ref(pick(AVATARS));

let retryTimer: ReturnType<typeof setTimeout> | undefined;
const FULL_RETRY_MS = 5000;

const enterRoom = () => router.replace(`/room/${roomId}`);

const attempt = async (consent: boolean, retry = false) => {
  clearTimeout(retryTimer);
  try {
    const result = await roomStore.joinRoom(pin, nickname.value.trim() || 'Participant', avatar.value, consent, retry, asParticipant.value);
    if (result.status === 'approved') {
      if (result.role === 'participant' && !result.returning) authStore.updateProfile(nickname.value.trim(), avatar.value);
      enterRoom();
    } else if (result.status === 'consent_required') {
      view.value = 'form';
    } else if (result.status === 'full') {
      fullInfo.value = { online: result.online || 0, max: result.max || 0 };
      view.value = 'full';
      retryTimer = setTimeout(() => attempt(consent, true), FULL_RETRY_MS);
    } else if (result.status === 'ended') {
      view.value = 'ended';
    } else {
      view.value = 'not_found';
    }
  } catch (err: any) {
    errorText.value = err?.message || t('join.couldNotJoin');
    view.value = 'error';
  }
};

const submit = () => {
  if (!agreed.value || !nickname.value.trim()) return;
  view.value = 'joining';
  attempt(true);
};

onMounted(async () => {
  const check = await roomStore.checkRoomExists(pin);
  if (!check.exists) {
    view.value = 'not_found';
    return;
  }
  // From here on the page speaks the room language, like the room itself and its consent text
  setRoomLocale(check.language);
  roomName.value = check.roomName || t('join.meetingName', { pin });
  consentText.value = check.consentText || (check.language === 'en' ? DEFAULT_CONSENT_TEXT : DEFAULT_CONSENT_TEXT_ZH);
  await authStore.waitForRole();
  // ?as=participant: the creator of a room made "as a participant" goes straight to the form
  if (route.query.as === 'participant') asParticipant.value = true;
  // ?as=observer (Admin > Room assignment): straight in, read-only and invisible
  else if (authStore.isObserver && !check.isHost && route.query.as !== 'observer') {
    view.value = 'choose';
    return;
  }
  // Researcher and returning members go straight in; everyone else gets the form
  await attempt(false);
});

const choose = (participant: boolean) => {
  asParticipant.value = participant;
  view.value = 'checking';
  attempt(false);
};

onUnmounted(() => {
  clearTimeout(retryTimer);
  // The room view sets it again from the room document
  setRoomLocale(null);
});
</script>

<template>
  <div class="min-h-[100dvh] flex items-center justify-center p-4 bg-slate-950 overflow-y-auto">
    <div v-if="view === 'checking' || view === 'joining'" class="text-center">
      <div class="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
      <p class="text-xs text-slate-400">{{ view === 'joining' ? t('join.joining') : t('join.checking') }}</p>
    </div>

    <div v-else class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl">
      <!-- Not found / ended / error -->
      <div v-if="view === 'not_found' || view === 'ended' || view === 'error'" class="text-center">
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center text-rose-400">
          <ShieldAlert class="w-7 h-7" />
        </div>
        <h2 class="text-lg font-bold text-ink mb-2">
          {{ view === 'ended' ? t('join.endedTitle') : view === 'error' ? t('join.errorTitle') : t('join.notFoundTitle') }}
        </h2>
        <p class="text-sm text-slate-400 mb-6 leading-relaxed">
          <template v-if="view === 'ended'">{{ t('join.endedText') }}</template>
          <template v-else-if="view === 'error'">{{ errorText }}</template>
          <template v-else>{{ t('join.notFoundText', { pin }) }}</template>
        </p>
        <router-link to="/" class="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition inline-flex items-center gap-2 shadow">
          <ArrowLeft class="w-4 h-4" /> {{ t('join.backHome') }}
        </router-link>
      </div>

      <!-- Observer: watch invisibly or take part -->
      <div v-else-if="view === 'choose'" class="space-y-4">
        <div class="text-center">
          <h2 class="text-xl font-bold text-ink mb-1">"{{ roomName }}"</h2>
          <p class="text-xs text-slate-400">{{ t('join.room') }} <span class="font-mono text-sky-400">{{ pin }}</span></p>
        </div>
        <button @click="choose(false)" class="w-full text-left p-4 rounded-xl border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 transition flex gap-3">
          <Eye class="w-5 h-5 text-violet-300 shrink-0 mt-0.5" />
          <span>
            <span class="block text-sm font-semibold text-ink">{{ t('join.observe') }}</span>
            <span class="block text-xs text-slate-400 mt-0.5">{{ t('join.observeHint') }}</span>
          </span>
        </button>
        <button @click="choose(true)" class="w-full text-left p-4 rounded-xl border border-slate-700 bg-slate-950/60 hover:border-sky-500/60 transition flex gap-3">
          <UserPlus class="w-5 h-5 text-sky-300 shrink-0 mt-0.5" />
          <span>
            <span class="block text-sm font-semibold text-ink">{{ t('join.asParticipant') }}</span>
            <span class="block text-xs text-slate-400 mt-0.5">{{ t('join.asParticipantHint') }}</span>
          </span>
        </button>
        <div class="text-center">
          <router-link to="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition">
            <ArrowLeft class="w-3.5 h-3.5" /> {{ t('common.cancel') }}
          </router-link>
        </div>
      </div>

      <!-- Room full: retried automatically -->
      <div v-else-if="view === 'full'" class="text-center">
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-300">
          <Users class="w-7 h-7" />
        </div>
        <h2 class="text-lg font-bold text-ink mb-2">{{ t('join.fullTitle') }}</h2>
        <p class="text-sm text-slate-400 mb-2 leading-relaxed">
          {{ t('join.fullText', { online: fullInfo.online, max: fullInfo.max }) }}
        </p>
        <p class="text-xs text-slate-500 mb-6 inline-flex items-center gap-1.5">
          <Loader2 class="w-3.5 h-3.5 animate-spin" /> {{ t('join.fullWait') }}
        </p>
        <div>
          <router-link to="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition">
            <ArrowLeft class="w-3.5 h-3.5" /> {{ t('join.goBack') }}
          </router-link>
        </div>
      </div>

      <!-- Nickname + consent -->
      <form v-else @submit.prevent="submit" class="space-y-5">
        <div class="text-center">
          <h2 class="text-xl font-bold text-ink mb-1">{{ t('join.title', { name: roomName }) }}</h2>
          <p class="text-xs text-slate-400">{{ t('join.room') }} <span class="font-mono text-sky-400">{{ pin }}</span></p>
        </div>

        <div class="space-y-2">
          <label class="text-[11px] font-medium text-slate-400" for="nickname">{{ t('join.nickname') }}</label>
          <div class="flex items-center gap-2">
            <span class="text-2xl p-1 bg-slate-800 rounded-lg border border-slate-700 shrink-0">{{ avatar }}</span>
            <input
              id="nickname"
              v-model="nickname"
              maxlength="20"
              class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-base sm:text-sm text-ink focus:outline-none focus:border-sky-500 min-h-[40px]"
            />
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="av in AVATARS"
              :key="av"
              type="button"
              @click="avatar = av"
              class="w-8 h-8 rounded-lg text-sm flex items-center justify-center transition border"
              :class="avatar === av ? 'bg-sky-500/20 border-sky-400' : 'bg-slate-950 border-slate-800 hover:border-slate-700'"
            >
              {{ av }}
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-[11px] font-medium text-slate-400">{{ t('join.consent') }}</div>
          <div class="max-h-48 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-slate-300 bg-slate-950/70 border border-slate-800 rounded-xl p-3">
            {{ consentText || t('common.loading') }}
          </div>
          <label class="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
            <input type="checkbox" v-model="agreed" class="mt-0.5" />
            <span>{{ t('join.agree') }}</span>
          </label>
        </div>

        <button
          type="submit"
          :disabled="!agreed || !nickname.trim()"
          class="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold transition inline-flex items-center justify-center gap-2 shadow disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <LogIn class="w-4 h-4" /> {{ t('join.join') }}
        </button>
        <div class="text-center">
          <router-link to="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition">
            <ArrowLeft class="w-3.5 h-3.5" /> {{ t('common.cancel') }}
          </router-link>
        </div>
      </form>
    </div>
  </div>
</template>
