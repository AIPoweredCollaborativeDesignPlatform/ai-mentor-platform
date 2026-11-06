<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { t, type MessageKey } from '../../i18n';
import { useAuthStore } from '../../stores/auth';
import { detailedOptions, scoreFields, emptyDetailed, isMultiple, loadDetailed, saveDetailed, type DetailField } from '../../services/coding';

const props = defineProps<{ roomId: string; messageId: string; replyId: string; advance?: boolean; externalBusy?: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean]; submitted: []; saved: [status: 'draft' | 'submitted']; valid: [value: boolean] }>();
const auth = useAuthStore();
const answer = ref(emptyDetailed(props.replyId));
const baseline = ref(JSON.stringify(answer.value));
const busy = ref(true);
const loaded = ref(false);
const error = ref('');
const notice = ref('');
const needsReason = computed(() => answer.value.ambiguous || answer.value.important);
const complete = computed(() => Object.values(answer.value.labels).every(values => values.length > 0)
  && scoreFields.every(field => answer.value.scores[field] >= 1 && answer.value.scores[field] <= 5)
  && (!needsReason.value || !!answer.value.reason.trim()));
watch(() => JSON.stringify(answer.value) !== baseline.value, value => emit('dirty', value));
watch(() => loaded.value && complete.value, value => emit('valid', value), { immediate: true });
const key = (value: string) => `coding.${value}` as MessageKey;
onMounted(async () => {
  try {
    answer.value = await loadDetailed(props.roomId, props.messageId, auth.uid!, props.replyId);
    baseline.value = JSON.stringify(answer.value); loaded.value = true;
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
});
function toggle(field: DetailField, option: string, checked: boolean) {
  let selected = answer.value.labels[field];
  if (field === 'collaboration_situation' && checked) {
    selected = option === 'effective' ? [] : selected.filter(value => value !== 'effective');
  }
  answer.value.labels[field] = isMultiple(field)
    ? checked ? [...selected, option] : selected.filter(value => value !== option)
    : [option];
}
async function save(status: 'draft' | 'submitted', advance = true) {
  if (!auth.uid || !loaded.value || (status === 'submitted' && !complete.value)) return false;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    answer.value = await saveDetailed(props.roomId, props.messageId, auth.uid, { ...answer.value, status });
    baseline.value = JSON.stringify(answer.value);
    emit('saved', status);
    notice.value = t(status === 'draft' ? 'coding.draftSaved' : 'coding.submitted');
    if (status === 'submitted' && advance) emit('submitted');
    return true;
  } catch (e) { error.value = t(e instanceof Error && e.message === 'coding-conflict' ? 'coding.conflict' : 'coding.saveFailed'); return false; }
  finally { busy.value = false; }
}
defineExpose({
  persist: () => save(answer.value.status === 'submitted' && complete.value ? 'submitted' : 'draft', false),
  submit: () => save('submitted', false),
});
</script>

<template>
  <form class="space-y-5" @submit.prevent="save('submitted')">
    <h2 class="font-semibold text-lg">{{ t('coding.phase2') }}</h2>
    <p class="text-sm text-slate-400">{{ t('coding.detailHint') }}</p>
    <p v-if="error" role="alert" class="text-rose-400">{{ error }}</p>
    <p v-if="notice" role="status" class="text-emerald-400">{{ notice }}</p>
    <fieldset :disabled="busy || externalBusy || !loaded" class="space-y-6">
      <fieldset v-for="(options, field) in detailedOptions" :key="field">
        <legend class="font-semibold mb-2">{{ t(key(field)) }} · {{ t(isMultiple(field) ? 'coding.multiple' : 'coding.single') }}</legend>
        <div class="grid gap-2">
          <label v-for="option in options" :key="option" class="flex items-start gap-3 border border-slate-700 rounded-lg p-3 cursor-pointer" :class="{ 'border-sky-500 bg-slate-800': answer.labels[field].includes(option) }">
            <input :type="isMultiple(field) ? 'checkbox' : 'radio'" :name="field" :checked="answer.labels[field].includes(option)" class="mt-1" @change="toggle(field, option, ($event.target as HTMLInputElement).checked)">
            <span><span class="block">{{ t(key(option)) }}</span><span class="block text-xs text-slate-400 mt-1">{{ t(key(option + 'Help')) }}</span></span>
          </label>
        </div>
      </fieldset>
      <h3 class="font-semibold">{{ t('coding.scores') }}</h3>
      <p class="text-sm text-slate-400">{{ t('coding.scale') }}</p>
      <fieldset v-for="field in scoreFields" :key="field">
        <legend class="mb-2">{{ t(key(field)) }}</legend>
        <div class="grid grid-cols-5 gap-1 sm:gap-2"><label v-for="score in 5" :key="score" class="min-w-0 flex flex-col sm:flex-row items-center justify-center gap-1 p-2 rounded-lg border border-slate-700" :class="{ 'border-sky-500 bg-slate-800': answer.scores[field] === score }"><input v-model="answer.scores[field]" type="radio" :name="field" :value="score">{{ score }}</label></div>
      </fieldset>
      <label class="flex items-center gap-2"><input v-model="answer.ambiguous" type="checkbox">{{ t('coding.ambiguous') }}</label>
      <label class="flex items-center gap-2"><input v-model="answer.important" type="checkbox">{{ t('coding.important') }}</label>
      <label v-if="needsReason" class="block">{{ t('coding.reason') }}<textarea v-model="answer.reason" required maxlength="1000" rows="2" class="block w-full bg-slate-950 border border-slate-700 p-3 rounded-lg mt-2" /></label>
      <div class="flex gap-3"><button type="button" class="px-4 py-2 border border-slate-600 rounded-lg" @click="save('draft')">{{ t('coding.saveDraft') }}</button><button :disabled="!complete" type="submit" class="px-4 py-2 bg-sky-600 text-white rounded-lg disabled:opacity-40">{{ t(advance ? 'coding.submitNext' : 'coding.submit') }}</button></div>
    </fieldset>
  </form>
</template>
