/**
 * board.js – Kanban board rendering and interactions (Web App)
 *
 * Ported from Chrome extension board.js.
 *
 * Responsibilities:
 *  - Render columns and cards (flat OR swimlane view)
 *  - Handle drag-and-drop via SortableJS
 *  - Inline "add card" form
 *  - Column header editing, column menu (rename/delete)
 *  - Board-level label filter bar
 *  - Swimlane mode: groups cards by status across user-defined columns
 */

import Sortable from 'sortablejs';
import * as storage from './storage.js';
import { canEdit, canAdmin } from './storage.js';
import { showCardModal } from './card-modal.js';
import { showToast } from './ui.js';
import { getCurrentUser } from './auth.js';

const boardEl = () => document.getElementById('board');

// Active Sortable instances (for cleanup)
let sortables = [];
let presenceData = {};

// Board filter state
let _activeFilters = new Set();

// Swimlane state
let _swimlaneMode = false;
let _lastColumns = [];
let _lastCardsByColumn = {};

// Card data map: cardId -> full card object (used by search)
const _cardDataMap = new Map();

// -- Swimlane status definitions ------------------------------------------------

export const SWIMLANE_STATUSES = [
  { id: 'new',          label: 'New',          color: '#6366f1' },
  { id: 'approved',     label: 'Approved',     color: '#06b6d4' },
  { id: 'fixed',        label: 'Fixed',        color: '#8b5cf6' },
  { id: 'for-followup', label: 'For Followup', color: '#f59e0b' },
  { id: 'completed',    label: 'Completed',    color: '#10b981' },
  { id: 'cancelled',    label: 'Cancelled',    color: '#7d8590' },
];

// -- Public API -----------------------------------------------------------------

export function setSwimlaneMode(enabled) {
  _swimlaneMode = !!enabled;
  // Persist preference
  localStorage.setItem('swimlaneMode', JSON.stringify(_swimlaneMode));
  // Re-render if we have data
  if (_lastColumns.length > 0) {
    renderBoard(_lastColumns, _lastCardsByColumn);
  }
}

export function getSwimlaneMode() {
  return _swimlaneMode;
}

export function loadSwimlanePref() {
  try {
    _swimlaneMode = JSON.parse(localStorage.getItem('swimlaneMode')) === true;
  } catch (_) {
    _swimlaneMode = false;
  }
  return _swimlaneMode;
}

/**
 * Full board render for a given project.
 * columns: ColumnDoc[]
 * cardsByColumn: { [columnId]: CardDoc[] }
 */
export function renderBoard(columns, cardsByColumn) {
  // Cache for re-render on swimlane toggle
  _lastColumns      = columns;
  _lastCardsByColumn = cardsByColumn;
  _cardDataMap.clear();

  destroySortables();
  const board = boardEl();
  board.innerHTML = '';
  board.classList.toggle('board--swimlane', _swimlaneMode);

  if (columns.length === 0) {
    board.innerHTML = `
      <div class="empty-board">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <rect x="4" y="8" width="16" height="48" rx="3" fill="currentColor" opacity="0.2"/>
          <rect x="24" y="8" width="16" height="48" rx="3" fill="currentColor" opacity="0.2"/>
          <rect x="44" y="8" width="16" height="48" rx="3" fill="currentColor" opacity="0.2"/>
        </svg>
        <h3>No columns yet</h3>
        <p>Add your first column to get started.</p>
      </div>`;
    const fb = document.getElementById('board-filter-bar');
    if (fb) fb.style.display = 'none';
    return;
  }

  if (_swimlaneMode) {
    renderSwimlaneBoard(columns, cardsByColumn);
  } else {
    renderFlatBoard(columns, cardsByColumn);
  }
}

/** Clear all active filters (called when switching projects). */
export function clearFilters() {
  _activeFilters.clear();
  const fb = document.getElementById('board-filter-bar');
  if (fb) fb.style.display = 'none';
}

// -- Flat Board -----------------------------------------------------------------

function renderFlatBoard(columns, cardsByColumn) {
  const board = boardEl();
  const allCards = [];

  for (const column of columns) {
    const cards = cardsByColumn[column.id] ?? [];
    const colEl = createColumnElement(column, cards);
    board.appendChild(colEl);
    initSortable(colEl.querySelector('.cards-container'), column.id);
    allCards.push(...cards);
  }

  renderFilterBar(allCards);
  filterCards();
}

// -- Swimlane Board -------------------------------------------------------------

function renderSwimlaneBoard(columns, cardsByColumn) {
  const board = boardEl();
  const allCards = Object.values(cardsByColumn).flat();

  // Sticky column header row
  board.appendChild(createSwimlaneHeaderRow(columns));

  // One row per status
  for (const status of SWIMLANE_STATUSES) {
    board.appendChild(createSwimlaneRow(status, columns, cardsByColumn));
  }

  renderFilterBar(allCards);
  filterCards();
}

function createSwimlaneHeaderRow(columns) {
  const row = document.createElement('div');
  row.className = 'sl-header-row';

  // Spacer for the lane-label column
  const spacer = document.createElement('div');
  spacer.className = 'sl-lane-label-spacer';
  row.appendChild(spacer);

  for (const col of columns) {
    const header = document.createElement('div');
    header.className = 'sl-col-header';
    header.dataset.columnId = col.id;

    const bar = document.createElement('div');
    bar.className = 'column-color-bar';
    bar.style.background = sanitizeColor(col.color ?? '#7d8590');

    const name = document.createElement('span');
    name.className = 'sl-col-name';
    name.textContent = col.name;

    header.appendChild(bar);
    header.appendChild(name);
    row.appendChild(header);
  }

  return row;
}

function createSwimlaneRow(status, columns, cardsByColumn) {
  const row = document.createElement('div');
  row.className = 'sl-row';
  row.dataset.status = status.id;

  // Lane label
  const label = document.createElement('div');
  label.className = 'sl-lane-label';

  const dot = document.createElement('div');
  dot.className = 'sl-status-dot';
  dot.style.background = status.color;

  const name = document.createElement('span');
  name.className = 'sl-lane-name';
  name.textContent = status.label;

  label.appendChild(dot);
  label.appendChild(name);
  row.appendChild(label);

  // One cell per column
  for (const col of columns) {
    const wrap = document.createElement('div');
    wrap.className = 'sl-cell-wrap';

    const cell = document.createElement('div');
    cell.className = 'sl-cell cards-container';
    cell.dataset.columnId = col.id;
    cell.dataset.status   = status.id;

    // Cards that belong to this column AND this status
    const colCards = (cardsByColumn[col.id] ?? []).filter(
      (c) => (c.status ?? 'to-do') === status.id
    );
    for (const card of colCards) {
      cell.appendChild(createCardElement(card, col.id));
    }

    wrap.appendChild(cell);

    // Add-card button (outside the Sortable container)
    if (canEdit()) {
      const addBtn = document.createElement('button');
      addBtn.className = 'sl-add-card-btn';
      addBtn.dataset.columnId = col.id;
      addBtn.dataset.status   = status.id;
      addBtn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add`;
      addBtn.addEventListener('click', () => {
        showAddCardForm(wrap, col.id, { status: status.id, cellEl: cell, addBtn });
      });
      wrap.appendChild(addBtn);
    }

    initSwimlaneCell(cell);
    row.appendChild(wrap);
  }

  return row;
}

// -- Filter Bar -----------------------------------------------------------------

function renderFilterBar(allCards) {
  const bar = document.getElementById('board-filter-bar');
  if (!bar) return;

  const labelMap = new Map();
  for (const card of allCards) {
    for (const label of (card.labels ?? [])) {
      if (!labelMap.has(label.name)) {
        labelMap.set(label.name, label.color ?? '#6366f1');
      }
    }
  }

  if (labelMap.size === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  bar.style.display = '';
  bar.innerHTML = '';

  const title = document.createElement('span');
  title.className = 'filter-bar-label';
  title.textContent = 'Filter:';
  bar.appendChild(title);

  labelMap.forEach((color, name) => {
    const chip = document.createElement('button');
    chip.className = 'filter-chip' + (_activeFilters.has(name.toLowerCase()) ? ' active' : '');
    chip.textContent = name;
    chip.style.setProperty('--chip-color', sanitizeColor(color));
    chip.addEventListener('click', () => {
      const key = name.toLowerCase();
      if (_activeFilters.has(key)) _activeFilters.delete(key);
      else                         _activeFilters.add(key);
      renderFilterBar(allCards);
      filterCards();
    });
    bar.appendChild(chip);
  });

  if (_activeFilters.size > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'filter-clear-btn';
    clearBtn.textContent = '\u2715 Clear';
    clearBtn.addEventListener('click', () => {
      _activeFilters.clear();
      renderFilterBar(allCards);
      filterCards();
    });
    bar.appendChild(clearBtn);
  }
}

function filterCards() {
  if (_activeFilters.size === 0) {
    document.querySelectorAll('.card').forEach((el) => { el.style.display = ''; });
    return;
  }
  document.querySelectorAll('.card').forEach((el) => {
    const names = (el.dataset.labelNames || '').split(',').filter(Boolean);
    const match = [..._activeFilters].every((f) => names.includes(f));
    el.style.display = match ? '' : 'none';
  });
}

/**
 * Update presence indicators on cards and in the header.
 */
export function updatePresenceIndicators(presence) {
  presenceData = presence;
  document.querySelectorAll('.card-presence').forEach((el) => el.remove());
  for (const [uid, data] of Object.entries(presence)) {
    if (!data.activeCardId) continue;
    const cardEl = document.querySelector(`[data-card-id="${data.activeCardId}"]`);
    if (!cardEl) continue;

    let bar = cardEl.querySelector('.card-presence');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'card-presence';
      cardEl.appendChild(bar);
    }
    const dotEl = document.createElement('div');
    dotEl.className = 'presence-dot';
    dotEl.style.background = data.color ?? '#6366f1';
    dotEl.title = data.displayName ?? 'Someone';
    bar.appendChild(dotEl);
  }
}

// -- Column element (flat board) ------------------------------------------------

function createColumnElement(column, cards) {
  const col = document.createElement('div');
  col.className = 'column';
  col.dataset.columnId = column.id;

  const editable = canEdit();

  col.innerHTML = `
    <div class="column-header" data-column-id="${column.id}">
      <div class="column-color-bar" style="background:${sanitizeColor(column.color ?? '#7d8590')}"></div>
      <div class="column-name" contenteditable="${editable}" spellcheck="false"
           data-column-id="${column.id}">${escapeHtml(column.name)}</div>
      <span class="column-count">${cards.length}</span>
      ${editable ? `
      <button class="column-menu-btn" data-column-id="${column.id}" title="Column options">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
        </svg>
      </button>` : ''}
    </div>
    <div class="cards-container" data-column-id="${column.id}"></div>
    ${editable ? `
    <button class="add-card-btn" data-column-id="${column.id}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Add card
    </button>` : ''}`;

  const container = col.querySelector('.cards-container');
  for (const card of cards) {
    container.appendChild(createCardElement(card, column.id));
  }

  attachColumnEvents(col, column);
  return col;
}

// -- Card element ---------------------------------------------------------------

function createCardElement(card, columnId) {
  _cardDataMap.set(card.id, { ...card, columnId });

  const el = document.createElement('div');
  el.className = `card priority-${card.priority ?? 'none'}`;
  el.dataset.cardId    = card.id;
  el.dataset.columnId  = columnId;
  el.dataset.status    = card.status ?? 'new';

  const labelNames = (card.labels ?? []).map((l) => l.name.toLowerCase());
  el.dataset.labelNames = labelNames.join(',');

  const labelsHtml = (card.labels ?? []).map((l) =>
    `<span class="card-label" style="background:${sanitizeColor(l.color)}">${escapeHtml(l.name)}</span>`
  ).join('');

  const dueHtml = card.dueDate ? buildDueBadge(card.dueDate) : '';
  const checklistTotal     = (card.checklist ?? []).length;
  const checklistCompleted = (card.checklist ?? []).filter((i) => i.completed).length;
  const checkHtml = checklistTotal > 0
    ? `<span class="card-checklist-badge ${checklistCompleted === checklistTotal ? 'complete' : ''}">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
           <polyline points="20 6 9 17 4 12"/>
         </svg>
         ${checklistCompleted}/${checklistTotal}
       </span>`
    : '';

  const attCount = (card.attachments ?? []).length;
  const attHtml  = attCount > 0
    ? `<span class="card-attach-badge">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
         </svg>
         ${attCount}
       </span>`
    : '';

  el.innerHTML = `
    <div class="card-drag-handle" title="Drag">
      <svg viewBox="0 0 10 16" fill="currentColor">
        <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
        <circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
        <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
      </svg>
    </div>
    ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
    ${card.key ? `<div class="card-key">${escapeHtml(card.key)}</div>` : ''}
    <div class="card-title">${escapeHtml(card.title ?? 'Untitled')}</div>
    ${dueHtml || checkHtml || attHtml
      ? `<div class="card-footer">${dueHtml}<div class="card-meta-badges">${checkHtml}${attHtml}</div></div>`
      : ''}`;

  // Insert cover strip at top via DOM API
  const cover = card.cover;
  if (cover?.type === 'color') {
    const strip = document.createElement('div');
    strip.className = 'card-cover-strip';
    strip.style.background = sanitizeColor(cover.value);
    el.insertBefore(strip, el.firstChild);
  } else if (cover?.type === 'image') {
    const strip = document.createElement('div');
    strip.className = 'card-cover-strip';
    const url = cover.value ?? '';
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' &&
          (u.hostname.endsWith('firebasestorage.googleapis.com') ||
           u.hostname.endsWith('storage.googleapis.com'))) {
        strip.style.backgroundImage    = `url("${url}")`;
        strip.style.backgroundSize     = 'cover';
        strip.style.backgroundPosition = 'center';
      }
    } catch (_) { /* invalid URL */ }
    el.insertBefore(strip, el.firstChild);
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('.card-drag-handle')) return;
    showCardModal(card, columnId);
  });

  return el;
}

function buildDueBadge(dueDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dueDate);
  const diff  = Math.round((due - today) / 86400000);
  const cls   = diff < 0 ? 'overdue' : diff <= 2 ? 'due-soon' : '';
  const label = diff < 0
    ? 'Overdue'
    : diff === 0 ? 'Today'
    : diff === 1 ? 'Tomorrow'
    : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `<span class="card-due ${cls}">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
    ${label}
  </span>`;
}

// -- Column events (flat board) -------------------------------------------------

function attachColumnEvents(colEl, column) {
  const nameEl = colEl.querySelector('.column-name');
  nameEl.addEventListener('blur', async () => {
    if (!canEdit()) { nameEl.textContent = column.name; return; }
    const newName = nameEl.textContent.trim();
    if (newName && newName !== column.name) {
      column.name = newName;
      await storage.updateColumn(window._currentProjectId, column.id, { name: newName })
        .catch(() => showToast('Failed to rename column', 'error'));
    } else {
      nameEl.textContent = column.name;
    }
  });

  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = column.name; nameEl.blur(); }
  });

  colEl.querySelector('.add-card-btn')?.addEventListener('click', () => {
    const container = colEl.querySelector('.cards-container');
    showAddCardForm(colEl, column.id, { cellEl: container });
  });

  colEl.querySelector('.column-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showColumnMenu(e, column, colEl);
  });
}

// -- Add-card inline form -------------------------------------------------------

/**
 * @param {HTMLElement} hostEl   - .column (flat) or .sl-cell-wrap (swimlane)
 * @param {string}      columnId
 * @param {Object}      opts     - { status?, cellEl?, addBtn? }
 */
function showAddCardForm(hostEl, columnId, opts = {}) {
  hostEl.querySelector('.add-card-form')?.remove();

  const status         = opts.status  ?? 'new';
  const cardsContainer = opts.cellEl ?? hostEl.querySelector('.cards-container');
  const insertBefore   = opts.addBtn ?? hostEl.querySelector('.add-card-btn');

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.innerHTML = `
    <textarea class="add-card-textarea" placeholder="Card title..." rows="2" autofocus></textarea>
    <div class="add-card-actions">
      <button class="btn-sm" id="confirm-add-card">Add Card</button>
      <button class="btn-ghost" id="cancel-add-card">Cancel</button>
    </div>`;

  hostEl.insertBefore(form, insertBefore);
  const ta = form.querySelector('.add-card-textarea');
  ta.focus();

  const saveCard = async () => {
    const title = ta.value.trim();
    if (!title) { form.remove(); return; }

    const projectId    = window._currentProjectId;
    const existingCards = cardsContainer.querySelectorAll('.card').length;

    try {
      const user = getCurrentUser();
      const { id: cardId, key: cardKey } = await storage.createCard(projectId, columnId, {
        title,
        description: '',
        labels:      [],
        priority:    'none',
        dueDate:     null,
        assigneeId:  null,
        order:       existingCards,
        checklist:   [],
        status,
        createdByUid:   user?.uid ?? null,
        createdByName:  user?.displayName ?? user?.email ?? null,
        createdByEmail: user?.email ?? null,
        createdByPhoto: user?.photoURL ?? null,
      });

      // Auto-transition project status to "in-progress" when first card is added
      if (window._autoSetProjectInProgress) {
        window._autoSetProjectInProgress();
      }

      form.remove();

      const newCard = { id: cardId, key: cardKey, title, labels: [], priority: 'none',
        checklist: [], order: existingCards, status };
      cardsContainer.appendChild(createCardElement(newCard, columnId));

      if (!_swimlaneMode) updateColumnCount(hostEl);
    } catch (err) {
      showToast('Failed to create card', 'error');
    }
  };

  form.querySelector('#confirm-add-card').addEventListener('click', saveCard);
  form.querySelector('#cancel-add-card').addEventListener('click', () => form.remove());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveCard(); }
    if (e.key === 'Escape') form.remove();
  });
}

// -- Column context menu --------------------------------------------------------

let activeColumnMenu = null;

function showColumnMenu(event, column, colEl) {
  activeColumnMenu?.remove();

  const menu = document.createElement('div');
  menu.className = 'dropdown';
  menu.style.cssText = 'position:fixed;z-index:500;min-width:160px';

  menu.innerHTML = `
    <button class="dropdown-item" id="cmenu-rename">Rename</button>
    <button class="dropdown-item" id="cmenu-clear">Clear cards</button>
    <div class="dropdown-divider"></div>
    <button class="dropdown-item danger-item" id="cmenu-delete">Delete column</button>`;

  const rect = event.target.closest('button').getBoundingClientRect();
  menu.style.top  = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;

  document.body.appendChild(menu);
  activeColumnMenu = menu;

  const close = () => { menu.remove(); activeColumnMenu = null; };
  document.addEventListener('click', close, { once: true });

  menu.querySelector('#cmenu-rename').addEventListener('click', (e) => {
    e.stopPropagation();
    close();
    const nameEl = colEl.querySelector('.column-name');
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });

  menu.querySelector('#cmenu-clear').addEventListener('click', async (e) => {
    e.stopPropagation();
    close();
    if (!confirm(`Clear all cards from "${column.name}"?`)) return;
    const projectId  = window._currentProjectId;
    const container  = colEl.querySelector('.cards-container');
    for (const cardEl of [...container.children]) {
      const cardId = cardEl.dataset.cardId;
      await storage.deleteCard(projectId, column.id, cardId).catch(() => {});
      cardEl.remove();
    }
    updateColumnCount(colEl);
    showToast('Column cleared', 'success');
  });

  menu.querySelector('#cmenu-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    close();
    if (!confirm(`Delete column "${column.name}" and all its cards?`)) return;
    await storage.deleteColumn(window._currentProjectId, column.id)
      .catch(() => showToast('Failed to delete column', 'error'));
    colEl.remove();
    showToast('Column deleted', 'success');
  });
}

// -- SortableJS -----------------------------------------------------------------

/** Flat board: sortable on the cards-container inside a .column */
function initSortable(containerEl, columnId) {
  const s = Sortable.create(containerEl, {
    group:       'cards',
    disabled:    !canEdit(),
    animation:   150,
    handle:      '.card-drag-handle',
    draggable:   '.card',
    ghostClass:  'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass:   'dragging',
    onEnd: async (evt) => {
      const cardId    = evt.item.dataset.cardId;
      const fromColId = evt.from.dataset.columnId;
      const toColId   = evt.to.dataset.columnId;
      const newIndex  = evt.newIndex;

      await storage.moveCard({
        projectId:    window._currentProjectId,
        cardId,
        fromColumnId: fromColId,
        toColumnId:   toColId,
        newIndex,
      }).catch(() => showToast('Failed to move card', 'error'));

      evt.item.dataset.columnId = toColId;

      updateColumnCount(evt.from.closest('.column'));
      if (fromColId !== toColId) {
        updateColumnCount(evt.to.closest('.column'));
      }
    },
  });
  sortables.push(s);
}

/** Swimlane mode: sortable on each .sl-cell */
function initSwimlaneCell(cellEl) {
  const s = Sortable.create(cellEl, {
    group:       'cards',
    disabled:    !canEdit(),
    animation:   150,
    handle:      '.card-drag-handle',
    draggable:   '.card',
    ghostClass:  'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass:   'dragging',
    onEnd: async (evt) => {
      const cardId     = evt.item.dataset.cardId;
      const fromColId  = evt.from.dataset.columnId;
      const toColId    = evt.to.dataset.columnId;
      const fromStatus = evt.item.dataset.status ?? 'new';
      const toStatus   = evt.to.dataset.status   ?? 'new';
      const newIndex   = evt.newIndex;

      // Update data attributes on card element
      evt.item.dataset.columnId = toColId;
      evt.item.dataset.status   = toStatus;

      try {
        // Move between columns (also handles same-column reorder)
        await storage.moveCard({
          projectId:    window._currentProjectId,
          cardId,
          fromColumnId: fromColId,
          toColumnId:   toColId,
          newIndex,
        });

        // Update status if it changed
        if (fromStatus !== toStatus) {
          await storage.updateCard(
            window._currentProjectId, toColId, cardId, { status: toStatus }
          );
        }
      } catch (err) {
        showToast('Failed to move card', 'error');
      }
    },
  });
  sortables.push(s);
}

function destroySortables() {
  sortables.forEach((s) => s.destroy());
  sortables = [];
}

// -- Helpers --------------------------------------------------------------------

function updateColumnCount(colEl) {
  if (!colEl) return;
  const count = colEl.querySelector('.cards-container')?.children.length ?? 0;
  const badge = colEl.querySelector('.column-count');
  if (badge) badge.textContent = count;
}

function sanitizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#7d8590';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html ?? '';
  return tmp.textContent ?? '';
}

// -- Search --------------------------------------------------------------------

/**
 * Filter visible cards by query string.
 * Matches against: card key, title, description text, label names.
 * Pass empty/null query to clear the search filter.
 */
export function searchCards(query) {
  const q = (query ?? '').trim().toLowerCase();
  const board = boardEl();
  if (!board) return;

  board.querySelectorAll('.card').forEach((el) => {
    if (!q) {
      el.classList.remove('search-hidden');
      return;
    }
    const data = _cardDataMap.get(el.dataset.cardId);
    if (!data) { el.classList.add('search-hidden'); return; }

    const haystack = [
      data.key         ?? '',
      data.title       ?? '',
      stripHtml(data.description ?? ''),
      ...(data.labels ?? []).map((l) => l.name),
    ].join(' ').toLowerCase();

    el.classList.toggle('search-hidden', !haystack.includes(q));
  });

  // Update column counts to reflect visible cards
  board.querySelectorAll('.column').forEach((col) => {
    const total   = col.querySelectorAll('.card').length;
    const visible = col.querySelectorAll('.card:not(.search-hidden)').length;
    const badge   = col.querySelector('.column-count');
    if (badge) badge.textContent = q ? `${visible}/${total}` : total;
  });
}

// -- Analytics data export ------------------------------------------------------

/** Returns a snapshot of all loaded card data and column metadata for analytics. */
export function getAnalyticsData() {
  return {
    columns:       _lastColumns,
    cardsByColumn: _lastCardsByColumn,
    cardMap:       new Map(_cardDataMap),
  };
}
