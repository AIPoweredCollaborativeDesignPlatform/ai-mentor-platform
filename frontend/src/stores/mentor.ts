import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { MentorConfig, SensitivityLevel } from '../types';

export const useMentorStore = defineStore('mentor', () => {
  const config = ref<MentorConfig>({
    sensitivity: 'Conservative',
    enable3D: true,
    enableMoodboard: true,
    enableFactRetrieval: true,
    enableProcessIntervention: true,
  });

  const setSensitivity = (level: SensitivityLevel) => {
    config.value.sensitivity = level;
  };

  const toggleModule = (moduleKey: keyof Omit<MentorConfig, 'sensitivity'>) => {
    config.value[moduleKey] = !config.value[moduleKey];
  };

  return {
    config,
    setSensitivity,
    toggleModule
  };
});
