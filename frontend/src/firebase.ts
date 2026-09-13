import { initializeApp } from "firebase/app";
import { browserLocalPersistence, getAuth, setPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Values come from frontend/.env.local (gitignored). Copy .env.example to
// .env.local and fill in the config shown in Firebase console > Project
// settings > Your apps > SDK setup and configuration.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/* If the env file is missing the app shows a setup screen instead of crashing
   with an opaque Firebase error, so a fresh clone is never just a blank page. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

export const missingFirebaseKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => `VITE_FIREBASE_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`);

const app = initializeApp(
  isFirebaseConfigured
    ? firebaseConfig
    : { apiKey: firebaseConfig.apiKey, projectId: firebaseConfig.projectId, appId: firebaseConfig.appId }
);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Keep the user signed in across refreshes and browser restarts.
if (isFirebaseConfigured) {
  setPersistence(auth, browserLocalPersistence).catch(() => {
    /* falls back to in-memory persistence (e.g. hardened private mode) */
  });
}
