import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyAYQsML6EDnKnlDQRe_hVXjzvbV5Gqnr50',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'ai-mentor-web.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'ai-mentor-web',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'ai-mentor-web.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '160863026720',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:160863026720:web:2dfcfb4bf690cb45df0645'
};

// The app cannot run without Firebase, so these are always initialized (no offline/localStorage mode).
export const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
