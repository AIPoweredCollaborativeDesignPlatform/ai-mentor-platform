import { ref, computed } from 'vue';

export type SupportedLocale = 'en' | 'zh-TW';

export const currentLocale = ref<SupportedLocale>(
  (localStorage.getItem('ai_mentor_locale') as SupportedLocale) || 'en'
);

export const setLocale = (locale: SupportedLocale) => {
  currentLocale.value = locale;
  localStorage.setItem('ai_mentor_locale', locale);
};

export const translations: Record<SupportedLocale, Record<string, string>> = {
  'en': {
    'room.meeting': 'Meeting',
    'room.archived': 'Archived',
    'room.members': 'Members',
    'room.host': 'Host',
    'room.copyInvite': 'Copy Invite',
    'room.copied': 'Copied!',
    'room.settings': 'Settings',
    'room.reopen': 'Reopen Meeting',
    'room.archivedBanner': 'This meeting has been closed by the host. It is currently in read-only archive mode.',
    'room.inputPlaceholder': 'Type a message (Shift+Enter for new line, paste images)...',
    'room.mutedPlaceholder': 'You have been muted by the host.',
    'room.closedPlaceholder': 'This meeting has been closed. Chat is in read-only mode.',
    'room.send': 'Send',
    'room.quickShortcuts': 'Quick Prompts:',
    'room.attachTooltip': 'Attach images, videos (<=30s), PDF or documents',
    'room.previewPdf': 'Preview PDF',
    'room.download': 'Download',
    'room.profile': 'Update Profile',
    'room.language': 'UI Language',
    'room.meetingLanguage': 'Room Language',
    'room.isTyping': 'is typing...',
    'room.and': 'and',
    'room.othersTyping': 'others are typing...',
    'room.mentionMember': 'Mention Member or AI',
    'room.googleSignIn': 'Sign in with Google',
    'room.googleVerified': 'Google Verified',
    'room.zoomIn': 'Zoom In',
    'room.zoomOut': 'Zoom Out',
    'room.resetView': 'Reset View',
    'drawer.title': 'Room Controls',
    'drawer.modelTier': 'AI Model Tier',
    'drawer.sensitivity': 'AI Sensitivity',
    'drawer.modules': 'AI Asset Modules',
    'drawer.roomLang': 'Meeting Working Language',
    'drawer.leave': 'Leave Meeting',
    'drawer.endAll': 'End for Everyone',
    'drawer.anonWarning': 'Anonymous Host Warning'
  },
  'zh-TW': {
    'room.meeting': '會議',
    'room.archived': '已封存',
    'room.members': '成員',
    'room.host': '主持人',
    'room.copyInvite': '複製邀請連結',
    'room.copied': '已複製！',
    'room.settings': '房間設定',
    'room.reopen': '重新開啟會議',
    'room.archivedBanner': '主持人已結束此會議。目前處於唯讀封存模式。',
    'room.inputPlaceholder': '輸入訊息（Shift+Enter 換行，支援貼上圖片）...',
    'room.mutedPlaceholder': '您已被主持人靜音。',
    'room.closedPlaceholder': '會議已結束，聊天室處於唯讀模式。',
    'room.send': '發送',
    'room.quickShortcuts': '快捷調用：',
    'room.attachTooltip': '附加圖片、影片（<=30秒）、PDF 或文件',
    'room.previewPdf': '預覽 PDF',
    'room.download': '下載',
    'room.profile': '修改個人資料',
    'room.language': '介面語言',
    'room.meetingLanguage': '會議工作語言',
    'room.isTyping': '正在輸入中...',
    'room.and': '與',
    'room.othersTyping': '位成員正在輸入...',
    'room.mentionMember': '提及成員或 AI',
    'room.googleSignIn': '使用 Google 帳號登入',
    'room.googleVerified': 'Google 驗證會員',
    'room.zoomIn': '放大',
    'room.zoomOut': '縮小',
    'room.resetView': '重置視角',
    'drawer.title': '房間控制面板',
    'drawer.modelTier': 'AI 模型等級',
    'drawer.sensitivity': 'AI 介入敏感度',
    'drawer.modules': 'AI 生成功能模組',
    'drawer.roomLang': '會議指定工作語言',
    'drawer.leave': '離開會議',
    'drawer.endAll': '為所有人結束會議',
    'drawer.anonWarning': '匿名主持人警示'
  }
};

export const t = (key: string): string => {
  return translations[currentLocale.value]?.[key] || translations['en']?.[key] || key;
};
