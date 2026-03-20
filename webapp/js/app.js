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
 *  - No analytics module
 *  - No import module (inline implementation)
 *  - No open-window functionality
 *  - No org-name feature
 *  - Auth button IDs: 'google-sign-in-btn' and 'skip-auth-btn'
 */

import { onAuthChange, signInWithGoogle, signOut, getCurrentUser } from './auth.js';
import { upsertUser, listenUser, listenProjects, inviteCollaborator, getProject,
  removeCollaborator, updateCollaboratorRole, getPendingInvites,
  acceptInvite, syncCollaboratorInfo, updateProjectStatus } from './db.js';
import { configure as configureStorage, getProjects, createProject, updateProject,
  deleteProject, getColumns, getCards, createColumn, deleteColumn,
  migrateLocalToCloud, adoptAnonymousData, setUserRole, canEdit, canAdmin,
  getStorageUsage, isPremiumMode } from './storage.js';
import { renderBoard, clearFilters, setSwimlaneMode, getSwimlaneMode, loadSwimlanePref,
  searchCards } from './board.js';
import { startListening, stopListening } from './collaboration.js';
import { startCheckout, openBillingPortal, purchaseStorageAddon } from './paddle.js';
import { exportToJSON } from './export.js';
import { paddleConfig } from './firebase-config.js';
import { showToast, openModal, closeModal, initModalOverlays,
  initDropdowns, initColorPicker, setUserAvatar, setTierBadge,
  applyTheme, loadTheme } from './ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const FREE_LIMIT = 3;

// ── State ─────────────────────────────────────────────────────────────────────
// Color state managed inline per modal (new-project / edit-project)
let _newProjectColorPicker = null;
let _editProjectColorPicker = null;

let _state = {
  user:             null,
  tier:             'free',
  projects:         [],
  currentProjectId: null,
  unsubUser:        null,
  selectedPlan:     'monthly',
  isDowngraded:     false,
};

// Expose current project ID globally so board.js / card-modal.js can access it
window._currentProjectId = null;
window._refreshBoard     = loadCurrentBoard;

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
      localStorage.removeItem('flowlane_skipAuth');
      await handleSignIn(user);
    } else {
      const skipAuth = localStorage.getItem('flowlane_skipAuth');
      if (skipAuth) {
        configureStorage({ isPremium: false, uid: 'local' });
        setUserAvatar(null);
        setTierBadge('free');
        await loadProjects();
        show('app');
      } else {
        handleSignOut();
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREEN MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

function show(screenId) {
  ['loading-screen', 'auth-screen', 'app'].forEach((id) => {
    document.getElementById(id)?.classList.toggle('hidden', id !== screenId);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

async function handleSignIn(user) {
  _state.user = user;

  // Move any anonymous (skip-auth) local data to the user-namespaced key
  await adoptAnonymousData(user.uid);

  // Upsert user in Firestore (no-op if offline / firebase not configured)
  try {
    await upsertUser(user.uid, {
      displayName: user.displayName,
      email:       user.email,
      photoURL:    user.photoURL,
    });
  } catch (_) { /* Firebase not yet configured — ok */ }

  // Listen for subscription status changes in Firestore
  _state.unsubUser?.();
  try {
    _state.unsubUser = listenUser(user.uid, async (userData) => {
      const storedTier = userData?.tier ?? 'free';
      const endsAt     = userData?.subscriptionEndsAt ?? null;

      // If Firestore says 'free' but the subscription period hasn't expired yet,
      // honour the paid period the user already paid for.
      let effectiveTier = storedTier;
      if (storedTier === 'free' && endsAt) {
        const expiryDate = endsAt?.toDate?.() ?? new Date(endsAt);
        if (expiryDate > new Date()) {
          effectiveTier = 'premium';
        }
      }

      const prevTier = _state.tier;

      if (effectiveTier !== prevTier) {
        if (prevTier === 'premium' && effectiveTier === 'free') {
          _state.tier = 'free';
          showDowngradeModal();
        } else {
          // free → premium: migrate any local data to Firestore first
          if (effectiveTier === 'premium') {
            try {
              showToast('Syncing your data to the cloud...', 'info');
              await migrateLocalToCloud(user.uid);
            } catch (migErr) {
              console.warn('[migrate]', migErr);
            }
          }

          _state.tier = effectiveTier;
          _state.isDowngraded = false;
          configureStorage({ isPremium: effectiveTier === 'premium', uid: user.uid });
          setTierBadge(effectiveTier);

          if (effectiveTier === 'premium') {
            await loadProjects();
          }
        }
      } else if (effectiveTier === 'free' && !_state.isDowngraded) {
        await checkAndEnterDowngradedMode(user.uid);
      }
    });
  } catch (_) { /* offline */ }

  configureStorage({ isPremium: false, uid: user.uid });
  setUserAvatar(user);
  setTierBadge(_state.tier);

  await loadProjects();
  show('app');

  // Check for pending invites after app is visible — non-blocking
  checkPendingInvites(user).catch(() => {});
}

function handleSignOut() {
  _state.user = null;
  _state.tier = 'free';
  _state.projects = [];
  _state.currentProjectId = null;

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

  // Clear board filters and search when switching projects
  clearFilters();
  window._clearSearch?.();

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

  // Set status dropdown
  const statusSel = document.getElementById('edit-project-status');
  if (statusSel) statusSel.value = project.status ?? 'active';

  // Highlight matching color swatch
  _editProjectColor = project.color ?? '#6c63ff';
  document.querySelectorAll('#edit-project-color-picker .color-swatch').forEach(b => {
    b.classList.toggle('active', b.dataset.color === _editProjectColor);
  });

  // Populate collaborators in edit modal
  populateCollaborators(_state.currentProjectId).catch(() => {});

  openModal('edit-project');
  setTimeout(() => document.getElementById('edit-project-name')?.focus(), 50);
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

  document.getElementById('skip-auth-btn')?.addEventListener('click', async () => {
    localStorage.setItem('flowlane_skipAuth', 'true');
    configureStorage({ isPremium: false, uid: 'local' });
    setUserAvatar(null);
    setTierBadge('free');
    await loadProjects();
    show('app');
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

  // ── Theme buttons (header toolbar) ──────────────────────────────────────
  document.getElementById('theme-dark-btn')?.addEventListener('click', () => applyTheme('dark'));
  document.getElementById('theme-light-btn')?.addEventListener('click', () => applyTheme('light'));
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

  // ── Invite button ───────────────────────────────────────────────────────
  document.getElementById('invite-btn')?.addEventListener('click', async () => {
    openModal('invite');
    await populateCollaborators(_state.currentProjectId);
  });

  // ── Upgrade button ──────────────────────────────────────────────────────
  document.getElementById('upgrade-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    openModal('upgrade');
  });

  // ── Manage Billing ──────────────────────────────────────────────────────
  document.getElementById('manage-billing-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    openBillingPortal();
  });

  // ── Sign out ────────────────────────────────────────────────────────────
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    localStorage.removeItem('flowlane_skipAuth');
    await signOut();
  });

  // ── Sign in from guest mode ─────────────────────────────────────────────
  document.getElementById('sign-in-menu-btn')?.addEventListener('click', async () => {
    document.getElementById('user-dropdown')?.classList.add('hidden');
    localStorage.removeItem('flowlane_skipAuth');
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('[SignIn from menu]', err);
      handleSignOut();
    }
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
      const statusLabels = { 'new': 'New', 'in-progress': 'In Progress', 'completed': 'Completed', 'cancelled': 'Cancelled' };
      statusBadge.textContent = statusLabels[pStatus] ?? pStatus;
      statusBadge.className = `project-status-badge project-status-badge--${pStatus}`;
    }

    // Show/hide Change Status button — only admins can mark completed/cancelled
    const changeStatusBtn = document.getElementById('change-project-status-btn');
    if (changeStatusBtn) {
      const isAdmin = canAdmin();
      const isTerminal = pStatus === 'completed' || pStatus === 'cancelled';
      changeStatusBtn.style.display = (isAdmin && !isTerminal) ? '' : 'none';
    }

    openModal('settings');
    loadStorageUsage().catch(() => {});
  });

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

  document.getElementById('add-column-btn')?.addEventListener('click', () => {
    openModal('column');
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

  let _editProjectColor = '#6c63ff';

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
      const p = _state.projects.find(x => x.id === editProjectId);
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

  async function handleDeleteProject(closeModalName) {
    const p = _state.projects.find(x => x.id === _state.currentProjectId);
    if (!p) return;
    if (!confirm(`Delete project "${p.name}" and all its data? This cannot be undone.`)) return;

    try {
      await deleteProject(_state.currentProjectId);
      _state.projects = _state.projects.filter(x => x.id !== _state.currentProjectId);
      renderProjectList();
      closeModal(closeModalName);

      if (_state.projects.length > 0) {
        await selectProject(_state.projects[0].id);
      } else {
        await createDefaultProject();
      }
      showToast('Project deleted', 'success');
    } catch (err) {
      showToast('Failed to delete project', 'error');
    }
  }

  // Delete from edit-project modal
  document.getElementById('delete-project-btn')?.addEventListener('click', () => handleDeleteProject('edit-project'));
  // Delete from settings modal
  document.getElementById('settings-delete-project-btn')?.addEventListener('click', () => handleDeleteProject('settings'));

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
    const email = document.getElementById('invite-email-input').value.trim();
    const role  = document.getElementById('invite-role-select').value;

    if (!email || !email.includes('@')) {
      showToast('Enter a valid email address', 'warning');
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
      document.getElementById('invite-email-input').value = '';
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
    orgInput.addEventListener('change', () => {
      const val = orgInput.value.trim();
      localStorage.setItem('flowlane_orgName', val);
    });
  }

  // ── Settings Done ───────────────────────────────────────────────────────
  document.getElementById('settings-done-btn')?.addEventListener('click', () => {
    closeModal('settings');
  });

  // ── Browse All Projects ─────────────────────────────────────────────────

  document.getElementById('browse-projects-btn')?.addEventListener('click', () => {
    closeModal('settings');
    openProjectBrowser();
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
        await updateProjectStatus(projectId, newStatus, remarks);
      } else {
        await updateProject(projectId, {
          projectStatus: newStatus,
          ...(newStatus === 'completed' ? { completedAt: Date.now(), completionRemarks: remarks } : {}),
          ...(newStatus === 'cancelled' ? { cancelledAt: Date.now(), cancellationRemarks: remarks } : {}),
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

function openProjectBrowser() {
  const listEl = document.getElementById('project-browser-list');
  const searchInput = document.getElementById('project-browser-search-input');

  if (!listEl) return;

  function renderBrowserList(filter = '') {
    listEl.innerHTML = '';
    const q = filter.toLowerCase();

    const sorted = [..._state.projects].sort((a, b) => {
      const termA = (a.projectStatus === 'completed' || a.projectStatus === 'cancelled') ? 1 : 0;
      const termB = (b.projectStatus === 'completed' || b.projectStatus === 'cancelled') ? 1 : 0;
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

    for (const [uid, role] of Object.entries(collabs)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color)';

      const nameSpan = document.createElement('span');
      nameSpan.style.flex = '1';
      nameSpan.style.fontSize = '13px';
      nameSpan.textContent = uid === (_state.user?.uid ?? '') ? 'You' : uid.slice(0, 12) + '...';
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
