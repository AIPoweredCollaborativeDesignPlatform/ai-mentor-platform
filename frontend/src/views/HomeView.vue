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
import { computed } from 'vue';

const router = useRouter();
const authStore = useAuthStore();
const roomStore = useRoomStore();

const pinInput = ref('');
const inputName = ref(authStore.displayName);
const selectedAvatar = ref(authStore.avatar);
const roomNameInput = ref('');
const errorMsg = ref('');
const isLoading = ref(false);

// Room Emoji Emblem with English Search & Categories
interface RoomEmojiItem {
  emoji: string;
  name: string;
  cat: 'tools' | 'food' | 'transport' | 'characters' | 'nature' | 'activities';
}

const ROOM_EMOJI_LIST: RoomEmojiItem[] = [
  // Tools & Objects
  { emoji: '🛠️', name: 'tools hammer wrench work build craft', cat: 'tools' },
  { emoji: '🔧', name: 'wrench spanner fix repair mechanic tool', cat: 'tools' },
  { emoji: '🔨', name: 'hammer construction build nail tool', cat: 'tools' },
  { emoji: '⚙️', name: 'gear settings engine mechanism cog machine', cat: 'tools' },
  { emoji: '💡', name: 'bulb idea light innovation solution insight', cat: 'tools' },
  { emoji: '💻', name: 'laptop computer code tech coding screen', cat: 'tools' },
  { emoji: '📱', name: 'phone mobile smartphone app tech screen', cat: 'tools' },
  { emoji: '📐', name: 'ruler triangle angle design architecture math', cat: 'tools' },
  { emoji: '📏', name: 'ruler measure length dimension geometry', cat: 'tools' },
  { emoji: '🎨', name: 'palette art paint design color studio', cat: 'tools' },
  { emoji: '✏️', name: 'pencil sketch write draw note draft', cat: 'tools' },
  { emoji: '📦', name: 'box package parcel delivery storage supply', cat: 'tools' },
  { emoji: '📷', name: 'camera photo photograph lens capture video', cat: 'tools' },
  { emoji: '🔑', name: 'key access security lock secret password', cat: 'tools' },
  { emoji: '🧭', name: 'compass navigate navigation direction explore', cat: 'tools' },
  { emoji: '⏰', name: 'clock alarm timer schedule deadline morning', cat: 'tools' },
  { emoji: '🔭', name: 'telescope astronomy science look search future', cat: 'tools' },
  { emoji: '🔬', name: 'microscope science laboratory research biology', cat: 'tools' },
  { emoji: '🔋', name: 'battery power energy charge electrical', cat: 'tools' },
  // Food & Drinks
  { emoji: '🍕', name: 'pizza food slice cheese Italian lunch dinner', cat: 'food' },
  { emoji: '🍔', name: 'burger hamburger fastfood sandwich grill', cat: 'food' },
  { emoji: '🍟', name: 'fries potato chips fastfood snack', cat: 'food' },
  { emoji: '☕', name: 'coffee tea cafe hot drink espresso morning brew', cat: 'food' },
  { emoji: '🍵', name: 'tea green matcha drink hot herbal cup', cat: 'food' },
  { emoji: '🍣', name: 'sushi Japanese seafood rice salmon dinner', cat: 'food' },
  { emoji: '🍜', name: 'ramen noodle soup broth Asian hot bowl', cat: 'food' },
  { emoji: '🍩', name: 'donut doughnut sweet dessert bakery glaze', cat: 'food' },
  { emoji: '🍪', name: 'cookie biscuit sweet chocolate bakery snack', cat: 'food' },
  { emoji: '🍰', name: 'cake slice dessert sweet bakery birthday', cat: 'food' },
  { emoji: '🍎', name: 'apple fruit healthy red snack fresh vitamin', cat: 'food' },
  { emoji: '🥑', name: 'avocado fruit green healthy salad food', cat: 'food' },
  { emoji: '🍉', name: 'watermelon fruit melon summer fresh juicy', cat: 'food' },
  { emoji: '🍓', name: 'strawberry berry fruit sweet red fresh', cat: 'food' },
  { emoji: '🍿', name: 'popcorn movie cinema snack corn butter', cat: 'food' },
  // Transport & Vehicles
  { emoji: '🚀', name: 'rocket spaceship space launch transport speed fly fast', cat: 'transport' },
  { emoji: '🛸', name: 'ufo flying saucer alien space scifi aircraft', cat: 'transport' },
  { emoji: '🚗', name: 'car automobile vehicle drive road travel', cat: 'transport' },
  { emoji: '🏎️', name: 'racecar fast formula speed sports motorsport', cat: 'transport' },
  { emoji: '🏍️', name: 'motorcycle bike motorbike speed ride driver', cat: 'transport' },
  { emoji: '🚲', name: 'bicycle bike cycle eco fitness transport pedal', cat: 'transport' },
  { emoji: '✈️', name: 'airplane plane flight travel journey sky airport', cat: 'transport' },
  { emoji: '🚁', name: 'helicopter rotor fly aircraft air mission rescue', cat: 'transport' },
  { emoji: '⛵', name: 'sailboat boat ocean sea wind marine voyage', cat: 'transport' },
  { emoji: '🚢', name: 'ship cruise boat cargo sea ocean voyage', cat: 'transport' },
  { emoji: '🚆', name: 'train transit rail railway commute locomotive', cat: 'transport' },
  { emoji: '🛹', name: 'skateboard skate sport street board trick', cat: 'transport' },
  // Characters & People
  { emoji: '🧑‍🚀', name: 'astronaut space cosmonaut explorer mission suit', cat: 'characters' },
  { emoji: '🧑‍💻', name: 'developer programmer engineer code coder tech developer', cat: 'characters' },
  { emoji: '🧙‍♂️', name: 'wizard mage sorcerer magic fantasy spell', cat: 'characters' },
  { emoji: '🤖', name: 'robot bot AI android cyborg cyber machine', cat: 'characters' },
  { emoji: '🥷', name: 'ninja stealth warrior martial shadow covert', cat: 'characters' },
  { emoji: '🦁', name: 'lion animal cat king predator brave safari', cat: 'characters' },
  { emoji: '🐯', name: 'tiger animal cat wild predator jungle stripes', cat: 'characters' },
  { emoji: '🐼', name: 'panda bear bamboo cute animal China wildlife', cat: 'characters' },
  { emoji: '🦊', name: 'fox animal wild clever red orange canine', cat: 'characters' },
  { emoji: '🦉', name: 'owl bird night wise wisdom nocturnal eyes', cat: 'characters' },
  { emoji: '🦄', name: 'unicorn horse horn magic rainbow fantasy myth', cat: 'characters' },
  { emoji: '🐲', name: 'dragon mythical beast creature monster fantasy', cat: 'characters' },
  { emoji: '🐧', name: 'penguin bird antarctic snow ice cute cold', cat: 'characters' },
  // Nature & Elements
  { emoji: '🌿', name: 'herb leaf plant green ecology nature flora eco', cat: 'nature' },
  { emoji: '🌲', name: 'pine tree forest evergreen wood nature wood', cat: 'nature' },
  { emoji: '🌸', name: 'cherry blossom flower pink spring sakura bloom', cat: 'nature' },
  { emoji: '🌻', name: 'sunflower flower summer yellow bright bloom sun', cat: 'nature' },
  { emoji: '🍁', name: 'maple leaf autumn fall orange nature foliage', cat: 'nature' },
  { emoji: '🌴', name: 'palm tree beach island tropical summer resort', cat: 'nature' },
  { emoji: '🌊', name: 'wave ocean sea water tsunami surf surf water', cat: 'nature' },
  { emoji: '⛰️', name: 'mountain rock peak summit climbing snow outdoor', cat: 'nature' },
  { emoji: '🌋', name: 'volcano lava eruption mountain magma fire heat', cat: 'nature' },
  { emoji: '⚡', name: 'lightning bolt electricity energy power storm thunder', cat: 'nature' },
  { emoji: '🔥', name: 'fire flame hot burn blaze campfire heat energy', cat: 'nature' },
  { emoji: '🪐', name: 'saturn planet cosmos galaxy orbit ring astronomical', cat: 'nature' },
  { emoji: '🌟', name: 'star shining sparkle light glow galaxy bright', cat: 'nature' },
  // Activities & Games
  { emoji: '🎯', name: 'target bullseye aim goal precision arrow focus', cat: 'activities' },
  { emoji: '🎮', name: 'game controller gaming video esports play arcade', cat: 'activities' },
  { emoji: '🎲', name: 'dice boardgame gamble luck roll random chance', cat: 'activities' },
  { emoji: '🏆', name: 'trophy champion win winner cup victory contest', cat: 'activities' },
  { emoji: '🥇', name: 'medal gold first winner award victory achievement', cat: 'activities' },
  { emoji: '⚽', name: 'soccer football ball sport goal team match', cat: 'activities' },
  { emoji: '🏀', name: 'basketball ball hoop court sport NBA bounce', cat: 'activities' },
  { emoji: '🎸', name: 'guitar rock music sound band instrument play', cat: 'activities' },
  { emoji: '🎹', name: 'piano keyboard keys music melody classical jazz', cat: 'activities' },
  { emoji: '🎬', name: 'movie clapper film cinema video director hollywood', cat: 'activities' }
];

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

const avatarChoices = ['🦊', '🦉', '🎨', '🚀', '🔮', '📐', '🤖', '⚡'];

const selectAvatar = (av: string) => {
  selectedAvatar.value = av;
};

const handleSaveProfile = () => {
  if (inputName.value.trim()) {
    authStore.updateProfile(inputName.value.trim(), selectedAvatar.value);
  }
};

const handleCreateRoom = async () => {
  handleSaveProfile();
  isLoading.value = true;
  try {
    const newRoom = await roomStore.createRoom(roomNameInput.value, selectedRoomEmoji.value);
    router.push(`/room/${newRoom.roomId}`);
  } catch (err) {
    console.error(err);
  } finally {
    isLoading.value = false;
  }
};

const handleJoinRoom = async () => {
  handleSaveProfile();
  const pin = pinInput.value.trim();
  if (pin.length !== 6) {
    errorMsg.value = 'Please enter a valid 6-digit room PIN';
    return;
  }
  errorMsg.value = '';
  isLoading.value = true;
  try {
    const roomCheck = await roomStore.checkRoomExists(pin);
    if (!roomCheck.exists) {
      errorMsg.value = `Meeting room "${pin}" does not exist. Please check the PIN.`;
      isLoading.value = false;
      return;
    }
    await roomStore.applyToJoin(pin);
    router.push(`/waiting/room_${pin}`);
  } catch (err: any) {
    errorMsg.value = err.message || 'Failed to join room';
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
    const res = await authStore.upgradeWithGoogle();
    if (res?.success) {
      inputName.value = authStore.displayName;
    }
  } catch (err: any) {
    if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
      let friendlyMsg = err?.message || 'Google sign-in failed. Please try again.';
      if (err?.code === 'auth/popup-blocked') {
        friendlyMsg = 'Popup was blocked by your browser. Please allow popups for this site and try again.';
      } else if (err?.code === 'auth/unauthorized-domain') {
        friendlyMsg = 'This domain is not authorized in Firebase Auth. Please verify Firebase settings.';
      } else if (err?.code === 'auth/network-request-failed') {
        friendlyMsg = 'Network connection error. Please check your internet connection.';
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
  <div class="min-h-[100dvh] flex flex-col items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 overflow-y-auto">
    <!-- Brand / Header -->
    <div class="text-center max-w-xl mb-5">
      <h1 class="text-xl sm:text-2xl font-black text-white mb-1.5 tracking-tight flex items-center justify-center gap-2">
        <Sparkles class="w-5 h-5 sm:w-6 sm:h-6 inline-block text-sky-400 mr-1.5" />
        AI Mentor Platform
      </h1>
      <p class="text-slate-400 text-xs sm:text-sm">
        AI-assisted collaborative design meetings with real-time 3D visualization
      </p>
    </div>

    <!-- Main Card -->
    <div class="w-full max-w-lg bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-2xl backdrop-blur-xl">
      <!-- Guest Profile Setup -->
      <section class="mb-5">
        <div class="flex items-center gap-3 mb-3">
          <div class="text-2xl p-1.5 bg-slate-800 rounded-xl border border-slate-700 shrink-0">
            {{ selectedAvatar }}
          </div>
          <input
            v-model="inputName"
            type="text"
            placeholder="Enter your name..."
            class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition min-h-[44px]"
          />
        </div>

        <!-- Avatar Picker -->
        <div class="flex items-center justify-between gap-0.5 p-1.5 bg-slate-950/60 rounded-xl border border-slate-800/80 mb-3">
          <button
            v-for="av in avatarChoices"
            :key="av"
            @click="selectAvatar(av)"
            class="p-1.5 rounded-lg text-base hover:scale-125 transition"
            :class="{ 'bg-sky-500/20 ring-2 ring-sky-400': selectedAvatar === av }"
          >
            {{ av }}
          </button>
        </div>

        <!-- Google Sign-in -->
        <div v-if="!authStore.isGoogleLinked" class="pt-2 border-t border-slate-800/60">
          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-400">Sign in for cross-device sync</span>
            <button
              @click="handleGoogleSignIn"
              :disabled="isGoogleSigningIn"
              class="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 font-medium px-3 py-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 transition cursor-pointer disabled:opacity-50"
            >
              <Loader2 v-if="isGoogleSigningIn" class="w-3.5 h-3.5 animate-spin" />
              <LogIn v-else class="w-3.5 h-3.5" />
              {{ isGoogleSigningIn ? 'Signing in...' : 'Sign in with Google' }}
            </button>
          </div>
          <p v-if="authErrorMsg" class="text-[11px] text-rose-400 mt-2 bg-rose-950/40 p-2 rounded-lg border border-rose-900/60 leading-relaxed">
            {{ authErrorMsg }}
          </p>
        </div>
        <div v-else class="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
          <span class="text-emerald-400 flex items-center gap-1">
            ✓ Signed in ({{ authStore.displayName || authStore.email?.split('@')[0] || 'User' }})
          </span>
          <router-link to="/dashboard" class="text-sky-400 hover:underline flex items-center gap-1 font-semibold">
            <LayoutDashboard class="w-3.5 h-3.5" /> Dashboard
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
              title="Select Room Emblem Emoji"
            >
              {{ selectedRoomEmoji }}
            </button>

            <!-- Room Name Input -->
            <input
              v-model="roomNameInput"
              type="text"
              placeholder="Room name (optional)"
              class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-base sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition min-h-[44px]"
            />

            <!-- Room Emoji Picker Popover -->
            <div
              v-if="isEmojiPickerOpen"
              class="absolute z-50 top-12 left-0 w-72 sm:w-80 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-2xl shadow-2xl p-3 text-slate-100 animate-in fade-in zoom-in-95 duration-100"
            >
              <div class="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs">
                <span class="font-semibold text-slate-300">Choose Room Emblem</span>
                <button
                  type="button"
                  @click="isEmojiPickerOpen = false"
                  class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
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
                  placeholder="Search emoji (e.g. rocket, tool, food)..."
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
                >All</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'tools'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'tools' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🛠️ Tools</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'food'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'food' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🍕 Food</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'transport'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'transport' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🚀 Vehicles</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'characters'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'characters' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🧑‍🚀 People</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'nature'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'nature' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🌿 Nature</button>
                <button
                  type="button"
                  @click="selectedEmojiCategory = 'activities'"
                  class="px-2 py-0.5 rounded-lg shrink-0 transition"
                  :class="selectedEmojiCategory === 'activities' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
                >🎯 Activities</button>
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
                  No matching emojis found
                </div>
              </div>
            </div>
          </div>
          <button
            @click="handleCreateRoom"
            :disabled="isLoading"
            class="flex-1 flex flex-col justify-between p-4 rounded-xl bg-gradient-to-br from-sky-600 to-indigo-700 hover:from-sky-500 hover:to-indigo-600 text-white shadow-lg transition text-left group disabled:opacity-50 min-h-[110px] cursor-pointer"
          >
            <div>
              <div class="p-2 bg-white/10 rounded-lg w-fit mb-2">
                <Users class="w-4 h-4 text-white" />
              </div>
              <h3 class="font-bold text-sm mb-0.5">Create Meeting</h3>
              <p class="text-[11px] text-sky-100 opacity-90">
                You'll be the host with a 6-digit PIN
              </p>
            </div>
            <div class="mt-3 flex items-center gap-1 text-xs font-semibold text-white group-hover:translate-x-1 transition">
              {{ isLoading ? 'Creating...' : 'Create Now' }} <ArrowRight class="w-3.5 h-3.5" />
            </div>
          </button>
        </div>

        <!-- Join Room -->
        <div class="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col justify-between">
          <div>
            <div class="p-2 bg-slate-800 rounded-lg w-fit mb-2">
              <KeyRound class="w-4 h-4 text-slate-300" />
            </div>
            <h3 class="font-bold text-sm text-slate-100 mb-0.5">Join Meeting</h3>
            <p class="text-[11px] text-slate-400 mb-2">
              Enter 6-digit PIN to request access
            </p>
            <input
              v-model="pinInput"
              type="text"
              maxlength="6"
              placeholder="e.g. 849201"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-center text-lg sm:text-base tracking-widest font-mono text-white placeholder-slate-600 focus:outline-none focus:border-sky-500 min-h-[44px]"
            />
            <p v-if="errorMsg" class="text-[11px] text-rose-400 mt-1">{{ errorMsg }}</p>
          </div>
          <button
            @click="handleJoinRoom"
            :disabled="isLoading"
            class="mt-3 w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition disabled:opacity-50 min-h-[44px] cursor-pointer"
          >
            {{ isLoading ? 'Requesting...' : 'Request to Join' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
