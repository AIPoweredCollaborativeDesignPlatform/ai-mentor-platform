import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const STORAGE_KEY = 'ai_mentor_firebase_config';

export function getStoredFirebaseConfig(): FirebaseConfig | null {
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    try {
      const parsed = JSON.parse(local);
      if (parsed.apiKey && parsed.projectId) return parsed;
    } catch {
      // ignore
    }
  }

  // Default to ai-mentor-platform-a27ce project
  const envConfig: FirebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDoDvNPhO66P82nuxheWXreEqbEi3dda3M',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'ai-mentor-platform-a27ce.firebaseapp.com',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'ai-mentor-platform-a27ce',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'ai-mentor-platform-a27ce.firebasestorage.app',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '1005044934711',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:1005044934711:web:8df0e3eba24b27247cf7b2'
  };

  if (envConfig.apiKey && envConfig.projectId) {
    return envConfig;
  }

  return null;
}

export function saveFirebaseConfig(config: FirebaseConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  window.location.reload(); // Reload to re-initialize Firebase
}

export function isFirebaseConfigured(): boolean {
  const cfg = getStoredFirebaseConfig();
  return Boolean(cfg && cfg.apiKey && cfg.projectId);
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

const currentConfig = getStoredFirebaseConfig();

if (currentConfig) {
  try {
    app = getApps().length === 0 ? initializeApp(currentConfig) : getApps()[0];
    auth = getAuth(app);
    db = getFirestore(app);
    console.log('[Firebase] Successfully initialized Firebase Client SDK:', currentConfig.projectId);
  } catch (error) {
    console.warn('[Firebase] Initialization error:', error);
  }
}

export { app, auth, db };
