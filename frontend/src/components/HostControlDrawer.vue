<script setup lang="ts">
import { t } from '../i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useRoomStore } from '../stores/room';
import { db } from '../firebase/config';
import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';
import {
  Sliders,
  Users,
  CheckCircle,
  XCircle,
  ShieldCheck,
  Search,
  X,
  MicOff,
  Mic,
  UserMinus,
  LogOut,
  Power,
  AlertTriangle,
  LogIn,
  Unlock,
  Check,
  Loader2,
  Edit3,
  Sparkles
} from 'lucide-vue-next';

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { ROOM_EMOJI_LIST } from '../constants/roomEmojis';

const props = withDefaults(defineProps<{
  isOpen: boolean;
  topOffset?: string;
}>(), {
  topOffset: '56px'
});

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const showLeaveModal = ref(false);
const showEndAllModal = ref(false);
const showAnonWarningModal = ref(false);
const pendingAction = ref<'leave' | 'end'>('leave');

// Room Details (Name & Emoji Avatar)
const editRoomName = ref(roomStore.currentRoom?.roomName || '');
const editRoomEmoji = ref(roomStore.currentRoom?.roomEmoji || '💡');
const isEmojiPickerOpen = ref(false);
const emojiSearchQuery = ref('');
const selectedEmojiCategory = ref<string>('all');
const isSavingRoomInfo = ref(false);
const roomInfoSavedMsg = ref('');

// Sync inputs when drawer opens or currentRoom updates
watch(
  [() => props.isOpen, () => roomStore.currentRoom?.roomName, () => roomStore.currentRoom?.roomEmoji],
  ([isOpen]) => {
    if (isOpen && roomStore.currentRoom) {
      editRoomName.value = roomStore.currentRoom.roomName || '';
      editRoomEmoji.value = roomStore.currentRoom.roomEmoji || '💡';
    }
  },
  { immediate: true }
);

const filteredRoomEmojis = computed(() => {
  const q = emojiSearchQuery.value.trim().toLowerCase();
  return ROOM_EMOJI_LIST.filter(item => {
    const matchCat = selectedEmojiCategory.value === 'all' || item.cat === selectedEmojiCategory.value;
    const matchQuery = !q || item.name.toLowerCase().includes(q) || item.emoji.includes(q);
    return matchCat && matchQuery;
  });
});

const selectRoomEmoji = (emoji: string) => {
  editRoomEmoji.value = emoji;
  isEmojiPickerOpen.value = false;
};

const handleSaveRoomInfo = async () => {
  if (!roomStore.currentRoom || isSavingRoomInfo.value) return;
  isSavingRoomInfo.value = true;
  try {
    await roomStore.updateRoomInfo(editRoomName.value, editRoomEmoji.value);
    roomInfoSavedMsg.value = t('drawer.detailsUpdated');
    setTimeout(() => {
      roomInfoSavedMsg.value = '';
    }, 2500);
  } catch (err) {
    console.error('Failed to save room info:', err);
  } finally {
    isSavingRoomInfo.value = false;
  }
};


const isStudyAdmin = computed(() => authStore.isAdmin);

const isGoogleSigningIn = ref(false);

const handleGoogleSignIn = async () => {
  if (isGoogleSigningIn.value) return;
  isGoogleSigningIn.value = true;
  try {
    // Signing in replaces the anonymous uid; the server moves rooms the guest hosted (claimGuestRooms)
    await authStore.upgradeWithGoogle();
    roomStore.pushToast(t('profile.signedInTitle'), t('profile.signedInText', { name: authStore.displayName }), 'success');
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
      console.warn('Google sign-in error:', err);
      roomStore.pushToast(t('profile.signInFailedTitle'), err?.message || t('drawer.googleFailed'), 'error');
    }
  } finally {
    isGoogleSigningIn.value = false;
  }
};



const triggerLeaveFlow = () => {
  if (roomStore.isHost && !authStore.isGoogleLinked) {
    pendingAction.value = 'leave';
    showAnonWarningModal.value = true;
  } else {
    showLeaveModal.value = true;
  }
};

const triggerEndFlow = () => {
  if (!authStore.isGoogleLinked) {
    pendingAction.value = 'end';
    showAnonWarningModal.value = true;
  } else {
    showEndAllModal.value = true;
  }
};

const proceedAfterAnonWarning = () => {
  showAnonWarningModal.value = false;
  if (pendingAction.value === 'leave') {
    showLeaveModal.value = true;
  } else {
    showEndAllModal.value = true;
  }
};

const handleLeaveMeeting = async () => {
  await roomStore.leaveRoom();
  showLeaveModal.value = false;
  emit('close');
  router.push(authStore.isGoogleLinked ? '/dashboard' : '/');
};

const handleEndMeetingForAll = async () => {
  await roomStore.endMeetingForAll();
  showEndAllModal.value = false;
  emit('close');
};

const handleReopenMeeting = async () => {
  if (!roomStore.currentRoom) return;
  roomStore.currentRoom.roomStatus = 'active';
  if (db) {
    try {
      await updateDoc(doc(db, 'rooms', roomStore.currentRoom.roomId), {
        roomStatus: 'active'
      });
      await addDoc(collection(db, 'rooms', roomStore.currentRoom.roomId, 'messages'), {
        senderUid: 'system',
        senderName: t('common.system'),
        senderAvatar: '🔓',
        type: 'text',
        content: t('drawer.reopenedNotice'),
        timestamp: Date.now()
      });
    } catch (e) {
      console.error(e);
    }
  }
  emit('close');
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.isOpen) {
    emit('close');
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});


</script>

<template>
  <div>
    <!-- Backdrop overlay with fade transition -->
    <Transition
      enter-active-class="transition-opacity duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-x-0 bottom-0 z-[90] bg-slate-950/60 backdrop-blur-xs"
        :style="{ top: topOffset }"
        @click="emit('close')"
      ></div>
    </Transition>

    <!-- Sliding Drawer Panel -->
    <div
      class="fixed bottom-0 right-0 z-[100] w-full max-w-md bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl transform transition-transform duration-300 ease-in-out"
      :style="{ top: topOffset, height: `calc(100dvh - ${topOffset})` }"
      :class="isOpen ? 'translate-x-0' : 'translate-x-full'"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/80">
        <div class="flex items-center gap-2">
          <Sliders class="w-5 h-5 text-sky-400" />
          <h3 class="font-bold text-slate-100">{{ t('drawer.title') }}</h3>
        </div>
        <button
          @click="emit('close')"
          class="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
          :title="t('drawer.close')"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-6">
        <!-- Anonymous Host Google Sign-in banner -->
        <div
          v-if="roomStore.isHost && !authStore.isGoogleLinked"
          class="p-3.5 rounded-2xl bg-amber-950/30 border border-amber-500/40 flex items-center justify-between gap-3 shadow-lg"
        >
          <div class="space-y-0.5">
            <p class="text-xs font-bold text-amber-300 flex items-center gap-1.5">
              <AlertTriangle class="w-3.5 h-3.5 text-amber-400" />
              {{ t('drawer.hostingAnon') }}
            </p>
            <p class="text-[11px] text-slate-400 leading-tight">
              {{ t('drawer.hostingAnonHint') }}
            </p>
          </div>
          <button
            @click="handleGoogleSignIn"
            class="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0 flex items-center gap-1.5 shadow transition"
          >
            <LogIn class="w-3.5 h-3.5" /> {{ t('drawer.signIn') }}
          </button>
        </div>

        <!-- Room Profile & Appearance (Name & Avatar/Emoji) -->
        <section class="p-4 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-3.5 shadow-lg">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Sparkles class="w-4 h-4 text-sky-400" />
              <h4 class="font-semibold text-sm text-slate-100">{{ t('drawer.roomDetails') }}</h4>
            </div>
            <span
              v-if="roomStore.isHost"
              class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30 flex items-center gap-1"
            >
              {{ t('drawer.hostEdit') }}
            </span>
            <span
              v-else
              class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700"
            >
              {{ t('drawer.hostOnly') }}
            </span>
          </div>

          <div class="flex items-center gap-3">
            <!-- Room Emoji / Avatar Button -->
            <div class="relative shrink-0">
              <button
                type="button"
                @click="roomStore.isHost ? (isEmojiPickerOpen = !isEmojiPickerOpen) : null"
                :disabled="!roomStore.isHost"
                class="w-13 h-13 rounded-2xl bg-slate-900 border-2 transition-all flex items-center justify-center text-2xl sm:text-3xl shadow-inner group relative"
                :class="roomStore.isHost ? 'border-slate-700 hover:border-sky-400 cursor-pointer hover:scale-105 active:scale-95' : 'border-slate-800 cursor-default opacity-90'"
                :title="roomStore.isHost ? t('drawer.changeAvatar') : t('drawer.roomAvatar')"
              >
                <span>{{ editRoomEmoji || '💡' }}</span>
                <span
                  v-if="roomStore.isHost"
                  class="absolute -bottom-1 -right-1 p-1 bg-sky-600 group-hover:bg-sky-500 text-white rounded-full shadow-md transition"
                  :title="t('drawer.changeEmoji')"
                >
                  <Edit3 class="w-2.5 h-2.5" />
                </span>
              </button>
            </div>

            <!-- Room Name Input & Save -->
            <div class="flex-1 space-y-1 min-w-0">
              <label class="text-[11px] font-medium text-slate-400 block truncate">
                {{ t('drawer.roomName') }}
              </label>
              <div class="flex items-center gap-1.5">
                <input
                  v-model="editRoomName"
                  :disabled="!roomStore.isHost"
                  @keydown.enter.prevent="handleSaveRoomInfo"
                  type="text"
                  :placeholder="t('drawer.roomNamePlaceholder')"
                  maxlength="50"
                  class="flex-1 bg-slate-900 border border-slate-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-xl px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition min-w-0"
                />
                <button
                  v-if="roomStore.isHost"
                  type="button"
                  @click="handleSaveRoomInfo"
                  :disabled="isSavingRoomInfo || (!editRoomName.trim() && !editRoomEmoji)"
                  class="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold shrink-0 transition flex items-center gap-1 cursor-pointer shadow"
                >
                  <Loader2 v-if="isSavingRoomInfo" class="w-3.5 h-3.5 animate-spin" />
                  <Check v-else-if="roomInfoSavedMsg" class="w-3.5 h-3.5 text-emerald-300" />
                  <span>{{ roomInfoSavedMsg ? t('drawer.saved') : t('drawer.save') }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Inline Searchable Room Emoji Picker -->
          <div
            v-if="isEmojiPickerOpen && roomStore.isHost"
            class="p-3 bg-slate-900/95 border border-sky-500/40 rounded-2xl space-y-2.5 animate-in fade-in zoom-in-95 shadow-xl"
          >
            <div class="flex items-center justify-between pb-1 border-b border-slate-800">
              <span class="text-xs font-semibold text-sky-300 flex items-center gap-1.5">
                <span>{{ t('drawer.selectAvatar') }}</span>
              </span>
              <button
                type="button"
                @click="isEmojiPickerOpen = false"
                class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Search input -->
            <div class="relative">
              <Search class="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                v-model="emojiSearchQuery"
                type="text"
                :placeholder="t('drawer.emojiSearch')"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl pl-8 pr-7 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
              <button
                v-if="emojiSearchQuery"
                type="button"
                @click="emojiSearchQuery = ''"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-0.5"
              >
                <X class="w-3 h-3" />
              </button>
            </div>

            <!-- Categories -->
            <div class="flex items-center gap-1 overflow-x-auto pb-1 text-[11px] custom-scrollbar">
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
              >{{ t('drawer.emojiTransport') }}</button>
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
            <div class="grid grid-cols-7 gap-1 max-h-40 overflow-y-auto p-1 bg-slate-950/70 rounded-xl border border-slate-800">
              <button
                v-for="item in filteredRoomEmojis"
                :key="item.emoji"
                type="button"
                @click="selectRoomEmoji(item.emoji)"
                class="h-8 w-8 rounded-lg hover:bg-slate-800 flex items-center justify-center text-base hover:scale-125 transition cursor-pointer"
                :class="editRoomEmoji === item.emoji ? 'bg-sky-600/40 ring-1 ring-sky-500 scale-110' : ''"
                :title="item.name"
              >
                {{ item.emoji }}
              </button>
              <div v-if="filteredRoomEmojis.length === 0" class="col-span-7 py-3 text-center text-xs text-slate-500">
                {{ t('home.noEmoji') }}
              </div>
            </div>
          </div>

          <p v-if="roomInfoSavedMsg" class="text-[11px] text-emerald-400 flex items-center gap-1.5 animate-in fade-in">
            <Check class="w-3.5 h-3.5" /> {{ roomInfoSavedMsg }}
          </p>
        </section>

        <!-- 1. Waiting Room Approval List -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <Users class="w-4 h-4 text-amber-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                {{ t('drawer.pendingRequests') }}
              </h4>
            </div>
            <span
              class="text-xs px-2 py-0.5 rounded-full font-bold"
              :class="roomStore.pendingParticipants.length > 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' : 'bg-slate-800 text-slate-500'"
            >
              {{ t('drawer.pendingCount', { count: roomStore.pendingParticipants.length }) }}
            </span>
          </div>

          <div v-if="roomStore.pendingParticipants.length === 0" class="text-xs text-slate-500 italic p-3 bg-slate-950/50 rounded-xl border border-slate-800/80 text-center">
            {{ t('drawer.noPending') }}
          </div>

          <div v-else class="space-y-2">
            <div
              v-for="p in roomStore.pendingParticipants"
              :key="p.uid"
              class="flex items-center justify-between p-3 rounded-xl bg-amber-950/20 border border-amber-500/30"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-2xl">{{ p.avatar }}</span>
                <div>
                  <h5 class="text-sm font-medium text-slate-100">{{ p.displayName }}</h5>
                  <p class="text-[11px] text-amber-400/80">{{ t('drawer.waitingApproval') }}</p>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  @click="roomStore.approveParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition"
                >
                  <CheckCircle class="w-3.5 h-3.5" /> {{ t('toast.approve') }}
                </button>
                <button
                  @click="roomStore.rejectParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs transition"
                >
                  <XCircle class="w-3.5 h-3.5" /> {{ t('toast.decline') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. Approved Members -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <ShieldCheck class="w-4 h-4 text-emerald-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                {{ t('drawer.members', { count: roomStore.approvedParticipants.length }) }}
              </h4>
            </div>
          </div>

          <div class="space-y-2">
            <div
              v-for="p in roomStore.approvedParticipants"
              :key="p.uid"
              class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-xl">{{ p.avatar }}</span>
                <span class="text-sm text-slate-200 font-medium">{{ p.displayName }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  v-if="p.isHost"
                  class="text-[10px] px-2 py-0.5 rounded-full font-medium"
                  :class="p.isOnline !== false ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'"
                >
                  {{ t('host.hostBadge') }} {{ p.isOnline !== false ? '' : t('host.offlineSuffix') }}
                </span>
                <span
                  v-else
                  class="text-[10px] flex items-center gap-1 font-medium"
                  :class="p.isOnline !== false ? 'text-emerald-400' : 'text-slate-500'"
                >
                  {{ p.isOnline !== false ? t('host.online') : t('host.offline') }}
                </span>

                <div v-if="!p.isHost" class="flex items-center gap-1">
                  <button
                    @click="roomStore.muteParticipant(p.uid, !p.isMuted)"
                    class="p-1.5 rounded bg-slate-800 hover:bg-slate-700 transition"
                    :title="p.isMuted ? t('drawer.unmute') : t('drawer.mute')"
                  >
                    <MicOff v-if="p.isMuted" class="w-3.5 h-3.5 text-rose-400" />
                    <Mic v-else class="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button
                    @click="roomStore.kickParticipant(p.uid)"
                    class="p-1.5 rounded bg-slate-800 hover:bg-rose-900/50 transition"
                    :title="t('drawer.remove')"
                  >
                    <UserMinus class="w-3.5 h-3.5 text-rose-400" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <hr class="border-slate-800" />
        <!-- Research conditions are managed in the admin page (/#/admin) -->
        <router-link v-if="isStudyAdmin" to="/admin" class="block p-3 rounded-xl border border-sky-500/40 bg-sky-950/40 text-xs text-sky-200 hover:bg-sky-900/50 transition">
          {{ t('drawer.adminLink') }}
        </router-link>

        <hr class="border-slate-800" />

        <!-- Anonymous Host Claim Warning -->
        <div v-if="roomStore.isHost && !authStore.isGoogleLinked" class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl mb-4 text-left">
          <div class="flex items-center gap-2 text-amber-400 font-semibold text-xs mb-1">
            <AlertTriangle class="w-4 h-4 shrink-0" />
            <span>{{ t('drawer.anonHost') }}</span>
          </div>
          <p class="text-[11px] text-slate-300 leading-relaxed mb-2.5">
            {{ t('drawer.anonHostText') }}
          </p>
          <button
            @click="handleGoogleSignIn"
            :disabled="isGoogleSigningIn"
            class="w-full py-1.5 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow cursor-pointer disabled:opacity-50"
          >
            <Loader2 v-if="isGoogleSigningIn" class="w-3.5 h-3.5 animate-spin" />
            <LogIn v-else class="w-3.5 h-3.5" />
            {{ isGoogleSigningIn ? t('common.signingIn') : t('drawer.signInSave') }}
          </button>
        </div>

        <hr class="border-slate-800" />

        <!-- 5. Meeting Session Actions -->
        <section class="space-y-2 pb-6">
          <h4 class="font-semibold text-sm text-slate-100 mb-2">{{ t('drawer.actions') }}</h4>

          <!-- Reopen Meeting (If Ended & Host) -->
          <button
            v-if="roomStore.isHost && roomStore.currentRoom?.roomStatus === 'ended' && !roomStore.currentRoom?.session"
            @click="handleReopenMeeting"
            class="w-full py-2.5 px-3 rounded-xl border border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 hover:text-emerald-100 text-xs font-semibold transition flex items-center justify-center gap-2 shadow"
          >
            <Unlock class="w-4 h-4 text-emerald-400" />
            <span>{{ t('drawer.reopenChat') }}</span>
          </button>

          <!-- Leave Meeting -->
          <button
            @click="triggerLeaveFlow"
            class="w-full py-2.5 px-3 rounded-xl border border-slate-700 bg-slate-950/60 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <LogOut class="w-4 h-4 text-amber-400" />
            <span>{{ roomStore.isHost ? t('drawer.leaveKeep') : t('drawer.leave') }}</span>
          </button>

          <!-- End Meeting for All (Host only) -->
          <button
            v-if="roomStore.isHost && roomStore.currentRoom?.roomStatus !== 'ended' && !roomStore.currentRoom?.session"
            @click="triggerEndFlow"
            class="w-full py-2.5 px-3 rounded-xl border border-rose-900/60 bg-rose-950/30 hover:bg-rose-900/50 text-rose-300 hover:text-rose-100 text-xs font-semibold transition flex items-center justify-center gap-2"
          >
            <Power class="w-4 h-4 text-rose-400" />
            <span>{{ t('drawer.closeArchive') }}</span>
          </button>
        </section>
      </div>
    </div>

    <!-- Anonymous Host Warning Modal -->
    <div v-if="showAnonWarningModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-amber-500/40 rounded-2xl p-6 shadow-2xl text-center">
        <div class="w-12 h-12 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center mx-auto mb-3">
          <AlertTriangle class="w-6 h-6" />
        </div>
        <h3 class="text-base font-bold text-white mb-2">{{ t('drawer.saveFirst') }}</h3>
        <p class="text-xs text-slate-300 mb-5 leading-relaxed">
          {{ t('drawer.saveFirstText') }}
        </p>
        <div class="space-y-2">
          <button
            @click="handleGoogleSignIn"
            class="w-full py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition shadow flex items-center justify-center gap-1.5"
          >
            <LogIn class="w-3.5 h-3.5" /> {{ t('drawer.signInSaveRoom') }}
          </button>
          <div class="flex gap-2 pt-1">
            <button
              @click="showAnonWarningModal = false"
              class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-semibold transition"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="proceedAfterAnonWarning"
              class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-rose-950/60 text-rose-400 border border-slate-700 text-xs font-semibold transition"
            >
              {{ t('drawer.leaveAnyway') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirm Leave Modal -->
    <div v-if="showLeaveModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
        <h3 class="text-base font-bold text-white mb-2">{{ t('drawer.leaveTitle') }}</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          {{ roomStore.isHost ? t('drawer.leaveHostText') : t('drawer.leaveText') }}
        </p>
        <div class="flex gap-2">
          <button
            @click="showLeaveModal = false"
            class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="handleLeaveMeeting"
            class="flex-1 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition shadow"
          >
            {{ t('drawer.confirmLeave') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Confirm End for All Modal -->
    <div v-if="showEndAllModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
        <h3 class="text-base font-bold text-rose-400 mb-2">{{ t('drawer.closeTitle') }}</h3>
        <p class="text-xs text-slate-400 mb-5 leading-relaxed">
          {{ t('drawer.closeText') }}
        </p>
        <div class="flex gap-2">
          <button
            @click="showEndAllModal = false"
            class="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="handleEndMeetingForAll"
            class="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow"
          >
            {{ t('drawer.closeMeeting') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
