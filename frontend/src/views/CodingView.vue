<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { Database, FolderSearch, Info, X, ListChecks } from 'lucide-vue-next';
import { navigationStorageKey, restoreNavigation } from '../services/codingNavigation';
import { isCodingQuestionEnabled } from '../services/coding';
import { humanText, humanWindow, type SamplingEvent } from '../services/codingSampling';
import PageNav from '../components/PageNav.vue';
import DetailedCoding from '../components/admin/DetailedCoding.vue';
import { intlLocale, t, type MessageKey } from '../i18n';
import { useAuthStore } from '../stores/auth';
import type { MessageItem } from '../types';
import { prepareSemanticQueue, codingOptions, emptyCoding, loadCoding, saveCoding, loadCodingCase, openCodingCase, reviewCoding, fetchCodingBank, loadDetailed, codingQuestionKey, type CodingCase, type CodingQuestion, type CodingSource, type CodingBankVersion } from '../services/coding';

const auth = useAuthStore();
const bankVersion = ref<CodingBankVersion | null>(null);
let bankQuestions: CodingQuestion[] = [];
const revisionFor = (room: string, id: string) => bankQuestions.find(q => q.roomId === room && q.messages[q.index].id === id)?.revision || '';
const currentRevision = computed(() => target.value ? revisionFor(roomId.value, target.value.id) : '');
const toolsDialog = ref<HTMLDialogElement | null>(null);
const activeTool = ref<'cloud' | 'source'>('cloud');
function openTool(tool: 'cloud' | 'source') {
  activeTool.value = tool;
  toolsDialog.value?.showModal();
}
const conversationHeight = ref(32);
let heightDrag: { pointerId: number; startY: number; startHeight: number; viewport: number } | null = null;
function setConversationHeight(value: number) {
  conversationHeight.value = Math.max(15, Math.min(60, value));
  try { localStorage.setItem('coding-conversation-height', String(conversationHeight.value)); } catch { /* Storage may be unavailable. */ }
}
function startHeightDrag(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const panel = document.getElementById('coding-context');
  const viewport = window.visualViewport?.height || window.innerHeight;
  heightDrag = { pointerId: event.pointerId, startY: event.clientY, startHeight: (panel?.getBoundingClientRect().height || viewport * conversationHeight.value / 100), viewport };
  handle.setPointerCapture(event.pointerId);
  handle.focus();
  event.preventDefault();
}
function moveHeightDrag(event: PointerEvent) {
  if (!heightDrag || heightDrag.pointerId !== event.pointerId) return;
  setConversationHeight((heightDrag.startHeight + event.clientY - heightDrag.startY) / heightDrag.viewport * 100);
}
function stopHeightDrag() { heightDrag = null; }
function resizeWithKeyboard(event: KeyboardEvent) {
  const values: Record<string, number> = { ArrowUp: conversationHeight.value - 2, ArrowDown: conversationHeight.value + 2, Home: 15, End: 60 };
  if (!(event.key in values)) return;
  event.preventDefault();
  setConversationHeight(values[event.key]);
}
const rooms = ref<{ id: string; name: string }[]>([]);
const roomId = ref('');
const messages = ref<MessageItem[]>([]);
const index = ref(-1);
const currentEvents = ref<SamplingEvent[]>([]);
const answer = ref(emptyCoding());
const baseline = ref(JSON.stringify(answer.value));
const busy = ref(true);
const management = ref(false);
const history = ref<{ question: CodingQuestion; phase: number; ordinal: number }[]>([]);
const historyPosition = ref(-1);
const detailedForm = ref<InstanceType<typeof DetailedCoding> | null>(null);
let queue: CodingQuestion[] = [];
let previousVisits: { key: string; at: number }[] = [];
const questionKey = (q: CodingQuestion) => codingQuestionKey(q.roomId, q.messages[q.index].id);
function rememberNavigation() {
  if (!auth.uid || management.value) return;
  try { localStorage.setItem(navigationStorageKey(auth.uid, bankVersion.value?.id), JSON.stringify({ version: 1,
    history: history.value.map(e => ({ key: questionKey(e.question), phase: e.phase, ordinal: e.ordinal })),
    position: historyPosition.value, queue: queue.map(questionKey) })); } catch { /* Private browsing may disable storage. */ }
}
async function resumeNavigation() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(navigationStorageKey(auth.uid!, bankVersion.value?.id));
    // The initial snapshot uses the same legacy rating scopes and can retain the existing visit order.
    if (!raw && bankVersion.value && !bankVersion.value.parentVersion && !bankVersion.value.resetAnswers) raw = localStorage.getItem(navigationStorageKey(auth.uid!));
  } catch { /* Start a new session. */ }
  const restored = restoreNavigation(raw, queue.map(questionKey));
  if (!restored) {
    // Upgrade from versions without local navigation, or recover on another browser.
    const bank = new Map(queue.map(q => [questionKey(q), q]));
    history.value = previousVisits.filter(v => bank.has(v.key)).map((v, i) => ({ question: bank.get(v.key)!, phase: 1, ordinal: i + 1 }));
    historyPosition.value = history.value.length - 1;
    await nextQuestion(); return;
  }
  const bank = new Map(queue.map(q => [questionKey(q), q]));
  history.value = restored.history.map(e => ({ question: bank.get(e.key)!, phase: e.phase, ordinal: e.ordinal }));
  queue = restored.queue.map(k => bank.get(k)!);
  // A previously visited first-stage question may have been selected for stage two later.
  for (const [key, q] of bank) if (selectedDetailed.value.has(key) && !completedDetailed.value.has(key)
    && !restored.history.some(e => e.key === key && e.phase === 2) && !restored.queue.includes(key)) queue.unshift(q);
  historyPosition.value = restored.position;
  if (restored.position >= 0 && restored.position < history.value.length) await loadHistory(restored.position);
  else await nextQuestion();
}
const cloudQuestionCount = ref(0);
const cloudRoomCount = ref(0);
const cloudSyncedAt = ref(0);
const completedQuestions = ref(new Set<string>());
const completedDetailed = ref(new Set<string>());
const selectedDetailed = ref(new Set<string>());
const detailedValid = ref(false);
const exhausted = ref(false);
const error = ref('');
const notice = ref('');
const phase = ref(1);
const detailedDirty = ref(false);
const codingCase = ref<CodingCase | null>(null);
const review = ref<Awaited<ReturnType<typeof reviewCoding>> | null>(null);
const replyId = ref('');
const reviewIndex = ref<Record<string, Awaited<ReturnType<typeof reviewCoding>>>>({});
const cutoffs = computed(() => messages.value.map((message, i) => ({ message, i })).filter(({ message }) => humanText(message)));
const aiReplies = computed(() => messages.value.slice(index.value + 1).filter(m => m.senderUid === 'ai_mentor' || m.senderUid === 'ai_mentor_3d'));
const reply = computed(() => messages.value.find(m => m.id === codingCase.value?.replyId));
const dirty = computed(() => JSON.stringify(answer.value) !== baseline.value);
const target = computed(() => messages.value[index.value]);
const context = computed(() => {
  if (!target.value) return [];
  const window = humanWindow(messages.value, target.value.id);
  // Stage two evaluates only the selected AI response, not all intervening AI messages.
  return phase.value === 2 && reply.value ? [...window, reply.value].sort((a, b) => a.timestamp - b.timestamp) : window;
});
const firstSpeaker = computed(() => context.value.find(message => humanText(message))?.senderUid);
const isHumanMessage = (message: MessageItem) => humanText(message);
const needsReason = computed(() => answer.value.ambiguous || answer.value.important);
const complete = computed(() => !!answer.value.thinking && !!answer.value.necessity && answer.value.discussion.length > 0 && answer.value.action.length > 0 && (!needsReason.value || !!answer.value.reason.trim()));
const progressTotal = computed(() => phase.value === 1 ? cloudQuestionCount.value : selectedDetailed.value.size);
const progressCompleted = computed(() => phase.value === 1 ? completedQuestions.value.size : completedDetailed.value.size);
const progressOrdinal = computed(() => exhausted.value ? progressTotal.value : Math.min(progressTotal.value, history.value[historyPosition.value]?.ordinal || 1));
const canAdvance = computed(() => phase.value === 1 ? complete.value : detailedValid.value);
function markProgress(stage: number, status: 'draft' | 'submitted') {
  if (!target.value) return;
  const key = codingQuestionKey(roomId.value, target.value.id);
  const completed = stage === 1 ? completedQuestions.value : completedDetailed.value;
  if (status === 'submitted') completed.add(key);
  else completed.delete(key);
}
function chooseOption(field: keyof typeof codingOptions, option: string, event: Event) {
  if (field === 'thinking' || field === 'necessity') {
    answer.value[field] = option;
    return;
  }
  const checked = (event.target as HTMLInputElement).checked;
  const previous = answer.value[field];
  answer.value[field] = !checked ? previous.filter(value => value !== option)
    : option === 'cannotJudge' ? [option]
    : [...previous.filter(value => value !== 'cannotJudge' && value !== option), option];
}
const key = (value: string) => `coding.${value}` as MessageKey;
const canLeave = () => !(dirty.value || detailedDirty.value) || window.confirm(t('coding.discard'));
const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.value || detailedDirty.value) { event.preventDefault(); event.returnValue = ''; } };
onBeforeRouteLeave(canLeave);
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  try {
    const savedHeight = Number(localStorage.getItem('coding-conversation-height'));
    if (savedHeight >= 15 && savedHeight <= 60) conversationHeight.value = savedHeight;
  } catch { /* Use the default height when storage is unavailable. */ }
  try {
    await auth.waitForAuthReady();
    await auth.waitForRole();
    if (auth.isObserver) {
      await syncCloudQueue();
      await resumeNavigation();
    }
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
async function syncCloudQueue() {
  const { rooms: cloudRooms, queue: cloudQueue, progress, previousVisits: visits, allQuestions, version } = await fetchCodingBank(bankVersion.value?.id);
  bankVersion.value = version; bankQuestions = allQuestions;
  previousVisits = visits;
  rooms.value = cloudRooms; queue = cloudQueue;
  completedQuestions.value = new Set(progress.completed);
  completedDetailed.value = new Set(progress.detailedCompleted);
  selectedDetailed.value = new Set(progress.selected);
  cloudQuestionCount.value = cloudQueue.length;
  cloudRoomCount.value = new Set(cloudQueue.map(question => question.roomId)).size;
  cloudSyncedAt.value = Date.now();
}
async function prepareSemanticEvents() {
  busy.value = true; error.value = ''; notice.value = t('coding.semanticPreparing');
  try { await prepareSemanticQueue(rooms.value); await syncCloudQueue(); notice.value = t('coding.semanticReady'); }
  catch { error.value = t('coding.semanticFailed'); }
  finally { busy.value = false; }
}
function sourceForQuestion(method: CodingSource['samplingMethod']): CodingSource {
  return { bankVersion: bankVersion.value?.id || '', roomId: roomId.value, messageId: target.value!.id, messageTimestamp: target.value!.timestamp,
    contextMessageIds: humanWindow(messages.value, target.value!.id).map(message => message.id),
    contextPolicy: 'human-before-after-5-v1', events: currentEvents.value,
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
      const progressKey = codingQuestionKey(question.roomId, id);
      if (completedQuestions.value.has(progressKey) && (!selectedDetailed.value.has(progressKey) || completedDetailed.value.has(progressKey))) {
        queue.pop(); continue;
      }
      const [nextAnswer, nextCase, enabled] = await Promise.all([
        loadCoding(question.roomId, id, auth.uid!, question.revision), loadCodingCase(question.roomId, id, question.revision), isCodingQuestionEnabled(question.roomId, id),
      ]);
      if (!enabled) { queue.pop(); continue; }
      let nextPhase = 1;
      if (nextAnswer.status === 'submitted') {
        if (!nextCase || (await loadDetailed(question.roomId, id, auth.uid!, nextCase.replyId, question.revision)).status === 'submitted') {
          queue.pop(); continue;
        }
        // A previously submitted question can return only for its selected second-stage review.
        nextPhase = 2;
      }
      queue.pop();
      roomId.value = question.roomId; messages.value = question.messages; index.value = question.index; currentEvents.value = question.events || [];
      answer.value = { ...nextAnswer, source: nextAnswer.source || sourceForQuestion('event-round-robin-v2') };
      baseline.value = JSON.stringify(answer.value); codingCase.value = nextCase;
      phase.value = nextPhase; detailedDirty.value = false; review.value = null;
      detailedValid.value = false;
      history.value.push({ question, phase: nextPhase, ordinal: Math.min(progressTotal.value, progressCompleted.value + 1) });
      historyPosition.value = history.value.length - 1;
      rememberNavigation();
      await resetQuestionScroll();
      return;
    }
    index.value = -1; messages.value = []; roomId.value = ''; answer.value = emptyCoding();
    baseline.value = JSON.stringify(answer.value); detailedDirty.value = false; exhausted.value = true;
    historyPosition.value = history.value.length;
    rememberNavigation();
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function resetQuestionScroll() {
  await nextTick();
  const conversation = document.getElementById('coding-context');
  if (conversation) { const anchor = conversation.querySelector<HTMLElement>('[data-coding-target="true"]'); conversation.scrollTop = anchor ? anchor.offsetTop - conversation.offsetTop : 0; }
  document.getElementById('coding-answer-scroll')?.scrollTo({ top: 0 });
}
async function loadHistory(position: number) {
  const entry = history.value[position];
  const question = entry.question;
  const id = question.messages[question.index].id;
  const [stored, selectedCase] = await Promise.all([
    loadCoding(question.roomId, id, auth.uid!, question.revision), loadCodingCase(question.roomId, id, question.revision),
  ]);
  roomId.value = question.roomId; messages.value = question.messages; index.value = question.index; currentEvents.value = question.events || [];
  answer.value = { ...stored, source: stored.source || sourceForQuestion('event-round-robin-v2') };
  baseline.value = JSON.stringify(answer.value); codingCase.value = selectedCase;
  phase.value = entry.phase === 2 && selectedCase && stored.status === 'submitted' ? 2 : 1;
  entry.phase = phase.value; detailedDirty.value = false; exhausted.value = false;
  detailedValid.value = false;
  historyPosition.value = position; notice.value = '';
  rememberNavigation();
  await resetQuestionScroll();
}
async function navigateQuestion(direction: -1 | 1) {
  if (busy.value) return;
  if (direction === 1) {
    if (exhausted.value || !canAdvance.value) return;
    if (phase.value === 1) { await save('submitted'); return; }
    busy.value = true; error.value = '';
    try {
      if (await detailedForm.value?.submit()) await nextQuestion();
    } catch { error.value = t('coding.saveFailed'); }
    finally { busy.value = false; }
    return;
  }
  busy.value = true; error.value = '';
  try {
    if (phase.value === 2 && detailedDirty.value && detailedForm.value) {
      if (!await detailedForm.value.persist()) return;
    } else if (target.value && dirty.value) {
      const status = answer.value.status === 'submitted' && complete.value ? 'submitted' : 'draft';
      answer.value = await saveCoding(roomId.value, target.value.id, auth.uid!, { ...answer.value, status, viewContext: { policy: 'human-before-after-5-v1', bankVersion: bankVersion.value?.id || '', messageIds: context.value.filter(humanText).map(m => m.id) } }, currentRevision.value);
      baseline.value = JSON.stringify(answer.value);
      markProgress(1, status);
    }
    if (direction === -1 && historyPosition.value > 0) await loadHistory(historyPosition.value - 1);
  } catch (e) { error.value = t(e instanceof Error && e.message === 'coding-conflict' ? 'coding.conflict' : 'coding.saveFailed'); }
  finally { busy.value = false; }
}
async function reloadQueue() {
  busy.value = true; error.value = '';
  try {
    await syncCloudQueue();
    if (!target.value) await nextQuestion();
  } catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function toggleManagement() {
  if (!canLeave()) return;
  baseline.value = JSON.stringify(answer.value); detailedDirty.value = false;
  management.value = !management.value;
  if (!management.value) {
    busy.value = true;
    try {
      await syncCloudQueue();
      if (historyPosition.value >= 0 && historyPosition.value < history.value.length) await loadHistory(historyPosition.value);
      else await nextQuestion();
    } catch { error.value = t('coding.loadFailed'); }
    finally { busy.value = false; }
  }
  else if (target.value) {
    busy.value = true;
    try {
      const storedAnswer = await loadCoding(roomId.value, target.value.id, auth.uid!, currentRevision.value);
      answer.value = { ...storedAnswer, source: storedAnswer.source || { ...sourceForQuestion('researcher-selection'), events: [] } };
      baseline.value = JSON.stringify(answer.value);
      review.value = await reviewCoding(roomId.value, target.value.id, currentRevision.value); replyId.value = aiReplies.value[0]?.id || '';
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
  try { if (roomId.value) messages.value = bankQuestions.find(q => q.roomId === roomId.value)?.messages || []; }
  catch { error.value = t('coding.loadFailed'); }
  finally { busy.value = false; }
}
async function scanRoom() {
  busy.value = true; error.value = '';
  try {
    // Bound the read concurrency for long conversations.
    for (let start = 0; start < cutoffs.value.length; start += 5) {
      await Promise.all(cutoffs.value.slice(start, start + 5).map(async ({ message }) => {
        reviewIndex.value[message.id] = await reviewCoding(roomId.value, message.id, revisionFor(roomId.value, message.id));
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
      loadCoding(roomId.value, id, auth.uid!, revisionFor(roomId.value, id)), loadCodingCase(roomId.value, id, revisionFor(roomId.value, id)),
      auth.isAdmin ? reviewCoding(roomId.value, id, revisionFor(roomId.value, id)) : Promise.resolve(null),
    ]);
    index.value = nextIndex;
    answer.value = { ...nextAnswer, source: nextAnswer.source || { ...sourceForQuestion('researcher-selection'), events: [] } };
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
    await openCodingCase(roomId.value, target.value.id, replyId.value, auth.uid, currentRevision.value);
    codingCase.value = await loadCodingCase(roomId.value, target.value.id, currentRevision.value);
    selectedDetailed.value.add(codingQuestionKey(roomId.value, target.value.id));
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
    answer.value = await saveCoding(roomId.value, target.value.id, auth.uid, { ...answer.value, status, viewContext: { policy: 'human-before-after-5-v1', bankVersion: bankVersion.value?.id || '', messageIds: context.value.filter(humanText).map(m => m.id) } }, currentRevision.value);
    markProgress(1, status);
    baseline.value = JSON.stringify(answer.value); notice.value = t(status === 'draft' ? 'coding.draftSaved' : 'coding.submitted');
    if (!management.value && status === 'submitted') {
      if (codingCase.value) queue.unshift({ roomId: roomId.value, messages: messages.value, index: index.value, revision: currentRevision.value });
      await nextQuestion();
    }
    else if (auth.isAdmin) review.value = await reviewCoding(roomId.value, target.value.id, currentRevision.value);
  } catch (e) { error.value = t(e instanceof Error && e.message === 'coding-conflict' ? 'coding.conflict' : 'coding.saveFailed'); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="coding-page h-[100dvh] overflow-hidden bg-slate-950 text-slate-100 pl-3 pr-16 sm:pl-4 sm:pr-20 pt-14 pb-safe">
    <PageNav />
    <aside v-if="auth.isObserver" class="coding-tools fixed right-1 sm:right-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950 p-1 text-slate-400" :aria-label="t('coding.tools')">
      <router-link v-if="auth.isAdmin" to="/admin/coding-bank" class="w-10 h-11 flex items-center justify-center rounded-lg hover:bg-slate-800 hover:text-slate-100" :title="t('coding.bankTitle')" :aria-label="t('coding.bankTitle')"><ListChecks class="w-4 h-4" /></router-link>
      <button type="button" class="w-10 h-11 flex items-center justify-center rounded-lg hover:bg-slate-800 hover:text-slate-100" :title="t('coding.cloudTools')" :aria-label="t('coding.cloudTools')" @click="openTool('cloud')"><Database class="w-4 h-4" /></button>
      <button v-if="auth.isAdmin" type="button" :disabled="busy" class="w-10 h-11 flex items-center justify-center rounded-lg hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40" :class="management ? 'text-sky-400 bg-slate-800' : ''" :title="t(management ? 'coding.returnRandom' : 'coding.manageCases')" :aria-label="t(management ? 'coding.returnRandom' : 'coding.manageCases')" @click="toggleManagement"><FolderSearch class="w-4 h-4" /></button>
      <button v-if="target" type="button" class="w-10 h-11 flex items-center justify-center rounded-lg hover:bg-slate-800 hover:text-slate-100" :title="t('coding.source')" :aria-label="t('coding.source')" @click="openTool('source')"><Info class="w-4 h-4" /></button>
    </aside>
    <dialog ref="toolsDialog" class="coding-tools-dialog fixed ml-auto mr-2 sm:mr-4 my-auto w-[min(24rem,calc(100vw-1rem))] max-h-[80dvh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 text-slate-100 p-4" aria-labelledby="coding-tools-title" @click="($event.target === toolsDialog) && toolsDialog?.close()">
      <header class="flex items-center justify-between gap-3 mb-4"><h2 id="coding-tools-title" class="font-semibold">{{ t(activeTool === 'cloud' ? 'coding.cloudTools' : 'coding.source') }}</h2><button type="button" class="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-slate-800" :aria-label="t('coding.closeTools')" @click="toolsDialog?.close()"><X class="w-4 h-4" /></button></header>
          <section v-if="activeTool === 'cloud'" class="rounded-lg border border-slate-800 p-3 text-sm space-y-2">
            <p v-if="cloudSyncedAt">{{ t('coding.cloudBank', { rooms: cloudRoomCount, questions: cloudQuestionCount }) }}</p>
            <p v-if="cloudSyncedAt" class="text-xs text-slate-400">{{ t('coding.cloudSynced', { time: new Date(cloudSyncedAt).toLocaleTimeString(intlLocale()) }) }}</p>
            <p class="text-xs text-slate-400">{{ t(bankVersion ? 'coding.fixedBankHint' : 'coding.cloudSampling') }}</p>
            <button type="button" :disabled="busy" class="rounded-lg border border-slate-700 px-3 py-2 disabled:opacity-40" @click="reloadQueue">{{ t(bankVersion ? 'coding.syncBankProgress' : 'coding.syncCloud') }}</button>
            <button v-if="auth.isAdmin && !bankVersion" type="button" :disabled="busy" class="rounded-lg border border-slate-700 px-3 py-2 disabled:opacity-40" @click="prepareSemanticEvents">{{ t('coding.prepareSemantic') }}</button>
            <p v-if="!bankVersion" class="text-xs text-slate-400">{{ t('coding.semanticHint') }}</p>
          </section>
        <section v-if="activeTool === 'source' && target" class="text-sm border border-slate-800 rounded-lg p-3">

          <dl class="mt-3 space-y-2 break-all"><div><dt>{{ t('coding.eventSources') }}</dt><dd v-for="event in answer.source?.events" :key="event.kind + event.ref">{{ t(key('event_' + event.kind)) }} · {{ event.ref }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceRoom') }}</dt><dd>{{ roomId }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceMessage') }}</dt><dd>{{ target.id }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceTime') }}</dt><dd>{{ new Date(target.timestamp).toLocaleString() }}</dd></div>
            <div><dt class="text-slate-400">{{ t('coding.sourceContext') }}</dt><dd>{{ answer.source?.contextMessageIds.length }}</dd></div>
          </dl>
        </section>
    </dialog>
    <main class="coding-main max-w-4xl mx-auto h-full min-h-0 flex flex-col gap-2">
      <header class="shrink-0"><h1 class="text-lg font-semibold">{{ t('coding.title') }}</h1><p class="text-xs text-slate-400">{{ bankVersion ? t('coding.bankVersionLabel', { version: bankVersion.sequence }) : t('coding.liveBank') }}</p></header>
      <div class="coding-workspace flex-1 min-h-0 min-w-0 flex flex-col gap-2" :class="{ 'has-conversation': target }">
                <section id="coding-context" :style="{ height: conversationHeight + 'dvh' }" tabindex="0" role="region" :aria-label="t('coding.context')" class="coding-conversation shrink-0 min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 overflow-auto" v-if="target">
            <h2 class="font-semibold mb-2">{{ t('coding.context') }}</h2><p class="text-xs text-slate-400 mb-4">{{ t('coding.windowHint') }}</p>
            <article :data-coding-target="message.id === target.id" v-for="message in context" :key="message.id" class="w-fit max-w-[90%] p-3 mb-4 rounded-2xl border" :class="[message.id === target.id ? 'border-sky-500 bg-slate-800' : 'border-slate-700 bg-slate-950', !isHumanMessage(message) ? 'mx-auto' : message.senderUid === firstSpeaker ? 'mr-auto rounded-tl-sm' : 'ml-auto rounded-tr-sm']">
              <p v-if="message.id === target.id" class="text-xs text-sky-400 mb-2">{{ t('coding.targetMessage') }}</p>
              <p v-else-if="isHumanMessage(message) && messages.indexOf(message) > index" class="text-xs text-amber-400 mb-2">{{ t('coding.afterTarget') }}</p>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2"><span class="text-sm font-medium text-sky-300">{{ message.senderName }}</span><time class="text-xs text-slate-400" :datetime="new Date(message.timestamp).toISOString()">{{ new Date(message.timestamp).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) }}</time></div><p class="whitespace-pre-wrap break-words leading-relaxed">{{ message.content }}</p>
              <img v-if="message.fileData?.type === 'image' && /^(https:\/\/|data:image\/)/.test(message.fileData.url)" :src="message.fileData.url" :alt="message.fileData.name" class="max-w-full rounded-lg mt-3" loading="lazy">
              <p v-if="phase === 2 && message.id === codingCase?.replyId" class="text-sm text-emerald-400 mt-2">{{ t('coding.evaluatedReply') }}</p>
              <p v-if="message.type !== 'text'" class="text-xs text-amber-300 mt-2">{{ t('coding.mediaContext') }}</p>
            </article>
          </section>
      <div v-if="target" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="coding-context" :aria-label="t('coding.conversationHeight')" :title="t('coding.dragHeight')" :aria-valuenow="Math.round(conversationHeight)" :aria-valuemin="15" :aria-valuemax="60" class="coding-resize-handle shrink-0 self-center flex items-center justify-center gap-1.5 text-slate-400 hover:text-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500" @pointerdown="startHeightDrag" @pointermove="moveHeightDrag" @pointerup="stopHeightDrag" @pointercancel="stopHeightDrag" @lostpointercapture="stopHeightDrag" @keydown="resizeWithKeyboard">
        <span v-for="dot in 3" :key="dot" aria-hidden="true" class="w-1 h-1 rounded-full bg-current" />
      </div>
      <div id="coding-answer-scroll" class="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain space-y-3 pb-6" tabindex="0" :aria-label="t('coding.answerArea')">
        <p v-if="error" role="alert" class="text-rose-400">{{ error }}</p>
        <p v-if="notice" role="status" class="text-emerald-400">{{ notice }}</p>
        <p v-if="busy" role="status">{{ t('coding.loading') }}</p>
        <p v-if="!busy && !auth.isObserver">{{ t('coding.noAccess') }}</p>
        <template v-if="auth.isObserver">
        <p v-if="!management && exhausted" role="status">{{ t('coding.exhausted') }}</p>
        <div v-if="management" class="grid sm:grid-cols-2 gap-4">
          <label class="space-y-2"><span>{{ t('coding.room') }}</span><select :value="roomId" :disabled="busy" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-lg" @change="chooseRoom"><option value="">{{ t('coding.chooseRoom') }}</option><option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option></select></label>
          <label class="space-y-2"><span>{{ t('coding.cutoff') }}</span><select :value="index" :disabled="busy || !messages.length" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-lg" @change="chooseTarget"><option :value="-1" disabled>{{ t('coding.chooseCutoff') }}</option><option v-for="{ message, i } in cutoffs" :key="message.id" :value="i">{{ i + 1 }}{{ reviewIndex[message.id]?.flagged || reviewIndex[message.id]?.disagreement ? ' · ' + t('coding.needsReview') : '' }}</option></select></label>
        </div>
        <button v-if="management && auth.isAdmin && messages.length" :disabled="busy" class="border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-40" @click="scanRoom">{{ t('coding.scanRoom') }}</button>
        <p v-if="roomId && !busy && !messages.length" class="text-slate-400">{{ t('coding.empty') }}</p>
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

                    <DetailedCoding ref="detailedForm" v-if="phase === 2 && codingCase" id="coding-answer" :key="roomId + target.id + management" :room-id="roomId" :message-id="target.id" :reply-id="codingCase.replyId" :rating-revision="currentRevision" :bank-version="bankVersion?.id" :advance="!management" :external-busy="busy" class="min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-5" @dirty="detailedDirty = $event" @valid="detailedValid = $event" @saved="markProgress(2, $event)" @submitted="!management && nextQuestion()" />
          <form v-else-if="target" id="coding-answer" class="min-w-0 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-5 space-y-5" @submit.prevent="save('submitted')">
            <fieldset :disabled="busy" class="space-y-5">
              <legend class="font-semibold mb-4">{{ t('coding.phase1') }}</legend>
              <fieldset v-for="(options, field) in codingOptions" :key="field">
                <legend class="font-medium mb-2">{{ t(key(field)) }}</legend>
                <div class="flex flex-wrap gap-2"><label v-for="option in options" :key="option" class="flex items-center gap-2 border rounded-lg px-3 py-2 cursor-pointer" :class="(Array.isArray(answer[field]) ? answer[field].includes(option) : answer[field] === option) ? 'border-sky-500 bg-sky-600 text-white' : 'border-slate-700'"><input :checked="Array.isArray(answer[field]) ? answer[field].includes(option) : answer[field] === option" @change="chooseOption(field, option, $event)" :type="field === 'discussion' || field === 'action' ? 'checkbox' : 'radio'" :name="field" :value="option">{{ t(key(option)) }}</label></div>
              </fieldset>
              <div class="border-t border-slate-700 pt-4 space-y-3">
                <label class="flex items-center gap-2"><input v-model="answer.ambiguous" type="checkbox">{{ t('coding.ambiguous') }}</label>
                <label class="flex items-center gap-2"><input v-model="answer.important" type="checkbox">{{ t('coding.important') }}</label>
                <label v-if="needsReason" class="block">{{ t('coding.reason') }}<textarea v-model="answer.reason" required maxlength="1000" rows="2" class="block w-full mt-2 p-3 rounded-lg bg-slate-950 border border-slate-700" /></label>
                <p class="text-xs text-slate-400">{{ t('coding.phase2Hint') }}</p>
              </div>
              <div class="flex gap-3"><button type="button" class="px-4 py-2 rounded-lg border border-slate-600" @click="save('draft')">{{ t('coding.saveDraft') }}</button><button type="submit" :disabled="!complete" class="px-4 py-2 rounded-lg bg-sky-600 text-white disabled:opacity-40">{{ t(management ? 'coding.submit' : 'coding.submitNext') }}</button></div>
              <p v-if="dirty" class="text-xs text-amber-300">{{ t('coding.unsaved') }}</p>
              <p v-if="!complete" class="text-sm text-slate-400">{{ t('coding.requiredBeforeNext') }}</p>
            </fieldset>
          </form>

        </template>
      </div>
      </div>
      <nav v-if="auth.isObserver && !management && history.length" class="shrink-0 flex items-center justify-between gap-2 border-t border-slate-800 bg-slate-950 py-2" :aria-label="t('coding.questionNavigation')">
        <button type="button" :disabled="busy || historyPosition <= 0" class="min-h-11 px-3 rounded-lg border border-slate-700 disabled:opacity-40" @click="navigateQuestion(-1)">{{ t('coding.previousQuestion') }}</button>
        <div class="min-w-0 flex-1 text-center space-y-1">
          <p class="text-sm">{{ t('coding.questionPosition', { current: progressOrdinal, total: progressTotal }) }}</p>
          <p class="text-xs text-slate-400">{{ t('coding.completedProgress', { stage: phase, completed: progressCompleted, total: progressTotal }) }}</p>
          <progress class="block w-full h-1.5 accent-sky-500" :value="progressCompleted" :max="Math.max(progressTotal, 1)" :aria-label="t('coding.progressLabel')" />
        </div>
        <button type="button" :disabled="busy || exhausted || !canAdvance" class="min-h-11 px-3 rounded-lg border border-slate-700 disabled:opacity-40" @click="navigateQuestion(1)">{{ t('coding.nextQuestion') }}</button>
      </nav>

    </main>
  </div>
</template>

<style scoped>
.coding-resize-handle { width: 72px; height: 16px; margin-block: -4px; touch-action: none; user-select: none; cursor: ns-resize; }
@media (pointer: coarse) { .coding-resize-handle { height: 24px; } }
.coding-tools-dialog::backdrop { background: rgb(15 23 42 / 25%); }
.coding-conversation { min-height: 70px; max-height: calc(100dvh - 260px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }

@media (min-width: 1024px) {
  .coding-main { max-width: 1600px; }
  .coding-workspace.has-conversation { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 16px; }
  .coding-workspace .coding-conversation { height: 100% !important; min-height: 0; max-height: none; }
  .coding-workspace .coding-resize-handle { display: none; }
}
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
