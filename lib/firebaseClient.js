import { initializeApp, getApps } from "firebase/app";
import { getAuth, browserLocalPersistence, setPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// True once real Firebase config has been supplied (see .env.local.example).
export const firebaseReady = !!(config.apiKey && config.projectId && config.appId);

let auth = null;
let db = null;

if (firebaseReady) {
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = getAuth(app);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  db = getFirestore(app);
}

export { auth, db };

// The account "name" is really a synthetic email under the hood, since
// Firebase Auth's email/password provider is what actually stores and
// verifies the password. Normalization keeps names case/spacing-insensitive.
export function normalize(name) {
  return (
    (name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "user"
  );
}

export function syntheticEmail(id) {
  return id + "@schedule-share.local";
}
