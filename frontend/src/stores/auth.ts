import { defineStore } from 'pinia';
import { ref } from 'vue';
import { auth, isFirebaseConfigured } from '../firebase/config';
import {
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  type User
} from 'firebase/auth';

export const useAuthStore = defineStore('auth', () => {
  const isConfigured = ref(isFirebaseConfigured());

  // Default guest values
  const storedUid = localStorage.getItem('ai_mentor_uid') || `guest_${Math.random().toString(36).substring(2, 9)}`;
  const storedName = localStorage.getItem('ai_mentor_name') || 'Guest';
  const storedAvatar = localStorage.getItem('ai_mentor_avatar') || '🦊';

  const uid = ref(storedUid);
  const displayName = ref(storedName);
  const avatar = ref(storedAvatar);
  const email = ref(localStorage.getItem('ai_mentor_email') || '');
  const isGoogleLinked = ref(localStorage.getItem('ai_mentor_google_linked') === 'true');
  const firebaseUser = ref<User | null>(null);

  // Sync profile locally
  const updateProfile = (name: string, newAvatar: string) => {
    displayName.value = name;
    avatar.value = newAvatar;
    localStorage.setItem('ai_mentor_name', name);
    localStorage.setItem('ai_mentor_avatar', newAvatar);
  };

  // Attach real Firebase listener if configured
  if (auth) {
    onAuthStateChanged(auth, (user) => {
      firebaseUser.value = user;
      if (user) {
        uid.value = user.uid;
        localStorage.setItem('ai_mentor_uid', user.uid);
        if (user.isAnonymous) {
          isGoogleLinked.value = false;
          localStorage.removeItem('ai_mentor_google_linked');
        } else {
          // Real Google account
          isGoogleLinked.value = true;
          email.value = user.email || '';
          displayName.value = user.displayName || displayName.value;
          localStorage.setItem('ai_mentor_google_linked', 'true');
          localStorage.setItem('ai_mentor_email', email.value);
          localStorage.setItem('ai_mentor_name', displayName.value);
        }
      }
    });
  }

  // Real Anonymous Guest login
  const initGuestAuth = async () => {
    if (!auth) return;
    try {
      if (!auth.currentUser) {
        const cred = await signInAnonymously(auth);
        uid.value = cred.user.uid;
        localStorage.setItem('ai_mentor_uid', cred.user.uid);
      }
    } catch (e) {
      console.warn('[Auth] Anonymous sign-in fallback to local UID:', e);
    }
  };

  // Real Google Account sign-in / upgrade
  const upgradeWithGoogle = async () => {
    if (!auth) {
      throw new Error('Firebase Auth is not configured');
    }
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    firebaseUser.value = user;
    uid.value = user.uid;
    email.value = user.email || '';
    displayName.value = user.displayName || 'Google User';
    isGoogleLinked.value = true;

    localStorage.setItem('ai_mentor_uid', user.uid);
    localStorage.setItem('ai_mentor_google_linked', 'true');
    localStorage.setItem('ai_mentor_email', email.value);
    localStorage.setItem('ai_mentor_name', displayName.value);
    return { success: true, user };
  };

  // Real Sign-out
  const logoutGoogle = async () => {
    if (auth) {
      try {
        await signOut(auth);
      } catch (e) {
        console.error(e);
      }
    }
    isGoogleLinked.value = false;
    email.value = '';
    localStorage.removeItem('ai_mentor_google_linked');
    localStorage.removeItem('ai_mentor_email');
    // Re-init anonymous guest
    await initGuestAuth();
  };

  // Init on store creation
  initGuestAuth();

  return {
    uid,
    displayName,
    avatar,
    email,
    isGoogleLinked,
    isConfigured,
    firebaseUser,
    updateProfile,
    upgradeWithGoogle,
    logoutGoogle,
    initGuestAuth
  };
});
