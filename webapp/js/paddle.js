/**
 * paddle.js – Paddle Billing integration (web app)
 *
 * Flow:
 *  1. User clicks "Upgrade"
 *  2. We call a Firebase Cloud Function to create a Paddle transaction
 *  3. Open the Paddle-hosted Checkout page in a new tab
 *  4. Paddle sends a webhook -> Cloud Function updates Firestore
 *  5. Our listenUser() detects the tier change and upgrades the UI
 */

import { getCurrentUser } from './auth.js';
import { FUNCTIONS_BASE_URL, firebaseConfig } from './firebase-config.js';
import { showToast } from './ui.js';

/**
 * @param {string} priceId – Paddle Price ID for the selected plan (monthly or annual)
 */
export async function startCheckout(priceId) {
  const user = getCurrentUser();
  if (!user) {
    showToast('Sign in with Google first to upgrade', 'warning');
    return;
  }

  if (!priceId) {
    showToast('No plan selected', 'warning');
    return;
  }

  let idToken;
  try {
    idToken = await user.getIdToken();
  } catch {
    showToast('Authentication error – please sign in again', 'error');
    return;
  }

  const btn = document.getElementById('checkout-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Redirecting\u2026';
  }

  try {
    const res = await fetch(`${FUNCTIONS_BASE_URL}/createCheckoutSession`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ priceId }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data?.error ? `: ${data.error}` : '';
      } catch {}
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    const { url } = await res.json();
    if (!url) throw new Error('No checkout URL returned');
    if (!isSafePaddleUrl(url)) throw new Error('Invalid Paddle URL');

    // Open Paddle Checkout in a new tab
    window.open(url, '_blank');

    showToast('Paddle Checkout opened in a new tab', 'info');
    document.getElementById('upgrade-modal')?.classList.add('hidden');
  } catch (err) {
    console.error('[Paddle] Checkout error:', err);
    showToast(`Could not start checkout. ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg> Upgrade Now`;
    }
  }
}

export async function openBillingPortal() {
  const user = getCurrentUser();
  if (!user) return;

  let idToken;
  try {
    idToken = await user.getIdToken();
  } catch {
    showToast('Authentication error', 'error');
    return;
  }

  try {
    const res = await fetch(`${FUNCTIONS_BASE_URL}/createPortalSession`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
    });

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data?.error ? `: ${data.error}` : '';
      } catch {}
      throw new Error(`HTTP ${res.status}${detail}`);
    }
    const { url } = await res.json();
    if (!isSafePaddleUrl(url)) throw new Error('Invalid Paddle URL');
    window.open(url, '_blank');
  } catch (err) {
    console.error('[Paddle] Portal error:', err);
    showToast(`Could not open billing portal. ${err.message}`, 'error');
  }
}

/**
 * Opens a Paddle one-time checkout to purchase +1 GB of storage for $9.99.
 */
export async function purchaseStorageAddon() {
  const user = getCurrentUser();
  if (!user) {
    showToast('Sign in first to purchase storage', 'warning');
    return;
  }

  let idToken;
  try {
    idToken = await user.getIdToken();
  } catch {
    showToast('Authentication error – please sign in again', 'error');
    return;
  }

  const btn = document.getElementById('buy-storage-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting\u2026'; }

  try {
    const res = await fetch(`${FUNCTIONS_BASE_URL}/purchaseStorageAddon`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
    });

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data?.error ? `: ${data.error}` : '';
      } catch {}
      throw new Error(`HTTP ${res.status}${detail}`);
    }
    const { url } = await res.json();
    if (!url) throw new Error('No checkout URL returned');
    if (!isSafePaddleUrl(url)) throw new Error('Invalid Paddle URL');

    window.open(url, '_blank');
    showToast('Paddle Checkout opened in a new tab', 'info');
  } catch (err) {
    console.error('[Paddle] Storage addon checkout error:', err);
    showToast(`Could not start checkout. ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Buy +1 GB \u00b7 $9.99'; }
  }
}

/**
 * Validates that a URL points to a legitimate Paddle domain.
 */
export function isSafePaddleUrl(url) {
  try {
    const u = new URL(url);
    const allowedHostedCheckoutHosts = new Set([
      `${firebaseConfig.projectId}.web.app`,
      `${firebaseConfig.projectId}.firebaseapp.com`,
    ]);

    const isHostedCheckoutLauncher =
      allowedHostedCheckoutHosts.has(u.hostname) &&
      u.pathname === '/paddle-checkout.html';

    return u.protocol === 'https:' &&
      (u.hostname === 'checkout.paddle.com' ||
       u.hostname === 'customer.paddle.com' ||
       u.hostname.endsWith('.paddle.com') ||
       isHostedCheckoutLauncher);
  } catch { return false; }
}
