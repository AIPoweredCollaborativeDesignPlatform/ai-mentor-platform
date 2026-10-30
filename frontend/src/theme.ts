import { nextTick, ref } from 'vue';

/** Day/night theme (P7). Day is the default; the choice is kept in this browser. index.html applies it before the app loads. */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ai-mentor-theme';
const DARK_BG = '#1c1c1c'; // --c-n-950 in dark mode (style.css)

const read = (): Theme => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const currentTheme = ref<Theme>(read());

// Always the latest choice, so a late callback from an earlier (skipped) switch cannot undo a newer one
let target: Theme = currentTheme.value;
// Mobile browser chrome (status bar / address bar) takes the page background colour
const syncThemeColor = (theme: Theme) => {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? DARK_BG : '#ffffff');
};
syncThemeColor(currentTheme.value);

const apply = async () => {
  currentTheme.value = target;
  document.documentElement.dataset.theme = target;
  syncThemeColor(target);
  await nextTick(); // let Vue redraw theme-dependent bits (the toggle icon) before the new snapshot
};

export function setTheme(theme: Theme) {
  // The whole page cross-fades as one picture (style.css ::view-transition), so text, icons and
  // backgrounds can never fade at different speeds. Browsers without view transitions switch at once.
  // Components' own colour transitions are switched off meanwhile, so nothing fades on its own.
  // If the browser never paints a frame (background or throttled tab), the switch is applied directly.
  type ViewTransition = { finished: Promise<void>; ready: Promise<void>; skipTransition: () => void };
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => ViewTransition };
  const root = document.documentElement;
  target = theme;
  root.classList.add('theme-switching');
  const done = () => root.classList.remove('theme-switching');
  if (doc.startViewTransition) {
    const vt = doc.startViewTransition(apply);
    vt.ready.catch(() => {}); // rejects when the transition is skipped; the theme is applied anyway
    const guard = setTimeout(() => {
      vt.skipTransition();
      apply();
      done();
    }, 800);
    vt.finished.finally(() => {
      clearTimeout(guard);
      done();
    });
  } else {
    apply().then(() => requestAnimationFrame(done));
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies for this page view
  }
}
