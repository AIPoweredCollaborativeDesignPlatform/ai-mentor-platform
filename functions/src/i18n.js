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
  system: { 'zh-TW': '系統', en: 'System' },
  refinedMessage: { 'zh-TW': '已為「{title}」加上彩色 PBR 材質與細節。', en: 'Refined "{title}" with color PBR textures and details.' },
  profileUpdated: { 'zh-TW': '{old} 已將名稱改為 {name} {avatar}', en: '{old} updated profile to {name} {avatar}' },
  aiRenamed: { 'zh-TW': 'AI 依討論方向把房間名稱改為「{name}」', en: 'The AI renamed the room to "{name}" after your design direction' },
  renameReverted: { 'zh-TW': '房間名稱已改回「{name}」', en: 'Room name changed back to "{name}"' },
  detailsUpdated: { 'zh-TW': '房間資訊已更新為 {emoji} {name}', en: 'Room details updated to {emoji} {name}' },
  aiAsset: { 'zh-TW': 'AI 產生了新素材', en: 'AI Asset Generated' },
  aiErrorPrefix: { 'zh-TW': '⚠️ {name}：{message}', en: '⚠️ {name}: {message}' },
  'aiError.KEY_INVALID': { 'zh-TW': 'AI 服務金鑰設定有誤，請聯絡研究人員。', en: 'The AI service key is not configured correctly. Please contact the study administrator.' },
  'aiError.QUOTA_EXCEEDED': { 'zh-TW': 'AI 服務目前流量受限，請稍後再試。', en: 'The AI service is rate-limited right now. Please retry in a moment.' },
  'aiError.HIGH_DEMAND': { 'zh-TW': 'AI 服務目前使用量過高，請再試一次。', en: 'The AI service is overloaded right now (high demand). Please retry.' },
  'aiError.NETWORK': { 'zh-TW': '無法連線到 AI 服務，請再試一次。', en: 'Could not reach the AI service. Please retry.' },
  'aiError.BAD_REQUEST': { 'zh-TW': 'AI 請求被拒絕，請再試一次或換個說法。', en: 'The AI request was rejected. Please retry or rephrase.' },
  'aiError.PARSE_ERROR': { 'zh-TW': 'AI 回傳的格式不正確，請再試一次。', en: 'The AI returned an unexpected format. Please retry.' },
  'aiError.UNKNOWN': { 'zh-TW': 'AI 請求失敗，請再試一次。', en: 'The AI request failed. Please retry.' },
  refinedTitle: { 'zh-TW': '{title}（彩色／PBR）', en: '{title} (Colored / PBR)' }
};

export function str(key, lang, params = {}) {
  const text = STRINGS[key]?.[roomLanguage(lang)] || STRINGS[key]?.en || key;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}
