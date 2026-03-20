/**
 * ui.js – Shared UI utilities (web app version)
 */

// -- Toasts -----------------------------------------------------------------

const ICONS = {
  success: '\u2713',
  error:   '\u2715',
  warning: '\u26A0',
  info:    '\u2139',
};

export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${ICONS[type] ?? ICONS.info}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, duration);
}

// -- Modal helpers ----------------------------------------------------------

export function openModal(name) {
  const el = document.getElementById(`${name}-modal`);
  if (el) el.classList.remove('hidden');
}

export function closeModal(name) {
  const el = document.getElementById(`${name}-modal`);
  if (el) el.classList.add('hidden');
}

// Close any modal when clicking the overlay background
export function initModalOverlays() {
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        const name = overlay.dataset.modal;
        if (name && name !== 'card') closeModal(name);
      }
    });
  });

  // data-close buttons
  document.querySelectorAll('[data-close]').forEach((btn) => {
    const name = btn.dataset.close;
    if (name !== 'card') {   // card modal has its own close handler
      btn.addEventListener('click', () => closeModal(name));
    }
  });
}

// -- Dropdowns --------------------------------------------------------------

export function initDropdowns() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.project-selector')) {
      document.getElementById('project-dropdown')?.classList.add('hidden');
    }
    if (!e.target.closest('.user-menu')) {
      document.getElementById('user-dropdown')?.classList.add('hidden');
    }
  });

  document.getElementById('project-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('project-dropdown');
    dd?.classList.toggle('hidden');
    document.getElementById('user-dropdown')?.classList.add('hidden');
  });

  document.getElementById('user-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('user-dropdown');
    dd?.classList.toggle('hidden');
    document.getElementById('project-dropdown')?.classList.add('hidden');
  });
}

// -- Color pickers ----------------------------------------------------------

export function initColorPicker(containerId, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let selected = container.querySelector('.active')?.dataset.color
    ?? container.querySelector('[data-color]')?.dataset.color
    ?? '#6366f1';

  container.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    container.querySelectorAll('[data-color]').forEach((s) => s.classList.remove('active'));
    swatch.classList.add('active');
    selected = swatch.dataset.color;
    onChange?.(selected);
  });

  function setColor(color) {
    container.querySelectorAll('[data-color]').forEach((s) => {
      s.classList.toggle('active', s.dataset.color === color);
    });
    selected = color;
  }

  return { getColor: () => selected, setColor };
}

// -- User avatar rendering --------------------------------------------------

export function setUserAvatar(user) {
  const img      = document.getElementById('user-avatar');
  const fallback = document.getElementById('user-avatar-fallback');

  if (user?.photoURL) {
    img.src = user.photoURL;
    img.style.display = '';
    fallback.style.display = 'none';
  } else {
    img.style.display = 'none';
    fallback.style.display = '';
    fallback.textContent = (user?.displayName ?? user?.email ?? 'G').charAt(0).toUpperCase();
  }

  document.getElementById('user-display-name').textContent =
    user?.displayName ?? user?.email ?? 'Guest';
  document.getElementById('user-email-display').textContent =
    user?.email ?? '';

  // Show Sign Out only for real Firebase users; show Sign In for guests/anonymous.
  const isSignedIn = !!(user?.uid && user.uid !== 'local');
  const signOutBtn    = document.getElementById('sign-out-btn');
  const signInMenuBtn = document.getElementById('sign-in-menu-btn');
  if (signOutBtn)    signOutBtn.style.display    = isSignedIn ? '' : 'none';
  if (signInMenuBtn) signInMenuBtn.style.display = isSignedIn ? 'none' : '';
}

export function setTierBadge(tier) {
  const badge = document.getElementById('tier-badge');
  if (!badge) return;

  if (tier === 'premium') {
    badge.textContent = '\u26A1 Premium';
    badge.classList.add('premium');
    document.getElementById('upgrade-btn')?.style.setProperty('display', 'none');
    document.getElementById('manage-billing-btn')?.style.setProperty('display', '');
    document.getElementById('invite-btn')?.style.setProperty('display', '');
  } else {
    badge.textContent = 'Free';
    badge.classList.remove('premium');
    document.getElementById('upgrade-btn')?.style.removeProperty('display');
    document.getElementById('manage-billing-btn')?.style.setProperty('display', 'none');
  }
}

// -- Theme ------------------------------------------------------------------

export function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  document.getElementById('theme-dark-btn')?.classList.toggle('active', theme !== 'light');
  document.getElementById('theme-light-btn')?.classList.toggle('active', theme === 'light');
  localStorage.setItem('theme', theme);
}

export function loadTheme() {
  const theme = localStorage.getItem('theme') ?? 'dark';
  applyTheme(theme);
  return theme;
}

// -- Helpers ----------------------------------------------------------------

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
