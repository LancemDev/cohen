import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import {
  APP_CHECK_DEBUG_TOKEN,
  RECAPTCHA_ENTERPRISE_SITE_KEY,
  firebaseConfig,
  isFirebaseConfigured,
} from '../config/firebase';
import { log } from '../utils/core';

let app: FirebaseApp | null = null;
let appCheck: AppCheck | null = null;
let ai: AI | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured. Add your project config to src/config/firebase.ts.');
  }
  app = getApps()[0] ?? initializeApp(firebaseConfig);
  return app;
}

export function ensureAppCheck(): AppCheck | null {
  if (appCheck) return appCheck;
  const firebaseApp = getFirebaseApp();

  try {
    if (APP_CHECK_DEBUG_TOKEN) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        APP_CHECK_DEBUG_TOKEN;
    }

    if (RECAPTCHA_ENTERPRISE_SITE_KEY) {
      appCheck = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
      return appCheck;
    }

    if (APP_CHECK_DEBUG_TOKEN) {
      // Debug mode: App Check still needs a provider object in web SDK.
      // ReCaptchaEnterpriseProvider won't issue real tokens in extension pages,
      // but the debug token flow lets local development proceed after registration.
      appCheck = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider('debug-provider-placeholder'),
        isTokenAutoRefreshEnabled: false,
      });
      log.warn('App Check initialized with debug placeholder; register debug token in Firebase console.');
      return appCheck;
    }

    log.warn('App Check not configured; cloud requests may be rejected by Firebase AI Logic.');
    return null;
  } catch (err) {
    log.warn('App Check initialization failed', err);
    return null;
  }
}

export function getAIService(): AI {
  if (ai) return ai;
  const firebaseApp = getFirebaseApp();
  ensureAppCheck();
  ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
  return ai;
}

export function firebaseStatus(): { configured: boolean; appCheck: boolean } {
  return {
    configured: isFirebaseConfigured(),
    appCheck: appCheck !== null,
  };
}
