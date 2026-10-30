import { onUnmounted, ref } from 'vue';

/**
 * Phones (any orientation) and portrait tablets have no room for chat and whiteboard side by side:
 * the meeting room then shows one at a time with Chat / Whiteboard tabs. Landscape tablets and desktops split.
 * Orientation and phone size come from the screen, not the viewport: an on-screen keyboard shortens the
 * viewport (a portrait tablet would look landscape) and must not switch the layout while typing.
 */
const stacked = () => {
  const sw = window.screen.width;
  const sh = window.screen.height;
  const portrait = window.screen.orientation ? window.screen.orientation.type.startsWith('portrait') : sh >= sw;
  const isPhone = Math.min(sw, sh) < 500;
  return window.innerWidth < 768 || isPhone || (portrait && window.innerWidth < 1200);
};

export function useStackedLayout() {
  const isStacked = ref(stacked());
  const update = () => (isStacked.value = stacked());
  window.addEventListener('resize', update);
  window.screen.orientation?.addEventListener('change', update);
  onUnmounted(() => {
    window.removeEventListener('resize', update);
    window.screen.orientation?.removeEventListener('change', update);
  });
  return isStacked;
}
