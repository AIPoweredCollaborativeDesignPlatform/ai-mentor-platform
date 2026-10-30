import { onUnmounted, ref } from 'vue';

/**
 * Phones (any orientation) and portrait tablets have no room for chat and whiteboard side by side:
 * the meeting room then shows one at a time with Chat / Whiteboard tabs. Landscape tablets and desktops split.
 * Phone landscape is caught by its short height.
 */
const STACKED_QUERY = '(max-width: 767px), (max-height: 500px), (orientation: portrait) and (max-width: 1199px)';

export function useStackedLayout() {
  const mq = window.matchMedia(STACKED_QUERY);
  const isStacked = ref(mq.matches);
  const update = () => (isStacked.value = mq.matches);
  mq.addEventListener('change', update);
  onUnmounted(() => mq.removeEventListener('change', update));
  return isStacked;
}
