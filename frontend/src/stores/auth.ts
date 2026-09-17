import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAuthStore = defineStore('auth', () => {
  // Load or initialize guest identity
  const storedUid = localStorage.getItem('ai_mentor_uid') || `guest_${Math.random().toString(36).substring(2, 9)}`;
  const storedName = localStorage.getItem('ai_mentor_name') || '設計探索者';
  const storedAvatar = localStorage.getItem('ai_mentor_avatar') || '🦊';
  const isGoogleLinked = ref(localStorage.getItem('ai_mentor_google_linked') === 'true');

  const uid = ref(storedUid);
  const displayName = ref(storedName);
  const avatar = ref(storedAvatar);
  const email = ref(localStorage.getItem('ai_mentor_email') || '');

  // Persist guest info
  localStorage.setItem('ai_mentor_uid', uid.value);

  const updateProfile = (name: string, newAvatar: string) => {
    displayName.value = name;
    avatar.value = newAvatar;
    localStorage.setItem('ai_mentor_name', name);
    localStorage.setItem('ai_mentor_avatar', newAvatar);
  };

  // Google Account Upgrade simulation / linking
  const upgradeWithGoogle = (simulatedEmail: string = 'alex.designer@gmail.com') => {
    isGoogleLinked.value = true;
    email.value = simulatedEmail;
    displayName.value = 'Alex (Google 認證)';
    avatar.value = '⚡';
    localStorage.setItem('ai_mentor_google_linked', 'true');
    localStorage.setItem('ai_mentor_email', simulatedEmail);
    localStorage.setItem('ai_mentor_name', displayName.value);
    localStorage.setItem('ai_mentor_avatar', avatar.value);
  };

  const logoutGoogle = () => {
    isGoogleLinked.value = false;
    email.value = '';
    localStorage.removeItem('ai_mentor_google_linked');
    localStorage.removeItem('ai_mentor_email');
  };

  return {
    uid,
    displayName,
    avatar,
    email,
    isGoogleLinked,
    updateProfile,
    upgradeWithGoogle,
    logoutGoogle
  };
});
