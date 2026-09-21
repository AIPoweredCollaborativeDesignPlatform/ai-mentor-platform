<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { doc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  ArrowLeft,
  LayoutDashboard,
  Box,
  Palette,
  FileText,
  Clock,
  LogOut,
  FolderOpen,
  Trash2
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

const historyRooms = ref<RoomHistoryItem[]>([]);

const generatedAssets = ref<{ type: string; title: string; date: string; roomPin: string }[]>([]);

onMounted(() => {
  // Discover local sessions from localStorage
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('ai_room_')) {
      try {
        const item = JSON.parse(localStorage.getItem(key) || '{}');
        if (item.pin && !historyRooms.value.some(r => r.pin === item.pin)) {
          historyRooms.value.unshift({
            id: item.roomId || `room_${item.pin}`,
            pin: item.pin,
            title: item.roomName || `Meeting (${item.pin})`,
            date: new Date(item.createdAt || Date.now()).toLocaleDateString(),
            members: Object.keys(item.participants || {}).length || 1,
            assetsCount: item.messages?.filter((m: any) => m.type === 'ai_asset')?.length || 0
          });
          // Collect assets from this room
          if (item.messages) {
            item.messages.forEach((m: any) => {
              if (m.type === 'ai_asset' && m.assetPayload?.title) {
                generatedAssets.value.push({
                  type: m.assetType === 'parametric_3d' || m.assetType === 'mesh_3d' ? '3d' : m.assetType === 'moodboard' ? 'moodboard' : 'doc',
                  title: m.assetPayload.title,
                  date: new Date(m.timestamp).toLocaleDateString(),
                  roomPin: item.pin
                });
              }
            });
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }
});

const handleDeleteRoom = async (room: RoomHistoryItem) => {
  if (!confirm(`Are you sure you want to remove history for "${room.title}"?`)) return;
  
  // If host, try to delete from Firestore
  const rawItem = localStorage.getItem(`ai_room_${room.pin}`);

  // Remove locally
  localStorage.removeItem(`ai_room_${room.pin}`);
  historyRooms.value = historyRooms.value.filter(r => r.pin !== room.pin);
  
  if (rawItem && db) {
    try {
      const parsed = JSON.parse(rawItem);
      if (parsed.hostUid === authStore.uid) {
        await deleteDoc(doc(db, 'rooms', room.id));
      }
    } catch(e) {}
  }
};

const handleLogout = async () => {
  await authStore.logoutGoogle();
  router.push('/');
};
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
    <div class="max-w-5xl mx-auto">
      <!-- Top Bar -->
      <div class="flex items-center justify-between pb-4 mb-6 border-b border-slate-800">
        <div class="flex items-center gap-3">
          <router-link
            to="/"
            class="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition border border-slate-800"
          >
            <ArrowLeft class="w-5 h-5" />
          </router-link>
          <div>
            <h1 class="text-xl font-bold text-white flex items-center gap-2">
              <LayoutDashboard class="w-5 h-5 text-sky-400" />
              Dashboard
            </h1>
            <p class="text-xs text-slate-400 mt-0.5">
              <span class="text-sky-400 font-mono">{{ authStore.email }}</span>
            </p>
          </div>
        </div>

        <button
          @click="handleLogout"
          class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
        >
          <LogOut class="w-4 h-4 text-rose-400" /> Sign Out
        </button>
      </div>

      <!-- History Rooms -->
      <section class="mb-8">
        <h2 class="text-base font-bold text-slate-100 mb-3 flex items-center gap-2">
          <Clock class="w-4 h-4 text-sky-400" /> Meeting History
        </h2>

        <!-- Empty State -->
        <div v-if="historyRooms.length === 0" class="p-8 text-center rounded-2xl bg-slate-900/50 border border-slate-800">
          <FolderOpen class="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p class="text-sm text-slate-400">No meetings yet</p>
          <p class="text-xs text-slate-500 mt-1">Create or join a meeting to see your history here</p>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            v-for="room in historyRooms"
            :key="room.id"
            class="p-4 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between group shadow"
          >
            <div>
              <div class="flex items-center justify-between mb-1.5">
                <span class="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-sky-400 border border-slate-700">
                  PIN: {{ room.pin }}
                </span>
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-slate-500">{{ room.date }}</span>
                  <button @click.prevent="handleDeleteRoom(room)" class="text-slate-500 hover:text-rose-400 transition" title="Delete room history">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <h3 class="font-bold text-slate-100 text-sm mb-1.5 group-hover:text-sky-400 transition">
                {{ room.title }}
              </h3>
              <p class="text-[11px] text-slate-400">
                {{ room.members }} members · {{ room.assetsCount }} assets
              </p>
            </div>

            <router-link
              :to="`/room/${room.id}`"
              class="mt-3 w-full text-center py-1.5 rounded-lg bg-slate-800 hover:bg-sky-600 hover:text-white text-slate-300 text-xs font-semibold transition"
            >
              Open
            </router-link>
          </div>
        </div>
      </section>

      <!-- AI Assets Gallery -->
      <section v-if="generatedAssets.length > 0">
        <h2 class="text-base font-bold text-slate-100 mb-3 flex items-center gap-2">
          <Box class="w-4 h-4 text-amber-400" /> Generated Assets
        </h2>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div
            v-for="(asset, idx) in generatedAssets"
            :key="idx"
            class="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-start gap-2.5"
          >
            <div
              class="p-2 rounded-lg shrink-0"
              :class="{
                'bg-sky-500/20 text-sky-400': asset.type === '3d',
                'bg-amber-500/20 text-amber-400': asset.type === 'moodboard',
                'bg-purple-500/20 text-purple-400': asset.type === 'doc'
              }"
            >
              <Box v-if="asset.type === '3d'" class="w-4 h-4" />
              <Palette v-else-if="asset.type === 'moodboard'" class="w-4 h-4" />
              <FileText v-else class="w-4 h-4" />
            </div>
            <div>
              <h4 class="font-semibold text-xs text-slate-200 mb-0.5">{{ asset.title }}</h4>
              <p class="text-[10px] text-slate-400">Room PIN: {{ asset.roomPin }}</p>
              <span class="text-[10px] text-slate-500">{{ asset.date }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
