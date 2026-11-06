<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import PageNav from '../components/PageNav.vue';
import ThemeSwitch from '../components/ThemeSwitch.vue';
import DetailedCoding from '../components/admin/DetailedCoding.vue';
import { intlLocale, t, type MessageKey } from '../i18n';
import { useAuthStore } from '../stores/auth';
import type { MessageItem } from '../types';
import { codingMessages, codingOptions, codingRooms, emptyCoding, loadCoding, saveCoding, loadCodingCase, openCodingCase, reviewCoding, buildCodingQueue, loadDetailed, type CodingCase, type CodingQuestion, type CodingSource } from '../services/coding';

const auth = useAuthStore();
const rooms = ref<{ id: string; name: string }[]>([]);
const roomId = ref('');
const messages = ref<MessageItem[]>([]);
const index = ref(-1);
const answer = ref(emptyCoding());
const baseline = ref(JSON.stringify(answer.value));
const busy = ref(true);
const management = ref(false);
const history = ref<{ question: CodingQuestion; phase: number }[]>([]);
const historyPosition = ref(-1);
const detailedForm = ref<InstanceType<typeof DetailedCoding> | null>(null);
let queue: CodingQuestion[] = [];
const exhausted = ref(false);
const error = ref('');
const notice = ref('');
const phase = ref(1);
const detailedDirty = ref(false);
const codingCase = ref<CodingCase | null>(null);
const review = ref<Awaited<ReturnType<typeof reviewCoding>> | null>(null);
const replyId = ref('');
const reviewIndex = ref<Record<string, Awaited<ReturnType<typeof reviewCoding>>>>({});
const cutoffs = computed(() => messages.value.map((message, i) => ({ message, i })).filter(({ message }) => !['ai_mentor', 'ai_mentor_3d', 'system'].includes(message.senderUid)));
const aiReplies = computed(() => messages.value.slice(index.value + 1).filter(m => m.senderUid === 'ai_mentor' || m.senderUid === 'ai_mentor_3d'));
const reply = computed(() => messages.value.find(m => m.id === codingCase.value?.replyId));
const dirty = computed(() => JSON.stringify(answer.value) !== baseline.value);
const target = computed(() => messages.value[index.value]);
const context = computed(() => messages.value.slice(0, phase.value === 2 && reply.value ? messages.value.indexOf(reply.value) + 1 : index.value + 1));
const firstSpeaker = computed(() => context.value.find(message => !['ai_mentor', 'ai_mentor_3d', 'system'].includes(message.senderUid))?.senderUid);
const isHumanMessage = (message: MessageItem) => !['ai_mentor', 'ai_mentor_3d', 'system'].includes(message.senderUid);
const needsReason = computed(() => answer.value.ambiguous || answer.value.important);
const complete = computed(() => !!answer.value.thinking && !!answer.value.necessity && answer.value.discussion.length > 0 && answer.value.action.length > 0 && (!needsReason.value || !!answer.value.reason.trim()));
const key = (value: string) => `coding.${value}` as MessageKey;
const canLeave = () => !(dirty.value || detailedDirty.value) || window.confirm(t('coding.discard'));
const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.value || detailedDirty.value) { event.preventDefault(); event.returnValue = ''; } };
onBeforeRouteLeave(canLeave);
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  try {
    await auth.waitForRole();
    if (auth.isObserver) {
      rooms.value = await codingRooms();
      queue = await buildCodingQueue(rooms.value);
      await nextQuestion();
    }
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
function sourceForQuestion(method: CodingSource['samplingMethod']): CodingSource {
  return { roomId: roomId.value, messageId: target.value!.id, messageTimestamp: target.value!.timestamp,
    contextMessageIds: messages.value.slice(0, index.value + 1).map(message => message.id),
    sampledAt: Date.now(), samplingMethod: method };
}
async function nextQuestion() {
  busy.value = true; error.value = ''; exhausted.value = false;
  try {
    if (historyPosition.value + 1 < history.value.length) {
      await loadHistory(historyPosition.value + 1);
      return;
    }
    while (queue.length) {
      const question = queue[queue.length - 1];
      const id = question.messages[question.index].id;
      const [nextAnswer, nextCase] = await Promise.all([
        loadCoding(question.roomId, id, auth.uid!), loadCodingCase(question.roomId, id),
      ]);
      let nextPhase = 1;
      if (nextAnswer.status === 'submitted') {
        if (!nextCase || (await loadDetailed(question.roomId, id, auth.uid!, nextCase.replyId)).status === 'submitted') {
          queue.pop(); continue;
        }
        // A previously submitted question can return only for its selected second-stage review.
        nextPhase = 2;
      }
      queue.pop();
      roomId.value = question.roomId; messages.value = question.messages; index.value = question.index;
      answer.value = { ...nextAnswer, source: nextAnswer.source || sourceForQuestion('random-human-message-v1') };
      baseline.value = JSON.stringify(answer.value); codingCase.value = nextCase;
      phase.value = nextPhase; detailedDirty.value = false; review.value = null;
      history.value.push({ question, phase: nextPhase });
      historyPosition.value = history.value.length - 1;
      await resetQuestionScroll();
      return;
    }
    index.value = -1; messages.value = []; roomId.value = ''; answer.value = emptyCoding();
    baseline.value = JSON.stringify(answer.value); detailedDirty.value = false; exhausted.value = true;
    historyPosition.value = history.value.length;
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function resetQuestionScroll() {
  await nextTick();
  const conversation = document.getElementById('coding-context');
  if (conversation) conversation.scrollTop = conversation.scrollHeight;
  document.getElementById('coding-answer-scroll')?.scrollTo({ top: 0 });
}
async function loadHistory(position: number) {
  const entry = history.value[position];
  const question = entry.question;
  const id = question.messages[question.index].id;
  const [stored, selectedCase] = await Promise.all([
    loadCoding(question.roomId, id, auth.uid!), loadCodingCase(question.roomId, id),
  ]);
  roomId.value = question.roomId; messages.value = question.messages; index.value = question.index;
  answer.value = { ...stored, source: stored.source || sourceForQuestion('random-human-message-v1') };
  baseline.value = JSON.stringify(answer.value); codingCase.value = selectedCase;
  phase.value = entry.phase; detailedDirty.value = false; exhausted.value = false;
  historyPosition.value = position; notice.value = '';
  await resetQuestionScroll();
}
async function navigateQuestion(direction: -1 | 1) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    if (phase.value === 2 && detailedDirty.value && detailedForm.value) {
      if (!await detailedForm.value.persist()) return;
    } else if (target.value && dirty.value) {
      const status = answer.value.status === 'submitted' && complete.value ? 'submitted' : 'draft';
      answer.value = await saveCoding(roomId.value, target.value.id, auth.uid!, { ...answer.value, status });
      baseline.value = JSON.stringify(answer.value);
    }
    if (direction === -1 && historyPosition.value > 0) await loadHistory(historyPosition.value - 1);
    else if (direction === 1) await nextQuestion();
  } catch (e) { error.value = t(e instanceof Error && e.message === 'coding-conflict' ? 'coding.conflict' : 'coding.saveFailed'); }
  finally { busy.value = false; }
}
async function reloadQueue() {
  if (!canLeave()) return;
  busy.value = true; error.value = '';
  try {
    rooms.value = await codingRooms(); queue = await buildCodingQueue(rooms.value);
    await nextQuestion();
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function toggleManagement() {
  if (!canLeave()) return;
  baseline.value = JSON.stringify(answer.value); detailedDirty.value = false;
  management.value = !management.value;
  if (!management.value) await reloadQueue();
  else if (target.value) {
    busy.value = true;
    try {
      const storedAnswer = await loadCoding(roomId.value, target.value.id, auth.uid!);
      answer.value = { ...storedAnswer, source: storedAnswer.source || sourceForQuestion('researcher-selection') };
      baseline.value = JSON.stringify(answer.value);
      review.value = await reviewCoding(roomId.value, target.value.id); replyId.value = aiReplies.value[0]?.id || '';
    }
    catch { error.value = t('coding.loadFailed'); }
    finally { busy.value = false; }
  }
}
async function chooseRoom(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (!canLeave()) { select.value = roomId.value; return; }
  busy.value = true; error.value = ''; notice.value = '';
  roomId.value = select.value; index.value = -1; messages.value = [];
  phase.value = 1; detailedDirty.value = false; codingCase.value = null; review.value = null;
  reviewIndex.value = {};
  answer.value = emptyCoding(); baseline.value = JSON.stringify(answer.value);
  try { if (roomId.value) messages.value = await codingMessages(roomId.value); }
  catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function scanRoom() {
  busy.value = true; error.value = '';
  try {
    // Bound the read concurrency for long conversations.
    for (let start = 0; start < cutoffs.value.length; start += 5) {
      await Promise.all(cutoffs.value.slice(start, start + 5).map(async ({ message }) => {
        reviewIndex.value[message.id] = await reviewCoding(roomId.value, message.id);
      }));
    }
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function chooseTarget(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (!canLeave()) { select.value = String(index.value); return; }
  const nextIndex = Number(select.value);
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const id = messages.value[nextIndex].id;
    const [nextAnswer, nextCase, nextReview] = await Promise.all([
      loadCoding(roomId.value, id, auth.uid!), loadCodingCase(roomId.value, id),
      auth.isAdmin ? reviewCoding(roomId.value, id) : Promise.resolve(null),
    ]);
    index.value = nextIndex;
    answer.value = { ...nextAnswer, source: nextAnswer.source || sourceForQuestion('researcher-selection') };
    baseline.value = JSON.stringify(answer.value);
    codingCase.value = nextCase; review.value = nextReview; phase.value = 1; detailedDirty.value = false;
    replyId.value = aiReplies.value[0]?.id || '';
  } catch { select.value = String(index.value); error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function openPhase2() {
  if (!target.value || !replyId.value || !auth.uid) return;
  busy.value = true; error.value = '';
  try {
    await openCodingCase(roomId.value, target.value.id, replyId.value, auth.uid);
    codingCase.value = await loadCodingCase(roomId.value, target.value.id);
  } catch { error.value = t('coding.saveFailed'); }
  finally { busy.value = false; }
}
function switchPhase(next: number) {
  if (next === phase.value) return;
  if (next === 1 && detailedDirty.value && !window.confirm(t('coding.discard'))) return;
  phase.value = next; detailedDirty.value = false;
}
async function save(status: 'draft' | 'submitted') {
  if (!target.value || !auth.uid || (status === 'submitted' && !complete.value)) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    answer.value = await saveCoding(roomId.value, target.value.id, auth.uid, { ...answer.value, status });
    baseline.value = JSON.stringify(answer.value); notice.value = t(status === 'draft' ? 'coding.draftSaved' : 'coding.submitted');
    if (!management.value && status === 'submitted') {
      if (codingCase.value) queue.unshift({ roomId: roomId.value, messages: messages.value, index: index.value });
      await nextQuestion();
    }
    else if (auth.isAdmin) review.value = await reviewCoding(roomId.value, target.value.id);
  } catch (e) { error.value = t(e instanceof Error && e.message === 'coding-conflict' ? 'coding.conflict' : 'coding.saveFailed'); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="coding-page h-[100dvh] overflow-hidden bg-slate-950 text-slate-100 px-3 sm:px-4 pt-14 pb-safe">
    <PageNav />
    <main class="max-w-4xl mx-auto h-full min-h-0 flex flex-col gap-2">
      <header class="shrink-0 flex items-center justify-between gap-3"><h1 class="text-lg font-semibold">{{ t('coding.title') }}</h1><div class="flex items-center gap-2 text-sm text-slate-400"><span>{{ t('coding.appearance') }}</span><ThemeSwitch class="!w-11 !h-11" /></div></header>
                <section id="coding-context" tabindex="0" role="region" :aria-label="t('coding.context')" class="coding-conversation shrink-0 min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 overflow-auto" v-if="target">
            <h2 class="font-semibold mb-4">{{ t('coding.context') }}</h2>
            <article v-for="message in context" :key="message.id" class="w-fit max-w-[90%] p-3 mb-4 rounded-2xl border" :class="[message.id === target.id ? 'border-sky-500 bg-slate-800' : 'border-slate-700 bg-slate-950', !isHumanMessage(message) ? 'mx-auto' : message.senderUid === firstSpeaker ? 'mr-auto rounded-tl-sm' : 'ml-auto rounded-tr-sm']">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2"><span class="text-sm font-medium text-sky-300">{{ message.senderName }}</span><time class="text-xs text-slate-400" :datetime="new Date(message.timestamp).toISOString()">{{ new Date(message.timestamp).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) }}</time></div><p class="whitespace-pre-wrap break-words leading-relaxed">{{ message.content }}</p>
              <img v-if="message.fileData?.type === 'image' && /^(https:\/\/|data:image\/)/.test(message.fileData.url)" :src="message.fileData.url" :alt="message.fileData.name" class="max-w-full rounded-lg mt-3" loading="lazy">
              <p v-if="phase === 2 && message.id === codingCase?.replyId" class="text-sm text-emerald-400 mt-2">{{ t('coding.evaluatedReply') }}</p>
              <p v-if="message.type !== 'text'" class="text-xs text-amber-300 mt-2">{{ t('coding.mediaContext') }}</p>
            </article>
          </section>
      <div id="coding-answer-scroll" class="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 pb-6" tabindex="0" :aria-label="t('coding.answerArea')">
        <p v-if="error" role="alert" class="text-rose-400">{{ error }}</p>
        <p v-if="notice" role="status" class="text-emerald-400">{{ notice }}</p>
        <p v-if="busy" role="status">{{ t('coding.loading') }}</p>
        <p v-if="!busy && !auth.isObserver">{{ t('coding.noAccess') }}</p>
        <template v-if="auth.isObserver">
                  <button v-if="auth.isAdmin" :disabled="busy" class="border border-slate-700 rounded-lg px-3 py-2" @click="toggleManagement">{{ t(management ? 'coding.returnRandom' : 'coding.manageCases') }}</button>

        <p v-if="!management && exhausted" role="status">{{ t('coding.exhausted') }}</p>
        <button v-if="!management && (exhausted || error)" :disabled="busy" class="border border-slate-700 rounded-lg px-3 py-2" @click="reloadQueue">{{ t('coding.reloadQueue') }}</button>
        <div v-if="management" class="grid sm:grid-cols-2 gap-4">
          <label class="space-y-2"><span>{{ t('coding.room') }}</span><select :value="roomId" :disabled="busy" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-lg" @change="chooseRoom"><option value="">{{ t('coding.chooseRoom') }}</option><option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option></select></label>
          <label class="space-y-2"><span>{{ t('coding.cutoff') }}</span><select :value="index" :disabled="busy || !messages.length" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-lg" @change="chooseTarget"><option :value="-1" disabled>{{ t('coding.chooseCutoff') }}</option><option v-for="{ message, i } in cutoffs" :key="message.id" :value="i">{{ i + 1 }}{{ reviewIndex[message.id]?.flagged || reviewIndex[message.id]?.disagreement ? ' · ' + t('coding.needsReview') : '' }}</option></select></label>
        </div>
        <button v-if="management && auth.isAdmin && messages.length" :disabled="busy" class="border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-40" @click="scanRoom">{{ t('coding.scanRoom') }}</button>
        <p v-if="roomId && !busy && !messages.length" class="text-slate-400">{{ t('coding.empty') }}</p>
        <details v-if="target" class="text-sm border border-slate-800 rounded-lg p-3">
          <summary class="cursor-pointer">{{ t('coding.source') }}</summary>
          <dl class="mt-3 space-y-2 break-all">
            <div><dt class="text-slate-400">{{ t('coding.sourceRoom') }}</dt><dd>{{ roomId }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceMessage') }}</dt><dd>{{ target.id }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceTime') }}</dt><dd>{{ new Date(target.timestamp).toLocaleString() }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceContext') }}</dt><dd>{{ answer.source?.contextMessageIds.length }}</dd></div>
          </dl>
        </details>
        <section v-if="management && target && auth.isAdmin" class="border border-slate-700 rounded-xl p-4 space-y-3">
          <p v-if="review">{{ t('coding.reviewCount', { count: review.count }) }} · {{ t(review.disagreement ? 'coding.disagreement' : 'coding.noDisagreement') }} · {{ t(review.flagged ? 'coding.flagged' : 'coding.noFlags') }}</p>
          <template v-if="!codingCase">
            <label class="block">{{ t('coding.pickReply') }}<select v-model="replyId" :disabled="busy" class="block w-full p-2 mt-2 bg-slate-900 border border-slate-700 rounded-lg"><option value="">{{ t('coding.chooseReply') }}</option><option v-for="message in aiReplies" :key="message.id" :value="message.id">{{ messages.indexOf(message) + 1 }}</option></select></label>
            <button :disabled="busy || !replyId || !review?.count" class="rounded-lg px-4 py-2 bg-sky-600 text-white disabled:opacity-40" @click="openPhase2">{{ t('coding.openPhase2') }}</button>
            <p class="text-xs text-slate-400">{{ t('coding.selectionHint') }}</p>
          </template>
        </section>
        <div v-if="management && target" class="flex gap-3">
          <button class="border rounded-lg px-3 py-2" :class="phase === 1 ? 'border-sky-500' : 'border-slate-700'" @click="switchPhase(1)">{{ t('coding.phase1') }}</button>
          <button v-if="codingCase && answer.status === 'submitted'" class="border rounded-lg px-3 py-2" :class="phase === 2 ? 'border-sky-500' : 'border-slate-700'" @click="switchPhase(2)">{{ t('coding.phase2') }}</button>
        </div>

                    <DetailedCoding ref="detailedForm" v-if="phase === 2 && codingCase" id="coding-answer" :key="roomId + target.id + management" :room-id="roomId" :message-id="target.id" :reply-id="codingCase.replyId" :advance="!management" :external-busy="busy" class="min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-5" @dirty="detailedDirty = $event" @submitted="!management && nextQuestion()" />
          <form v-else-if="target" id="coding-answer" class="min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-5 space-y-5" @submit.prevent="save('submitted')">
            <fieldset :disabled="busy" class="space-y-5">
              <legend class="font-semibold mb-4">{{ t('coding.phase1') }}</legend>
              <fieldset v-for="(options, field) in codingOptions" :key="field">
                <legend class="font-medium mb-2">{{ t(key(field)) }}</legend>
                <div class="flex flex-wrap gap-2"><label v-for="option in options" :key="option" class="flex items-center gap-2 border rounded-lg px-3 py-2 cursor-pointer" :class="(Array.isArray(answer[field]) ? answer[field].includes(option) : answer[field] === option) ? 'border-sky-500 bg-sky-600 text-white' : 'border-slate-700'"><input v-model="answer[field]" :type="field === 'discussion' || field === 'action' ? 'checkbox' : 'radio'" :name="field" :value="option">{{ t(key(option)) }}</label></div>
              </fieldset>
              <div class="border-t border-slate-700 pt-4 space-y-3">
                <label class="flex items-center gap-2"><input v-model="answer.ambiguous" type="checkbox">{{ t('coding.ambiguous') }}</label>
                <label class="flex items-center gap-2"><input v-model="answer.important" type="checkbox">{{ t('coding.important') }}</label>
                <label v-if="needsReason" class="block">{{ t('coding.reason') }}<textarea v-model="answer.reason" required maxlength="1000" rows="2" class="block w-full mt-2 p-3 rounded-lg bg-slate-950 border border-slate-700" /></label>
                <p class="text-xs text-slate-400">{{ t('coding.phase2Hint') }}</p>
              </div>
              <div class="flex gap-3"><button type="button" class="px-4 py-2 rounded-lg border border-slate-600" @click="save('draft')">{{ t('coding.saveDraft') }}</button><button type="submit" :disabled="!complete" class="px-4 py-2 rounded-lg bg-sky-600 text-white disabled:opacity-40">{{ t(management ? 'coding.submit' : 'coding.submitNext') }}</button></div>
              <p v-if="dirty" class="text-xs text-amber-300">{{ t('coding.unsaved') }}</p>
            </fieldset>
          </form>

        </template>
      </div>
      <nav v-if="auth.isObserver && !management && history.length" class="shrink-0 flex items-center justify-between gap-2 border-t border-slate-800 bg-slate-950 py-2" :aria-label="t('coding.questionNavigation')">
        <button type="button" :disabled="busy || historyPosition <= 0" class="min-h-11 px-3 rounded-lg border border-slate-700 disabled:opacity-40" @click="navigateQuestion(-1)">{{ t('coding.previousQuestion') }}</button>
        <span class="text-sm text-slate-400">{{ t('coding.questionPosition', { current: Math.min(historyPosition + 1, history.length), total: history.length }) }}</span>
        <button type="button" :disabled="busy || exhausted" class="min-h-11 px-3 rounded-lg border border-slate-700 disabled:opacity-40" @click="navigateQuestion(1)">{{ t('coding.nextQuestion') }}</button>
      </nav>

    </main>
  </div>
</template>

<style scoped>
.coding-conversation { height: clamp(120px, 32dvh, 340px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
@media (max-height: 500px) { .coding-conversation { height: 25dvh; min-height: 70px; } }
.coding-page :deep(input[type='checkbox']),
.coding-page :deep(input[type='radio']) {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
  accent-color: #0284c7;
}
.coding-page :deep(fieldset) { min-width: 0; }
.coding-page :deep(button:focus-visible),
.coding-page :deep(input:focus-visible) { outline: 2px solid #0284c7; outline-offset: 3px; }
@media (max-width: 1023px) {
  .coding-page :deep(button), .coding-page :deep(label:has(input)) { min-height: 48px; }
  .coding-page :deep(button) { min-width: 44px; }
  .coding-page :deep(textarea), .coding-page :deep(select) { font-size: 16px; }
  .coding-page :deep(legend) { line-height: 1.7; }
}
</style>
