/**
 * collaboration.js – Real-time listeners and presence (web app)
 *
 * For Premium users:
 *  - Listens to Firestore for live column / card changes
 *  - Manages presence pings (current user is "active" on a project)
 *  - Renders presence avatars in the header
 */

import { listenColumns, listenCards, listenPresence,
  updatePresence, clearPresence } from './db.js';
import { renderBoard, updatePresenceIndicators } from './board.js';
import { getCurrentUser } from './auth.js';
import { showToast } from './ui.js';

const presenceColors = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316',
];

let _projectId     = null;
let _unsubColumns  = null;
let _unsubCards    = {};          // { [columnId]: unsubFn }
let _unsubPresence = null;
let _presencePing  = null;
let _currentCols   = [];
let _currentCards  = {};          // { [columnId]: CardDoc[] }

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start all real-time listeners for a project.
 * Call this when the user switches to a new project (premium only).
 */
export function startListening(projectId) {
  if (_projectId === projectId) return;   // already listening
  stopListening();
  _projectId = projectId;

  const user = getCurrentUser();

  // 1. Columns
  _unsubColumns = listenColumns(projectId, (columns) => {
    _currentCols = columns;

    // Re-subscribe card listeners whenever columns change
    // (handles added / removed columns)
    const newColIds = new Set(columns.map((c) => c.id));

    // Clean up listeners for removed columns
    for (const [colId, unsub] of Object.entries(_unsubCards)) {
      if (!newColIds.has(colId)) {
        unsub();
        delete _unsubCards[colId];
        delete _currentCards[colId];
      }
    }

    // Add listeners for new columns
    for (const col of columns) {
      if (!_unsubCards[col.id]) {
        _unsubCards[col.id] = listenCards(projectId, col.id, (cards) => {
          _currentCards[col.id] = cards;
          renderBoard(_currentCols, _currentCards);
        });
      }
    }

    renderBoard(_currentCols, _currentCards);
  });

  // 2. Presence
  _unsubPresence = listenPresence(projectId, (presence) => {
    renderPresenceBar(presence);
    updatePresenceIndicators(presence);
  });

  // 3. Broadcast own presence every 25 seconds
  if (user) {
    const colorIdx = user.uid.charCodeAt(0) % presenceColors.length;
    const myColor  = presenceColors[colorIdx];

    const ping = () => updatePresence(projectId, user.uid, {
      displayName:  user.displayName ?? user.email ?? 'Anonymous',
      photoURL:     user.photoURL    ?? null,
      color:        myColor,
      activeCardId: null,
    }).catch(() => {});

    ping();
    _presencePing = setInterval(ping, 25_000);
  }
}

/**
 * Stop all real-time listeners and clear own presence.
 */
export async function stopListening() {
  _unsubColumns?.();
  for (const unsub of Object.values(_unsubCards)) unsub();
  _unsubPresence?.();
  clearInterval(_presencePing);

  _unsubColumns  = null;
  _unsubCards    = {};
  _unsubPresence = null;
  _presencePing  = null;

  if (_projectId) {
    const user = getCurrentUser();
    if (user) {
      await clearPresence(_projectId, user.uid).catch(() => {});
    }
    _projectId = null;
  }
}

// ── Presence Bar Rendering ─────────────────────────────────────────────────

/**
 * Renders other users' presence avatars in the #presence-bar element.
 * Uses DOM API (not innerHTML) for photoURL img elements (security).
 */
export function renderPresenceBar(presence) {
  const bar = document.getElementById('presence-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const currentUser = getCurrentUser();
  const others = Object.values(presence).filter(
    (p) => p.uid !== currentUser?.uid
  );

  // Stale check: only show users seen in last 45 seconds
  const now = Date.now() / 1000;
  const active = others.filter((p) => {
    const seen = p.lastSeen?.seconds ?? 0;
    return (now - seen) < 45;
  });

  for (const person of active.slice(0, 5)) {
    const avatar = document.createElement('div');
    avatar.className = 'presence-avatar';
    avatar.title     = person.displayName ?? 'Anonymous';
    avatar.style.borderColor = person.color ?? '#6366f1';

    if (person.photoURL) {
      const img = document.createElement('img');
      img.src = person.photoURL;
      img.alt = person.displayName ?? '?';
      avatar.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'presence-avatar-fallback';
      fallback.style.background = person.color ?? '#6366f1';
      fallback.textContent = (person.displayName ?? '?').charAt(0).toUpperCase();
      avatar.appendChild(fallback);
    }

    bar.appendChild(avatar);
  }

  if (active.length > 5) {
    const more = document.createElement('div');
    more.className = 'presence-avatar';
    more.style.cssText = 'background:var(--bg-active);';
    more.title = `+${active.length - 5} more`;

    const moreInner = document.createElement('div');
    moreInner.className = 'presence-avatar-fallback';
    moreInner.style.background = 'var(--bg-active)';
    moreInner.style.color = 'var(--text-secondary)';
    moreInner.style.fontSize = '9px';
    moreInner.textContent = `+${active.length - 5}`;
    more.appendChild(moreInner);

    bar.appendChild(more);
  }

  // Show invite button when premium
  const inviteBtn = document.getElementById('invite-btn');
  if (inviteBtn) inviteBtn.style.display = '';
}
