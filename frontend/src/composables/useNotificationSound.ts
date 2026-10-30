import { ref } from 'vue';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config';

const STORAGE_KEY = 'ai_mentor_sound_muted';
const isSoundMuted = ref(localStorage.getItem(STORAGE_KEY) === 'true');

// Site-wide volume 0-100, set by the administrator (config/system.notificationVolume)
export const DEFAULT_NOTIFICATION_VOLUME = 70;
const volume = ref(DEFAULT_NOTIFICATION_VOLUME);
let volumeLoaded = false;
const loadVolume = async () => {
  if (volumeLoaded) return;
  try {
    const v = (await getDoc(doc(db, 'config', 'system'))).data()?.notificationVolume;
    if (typeof v === 'number') volume.value = Math.min(100, Math.max(0, v));
    volumeLoaded = true;
  } catch {
    // Not signed in yet: try again on the next chime
  }
};

/** Two-tone chime at `vol` (0-100); 70 is about 0.3 gain. */
export function playChime(vol: number) {
  if (vol <= 0) return;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime((Math.min(100, vol) / 100) * 0.43, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    gain.connect(ctx.destination);

    [[587.33, now, now + 0.1], [880, now + 0.1, now + 0.45]].forEach(([freq, start, stop]) => {
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
}

/** Chime for incoming messages; mute is remembered per browser, the volume comes from the admin setting. */
export function useNotificationSound() {
  loadVolume();
  const toggleSoundMute = () => {
    isSoundMuted.value = !isSoundMuted.value;
    localStorage.setItem(STORAGE_KEY, String(isSoundMuted.value));
  };

  const playNotificationSound = () => {
    if (isSoundMuted.value) return;
    loadVolume();
    playChime(volume.value);
  };

  return { isSoundMuted, toggleSoundMute, playNotificationSound };
}
