import { ref } from 'vue';

/** Day/night theme (P7). Day is the default; the choice is kept in this browser. index.html applies it before the app loads. */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ai-mentor-theme';

const read = (): Theme => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const currentTheme = ref<Theme>(read());

// While switching, every element gets the same colour transition (style.css `html.theme-anim`), overriding
// each component's own transition so the whole page fades together
const SWITCH_MS = 300;
let switchTimer: ReturnType<typeof setTimeout> | undefined;

export function setTheme(theme: Theme) {
  currentTheme.value = theme;
  const root = document.documentElement;
  // A colour fade, not motion, so it also runs under prefers-reduced-motion
  root.classList.add('theme-anim');
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => root.classList.remove('theme-anim'), SWITCH_MS + 50);
  root.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies for this page view
  }
}
