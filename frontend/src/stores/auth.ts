import { defineStore } from 'pinia';
import { ref } from 'vue';
import { auth, db } from '../firebase/config';
import { updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import {
  signInAnonymously,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  type User
} from 'firebase/auth';

export const useAuthStore = defineStore('auth', () => {

  // Pool of diverse, fun emoji avatars to prevent repeated avatars
  const AVATAR_POOL = [
    '🦊', '🐼', '🐨', '🦁', '🐯', '🐙', '🦉', '🦄', '🐲', '🐧',
    '🤖', '🧙‍♂️', '🧑‍🚀', '🐱', '🐶', '🐺', '🐵', '🐸', '🐹', '🐰',
    '🦝', '🦥', '🦦', '🦔', '🦖', '🐬', '🦚', '🦋', '🐝', '👾',
    '🚀', '🎨', '⚡', '🌟', '🧁', '🍕'
  ];
  const getRandomAvatar = () => AVATAR_POOL[Math.floor(Math.random() * AVATAR_POOL.length)];

  // Default guest values
  const storedUid = localStorage.getItem('ai_mentor_uid') || `guest_${Math.random().toString(36).substring(2, 9)}`;
  const storedName = localStorage.getItem('ai_mentor_name') || 'Guest';
  let initialAvatar = localStorage.getItem('ai_mentor_avatar');
  if (!initialAvatar) {
    initialAvatar = getRandomAvatar();
    localStorage.setItem('ai_mentor_avatar', initialAvatar);
  }

  const uid = ref(storedUid);
  const displayName = ref(storedName);
  const avatar = ref(initialAvatar);
  const email = ref(localStorage.getItem('ai_mentor_email') || '');
  const isGoogleLinked = ref(localStorage.getItem('ai_mentor_google_linked') === 'true');
  const firebaseUser = ref<User | null>(null);
  const isAuthReady = ref(!auth);
  let authReadyResolve: ((user: User | null) => void) | null = null;
  const authReadyPromise = new Promise<User | null>((resolve) => {
    authReadyResolve = resolve;
  });

  const waitForAuthReady = async (): Promise<User | null> => {
    if (!auth) return null;
    if (isAuthReady.value) return firebaseUser.value || auth.currentUser;
    return authReadyPromise;
  };

  // Sync profile locally
  const updateProfile = (name: string, newAvatar: string) => {
    displayName.value = name;
    avatar.value = newAvatar;
    localStorage.setItem('ai_mentor_name', name);
    localStorage.setItem('ai_mentor_avatar', newAvatar);
  };

  // Attach real Firebase listener if configured
  if (auth) {
    // Check if we just came back from a redirect login
    getRedirectResult(auth).then((result) => {
      if (result?.user) {
        console.log('[Auth] Redirect sign-in success:', result.user.uid);
      }
    }).catch((err) => {
      if (err?.code !== 'auth/popup-closed-by-user') {
        console.warn('[Auth] Redirect sign-in error:', err);
      }
    });

    onAuthStateChanged(auth, async (user) => {
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
          displayName.value = user.displayName || displayName.value || user.email?.split('@')[0] || 'User';
          localStorage.setItem('ai_mentor_google_linked', 'true');
          localStorage.setItem('ai_mentor_email', email.value);
          localStorage.setItem('ai_mentor_name', displayName.value);
        }
      } else if (localStorage.getItem('ai_mentor_google_linked') !== 'true') {
        // First-time guest visit: sign in anonymously so Firestore security rules pass immediately
        try {
          const cred = await signInAnonymously(auth!);
          user = cred.user;
          firebaseUser.value = user;
          uid.value = user.uid;
          localStorage.setItem('ai_mentor_uid', user.uid);
        } catch (e) {
          console.warn('[Auth] Anonymous sign-in fallback:', e);
        }
      }

      if (!isAuthReady.value) {
        isAuthReady.value = true;
        authReadyResolve?.(user);
      }
    });
  }

  // Real Anonymous Guest login
  const initGuestAuth = async () => {
    if (!auth) return;
    // CRITICAL: If user was previously signed in with Google, DO NOT overwrite with anonymous sign-in!
    if (localStorage.getItem('ai_mentor_google_linked') === 'true') {
      return;
    }
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

    const previousAnonUid = (auth.currentUser && auth.currentUser.isAnonymous)
      ? auth.currentUser.uid
      : null;

    let user: User | null = null;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    try {
      // Directly call signInWithPopup to honor user click activation
      const result = await signInWithPopup(auth, provider);
      user = result.user;
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') {
        // User closed the popup intentionally
        throw err;
      }

      if (err?.code === 'auth/popup-blocked' || isMobile) {
        console.warn('Popup blocked or mobile browser detected, redirecting...', err);
        await signInWithRedirect(auth, provider);
        return { success: true, user: auth.currentUser, previousAnonUid };
      }

      throw err;
    }

    if (!user) return { success: false };

    firebaseUser.value = user;
    uid.value = user.uid;
    email.value = user.email || '';
    displayName.value = user.displayName || displayName.value || user.email?.split('@')[0] || 'User';
    isGoogleLinked.value = true;

    localStorage.setItem('ai_mentor_uid', user.uid);
    localStorage.setItem('ai_mentor_google_linked', 'true');
    localStorage.setItem('ai_mentor_email', email.value);
    localStorage.setItem('ai_mentor_name', displayName.value);

    // If upgrading from an anonymous account, migrate local rooms and Firestore rooms
    if (previousAnonUid && previousAnonUid !== user.uid) {
      // 1. Migrate local storage rooms
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('ai_room_')) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const item = JSON.parse(raw);
              let changed = false;
              if (item.hostUid === previousAnonUid) {
                item.hostUid = user.uid;
                changed = true;
              }
              if (item.participants && item.participants[previousAnonUid]) {
                const p = item.participants[previousAnonUid];
                p.uid = user.uid;
                p.displayName = displayName.value;
                item.participants[user.uid] = p;
                delete item.participants[previousAnonUid];
                changed = true;
              }
              if (changed) {
                localStorage.setItem(key, JSON.stringify(item));
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Auth] Error migrating localStorage rooms:', err);
      }

      // 2. Migrate Firestore rooms where host was previousAnonUid
      if (db) {
        try {
          const roomsQuery = query(collection(db, 'rooms'), where('hostUid', '==', previousAnonUid));
          const snap = await getDocs(roomsQuery);
          for (const docSnap of snap.docs) {
            await updateDoc(docSnap.ref, { hostUid: user.uid });
          }
        } catch (err) {
          console.warn('[Auth] Error migrating Firestore rooms:', err);
        }
      }
    }

    return { success: true, user, previousAnonUid };
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
    firebaseUser,
    updateProfile,
    upgradeWithGoogle,
    logoutGoogle,
    initGuestAuth,
    isAuthReady,
    waitForAuthReady
  };
});
