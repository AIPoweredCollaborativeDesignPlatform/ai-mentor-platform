import { nextTick, onUnmounted, watch, type Ref } from 'vue';
import { logEvent } from '../services/researchLog';

const VISIBLE_RATIO = 0.5;
const MIN_DWELL_MS = 1000;

/**
 * "Read an AI message": at least half of the message is on screen for at least 1s while the tab is
 * visible. Each such stretch is logged once as ai_message_viewed with its dwell time.
 * Elements are found by their data-ai-msg attribute inside the scrolling chat container.
 */
export function useAiReadTracking(container: Ref<HTMLElement | null>, messageCount: () => number) {
  const visibleSince = new Map<string, number>();
  const observed = new WeakSet<Element>();
  let observer: IntersectionObserver | null = null;

  const finish = (id: string) => {
    const since = visibleSince.get(id);
    visibleSince.delete(id);
    if (since && Date.now() - since >= MIN_DWELL_MS) logEvent('ai_message_viewed', { messageId: id, dwellMs: Date.now() - since });
  };

  const ensureObserver = () => {
    if (observer || !container.value) return;
    observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.aiMsg;
        if (!id) continue;
        if (e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO && document.visibilityState === 'visible') {
          if (!visibleSince.has(id)) visibleSince.set(id, Date.now());
        } else {
          finish(id);
        }
      }
    }, { root: container.value, threshold: [0, VISIBLE_RATIO, 1] });
  };

  const observeNew = () => {
    ensureObserver();
    container.value?.querySelectorAll<HTMLElement>('[data-ai-msg]').forEach(el => {
      if (observed.has(el)) return;
      observed.add(el);
      observer!.observe(el);
    });
  };

  // Hidden tab: close every open stretch; visible again: the observer re-reports on the next change
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') [...visibleSince.keys()].forEach(finish);
    else if (observer) {
      observer.disconnect();
      observer = null;
      container.value?.querySelectorAll('[data-ai-msg]').forEach(el => observed.delete(el));
      observeNew();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  watch([messageCount, container], () => nextTick(observeNew), { immediate: true });

  onUnmounted(() => {
    [...visibleSince.keys()].forEach(finish);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
