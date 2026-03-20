/**
 * card-modal.js – Full card detail / edit modal (Web App)
 * Ported from the Chrome extension card-modal.js.
 * Quill and DOMPurify are loaded via CDN script tags (globals).
 */

import * as storage from './storage.js';
import { canEdit } from './storage.js';
import { addComment, listenComments, getProject, updatePresence, clearPresence } from './db.js';
import { getCurrentUser } from './auth.js';
import { showToast } from './ui.js';

let _card         = null;
let _columnId     = null;
let _labelColor   = '#6366f1';
let _commentUnsub = null;
let _quill        = null;   // Quill rich-text instance

// ── Preset Tags ─────────────────────────────────────────────────────────────

const PRESET_TAGS = [
  { name: 'Bug',           color: '#f85149' },
  { name: 'Feature',       color: '#3fb950' },
  { name: 'Urgent',        color: '#ff7b72' },
  { name: 'Blocker',       color: '#ef4444' },
  { name: 'Question',      color: '#d2a8ff' },
  { name: 'Design',        color: '#ec4899' },
  { name: 'Backend',       color: '#58a6ff' },
  { name: 'Frontend',      color: '#06b6d4' },
  { name: 'Docs',          color: '#d29922' },
  { name: 'In Review',     color: '#6366f1' },
];

// ── Public ─────────────────────────────────────────────────────────────────

export function showCardModal(card, columnId) {
  _card     = { ...card };
  _columnId = columnId;

  populate();
  initQuill();
  openModal('card');

  // Presence: mark that the current user is editing this card
  const user = getCurrentUser();
  if (user && storage.isPremiumMode()) {
    const projectId = window._currentProjectId;
    const colors    = ['#6366f1','#10b981','#f59e0b','#ef4444','#06b6d4'];
    const color     = colors[user.uid.charCodeAt(0) % colors.length];
    updatePresence(projectId, user.uid, {
      displayName: user.displayName,
      photoURL:    user.photoURL,
      activeCardId: card.id,
      color,
    }).catch(() => {});
  }
}

export function closeCardModal() {
  closeModal('card');
  _commentUnsub?.();
  _commentUnsub = null;

  // Reset Quill enabled state for next open
  if (_quill) _quill.enable(true);

  const user = getCurrentUser();
  if (user && storage.isPremiumMode()) {
    clearPresence(window._currentProjectId, user.uid).catch(() => {});
  }
}

// ── Quill rich-text editor ─────────────────────────────────────────────────

function initQuill() {
  const container = document.getElementById('quill-editor');
  if (!container) return;

  const Quill = window.Quill;
  if (!Quill) {
    console.warn('[card-modal] Quill not loaded');
    return;
  }

  // Create Quill once; re-use instance on subsequent modal opens
  if (!_quill) {
    _quill = new Quill(container, {
      theme: 'snow',
      placeholder: 'Add a description...',
      modules: {
        toolbar: [
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'code-block'],
          ['link'],
          ['clean'],
        ],
      },
      // Restrict to semantic-only formats — no inline styles → CSP safe
      formats: [
        'bold', 'italic', 'underline', 'strike',
        'list', 'blockquote', 'code-block', 'link',
      ],
    });
  }

  const DOMPurify = window.DOMPurify;

  // Load existing description (backward-compatible: plain text or HTML)
  const raw = _card.description ?? '';
  _quill.root.innerHTML = '';
  if (raw) {
    const sanitized = DOMPurify ? DOMPurify.sanitize(raw) : raw;
    const isHtml = /<[a-z][\s\S]*>/i.test(raw);
    if (isHtml) {
      _quill.clipboard.dangerouslyPasteHTML(sanitized);
    } else {
      _quill.setText(raw);
    }
  }

  // Apply role access
  _quill.enable(canEdit());
}

// ── Populate ──────────────────────────────────────────────────────────────

function populate() {
  const card = _card;

  // Key identifier (e.g. PRJ-1) — read-only badge above title
  const keyDisplay = document.getElementById('card-key-display');
  if (keyDisplay) {
    keyDisplay.textContent = card.key ?? '';
    keyDisplay.style.display = card.key ? '' : 'none';
  }

  // Title
  document.getElementById('card-title-input').value = card.title ?? '';
  autoResizeTextarea(document.getElementById('card-title-input'));

  // Priority bar colour
  const bar = document.getElementById('card-priority-bar');
  bar.className = `card-priority-bar priority-${card.priority ?? 'none'}`;

  // Priority select
  document.getElementById('card-priority-select').value = card.priority ?? 'none';

  // Status select
  const statusSel = document.getElementById('card-status-select');
  if (statusSel) statusSel.value = card.status ?? 'to-do';

  // Column selector
  buildColumnSelect();

  // Target date (formerly "due date")
  document.getElementById('card-due-date').value = card.dueDate ?? '';

  // Created date (read-only display)
  const createdEl = document.getElementById('card-created-display');
  if (createdEl) {
    createdEl.textContent = card.createdAt ? formatCardDate(card.createdAt) : '\u2014';
  }

  // Created by display
  renderCreatedBy(card);

  // Completed date (read-only display — only shown when status is done)
  renderCompletedDate(card);

  // Labels
  renderLabels();

  // Preset tags
  renderPresetTags();

  // Checklist
  renderChecklist();

  // Attachments
  renderAttachments();

  // Cover
  renderCover();

  // Assignee
  renderAssignee();

  // Comments (premium only)
  const user      = getCurrentUser();
  const isPremium = storage.isPremiumMode();
  const commSec   = document.getElementById('comments-section');
  if (isPremium && user) {
    commSec.style.display = '';
    startListeningComments();
  } else {
    commSec.style.display = 'none';
  }

  // Activity
  renderActivity();

  // Apply role-based access control
  applyRoleToModal(canEdit());

  // Wire events (once only)
  wireEvents();
}

function buildColumnSelect() {
  const sel   = document.getElementById('card-column-select');
  sel.innerHTML = '';
  const board = document.getElementById('board');

  if (board.classList.contains('board--swimlane')) {
    // Swimlane mode: read column names from header row
    board.querySelectorAll('.sl-col-header').forEach((header) => {
      const colId   = header.dataset.columnId;
      const colName = header.querySelector('.sl-col-name')?.textContent ?? 'Column';
      const opt     = document.createElement('option');
      opt.value     = colId;
      opt.textContent = colName;
      if (colId === _columnId) opt.selected = true;
      sel.appendChild(opt);
    });
  } else {
    // Flat mode: read from .column elements
    board.querySelectorAll('.column').forEach((colEl) => {
      const colId   = colEl.dataset.columnId;
      const colName = colEl.querySelector('.column-name')?.textContent ?? 'Column';
      const opt     = document.createElement('option');
      opt.value     = colId;
      opt.textContent = colName;
      if (colId === _columnId) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}

function renderLabels() {
  const list = document.getElementById('card-labels-list');
  list.innerHTML = '';
  (_card.labels ?? []).forEach((label, idx) => {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.style.background = sanitizeColor(label.color);
    chip.innerHTML = `${escapeHtml(label.name)}
      <span class="label-chip-remove" data-idx="${idx}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </span>`;
    chip.querySelector('.label-chip-remove').addEventListener('click', () => {
      _card.labels.splice(idx, 1);
      renderLabels();
    });
    list.appendChild(chip);
  });
}

function renderPresetTags() {
  const row = document.getElementById('preset-tags-row');
  if (!row) return;
  row.innerHTML = '';
  PRESET_TAGS.forEach((tag) => {
    const btn = document.createElement('button');
    btn.className = 'preset-tag-btn';
    btn.textContent = tag.name;
    btn.style.borderColor = tag.color;
    btn.style.color = tag.color;
    // Highlight if already added
    const already = (_card.labels ?? []).some(
      (l) => l.name.toLowerCase() === tag.name.toLowerCase()
    );
    if (already) {
      btn.classList.add('active');
      btn.style.background = tag.color;
      btn.style.color = '#fff';
    }
    btn.addEventListener('click', () => {
      if (already || (_card.labels ?? []).some(
        (l) => l.name.toLowerCase() === tag.name.toLowerCase()
      )) {
        // Remove if already present
        _card.labels = (_card.labels ?? []).filter(
          (l) => l.name.toLowerCase() !== tag.name.toLowerCase()
        );
      } else {
        if (!_card.labels) _card.labels = [];
        _card.labels.push({ name: tag.name, color: tag.color });
      }
      renderLabels();
      renderPresetTags();
    });
    row.appendChild(btn);
  });
}

function renderChecklist() {
  const items   = _card.checklist ?? [];
  const total   = items.length;
  const done    = items.filter((i) => i.completed).length;
  const pct     = total > 0 ? Math.round((done / total) * 100) : 0;

  document.getElementById('checklist-progress').textContent =
    total > 0 ? `${done}/${total}` : '';

  const barWrap = document.getElementById('checklist-bar-wrap');
  barWrap.style.display = total > 0 ? '' : 'none';
  document.getElementById('checklist-bar').style.width = `${pct}%`;

  const container = document.getElementById('checklist-items');
  container.innerHTML = '';
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `checklist-item ${item.completed ? 'checked' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="checklist-checkbox" ${item.completed ? 'checked' : ''} data-idx="${idx}" />
      <span class="checklist-text">${escapeHtml(item.text)}</span>
      <button class="checklist-delete-btn" data-idx="${idx}" title="Remove">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;

    row.querySelector('.checklist-checkbox').addEventListener('change', (e) => {
      _card.checklist[idx].completed = e.target.checked;
      renderChecklist();
    });

    row.querySelector('.checklist-delete-btn').addEventListener('click', () => {
      _card.checklist.splice(idx, 1);
      renderChecklist();
    });

    container.appendChild(row);
  });
}

// ── Attachments ─────────────────────────────────────────────────────────────

function renderAttachments() {
  const list = document.getElementById('attachments-list');
  if (!list) return;
  list.innerHTML = '';

  const attachments = _card.attachments ?? [];
  const isPremium   = storage.isPremiumMode();
  const editable    = canEdit();

  // Show/hide the premium gate
  const gate = document.getElementById('attachment-premium-gate');
  const btn  = document.getElementById('add-attachment-btn');
  if (gate) gate.style.display = (!isPremium && attachments.length === 0) ? '' : 'none';
  if (btn)  btn.style.display  = (isPremium && editable) ? '' : 'none';

  attachments.forEach((att, idx) => {
    const item = document.createElement('div');
    item.className = 'attachment-item';

    const isImage = att.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(att.name);

    // Thumbnail (DOM API, no innerHTML for URL)
    if (isImage && sanitizeStorageUrl(att.url)) {
      const thumb = document.createElement('img');
      thumb.className = 'attachment-thumb';
      thumb.alt = att.name ?? 'attachment';
      thumb.src = sanitizeStorageUrl(att.url);
      item.appendChild(thumb);
    } else {
      const icon = document.createElement('div');
      icon.className = 'attachment-icon';
      icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>`;
      item.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const nameEl = document.createElement('a');
    nameEl.className = 'attachment-name';
    nameEl.textContent = att.name ?? 'attachment';
    const safeUrl = sanitizeStorageUrl(att.url);
    if (safeUrl) {
      nameEl.href = safeUrl;
      nameEl.target = '_blank';
      nameEl.rel = 'noopener noreferrer';
    }
    info.appendChild(nameEl);

    if (att.size) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'attachment-size';
      sizeEl.textContent = formatFileSize(att.size);
      info.appendChild(sizeEl);
    }

    item.appendChild(info);

    if (isPremium && editable) {
      const delBtn = document.createElement('button');
      delBtn.className = 'attachment-delete';
      delBtn.title = 'Remove attachment';
      delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>`;
      delBtn.addEventListener('click', async () => {
        try {
          if (att.storagePath) {
            // Pass the stored file size so the usage counter is decremented
            await storage.deleteAttachment(att.storagePath, att.size ?? 0);
          }
          _card.attachments.splice(idx, 1);
          renderAttachments();
        } catch (err) {
          showToast('Failed to delete attachment', 'error');
        }
      });
      item.appendChild(delBtn);
    }

    list.appendChild(item);
  });
}

// ── Cover ────────────────────────────────────────────────────────────────────

function renderCover() {
  const area   = document.getElementById('card-cover-area');
  const remove = document.getElementById('cover-remove-btn');
  const cover  = _card.cover;

  if (!cover || cover.type === null || cover.type === undefined) {
    if (area)   { area.style.display = 'none'; area.style.background = ''; area.style.backgroundImage = ''; }
    if (remove) remove.style.display = 'none';
    return;
  }

  if (area)   area.style.display = '';
  if (remove) remove.style.display = '';

  if (cover.type === 'color') {
    area.style.background      = sanitizeColor(cover.value);
    area.style.backgroundImage = '';
  } else if (cover.type === 'image') {
    const url = sanitizeStorageUrl(cover.value);
    area.style.background         = 'var(--bg-overlay)';
    area.style.backgroundImage    = url ? `url("${url}")` : '';
    area.style.backgroundSize     = 'cover';
    area.style.backgroundPosition = 'center';
  }
}

function renderAssignee() {
  const user    = getCurrentUser();
  const display = document.getElementById('assignee-display');

  // Resolve display name for the assignee
  const assigneeDisplay = _card.assigneeId
    ? (_card.assigneeId === user?.uid
        ? 'You'
        : (_card.assigneeName ?? _card.assigneeId.slice(0, 12) + '\u2026'))
    : null;

  if (_card.assigneeId && assigneeDisplay) {
    const avatarLetter = (_card.assigneeName ?? _card.assigneeId ?? '?').charAt(0).toUpperCase();
    display.innerHTML = `
      <div class="assignee-avatar-sm">${escapeHtml(avatarLetter)}</div>
      <span>${escapeHtml(assigneeDisplay)}</span>`;
  } else {
    display.innerHTML = '<span class="assignee-placeholder">Unassigned</span>';
  }

  display.onclick = async () => {
    const listEl = document.getElementById('assignee-list');
    listEl.classList.toggle('hidden');

    if (!listEl.classList.contains('hidden')) {
      listEl.innerHTML = '';
      // Unassign option
      const none = buildAssigneeOption('', 'Unassigned', null);
      none.addEventListener('click', () => {
        _card.assigneeId = null;
        _card.assigneeName = null;
        renderAssignee();
        listEl.classList.add('hidden');
      });
      listEl.appendChild(none);

      // Self always available
      if (user) {
        const self = buildAssigneeOption(user.uid, user.displayName ?? user.email, user.photoURL);
        self.addEventListener('click', () => {
          _card.assigneeId = user.uid;
          _card.assigneeName = user.displayName ?? user.email;
          renderAssignee();
          listEl.classList.add('hidden');
        });
        listEl.appendChild(self);
      }

      // Load project collaborators if premium
      if (storage.isPremiumMode()) {
        try {
          const project = await getProject(window._currentProjectId);
          // Guard: if the dropdown was closed during the async fetch, abort
          if (listEl.classList.contains('hidden')) return;

          const collabNames = project?.collaboratorNames ?? {};
          const collabs = project?.collaborators ?? {};

          for (const [uid, role] of Object.entries(collabs)) {
            if (uid === user?.uid) continue; // already added as "Self"
            const info = collabNames[uid];
            const displayName = info?.name ?? info?.email ?? uid.slice(0, 12) + '\u2026';
            const photoURL = info?.photoURL ?? null;
            const opt = buildAssigneeOption(uid, displayName, photoURL);
            opt.addEventListener('click', () => {
              _card.assigneeId = uid;
              _card.assigneeName = displayName;
              renderAssignee();
              listEl.classList.add('hidden');
            });
            listEl.appendChild(opt);
          }
        } catch (err) {
          console.warn('[assignee] Could not load collaborators:', err.message);
        }
      }
    }
  };
}

function buildAssigneeOption(uid, name, photoURL) {
  const opt = document.createElement('div');
  opt.className = 'assignee-option';

  const avatar = document.createElement('div');
  avatar.className = 'assignee-avatar-sm';
  if (photoURL) {
    const img = document.createElement('img');
    img.src = photoURL;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    avatar.appendChild(img);
  } else {
    avatar.textContent = (name ?? '?').charAt(0).toUpperCase();
  }

  const label = document.createElement('span');
  label.textContent = name ?? '';

  opt.appendChild(avatar);
  opt.appendChild(label);
  return opt;
}

function renderActivity() {
  const log = document.getElementById('activity-log');
  const entries = _card.activity ?? [];
  log.innerHTML = entries.length === 0
    ? `<span class="activity-item">No activity yet.</span>`
    : entries.slice(-10).reverse().map((e) =>
        `<div class="activity-item">
           <strong>${escapeHtml(e.actor ?? 'Someone')}</strong>
           ${escapeHtml(e.action ?? '')}
           <span style="margin-left:4px;font-size:10px;">${formatTime(e.at)}</span>
         </div>`
      ).join('');
}

function startListeningComments() {
  _commentUnsub?.();
  const projectId = window._currentProjectId;
  _commentUnsub = listenComments(projectId, _columnId, _card.id, (comments) => {
    const list = document.getElementById('comments-list');
    list.innerHTML = comments.length === 0
      ? '<span style="font-size:11px;color:var(--text-muted)">No comments yet.</span>'
      : comments.map((c) => `
          <div class="comment">
            <div class="comment-avatar">${(c.displayName ?? c.uid ?? '?').charAt(0).toUpperCase()}</div>
            <div class="comment-body">
              <span class="comment-author">${escapeHtml(c.displayName ?? c.uid)}</span>
              <span class="comment-time">${formatTime(c.createdAt?.seconds ? c.createdAt.seconds * 1000 : c.createdAt)}</span>
              <div class="comment-text">${escapeHtml(c.text)}</div>
            </div>
          </div>`
        ).join('');
    list.scrollTop = list.scrollHeight;
  });
}

// ── Role enforcement ──────────────────────────────────────────────────────

function applyRoleToModal(editable) {
  // Input fields
  document.getElementById('card-title-input').readOnly    = !editable;
  if (_quill) _quill.enable(editable);
  document.getElementById('card-priority-select').disabled = !editable;
  document.getElementById('card-status-select')?.setAttribute('disabled', !editable ? 'true' : '');
  if (editable) document.getElementById('card-status-select')?.removeAttribute('disabled');
  document.getElementById('card-due-date').disabled        = !editable;
  document.getElementById('card-column-select').disabled   = !editable;

  // Buttons that perform writes
  const writeIds = [
    'save-card-btn', 'delete-card-btn',
    'add-label-btn', 'label-input', 'label-color-picker',
    'add-checklist-btn', 'checklist-input',
    'cover-upload-btn', 'cover-remove-btn',
    'add-attachment-btn', 'preset-tags-row',
  ];
  writeIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = editable ? '' : 'none';
  });

  // Assignee selector — viewers can only read it, not change it
  const assigneeDisplay = document.getElementById('assignee-display');
  if (assigneeDisplay) {
    assigneeDisplay.style.cursor       = editable ? 'pointer' : 'default';
    assigneeDisplay.style.pointerEvents = editable ? '' : 'none';
  }

  // Comment input — viewers cannot comment
  const commentArea = document.getElementById('comment-input');
  const commentBtn  = document.getElementById('post-comment-btn');
  if (commentArea) commentArea.style.display = editable ? '' : 'none';
  if (commentBtn)  commentBtn.style.display  = editable ? '' : 'none';

  // Cover swatches hidden for viewers
  const coverSwatches = document.getElementById('cover-color-swatches');
  if (coverSwatches) coverSwatches.style.display = editable ? '' : 'none';

  // Visual cue in modal header for viewers
  let viewerBanner = document.getElementById('viewer-banner');
  if (!editable) {
    if (!viewerBanner) {
      viewerBanner = document.createElement('div');
      viewerBanner.id = 'viewer-banner';
      viewerBanner.style.cssText =
        'background:var(--bg-active);color:var(--text-secondary);font-size:11px;' +
        'text-align:center;padding:4px 0;border-radius:4px;margin-bottom:8px;';
      viewerBanner.textContent = 'View only \u2014 you have Viewer access on this project';
      document.getElementById('card-modal')
        ?.querySelector('.modal-body')
        ?.prepend(viewerBanner);
    }
    viewerBanner.style.display = '';
  } else if (viewerBanner) {
    viewerBanner.style.display = 'none';
  }
}

// ── Wire Events ───────────────────────────────────────────────────────────

let _eventsWired = false;

function wireEvents() {
  if (_eventsWired) return;
  _eventsWired = true;

  // Auto-resize title
  const titleInput = document.getElementById('card-title-input');
  titleInput.addEventListener('input', () => autoResizeTextarea(titleInput));

  // Priority → update bar
  document.getElementById('card-priority-select').addEventListener('change', (e) => {
    _card.priority = e.target.value;
    const bar = document.getElementById('card-priority-bar');
    bar.className = `card-priority-bar priority-${_card.priority}`;
  });

  // Status → live-preview completed date
  document.getElementById('card-status-select')?.addEventListener('change', (e) => {
    const status = e.target.value;
    if (status === 'completed' && !_card.completedAt) {
      // Preview: show "now" until officially saved
      const item    = document.getElementById('card-completed-item');
      const display = document.getElementById('card-completed-display');
      if (item && display) {
        display.textContent = formatCardDate(Date.now());
        item.style.display = '';
      }
    } else if (status !== 'completed') {
      const item = document.getElementById('card-completed-item');
      if (item) item.style.display = 'none';
    }
  });

  // Label color picker
  document.getElementById('label-color-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.color-dot');
    if (!btn) return;
    document.querySelectorAll('.color-dot').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    _labelColor = btn.dataset.color;
  });

  // Add label
  document.getElementById('add-label-btn').addEventListener('click', addLabel);
  document.getElementById('label-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLabel(); }
  });

  // Checklist add
  document.getElementById('add-checklist-btn').addEventListener('click', addChecklistItem);
  document.getElementById('checklist-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); }
  });

  // ── Cover events ─────────────────────────────────────────────────────────

  document.getElementById('cover-color-swatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.cover-swatch');
    if (!btn) return;
    _card.cover = { type: 'color', value: btn.dataset.color };
    renderCover();
  });

  const coverUploadBtn = document.getElementById('cover-upload-btn');
  const coverFileInput = document.getElementById('cover-file-input');
  const coverGate      = document.getElementById('cover-premium-gate');

  coverUploadBtn?.addEventListener('click', () => {
    if (!storage.isPremiumMode()) {
      if (coverGate) coverGate.style.display = '';
      return;
    }
    coverFileInput?.click();
  });

  coverFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', 'warning');
      e.target.value = '';
      return;
    }
    if (file.size > storage.MAX_ATTACHMENT_SIZE_BYTES) {
      showToast('Cover image too large \u2014 maximum size is 10 MB', 'warning');
      e.target.value = '';
      return;
    }
    try {
      showToast('Uploading cover...', 'info');
      const url = await storage.uploadCover(
        window._currentProjectId, _card.id, file
      );
      _card.cover = { type: 'image', value: url };
      renderCover();
      showToast('Cover uploaded', 'success');
    } catch (err) {
      if (err.message === 'STORAGE_QUOTA_EXCEEDED') {
        showToast('Storage limit reached \u2014 go to Settings to buy more storage.', 'error');
      } else {
        showToast('Cover upload failed', 'error');
      }
      console.error(err);
    }
    e.target.value = '';
  });

  document.getElementById('cover-remove-btn')?.addEventListener('click', () => {
    _card.cover = { type: null, value: null };
    renderCover();
  });

  // ── Attachment events ─────────────────────────────────────────────────────

  const addAttBtn      = document.getElementById('add-attachment-btn');
  const attFileInput   = document.getElementById('attachment-file-input');
  const attPremiumGate = document.getElementById('attachment-premium-gate');

  addAttBtn?.addEventListener('click', () => {
    if (!storage.isPremiumMode()) {
      if (attPremiumGate) attPremiumGate.style.display = '';
      return;
    }
    attFileInput?.click();
  });

  attFileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    for (const file of files) {
      // Hard cap: 10 MB per file
      if (file.size > storage.MAX_ATTACHMENT_SIZE_BYTES) {
        showToast(`${file.name} is too large \u2014 maximum attachment size is 10 MB`, 'warning');
        continue;
      }

      try {
        showToast(`Uploading ${file.name}...`, 'info');
        const timestamp = Date.now();
        const url = await storage.uploadAttachment(
          window._currentProjectId, _card.id, file
        );
        if (!_card.attachments) _card.attachments = [];
        _card.attachments.push({
          id:          timestamp.toString(),
          name:        file.name,
          url,
          storagePath: `attachments/${window._currentProjectId}/${_card.id}/${timestamp}_${file.name}`,
          type:        file.type,
          size:        file.size,
          uploadedAt:  new Date().toISOString(),
        });
        renderAttachments();
        showToast(`${file.name} attached`, 'success');
      } catch (err) {
        if (err.message === 'STORAGE_QUOTA_EXCEEDED') {
          showToast('Storage limit reached \u2014 go to Settings to buy more storage.', 'error');
          break; // No point trying the remaining files
        } else {
          showToast(`Failed to upload ${file.name}`, 'error');
        }
        console.error(err);
      }
    }
    e.target.value = '';
  });

  // Save card
  document.getElementById('save-card-btn').addEventListener('click', saveCard);

  // Delete card
  document.getElementById('delete-card-btn').addEventListener('click', deleteCard);

  // Post comment
  document.getElementById('post-comment-btn').addEventListener('click', postComment);
  document.getElementById('comment-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(); }
  });

  // Close buttons / overlay
  document.querySelectorAll('[data-close="card"]').forEach((btn) => {
    btn.addEventListener('click', closeCardModal);
  });

  document.getElementById('card-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('card-modal')) closeCardModal();
  });
}

// ── Actions ───────────────────────────────────────────────────────────────

function addLabel() {
  const input = document.getElementById('label-input');
  const name  = input.value.trim();
  if (!name) return;
  if (!_card.labels) _card.labels = [];
  _card.labels.push({ name, color: _labelColor });
  input.value = '';
  renderLabels();
  renderPresetTags();
}

function addChecklistItem() {
  const input = document.getElementById('checklist-input');
  const text  = input.value.trim();
  if (!text) return;
  if (!_card.checklist) _card.checklist = [];
  _card.checklist.push({ id: Date.now().toString(), text, completed: false });
  input.value = '';
  renderChecklist();
}

async function saveCard() {
  const title = document.getElementById('card-title-input').value.trim();
  if (!title) { showToast('Card title is required', 'warning'); return; }

  const newColumnId = document.getElementById('card-column-select').value;
  const projectId   = window._currentProjectId;

  const DOMPurify = window.DOMPurify;

  // Get rich text description from Quill (sanitized HTML)
  const description = _quill
    ? (DOMPurify ? DOMPurify.sanitize(_quill.root.innerHTML) : _quill.root.innerHTML)
    : '';

  const newStatus = document.getElementById('card-status-select')?.value ?? (_card.status ?? 'new');

  // Auto-set completedAt when status moves to 'completed'; clear when moving away
  let completedAt = _card.completedAt ?? null;
  if (newStatus === 'completed' && !completedAt) {
    completedAt = Date.now();
  } else if (newStatus !== 'completed') {
    completedAt = null;
  }

  const updates = {
    title,
    description,
    priority:    document.getElementById('card-priority-select').value,
    status:      newStatus,
    dueDate:     document.getElementById('card-due-date').value || null,
    completedAt,
    labels:      _card.labels ?? [],
    checklist:   _card.checklist ?? [],
    assigneeId:  _card.assigneeId ?? null,
    assigneeName: _card.assigneeName ?? null,
    cover:       _card.cover ?? null,
    attachments: _card.attachments ?? [],
  };

  try {
    // If column changed, move the card first
    if (newColumnId !== _columnId) {
      await storage.moveCard({
        projectId,
        cardId:       _card.id,
        fromColumnId: _columnId,
        toColumnId:   newColumnId,
        newIndex:     0,
      });
      _columnId = newColumnId;
    }

    await storage.updateCard(projectId, _columnId, _card.id, updates);

    showToast('Card saved', 'success');
    closeCardModal();

    // Refresh the board to reflect all changes
    if (window._refreshBoard) window._refreshBoard();
  } catch (err) {
    showToast('Failed to save card', 'error');
    console.error(err);
  }
}

async function deleteCard() {
  if (!confirm('Delete this card? This cannot be undone.')) return;

  try {
    await storage.deleteCard(window._currentProjectId, _columnId, _card.id);

    const cardEl = document.querySelector(`[data-card-id="${_card.id}"]`);
    if (cardEl) {
      const colEl = cardEl.closest('.column');
      cardEl.remove();
      colEl?.querySelector('.column-count') &&
        (colEl.querySelector('.column-count').textContent =
          colEl.querySelector('.cards-container').children.length);
    }

    showToast('Card deleted', 'success');
    closeCardModal();
  } catch (err) {
    showToast('Failed to delete card', 'error');
  }
}

async function postComment() {
  const input   = document.getElementById('comment-input');
  const text    = input.value.trim();
  if (!text) return;

  const user = getCurrentUser();
  if (!user) { showToast('Sign in to comment', 'warning'); return; }

  try {
    await addComment(
      window._currentProjectId, _columnId, _card.id, user.uid,
      text
    );
    input.value = '';
  } catch (err) {
    showToast('Failed to post comment', 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts)
    : ts?.toDate ? ts.toDate()
    : new Date(ts);
  const now = new Date();
  const diff = Math.round((now - d) / 60000);
  if (diff < 1)   return 'just now';
  if (diff < 60)  return `${diff}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format a timestamp (ms number | ISO string | Firebase Timestamp) as readable date+time. */
function formatCardDate(ts) {
  if (!ts) return '\u2014';
  let d;
  if (typeof ts === 'number') {
    d = new Date(ts);
  } else if (typeof ts === 'object' && typeof ts.toDate === 'function') {
    d = ts.toDate();                        // Firestore Timestamp instance
  } else if (typeof ts === 'object' && ts.seconds != null) {
    d = new Date(ts.seconds * 1000);        // Serialised {seconds, nanoseconds}
  } else {
    d = new Date(Date.parse(String(ts)));   // ISO string or other
  }
  if (!d || isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** Show the "Created by" info with avatar and name/email. */
function renderCreatedBy(card) {
  const container = document.getElementById('card-created-by-display');
  const item = document.getElementById('card-created-by-item');
  if (!container || !item) return;

  if (!card.createdByUid && !card.createdByName) {
    item.style.display = 'none';
    return;
  }

  item.style.display = '';
  container.innerHTML = '';

  const avatar = document.createElement('div');
  avatar.className = 'created-by-avatar';
  // Only allow https:// photo URLs to prevent XSS
  const safePhoto = card.createdByPhoto && /^https:\/\//i.test(card.createdByPhoto)
    ? card.createdByPhoto : null;
  if (safePhoto) {
    const img = document.createElement('img');
    img.src = safePhoto;
    img.alt = card.createdByName ?? '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = (card.createdByName ?? card.createdByEmail ?? '?').charAt(0).toUpperCase();
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'created-by-name';
  const user = getCurrentUser();
  if (card.createdByUid === user?.uid) {
    nameSpan.textContent = 'You';
  } else {
    nameSpan.textContent = card.createdByName ?? card.createdByEmail ?? 'Unknown';
  }

  // Show email on hover if available
  if (card.createdByEmail) {
    nameSpan.title = card.createdByEmail;
  }

  container.appendChild(avatar);
  container.appendChild(nameSpan);
}

/** Show or hide the Completed date based on card status. */
function renderCompletedDate(card) {
  const item    = document.getElementById('card-completed-item');
  const display = document.getElementById('card-completed-display');
  if (!item || !display) return;

  if (card.status === 'completed' && card.completedAt) {
    display.textContent = formatCardDate(card.completedAt);
    item.style.display = '';
  } else {
    item.style.display = 'none';
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#6366f1';
}

function sanitizeStorageUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    if (!u.hostname.endsWith('firebasestorage.googleapis.com') &&
        !u.hostname.endsWith('storage.googleapis.com')) return '';
    return url;
  } catch (_) {
    return '';
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Modal helpers (shared) ─────────────────────────────────────────────────

function openModal(name) {
  document.getElementById(`${name}-modal`)?.classList.remove('hidden');
}

function closeModal(name) {
  document.getElementById(`${name}-modal`)?.classList.add('hidden');
}
