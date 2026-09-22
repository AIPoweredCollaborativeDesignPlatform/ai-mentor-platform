<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import {
  doc,
  getDocs,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit
} from 'firebase/firestore';
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
  Trash2,
  SlidersHorizontal,
  Check,
  CheckCheck,
  RefreshCw,
  Loader2
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
  preview?: string;
  timestamp: number;
}

const historyRooms = ref<RoomHistoryItem[]>([]);
const generatedAssets = ref<{ type: string; title: string; date: string; roomPin: string }[]>([]);

const isManageMode = ref(false);
const selectedRooms = ref(new Set<string>());
const showDeleteModal = ref(false);
const trashNotification = ref('');
const isLoading = ref(false);
const isRefreshing = ref(false);

const toggleSelect = (pin: string) => {
  const updated = new Set(selectedRooms.value);
  if (updated.has(pin)) {
    updated.delete(pin);
  } else {
    updated.add(pin);
  }
  selectedRooms.value = updated;
};

const toggleSelectAll = () => {
  if (selectedRooms.value.size === historyRooms.value.length) {
    selectedRooms.value = new Set();
  } else {
    selectedRooms.value = new Set(historyRooms.value.map((r) => r.pin));
  }
};

const cancelManageMode = () => {
  isManageMode.value = false;
  selectedRooms.value = new Set();
};

const loadDashboardData = async () => {
  // 1. Instant local render from localStorage cache
  const localMap = new Map<string, any>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('ai_room_')) {
      try {
        const item = JSON.parse(localStorage.getItem(key) || '{}');
        const isMyRoom = item.hostUid === authStore.uid || item.participants?.[authStore.uid];
        if (isMyRoom && item.pin) {
          localMap.set(item.pin, item);
        }
      } catch (e) {}
    }
  }

  // Populate immediate UI from local cache
  const initialRooms: RoomHistoryItem[] = [];
  const initialAssets: { type: string; title: string; date: string; roomPin: string }[] = [];

  localMap.forEach((item, pin) => {
    const messages = item.messages || [];
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastActive = lastMsg ? lastMsg.timestamp : item.lastActive || item.createdAt || Date.now();

    let previewText = '';
    if (lastMsg) {
      const sender = lastMsg.senderUid === 'ai_mentor' ? 'AI' : lastMsg.senderName || 'User';
      let content = lastMsg.content || '';
      if (lastMsg.type === 'file') content = '📎 Attachment';
      else if (lastMsg.type === 'ai_asset') content = '✨ AI Asset Generated';
      previewText = `${sender}: ${content}`;
      if (previewText.length > 50) previewText = previewText.substring(0, 50) + '...';
    }

    initialRooms.push({
      id: item.roomId || `room_${pin}`,
      pin,
      title: item.roomName || `Meeting (${pin})`,
      date: new Date(lastActive).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      members: Object.keys(item.participants || {}).filter((k) => item.participants[k].status === 'approved').length || 1,
      assetsCount: item.assetsCount || item.messages?.filter((m: any) => m.type === 'ai_asset')?.length || 0,
      preview: previewText,
      timestamp: lastActive
    });

    if (item.messages) {
      item.messages.forEach((m: any) => {
        if (m.type === 'ai_asset' && m.assetPayload?.title) {
          initialAssets.push({
            type:
              m.assetType === 'parametric_3d' || m.assetType === 'mesh_3d'
                ? '3d'
                : m.assetType === 'moodboard'
                ? 'moodboard'
                : 'doc',
            title: m.assetPayload.title,
            date: new Date(m.timestamp).toLocaleDateString(),
            roomPin: pin
          });
        }
      });
    }
  });

  initialRooms.sort((a, b) => b.timestamp - a.timestamp);
  historyRooms.value = initialRooms;
  generatedAssets.value = initialAssets;

  // 2. Fetch remote rooms from Firestore (Multi-device synchronization)
  if (!db || !authStore.uid) {
    isLoading.value = false;
    isRefreshing.value = false;
    return;
  }

  try {
    const remoteRoomsMap = new Map<string, any>();

    // Query A: Rooms where user is host
    try {
      const qHost = query(collection(db, 'rooms'), where('hostUid', '==', authStore.uid));
      const snapHost = await getDocs(qHost);
      snapHost.forEach((d) => {
        const data = d.data();
        const pin = data.pin || d.id.replace('room_', '');
        remoteRoomsMap.set(pin, { ...data, roomId: d.id, pin });
      });
    } catch (e) {
      console.warn('qHost failed:', e);
    }

    // Query B: Rooms where user is a participant
    try {
      const qPart = query(
        collection(db, 'rooms'),
        where('participantUids', 'array-contains', authStore.uid)
      );
      const snapPart = await getDocs(qPart);
      snapPart.forEach((d) => {
        const data = d.data();
        const pin = data.pin || d.id.replace('room_', '');
        if (!remoteRoomsMap.has(pin)) {
          remoteRoomsMap.set(pin, { ...data, roomId: d.id, pin });
        }
      });
    } catch (e) {
      console.warn('qPart failed:', e);
    }

    // Query C: User personal room index
    try {
      const snapUser = await getDocs(collection(db, 'users', authStore.uid, 'rooms'));
      snapUser.forEach((d) => {
        const data = d.data();
        const pin = data.pin || d.id.replace('room_', '');
        if (!remoteRoomsMap.has(pin)) {
          remoteRoomsMap.set(pin, { ...data, roomId: d.id, pin });
        }
      });
    } catch (e) {
      console.warn('snapUser failed:', e);
    }

    // Process all rooms retrieved from Cloud
    const mergedRooms: RoomHistoryItem[] = [];
    const mergedAssets: { type: string; title: string; date: string; roomPin: string }[] = [];
    const seenAssetKeys = new Set<string>();

    for (const [pin, roomData] of remoteRoomsMap.entries()) {
      const roomId = roomData.roomId || `room_${pin}`;
      let lastActive = roomData.lastActive || roomData.createdAt || roomData.joinedAt || Date.now();
      let previewText = '';
      let assetsCount = roomData.assetsCount || 0;

      if (roomData.lastMessage) {
        const lm = roomData.lastMessage;
        const sender = lm.senderUid === 'ai_mentor' ? 'AI' : lm.senderName || 'User';
        previewText = `${sender}: ${lm.content || ''}`;
        if (previewText.length > 50) previewText = previewText.substring(0, 50) + '...';
      }

      // Check messages subcollection for deeper preview & assets if needed
      try {
        const msgQuery = query(
          collection(db, 'rooms', roomId, 'messages'),
          orderBy('timestamp', 'desc'),
          limit(8)
        );
        const msgSnap = await getDocs(msgQuery);
        if (!msgSnap.empty) {
          const recentMsgs: any[] = [];
          msgSnap.forEach((mDoc) => {
            const mData = mDoc.data();
            recentMsgs.push(mData);
            if (mData.type === 'ai_asset' && mData.assetPayload?.title) {
              const assetKey = `${pin}_${mData.assetPayload.title}`;
              if (!seenAssetKeys.has(assetKey)) {
                seenAssetKeys.add(assetKey);
                mergedAssets.push({
                  type:
                    mData.assetType === 'parametric_3d' || mData.assetType === 'mesh_3d'
                      ? '3d'
                      : mData.assetType === 'moodboard'
                      ? 'moodboard'
                      : 'doc',
                  title: mData.assetPayload.title,
                  date: new Date(mData.timestamp).toLocaleDateString(),
                  roomPin: pin
                });
              }
            }
          });

          if (!previewText && recentMsgs.length > 0) {
            const latest = recentMsgs[0];
            const sender = latest.senderUid === 'ai_mentor' ? 'AI' : latest.senderName || 'User';
            let content = latest.content || '';
            if (latest.type === 'file') content = '📎 Attachment';
            else if (latest.type === 'ai_asset') content = '✨ AI Asset Generated';
            previewText = `${sender}: ${content}`;
            if (previewText.length > 50) previewText = previewText.substring(0, 50) + '...';
          }
          if (recentMsgs[0]?.timestamp) {
            lastActive = Math.max(lastActive, recentMsgs[0].timestamp);
          }
        }
      } catch (e) {
        // subcollection message query might be restricted if not joined yet
      }

      // Sync to local storage cache so next load is instantaneous
      const cached = localMap.get(pin) || {};
      const updatedCache = {
        ...cached,
        roomId,
        pin,
        roomName: roomData.roomName || roomData.title || `Meeting (${pin})`,
        hostUid: roomData.hostUid || cached.hostUid || '',
        lastActive,
        createdAt: roomData.createdAt || cached.createdAt || Date.now(),
        assetsCount
      };
      localStorage.setItem(`ai_room_${pin}`, JSON.stringify(updatedCache));

      mergedRooms.push({
        id: roomId,
        pin,
        title: roomData.roomName || roomData.title || `Meeting (${pin})`,
        date: new Date(lastActive).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        members:
          roomData.participantUids?.length ||
          (roomData.participants ? Object.keys(roomData.participants).length : 1),
        assetsCount,
        preview: previewText,
        timestamp: lastActive
      });
    }

    // Merge any local assets that weren't captured remotely
    initialAssets.forEach((asset) => {
      const key = `${asset.roomPin}_${asset.title}`;
      if (!seenAssetKeys.has(key)) {
        seenAssetKeys.add(key);
        mergedAssets.push(asset);
      }
    });

    mergedRooms.sort((a, b) => b.timestamp - a.timestamp);
    historyRooms.value = mergedRooms;
    generatedAssets.value = mergedAssets;
  } catch (err) {
    console.error('Failed to sync cloud rooms:', err);
  } finally {
    isLoading.value = false;
    isRefreshing.value = false;
  }
};

const handleRefresh = async () => {
  isRefreshing.value = true;
  await loadDashboardData();
};

onMounted(async () => {
  // Strict Auth Guard: Dashboard requires Google sign-in
  if (!authStore.isGoogleLinked) {
    router.replace('/');
    return;
  }
  isLoading.value = true;
  await loadDashboardData();
});

const confirmDelete = async () => {
  const pinsToDelete = Array.from(selectedRooms.value);
  const count = pinsToDelete.length;

  for (const pin of pinsToDelete) {
    const rawItem = localStorage.getItem(`ai_room_${pin}`);
    const room = historyRooms.value.find((r) => r.pin === pin);
    const docId = room?.id || (rawItem ? JSON.parse(rawItem).roomId : `room_${pin}`);

    localStorage.removeItem(`ai_room_${pin}`);

    if (db) {
      try {
        // Remove from user's personal cloud history index
        if (authStore.uid) {
          await deleteDoc(doc(db, 'users', authStore.uid, 'rooms', docId)).catch(() => {});
        }
        // If user is host, remove room from Firestore
        let isHost = false;
        if (rawItem) {
          try {
            const parsed = JSON.parse(rawItem);
            if (parsed.hostUid === authStore.uid) isHost = true;
          } catch (e) {}
        }
        if (isHost) {
          await deleteDoc(doc(db, 'rooms', docId)).catch(() => {});
        }
      } catch (e) {
        console.warn('Failed to delete room doc:', e);
      }
    }
  }

  historyRooms.value = historyRooms.value.filter((r) => !selectedRooms.value.has(r.pin));
  generatedAssets.value = generatedAssets.value.filter((a) => !selectedRooms.value.has(a.roomPin));
  selectedRooms.value = new Set();
  showDeleteModal.value = false;
  isManageMode.value = false;

  // Show transient toast
  trashNotification.value = `Moved ${count} meeting${count > 1 ? 's' : ''} to Trash`;
  setTimeout(() => {
    trashNotification.value = '';
  }, 4000);
};

const handleLogout = async () => {
  await authStore.logoutGoogle();
  historyRooms.value = [];
  generatedAssets.value = [];
  router.replace('/');
};
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-950 text-slate-100 p-3.5 sm:p-6 pb-24 overflow-y-auto">
    <!-- Transient Trash Notification Banner -->
    <div
      v-if="trashNotification"
      class="fixed top-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl text-xs text-slate-200 flex items-center gap-2 animate-fade-in"
    >
      <Trash2 class="w-4 h-4 text-rose-400" />
      <span>{{ trashNotification }}</span>
    </div>

    <div class="max-w-5xl mx-auto">
      <!-- Top Bar -->
      <div class="flex items-center justify-between pb-4 mb-6 border-b border-slate-800 gap-2">
        <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <router-link
            to="/"
            class="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition border border-slate-800 shrink-0"
          >
            <ArrowLeft class="w-5 h-5" />
          </router-link>
          <div class="min-w-0">
            <h1 class="text-lg sm:text-xl font-bold text-white flex items-center gap-2 truncate">
              <LayoutDashboard class="w-4 h-4 sm:w-5 sm:h-5 text-sky-400 shrink-0" />
              Dashboard
            </h1>
            <p class="text-xs text-slate-400 mt-0.5 truncate">
              <span class="text-sky-400 font-mono truncate block max-w-[130px] xs:max-w-[200px] sm:max-w-none">{{
                authStore.email
              }}</span>
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            @click="handleRefresh"
            :disabled="isRefreshing"
            class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
            title="Sync meetings from Cloud"
          >
            <RefreshCw class="w-3.5 h-3.5 text-sky-400" :class="{ 'animate-spin': isRefreshing }" />
            <span class="hidden sm:inline">Sync</span>
          </button>

          <button
            @click="handleLogout"
            class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
          >
            <LogOut class="w-4 h-4 text-rose-400" /> Sign Out
          </button>
        </div>
      </div>

      <!-- History Rooms -->
      <section class="mb-8">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <h2 class="text-base font-bold text-slate-100 flex items-center gap-2">
              <Clock class="w-4 h-4 text-sky-400" /> Meeting History
            </h2>
            <span v-if="historyRooms.length > 0" class="text-xs text-slate-500">
              ({{ historyRooms.length }})
            </span>
            <span v-if="isLoading" class="text-xs text-slate-500 flex items-center gap-1">
              <Loader2 class="w-3 h-3 animate-spin text-sky-400" /> Syncing...
            </span>
          </div>

          <!-- Actions on right of header -->
          <div v-if="historyRooms.length > 0" class="flex items-center gap-2">
            <!-- If in manage mode -->
            <template v-if="isManageMode">
              <button
                @click="toggleSelectAll"
                class="text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:text-white transition flex items-center gap-1"
              >
                <CheckCheck class="w-3.5 h-3.5 text-sky-400" />
                <span>{{ selectedRooms.size === historyRooms.length ? 'Deselect All' : 'Select All' }}</span>
              </button>
              <button
                @click="showDeleteModal = true"
                :disabled="selectedRooms.size === 0"
                class="text-xs px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition flex items-center gap-1.5 shadow"
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>Move to Trash ({{ selectedRooms.size }})</span>
              </button>
              <button
                @click="cancelManageMode"
                class="text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              >
                Done
              </button>
            </template>

            <!-- If not in manage mode -->
            <template v-else>
              <button
                @click="isManageMode = true"
                class="text-xs px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white transition flex items-center gap-1.5"
              >
                <SlidersHorizontal class="w-3.5 h-3.5 text-sky-400" />
                <span>Manage</span>
              </button>
            </template>
          </div>
        </div>

        <!-- Empty State -->
        <div
          v-if="historyRooms.length === 0 && !isLoading"
          class="p-8 text-center rounded-2xl bg-slate-900/50 border border-slate-800"
        >
          <FolderOpen class="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p class="text-sm text-slate-400">No meetings yet</p>
          <p class="text-xs text-slate-500 mt-1">Create or join a meeting to see your history here</p>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            v-for="room in historyRooms"
            :key="room.id"
            @click="isManageMode ? toggleSelect(room.pin) : null"
            class="p-4 rounded-xl bg-slate-900/80 border transition flex flex-col justify-between group shadow"
            :class="[
              isManageMode ? 'cursor-pointer' : '',
              selectedRooms.has(room.pin)
                ? 'border-sky-500/80 ring-1 ring-sky-500/40 bg-slate-900'
                : 'border-slate-800 hover:border-slate-700'
            ]"
          >
            <div>
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                  <!-- Custom Checkbox (Only visible in manage mode) -->
                  <div
                    v-if="isManageMode"
                    class="w-4 h-4 rounded border flex items-center justify-center transition shrink-0"
                    :class="
                      selectedRooms.has(room.pin)
                        ? 'bg-sky-500 border-sky-400 text-white shadow-xs'
                        : 'border-slate-600 bg-slate-950'
                    "
                  >
                    <Check v-if="selectedRooms.has(room.pin)" class="w-3 h-3 stroke-[3]" />
                  </div>

                  <span
                    class="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-sky-400 border border-slate-700"
                  >
                    PIN: {{ room.pin }}
                  </span>
                </div>
                <span class="text-[11px] text-slate-500">{{ room.date }}</span>
              </div>

              <h3 class="font-bold text-slate-100 text-sm mb-1 group-hover:text-sky-400 transition truncate">
                {{ room.title }}
              </h3>
              <p class="text-[11px] text-slate-400 mb-2">
                {{ room.members }} members
              </p>

              <div
                v-if="room.preview"
                class="p-2 rounded-lg bg-slate-950/50 border border-slate-800 text-xs text-slate-300 truncate"
              >
                {{ room.preview }}
              </div>
            </div>

            <!-- Open Button (Only in non-manage mode) -->
            <router-link
              v-if="!isManageMode"
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

    <!-- Custom Modal Confirmation Dialog for Trash -->
    <div
      v-if="showDeleteModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs"
      @click.self="showDeleteModal = false"
    >
      <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-slate-100">
        <div class="flex items-center gap-3 mb-4">
          <div class="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
            <Trash2 class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Move to Trash?</h3>
            <p class="text-xs text-slate-400">This will remove the selected meetings from your dashboard.</p>
          </div>
        </div>

        <p class="text-sm text-slate-300 mb-6">
          Are you sure you want to move
          <span class="font-semibold text-white">
            {{ selectedRooms.size === 1 ? '1 meeting' : `${selectedRooms.size} meetings` }}
          </span>
          to trash?
        </p>

        <div class="flex items-center justify-end gap-2.5">
          <button
            @click="showDeleteModal = false"
            class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition border border-slate-700"
          >
            Cancel
          </button>
          <button
            @click="confirmDelete"
            class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-md"
          >
            Move to Trash
          </button>
        </div>
      </div>
    </div>

    <!-- Version badge in normal document flow -->
    <div class="mt-12 text-center text-[10px] text-slate-600 font-mono select-none">
      v1.7.1 · 2026-09-22 19:30
    </div>
  </div>
</template>
