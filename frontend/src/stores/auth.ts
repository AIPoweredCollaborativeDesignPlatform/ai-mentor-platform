import { defineStore } from 'pinia';
import { ref } from 'vue';
import { auth, db, isFirebaseConfigured } from '../firebase/config';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import {
  signInAnonymously,
  signInWithPopup,
  signInWithRedirect,
  linkWithPopup,
  linkWithRedirect,
  getRedirectResult,
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
    // Check if we just came back from a redirect login/link
    getRedirectResult(auth!).then((result) => {
      if (result?.user) {
        // If it was a redirect login/link, and we are here, it was successful.
        // We will let onAuthStateChanged handle the state updates.
      }
    }).catch(async (err) => {
      console.warn('Redirect sign-in error:', err);
      if (err?.code === 'auth/credential-already-in-use') {
         // The Google account is already used by another user.
         // We must sign out of the anonymous account and sign in with the Google credential.
         const credential = GoogleAuthProvider.credentialFromError(err);
         if (credential && auth) {
            // Need to sign out first to use the existing account
            await signOut(auth);
            // Sign in directly since we have the credential
            // Actually, in redirect flow, getting credential from error requires prompt...
            // the safest bet is to redirect again but as signIn instead of link.
            await signInWithRedirect(auth, new GoogleAuthProvider());
         }
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
          displayName.value = user.displayName || displayName.value;
          localStorage.setItem('ai_mentor_google_linked', 'true');
          localStorage.setItem('ai_mentor_email', email.value);
          localStorage.setItem('ai_mentor_name', displayName.value);
        }

        // Restore cloud-synced API keys from Firestore user profile across devices
        if (db) {
          try {
            const userDocRef = doc(db, 'users', user.uid);
            const snap = await getDoc(userDocRef);
            if (snap.exists()) {
              const data = snap.data();
              if (data.geminiApiKey) {
                localStorage.setItem('ai_gemini_api_key', data.geminiApiKey);
                (window as any).__SHARED_GEMINI_KEY__ = data.geminiApiKey;
              }
              if (data.tripoApiKey) {
                localStorage.setItem('ai_tripo_api_key', data.tripoApiKey);
              }
              if (data.meshyApiKey) {
                localStorage.setItem('ai_meshy_api_key', data.meshyApiKey);
              }
              if (data.engine3D) {
                localStorage.setItem('ai_3d_engine', data.engine3D);
              }
            }
          } catch (err) {
            console.warn('[Auth] Failed to load user profile API keys:', err);
          }
        }
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
    try {
      if (auth.currentUser && auth.currentUser.isAnonymous) {
        const result = await linkWithPopup(auth.currentUser, provider);
        user = result.user;
      } else {
        const result = await signInWithPopup(auth, provider);
        user = result.user;
      }
    } catch (err: any) {
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      
      if (err?.code === 'auth/credential-already-in-use') {
        // If the Google account is already linked to another Firebase user, fallback to sign in
        try {
           const result = await signInWithPopup(auth, provider);
           user = result.user;
        } catch (innerErr: any) {
           if (innerErr?.code === 'auth/popup-blocked' || isMobile) {
              await signInWithRedirect(auth, provider);
              return { success: true, user: auth.currentUser, previousAnonUid }; // Execution stops, page redirects
           }
           throw innerErr;
        }
      } else if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/cancelled-popup-request' || isMobile) {
        console.warn('Popup blocked or mobile device detected, using redirect instead...', err);
        if (auth.currentUser && auth.currentUser.isAnonymous) {
           await linkWithRedirect(auth.currentUser, provider);
        } else {
           await signInWithRedirect(auth, provider);
        }
        return { success: true, user: auth.currentUser, previousAnonUid }; // Execution stops, page redirects
      } else {
        throw err;
      }
    }
    
    if (!user) return { success: false };

    firebaseUser.value = user;
    uid.value = user.uid;
    email.value = user.email || '';
    displayName.value = user.displayName || 'Google User';
    isGoogleLinked.value = true;

    localStorage.setItem('ai_mentor_uid', user.uid);
    localStorage.setItem('ai_mentor_google_linked', 'true');
    localStorage.setItem('ai_mentor_email', email.value);
    localStorage.setItem('ai_mentor_name', displayName.value);
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

  const syncUserApiKeys = async (keys: {
    geminiApiKey?: string;
    tripoApiKey?: string;
    meshyApiKey?: string;
    engine3D?: string;
  }) => {
    if (keys.geminiApiKey !== undefined) {
      if (keys.geminiApiKey) {
        localStorage.setItem('ai_gemini_api_key', keys.geminiApiKey.trim());
        (window as any).__SHARED_GEMINI_KEY__ = keys.geminiApiKey.trim();
      } else {
        localStorage.removeItem('ai_gemini_api_key');
        delete (window as any).__SHARED_GEMINI_KEY__;
      }
    }
    if (keys.tripoApiKey !== undefined) {
      if (keys.tripoApiKey) localStorage.setItem('ai_tripo_api_key', keys.tripoApiKey.trim());
      else localStorage.removeItem('ai_tripo_api_key');
    }
    if (keys.meshyApiKey !== undefined) {
      if (keys.meshyApiKey) localStorage.setItem('ai_meshy_api_key', keys.meshyApiKey.trim());
      else localStorage.removeItem('ai_meshy_api_key');
    }
    if (keys.engine3D !== undefined) {
      if (keys.engine3D) localStorage.setItem('ai_3d_engine', keys.engine3D);
    }

    // Sync to Firestore if user and db exist
    if (db && uid.value) {
      try {
        const userDocRef = doc(db, 'users', uid.value);
        await setDoc(userDocRef, {
          ...(keys.geminiApiKey !== undefined && { geminiApiKey: keys.geminiApiKey }),
          ...(keys.tripoApiKey !== undefined && { tripoApiKey: keys.tripoApiKey }),
          ...(keys.meshyApiKey !== undefined && { meshyApiKey: keys.meshyApiKey }),
          ...(keys.engine3D !== undefined && { engine3D: keys.engine3D }),
          updatedAt: Date.now()
        }, { merge: true });
      } catch (err) {
        console.warn('[Auth] Failed to sync keys to Firestore user profile:', err);
      }
    }
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
    initGuestAuth,
    syncUserApiKeys
  };
});
