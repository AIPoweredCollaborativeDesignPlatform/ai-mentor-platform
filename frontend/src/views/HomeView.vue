<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import {
  Sparkles,
  Users,
  LogIn,
  KeyRound,
  ArrowRight,
  LayoutDashboard,
  Search,
  X,
  Loader2
} from 'lucide-vue-next';
import { computed, onMounted, watch } from 'vue';
import { listProfiles } from '../services/admin';
import { modeLabel, type AiProfile } from '../utils/aiProfiles';
import { t } from '../i18n';
import PageNav from '../components/PageNav.vue';

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const pinInput = ref('');
const roomNameInput = ref('');
const errorMsg = ref('');
const isLoading = ref(false);

import { ROOM_EMOJI_LIST } from '../constants/roomEmojis';

const selectedRoomEmoji = ref(ROOM_EMOJI_LIST[Math.floor(Math.random() * ROOM_EMOJI_LIST.length)].emoji);
const isEmojiPickerOpen = ref(false);
const emojiSearchQuery = ref('');
const selectedEmojiCategory = ref<string>('all');

const filteredRoomEmojis = computed(() => {
  const q = emojiSearchQuery.value.trim().toLowerCase();
  return ROOM_EMOJI_LIST.filter(item => {
    const matchCat = selectedEmojiCategory.value === 'all' || item.cat === selectedEmojiCategory.value;
    if (!matchCat) return false;
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.emoji.includes(q);
  });
});

const selectRoomEmoji = (em: string) => {
  selectedRoomEmoji.value = em;
  isEmojiPickerOpen.value = false;
};

// Study staff (administrator and observers) pick the experiment condition when creating a room
// (others get the default) and may create it as a participant instead of the researcher.
// The role and the profile list are remembered from the last visit so these controls appear at once.
const PROFILE_CACHE = 'ai_mentor_profiles_cache';
const isStudyAdmin = computed(() => authStore.isObserver);
const readCachedProfiles = (): AiProfile[] => {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_CACHE) || '[]');
  } catch {
    return [];
  }
};
const profiles = ref<AiProfile[]>(isStudyAdmin.value ? readCachedProfiles() : []);
const selectedProfileId = ref('');
const createAsParticipant = ref(false);
let profilesLoaded = false;
const loadProfiles = async () => {
  if (profilesLoaded || !isStudyAdmin.value) return;
  await authStore.waitForAuthReady().catch(() => {});
  const list = await listProfiles().catch(() => null);
  if (!list) return; // retried when the role is confirmed or the menu is opened
  profilesLoaded = true;
  profiles.value = list;
  try {
    localStorage.setItem(PROFILE_CACHE, JSON.stringify(list.map(p => ({ id: p.id, name: p.name, mode: p.mode }))));
  } catch {
    // Storage blocked: the list just loads fresh next time
  }
};
onMounted(async () => {
  // The remembered role is good enough to fetch with (rules decide)
  loadProfiles();
  await authStore.waitForRole();
  loadProfiles();
});
// Signing in on this page (or the role arriving later) makes the staff controls appear: load the list then
watch(isStudyAdmin, loadProfiles);

const handleCreateRoom = async () => {
  isLoading.value = true;
  try {
    const newRoom = await roomStore.createRoom(roomNameInput.value, selectedRoomEmoji.value, {
      asParticipant: !isStudyAdmin.value || createAsParticipant.value,
      profileId: (isStudyAdmin.value && selectedProfileId.value) || undefined
    });
    // No host: the creator fills in nickname and consent like everyone else
    router.push(newRoom.hostUid ? `/room/${newRoom.roomId}` : `/waiting/${newRoom.roomId}?as=participant`);
  } catch (err: any) {
    console.error(err);
    roomStore.pushToast(t('home.createFailed'), err?.message || t('common.tryAgain'), 'error');
  } finally {
    isLoading.value = false;
  }
};

const handleJoinRoom = async () => {
  const pin = pinInput.value.trim();
  // New rooms have 4 digits; older rooms keep their 6-digit PINs
  if (!/^(\d{4}|\d{6})$/.test(pin)) {
    errorMsg.value = t('home.invalidPin');
    return;
  }
  errorMsg.value = '';
  isLoading.value = true;
  try {
    const roomCheck = await roomStore.checkRoomExists(pin);
    if (!roomCheck.exists) {
      errorMsg.value = t('home.roomNotFound', { pin });
      isLoading.value = false;
      return;
    }
    router.push(`/waiting/room_${pin}`);
  } catch (err: any) {
    errorMsg.value = err.message || t('home.joinFailed');
  } finally {
    isLoading.value = false;
  }
};

const isGoogleSigningIn = ref(false);
const authErrorMsg = ref('');

const handleGoogleSignIn = async () => {
  if (isGoogleSigningIn.value) return;
  isGoogleSigningIn.value = true;
  authErrorMsg.value = '';
  try {
    await authStore.upgradeWithGoogle();
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
      let friendlyMsg = err?.message || t('home.googleFailed');
      if (err?.code === 'auth/popup-blocked') {
        friendlyMsg = t('home.popupBlocked');
      } else if (err?.code === 'auth/unauthorized-domain') {
        friendlyMsg = t('home.unauthorizedDomain');
      } else if (err?.code === 'auth/network-request-failed') {
        friendlyMsg = t('home.networkError');
      }
      authErrorMsg.value = friendlyMsg;
      console.warn('Google sign-in error:', err);
    }
  } finally {
    isGoogleSigningIn.value = false;
  }
};
</script>

<template>
  <div class="min-h-[100dvh] flex flex-col items-center justify-center p-4 sm:p-6 bg-slate-950 overflow-y-auto relative">
    <PageNav />
    <!-- Brand / Header -->
    <div class="text-center max-w-xl mb-5">
      <h1 class="text-xl sm:text-2xl font-black text-ink mb-1.5 tracking-tight flex items-center justify-center gap-2">
        <Sparkles class="w-5 h-5 sm:w-6 sm:h-6 inline-block text-sky-400 mr-1.5" />
        {{ t('home.title') }}
      </h1>
      <p class="text-slate-400 text-xs sm:text-sm">
        {{ t('home.subtitle') }}
      </p>
    </div>

    <!-- Main Card -->
    <div class="w-full max-w-lg bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-2xl">
      <!-- Account (nickname and avatar are entered on the join page, together with the consent form) -->
      <section class="mb-5">
        <!-- Google Sign-in -->
        <div v-if="!authStore.isGoogleLinked">
          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-400">{{ t('home.signInHint') }}</span>
            <button
              @click="handleGoogleSignIn"
              :disabled="isGoogleSigningIn"
              class="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 font-medium px-3 py-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 transition cursor-pointer disabled:opacity-50"
            >
              <Loader2 v-if="isGoogleSigningIn" class="w-3.5 h-3.5 animate-spin" />
              <LogIn v-else class="w-3.5 h-3.5" />
              {{ isGoogleSigningIn ? t('common.signingIn') : t('common.signInWithGoogle') }}
            </button>
          </div>
          <p v-if="authErrorMsg" class="text-[11px] text-rose-400 mt-2 bg-rose-950/40 p-2 rounded-lg border border-rose-900/60 leading-relaxed">
            {{ authErrorMsg }}
          </p>
        </div>
        <div v-else class="flex items-center justify-between text-xs">
          <span class="text-emerald-400 flex items-center gap-1">
            {{ t('home.signedIn', { name: authStore.displayName || authStore.email?.split('@')[0] || t('common.user') }) }}
          </span>
          <router-link to="/dashboard" class="text-sky-400 hover:underline flex items-center gap-1 font-semibold">
            <LayoutDashboard class="w-3.5 h-3.5" /> {{ t('common.dashboard') }}
          </router-link>
        </div>
      </section>

      <hr class="border-slate-800 mb-5" />

      <!-- Room Actions -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <!-- Create Room -->
        <div class="flex flex-col relative">
          <!-- Room Emoji & Name Input Row -->
          <div class="flex items-center gap-2 mb-2 relative">
            <!-- Room Emoji Trigger Button -->
            <button
              type="button"
              @click="isEmojiPickerOpen = !isEmojiPickerOpen"
              class="h-[44px] w-[44px] shrink-0 bg-slate-950 hover:bg-slate-900 border border-slate-700 hover:border-sky-500 rounded-xl text-xl flex items-center justify-center transition cursor-pointer shadow-inner"
              :title="t('home.emojiTitle')"
            >
              {{ selectedRoomEmoji }}
            </button>

            <!-- Room Name Input -->
            <input
              v-model="roomNameInput"
              type="text"
              :placeholder="t('home.roomNamePlaceholder')"
              class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition min-h-[44px]"
            />

            <!-- Room Emoji Picker Popover -->
            <div
              v-if="isEmojiPickerOpen"
              class="absolute z-50 top-12 left-0 w-72 sm:w-80 bg-slate-900/95 border border-slate-700 rounded-2xl shadow-2xl p-3 text-slate-100 animate-in fade-in zoom-in-95 duration-100"
            >
              <div class="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs">
                <span class="font-semibold text-slate-300">{{ t('home.chooseEmblem') }}</span>
                <button
                  type="button"
                  @click="isEmojiPickerOpen = false"
                  class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-ink"
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <!-- English Search Filter -->
              <div class="relative mb-2">
                <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  v-model="emojiSearchQuery"
                  type="text"
                  :placeholder="t('home.emojiSearch')"
                  class="w-full bg-slate-950 border border-slate-700/80 rounded-xl pl-8 pr-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              <!-- Category Pills -->
              <div class="flex items-center gap-1 overflow-x-auto pb-1.5 mb-2 no-scrollbar text-[10px]">
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'all'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'all' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiAll') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'tools'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'tools' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiTools') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'food'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'food' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiFood') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'transport'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'transport' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiVehicles') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'characters'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'characters' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiPeople') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'nature'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'nature' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiNature') }}</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'activities'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'activities' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >{{ t('home.emojiActivities') }}</button>
              </div>

              <!-- Emoji Grid -->
              <div class="grid grid-cols-6 gap-1 max-h-44 overflow-y-auto p-1">
                <button
                  v-for="item in filteredRoomEmojis"
                  :key="item.emoji"
                  type="button"
                  @click="selectRoomEmoji(item.emoji)"
                  class="h-9 w-9 rounded-xl hover:bg-slate-800 flex items-center justify-center text-lg hover:scale-110 transition cursor-pointer"
                  :class="selectedRoomEmoji === item.emoji ? 'bg-sky-600/40 ring-1 ring-sky-500' : ''"
                  :title="item.name"
                >
                  {{ item.emoji }}
                </button>
                <div v-if="filteredRoomEmojis.length === 0" class="col-span-6 py-4 text-center text-xs text-slate-500">
                  {{ t('home.noEmoji') }}
                </div>
              </div>
            </div>
          </div>
          <select
            v-if="isStudyAdmin"
            v-model="selectedProfileId"
            @focus="loadProfiles"
            class="mb-2 w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
            :title="t('home.profileTitle')"
          >
            <option value="">{{ t('home.defaultProfile') }}</option>
            <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }} · {{ modeLabel(p.mode, true) }}</option>
          </select>
          <label v-if="isStudyAdmin" class="mb-2 flex items-start gap-2 text-xs text-slate-300 cursor-pointer" :title="t('home.asParticipantTitle')">
            <input type="checkbox" v-model="createAsParticipant" class="mt-0.5" />
            <span>{{ t('home.asParticipant') }} <span class="text-slate-500">{{ t('home.asParticipantNote') }}</span></span>
          </label>
          <button
            @click="handleCreateRoom"
            :disabled="isLoading"
            class="flex-1 flex flex-col justify-between p-4 rounded-xl bg-sky-500 hover:bg-sky-600 text-white shadow-lg transition text-left group disabled:opacity-50 min-h-[110px] cursor-pointer"
          >
            <!-- sky-500/600 and white are the same in both themes, so this block does not change with day/night -->
            <div>
              <div class="p-2 bg-white/15 rounded-lg w-fit mb-2">
                <Users class="w-4 h-4 text-white" />
              </div>
              <h3 class="font-bold text-sm mb-0.5">{{ t('home.createMeeting') }}</h3>
              <p class="text-[11px] text-white/85">
                {{ t('home.createHint') }}
              </p>
            </div>
            <div class="mt-3 flex items-center gap-1 text-xs font-semibold text-white group-hover:translate-x-1 transition">
              {{ isLoading ? t('home.creating') : t('home.createNow') }} <ArrowRight class="w-3.5 h-3.5" />
            </div>
          </button>
        </div>

        <!-- Join Room -->
        <div class="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col justify-between">
          <div>
            <div class="p-2 bg-slate-800 rounded-lg w-fit mb-2">
              <KeyRound class="w-4 h-4 text-slate-300" />
            </div>
            <h3 class="font-bold text-sm text-slate-100 mb-0.5">{{ t('home.joinMeeting') }}</h3>
            <p class="text-[11px] text-slate-400 mb-2">
              {{ t('home.joinHint') }}
            </p>
            <input
              v-model="pinInput"
              type="text"
              maxlength="6"
              :placeholder="t('home.pinPlaceholder')"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-center text-lg sm:text-base tracking-widest font-mono text-ink placeholder-slate-600 focus:outline-none focus:border-sky-500 min-h-[44px]"
            />
            <p v-if="errorMsg" class="text-[11px] text-rose-400 mt-1">{{ errorMsg }}</p>
          </div>
          <button
            @click="handleJoinRoom"
            :disabled="isLoading"
            class="mt-3 w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition disabled:opacity-50 min-h-[44px] cursor-pointer"
          >
            {{ isLoading ? t('home.requesting') : t('home.requestJoin') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Academic Research & AI Privacy Disclosure (IRB Compliance Notice) -->
    <div class="mt-6 text-center max-w-lg px-4">
      <p class="text-[11px] text-slate-500 leading-relaxed">
        <strong class="text-slate-400 font-medium">{{ t('home.disclosureTitle') }}</strong>
        {{ t('home.disclosure') }}
      </p>
    </div>
  </div>
</template>
