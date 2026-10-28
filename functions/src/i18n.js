/**
 * Room language (rooms/{id}.language, from the assigned profile): everything the server writes into
 * a room follows it, so replays and exports show exactly what participants saw.
 */

export const LANGUAGES = ['zh-TW', 'en'];
export const DEFAULT_LANGUAGE = 'zh-TW';
export const roomLanguage = lang => (LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE);

/** Profile texts may be a plain string (older profiles) or { 'zh-TW': ..., en: ... }. */
export function localized(value, lang) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[roomLanguage(lang)] || value.en || value['zh-TW'] || '';
}

/** Consent text: system config keeps the English text in consentText and the Chinese in consentTextZh. */
export const consentTextFor = (sys, lang) =>
  (roomLanguage(lang) === 'zh-TW' ? sys.consentTextZh || sys.consentText : sys.consentText) || '';

const STRINGS = {
  sessionEnded: { 'zh-TW': '本次討論已結束。', en: 'This session has ended.' },
  sessionReopened: { 'zh-TW': '本次討論已重新開啟。', en: 'The session has been reopened.' },
  timeUp: { 'zh-TW': '時間到。', en: 'Time is up.' },
  roomCreated: { 'zh-TW': '{emoji} 已建立房間「{name}」· PIN：{pin}', en: '{emoji} Room "{name}" created · PIN: {pin}' },
  system: { 'zh-TW': '系統', en: 'System' }
};

export function str(key, lang, params = {}) {
  const text = STRINGS[key]?.[roomLanguage(lang)] || STRINGS[key]?.en || key;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}
