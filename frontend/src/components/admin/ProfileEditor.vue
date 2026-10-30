<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { MODES, TIMING_FIELDS, getPath, modeLabel, setPath, withDefaults, type AiProfile } from '../../utils/aiProfiles';
import { t, type MessageKey } from '../../i18n';
import { getPromptDefaults, type PromptDefaults } from '../../services/admin';

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

const MODULES: { key: keyof AiProfile['modules']; label: MessageKey }[] = [
  { key: 'enable3D', label: 'pe.mod3d' },
  { key: 'enableMoodboard', label: 'pe.modMood' },
  { key: 'enableFactRetrieval', label: 'pe.modFact' },
  { key: 'enableSummary', label: 'pe.modSummary' },
  { key: 'enableWhiteboardAi', label: 'pe.modWb' }
];
const LANGS = [{ code: 'zh-TW', label: 'pe.zh' }, { code: 'en', label: 'pe.en' }] as const;

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

// ---------- Tone, pacing and prompt blocks ----------
const CASUAL_LABELS: MessageKey[] = ['pe.casual1', 'pe.casual2', 'pe.casual3', 'pe.casual4', 'pe.casual5'];
const setDivergeShare = (raw: string) => (draft.value.facilitation.divergeShare = Math.min(100, Math.max(0, Number(raw) || 0)) / 100);

// Same blocks as functions/src/prompts.js PROMPT_DEFAULTS
const PROMPT_BLOCKS: { key: string; label: MessageKey; warn?: MessageKey }[] = [
  { key: 'role', label: 'pp.role' },
  { key: 'designThinking', label: 'pp.designThinking' },
  { key: 'pacingDiverge', label: 'pp.pacingDiverge' },
  { key: 'pacingConverge', label: 'pp.pacingConverge' },
  { key: 'pacingOpen', label: 'pp.pacingOpen' },
  { key: 'style', label: 'pp.style' },
  { key: 'rules', label: 'pp.rules' },
  { key: 'outputFormat', label: 'pp.outputFormat', warn: 'pp.outputFormatWarn' },
  { key: 'memory', label: 'pp.memory', warn: 'pp.outputFormatWarn' },
  { key: 'sessionMessage', label: 'pp.sessionMessage' },
  { key: 'sessionKickoff', label: 'pp.sessionKickoff' },
  { key: 'sessionReminder', label: 'pp.sessionReminder' },
  { key: 'sessionTimeUp', label: 'pp.sessionTimeUp' },
  { key: 'vision', label: 'pp.vision' },
  { key: 'svgRules', label: 'pp.svgRules' },
  { key: 'textToSvg', label: 'pp.textToSvg' },
  { key: 'sketchToSvg', label: 'pp.sketchToSvg' }
];
const promptDefaults = ref<PromptDefaults | null>(null);
const promptError = ref('');
onMounted(async () => {
  try {
    promptDefaults.value = await getPromptDefaults();
  } catch (e: any) {
    promptError.value = t('pe.promptsLoadFailed', { error: e?.message || String(e) });
  }
});
const phLabel = (ph: string) => `{{${ph}}}`;
const promptValue = (key: string) => draft.value.prompts[key] ?? promptDefaults.value?.defaults[key] ?? '';
const setPrompt = (key: string, value: string) => (draft.value.prompts[key] = value);
const isPromptChanged = (key: string) => key in draft.value.prompts && draft.value.prompts[key] !== promptDefaults.value?.defaults[key];
const resetPrompt = (key: string) => delete draft.value.prompts[key];

const save = () => {
  draft.value.rationale = Object.fromEntries(Object.entries(draft.value.rationale || {}).filter(([, v]) => v?.trim()));
  // Keep only blocks that differ from the built-in text (an emptied block falls back to it)
  const defaults = promptDefaults.value?.defaults;
  draft.value.prompts = Object.fromEntries(Object.entries(draft.value.prompts || {}).filter(([k, v]) => v?.trim() && v !== defaults?.[k]));
  emit('save', draft.value);
};

const input = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500';
</script>

<template>
  <div class="space-y-6">
    <section class="grid sm:grid-cols-2 gap-3">
      <label class="space-y-1">
        <span class="text-xs text-slate-400">{{ t('pe.name') }}</span>
        <input v-model="draft.name" :class="input" :placeholder="t('pe.namePlaceholder')" />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-slate-400">{{ t('pe.description') }}</span>
        <input v-model="draft.description" :class="input" />
      </label>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.condition') }}</h3>
      <div class="grid sm:grid-cols-3 gap-2">
        <button
          v-for="mode in MODES"
          :key="mode"
          type="button"
          @click="draft.mode = mode"
          class="text-left p-3 rounded-xl border text-xs transition"
          :class="draft.mode === mode ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'"
        >
          {{ modeLabel(mode) }}
        </button>
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-300 pt-1">
        <span class="text-slate-400">{{ t('pe.language') }}</span>
        <select v-model="draft.language" class="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100">
          <option v-for="l in LANGS" :key="l.code" :value="l.code">{{ t(l.label) }}</option>
        </select>
      </label>
      <label class="flex items-start gap-2 text-xs text-slate-300 pt-1">
        <input type="checkbox" v-model="draft.shadowAssessment" class="mt-0.5" />
        <span>{{ t('pe.shadow') }}</span>
      </label>
    </section>

    <section class="space-y-3">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.flow') }}</h3>
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.expected') }}</span>
          <input type="number" min="1" :value="draft.session.expectedParticipants" @input="sessionNumber('expectedParticipants', ($event.target as HTMLInputElement).value)" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.max') }}</span>
          <input type="number" min="0" :value="draft.session.maxParticipants" @input="sessionNumber('maxParticipants', ($event.target as HTMLInputElement).value)" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.minutes') }}</span>
          <input type="number" min="1" :disabled="noTimeLimit" :value="draft.session.taskMinutes || ''" @input="sessionNumber('taskMinutes', ($event.target as HTMLInputElement).value)" :class="[input, noTimeLimit ? 'opacity-40' : '']" />
          <span class="flex items-center gap-1.5 text-[11px] text-slate-300"><input type="checkbox" v-model="noTimeLimit" /> {{ t('pe.noLimit') }}</span>
        </label>
      </div>
      <p v-if="draft.session.maxParticipants && draft.session.maxParticipants < draft.session.expectedParticipants" class="text-[11px] text-rose-300">{{ t('pe.maxTooLow') }}</p>
      <div :class="{ 'opacity-50': draft.mode === 'none' }" class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.reminders') }}</span>
          <input v-model.lazy="reminderText" :disabled="noTimeLimit" :class="[input, noTimeLimit ? 'opacity-40' : '']" :placeholder="t('pe.remindersPlaceholder')" />
        </label>
        <!-- One text per language; the room language of this profile is the one used (highlighted) -->
        <div v-for="field in (['openingText', 'taskDescription'] as const)" :key="field" class="space-y-1">
          <span class="text-xs text-slate-400">{{ t(field === 'openingText' ? 'pe.opening' : 'pe.task') }}</span>
          <div class="grid sm:grid-cols-2 gap-2">
            <label v-for="l in LANGS" :key="l.code" class="block space-y-0.5">
              <span class="text-[10px]" :class="draft.language === l.code ? 'text-sky-300' : 'text-slate-500'" :title="draft.language === l.code ? t('pe.usedLanguage') : ''">{{ t(l.label) }}{{ draft.language === l.code ? ' ●' : '' }}</span>
              <textarea v-model="draft.session[field][l.code]" rows="3" :class="input"></textarea>
            </label>
          </div>
        </div>
        <p v-if="draft.mode === 'none'" class="text-[11px] text-amber-300">{{ t('pe.noneNote') }}</p>
      </div>
    </section>

    <section class="space-y-3" :class="{ 'opacity-50': draft.mode === 'none' }">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.identity') }}</h3>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.nameZh') }}</span>
          <input v-model="draft.displayName['zh-TW']" :class="input" />
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.nameEn') }}</span>
          <input v-model="draft.displayName.en" :class="input" />
        </label>
      </div>
      <label class="block space-y-1">
        <span class="text-xs text-slate-400">{{ t('pe.persona') }}</span>
        <textarea v-model="draft.persona" rows="3" :class="input"></textarea>
      </label>
      <div class="text-[11px]">
        <button type="button" class="text-sky-400 hover:underline pointer-coarse:py-1.5" @click="toggleRationale('persona')">
          {{ hasRationale('persona') ? t('pe.rationaleSet') : t('pe.rationaleAdd') }}
        </button>
        <textarea v-if="openRationale.persona" v-model="draft.rationale.persona" rows="2" :class="[input, 'mt-1 text-xs']" :placeholder="t('pe.rationalePlaceholder')"></textarea>
      </div>
    </section>

    <!-- Chat tone and divergent / convergent pacing -->
    <section class="space-y-3" :class="{ 'opacity-50': draft.mode === 'none' }">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.style') }}</h3>
      <div class="space-y-1">
        <span class="text-xs text-slate-400">{{ t('pe.casualness') }}</span>
        <div class="grid grid-cols-5 gap-1.5">
          <button
            v-for="level in 5"
            :key="level"
            type="button"
            @click="draft.style.casualness = level"
            class="px-1 py-2 pointer-coarse:py-2.5 rounded-lg border text-xs transition"
            :class="draft.style.casualness === level ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600'"
          >
            <span class="block font-semibold">{{ level }}</span>
            <span class="block text-[10px]">{{ t(CASUAL_LABELS[level - 1]) }}</span>
          </button>
        </div>
      </div>
      <div class="grid sm:grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.maxSentences') }}</span>
          <input type="number" min="1" max="8" v-model.number="draft.style.maxSentences" :class="input" />
          <span class="block text-[11px] text-slate-500">{{ t('pe.maxSentencesHelp') }}</span>
        </label>
        <label class="space-y-1">
          <span class="text-xs text-slate-400">{{ t('pe.divergeShare') }}</span>
          <input type="number" min="0" max="100" :value="Math.round(draft.facilitation.divergeShare * 100)" @input="setDivergeShare(($event.target as HTMLInputElement).value)" :class="input" />
          <span class="block text-[11px] text-slate-500">{{ t('pe.divergeShareHelp') }}</span>
        </label>
      </div>
    </section>

    <!-- Every instruction the AI receives; only changed blocks are stored with the profile -->
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.prompts') }}</h3>
      <p class="text-[11px] text-slate-500">{{ t('pe.promptsHelp', { version: promptDefaults?.version || '—' }) }}</p>
      <p v-if="promptError" class="text-[11px] text-rose-300">{{ promptError }}</p>
      <details v-for="b in PROMPT_BLOCKS" :key="b.key" class="rounded-xl border border-slate-800 bg-slate-900/60">
        <summary class="px-3 py-2.5 pointer-coarse:py-3 cursor-pointer text-sm text-slate-200 flex items-center gap-2 select-none">
          <span class="min-w-0 flex-1">{{ t(b.label) }}</span>
          <span v-if="isPromptChanged(b.key)" class="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{{ t('pe.promptChanged') }}</span>
        </summary>
        <div class="px-3 pb-3 space-y-2">
          <p v-if="b.warn" class="text-[11px] text-amber-300">{{ t(b.warn) }}</p>
          <div v-if="promptDefaults?.placeholders[b.key]?.length" class="flex flex-wrap gap-1 text-[10px]">
            <span class="text-slate-500">{{ t('pe.placeholders') }}</span>
            <code v-for="ph in promptDefaults.placeholders[b.key]" :key="ph" class="px-1 rounded bg-slate-800 text-sky-300">{{ phLabel(ph) }}</code>
          </div>
          <textarea
            :value="promptValue(b.key)"
            @input="setPrompt(b.key, ($event.target as HTMLTextAreaElement).value)"
            :disabled="!promptDefaults"
            rows="10"
            spellcheck="false"
            :class="[input, 'font-mono !text-xs leading-relaxed']"
          ></textarea>
          <button v-if="isPromptChanged(b.key)" type="button" @click="resetPrompt(b.key)" class="text-[11px] text-sky-400 hover:underline pointer-coarse:py-1.5">{{ t('pe.promptReset') }}</button>
        </div>
      </details>
    </section>


    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.timing') }}</h3>
      <div v-for="f in TIMING_FIELDS" :key="f.path" class="p-3 rounded-xl border border-slate-800 bg-slate-900/60">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm text-slate-100">{{ t(f.label) }}</div>
            <div class="text-[11px] text-slate-500">{{ t(f.help) }}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              type="number"
              :min="f.min"
              :max="f.max"
              :value="numberValue(f.path)"
              @input="setNumber(f.path, ($event.target as HTMLInputElement).value)"
              class="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 pointer-coarse:py-2 text-sm text-right text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <span class="text-xs text-slate-400 w-8">{{ f.unit ? t(f.unit) : '' }}</span>
          </div>
        </div>
        <div class="mt-1.5 text-[11px]">
          <button type="button" class="text-sky-400 hover:underline pointer-coarse:py-1.5" @click="toggleRationale(f.path)">
            {{ hasRationale(f.path) ? t('pe.rationaleSet') : t('pe.rationaleAdd') }}
          </button>
          <span v-if="!hasRationale(f.path)" class="ml-2 text-amber-400/70">{{ t('pe.provisional') }}</span>
          <textarea
            v-if="openRationale[f.path]"
            v-model="draft.rationale[f.path]"
            rows="2"
            :class="[input, 'mt-1 text-xs']"
            :placeholder="t('pe.rationaleExample')"
          ></textarea>
        </div>
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" v-model="draft.memory.updateOnWhiteboardShare" />
        <span>{{ t('pe.memoryOnShare') }}</span>
      </label>
    </section>

    <section class="space-y-2" :class="{ 'opacity-50': draft.mode === 'none' }">
      <h3 class="text-sm font-semibold text-slate-200">{{ t('pe.modules') }}</h3>
      <p v-if="draft.mode === 'none'" class="text-[11px] text-amber-300">{{ t('pe.modulesOff') }}</p>
      <div class="grid sm:grid-cols-2 gap-2">
        <label v-for="m in MODULES" :key="m.key" class="flex items-center gap-2 p-2.5 rounded-lg border border-slate-800 bg-slate-900/60 text-xs text-slate-200">
          <input type="checkbox" v-model="draft.modules[m.key]" :disabled="draft.mode === 'none'" />
          <span>{{ t(m.label) }}</span>
        </label>
      </div>
    </section>

    <div class="sticky bottom-0 -mx-4 -mb-4 px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 bg-slate-900 rounded-b-2xl">
      <span class="text-[11px] text-slate-500 mr-auto">{{ t('pe.versionNote', { version: profile.version || 0 }) }}</span>
      <button type="button" @click="emit('cancel')" class="px-4 py-2 pointer-coarse:py-2.5 rounded-lg text-xs text-slate-400 hover:text-ink">{{ t('common.cancel') }}</button>
      <button
        type="button"
        @click="save"
        :disabled="saving || !draft.name.trim()"
        class="px-4 py-2 pointer-coarse:py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40"
      >
        {{ saving ? t('pe.saving') : t('pe.save') }}
      </button>
    </div>
  </div>
</template>
