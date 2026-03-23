import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js';
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
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js';
import { firebaseConfig, paddleConfig, FUNCTIONS_BASE_URL } from './checkout-flow-config.js';

const PLAN_CONTENT = {
  monthly: {
    name: 'Premium Monthly',
    price: '<span>$</span>3.99',
    copy: 'Monthly billing. Cancel anytime.',
    priceId: paddleConfig.monthlyPriceId,
  },
  annual: {
    name: 'Premium Annual',
    price: '<span>$</span>3.33',
    copy: '$39.99 billed annually. Save 16% over monthly billing.',
    priceId: paddleConfig.annualPriceId,
  },
};

const params = new URLSearchParams(window.location.search);
const selectedPlan = params.get('plan') === 'annual' ? 'annual' : 'monthly';
const planConfig = PLAN_CONTENT[selectedPlan];

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

const panelTitle = document.getElementById('panelTitle');
const panelLead = document.getElementById('panelLead');
const planName = document.getElementById('planName');
const planPrice = document.getElementById('planPrice');
const planCopy = document.getElementById('planCopy');
const statusBox = document.getElementById('statusBox');
const signedOutView = document.getElementById('signedOutView');
const signedInView = document.getElementById('signedInView');
const signedInSummary = document.getElementById('signedInSummary');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const githubSignInBtn = document.getElementById('githubSignInBtn');
const signinModeBtn = document.getElementById('signinModeBtn');
const registerModeBtn = document.getElementById('registerModeBtn');
const emailAuthForm = document.getElementById('emailAuthForm');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const emailSubmitBtn = document.getElementById('emailSubmitBtn');
const resetPasswordBtn = document.getElementById('resetPasswordBtn');
const continueCheckoutBtn = document.getElementById('continueCheckoutBtn');
const switchAccountBtn = document.getElementById('switchAccountBtn');

let emailMode = 'signin';
let checkoutStarted = false;

planName.textContent = planConfig.name;
planPrice.innerHTML = planConfig.price;
planCopy.textContent = planConfig.copy;

function setStatus(message, type = 'info') {
  if (!message) {
    statusBox.hidden = true;
    statusBox.className = 'notice';
    statusBox.textContent = '';
    return;
  }

  statusBox.hidden = false;
  statusBox.className = `notice${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  statusBox.textContent = message;
}

function setBusy(button, label) {
  if (!button) return;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${label}`;
}

function clearBusy(button, label) {
  if (!button) return;
  button.disabled = false;
  button.textContent = label;
}

function setEmailMode(mode) {
  emailMode = mode === 'register' ? 'register' : 'signin';
  signinModeBtn.classList.toggle('active', emailMode === 'signin');
  registerModeBtn.classList.toggle('active', emailMode === 'register');
  emailSubmitBtn.textContent = emailMode === 'signin' ? 'Sign In with Email' : 'Create Account';
  passwordInput.autocomplete = emailMode === 'signin' ? 'current-password' : 'new-password';
  resetPasswordBtn.hidden = emailMode !== 'signin';
}

function isVerifiedPasswordUser(user) {
  const usesPassword = user?.providerData?.some((provider) => provider?.providerId === 'password');
  return !usesPassword || user.emailVerified;
}

function getSafeCheckoutUrl(url) {
  try {
    const parsed = new URL(url);
    const isHostedLauncher =
      (parsed.hostname === `${firebaseConfig.projectId}.web.app` ||
       parsed.hostname === `${firebaseConfig.projectId}.firebaseapp.com`) &&
      parsed.pathname === '/paddle-checkout.html';

    const isAllowedHost =
      parsed.hostname === 'checkout.paddle.com' ||
      parsed.hostname === 'customer.paddle.com' ||
      parsed.hostname.endsWith('.paddle.com') ||
      isHostedLauncher;

    return parsed.protocol === 'https:' && isAllowedHost ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function showSignedOut() {
  signedOutView.hidden = false;
  signedInView.hidden = true;
  panelTitle.textContent = 'Sign in to continue';
  panelLead.textContent = 'We link your Paddle purchase to your FlowLane account before checkout opens.';
}

function showSignedIn(user) {
  signedOutView.hidden = true;
  signedInView.hidden = false;
  panelTitle.textContent = 'Ready for checkout';
  panelLead.textContent = 'Your account is linked. Continue to Paddle checkout when you are ready.';
  signedInSummary.textContent = `Signed in as ${user.displayName || user.email || 'your FlowLane account'}.`;
}

async function signInWithProvider(providerFactory) {
  setStatus('');

  try {
    await signInWithPopup(auth, providerFactory());
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-cancelled-by-user') {
      await signInWithRedirect(auth, providerFactory());
      return;
    }
    throw err;
  }
}

async function startCheckoutForUser(user) {
  if (!user || checkoutStarted) return;
  checkoutStarted = true;

  setStatus('Creating your secure Paddle checkout...', 'success');
  panelTitle.textContent = 'Preparing checkout';
  panelLead.textContent = 'One moment while we create your FlowLane Premium transaction.';
  setBusy(continueCheckoutBtn, 'Opening Paddle Checkout');

  try {
    const idToken = await user.getIdToken();
    const response = await fetch(`${FUNCTIONS_BASE_URL}/createCheckoutSession`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ priceId: planConfig.priceId }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        detail = data?.error || detail;
      } catch {}
      throw new Error(detail);
    }

    const data = await response.json();
    const checkoutUrl = getSafeCheckoutUrl(data?.url);
    if (!checkoutUrl) {
      throw new Error('Invalid Paddle checkout URL returned.');
    }

    window.location.href = checkoutUrl;
  } catch (err) {
    checkoutStarted = false;
    panelTitle.textContent = 'Ready for checkout';
    panelLead.textContent = 'We could not open Paddle checkout yet. You can retry below.';
    setStatus(`Could not start checkout. ${err.message}`, 'error');
    clearBusy(continueCheckoutBtn, 'Continue to Paddle Checkout');
  }
}

googleSignInBtn.addEventListener('click', async () => {
  setBusy(googleSignInBtn, 'Continuing with Google');
  try {
    await signInWithProvider(() => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return provider;
    });
  } catch (err) {
    setStatus(`Google sign-in failed. ${err.message}`, 'error');
    clearBusy(googleSignInBtn, 'Continue with Google');
  }
});

githubSignInBtn.addEventListener('click', async () => {
  setBusy(githubSignInBtn, 'Continuing with GitHub');
  try {
    await signInWithProvider(() => {
      const provider = new GithubAuthProvider();
      provider.addScope('read:user');
      provider.addScope('user:email');
      return provider;
    });
  } catch (err) {
    setStatus(`GitHub sign-in failed. ${err.message}`, 'error');
    clearBusy(githubSignInBtn, 'Continue with GitHub');
  }
});

signinModeBtn.addEventListener('click', () => setEmailMode('signin'));
registerModeBtn.addEventListener('click', () => setEmailMode('register'));

emailAuthForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('');

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    setStatus('Enter both your email address and password.', 'error');
    return;
  }

  setBusy(emailSubmitBtn, emailMode === 'signin' ? 'Signing In' : 'Creating Account');

  try {
    if (emailMode === 'register') {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(result.user);
      await signOut(auth).catch(() => {});
      setStatus(`Verification email sent to ${email}. Verify your address, then sign in to continue to checkout.`, 'success');
      passwordInput.value = '';
      setEmailMode('signin');
      return;
    }

    const result = await signInWithEmailAndPassword(auth, email, password);
    if (!isVerifiedPasswordUser(result.user)) {
      await sendEmailVerification(result.user).catch(() => {});
      await signOut(auth).catch(() => {});
      throw new Error(`Please verify ${email} before signing in. A fresh verification email has been sent.`);
    }
  } catch (err) {
    setStatus(err.message || 'Email authentication failed.', 'error');
  } finally {
    clearBusy(emailSubmitBtn, emailMode === 'signin' ? 'Sign In with Email' : 'Create Account');
  }
});

resetPasswordBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    setStatus('Enter your email address first so we know where to send the reset link.', 'error');
    emailInput.focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    setStatus('Password reset email sent.', 'success');
  } catch (err) {
    setStatus(`Could not send password reset email. ${err.message}`, 'error');
  }
});

continueCheckoutBtn.addEventListener('click', async () => {
  await startCheckoutForUser(auth.currentUser);
});

switchAccountBtn.addEventListener('click', async () => {
  await signOut(auth).catch(() => {});
  checkoutStarted = false;
  clearBusy(continueCheckoutBtn, 'Continue to Paddle Checkout');
  setStatus('');
  showSignedOut();
});

setEmailMode('signin');

await getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, async (user) => {
  clearBusy(googleSignInBtn, 'Continue with Google');
  clearBusy(githubSignInBtn, 'Continue with GitHub');

  if (!user) {
    checkoutStarted = false;
    clearBusy(continueCheckoutBtn, 'Continue to Paddle Checkout');
    showSignedOut();
    return;
  }

  showSignedIn(user);
  await startCheckoutForUser(user);
});
