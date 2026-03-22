/**
 * app.js – Main entry point for the FlowLane Web App
 *
 * Boot sequence:
 *  1. Show loading screen
 *  2. Listen for Firebase auth state
 *  3a. If signed in → check subscription → load board
 *  3b. If not signed in → show auth screen (or skip-auth local mode)
 *
 * Key differences from the Chrome extension popup.js:
 *  - No chrome.* API calls — uses localStorage / window.open instead
 *  - No i18n module — inline English strings
 *  - No import module (inline implementation)
 *  - No open-window functionality
 *  - Auth button IDs: 'google-sign-in-btn' and 'skip-auth-btn'
 */

import { onAuthChange, signInWithGoogle, signOut, getCurrentUser, handleRedirectResult } from './auth.js';
import { upsertUser, listenUser, listenProjects, inviteCollaborator, getProject,
  removeCollaborator, updateCollaboratorRole, getPendingInvites,
  acceptInvite, getSentInvites, getAcceptedInvites, declineInvite, revokeInvite,
  syncCollaboratorInfo, updateProjectStatus,
  getProjectAuditLog, logUserAction, getInviteContacts, upsertInviteContact } from './db.js';
import { configure as configureStorage, getProjects, createProject, updateProject,
  deleteProject, hardDeleteProject, getColumns, getCards, createColumn, deleteColumn,
  getDeletedProjects, restoreDeletedProject, migrateLocalToCloud, adoptAnonymousData, setUserRole, canEdit, canAdmin,
  getStorageUsage, isPremiumMode } from './storage.js';
import { renderBoard, clearFilters, setSwimlaneMode, getSwimlaneMode, loadSwimlanePref,
  searchCards, getAnalyticsData } from './board.js';
import { renderAnalytics } from './analytics.js';
import { startListening, stopListening } from './collaboration.js';
import { startCheckout, openBillingPortal, purchaseStorageAddon } from './paddle.js';
import { exportToJSON } from './export.js';
import { paddleConfig } from './firebase-config.js';
import { showToast, openModal, closeModal, initModalOverlays,
  initDropdowns, initColorPicker, setUserAvatar, setTierBadge,
  applyTheme, loadTheme } from './ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const FREE_LIMIT = 3;
const HARD_DELETE_CONFIRM_TEXT = 'DELETE';

// ── State ─────────────────────────────────────────────────────────────────────
// Color state managed inline per modal (new-project / edit-project)
let _newProjectColorPicker = null;
let _editProjectColorPicker = null;
let _editProjectColor = '#6c63ff';
let _inviteContacts = [];
let _selectedInviteContactEmail = null;
let _inviteModalTab = 'invite';

let _state = {
  user:             null,
  tier:             'free',
  projects:         [],
  currentProjectId: null,
  unsubUser:        null,
  selectedPlan:     'monthly',
  isDowngraded:     false,
  pendingInviteCheckKey: null,
  deleteFlow:       null,
};

// Expose current project ID globally so board.js / card-modal.js can access it
window._currentProjectId = null;
window._refreshBoard     = loadCurrentBoard;

function logProjectManagerAction(action, details = {}) {
  const projectId = details.projectId ?? _state.deleteFlow?.projectId ?? _state.currentProjectId ?? null;
  const projectName = details.projectName
    ?? _state.deleteFlow?.projectName
    ?? _state.projects.find((x) => x.id === projectId)?.name
    ?? null;

  logUserAction(_state.user?.uid, action, {
    context: 'project_manager',
    platform: 'webapp',
    projectId,
    projectName,
    ...details,
  }).catch((err) => {
    console.warn('[logUserAction]', err);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════

async function boot() {
  await loadTheme();
  await loadSwimlanePref();

  show('loading-screen');

  initModalOverlays();
  initDropdowns();
  wireStaticButtons();

  onAuthChange(async (user) => {
    if (user) {
      await handleSignIn(user);
    } else {
      handleSignOut();
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREEN MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function show(screenId) {
  ['loading-screen', 'auth-screen', 'premium-wall', 'app'].forEach((id) => {
    document.getElementById(id)?.classList.toggle('hidden', id !== screenId);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

async function handleSignIn(user) {
  _state.user = user;
  _state.pendingInviteCheckKey = null;

  // Upsert user in Firestore (no-op if offline / firebase not configured)
  try {
    await upsertUser(user.uid, {
      displayName: user.displayName,
      email:       user.email,
      photoURL:    user.photoURL,
    });
  } catch (_) { /* Firebase not yet configured — ok */ }

  setUserAvatar(user);

  // Load org name from Firestore (fall back to localStorage)
  try {
    const { getUser } = await import('./db.js');
    const userData = await getUser(user.uid);
    if (userData?.orgName) {
      localStorage.setItem('flowlane_orgName', userData.orgName);
      applyOrgName(userData.orgName);
      const orgInput = document.getElementById('org-name-input');
      if (orgInput) orgInput.value = userData.orgName;
    } else {
      applyOrgName(localStorage.getItem('flowlane_orgName') || '');
    }
  } catch (_) {
    applyOrgName(localStorage.getItem('flowlane_orgName') || '');
  }

  // Stay on loading screen while we determine the subscription tier
  show('loading-screen');

  let tierResolved = false;

  // Fallback: if Firestore doesn't respond in 8s, show premium wall
  const tierTimeout = setTimeout(() => {
    if (!tierResolved) {
      tierResolved = true;
      show('premium-wall');
    }
  }, 8000);

  // Listen for subscription status — drives which screen is shown
  _state.unsubUser?.();
  try {
    _state.unsubUser = listenUser(user.uid, async (userData) => {
      const storedTier = userData?.tier ?? 'free';
      const endsAt     = userData?.subscriptionEndsAt ?? null;

      // Honour paid period even if Firestore tier is already set back to 'free'
      let effectiveTier = storedTier;
      if (storedTier === 'free' && endsAt) {
        const expiryDate = endsAt?.toDate?.() ?? new Date(endsAt);
        if (expiryDate > new Date()) effectiveTier = 'premium';
      }

      const prevTier = _state.tier;

      if (!tierResolved) {
        // First callback — determine initial screen
        tierResolved = true;
        clearTimeout(tierTimeout);
        _state.tier = effectiveTier;
        setTierBadge(effectiveTier);

        if (effectiveTier === 'premium') {
          configureStorage({ isPremium: true, uid: user.uid });
          await loadProjects();
          show('app');
        } else {
          // Not premium — show the premium wall
          show('premium-wall');
        }
      } else if (effectiveTier !== prevTier) {
        // Tier changed while app is running
        if (prevTier === 'premium' && effectiveTier === 'free') {
          // Subscription lapsed — move back to premium wall
          _state.tier = 'free';
          setTierBadge('free');
          stopListening();
          show('premium-wall');
        } else if (effectiveTier === 'premium') {
          // Upgraded from premium wall — enter the app
          _state.tier = 'premium';
          _state.isDowngraded = false;
          configureStorage({ isPremium: true, uid: user.uid });
          setTierBadge('premium');
          await loadProjects();
          show('app');
        }
      }

      if (tierResolved) {
        queuePendingInviteCheck(user);
      }
    });
  } catch (_) {
    // Firestore not configured — fall through to premium wall after timeout
  }
}

function handleSignOut() {
  _state.user = null;
  _state.tier = 'free';
  _state.projects = [];
  _state.currentProjectId = null;
  _state.isDowngraded = false;
  _state.pendingInviteCheckKey = null;

  _state.unsubUser?.();
  _state.unsubUser = null;
  stopListening();
  configureStorage({ isPremium: false, uid: null });
  setUserAvatar(null);
  setTierBadge('free');

  show('auth-screen');
}

// ══════════════════════════════════════════════════════════════════════════════
// DOWNGRADE
// ══════════════════════════════════════════════════════════════════════════════

function showDowngradeModal() {
  openModal('downgrade');
}

/**
 * Called when the user's effective tier is 'free' and we haven't yet entered
 * downgrade mode. Queries Firestore directly to see if the user still has
 * cloud projects from a previous premium subscription.
 */
async function checkAndEnterDowngradedMode(uid) {
  return new Promise((resolve) => {
    const unsub = listenProjects(uid, async (cloudProjects) => {
      unsub();
      if (cloudProjects.length > 0) {
        _state.isDowngraded = true;
        configureStorage({ isPremium: true, uid });
        setTierBadge('free');
        await loadProjects();
      } else if (_state.projects.length === 0) {
        await createDefaultProject();
      }
      resolve();
    });
  });
}

/**
 * Called when the user confirms they want to continue with the free plan.
 * Storage stays in Firestore mode so all boards remain readable.
 * Boards 4+ are locked in the UI until the user re-subscribes.
 */
function finalizeDowngrade() {
  const uid = _state.user?.uid ?? null;
  _state.tier = 'free';
  _state.isDowngraded = true;

  // Intentionally NOT calling configureStorage({ isPremium: false }) here.
  // Storage stays in Firestore mode so all boards remain readable.
  setTierBadge('free');
  stopListening();
  loadProjects().catch(() => {});
  showToast(
    'Switched to Free plan. Your first 3 boards are fully accessible — the rest are locked until you upgrade.',
    'info',
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PENDING INVITES
// ══════════════════════════════════════════════════════════════════════════════

function queuePendingInviteCheck(user) {
  if (!user?.uid || !user?.email) return;
  const key = `${user.uid}:${_state.tier}`;
  if (_state.pendingInviteCheckKey === key) return;
  _state.pendingInviteCheckKey = key;
  checkPendingInvites(user).catch(() => {});
}

function openInviteUpgrade() {
  closeModal('pending-invites');
  closeModal('invitation-manager');
  const note = document.getElementById('upgrade-note');
  if (note) {
    note.textContent = 'Upgrade to Premium to accept invitations and collaborate with your team.';
  }
  openModal('upgrade');
}

function getInviteRoleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'editor') return 'Editor';
  return 'Viewer';
}

function getInviteStatusLabel(status) {
  if (status === 'accepted') return 'Accepted';
  if (status === 'declined') return 'Declined';
  if (status === 'revoked') return 'Revoked';
  return 'Pending';
}

function toInviteDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date?.getTime?.()) ? null : date;
  }
  if (typeof value?.seconds === 'number') {
    const date = new Date(value.seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatInviteDate(value) {
  const date = toInviteDate(value);
  if (!date) return 'Unknown date';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderInvitationEmptyState(container, message) {
  container.innerHTML = `<div class="invitation-empty">${escapeHtml(message)}</div>`;
}

function getInvitationSearchQuery() {
  return (document.getElementById('invitation-manager-search-input')?.value ?? '')
    .trim()
    .toLowerCase();
}

function invitationMatchesQuery(invite, query) {
  if (!query) return true;

  const text = [
    invite.projectName,
    invite.email,
    invite.invitedByName,
    getInviteRoleLabel(invite.role),
    getInviteStatusLabel(invite.status),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text.includes(query);
}

async function openInvitationProject(projectId) {
  if (!projectId) return;

  closeModal('invitation-manager');

  if (!_state.projects.some((project) => project.id === projectId)) {
    await loadProjects();
  }

  if (!_state.projects.some((project) => project.id === projectId)) {
    showToast('That project is not available in your workspace yet.', 'warning');
    return;
  }

  await selectProject(projectId);
}

async function acceptInvitation(invite) {
  if (!invite?.id || !_state.user?.uid) throw new Error('Invite not available');

  await acceptInvite(invite.id, invite.projectId, invite.role, _state.user.uid);
  syncCollaboratorInfo(invite.projectId, _state.user.uid, {
    name: _state.user.displayName,
    email: _state.user.email,
    photoURL: _state.user.photoURL,
  }).catch(() => {});

  showToast('Invitation accepted! Reloading projects...', 'success');
  await loadProjects();
}

async function declineInvitation(inviteId) {
  if (!inviteId) throw new Error('Invite not available');
  await declineInvite(inviteId, _state.user?.uid ?? null);
  showToast('Invitation declined', 'success');
}

async function revokeSentInvitation(inviteId) {
  if (!inviteId) throw new Error('Invite not available');
  await revokeInvite(inviteId, _state.user?.uid ?? null);
  showToast('Invitation revoked', 'success');
}

function renderReceivedInvites(container, invites, { onChanged, emptyMessage } = {}) {
  container.innerHTML = '';

  if (!invites.length) {
    renderInvitationEmptyState(container, emptyMessage ?? 'No pending invitations right now.');
    return;
  }

  for (const invite of invites) {
    const row = document.createElement('div');
    row.className = 'pending-invite-row';
    row.dataset.inviteId = invite.id;

    const acceptLabel = _state.tier === 'premium' ? 'Accept' : 'Upgrade';
    row.innerHTML = `
      <div class="pending-invite-info">
        <div class="pending-invite-project">${escapeHtml(invite.projectName ?? 'Unknown Project')}</div>
        <div class="pending-invite-meta">
          Invited by <strong>${escapeHtml(invite.invitedByName ?? 'Someone')}</strong>
          · Role: <span class="role-chip">${escapeHtml(getInviteRoleLabel(invite.role))}</span>
        </div>
      </div>
      <div class="pending-invite-actions">
        <button class="btn-primary btn-sm accept-invite-btn" type="button">${acceptLabel}</button>
        <button class="btn-ghost btn-sm decline-invite-btn" type="button">Decline</button>
      </div>`;

    const acceptBtn = row.querySelector('.accept-invite-btn');
    const declineBtn = row.querySelector('.decline-invite-btn');

    acceptBtn?.addEventListener('click', async () => {
      if (_state.tier !== 'premium') {
        openInviteUpgrade();
        return;
      }

      if (!acceptBtn || !declineBtn) return;
      acceptBtn.disabled = true;
      declineBtn.disabled = true;
      acceptBtn.textContent = 'Accepting...';

      try {
        await acceptInvitation(invite);
        await onChanged?.();
      } catch (err) {
        console.error('[acceptInvite]', err);
        showToast('Failed to accept invite. Try again.', 'error');
        acceptBtn.disabled = false;
        declineBtn.disabled = false;
        acceptBtn.textContent = 'Accept';
      }
    });

    declineBtn?.addEventListener('click', async () => {
      if (!acceptBtn || !declineBtn) return;
      acceptBtn.disabled = true;
      declineBtn.disabled = true;
      declineBtn.textContent = 'Declining...';

      try {
        await declineInvitation(invite.id);
        await onChanged?.();
      } catch (err) {
        console.error('[declineInvite]', err);
        showToast('Failed to decline invite. Try again.', 'error');
        acceptBtn.disabled = false;
        declineBtn.disabled = false;
        acceptBtn.textContent = _state.tier === 'premium' ? 'Accept' : 'Upgrade';
        declineBtn.textContent = 'Decline';
      }
    });

    container.appendChild(row);
  }
}

function renderSentInvites(container, invites, { onChanged, emptyMessage } = {}) {
  container.innerHTML = '';

  if (!invites.length) {
    renderInvitationEmptyState(container, emptyMessage ?? 'No invitations sent yet.');
    return;
  }

  for (const invite of invites) {
    const status = invite.status ?? 'pending';
    const row = document.createElement('div');
    row.className = 'pending-invite-row';
    row.dataset.inviteId = invite.id;

    row.innerHTML = `
      <div class="pending-invite-info">
        <div class="pending-invite-project">${escapeHtml(invite.projectName ?? 'Unknown Project')}</div>
        <div class="pending-invite-meta">
          To <strong>${escapeHtml(invite.email ?? 'Unknown email')}</strong>
          · Role: <span class="role-chip">${escapeHtml(getInviteRoleLabel(invite.role))}</span>
          · Sent ${escapeHtml(formatInviteDate(invite.createdAt))}
        </div>
      </div>
      <div class="pending-invite-actions">
        <span class="invite-status-badge invite-status-badge--${escapeHtml(status)}">${escapeHtml(getInviteStatusLabel(status))}</span>
        ${status === 'pending' ? '<button class="btn-ghost btn-sm revoke-invite-btn" type="button">Revoke</button>' : ''}
      </div>`;

    const revokeBtn = row.querySelector('.revoke-invite-btn');
    revokeBtn?.addEventListener('click', async () => {
      revokeBtn.disabled = true;
      revokeBtn.textContent = 'Revoking...';

      try {
        await revokeSentInvitation(invite.id);
        await onChanged?.();
      } catch (err) {
        console.error('[revokeInvite]', err);
        showToast('Failed to revoke invite. Try again.', 'error');
        revokeBtn.disabled = false;
        revokeBtn.textContent = 'Revoke';
      }
    });

    container.appendChild(row);
  }
}

function renderAcceptedInvites(container, invites, { emptyMessage } = {}) {
  container.innerHTML = '';

  if (!invites.length) {
    renderInvitationEmptyState(container, emptyMessage ?? 'No joined projects from invitations yet.');
    return;
  }

  for (const invite of invites) {
    const row = document.createElement('div');
    row.className = 'pending-invite-row';
    row.innerHTML = `
      <div class="pending-invite-info">
        <button class="invitation-project-link" type="button">${escapeHtml(invite.projectName ?? 'Unknown Project')}</button>
        <div class="pending-invite-meta">
          Your role: <span class="role-chip">${escapeHtml(getInviteRoleLabel(invite.role))}</span>
          · Accepted ${escapeHtml(formatInviteDate(invite.acceptedAt ?? invite.createdAt))}
        </div>
      </div>
      <div class="pending-invite-actions">
        <span class="invite-status-badge invite-status-badge--accepted">Accepted</span>
      </div>`;
    const meta = row.querySelector('.pending-invite-meta');
    if (meta) {
      meta.innerHTML = `Invited by <strong>${escapeHtml(invite.invitedByName ?? 'Someone')}</strong> &middot; Your role: <span class="role-chip">${escapeHtml(getInviteRoleLabel(invite.role))}</span> &middot; Accepted ${escapeHtml(formatInviteDate(invite.acceptedAt ?? invite.createdAt))}`;
    }

    row.querySelector('.invitation-project-link')?.addEventListener('click', () => {
      openInvitationProject(invite.projectId).catch((err) => {
        console.error('[openInvitationProject]', err);
        showToast('Failed to open project', 'error');
      });
    });

    container.appendChild(row);
  }
}

async function populateInvitationManager() {
  const receivedList = document.getElementById('received-invitations-list');
  const acceptedList = document.getElementById('accepted-invitations-list');
  const sentList = document.getElementById('sent-invitations-list');
  const query = getInvitationSearchQuery();
  if (!receivedList || !acceptedList || !sentList) return;

  if (!_state.user?.email) {
    renderInvitationEmptyState(receivedList, 'Sign in to review invitations.');
    renderInvitationEmptyState(acceptedList, 'Sign in to review invitations.');
    renderInvitationEmptyState(sentList, 'Sign in to review invitations.');
    return;
  }

  renderInvitationEmptyState(receivedList, 'Loading invitations...');
  renderInvitationEmptyState(acceptedList, 'Loading invitations...');
  renderInvitationEmptyState(sentList, 'Loading invitations...');

  try {
    const [receivedInvites, acceptedInvites, sentInvites] = await Promise.all([
      getPendingInvites(_state.user.email),
      getAcceptedInvites(_state.user.uid, _state.user.email),
      getSentInvites(_state.user.uid),
    ]);
    const activeProjectIds = new Set((_state.projects ?? []).map((project) => project.id).filter(Boolean));
    const visibleAcceptedInvites = acceptedInvites.filter((invite) => invite.projectId && activeProjectIds.has(invite.projectId));

    const refreshManager = () => populateInvitationManager().catch(() => {});
    renderReceivedInvites(
      receivedList,
      receivedInvites.filter((invite) => invitationMatchesQuery(invite, query)),
      {
        onChanged: refreshManager,
        emptyMessage: query ? 'No pending invitations match your search.' : 'No pending invitations right now.',
      },
    );
    renderAcceptedInvites(
      acceptedList,
      visibleAcceptedInvites.filter((invite) => invitationMatchesQuery(invite, query)),
      {
        emptyMessage: query ? 'No joined projects match your search.' : 'No joined projects from invitations yet.',
      },
    );
    renderSentInvites(
      sentList,
      sentInvites.filter((invite) => invitationMatchesQuery(invite, query)),
      {
        onChanged: refreshManager,
        emptyMessage: query ? 'No sent invitations match your search.' : 'No invitations sent yet.',
      },
    );
  } catch (err) {
    console.error('[invitationManager]', err);
    renderInvitationEmptyState(receivedList, 'Could not load received invitations.');
    renderInvitationEmptyState(acceptedList, 'Could not load joined projects.');
    renderInvitationEmptyState(sentList, 'Could not load sent invitations.');
  }
}

async function openInvitationManager() {
  const searchInput = document.getElementById('invitation-manager-search-input');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = () => populateInvitationManager().catch(() => {});
  }
  closeModal('settings');
  openModal('invitation-manager');
  await populateInvitationManager();
  setTimeout(() => searchInput?.focus(), 50);
}

async function checkPendingInvites(user) {
  if (!user?.email) return;
  let invites;
  try {
    invites = await getPendingInvites(user.email);
  } catch (err) {
    console.warn('[invites] Could not fetch pending invites:', err.message);
    return;
  }
  if (!invites.length) return;

  const list = document.getElementById('pending-invites-list');
  if (!list) return;
  list.innerHTML = '';

  if (_state.tier !== 'premium') {
    const notice = document.createElement('div');
    notice.className = 'invitation-empty';
    notice.innerHTML = `
      <p style="margin-bottom:8px">You have <strong>${invites.length}</strong> pending invitation(s), but collaboration requires a <strong>Premium</strong> subscription.</p>
      <button class="btn-primary btn-sm" id="invite-upgrade-btn" type="button">Upgrade to Premium</button>`;
    list.appendChild(notice);
    document.getElementById('invite-upgrade-btn')?.addEventListener('click', openInviteUpgrade, { once: true });
    openModal('pending-invites');
    return;
  }

  const refreshPendingInvites = async () => {
    const remainingInvites = await getPendingInvites(user.email);
    if (!remainingInvites.length) {
      closeModal('pending-invites');
      return;
    }
    renderReceivedInvites(list, remainingInvites, { onChanged: refreshPendingInvites });
  };

  renderReceivedInvites(list, invites, { onChanged: refreshPendingInvites });
  openModal('pending-invites');
  return;

  for (const invite of invites) {
    const row = document.createElement('div');
    row.className = 'pending-invite-row';
    row.dataset.inviteId = invite.id;

    const roleLabel = invite.role === 'admin' ? 'Admin'
                    : invite.role === 'editor' ? 'Editor'
                    : 'Viewer';

    row.innerHTML = `
      <div class="pending-invite-info">
        <div class="pending-invite-project">${escapeHtml(invite.projectName ?? 'Unknown Project')}</div>
        <div class="pending-invite-meta">
          Invited by <strong>${escapeHtml(invite.invitedByName ?? 'Someone')}</strong>
          · Role: <span class="role-chip">${escapeHtml(roleLabel)}</span>
        </div>
      </div>
      <div class="pending-invite-actions">
        <button class="btn-primary btn-sm accept-invite-btn" data-invite-id="${invite.id}">Accept</button>
        <button class="btn-ghost btn-sm decline-invite-btn" data-invite-id="${invite.id}">Decline</button>
      </div>`;

    list.appendChild(row);
  }

  // Wire accept buttons
  list.querySelectorAll('.accept-invite-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Accepting...';
      const inviteId = btn.dataset.inviteId;
      try {
        const invite = invites.find(i => i.id === inviteId);
        if (!invite) throw new Error('Invite not found');
        await acceptInvite(inviteId, invite.projectId, invite.role, user.uid);
        syncCollaboratorInfo(invite.projectId, user.uid, {
          name:     user.displayName,
          email:    user.email,
          photoURL: user.photoURL,
        }).catch(() => {});
        btn.closest('.pending-invite-row').remove();
        showToast('Invitation accepted! Reloading projects...', 'success');
        await loadProjects();
      } catch (err) {
        console.error('[acceptInvite]', err);
        showToast('Failed to accept invite. Try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Accept';
      }
      if (!list.children.length) closeModal('pending-invites');
    });
  });

  // Wire decline buttons
  list.querySelectorAll('.decline-invite-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.pending-invite-row').remove();
      if (!list.children.length) closeModal('pending-invites');
    });
  });

  openModal('pending-invites');
}

// ══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════════════════════════════════════════

async function loadProjects() {
  try {
    _state.projects = await getProjects();

    renderProjectList();

    if (_state.projects.length === 0) {
      if (!_state.user) {
        await createDefaultProject();
      }
    } else {
      const saved = getSavedProjectId();
      const savedIdx = _state.projects.findIndex((p) => p.id === saved);

      const isLockedSaved = _state.isDowngraded && savedIdx >= FREE_LIMIT;
      const exists = !isLockedSaved && savedIdx !== -1;

      await selectProject(exists ? saved : _state.projects[0].id);
    }
  } catch (err) {
    console.error('[loadProjects]', err);
    showToast('Error loading projects', 'error');
  }
}

async function createDefaultProject() {
  try {
    const id = await createProject({
      name:        'My Board',
      description: 'Your first project',
      color:       '#6366f1',
    });
    _state.projects = [{ id, name: 'My Board', color: '#6366f1' }];
    renderProjectList();
    await selectProject(id);
  } catch (err) {
    if (err.message === 'FREE_LIMIT') {
      showToast('Project limit reached — upgrade to Premium', 'warning');
    } else {
      showToast('Failed to create default project', 'error');
    }
  }
}

async function selectProject(projectId) {
  // Guard: in downgrade mode, projects beyond FREE_LIMIT are locked
  if (_state.isDowngraded) {
    const idx = _state.projects.findIndex((p) => p.id === projectId);
    if (idx >= FREE_LIMIT) {
      document.getElementById('upgrade-note').textContent =
        'Upgrade to Premium to access all your boards.';
      openModal('upgrade');
      return;
    }
  }

  _state.currentProjectId  = projectId;
  window._currentProjectId = projectId;

  // Clear board filters, search, and close analytics when switching projects
  clearFilters();
  window._clearSearch?.();
  window._closeAnalytics?.();

  // Update project button label with status
  const project = _state.projects.find((p) => p.id === projectId);
  const projStatus = project?.projectStatus ?? 'new';
  const projStatusLabel = projStatus === 'in-progress' ? 'In Progress'
    : projStatus.charAt(0).toUpperCase() + projStatus.slice(1);

  const projectNameEl = document.getElementById('current-project-name');
  if (projectNameEl) {
    projectNameEl.textContent = `${project?.name ?? 'Unknown'} — ${projStatusLabel}`;
  }

  // Also update #project-btn-label if it exists
  const btnLabel = document.getElementById('project-btn-label');
  if (btnLabel) {
    btnLabel.textContent = project?.name ?? 'Unknown';
  }

  // Mark active in dropdown list
  document.querySelectorAll('.project-list-item').forEach((li) => {
    li.classList.toggle('active', li.dataset.projectId === projectId);
  });

  // Save last-used project to localStorage
  localStorage.setItem('flowlane_lastProjectId', projectId);

  // ── Determine user role for this project ─────────────────────────────────
  let role = 'admin'; // free/local users always own their data
  if (_state.tier === 'premium' && _state.user) {
    try {
      const proj = await getProject(projectId);
      role = proj?.collaborators?.[_state.user.uid] ?? 'viewer';

      // Sync this user's display info for the assignee dropdown
      syncCollaboratorInfo(projectId, _state.user.uid, {
        name:     _state.user.displayName,
        email:    _state.user.email,
        photoURL: _state.user.photoURL,
      }).catch(() => {});

      // Track project status: set to "new" if not already set
      if (!proj?.projectStatus) {
        updateProject(projectId, { projectStatus: 'new', openedAt: new Date().toISOString() }).catch(() => {});
      }
    } catch (_) { /* offline — default to admin to avoid locking out */ }
  }
  setUserRole(role);
  applyRoleToUI(role);

  // Start or stop collaboration listeners
  if (_state.tier === 'premium') {
    startListening(projectId);
  } else {
    stopListening();
    await loadCurrentBoard();
  }
}

/**
 * Show / hide UI elements based on the user's role for the current project.
 *  admin  – full access
 *  editor – board editing, no project management / collaborator management
 *  viewer – read-only
 */
function applyRoleToUI(role) {
  const isEditor = role === 'admin' || role === 'editor';
  const isAdmin  = role === 'admin';

  // Add-column buttons (editor & admin)
  document.getElementById('add-column-btn')?.classList.toggle('hidden', !isEditor);
  document.getElementById('add-column-inline-btn')?.classList.toggle('hidden', !isEditor);

  // Invite collaborators — admin only
  document.getElementById('invite-btn')?.classList.toggle('hidden', !isAdmin);

  // Delete-project button inside the settings modal — extra safety
  document.getElementById('delete-project-btn')?.classList.toggle('hidden', !isAdmin);

  // Show a small role badge in the header so the user always knows their access level
  let roleBadgeEl = document.getElementById('role-badge');
  if (!roleBadgeEl) {
    roleBadgeEl = document.createElement('span');
    roleBadgeEl.id = 'role-badge';
    roleBadgeEl.style.cssText =
      'font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;' +
      'background:var(--bg-active);color:var(--text-secondary);text-transform:uppercase;' +
      'letter-spacing:.5px;vertical-align:middle;';
    document.getElementById('current-project-name')?.parentElement?.appendChild(roleBadgeEl);
  }
  const labels = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
  roleBadgeEl.textContent  = labels[role] ?? role;
  roleBadgeEl.style.display = isAdmin ? 'none' : '';
}

// ══════════════════════════════════════════════════════════════════════════════
// PROJECT LIST RENDERING
// ══════════════════════════════════════════════════════════════════════════════

function renderProjectList() {
  const ul = document.getElementById('project-list');
  if (!ul) return;
  ul.innerHTML = '';

  // Sort: active projects first, completed/cancelled at the bottom
  const sortedProjects = [..._state.projects].sort((a, b) => {
    const terminalA = (a.projectStatus === 'completed' || a.projectStatus === 'cancelled') ? 1 : 0;
    const terminalB = (b.projectStatus === 'completed' || b.projectStatus === 'cancelled') ? 1 : 0;
    if (terminalA !== terminalB) return terminalA - terminalB;
    return 0;
  });

  sortedProjects.forEach((p) => {
    const origIdx = _state.projects.indexOf(p);
    const isLocked = _state.isDowngraded && origIdx >= FREE_LIMIT;
    const status = p.projectStatus ?? 'new';

    const li = document.createElement('li');
    li.className = [
      'project-list-item',
      p.id === _state.currentProjectId && !isLocked ? 'active' : '',
      isLocked ? 'project-list-item--locked' : '',
    ].filter(Boolean).join(' ');
    li.dataset.projectId = p.id;

    // Project name area
    const nameArea = document.createElement('div');
    nameArea.className = 'project-list-item__name';

    const dot = document.createElement('div');
    dot.className = 'project-dot';
    dot.style.background = isLocked ? 'var(--text-muted)' : (p.color ?? '#6366f1');

    const nameSpan = document.createElement('span');
    const statusLabel = status === 'in-progress' ? 'In Progress'
      : status.charAt(0).toUpperCase() + status.slice(1);
    nameSpan.textContent = `${p.name} — ${statusLabel}`;

    nameArea.appendChild(dot);
    nameArea.appendChild(nameSpan);

    if (isLocked) {
      // Lock icon to signal the board is inaccessible on the free tier
      const lockIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lockIcon.setAttribute('class', 'project-lock-icon');
      lockIcon.setAttribute('width', '11');
      lockIcon.setAttribute('height', '11');
      lockIcon.setAttribute('viewBox', '0 0 24 24');
      lockIcon.setAttribute('fill', 'none');
      lockIcon.setAttribute('stroke', 'currentColor');
      lockIcon.setAttribute('stroke-width', '2.5');
      lockIcon.innerHTML =
        '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
        '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
      nameArea.appendChild(lockIcon);

      nameArea.addEventListener('click', () => {
        document.getElementById('project-dropdown')?.classList.add('hidden');
        document.getElementById('upgrade-note').textContent =
          'Upgrade to Premium to access all your boards.';
        openModal('upgrade');
      });
    } else {
      nameArea.addEventListener('click', async () => {
        await selectProject(p.id);
        document.getElementById('project-dropdown')?.classList.add('hidden');
      });

      // Edit (pencil) button — only for accessible projects
      const editBtn = document.createElement('button');
      editBtn.className = 'project-edit-btn';
      editBtn.title = 'Rename project';
      editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>`;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('project-dropdown')?.classList.add('hidden');
        openEditProjectModal(p);
      });
      li.appendChild(editBtn);
    }

    li.appendChild(nameArea);
    ul.appendChild(li);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EDIT PROJECT MODAL
// ══════════════════════════════════════════════════════════════════════════════

/** Track whether the code field was auto-set or manually typed. */
let _codeAutoSet = true;

function openEditProjectModal(project) {
  document.getElementById('edit-project-name').value = project.name ?? '';
  document.getElementById('edit-project-code').value = project.code ?? '';
  document.getElementById('edit-project-desc').value = project.description ?? '';

  // Highlight matching color swatch
  _editProjectColor = project.color ?? '#6c63ff';
  document.querySelectorAll('#edit-project-color-picker .color-swatch').forEach(b => {
    b.classList.toggle('active', b.dataset.color === _editProjectColor);
  });

  // ── Status, Remarks, Audit Trail ──────────────────────────────────────
  const statusGroup   = document.getElementById('project-edit-status-group');
  const remarksGroup  = document.getElementById('project-edit-remarks-group');
  const auditGroup    = document.getElementById('project-edit-audit-group');
  const statusSelect  = document.getElementById('edit-project-status');
  const remarksField  = document.getElementById('edit-project-remarks');

  const isAdmin = canAdmin();
  const currentStatus = project.projectStatus ?? 'new';

  // Show status dropdown (admin only)
  if (statusGroup) {
    statusGroup.classList.toggle('hidden', !isAdmin);
    if (statusSelect) statusSelect.value = currentStatus;
  }

  // Show/hide remarks based on selected status
  const toggleRemarks = () => {
    const sel = statusSelect?.value ?? 'new';
    const needsRemarks = sel === 'completed' || sel === 'cancelled' || sel === 'deferred';
    remarksGroup?.classList.toggle('hidden', !needsRemarks || !isAdmin);
  };
  statusSelect?.removeEventListener('change', toggleRemarks);
  statusSelect?.addEventListener('change', toggleRemarks);
  toggleRemarks();

  // Pre-fill existing remarks
  if (remarksField) {
    remarksField.value = project.completionRemarks
      ?? project.cancellationRemarks
      ?? project.deferralRemarks
      ?? '';
  }

  // Audit Trail — visible for premium users
  if (auditGroup) auditGroup.classList.toggle('hidden', !isPremiumMode());
  if (isPremiumMode()) loadProjectAuditLog(project.id);

  // Populate collaborators in edit modal
  populateCollaborators(_state.currentProjectId).catch(() => {});

  openModal('edit-project');
  setTimeout(() => document.getElementById('edit-project-name')?.focus(), 50);
}

/** Load and render audit log entries in the edit modal. */
async function loadProjectAuditLog(projectId) {
  const logEl = document.getElementById('project-audit-log');
  if (!logEl) return;
  logEl.innerHTML = '';

  try {
    const entries = await getProjectAuditLog(projectId);
    if (entries.length === 0) {
      logEl.innerHTML = '<div class="audit-log-empty">No audit entries yet</div>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'audit-log-entry';

      const timeEl = document.createElement('span');
      timeEl.className = 'audit-log-entry__time';
      const ts = entry.timestamp?.seconds
        ? new Date(entry.timestamp.seconds * 1000)
        : (entry.timestamp ? new Date(entry.timestamp) : null);
      timeEl.textContent = ts ? ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

      const actionEl = document.createElement('span');
      actionEl.className = 'audit-log-entry__action';

      const statusLabel = (entry.newStatus ?? '').replace('-', ' ');
      actionEl.textContent = 'Status changed to ';
      const statusSpan = document.createElement('span');
      statusSpan.className = 'audit-log-entry__status';
      statusSpan.textContent = statusLabel;
      actionEl.appendChild(statusSpan);

      if (entry.remarks) {
        const rem = document.createElement('div');
        rem.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:1px;font-style:italic';
        rem.textContent = `"${entry.remarks}"`;
        actionEl.appendChild(rem);
      }

      row.appendChild(timeEl);
      row.appendChild(actionEl);
      logEl.appendChild(row);
    }
  } catch (err) {
    console.error('[loadAuditLog]', err);
    logEl.innerHTML = '<div class="audit-log-empty">No audit entries yet</div>';
  }
}

/** Derive a suggested code from a project name: first letters of each word, max 5 chars. */
function suggestCode(name) {
  return name.trim().split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 5) || 'PRJ';
}

// updateCodePreview removed — no longer needed with separate modals

// ══════════════════════════════════════════════════════════════════════════════
// BOARD LOADING
// ══════════════════════════════════════════════════════════════════════════════

async function loadCurrentBoard() {
  const projectId = window._currentProjectId;
  if (!projectId) return;

  try {
    const columns = await getColumns(projectId);
    const cardsByColumn = {};
    for (const col of columns) {
      cardsByColumn[col.id] = await getCards(projectId, col.id);
    }
    renderBoard(columns, cardsByColumn);
  } catch (err) {
    console.error('[loadCurrentBoard]', err);
    showToast('Error loading board', 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STATIC BUTTON WIRING
// ══════════════════════════════════════════════════════════════════════════════

function wireStaticButtons() {

  // ── Auth screen ─────────────────────────────────────────────────────────

  document.getElementById('google-sign-in-btn')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('[SignIn]', err);
      showToast('Sign-in failed. Check your configuration.', 'error');
    }
  });

  // ── Premium wall ─────────────────────────────────────────────────────────
  document.getElementById('premium-wall-subscribe-btn')?.addEventListener('click', () => {
    startCheckout(_state.user?.uid);
  });

  document.getElementById('premium-wall-sign-out-btn')?.addEventListener('click', async () => {
    await signOut();
  });

  // ── Header ───────────────────────────────────────────────────────────────

  // ── View toggle (Board / Swimlane) ──────────────────────────────────────
  function updateViewToggle() {
    const swimlane = getSwimlaneMode();
    document.getElementById('view-board-btn')?.classList.toggle('view-toggle-btn--active', !swimlane);
    document.getElementById('view-swimlane-btn')?.classList.toggle('view-toggle-btn--active', swimlane);
    document.getElementById('swimlane-toggle-btn')?.classList.toggle('active', swimlane);
    const dvSel = document.getElementById('default-view-select');
    if (dvSel) dvSel.value = swimlane ? 'swimlane' : 'board';
  }

  updateViewToggle();

  document.getElementById('view-board-btn')?.addEventListener('click', () => {
    setSwimlaneMode(false);
    updateViewToggle();
  });
  document.getElementById('view-swimlane-btn')?.addEventListener('click', () => {
    setSwimlaneMode(true);
    updateViewToggle();
  });

  // Legacy swimlane toggle button (if present)
  document.getElementById('swimlane-toggle-btn')?.addEventListener('click', () => {
    const current = getSwimlaneMode();
    setSwimlaneMode(!current);
    document.getElementById('swimlane-toggle-btn')?.classList.toggle('active', !current);
    updateViewToggle();
  });

  // ── Theme buttons (settings modal) ────────────────────────────────────
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  // ── Search ──────────────────────────────────────────────────────────────

  const searchInput = document.getElementById('search-input')
                   || document.getElementById('board-search-input');
  const searchClear = document.getElementById('search-clear-btn');

  let _searchDebounce = null;
  searchInput?.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      const q = searchInput.value;
      searchCards(q);
      if (searchClear) searchClear.style.display = q ? '' : 'none';
    }, 120);
  });

  searchClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchCards('');
    if (searchClear) searchClear.style.display = 'none';
    searchInput?.focus();
  });

  // Clear search when project changes
  window._clearSearch = () => {
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
  };

  const inviteTabInviteBtn = document.getElementById('invite-tab-invite-btn');
  const inviteTabContactsBtn = document.getElementById('invite-tab-contacts-btn');
  const inviteTabPanel = document.getElementById('invite-tab-panel');
  const contactsTabPanel = document.getElementById('contacts-tab-panel');
  const inviteContactSearchInput = document.getElementById('invite-contact-search-input');
  const inviteContactSelected = document.getElementById('invite-contact-selected');
  const inviteContactOptions = document.getElementById('invite-contact-options');
  const inviteContactsList = document.getElementById('invite-contacts-list');
  const inviteContactNameInput = document.getElementById('invite-contact-name-input');
  const inviteContactEmailInput = document.getElementById('invite-contact-email-input');
  const sendInviteBtn = document.getElementById('send-invite-btn');

  const formatInviteContactLabel = (contact) => {
    if (!contact) return '';
    const name = contact.name?.trim();
    return name ? `${name} (${contact.email})` : contact.email;
  };

  const getSelectedInviteContact = () => (
    _inviteContacts.find((contact) => contact.email === _selectedInviteContactEmail) ?? null
  );

  const updateInviteSendButtonState = () => {
    if (!sendInviteBtn) return;
    sendInviteBtn.disabled = _inviteModalTab !== 'invite' || !_selectedInviteContactEmail;
  };

  const setInviteModalTab = (tab) => {
    _inviteModalTab = tab;
    inviteTabInviteBtn?.classList.toggle('active', tab === 'invite');
    inviteTabContactsBtn?.classList.toggle('active', tab === 'contacts');
    inviteTabPanel?.classList.toggle('hidden', tab !== 'invite');
    contactsTabPanel?.classList.toggle('hidden', tab !== 'contacts');
    updateInviteSendButtonState();
  };

  const renderSelectedInviteContact = () => {
    if (!inviteContactSelected) return;
    const contact = getSelectedInviteContact();
    if (!contact) {
      inviteContactSelected.classList.add('hidden');
      inviteContactSelected.textContent = '';
      return;
    }

    inviteContactSelected.classList.remove('hidden');
    inviteContactSelected.textContent = `Selected contact: ${formatInviteContactLabel(contact)}`;
  };

  const getFilteredInviteContacts = (query = '') => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return _inviteContacts;

    return _inviteContacts.filter((contact) => {
      const haystack = [contact.name, contact.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  };

  function renderInviteContactOptions(query = '') {
    if (!inviteContactOptions) return;

    inviteContactOptions.innerHTML = '';

    if (!_inviteContacts.length) {
      inviteContactOptions.innerHTML = '<div class="invite-contact-empty">No contacts yet. Add one in the Contacts tab before sending an invite.</div>';
      return;
    }

    const contacts = getFilteredInviteContacts(query);
    if (!contacts.length) {
      inviteContactOptions.innerHTML = '<div class="invite-contact-empty">No contacts match your search.</div>';
      return;
    }

    for (const contact of contacts) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'invite-contact-option' + (contact.email === _selectedInviteContactEmail ? ' is-selected' : '');
      option.innerHTML = `
        <span class="invite-contact-details">
          <span class="invite-contact-name">${escapeHtml(contact.name || contact.email)}</span>
          <span class="invite-contact-email">${escapeHtml(contact.email)}</span>
        </span>`;
      option.addEventListener('click', () => {
        _selectedInviteContactEmail = contact.email;
        if (inviteContactSearchInput) {
          inviteContactSearchInput.value = formatInviteContactLabel(contact);
        }
        renderSelectedInviteContact();
        renderInviteContactOptions(inviteContactSearchInput?.value ?? '');
        updateInviteSendButtonState();
      });
      inviteContactOptions.appendChild(option);
    }
  }

  const renderInviteContactsList = () => {
    if (!inviteContactsList) return;

    inviteContactsList.innerHTML = '';
    if (!_inviteContacts.length) {
      inviteContactsList.innerHTML = '<div class="invite-contact-empty">No contacts saved yet.</div>';
      return;
    }

    for (const contact of _inviteContacts) {
      const row = document.createElement('div');
      row.className = 'invite-contact-row';
      row.innerHTML = `
        <div class="invite-contact-details">
          <div class="invite-contact-name">${escapeHtml(contact.name || contact.email)}</div>
          <div class="invite-contact-email">${escapeHtml(contact.email)}</div>
        </div>
        <button class="btn-ghost" type="button">Use in Invite</button>`;
      row.querySelector('button')?.addEventListener('click', () => {
        _selectedInviteContactEmail = contact.email;
        if (inviteContactSearchInput) {
          inviteContactSearchInput.value = formatInviteContactLabel(contact);
        }
        renderSelectedInviteContact();
        renderInviteContactOptions(inviteContactSearchInput?.value ?? '');
        setInviteModalTab('invite');
        inviteContactSearchInput?.focus();
      });
      inviteContactsList.appendChild(row);
    }
  };

  const loadInviteContactsForModal = async () => {
    _inviteContacts = _state.user?.uid ? await getInviteContacts(_state.user.uid) : [];

    if (_selectedInviteContactEmail && !_inviteContacts.some((contact) => contact.email === _selectedInviteContactEmail)) {
      _selectedInviteContactEmail = null;
    }

    renderSelectedInviteContact();
    renderInviteContactOptions(inviteContactSearchInput?.value ?? '');
    renderInviteContactsList();
    updateInviteSendButtonState();
  };

  inviteTabInviteBtn?.addEventListener('click', () => setInviteModalTab('invite'));
  inviteTabContactsBtn?.addEventListener('click', () => setInviteModalTab('contacts'));
  inviteContactSearchInput?.addEventListener('input', () => {
    const selectedContact = getSelectedInviteContact();
    if (selectedContact && inviteContactSearchInput.value.trim() !== formatInviteContactLabel(selectedContact)) {
      _selectedInviteContactEmail = null;
    }
    renderSelectedInviteContact();
    renderInviteContactOptions(inviteContactSearchInput.value);
    updateInviteSendButtonState();
  });
  document.getElementById('add-invite-contact-btn')?.addEventListener('click', async () => {
    const name = inviteContactNameInput?.value?.trim() ?? '';
    const email = inviteContactEmailInput?.value?.trim()?.toLowerCase?.() ?? '';

    if (!name || !email || !email.includes('@')) {
      showToast('Enter a valid contact name and email address', 'warning');
      return;
    }

    if (!_state.user?.uid) {
      showToast('Sign in to save contacts', 'warning');
      return;
    }

    try {
      await upsertInviteContact(_state.user.uid, { name, email });
      if (inviteContactNameInput) inviteContactNameInput.value = '';
      if (inviteContactEmailInput) inviteContactEmailInput.value = '';
      await loadInviteContactsForModal();
      const savedContact = _inviteContacts.find((contact) => contact.email === email);
      if (savedContact) {
        _selectedInviteContactEmail = savedContact.email;
        if (inviteContactSearchInput) {
          inviteContactSearchInput.value = formatInviteContactLabel(savedContact);
        }
      }
      renderSelectedInviteContact();
      renderInviteContactOptions(inviteContactSearchInput?.value ?? '');
      setInviteModalTab('invite');
      showToast('Contact saved', 'success');
    } catch (err) {
      console.error('[inviteContact]', err);
      showToast('Failed to save contact', 'error');
    }
  });

  // ── Invite button ───────────────────────────────────────────────────────
  document.getElementById('invite-btn')?.addEventListener('click', async () => {
    _selectedInviteContactEmail = null;
    _inviteModalTab = 'invite';
    if (inviteContactSearchInput) inviteContactSearchInput.value = '';
    if (inviteContactNameInput) inviteContactNameInput.value = '';
    if (inviteContactEmailInput) inviteContactEmailInput.value = '';
    openModal('invite');
    try {
      await Promise.all([
        loadInviteContactsForModal(),
        populateCollaborators(_state.currentProjectId),
      ]);
    } catch (err) {
      console.error('[inviteModal]', err);
      showToast('Failed to load invite contacts', 'error');
    }
    setInviteModalTab(_inviteContacts.length ? 'invite' : 'contacts');
    setTimeout(() => {
      (_inviteContacts.length ? inviteContactSearchInput : inviteContactNameInput)?.focus();
    }, 50);
  });

  // ── Manage Billing ──────────────────────────────────────────────────────
  document.getElementById('manage-billing-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    openBillingPortal();
  });

  // ── Sign out ────────────────────────────────────────────────────────────
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    await signOut();
  });

  // ── Settings ────────────────────────────────────────────────────────────
  document.getElementById('settings-btn')?.addEventListener('click', async () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');

    // Always show export/import
    const exportSection = document.getElementById('export-section');
    if (exportSection) exportSection.style.display = '';

    // Sync default-view selector to current view mode
    const dvSel = document.getElementById('default-view-select');
    if (dvSel) dvSel.value = getSwimlaneMode() ? 'swimlane' : 'board';

    // Show project status in settings
    const currentProj = _state.projects.find(p => p.id === _state.currentProjectId);
    const pStatus = currentProj?.projectStatus ?? 'new';
    const statusBadge = document.getElementById('current-project-status-badge');
    if (statusBadge) {
      const statusLabels = {
        'new': 'New',
        'in-progress': 'In Progress',
        'completed': 'Completed',
        'cancelled': 'Cancelled',
        'deferred': 'Deferred',
      };
      statusBadge.textContent = statusLabels[pStatus] ?? pStatus;
      statusBadge.className = `project-status-badge project-status-badge--${pStatus}`;
    }

    // Show/hide Change Status button — admins can always change status
    const changeStatusBtn = document.getElementById('change-project-status-btn');
    if (changeStatusBtn) {
      changeStatusBtn.style.display = canAdmin() ? '' : 'none';
    }

    const invitationsSection = document.getElementById('invitations-section');
    if (invitationsSection) {
      invitationsSection.style.display = _state.user ? '' : 'none';
    }

    openModal('settings');
    loadStorageUsage().catch(() => {});
  });

  // ── Analytics ───────────────────────────────────────────────────────────
  const analyticsBtn   = document.getElementById('analytics-btn');
  const analyticsView  = document.getElementById('analytics-view');
  const analyticsClose = document.getElementById('analytics-close-btn');
  const boardWrapper   = document.getElementById('board');

  function openAnalytics() {
    const { columns, cardsByColumn } = getAnalyticsData();
    const projName = document.getElementById('project-btn-label')?.textContent ?? '';
    const nameEl   = document.getElementById('analytics-project-name');
    if (nameEl) nameEl.textContent = projName;
    renderAnalytics({ columns, cardsByColumn });
    if (boardWrapper)  boardWrapper.style.display  = 'none';
    if (analyticsView) analyticsView.style.display = 'flex';
    analyticsBtn?.classList.add('analytics-active');
  }

  function closeAnalytics() {
    if (analyticsView) analyticsView.style.display = 'none';
    if (boardWrapper)  boardWrapper.style.display  = '';
    analyticsBtn?.classList.remove('analytics-active');
  }

  analyticsBtn?.addEventListener('click', () => {
    const isOpen = analyticsView?.style.display !== 'none';
    isOpen ? closeAnalytics() : openAnalytics();
  });

  analyticsClose?.addEventListener('click', closeAnalytics);

  // Expose for use when switching projects
  window._closeAnalytics = closeAnalytics;

  // ── Hamburger / Sidebar (mobile) ────────────────────────────────────────
  document.getElementById('hamburger-btn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar')
                 || document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('sidebar--open');
  });

  // ── Buy storage addon ───────────────────────────────────────────────────
  document.getElementById('buy-storage-btn')?.addEventListener('click', () => {
    purchaseStorageAddon();
  });

  // ── Add Column ──────────────────────────────────────────────────────────

  // ── Add Column (inline in Settings modal) ──────────────────────────────
  async function addColumnFromSettings() {
    const nameInput = document.getElementById('new-column-name');
    const name = nameInput?.value.trim();
    if (!name) { showToast('Column name is required', 'warning'); nameInput?.focus(); return; }

    const projectId = window._currentProjectId;
    const board     = document.getElementById('board');
    const order = board?.classList.contains('board--swimlane')
      ? board.querySelectorAll('.sl-col-header').length
      : board?.querySelectorAll('.column').length ?? 0;

    try {
      await createColumn(projectId, { name, color: '#7d8590', order });
      if (nameInput) nameInput.value = '';
      await loadCurrentBoard();
      showToast(`Column "${name}" added`, 'success');
    } catch (err) {
      showToast('Failed to add column', 'error');
      console.error('[addColumn settings]', err);
    }
  }

  document.getElementById('add-column-btn')?.addEventListener('click', addColumnFromSettings);

  document.getElementById('new-column-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addColumnFromSettings(); }
  });

  document.getElementById('add-column-inline-btn')?.addEventListener('click', () => {
    openModal('column');
  });

  let columnColor = '#7d8590';
  initColorPicker('column-color-picker', (c) => { columnColor = c; });

  document.getElementById('save-column-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('column-name-input').value.trim();
    if (!name) { showToast('Column name is required', 'warning'); return; }

    const projectId = window._currentProjectId;
    const board     = document.getElementById('board');
    const order = board?.classList.contains('board--swimlane')
      ? board.querySelectorAll('.sl-col-header').length
      : board?.querySelectorAll('.column').length ?? 0;

    try {
      await createColumn(projectId, { name, color: columnColor, order });
      closeModal('column');
      document.getElementById('column-name-input').value = '';
      await loadCurrentBoard();
      showToast(`Column "${name}" added`, 'success');
    } catch (err) {
      showToast('Failed to add column', 'error');
      console.error('[addColumn]', err);
    }
  });

  // ── New Project ─────────────────────────────────────────────────────────

  let _newProjectColor = '#6c63ff';

  // Color picker for new-project modal
  document.querySelectorAll('#new-project-color-picker .color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#new-project-color-picker .color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _newProjectColor = btn.dataset.color;
    });
  });

  document.getElementById('new-project-btn')?.addEventListener('click', () => {
    document.getElementById('project-dropdown')?.classList.add('hidden');

    if (_state.isDowngraded) {
      document.getElementById('upgrade-note').textContent =
        'Upgrade to Premium to create unlimited boards.';
      openModal('upgrade');
      return;
    }

    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-code').value = '';
    document.getElementById('new-project-desc').value = '';
    _newProjectColor = '#6c63ff';
    document.querySelectorAll('#new-project-color-picker .color-swatch').forEach(b => b.classList.remove('active'));
    document.querySelector('#new-project-color-picker .color-swatch[data-color="#6c63ff"]')?.classList.add('active');

    openModal('new-project');
    setTimeout(() => document.getElementById('new-project-name')?.focus(), 50);
  });

  // Auto-suggest code from name
  document.getElementById('new-project-name')?.addEventListener('input', (e) => {
    const codeInput = document.getElementById('new-project-code');
    if (codeInput && !codeInput.dataset.manual) {
      codeInput.value = suggestCode(e.target.value);
    }
  });

  document.getElementById('new-project-code')?.addEventListener('input', (e) => {
    const clean = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
    e.target.value = clean;
    e.target.dataset.manual = clean ? 'true' : '';
  });

  // ── Create Project Button ──────────────────────────────────────────────

  document.getElementById('create-project-btn')?.addEventListener('click', async () => {
    const name  = document.getElementById('new-project-name').value.trim();
    const code  = (document.getElementById('new-project-code')?.value ?? '')
                    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
    const desc  = document.getElementById('new-project-desc')?.value.trim() ?? '';
    const color = _newProjectColor;

    if (!name) { showToast('Project name is required', 'warning'); return; }
    if (code.length < 2) { showToast('Project code must be at least 2 letters', 'warning'); return; }

    const duplicate = _state.projects.find(p => (p.code ?? '').toUpperCase() === code);
    if (duplicate) {
      showToast(`Code "${code}" is already used by "${duplicate.name}"`, 'warning');
      return;
    }

    try {
      const id = await createProject({ name, code, description: desc, color });
      _state.projects.push({ id, name, code, color });
      renderProjectList();
      await selectProject(id);
      showToast(`Project "${name}" created`, 'success');
      closeModal('new-project');
    } catch (err) {
      if (err.message === 'FREE_LIMIT') {
        closeModal('new-project');
        openModal('upgrade');
        document.getElementById('upgrade-note').textContent =
          'You have reached the 3-project limit. Upgrade to create unlimited projects.';
      } else {
        showToast('Failed to create project', 'error');
      }
    }
  });

  // ── Save Project (edit mode) ───────────────────────────────────────────

  document.querySelectorAll('#edit-project-color-picker .color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#edit-project-color-picker .color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _editProjectColor = btn.dataset.color;
    });
  });

  document.getElementById('save-project-btn')?.addEventListener('click', async () => {
    const editProjectId = _state.currentProjectId;
    const name  = document.getElementById('edit-project-name').value.trim();
    const desc  = document.getElementById('edit-project-desc')?.value.trim() ?? '';
    const color = _editProjectColor;

    if (!name) { showToast('Project name is required', 'warning'); return; }

    try {
      await updateProject(editProjectId, { name, description: desc, color });

      // Handle status change if admin changed it
      const statusSelect = document.getElementById('edit-project-status');
      const remarksField = document.getElementById('edit-project-remarks');
      const p = _state.projects.find(x => x.id === editProjectId);
      const oldStatus = p?.projectStatus ?? 'new';
      const newStatus = statusSelect?.value ?? oldStatus;

      if (canAdmin() && newStatus !== oldStatus) {
        const remarks = remarksField?.value?.trim() ?? '';
        if (_state.tier === 'premium') {
          await updateProjectStatus(editProjectId, newStatus, remarks, _state.user?.uid ?? null);
        } else {
          const statusUpdates = { projectStatus: newStatus };
          if (newStatus === 'completed') {
            statusUpdates.completedAt = Date.now();
            statusUpdates.completionRemarks = remarks;
          } else if (newStatus === 'cancelled') {
            statusUpdates.cancelledAt = Date.now();
            statusUpdates.cancellationRemarks = remarks;
          } else if (newStatus === 'deferred') {
            statusUpdates.deferredAt = Date.now();
            statusUpdates.deferralRemarks = remarks;
          } else if (newStatus === 'in-progress') {
            statusUpdates.inProgressAt = Date.now();
          }
          await updateProject(editProjectId, statusUpdates);
        }
        if (p) p.projectStatus = newStatus;
      }

      if (p) { p.name = name; p.color = color; p.description = desc; }
      renderProjectList();
      document.getElementById('project-btn-label').textContent = name;
      showToast('Project updated', 'success');
      closeModal('edit-project');
    } catch (err) {
      showToast('Failed to save project', 'error');
    }
  });

  // ── Delete Project ──────────────────────────────────────────────────────

  function resetDeleteProjectFlow() {
    _state.deleteFlow = null;
    const input = document.getElementById('hard-delete-project-input');
    const confirmBtn = document.getElementById('confirm-hard-delete-project-btn');
    if (input) input.value = '';
    if (confirmBtn) confirmBtn.disabled = true;
  }

  function openDeleteProjectFlow(sourceModalName) {
    const project = _state.projects.find((x) => x.id === _state.currentProjectId);
    if (!project) return;

    _state.deleteFlow = {
      projectId: project.id,
      projectName: project.name ?? 'Untitled Project',
      sourceModalName,
    };

    const deleteCopy = document.getElementById('delete-project-copy');
    const hardDeleteCopy = document.getElementById('hard-delete-project-copy');
    const input = document.getElementById('hard-delete-project-input');
    const confirmBtn = document.getElementById('confirm-hard-delete-project-btn');

    if (deleteCopy) {
      deleteCopy.textContent = `Choose how you want to delete "${project.name}". Soft delete keeps it in Deleted Projects for 60 days.`;
    }
    if (hardDeleteCopy) {
      hardDeleteCopy.textContent = `Are you sure? This will permanently delete "${project.name}" and it will not be recoverable.`;
    }
    if (input) input.value = '';
    if (confirmBtn) confirmBtn.disabled = true;

    logProjectManagerAction('project_delete_dialog_opened', { sourceModalName });

    closeModal(sourceModalName);
    closeModal('hard-delete-project');
    openModal('delete-project');
  }

  async function finishProjectDeletion(mode) {
    const flow = _state.deleteFlow;
    if (!flow?.projectId) return;

    const projectId = flow.projectId;

    try {
      if (mode === 'hard') {
        await hardDeleteProject(projectId);
      } else {
        await deleteProject(projectId);
      }

      _state.projects = _state.projects.filter((x) => x.id !== projectId);
      renderProjectList();
      closeModal('delete-project');
      closeModal('hard-delete-project');

      if (_state.currentProjectId === projectId) {
        if (_state.projects.length > 0) {
          await selectProject(_state.projects[0].id);
        } else {
          await createDefaultProject();
        }
      }

      logProjectManagerAction(
        mode === 'hard' ? 'project_hard_deleted' : 'project_soft_deleted',
        { deleteMode: mode, projectId: flow.projectId, projectName: flow.projectName }
      );
      showToast(mode === 'hard' ? 'Project permanently deleted' : 'Project moved to Deleted Projects', 'success');
    } catch (err) {
      console.error('[projectDelete]', err);
      logProjectManagerAction('project_delete_failed', {
        deleteMode: mode,
        projectId: flow.projectId,
        projectName: flow.projectName,
        errorMessage: err?.message ?? 'Unknown error',
      });
      showToast(mode === 'hard' ? 'Failed to permanently delete project' : 'Failed to delete project', 'error');
    } finally {
      resetDeleteProjectFlow();
    }
  }

  document.getElementById('delete-project-btn')?.addEventListener('click', () => openDeleteProjectFlow('edit-project'));
  document.getElementById('settings-delete-project-btn')?.addEventListener('click', () => openDeleteProjectFlow('settings'));
  document.getElementById('soft-delete-project-confirm-btn')?.addEventListener('click', () => {
    logProjectManagerAction('project_soft_delete_selected', { deleteMode: 'soft' });
    finishProjectDeletion('soft');
  });
  document.getElementById('open-hard-delete-project-btn')?.addEventListener('click', () => {
    logProjectManagerAction('project_hard_delete_selected', { deleteMode: 'hard' });
    closeModal('delete-project');
    openModal('hard-delete-project');
    setTimeout(() => document.getElementById('hard-delete-project-input')?.focus(), 50);
  });
  document.getElementById('cancel-hard-delete-project-btn')?.addEventListener('click', () => {
    logProjectManagerAction('project_hard_delete_cancelled', { deleteMode: 'hard' });
    closeModal('hard-delete-project');
    openModal('delete-project');
  });
  document.getElementById('hard-delete-project-input')?.addEventListener('input', (event) => {
    const value = event.target?.value?.trim?.().toUpperCase?.() ?? '';
    const confirmBtn = document.getElementById('confirm-hard-delete-project-btn');
    if (confirmBtn) confirmBtn.disabled = value !== HARD_DELETE_CONFIRM_TEXT;
  });
  document.getElementById('confirm-hard-delete-project-btn')?.addEventListener('click', () => {
    const value = document.getElementById('hard-delete-project-input')?.value?.trim?.().toUpperCase?.() ?? '';
    if (value !== HARD_DELETE_CONFIRM_TEXT) return;
    logProjectManagerAction('project_hard_delete_confirmed', { deleteMode: 'hard' });
    finishProjectDeletion('hard');
  });

  // ── Upgrade Modal ───────────────────────────────────────────────────────

  document.getElementById('plan-monthly')?.addEventListener('click', () => {
    _state.selectedPlan = 'monthly';
    document.getElementById('plan-monthly')?.classList.add('active');
    document.getElementById('plan-annual')?.classList.remove('active');
  });

  document.getElementById('plan-annual')?.addEventListener('click', () => {
    _state.selectedPlan = 'annual';
    document.getElementById('plan-annual')?.classList.add('active');
    document.getElementById('plan-monthly')?.classList.remove('active');
  });

  document.getElementById('checkout-btn')?.addEventListener('click', () => {
    const priceId = _state.selectedPlan === 'annual'
      ? paddleConfig.annualPriceId
      : paddleConfig.monthlyPriceId;
    startCheckout(priceId);
  });

  // ── Invite Modal ────────────────────────────────────────────────────────

  document.getElementById('send-invite-btn')?.addEventListener('click', async () => {
    const contact = _inviteContacts.find((entry) => entry.email === _selectedInviteContactEmail) ?? null;
    const email = contact?.email?.trim?.() ?? '';
    const role  = document.getElementById('invite-role-select').value;

    if (!contact || !email || !email.includes('@')) {
      showToast('Select a saved contact before sending an invite', 'warning');
      return;
    }

    if (_state.tier !== 'premium') {
      closeModal('invite');
      openModal('upgrade');
      return;
    }

    try {
      const inviter = {
        uid:  _state.user?.uid  ?? null,
        name: _state.user?.displayName ?? _state.user?.email ?? 'A FlowLane user',
      };
      await inviteCollaborator(_state.currentProjectId, email, role, inviter);
      _selectedInviteContactEmail = null;
      if (inviteContactSearchInput) inviteContactSearchInput.value = '';
      renderSelectedInviteContact();
      renderInviteContactOptions('');
      updateInviteSendButtonState();
      showToast(`Invite sent to ${email}`, 'success');
    } catch (err) {
      console.error('[invite]', err);
      showToast('Failed to send invite', 'error');
    }
  });

  // ── Settings — Export ───────────────────────────────────────────────────

  document.getElementById('export-json-btn')?.addEventListener('click', async () => {
    try {
      await exportToJSON();
      showToast('JSON export downloaded', 'success');
    } catch (err) {
      console.error('[Export]', err);
      showToast('Export failed', 'error');
    }
  });

  // ── Settings — Import ───────────────────────────────────────────────────

  const importFileInput = document.getElementById('import-file-input');

  document.getElementById('import-json-btn')?.addEventListener('click', () => {
    importFileInput?.click();
  });

  importFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate FlowLane export format
      if (!data.version || !Array.isArray(data.projects)) {
        throw new Error('Invalid FlowLane export file');
      }

      let importedCount = 0;

      for (const proj of data.projects) {
        // Create the project
        const projectId = await createProject({
          name:        proj.name ?? 'Imported Project',
          code:        proj.code ?? undefined,
          description: proj.description ?? '',
          color:       proj.color ?? '#6366f1',
        });

        // Create columns
        if (Array.isArray(proj.columns)) {
          for (let ci = 0; ci < proj.columns.length; ci++) {
            const col = proj.columns[ci];
            const colId = await createColumn(projectId, {
              name:  col.name ?? `Column ${ci + 1}`,
              color: col.color ?? '#7d8590',
              order: col.order ?? ci,
            });

            // Create cards in this column
            if (Array.isArray(col.cards)) {
              const { createCard } = await import('./storage.js');
              for (const card of col.cards) {
                await createCard(projectId, colId, {
                  title:       card.title ?? '',
                  description: card.description ?? '',
                  priority:    card.priority ?? 'none',
                  labels:      card.labels ?? [],
                  assignee:    card.assignee ?? null,
                  dueDate:     card.dueDate ?? null,
                  order:       card.order ?? 0,
                  color:       card.color ?? null,
                  status:      card.status ?? 'default',
                });
              }
            }
          }
        }

        importedCount++;
      }

      showToast(`Imported ${importedCount} project${importedCount !== 1 ? 's' : ''}`, 'success');
      closeModal('settings');

      // Reload project list
      _state.projects = await getProjects();
      renderProjectList();
      if (_state.projects.length > 0) {
        const last = _state.projects[_state.projects.length - 1];
        await selectProject(last.id);
      }
    } catch (err) {
      if (err.message === 'FREE_LIMIT') {
        showToast('Free plan limit (3 projects) reached. Upgrade or delete a project first.', 'warning');
      } else {
        console.error('[Import]', err);
        showToast(`Import failed: ${err.message}`, 'error');
      }
    }
  });

  // ── Settings — Default View ─────────────────────────────────────────────

  const dvSel = document.getElementById('default-view-select');
  dvSel?.addEventListener('change', () => {
    const wantSwimlane = dvSel.value === 'swimlane';
    if (wantSwimlane !== getSwimlaneMode()) {
      setSwimlaneMode(wantSwimlane);
      updateViewToggle();
    }
  });

  // ── Org Name ────────────────────────────────────────────────────────────
  const orgInput = document.getElementById('org-name-input');
  if (orgInput) {
    orgInput.value = localStorage.getItem('flowlane_orgName') || '';
    orgInput.addEventListener('change', async () => {
      const val = orgInput.value.trim();
      localStorage.setItem('flowlane_orgName', val);
      applyOrgName(val);
      // Persist to Firestore so it syncs across devices
      if (_state.user?.uid) {
        try { await upsertUser(_state.user.uid, { orgName: val }); } catch (_) {}
      }
    });
  }

  // ── Settings Done ───────────────────────────────────────────────────────
  document.getElementById('settings-done-btn')?.addEventListener('click', () => {
    closeModal('settings');
  });

  // ── Browse All Projects ─────────────────────────────────────────────────

  document.getElementById('browse-projects-btn')?.addEventListener('click', () => {
    closeModal('settings');
    openProjectBrowser().catch((err) => {
      console.error('[openProjectBrowser]', err);
      showToast('Failed to open project manager', 'error');
    });
  });

  document.getElementById('manage-invitations-btn')?.addEventListener('click', () => {
    openInvitationManager().catch((err) => {
      console.error('[invitationManager]', err);
      showToast('Failed to open invitation manager', 'error');
    });
  });

  // ── Project Status Change ───────────────────────────────────────────────

  document.getElementById('change-project-status-btn')?.addEventListener('click', () => {
    closeModal('settings');
    const remarksEl = document.getElementById('project-status-remarks');
    if (remarksEl) remarksEl.value = '';
    const statusSelect = document.getElementById('project-new-status-select');
    if (statusSelect) statusSelect.value = 'completed';
    const proj = _state.projects.find(p => p.id === _state.currentProjectId);
    const titleEl = document.getElementById('project-status-modal-title');
    if (titleEl) titleEl.textContent = `Change Status: ${proj?.name ?? 'Project'}`;
    openModal('project-status');
  });

  document.getElementById('confirm-project-status-btn')?.addEventListener('click', async () => {
    const newStatus = document.getElementById('project-new-status-select')?.value;
    const remarks   = document.getElementById('project-status-remarks')?.value.trim() ?? '';
    const projectId = _state.currentProjectId;

    if (!projectId || !newStatus) return;

    try {
      if (_state.tier === 'premium') {
        await updateProjectStatus(projectId, newStatus, remarks, _state.user?.uid ?? null);
      } else {
        await updateProject(projectId, {
          projectStatus: newStatus,
          ...(newStatus === 'completed' ? { completedAt: Date.now(), completionRemarks: remarks } : {}),
          ...(newStatus === 'cancelled' ? { cancelledAt: Date.now(), cancellationRemarks: remarks } : {}),
          ...(newStatus === 'deferred' ? { deferredAt: Date.now(), deferralRemarks: remarks } : {}),
          ...(newStatus === 'in-progress' ? { inProgressAt: Date.now() } : {}),
        });
      }

      const proj = _state.projects.find(p => p.id === projectId);
      if (proj) proj.projectStatus = newStatus;

      renderProjectList();
      const statusLabel = newStatus === 'in-progress' ? 'In Progress'
        : newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
      const nameEl = document.getElementById('current-project-name');
      if (nameEl) nameEl.textContent = `${proj?.name ?? 'Unknown'} — ${statusLabel}`;

      closeModal('project-status');
      showToast(`Project marked as ${statusLabel}`, 'success');
    } catch (err) {
      console.error('[projectStatus]', err);
      showToast('Failed to update project status', 'error');
    }
  });

  // ── Auto-set project to In Progress when first card is created ──────────

  let _autoSetBusy = false;
  window._autoSetProjectInProgress = async () => {
    if (_autoSetBusy) return;
    const projectId = window._currentProjectId;
    const proj = _state.projects.find(p => p.id === projectId);
    if (!proj) return;
    const currentStatus = proj.projectStatus ?? 'new';
    if (currentStatus !== 'new') return;

    _autoSetBusy = true;
    try {
      proj.projectStatus = 'in-progress';
      if (_state.tier === 'premium') {
        await updateProjectStatus(projectId, 'in-progress');
      } else {
        await updateProject(projectId, { projectStatus: 'in-progress', inProgressAt: Date.now() });
      }
      renderProjectList();
      const nameEl = document.getElementById('current-project-name');
      if (nameEl) nameEl.textContent = `${proj.name} — In Progress`;
    } catch (_) { /* non-critical */ }
    _autoSetBusy = false;
  };

  // ── Downgrade Modal ─────────────────────────────────────────────────────

  document.getElementById('downgrade-export-json-btn')?.addEventListener('click', async () => {
    try {
      await exportToJSON();
      showToast('JSON export downloaded', 'success');
    } catch (err) {
      showToast('Export failed', 'error');
    }
  });

  document.getElementById('downgrade-renew-btn')?.addEventListener('click', () => {
    closeModal('downgrade');
    openModal('upgrade');
  });

  document.getElementById('downgrade-continue-btn')?.addEventListener('click', () => {
    closeModal('downgrade');
    finalizeDowngrade();
  });

  // Also support 'downgrade-confirm-btn' as an alias
  document.getElementById('downgrade-confirm-btn')?.addEventListener('click', () => {
    closeModal('downgrade');
    finalizeDowngrade();
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('project-dropdown')?.classList.add('hidden');
      document.getElementById('user-dropdown')?.classList.add('hidden');
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PROJECT BROWSER
// ══════════════════════════════════════════════════════════════════════════════

function openProjectBrowserLegacy() {
  const listEl = document.getElementById('project-browser-list');
  const searchInput = document.getElementById('project-browser-search-input');

  if (!listEl) return;

  function renderBrowserList(filter = '') {
    listEl.innerHTML = '';
    const q = filter.toLowerCase();

    const isTerminal = (status) =>
      status === 'completed' || status === 'cancelled' || status === 'deferred';

    const sorted = [..._state.projects].sort((a, b) => {
      const termA = isTerminal(a.projectStatus) ? 1 : 0;
      const termB = isTerminal(b.projectStatus) ? 1 : 0;
      if (termA !== termB) return termA - termB;
      return 0;
    });

    for (const p of sorted) {
      const status = p.projectStatus ?? 'new';
      const statusLabel = status === 'in-progress' ? 'In Progress'
        : status.charAt(0).toUpperCase() + status.slice(1);
      const fullName = `${p.name} — ${statusLabel}`;

      if (q && !fullName.toLowerCase().includes(q) && !(p.code ?? '').toLowerCase().includes(q)) {
        continue;
      }

      const item = document.createElement('div');
      item.className = 'project-browser-item' + (p.id === _state.currentProjectId ? ' active' : '');

      const dot = document.createElement('div');
      dot.className = 'project-dot';
      dot.style.background = p.color ?? '#6366f1';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'project-browser-item__name';
      nameSpan.textContent = fullName;

      const badge = document.createElement('span');
      badge.className = `project-status-badge project-status-badge--${status}`;
      badge.textContent = statusLabel;

      const dates = document.createElement('div');
      dates.className = 'project-browser-item__dates';
      const created = p.createdAt
        ? (typeof p.createdAt === 'object' && p.createdAt.seconds
            ? new Date(p.createdAt.seconds * 1000)
            : new Date(p.createdAt))
        : null;
      if (created && !isNaN(created.getTime())) {
        dates.textContent = created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }

      item.appendChild(dot);
      item.appendChild(nameSpan);
      item.appendChild(badge);
      item.appendChild(dates);

      item.addEventListener('click', async () => {
        closeModal('project-browser');
        await selectProject(p.id);
      });

      listEl.appendChild(item);
    }

    if (listEl.children.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:var(--text-muted);padding:20px;font-size:13px';
      empty.textContent = 'No projects match your search.';
      listEl.appendChild(empty);
    }
  }

  renderBrowserList();
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = () => renderBrowserList(searchInput.value);
  }

  openModal('project-browser');
  setTimeout(() => searchInput?.focus(), 50);
}

async function openProjectBrowser() {
  const listEl = document.getElementById('project-browser-list');
  const searchInput = document.getElementById('project-browser-search-input');
  const helpEl = document.getElementById('project-browser-help');
  const currentTabBtn = document.getElementById('project-browser-tab-current');
  const deletedTabBtn = document.getElementById('project-browser-tab-deleted');

  if (!listEl || !searchInput || !helpEl || !currentTabBtn || !deletedTabBtn) return;

  let activeTab = 'current';
  let deletedProjects = [];
  let deletedProjectsLoading = true;
  let deletedProjectsError = '';

  const toDate = (value) => {
    if (!value) return null;
    if (typeof value?.toDate === 'function') {
      const date = value.toDate();
      return Number.isNaN(date?.getTime?.()) ? null : date;
    }
    if (typeof value?.seconds === 'number') {
      const date = new Date(value.seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const formatDate = (value, fallback = 'Unknown date') => {
    const date = toDate(value);
    if (!date) return fallback;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getRestoreUntilValue = (project) => {
    if (project?.restoreUntil) return project.restoreUntil;
    const deletedDate = toDate(project?.deletedAt);
    return deletedDate ? new Date(deletedDate.getTime() + (60 * 24 * 60 * 60 * 1000)) : null;
  };

  const getStatusLabel = (status = 'new') => {
    if (status === 'in-progress') return 'In Progress';
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const matchesFilter = (project, filter) => {
    const query = filter.trim().toLowerCase();
    if (!query) return true;

    const haystack = [
      project.name,
      project.code,
      getStatusLabel(project.projectStatus ?? 'new'),
      project.description,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  };

  const renderEmptyState = (message) => {
    listEl.innerHTML = `<div class="project-browser-empty">${escapeHtml(message)}</div>`;
  };

  const updateTabState = () => {
    currentTabBtn.classList.toggle('active', activeTab === 'current');
    deletedTabBtn.classList.toggle('active', activeTab === 'deleted');
    helpEl.textContent = activeTab === 'current'
      ? 'All current projects, including completed, cancelled, and deferred boards.'
      : 'Projects you deleted and can restore. Restoring brings back cards and collaborators.';
  };

  const renderCurrentProjects = (filter) => {
    const projects = [..._state.projects]
      .filter((project) => matchesFilter(project, filter));

    if (!projects.length) {
      renderEmptyState(filter ? 'No current projects match your search.' : 'No current projects yet.');
      return;
    }

    for (const project of projects) {
      const status = project.projectStatus ?? 'new';
      const item = document.createElement('div');
      item.className = 'project-browser-item' + (project.id === _state.currentProjectId ? ' active' : '');

      item.innerHTML = `
        <div class="project-browser-item__main">
          <div class="project-browser-item__name">${escapeHtml(project.name ?? 'Untitled Project')}</div>
          <div class="project-browser-item__meta">
            ${escapeHtml(project.code ?? 'PROJECT')} &middot; Created ${escapeHtml(formatDate(project.createdAt))}
          </div>
        </div>
        <div class="project-browser-item__actions">
          <span class="project-status-badge project-status-badge--${escapeHtml(status)}">${escapeHtml(getStatusLabel(status))}</span>
          <div class="project-browser-item__dates">${escapeHtml(formatDate(project.updatedAt ?? project.createdAt))}</div>
        </div>`;

      const dot = document.createElement('div');
      dot.className = 'project-dot';
      dot.style.background = project.color ?? '#6366f1';
      item.prepend(dot);

      item.addEventListener('click', async () => {
        closeModal('project-browser');
        await selectProject(project.id);
      });

      listEl.appendChild(item);
    }
  };

  const renderDeletedProjects = (filter) => {
    if (deletedProjectsLoading) {
      renderEmptyState('Loading deleted projects...');
      return;
    }

    if (deletedProjectsError) {
      renderEmptyState(deletedProjectsError);
      return;
    }

    const projects = deletedProjects.filter((project) => matchesFilter(project, filter));
    if (!projects.length) {
      renderEmptyState(filter ? 'No deleted projects match your search.' : 'No deleted projects yet.');
      return;
    }

    for (const project of projects) {
      const status = project.projectStatus ?? 'new';
      const item = document.createElement('div');
      item.className = 'project-browser-item project-browser-item--deleted';

      item.innerHTML = `
        <div class="project-browser-item__main">
          <div class="project-browser-item__name">${escapeHtml(project.name ?? 'Untitled Project')}</div>
          <div class="project-browser-item__meta">
            Status: ${escapeHtml(getStatusLabel(status))} &middot; Deleted ${escapeHtml(formatDate(project.deletedAt))} &middot; Restore until ${escapeHtml(formatDate(getRestoreUntilValue(project)))}
          </div>
        </div>
        <div class="project-browser-item__actions">
          <span class="project-status-badge project-status-badge--${escapeHtml(status)}">${escapeHtml(getStatusLabel(status))}</span>
          <button class="btn-primary btn-sm project-browser-item__restore" type="button">Restore</button>
        </div>`;

      const dot = document.createElement('div');
      dot.className = 'project-dot';
      dot.style.background = project.color ?? '#6366f1';
      item.prepend(dot);

      const restoreBtn = item.querySelector('.project-browser-item__restore');
      restoreBtn?.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!restoreBtn) return;

        logProjectManagerAction('project_restore_requested', {
          projectId: project.originalProjectId ?? project.id,
          projectName: project.name ?? 'Untitled Project',
          deletedProjectId: project.id,
          restoreUntil: getRestoreUntilValue(project),
        });
        restoreBtn.disabled = true;
        restoreBtn.textContent = 'Restoring...';

        try {
          await restoreDeletedProject(project.id);
          await loadProjects();
          deletedProjectsLoading = true;
          deletedProjectsError = '';
          renderBrowserList(searchInput.value);
          try {
            deletedProjects = await getDeletedProjects();
          } catch (err) {
            console.error('[getDeletedProjects]', err);
            deletedProjects = [];
            deletedProjectsError = 'Could not load deleted projects.';
          } finally {
            deletedProjectsLoading = false;
          }
          renderBrowserList(searchInput.value);
          logProjectManagerAction('project_restored', {
            projectId: project.originalProjectId ?? project.id,
            projectName: project.name ?? 'Untitled Project',
            deletedProjectId: project.id,
          });
          showToast('Project restored', 'success');
        } catch (err) {
          console.error('[restoreDeletedProject]', err);
          logProjectManagerAction('project_restore_failed', {
            projectId: project.originalProjectId ?? project.id,
            projectName: project.name ?? 'Untitled Project',
            deletedProjectId: project.id,
            errorMessage: err?.message ?? 'Unknown error',
          });
          showToast(
            err?.message === 'OWNER_ONLY'
              ? 'Only the project owner can restore this project.'
              : err?.message === 'RESTORE_EXPIRED'
                ? 'This recycle-bin item has expired and can no longer be restored.'
                : err?.code === 'permission-denied'
                  ? 'Restore needs the latest Firestore rules. Deploy firestore.rules and try again.'
                : 'Failed to restore project',
            'error',
          );
          restoreBtn.disabled = false;
          restoreBtn.textContent = 'Restore';
        }
      });

      listEl.appendChild(item);
    }
  };

  function renderBrowserList(filter = '') {
    listEl.innerHTML = '';
    updateTabState();

    if (activeTab === 'deleted') {
      renderDeletedProjects(filter);
      return;
    }

    renderCurrentProjects(filter);
  }

  currentTabBtn.onclick = () => {
    activeTab = 'current';
    renderBrowserList(searchInput.value);
  };
  deletedTabBtn.onclick = () => {
    activeTab = 'deleted';
    renderBrowserList(searchInput.value);
  };

  searchInput.value = '';
  searchInput.oninput = () => renderBrowserList(searchInput.value);

  renderBrowserList();
  openModal('project-browser');
  setTimeout(() => searchInput?.focus(), 50);

  try {
    deletedProjects = await getDeletedProjects();
  } catch (err) {
    console.error('[getDeletedProjects]', err);
    deletedProjects = [];
    deletedProjectsError = 'Could not load deleted projects.';
  } finally {
    deletedProjectsLoading = false;
  }

  renderBrowserList(searchInput.value);
}

// ══════════════════════════════════════════════════════════════════════════════
// COLLABORATORS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Loads and renders the current collaborator list inside the invite modal.
 * Each row shows the collaborator's role with a change dropdown (admin only)
 * and a remove button.
 */
async function populateCollaborators(projectId) {
  const container = document.getElementById('current-collaborators')
                 || document.getElementById('collaborators-list');
  if (!container) return;

  if (_state.tier !== 'premium' || !projectId) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:12px">Collaboration requires Premium.</p>';
    return;
  }

  container.innerHTML = '<p style="color:var(--text-secondary);font-size:12px">Loading...</p>';

  try {
    const project = await getProject(projectId);
    const collabs = project?.collaborators ?? {};
    const isAdmin = canAdmin();

    if (Object.keys(collabs).length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:12px">No collaborators yet.</p>';
      return;
    }

    container.innerHTML = '';

    const collabNames = project?.collaboratorNames ?? {};

    for (const [uid, role] of Object.entries(collabs)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color)';

      // Avatar
      const info = collabNames[uid];
      const avatarEl = document.createElement('div');
      avatarEl.style.cssText = 'width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;background:var(--accent);overflow:hidden';
      if (info?.photoURL) {
        const img = document.createElement('img');
        img.src = info.photoURL;
        img.alt = info.name ?? '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover';
        avatarEl.appendChild(img);
      } else {
        avatarEl.textContent = ((info?.name ?? info?.email ?? uid).charAt(0) ?? '?').toUpperCase();
      }
      row.appendChild(avatarEl);

      const nameSpan = document.createElement('span');
      nameSpan.style.flex = '1';
      nameSpan.style.fontSize = '13px';
      const isMe = uid === (_state.user?.uid ?? '');
      const displayName = isMe
        ? 'You'
        : (info?.name ?? info?.email ?? uid.slice(0, 12) + '...');
      nameSpan.textContent = displayName;
      row.appendChild(nameSpan);

      if (isAdmin) {
        // Role selector
        const select = document.createElement('select');
        select.className = 'form-input';
        select.style.cssText = 'padding:2px 4px;font-size:12px;width:auto';
        [['admin', 'Admin'], ['editor', 'Editor'], ['viewer', 'Viewer']].forEach(([val, label]) => {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (val === role) opt.selected = true;
          select.appendChild(opt);
        });
        select.addEventListener('change', async () => {
          try {
            await updateCollaboratorRole(projectId, uid, select.value);
            showToast('Role updated', 'success');
          } catch (_) {
            showToast('Failed to update role', 'error');
          }
        });
        row.appendChild(select);

        // Remove button (cannot remove yourself)
        if (uid !== (_state.user?.uid ?? '')) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'btn-danger-sm';
          removeBtn.style.cssText = 'padding:2px 8px;font-size:12px';
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', async () => {
            if (!confirm('Remove this collaborator from the project?')) return;
            try {
              await removeCollaborator(projectId, uid);
              row.remove();
              showToast('Collaborator removed', 'success');
            } catch (_) {
              showToast('Failed to remove collaborator', 'error');
            }
          });
          row.appendChild(removeBtn);
        }
      } else {
        const roleSpan = document.createElement('span');
        roleSpan.style.cssText = 'font-size:12px;color:var(--text-secondary);text-transform:capitalize';
        roleSpan.textContent = role;
        row.appendChild(roleSpan);
      }

      container.appendChild(row);
    }
  } catch (err) {
    console.error('[populateCollaborators]', err);
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:12px">Could not load collaborators.</p>';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STORAGE USAGE
// ══════════════════════════════════════════════════════════════════════════════

async function loadStorageUsage() {
  const section = document.getElementById('storage-section');
  if (!section) return;

  if (!_state.user || !isPremiumMode()) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const fill = document.getElementById('storage-bar-fill');
  const text = document.getElementById('storage-used-text');
  if (text) text.textContent = 'Loading...';

  try {
    const { usedBytes, quotaBytes } = await getStorageUsage();
    const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;

    if (fill) {
      fill.style.width = `${pct}%`;
      fill.className   = 'storage-bar-fill';
      if      (pct >= 90) fill.classList.add('storage-bar-fill--danger');
      else if (pct >= 75) fill.classList.add('storage-bar-fill--warn');
    }

    if (text) {
      const usedLabel  = formatBytes(usedBytes);
      const quotaLabel = formatBytes(quotaBytes);
      text.textContent = `${usedLabel} of ${quotaLabel} used (${Math.round(pct)}%)`;
      text.style.color = pct >= 90 ? 'var(--danger)'
                       : pct >= 75 ? 'var(--warning)'
                       : '';
    }
  } catch (err) {
    console.error('[loadStorageUsage]', err);
    if (text) text.textContent = 'Could not load storage info';
  }
}

function formatBytes(bytes) {
  if (bytes < 1024)              return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function applyOrgName(name) {
  const display = document.getElementById('org-name-display');
  const divider = document.getElementById('org-name-divider');
  if (!display) return;
  if (name) {
    display.textContent = name;
    display.style.display = '';
    if (divider) divider.style.display = '';
  } else {
    display.style.display = 'none';
    if (divider) divider.style.display = 'none';
  }
}

function getSavedProjectId() {
  return localStorage.getItem('flowlane_lastProjectId') ?? null;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════

boot();
