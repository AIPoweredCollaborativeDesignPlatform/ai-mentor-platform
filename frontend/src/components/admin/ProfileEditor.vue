<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MODE_LABELS, TIMING_FIELDS, getPath, setPath, withDefaults, type AiMode, type AiProfile } from '../../utils/aiProfiles';

const props = defineProps<{ profile: AiProfile; saving: boolean }>();
const emit = defineEmits<{ (e: 'save', profile: AiProfile): void; (e: 'cancel'): void }>();

// Edit a deep copy; nothing changes until saved (saving creates a new version)
// (JSON copy: structuredClone cannot clone Vue reactive proxies)
const clone = (p: AiProfile): AiProfile => withDefaults({ ...JSON.parse(JSON.stringify(p)), rationale: { ...(p.rationale || {}) } });
const draft = ref<AiProfile>(clone(props.profile));
watch(() => props.profile, p => (draft.value = clone(p)));

const openRationale = ref<Record<string, boolean>>({});
const toggleRationale = (path: string) => (openRationale.value[path] = !openRationale.value[path]);
const hasRationale = (path: string) => Boolean(draft.value.rationale?.[path]?.trim());

const MODULES: { key: keyof AiProfile['modules']; label: string }[] = [
  { key: 'enable3D', label: '3D 模型生成' },
  { key: 'enableMoodboard', label: '情緒板（FLUX 生圖）' },
  { key: 'enableFactRetrieval', label: '事實查核（上網搜尋）' },
  { key: 'enableSummary', label: '摘要／決策文件' },
  { key: 'enableWhiteboardAi', label: '白板 AI（生成 SVG、手繪轉 SVG）' }
];

const numberValue = (path: string) => Number(getPath(draft.value, path) ?? 0);
const setNumber = (path: string, raw: string) => setPath(draft.value, path, Math.max(0, Number(raw) || 0));

const noTimeLimit = computed({
  get: () => !draft.value.session.taskMinutes,
  set: v => (draft.value.session.taskMinutes = v ? 0 : 30)
});
const reminderText = computed({
  get: () => draft.value.session.reminderMinutes.join(', '),
  set: v => (draft.value.session.reminderMinutes = [...new Set(v.split(/[,，\s]+/).map(Number).filter(n => n > 0))].sort((a, b) => b - a))
});
const sessionNumber = (key: 'expectedParticipants' | 'maxParticipants' | 'taskMinutes', raw: string) =>
  (draft.value.session[key] = Math.max(key === 'expectedParticipants' ? 1 : 0, Math.round(Number(raw) || 0)));

const save = () => {
  draft.value.rationale = Object.fromEntries(Object.entries(draft.value.rationale || {}).filter(([, v]) => v?.trim()));
  emit('save', draft.value);
};

const input = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500';
</script>

<template>
  <div class="space-y-6">
    <section class="grid sm:grid-cols-2 gap-3">
      <label class="space-y-1">
        <span class="text-xs text-slate-400">設定檔名稱</span>
        <input v-model="draft.name" :class="input" placeholder="例如：Proactive v1" />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-slate-400">說明（研究用，參與者看不到）</span>
        <input v-model="draft.description" :class="input" />
      </label>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">實驗條件</h3>
      <div class="grid sm:grid-cols-3 gap-2">
        <button
          v-for="(label, mode) in MODE_LABELS"
          :key="mode"
          type="button"
          @click="draft.mode = mode as AiMode"
          class="text-left p-3 rounded-xl border text-xs transition"
          :class="draft.mode === mode ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'"
        >
          {{ label }}
        </button>
      </div>
      <label class="flex items-start gap-2 text-xs text-slate-300 pt-1">
        <input type="checkbox" v-model="draft.shadowAssessment" class="mt-0.5" />
        <span>背景影子判斷：AI 不發言時（無 AI、Reactive、冷卻中）仍在背景判斷協作狀態並記錄，作為比較基準。</span>
      </label>
    </section>

    <section class="space-y-3">
      <h3 class="text-sm font-semibold text-slate-200">實驗流程</h3>
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="space-y-1">
          <span class="text-xs text-slate-400">預期人數（到齊自動開場）</span>
          <input type="number" min="1" :value="draft.session.expectedParticipants" @input="sessionNumber('expectedParticipants', ($event.target as HTMLInputElement).value)" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">同時在線上限（0＝不限；研究者不算）</span>
          <input type="number" min="0" :value="draft.session.maxParticipants" @input="sessionNumber('maxParticipants', ($event.target as HTMLInputElement).value)" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">任務時間（分鐘）</span>
          <input type="number" min="1" :disabled="noTimeLimit" :value="draft.session.taskMinutes || ''" @input="sessionNumber('taskMinutes', ($event.target as HTMLInputElement).value)" :class="[input, noTimeLimit ? 'opacity-40' : '']" />
          <span class="flex items-center gap-1.5 text-[11px] text-slate-300"><input type="checkbox" v-model="noTimeLimit" /> 無時間限制（沒有提醒，也沒有時間到訊息）</span>
        </label>
      </div>
      <p v-if="draft.session.maxParticipants && draft.session.maxParticipants < draft.session.expectedParticipants" class="text-[11px] text-rose-300">上限小於預期人數，房間永遠不會開場。</p>
      <div :class="{ 'opacity-50': draft.mode === 'none' }" class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs text-slate-400">提醒時間點（距離結束幾分鐘，可填多個，以逗號分隔；提醒內容由 AI 生成）</span>
          <input v-model.lazy="reminderText" :disabled="noTimeLimit" :class="[input, noTimeLimit ? 'opacity-40' : '']" placeholder="例如：10, 5" />
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-slate-400">開場文字（開場時 AI 照原文發出；留空則不發）</span>
          <textarea v-model="draft.session.openingText" rows="3" :class="input"></textarea>
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-slate-400">任務說明（AI 據此開啟話題，並在整場討論中參考；參與者看不到原文）</span>
          <textarea v-model="draft.session.taskDescription" rows="3" :class="input"></textarea>
        </label>
        <p v-if="draft.mode === 'none'" class="text-[11px] text-amber-300">無 AI 條件：不發開場文字、不開話題、不提醒；只有時間到時發一則系統訊息。</p>
      </div>
    </section>

    <section class="space-y-3" :class="{ 'opacity-50': draft.mode === 'none' }">
      <h3 class="text-sm font-semibold text-slate-200">AI 身分</h3>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-xs text-slate-400">顯示名稱（中文）</span>
          <input v-model="draft.displayName['zh-TW']" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">Display name (English)</span>
          <input v-model="draft.displayName.en" :class="input" />
        </label>
      </div>
      <label class="block space-y-1">
        <span class="text-xs text-slate-400">人設（會放進 AI 的系統提示；建議用英文撰寫）</span>
        <textarea v-model="draft.persona" rows="3" :class="input"></textarea>
      </label>
      <div class="text-[11px]">
        <button type="button" class="text-sky-400 hover:underline" @click="toggleRationale('persona')">
          {{ hasRationale('persona') ? '依據 ✓' : '＋ 依據（選填）' }}
        </button>
        <textarea v-if="openRationale.persona" v-model="draft.rationale.persona" rows="2" :class="[input, 'mt-1 text-xs']" placeholder="文獻、引用或設計理由"></textarea>
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">時間與頻率</h3>
      <div v-for="f in TIMING_FIELDS" :key="f.path" class="p-3 rounded-xl border border-slate-800 bg-slate-900/60">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm text-slate-100">{{ f.label }}</div>
            <div class="text-[11px] text-slate-500">{{ f.help }}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              type="number"
              :min="f.min"
              :max="f.max"
              :value="numberValue(f.path)"
              @input="setNumber(f.path, ($event.target as HTMLInputElement).value)"
              class="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-sm text-right text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <span class="text-xs text-slate-400 w-6">{{ f.unit }}</span>
          </div>
        </div>
        <div class="mt-1.5 text-[11px]">
          <button type="button" class="text-sky-400 hover:underline" @click="toggleRationale(f.path)">
            {{ hasRationale(f.path) ? '依據 ✓' : '＋ 依據（選填）' }}
          </button>
          <span v-if="!hasRationale(f.path)" class="ml-2 text-amber-400/70">暫定值，未填依據</span>
          <textarea
            v-if="openRationale[f.path]"
            v-model="draft.rationale[f.path]"
            rows="2"
            :class="[input, 'mt-1 text-xs']"
            placeholder="例如：Do et al. (2022) 在群組聊天中…"
          ></textarea>
        </div>
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" v-model="draft.memory.updateOnWhiteboardShare" />
        <span>白板分享時也更新長期記憶</span>
      </label>
    </section>

    <section class="space-y-2" :class="{ 'opacity-50': draft.mode === 'none' }">
      <h3 class="text-sm font-semibold text-slate-200">AI 功能模組</h3>
      <p v-if="draft.mode === 'none'" class="text-[11px] text-amber-300">無 AI 條件下所有 AI 功能都會關閉。</p>
      <div class="grid sm:grid-cols-2 gap-2">
        <label v-for="m in MODULES" :key="m.key" class="flex items-center gap-2 p-2.5 rounded-lg border border-slate-800 bg-slate-900/60 text-xs text-slate-200">
          <input type="checkbox" v-model="draft.modules[m.key]" :disabled="draft.mode === 'none'" />
          <span>{{ m.label }}</span>
        </label>
      </div>
    </section>

    <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
      <span class="text-[11px] text-slate-500 mr-auto">儲存會建立新版本（目前 v{{ profile.version || 0 }}）；已在進行的房間不受影響。</span>
      <button type="button" @click="emit('cancel')" class="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-white">取消</button>
      <button
        type="button"
        @click="save"
        :disabled="saving || !draft.name.trim()"
        class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40"
      >
        {{ saving ? '儲存中…' : '儲存為新版本' }}
      </button>
    </div>
  </div>
</template>
