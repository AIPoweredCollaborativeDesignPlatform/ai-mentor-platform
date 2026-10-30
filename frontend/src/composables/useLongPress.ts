import { ref } from 'vue';

/** The chat message whose reaction / reply toolbar is open on a touch screen (one at a time). */
export const touchToolbarMsgId = ref<string | null>(null);

// Any tap outside an open toolbar closes it
document.addEventListener('pointerdown', e => {
  if (touchToolbarMsgId.value && !(e.target as Element | null)?.closest?.('[data-touch-toolbar]')) touchToolbarMsgId.value = null;
}, true);

const PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

/**
 * Touch screens have no hover, so a long press (finger only; mouse and pen keep hover) calls `onPress`.
 * Moving the finger (scrolling) cancels it. Bind with `v-on="useLongPress(...)"`.
 */
export function useLongPress(onPress: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start = { x: 0, y: 0 };
  const cancel = () => clearTimeout(timer);

  return {
    pointerdown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      start = { x: e.clientX, y: e.clientY };
      cancel();
      timer = setTimeout(() => {
        navigator.vibrate?.(10);
        onPress();
      }, PRESS_MS);
    },
    pointermove: (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) cancel();
    },
    pointerup: cancel,
    pointercancel: cancel
  };
}
