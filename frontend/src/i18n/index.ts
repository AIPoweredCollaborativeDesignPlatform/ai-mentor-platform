import { computed, ref, watch } from 'vue';
import en from './en';
import zhTW from './zh-TW';

/**
 * UI language. Outside rooms the viewer's own choice (LocaleSwitch, saved in this browser) applies;
 * inside a room (and on its join page) the room language set by the experiment profile overrides it,
 * so every participant of a condition sees the same language as the AI and the system messages.
 * Strings live in en.ts (source of keys) and zh-TW.ts (type-checked to have every key).
 */
export type SupportedLocale = 'en' | 'zh-TW';
export const SUPPORTED_LOCALES: SupportedLocale[] = ['zh-TW', 'en'];
const isLocale = (v: unknown): v is SupportedLocale => v === 'en' || v === 'zh-TW';

const stored = localStorage.getItem('ai_mentor_locale');
export const preferredLocale = ref<SupportedLocale>(isLocale(stored) ? stored : 'zh-TW');
const roomLocale = ref<SupportedLocale | null>(null);
export const currentLocale = computed<SupportedLocale>(() => roomLocale.value || preferredLocale.value);
/** True while a room's language is in charge (the switch is hidden then). */
export const isRoomLocale = computed(() => roomLocale.value !== null);
watch(currentLocale, l => document.documentElement.setAttribute('lang', l), { immediate: true });

export const setLocale = (locale: SupportedLocale) => {
  preferredLocale.value = locale;
  localStorage.setItem('ai_mentor_locale', locale);
};

export const setRoomLocale = (locale: string | null | undefined) => {
  roomLocale.value = isLocale(locale) ? locale : locale === null ? null : 'zh-TW';
};

export type MessageKey = keyof typeof en;
const DICTS: Record<SupportedLocale, Record<MessageKey, string>> = { en, 'zh-TW': zhTW };
const warned = new Set<string>();

/** `t('home.create')`, with `{name}` placeholders filled from params. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  let text = DICTS[currentLocale.value][key];
  if (text === undefined) {
    if (!warned.has(key)) console.warn(`[i18n] missing ${currentLocale.value} text: ${key}`);
    warned.add(key);
    text = en[key] ?? key;
  }
  return text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

/** Locale code for Intl / toLocaleString. */
export const intlLocale = () => (currentLocale.value === 'zh-TW' ? 'zh-TW' : 'en-US');
