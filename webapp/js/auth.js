import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut as fbSignOut, onAuthStateChanged } from 'firebase/auth';
import { firebaseConfig } from './firebase-config.js';

let app;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

export const auth = getAuth(app);
export { app };

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

export async function signInWithGoogle() {
  try {
    const { user } = await signInWithPopup(auth, provider);
    return user;
  } catch (err) {
    // If popup was blocked, fall back to redirect flow
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-cancelled-by-user') {
      await signInWithRedirect(auth, provider);
      return null; // onAuthChange will fire after redirect completes
    }
    throw err;
  }
}

/** Call once on boot to complete any pending redirect sign-in. */
export async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    return result?.user ?? null;
  } catch (_) {
    return null;
  }
}

export async function signOut() {
  await fbSignOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function getCurrentUser() {
  return auth.currentUser;
}
