<script setup lang="ts">
import { ref } from 'vue';
import {
  getStoredFirebaseConfig,
  saveFirebaseConfig,
  isFirebaseConfigured,
  type FirebaseConfig
} from '../firebase/config';
import { Settings, Check, X, ExternalLink, ShieldCheck, Database } from 'lucide-vue-next';

defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const existing = getStoredFirebaseConfig() || {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: ''
};

const form = ref<FirebaseConfig>({ ...existing });
const configured = ref(isFirebaseConfigured());

const handleSave = () => {
  saveFirebaseConfig(form.value);
};
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
    <div class="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="flex items-center justify-between p-5 border-b border-slate-800 bg-slate-950/70">
        <div class="flex items-center gap-2.5">
          <Database class="w-5 h-5 text-sky-400" />
          <div>
            <h3 class="font-bold text-slate-100 text-base">Firebase 雲端連線設定</h3>
            <p class="text-xs text-slate-400">配置真實的 Firebase 專案以啟用 Google 登入與即時串流</p>
          </div>
        </div>
        <button
          @click="emit('close')"
          class="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Body -->
      <div class="p-6 overflow-y-auto space-y-4 text-xs text-slate-300">
        <!-- Status Banner -->
        <div
          class="p-3.5 rounded-2xl border flex items-center justify-between"
          :class="configured ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200' : 'bg-amber-950/40 border-amber-500/40 text-amber-200'"
        >
          <div class="flex items-center gap-2">
            <ShieldCheck class="w-4 h-4" />
            <span class="font-medium">
              {{ configured ? `已連線至 Firebase: ${form.projectId}` : '尚未連線 Firebase（目前處於本機模擬模式）' }}
            </span>
          </div>
          <a
            href="https://console.firebase.google.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-sky-400 hover:underline flex items-center gap-1"
          >
            Firebase Console <ExternalLink class="w-3 h-3" />
          </a>
        </div>

        <p class="text-slate-400 leading-relaxed">
          至 Firebase Console ➔ 專案設定 ➔ 一般 ➔ 您的應用程式 ➔ 選擇 Web (網頁)，將其設定貼於此處：
        </p>

        <!-- Form fields -->
        <div class="space-y-3 font-mono">
          <div>
            <label class="block text-[11px] text-slate-400 mb-1">apiKey</label>
            <input
              v-model="form.apiKey"
              placeholder="AIzaSy..."
              class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">authDomain</label>
              <input
                v-model="form.authDomain"
                placeholder="your-project.firebaseapp.com"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">projectId</label>
              <input
                v-model="form.projectId"
                placeholder="your-project-id"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">storageBucket</label>
              <input
                v-model="form.storageBucket"
                placeholder="your-project.appspot.com"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label class="block text-[11px] text-slate-400 mb-1">messagingSenderId</label>
              <input
                v-model="form.messagingSenderId"
                placeholder="1029384756"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div>
            <label class="block text-[11px] text-slate-400 mb-1">appId</label>
            <input
              v-model="form.appId"
              placeholder="1:1029384756:web:abcd1234"
              class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 text-xs focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="p-4 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
        <span class="text-[11px] text-slate-500">儲存後網頁將自動重新整理以套用配置</span>
        <div class="flex items-center gap-2">
          <button
            @click="emit('close')"
            class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 text-xs font-medium"
          >
            取消
          </button>
          <button
            @click="handleSave"
            class="px-5 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold shadow transition flex items-center gap-1.5"
          >
            <Check class="w-3.5 h-3.5" /> 儲存並連線
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
