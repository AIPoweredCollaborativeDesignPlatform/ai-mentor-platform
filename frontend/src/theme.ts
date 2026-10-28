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

export function setTheme(theme: Theme) {
  currentTheme.value = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies for this page view
  }
}
