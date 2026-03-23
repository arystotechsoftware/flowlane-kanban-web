import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail as firebaseSendPasswordResetEmail,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { firebaseConfig } from './firebase-config.js';

let app;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

export const auth = getAuth(app);
export { app };

function createGoogleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

function createGitHubProvider() {
  const provider = new GithubAuthProvider();
  provider.addScope('read:user');
  provider.addScope('user:email');
  return provider;
}

function isPasswordUser(user) {
  return !!user?.providerData?.some((provider) => provider?.providerId === 'password');
}

function getEmailVerificationMessage(email) {
  const target = email ? ` ${email}` : '';
  return `Please verify${target} before signing in. We sent a verification link to your inbox.`;
}



async function signInWithPopupOrRedirect(provider) {
  try {
    const { user } = await signInWithPopup(auth, provider);
    return user;
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-cancelled-by-user') {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

export function signInWithGoogle() {
  return signInWithPopupOrRedirect(createGoogleProvider());
}

export function signInWithGitHub() {
  return signInWithPopupOrRedirect(createGitHubProvider());
}



export async function signInWithEmailPassword(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  if (isPasswordUser(user) && !user.emailVerified) {
    await sendEmailVerification(user).catch(() => {});
    await fbSignOut(auth);
    throw new Error(getEmailVerificationMessage(user.email));
  }
  return user;
}

export async function registerWithEmailPassword(email, password) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(user);
  await fbSignOut(auth);
  return user;
}

export async function sendPasswordReset(email) {
  await firebaseSendPasswordResetEmail(auth, email);
}

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



