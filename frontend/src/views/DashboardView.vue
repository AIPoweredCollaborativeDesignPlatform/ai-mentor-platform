<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import {
  ArrowLeft,
  LayoutDashboard,
  Box,
  Palette,
  FileText,
  Clock,
  LogOut
} from 'lucide-vue-next';

import { ref, onMounted } from 'vue';

const router = useRouter();
const authStore = useAuthStore();

interface RoomHistoryItem {
  id: string;
  pin: string;
  title: string;
  date: string;
  members: number;
  assetsCount: number;
}

const historyRooms = ref<RoomHistoryItem[]>([
  { id: 'room_849201', pin: '849201', title: '智能咖啡機人機介面概念設計', date: '2026-09-15', members: 4, assetsCount: 3 },
  { id: 'room_512930', pin: '512930', title: '遠距人體工學工作椅體量評估', date: '2026-09-12', members: 3, assetsCount: 5 },
  { id: 'room_194820', pin: '194820', title: '現代客廳幾何茶几與材質審查', date: '2026-09-10', members: 5, assetsCount: 4 }
]);

const generatedAssets = ref([
  { type: '3d', title: '人體工學椅原型 (Parametric 3D)', date: '2026-09-12', roomPin: '512930' },
  { type: 'moodboard', title: '現代極簡胡桃木視覺意向板', date: '2026-09-10', roomPin: '194820' },
  { type: 'doc', title: '設計協同委託草約 (Markdown)', date: '2026-09-15', roomPin: '849201' }
]);

onMounted(() => {
  // Discover local sessions
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('ai_room_')) {
      try {
        const item = JSON.parse(localStorage.getItem(key) || '{}');
        if (item.pin && !historyRooms.value.some(r => r.pin === item.pin)) {
          historyRooms.value.unshift({
            id: item.roomId || `room_${item.pin}`,
            pin: item.pin,
            title: `協同設計會議 (${item.pin})`,
            date: new Date(item.createdAt || Date.now()).toLocaleDateString(),
            members: Object.keys(item.participants || {}).length || 1,
            assetsCount: item.messages?.filter((m: any) => m.type === 'ai_asset')?.length || 0
          });
        }
      } catch (e) {
        // ignore
      }
    }
  }
});

const handleLogout = async () => {
  await authStore.logoutGoogle();
  router.push('/');
};
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 p-6">
    <div class="max-w-5xl mx-auto">
      <!-- Top Bar -->
      <div class="flex items-center justify-between pb-6 mb-8 border-b border-slate-800">
        <div class="flex items-center gap-3">
          <router-link
            to="/"
            class="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition border border-slate-800"
          >
            <ArrowLeft class="w-5 h-5" />
          </router-link>
          <div>
            <h1 class="text-2xl font-bold text-white flex items-center gap-2">
              <LayoutDashboard class="w-6 h-6 text-sky-400" />
              專案大廳 (Project Dashboard)
            </h1>
            <p class="text-xs text-slate-400 mt-0.5">
              已綁定帳號：<span class="text-sky-400 font-mono">{{ authStore.email || 'alex.designer@gmail.com' }}</span>
            </p>
          </div>
        </div>

        <button
          @click="handleLogout"
          class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
        >
          <LogOut class="w-4 h-4 text-rose-400" /> 登出 Google 帳號
        </button>
      </div>

      <!-- History Rooms -->
      <section class="mb-10">
        <h2 class="text-lg font-bold text-slate-100 mb-4 flex items-center gap-2">
          <Clock class="w-5 h-5 text-sky-400" /> 歷史協作會議室
        </h2>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div
            v-for="room in historyRooms"
            :key="room.id"
            class="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between group shadow-lg"
          >
            <div>
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-mono px-2 py-0.5 rounded-md bg-slate-800 text-sky-400 border border-slate-700">
                  PIN: {{ room.pin }}
                </span>
                <span class="text-[11px] text-slate-500">{{ room.date }}</span>
              </div>
              <h3 class="font-bold text-slate-100 text-base mb-2 group-hover:text-sky-400 transition">
                {{ room.title }}
              </h3>
              <p class="text-xs text-slate-400">
                成員 {{ room.members }} 人 · 產出資產 {{ room.assetsCount }} 件
              </p>
            </div>

            <router-link
              :to="`/room/${room.id}`"
              class="mt-4 w-full text-center py-2 rounded-xl bg-slate-800 hover:bg-sky-600 hover:text-white text-slate-300 text-xs font-semibold transition"
            >
              進入聊天室
            </router-link>
          </div>
        </div>
      </section>

      <!-- AI Assets Gallery -->
      <section>
        <h2 class="text-lg font-bold text-slate-100 mb-4 flex items-center gap-2">
          <Box class="w-5 h-5 text-amber-400" /> AI 跨專案資產總覽
        </h2>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div
            v-for="(asset, idx) in generatedAssets"
            :key="idx"
            class="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex items-start gap-3"
          >
            <div
              class="p-2.5 rounded-xl shrink-0"
              :class="{
                'bg-sky-500/20 text-sky-400': asset.type === '3d',
                'bg-amber-500/20 text-amber-400': asset.type === 'moodboard',
                'bg-purple-500/20 text-purple-400': asset.type === 'doc'
              }"
            >
              <Box v-if="asset.type === '3d'" class="w-5 h-5" />
              <Palette v-else-if="asset.type === 'moodboard'" class="w-5 h-5" />
              <FileText v-else class="w-5 h-5" />
            </div>
            <div>
              <h4 class="font-semibold text-sm text-slate-200 mb-0.5">{{ asset.title }}</h4>
              <p class="text-[11px] text-slate-400">來源會議室 PIN: {{ asset.roomPin }}</p>
              <span class="text-[10px] text-slate-500">{{ asset.date }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
