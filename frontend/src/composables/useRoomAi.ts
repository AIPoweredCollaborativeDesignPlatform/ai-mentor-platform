import { computed } from 'vue';
import { useRoomStore } from '../stores/room';
import { currentLocale } from '../i18n';
import type { RoomAiView } from '../types';

// Until the server assigns a profile (a second after room creation) the AI is shown as enabled
const FALLBACK: RoomAiView = {
  enabled: true,
  displayName: { 'zh-TW': 'AI 導師', en: 'AI Mentor' },
  modules: { enable3D: true, enableMoodboard: true, enableFactRetrieval: true, enableSummary: true, enableWhiteboardAi: true }
};

/** What the current room's condition lets participants see of the AI (no-AI rooms hide it entirely). */
export function useRoomAi() {
  const roomStore = useRoomStore();
  const view = computed(() => roomStore.currentRoom?.ai || FALLBACK);
  return {
    aiEnabled: computed(() => view.value.enabled),
    aiName: computed(() => view.value.displayName?.[currentLocale.value] || view.value.displayName?.en || 'AI Mentor'),
    aiModules: computed(() => (view.value.enabled ? view.value.modules : { ...FALLBACK.modules, enable3D: false, enableMoodboard: false, enableFactRetrieval: false, enableSummary: false, enableWhiteboardAi: false }))
  };
}
