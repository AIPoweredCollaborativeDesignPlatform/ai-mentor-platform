import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyAYQsML6EDnKnlDQRe_hVXjzvbV5Gqnr50',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'ai-mentor-web.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'ai-mentor-web',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'ai-mentor-web.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '160863026720',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:160863026720:web:2dfcfb4bf690cb45df0645'
};

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

try {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  auth = getAuth(app);
  db = getFirestore(app);
  console.log('[Firebase] Initialized:', firebaseConfig.projectId);
} catch (error) {
  console.warn('[Firebase] Initialization error:', error);
}

export { app, auth, db };
