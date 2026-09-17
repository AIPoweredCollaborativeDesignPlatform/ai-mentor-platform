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

  // Default to ai-mentor-web project
  const envConfig: FirebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyAYQsML6EDnKnlDQRe_hVXjzvbV5Gqnr50',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'ai-mentor-web.firebaseapp.com',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'ai-mentor-web',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'ai-mentor-web.firebasestorage.app',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '160863026720',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:160863026720:web:2dfcfb4bf690cb45df0645'
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
