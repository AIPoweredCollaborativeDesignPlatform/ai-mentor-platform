import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { MentorConfig, SensitivityLevel } from '../types';

export const useMentorStore = defineStore('mentor', () => {
  const config = ref<MentorConfig>({
    sensitivity: 'Conservative',
    modelTier: 'flash',
    meetingLanguage: 'en',
    enable3D: true,
    enableMoodboard: true,
    enableFactRetrieval: true,
    enableProcessIntervention: true,
  });

  // Internal AI progress checkpoints (private to AI, invisible to users)
  const internalCheckpoints = ref<{ messageIndex: number; topic: string; consensusScore: number }[]>([]);

  const setSensitivity = (level: SensitivityLevel) => {
    config.value.sensitivity = level;
  };

  const setModelTier = (tier: 'flash' | 'pro') => {
    config.value.modelTier = tier;
  };

  const setMeetingLanguage = (lang: 'en' | 'zh-TW' | 'ja' | 'ko') => {
    config.value.meetingLanguage = lang;
  };

  const toggleModule = (moduleKey: 'enable3D' | 'enableMoodboard' | 'enableFactRetrieval' | 'enableProcessIntervention') => {
    config.value[moduleKey] = !config.value[moduleKey];
  };

  const recordCheckpoint = (messageIndex: number, topic: string, consensusScore: number) => {
    internalCheckpoints.value.push({ messageIndex, topic, consensusScore });
  };

  return {
    config,
    internalCheckpoints,
    setSensitivity,
    setModelTier,
    setMeetingLanguage,
    toggleModule,
    recordCheckpoint
  };
});
