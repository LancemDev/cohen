/**
 * Firebase web app config.
 *
 * Replace these values with your Firebase project's config from:
 * Firebase console > Project settings > Your apps > Web app.
 *
 * The extension runs with these values bundled into the client. That is
 * expected for Firebase web configs; security comes from App Check,
 * Firebase Security Rules, and API restrictions — not from keeping this
 * config secret.
 */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export const firebaseConfig: FirebaseWebConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

export function isFirebaseConfigured(config: FirebaseWebConfig = firebaseConfig): boolean {
  return Object.values(config).every(
    (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('YOUR_'),
  );
}

// Chrome App Check debug token for local development.
// Set this in the service worker/offscreen console, then register it in
// Firebase console > App Check > Apps > Manage debug tokens.
// Never ship a debug token in a production build.
export const APP_CHECK_DEBUG_TOKEN: string | boolean = false;

// reCAPTCHA Enterprise site key for production App Check on web.
// Leave empty to rely on debug provider during local development.
export const RECAPTCHA_ENTERPRISE_SITE_KEY = '';
