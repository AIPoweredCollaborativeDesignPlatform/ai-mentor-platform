import { ref } from 'vue';

const STORAGE_KEY = 'ai_mentor_sound_muted';
const isSoundMuted = ref(localStorage.getItem(STORAGE_KEY) === 'true');

/** Two-tone chime for incoming messages; mute preference is remembered per browser. */
export function useNotificationSound() {
  const toggleSoundMute = () => {
    isSoundMuted.value = !isSoundMuted.value;
    localStorage.setItem(STORAGE_KEY, String(isSoundMuted.value));
  };

  const playNotificationSound = () => {
    if (isSoundMuted.value) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      gain.connect(ctx.destination);

      [[587.33, now, now + 0.08], [880, now + 0.08, now + 0.32]].forEach(([freq, start, stop]) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        osc.connect(gain);
        osc.start(start);
        osc.stop(stop);
      });
    } catch {
      // ignore autoplay policy restrictions
    }
  };

  return { isSoundMuted, toggleSoundMute, playNotificationSound };
}
