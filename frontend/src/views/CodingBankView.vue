<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import PageNav from '../components/PageNav.vue';
import { useAuthStore } from '../stores/auth';
import { intlLocale, t, type MessageKey } from '../i18n';
import { fetchCodingBank, listCodingRatings, setCodingQuestionEnabled, codingQuestionKey, manageCodingBank, prepareSemanticQueue, type CodingQuestion, type CodingRatingRow, type CodingBankVersion } from '../services/coding';
import CodingMedia from '../components/admin/CodingMedia.vue';
import { mediaWindow, hasCodingMedia, humanSender } from '../../../functions/src/codingMedia.js';
import { humanWindow } from '../services/codingSampling';
import { exportCodingBankToDrive, type CodingCloudExport } from '../services/coding';

const auth = useAuthStore();
const busy = ref(true), saving = ref(''), error = ref('');
const uploading = ref(false), cloudExport = ref<CodingCloudExport | null>(null);
async function exportAllToDrive() {
  if (!bankVersion.value) return;
  uploading.value = true; error.value = '';
  const versionId = bankVersion.value.id;
  try { const result = await exportCodingBankToDrive(versionId); if (bankVersion.value?.id === versionId) cloudExport.value = result; }
  catch { error.value = t('coding.cloudExportFailed'); }
  finally { uploading.value = false; }
}
const versions = ref<CodingBankVersion[]>([]), bankVersion = ref<CodingBankVersion | null>(null);
const versionSelection = ref(''), activeVersion = ref(''), versionNote = ref('');
const building = ref(false), updateSemantic = ref(false);
const questionCount = ref<number | null>(null), estimating = ref(false);
const estimate = ref<{ available: number; recommended: number } | null>(null);
async function suggestCount() {
  estimating.value = true; error.value = '';
  try {
    const result = await manageCodingBank({ action: 'estimate', ...(checkedRooms.value.length ? { roomIds: [...checkedRooms.value] } : {}) });
    estimate.value = { available: result.available!, recommended: result.recommended! };
    questionCount.value = result.recommended!;
  } catch { error.value = t('coding.loadFailed'); }
  finally { estimating.value = false; }
}
async function deleteVersion(id: string, restore = false) {
  building.value = true; error.value = '';
  try { await manageCodingBank({ action: restore ? 'restore' : 'delete', versionId: id }); versionSelection.value = ''; await refresh(); }
  catch { error.value = t('coding.deleteVersionFailed'); }
  finally { building.value = false; }
}
const availableRooms = ref<{ id: string; name: string }[]>([]), checkedRooms = ref<string[]>([]);
const roomIncluded = (id: string) => questions.value.some(q => q.roomId === id);
let appendRequest = '';
watch(checkedRooms, () => { appendRequest = ''; estimate.value = null; questionCount.value = null; }, { deep: true });
watch(questionCount, () => { appendRequest = ''; buildRequest = ''; resetRequest = ''; });
async function appendRooms() {
  if (!bankVersion.value || !checkedRooms.value.length || !questionCount.value) return;
  const baseVersion = bankVersion.value.id;
  const roomIds = [...checkedRooms.value];
  building.value = true; error.value = '';
  try {
    if (updateSemantic.value) await prepareSemanticQueue(roomIds.map(id => ({ id })));
    appendRequest ||= crypto.randomUUID();
    const result = await manageCodingBank({ action: 'append', requestId: appendRequest, baseVersion, roomIds, note: versionNote.value, questionCount: questionCount.value });
    versionSelection.value = result.version!.id; appendRequest = ''; checkedRooms.value = []; versionNote.value = '';
    await refresh();
  } catch { error.value = t('coding.appendFailed'); }
  finally { building.value = false; }
}
let buildRequest = '';
let resetRequest = '';
async function createVersion(reset = false) {
  if (!questionCount.value || checkedRooms.value.length) return;
  if (reset && !window.confirm(t('coding.resetConfirm'))) return;
  building.value = true; error.value = '';
  try {
    if (updateSemantic.value) {
      const live = await fetchCodingBank('live');
      await prepareSemanticQueue(live.rooms);
    }
    if (reset) resetRequest ||= crypto.randomUUID(); else buildRequest ||= crypto.randomUUID();
    const result = await manageCodingBank({ action: reset ? 'reset' : 'create', requestId: reset ? resetRequest : buildRequest, note: versionNote.value, questionCount: questionCount.value });
    versionSelection.value = result.version!.id;
    if (reset) resetRequest = ''; else buildRequest = '';
    versionNote.value = '';
    await refresh();
  } catch { error.value = t('coding.versionBuildFailed'); }
  finally { building.value = false; }
}
async function activateVersion() {
  if (!bankVersion.value) return;
  building.value = true; error.value = '';
  try { activeVersion.value = (await manageCodingBank({ action: 'activate', versionId: bankVersion.value.id })).activeVersion!; }
  catch { error.value = t('coding.saveFailed'); }
  finally { building.value = false; }
}
const rooms = ref<{ id: string; name: string }[]>([]);
const questions = ref<CodingQuestion[]>([]);
const disabled = ref(new Set<string>());
const ratings = ref<Record<string, CodingRatingRow[]>>({});
const room = ref(''), source = ref(''), status = ref(''), search = ref('');
const selected = ref<CodingQuestion | null>(null);
const detailDialog = ref<HTMLDialogElement | null>(null);
watch(selected, async value => { await nextTick(); if (value) detailDialog.value?.showModal(); else detailDialog.value?.close(); });
const keyOf = (q: CodingQuestion) => codingQuestionKey(q.roomId, q.messages[q.index].id);
const label = (key: string) => t(`coding.${key}` as MessageKey);
const date = (value: number) => value ? new Date(value).toLocaleString(intlLocale()) : '—';
const roomQuestions = computed(() => questions.value.filter(q => q.roomId === room.value));
const visible = computed(() => roomQuestions.value.filter(q => {
  const rows = ratings.value[keyOf(q)];
  return (!source.value || q.events?.some(e => e.kind === source.value))
    && (!status.value || (status.value === 'disabled' ? disabled.value.has(keyOf(q))
      : status.value === 'enabled' ? !disabled.value.has(keyOf(q))
      : status.value === 'unanswered' ? rows?.length === 0 : rows?.some(r => r.answer.status === status.value)))
    && (!search.value || `${keyOf(q)} ${q.messages[q.index].content}`.toLowerCase().includes(search.value.toLowerCase()));
}));
const reviewers = computed(() => {
  const people = new Map<string, { uid: string; draft: number; submitted: number; detailedDraft: number; detailedSubmitted: number }>();
  for (const q of roomQuestions.value) for (const row of ratings.value[keyOf(q)] || []) {
    const person = people.get(row.uid) || { uid: row.uid, draft: 0, submitted: 0, detailedDraft: 0, detailedSubmitted: 0 };
    if (row.phase === 1) person[row.answer.status]++;
    else if (row.answer.status === 'submitted') person.detailedSubmitted++;
    else person.detailedDraft++;
    people.set(row.uid, person);
  }
  return [...people.values()];
});
const count = (q: CodingQuestion, phase: number, status: string) => ratings.value[keyOf(q)]?.filter(r => r.phase === phase && r.answer.status === status).length;
const selectedRows = computed(() => selected.value ? ratings.value[keyOf(selected.value)] || [] : []);
const context = computed(() => selected.value ? (selected.value.mediaPolicy ? mediaWindow : humanWindow)(selected.value.messages, selected.value.messages[selected.value.index].id) : []);
let generation = 0;
async function loadRoom() {
  const ticket = ++generation;
  busy.value = true; error.value = ''; selected.value = null;
  const pending = [...roomQuestions.value];
  try {
    for (let i = 0; i < pending.length; i += 5) {
      const batch = await Promise.all(pending.slice(i, i + 5).map(async q => [keyOf(q), await listCodingRatings(q.roomId, q.messages[q.index].id, q.revision)] as const));
      if (ticket !== generation) return;
      for (const [key, rows] of batch) ratings.value[key] = rows;
    }
  } catch { if (ticket === generation) error.value = t('coding.loadFailed'); }
  finally { if (ticket === generation) busy.value = false; }
}
async function refresh() {
  busy.value = true; error.value = '';
  try {
    const [bank, catalog, liveRooms] = await Promise.all([fetchCodingBank(versionSelection.value || undefined), manageCodingBank({ action: 'list' }), manageCodingBank({ action: 'rooms' })]);
    availableRooms.value = liveRooms.rooms || []; checkedRooms.value = []; appendRequest = '';
    bankVersion.value = bank.version; activeVersion.value = catalog.activeVersion || ''; versions.value = catalog.versions || [];
    cloudExport.value = (bank.version as (CodingBankVersion & { lastExport?: CodingCloudExport }) | null)?.lastExport || null;
    questions.value = bank.allQuestions.sort((a, b) => a.messages[a.index].timestamp - b.messages[b.index].timestamp);
    rooms.value = bank.rooms.filter(r => questions.value.some(q => q.roomId === r.id));
    disabled.value = bank.disabled; ratings.value = {};
    if (!rooms.value.some(r => r.id === room.value)) room.value = rooms.value[0]?.id || '';
    await loadRoom();
  } catch { error.value = t('coding.loadFailed'); busy.value = false; }
}
async function toggle(q: CodingQuestion) {
  const key = keyOf(q); saving.value = key; error.value = '';
  const enabled = disabled.value.has(key);
  try {
    await setCodingQuestionEnabled(q.roomId, q.messages[q.index].id, enabled, auth.uid!);
    if (enabled) disabled.value.delete(key); else disabled.value.add(key);
  } catch { error.value = t('coding.saveFailed'); }
  finally { saving.value = ''; }
}
function answerFields(row: CodingRatingRow) {
  const a = row.answer;
  if ('labels' in a) return [...Object.entries(a.labels).map(([k, values]) => ({ label: label(k), value: values.map(label).join('、') })),
    ...Object.entries(a.scores).map(([k, score]) => ({ label: label(k), value: `${score || '—'} / 5` }))];
  return ['thinking', 'discussion', 'necessity', 'action'].map(k => {
    const value = a[k as 'thinking' | 'discussion' | 'necessity' | 'action'];
    return { label: label(k), value: (Array.isArray(value) ? value : value ? [value] : []).map(label).join('、') || '—' };
  });
}
function exportRoom() {
  const data = roomQuestions.value.map(q => ({ roomId: q.roomId, messageId: q.messages[q.index].id,
    enabled: !disabled.value.has(keyOf(q)), events: q.events, ratingRevision: q.revision || 'legacy', ratings: ratings.value[keyOf(q)] }));
  const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: Date.now(), bankVersion: bankVersion.value, questions: data }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `coding-${room.value}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(async () => {
  try { await auth.waitForAuthReady(); await auth.waitForRole(); if (auth.isAdmin) await refresh(); }
  catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
});
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6 pt-20 sm:pt-20">
    <PageNav />
    <main class="max-w-6xl mx-auto space-y-5">
      <header class="flex flex-wrap items-center justify-between gap-3"><h1 class="text-xl font-semibold">{{ t('coding.bankTitle') }}</h1><router-link to="/admin/coding" class="border border-slate-700 rounded-lg px-3 py-2">{{ t('coding.backToAnswers') }}</router-link></header>
      <p v-if="error" role="alert" class="text-rose-400">{{ error }}</p>
      <p v-if="busy" role="status">{{ t('coding.loading') }}</p>
      <p v-if="!busy && !auth.isAdmin">{{ t('coding.noAccess') }}</p>
      <template v-if="auth.isAdmin">
        <section class="border border-slate-700 rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">{{ t('coding.exportWholeVersion') }}</h2>
          <p class="text-sm text-slate-400">{{ t('coding.exportWholeHint') }}</p>
          <button :disabled="busy || building || uploading || !bankVersion" class="bg-sky-600 text-white rounded-lg px-4 py-2 disabled:opacity-40" @click="exportAllToDrive">{{ t(uploading ? 'coding.uploadingAnswers' : 'coding.uploadAllAnswers') }}</button>
          <p v-if="!bankVersion" class="text-sm text-amber-400">{{ t('coding.exportNeedsVersion') }}</p>
          <p v-if="cloudExport" class="text-sm">{{ t('coding.cloudExportDone', { count: cloudExport.answerCount, time: date(cloudExport.completedAt) }) }} <a :href="cloudExport.folderUrl" target="_blank" rel="noopener noreferrer" class="text-sky-400 underline">{{ t('coding.openExportFolder') }}</a></p>
          <router-link to="/admin" class="text-sm text-sky-400 underline">{{ t('coding.driveSetup') }}</router-link>
        </section>
        <section class="border border-slate-700 rounded-xl p-4 space-y-3">
          <h2 class="font-semibold">{{ t('coding.versionManagement') }}</h2>
          <p class="text-sm text-slate-400">{{ t('coding.versionHint') }}</p>
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex-1 min-w-48">{{ t('coding.viewVersion') }}<select v-model="versionSelection" :disabled="busy || building" class="block w-full bg-slate-900 border border-slate-700 rounded-lg p-2" @change="refresh"><option value="">{{ t('coding.currentBank') }}</option><option v-for="version in versions.filter(v => v.status === 'ready' && !v.deletedAt)" :key="version.id" :value="version.id">{{ t('coding.bankVersionLabel', { version: version.sequence }) }} · {{ date(version.completedAt || version.startedAt) }}{{ version.id === activeVersion ? ' · ' + t('coding.activeBank') : '' }}</option></select></label>
            <button :disabled="busy || building || !bankVersion || bankVersion.id === activeVersion" class="border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-40" @click="activateVersion">{{ t('coding.activateVersion') }}</button>
          </div>
          <button v-if="bankVersion" :disabled="busy || building || bankVersion.id === activeVersion" class="border border-rose-500 text-rose-400 rounded-lg px-3 py-2 disabled:opacity-40" @click="deleteVersion(bankVersion.id)">{{ t('coding.deleteVersion') }}</button>
          <p class="text-xs text-slate-400">{{ t('coding.deleteVersionHint') }}</p>
          <details><summary>{{ t('coding.deletedVersions') }}</summary><div v-for="v in versions.filter(v => v.deletedAt)" :key="v.id" class="flex justify-between gap-3 py-2"><span>{{ t('coding.bankVersionLabel', { version: v.sequence }) }}</span><button :disabled="building" class="text-sky-400 underline" @click="deleteVersion(v.id, true)">{{ t('coding.restoreVersion') }}</button></div></details>
          <template v-if="bankVersion">
            <p>{{ t('coding.bankVersionLabel', { version: bankVersion.sequence }) }} · {{ t(bankVersion.id === activeVersion ? 'coding.activeBank' : 'coding.archivedBank') }}</p>
            <p class="text-sm">{{ t('coding.versionSourceRange', { start: date(bankVersion.startedAt), end: date(bankVersion.completedAt || bankVersion.startedAt) }) }}</p>
            <p v-if="bankVersion.counts" class="text-sm">{{ t('coding.versionChanges', bankVersion.counts) }}</p>
            <p v-if="bankVersion.counts" class="text-sm" :class="bankVersion.counts.semanticCovered < bankVersion.counts.questions ? 'text-amber-400' : 'text-slate-400'">{{ t('coding.semanticCoverage', { covered: bankVersion.counts.semanticCovered, total: bankVersion.counts.questions }) }}</p>
            <p v-if="bankVersion.resetAnswers" class="text-amber-400 text-sm">{{ t('coding.resetVersion') }}</p>
            <p v-if="bankVersion.note" class="text-sm whitespace-pre-wrap">{{ bankVersion.note }}</p>
          </template>
          <p v-else class="text-sm text-amber-400">{{ t('coding.liveBank') }}</p>
          <section class="border border-slate-700 rounded-lg p-3 space-y-2">
            <p class="text-sm">{{ t('coding.countHint') }}</p>
            <button :disabled="busy || building || estimating" class="border border-slate-700 rounded-lg px-3 py-2" @click="suggestCount">{{ t('coding.suggestCount') }}</button>
            <p v-if="estimate" class="text-sm text-slate-400">{{ t('coding.countEstimate', estimate) }}</p>
            <label class="block">{{ t('coding.questionCount') }}<input v-model.number="questionCount" type="number" min="1" step="1" :max="estimate?.available" :disabled="building || estimating" class="block w-40 bg-slate-900 border border-slate-700 rounded-lg p-2"></label>
          </section>
          <label class="block">{{ t('coding.versionNote') }}<input v-model="versionNote" :disabled="building" maxlength="300" class="block w-full bg-slate-900 border border-slate-700 p-2 rounded-lg"></label>
          <label class="flex gap-2 items-start text-sm"><input v-model="updateSemantic" type="checkbox" :disabled="building" class="mt-1">{{ t('coding.updateSemanticForVersion') }}</label>
          <p class="text-xs text-slate-400">{{ t('coding.versionSemanticHint') }}</p>
          <button :disabled="busy || building || checkedRooms.length > 0 || !questionCount || questionCount < 1" class="bg-sky-600 text-white rounded-lg px-4 py-2 disabled:opacity-40" @click="createVersion(false)">{{ t(building ? 'coding.buildingVersion' : 'coding.createVersion') }}</button>
          <section class="border-t border-slate-700 pt-3 space-y-3">
            <h3 class="font-medium">{{ t('coding.appendRoomsTitle') }}</h3>
            <p class="text-sm text-slate-400">{{ t('coding.appendRoomsHint') }}</p>
            <div class="max-h-64 overflow-y-auto grid sm:grid-cols-2 gap-2">
              <label v-for="r in availableRooms" :key="r.id" class="flex items-start gap-2 border border-slate-700 rounded-lg p-3" :class="{ 'opacity-50': roomIncluded(r.id) }"><input v-model="checkedRooms" :value="r.id" type="checkbox" :disabled="busy || building || !bankVersion || roomIncluded(r.id)"><span class="break-all">{{ r.name }} · {{ r.id }}<span v-if="roomIncluded(r.id)"> · {{ t('coding.roomAlreadyIncluded') }}</span></span></label>
            </div>
            <button :disabled="busy || building || !bankVersion || !checkedRooms.length || !questionCount || questionCount < 1" class="border border-sky-500 text-sky-400 rounded-lg px-4 py-2 disabled:opacity-40" @click="appendRooms">{{ t('coding.appendRoomsButton', { count: checkedRooms.length }) }}</button>
          </section>
          <div class="border-t border-slate-700 pt-3 space-y-2">
            <p class="text-sm text-slate-400">{{ t('coding.resetHint') }}</p>
            <button :disabled="busy || building || checkedRooms.length > 0 || !questionCount || questionCount < 1" class="border border-amber-500 text-amber-400 rounded-lg px-4 py-2 disabled:opacity-40" @click="createVersion(true)">{{ t('coding.resetBank') }}</button>
          </div>
        </section>
        <p class="text-sm text-slate-400">{{ t('coding.bankHint') }}</p>
        <p>{{ t('coding.bankTotals', { total: questions.length, enabled: questions.length - disabled.size }) }}</p>
        <div class="flex flex-wrap gap-3">
          <label>{{ t('coding.room') }}<select v-model="room" :disabled="busy" class="block bg-slate-900 border border-slate-700 p-2 rounded-lg max-w-full" @change="loadRoom"><option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
          <label>{{ t('coding.eventSources') }}<select v-model="source" class="block bg-slate-900 border border-slate-700 p-2 rounded-lg"><option value="">{{ t('coding.all') }}</option><option v-for="kind in ['intervention', 'semantic', 'tool', 'random']" :key="kind" :value="kind">{{ label('event_' + kind) }}</option></select></label>
          <label>{{ t('coding.filterStatus') }}<select v-model="status" class="block bg-slate-900 border border-slate-700 p-2 rounded-lg"><option value="">{{ t('coding.all') }}</option><option v-for="s in ['enabled', 'disabled', 'unanswered', 'draft', 'submitted']" :key="s" :value="s">{{ label('status_' + s) }}</option></select></label>
          <label class="flex-1 min-w-40">{{ t('coding.searchQuestions') }}<input v-model="search" type="search" class="block w-full bg-slate-900 border border-slate-700 rounded-lg p-2"></label>
          <button :disabled="busy || !!saving" class="self-end border border-slate-700 rounded-lg p-2 disabled:opacity-40" @click="refresh">{{ t('coding.refreshResults') }}</button>
          <button :disabled="busy || !!error || !roomQuestions.length" class="self-end border border-slate-700 rounded-lg p-2 disabled:opacity-40" @click="exportRoom">{{ t('coding.exportResults') }}</button>
        </div>
        <section class="space-y-3"><h2 class="font-semibold">{{ t('coding.reviewerProgress') }}</h2><p class="text-xs text-slate-400">{{ t('coding.reviewerHint') }}</p>
          <div class="grid gap-2 sm:grid-cols-2"><article v-for="person in reviewers" :key="person.uid" class="rounded-xl border border-slate-800 p-3 text-sm"><p class="break-all">{{ t('coding.reviewerId') }}: {{ person.uid }}</p><p>{{ t('coding.stageCounts', { stage: 1, draft: person.draft, submitted: person.submitted }) }}</p><p>{{ t('coding.stageCounts', { stage: 2, draft: person.detailedDraft, submitted: person.detailedSubmitted }) }}</p></article></div>
          <p v-if="!busy && !reviewers.length" class="text-slate-400">{{ t('coding.noRatings') }}</p>
        </section>
        <section class="space-y-3"><h2 class="font-semibold">{{ t('coding.questionList', { count: visible.length }) }}</h2>
          <article v-for="q in visible" :key="keyOf(q)" class="border border-slate-800 rounded-xl p-4 space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-3"><p class="text-xs text-slate-400 break-all">{{ keyOf(q) }} · {{ date(q.messages[q.index].timestamp) }}</p><span :class="disabled.has(keyOf(q)) ? 'text-amber-400' : 'text-emerald-400'">{{ t(disabled.has(keyOf(q)) ? 'coding.status_disabled' : 'coding.status_enabled') }}</span></div>
            <p class="whitespace-pre-wrap break-words line-clamp-3">{{ q.messages[q.index].content }}</p>
            <p class="text-xs text-slate-400">{{ [...new Set(q.events?.map(e => label('event_' + e.kind)))].join(' · ') }}</p>
            <div class="flex flex-wrap items-center justify-between gap-3"><div class="text-sm"><p v-for="stage in [1, 2]" :key="stage">{{ t('coding.stageCounts', { stage, submitted: count(q, stage, 'submitted') ?? '—', draft: count(q, stage, 'draft') ?? '—' }) }}</p></div>
              <div class="flex gap-2"><button :disabled="!ratings[keyOf(q)]" class="border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-40" @click="selected = q">{{ t('coding.answerDetails') }}</button><button :disabled="!!saving" class="border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-40" @click="toggle(q)">{{ t(disabled.has(keyOf(q)) ? 'coding.enableQuestion' : 'coding.disableQuestion') }}</button></div>
            </div>
          </article>
          <p v-if="!busy && !visible.length">{{ t('coding.noMatchingQuestions') }}</p>
        </section>
      </template>
      <dialog ref="detailDialog" class="fixed inset-0 z-50 m-0 w-full h-full max-h-none max-w-none bg-slate-950 text-slate-100 overflow-y-auto p-4 sm:p-6" aria-labelledby="coding-detail-title" @close="selected = null">
        <div v-if="selected" class="max-w-4xl mx-auto space-y-4">
          <header class="sticky top-0 bg-slate-950 py-2 flex justify-between items-center gap-3"><h2 id="coding-detail-title" class="font-semibold">{{ t('coding.answerDetails') }}</h2><button class="border border-slate-700 rounded-lg px-4 py-2" autofocus @click="selected = null">{{ t('coding.closeTools') }}</button></header>
          <p class="break-all text-sm">{{ keyOf(selected) }}</p>
          <section class="space-y-2"><p v-for="m in context" :key="m.id" class="rounded-xl border p-3 whitespace-pre-wrap break-words" :class="m.id === selected.messages[selected.index].id ? 'border-sky-500' : 'border-slate-800'"><span class="block text-xs text-slate-400 mb-1">{{ m.senderName }} · {{ date(m.timestamp) }} {{ m.id === selected.messages[selected.index].id ? t('coding.targetMessage') : '' }}</span><span v-if="humanSender(m)">{{ m.content }}</span><CodingMedia v-if="hasCodingMedia(m)" :message="m" /></p></section>
          <p v-if="!selectedRows.length">{{ t('coding.noRatings') }}</p>
          <article v-for="row in selectedRows" :key="row.uid + row.phase" class="border border-slate-700 rounded-xl p-4 space-y-3">
            <h3 class="font-medium break-all">{{ t('coding.reviewerId') }}: {{ row.uid }}</h3><p>{{ label('phase' + row.phase) }} · {{ label('status_' + row.answer.status) }} · {{ date(row.answer.updatedAt) }}</p>
            <dl class="space-y-3"><div v-for="field in answerFields(row)" :key="field.label"><dt class="text-sm text-slate-400">{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl>
            <p v-if="row.answer.ambiguous">{{ t('coding.ambiguous') }}</p><p v-if="row.answer.important">{{ t('coding.important') }}</p><p v-if="row.answer.reason" class="whitespace-pre-wrap">{{ t('coding.reason') }}: {{ row.answer.reason }}</p>
            <details><summary class="cursor-pointer">{{ t('coding.source') }}</summary><pre class="text-xs whitespace-pre-wrap break-all mt-2">{{ JSON.stringify({ roomId: selected.roomId, messageId: selected.messages[selected.index].id, ...('labels' in row.answer ? { replyId: row.answer.replyId } : { source: row.answer.source, viewContext: row.answer.viewContext }) }, null, 2) }}</pre></details>
          </article>
        </div>
      </dialog>
    </main>
  </div>
</template>
