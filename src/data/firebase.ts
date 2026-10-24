import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';

export const usingEmulators = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';

const config = {
  apiKey: usingEmulators ? 'demo-api-key' : import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: usingEmulators ? 'demo-spendsmart.firebaseapp.com' : import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: usingEmulators ? 'demo-spendsmart' : import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: usingEmulators ? '1:123456789:web:demo-spendsmart' : import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
};

const configurationProvided = [config.apiKey, config.authDomain, config.projectId, config.appId]
  .every((value) => Boolean(value) && !value?.includes('your-') && !value?.includes('REPLACE_'));

let configuredAuth: Auth | null = null;
let configuredDatabase: Firestore | null = null;

if (configurationProvided) {
  try {
    const appName = usingEmulators ? 'spendsmart-emulator' : '[DEFAULT]';
    const app = getApps().some((existing) => existing.name === appName) ? getApp(appName) : initializeApp(config, appName);
    configuredAuth = getAuth(app);
    configuredDatabase = getFirestore(app);
    if (usingEmulators) {
      connectAuthEmulator(configuredAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(configuredDatabase, '127.0.0.1', 8080);
    }
  } catch {
    // A malformed configuration should not prevent the local demo from running.
    configuredAuth = null;
    configuredDatabase = null;
  }
}

export const auth = configuredAuth;
export const database = configuredDatabase;
export const cloudConfigured = Boolean(auth && database);
