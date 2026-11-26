import type { FirebaseOptions } from 'firebase/app';

/**
 * Firebase web app config template.
 *
 * Copy `src/config/firebase.local.example.ts` to `src/config/firebase.local.ts`
 * and fill in your real values. `firebase.local.ts` is gitignored.
 */
export const firebaseConfig: FirebaseOptions = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  measurementId: 'YOUR_MEASUREMENT_ID',
};

export const APP_CHECK_DEBUG_TOKEN: string | boolean = false;
export const RECAPTCHA_ENTERPRISE_SITE_KEY = 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY';

export function isFirebaseConfigured(): boolean {
  return Object.values(firebaseConfig).every(
    (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('YOUR_'),
  );
}
