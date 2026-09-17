<script setup lang="ts">
import { useRoomStore } from '../stores/room';
import { useMentorStore } from '../stores/mentor';
import type { SensitivityLevel } from '../types';
import {
  Sliders,
  Users,
  CheckCircle,
  XCircle,
  ShieldCheck,
  Box,
  Palette,
  Search,
  FileCheck2,
  X
} from 'lucide-vue-next';

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const roomStore = useRoomStore();
const mentorStore = useMentorStore();

const sensitivities: { id: SensitivityLevel; name: string; desc: string }[] = [
  { id: 'Strict', name: 'Strict (嚴謹)', desc: '僅在被 @Mentor 提及時回覆' },
  { id: 'Conservative', name: 'Conservative (保守·預設)', desc: '偵測連續 3 次分歧、長時間停滯或視覺需求時介入' },
  { id: 'Exploratory', name: 'Exploratory (探索型)', desc: '主動發想變體提案與推薦參考資產' }
];
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs">
    <div
      class="w-full max-w-md bg-slate-900 border-l border-slate-800 h-full flex flex-col shadow-2xl transition-transform duration-300"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/60">
        <div class="flex items-center gap-2">
          <Sliders class="w-5 h-5 text-sky-400" />
          <h3 class="font-bold text-slate-100">主持人控制台 (Host Controls)</h3>
        </div>
        <button
          @click="emit('close')"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-6">
        <!-- 1. 等候室審核名單 (Waiting Room Host Approval) -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <Users class="w-4 h-4 text-amber-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                待審核名單 (等候室)
              </h4>
            </div>
            <span
              class="text-xs px-2 py-0.5 rounded-full font-bold"
              :class="roomStore.pendingParticipants.length > 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' : 'bg-slate-800 text-slate-500'"
            >
              {{ roomStore.pendingParticipants.length }} 人待核准
            </span>
          </div>

          <div v-if="roomStore.pendingParticipants.length === 0" class="text-xs text-slate-500 italic p-3 bg-slate-950/50 rounded-xl border border-slate-800/80 text-center">
            目前沒有新成員等待核准
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
                  <p class="text-[11px] text-amber-400/80">等待進入會議室...</p>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  @click="roomStore.approveParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition"
                  title="允許進入"
                >
                  <CheckCircle class="w-3.5 h-3.5" /> 允許
                </button>
                <button
                  @click="roomStore.rejectParticipant(p.uid)"
                  class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs transition"
                  title="拒絕"
                >
                  <XCircle class="w-3.5 h-3.5" /> 拒絕
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. 已加入成員列表 -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <ShieldCheck class="w-4 h-4 text-emerald-400" />
              <h4 class="font-semibold text-sm text-slate-200">
                已加入成員 ({{ roomStore.approvedParticipants.length }})
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
              <span
                v-if="p.isHost"
                class="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-medium"
              >
                👑 主持人
              </span>
              <span
                v-else
                class="text-[10px] text-emerald-400 flex items-center gap-1"
              >
                ● 在線
              </span>
            </div>
          </div>
        </section>

        <hr class="border-slate-800" />

        <!-- 3. Mentor 控制面板 (Sensitivity & Modules) -->
        <section>
          <h4 class="font-semibold text-sm text-slate-100 mb-1 flex items-center gap-2">
            <Sliders class="w-4 h-4 text-sky-400" />
            AI Mentor 介入敏感度
          </h4>
          <p class="text-xs text-slate-400 mb-3">
            調整 AI 監聽引擎在對話中主動介入與去衝突的時機
          </p>

          <div class="space-y-2">
            <div
              v-for="s in sensitivities"
              :key="s.id"
              @click="mentorStore.setSensitivity(s.id)"
              class="p-3 rounded-xl border cursor-pointer transition flex flex-col gap-1"
              :class="mentorStore.config.sensitivity === s.id
                ? 'bg-sky-950/40 border-sky-500 text-sky-100 shadow-sm'
                : 'bg-slate-950/50 border-slate-800 text-slate-300 hover:border-slate-700'"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold">{{ s.name }}</span>
                <span
                  class="w-3 h-3 rounded-full border"
                  :class="mentorStore.config.sensitivity === s.id ? 'bg-sky-400 border-sky-300' : 'border-slate-600'"
                ></span>
              </div>
              <p class="text-xs opacity-75">{{ s.desc }}</p>
            </div>
          </div>
        </section>

        <!-- 4. 模組開關 -->
        <section>
          <h4 class="font-semibold text-sm text-slate-100 mb-3">
            AI 資產生成模組開關
          </h4>

          <div class="space-y-2.5">
            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="mentorStore.toggleModule('enable3D')"
            >
              <div class="flex items-center gap-2.5">
                <Box class="w-4 h-4 text-sky-400" />
                <span class="text-sm text-slate-200">雙軌 3D 原型 (Code-to-3D / GLB)</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enable3D ? 'bg-sky-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enable3D ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="mentorStore.toggleModule('enableMoodboard')"
            >
              <div class="flex items-center gap-2.5">
                <Palette class="w-4 h-4 text-amber-400" />
                <span class="text-sm text-slate-200">視覺意向板 (Mood Board)</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableMoodboard ? 'bg-amber-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableMoodboard ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="mentorStore.toggleModule('enableFactRetrieval')"
            >
              <div class="flex items-center gap-2.5">
                <Search class="w-4 h-4 text-emerald-400" />
                <span class="text-sm text-slate-200">即時事實檢索 (Fact Retrieval)</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableFactRetrieval ? 'bg-emerald-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableFactRetrieval ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl bg-slate-950/50 border border-slate-800 cursor-pointer hover:border-slate-700"
              @click="mentorStore.toggleModule('enableProcessIntervention')"
            >
              <div class="flex items-center gap-2.5">
                <FileCheck2 class="w-4 h-4 text-purple-400" />
                <span class="text-sm text-slate-200">進程總結與文件草案交付</span>
              </div>
              <div
                class="w-10 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out"
                :class="mentorStore.config.enableProcessIntervention ? 'bg-purple-500' : 'bg-slate-700'"
              >
                <div
                  class="w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out transform"
                  :class="mentorStore.config.enableProcessIntervention ? 'translate-x-5' : 'translate-x-0'"
                ></div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
