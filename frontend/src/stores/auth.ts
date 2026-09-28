import { defineStore } from 'pinia';
import { ref } from 'vue';
import { auth, db, isFirebaseConfigured } from '../firebase/config';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
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
  const isConfigured = ref(isFirebaseConfigured());

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

        // Restore and sync cloud-synced API keys from Firestore user profile across devices
        if (db) {
          try {
            const userDocRef = doc(db, 'users', user.uid);
            const snap = await getDoc(userDocRef);
            const localGemini = localStorage.getItem('ai_gemini_api_key') || '';
            const localTripo = localStorage.getItem('ai_tripo_api_key') || '';
            const localMeshy = localStorage.getItem('ai_meshy_api_key') || '';
            const localEngine = localStorage.getItem('ai_3d_engine') || '';

            if (snap.exists()) {
              const data = snap.data();
              if (data.geminiApiKey) {
                localStorage.setItem('ai_gemini_api_key', data.geminiApiKey);
                (window as any).__SHARED_GEMINI_KEY__ = data.geminiApiKey;
              } else if (localGemini) {
                await setDoc(userDocRef, { geminiApiKey: localGemini }, { merge: true });
              }

              if (data.tripoApiKey) {
                localStorage.setItem('ai_tripo_api_key', data.tripoApiKey);
              } else if (localTripo) {
                await setDoc(userDocRef, { tripoApiKey: localTripo }, { merge: true });
              }

              if (data.meshyApiKey) {
                localStorage.setItem('ai_meshy_api_key', data.meshyApiKey);
              } else if (localMeshy) {
                await setDoc(userDocRef, { meshyApiKey: localMeshy }, { merge: true });
              }

              if (data.engine3D) {
                localStorage.setItem('ai_3d_engine', data.engine3D);
              } else if (localEngine) {
                await setDoc(userDocRef, { engine3D: localEngine }, { merge: true });
              }
            } else if (localGemini || localTripo || localMeshy || localEngine) {
              await setDoc(userDocRef, {
                geminiApiKey: localGemini || undefined,
                tripoApiKey: localTripo || undefined,
                meshyApiKey: localMeshy || undefined,
                engine3D: localEngine || undefined,
                updatedAt: Date.now()
              }, { merge: true });
            }
          } catch (err) {
            console.warn('[Auth] Failed to load/sync user profile API keys:', err);
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
