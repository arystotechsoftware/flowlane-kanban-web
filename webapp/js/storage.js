/**
 * storage.js – Unified storage abstraction (web app)
 *
 * Routes read/write calls to either:
 *   - Firestore (Premium users, signed in)
 *   - localStorage (Free / anonymous users)
 *
 * The board module only interacts with this file,
 * never with db.js or local-storage.js directly.
 */

import * as local from './local-storage.js';
import * as remote from './db.js';

export { adoptAnonymousData } from './local-storage.js';

// ── Storage quota constants ────────────────────────────────────────────────

/** Free quota every premium user gets (512 MB). */
export const STORAGE_FREE_QUOTA_BYTES = 512 * 1024 * 1024;

/** Extra bytes added per storage addon purchase (1 GB per pack). */
const STORAGE_ADDON_BYTES = 1024 * 1024 * 1024; // eslint-disable-line no-unused-vars

/** Hard cap per individual file upload (10 MB). */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

export const FREE_PROJECT_LIMIT = 3;

let _isPremium = false;
let _uid = null;
let _userRole = 'admin'; // 'admin' | 'editor' | 'viewer'

export function configure({ isPremium, uid }) {
  _isPremium = isPremium;
  _uid = uid;
  _userRole = 'admin'; // reset to admin per-session; selectProject() updates per project
  local.setLocalUser(uid);
}

export function isPremiumMode() { return _isPremium; }
export function currentUid()    { return _uid; }

/** Set the current user's role for the active project. */
export function setUserRole(role) { _userRole = role ?? 'admin'; }
export function getUserRole()     { return _userRole; }
/** True for admin or editor — can write cards/columns. */
export function canEdit()  { return _userRole === 'admin' || _userRole === 'editor'; }
/** True only for admin — can delete project, manage collaborators. */
export function canAdmin() { return _userRole === 'admin'; }

// ── PROJECTS ──────────────────────────────────────────────────────────────

export async function getProjects() {
  if (_isPremium) {
    return new Promise((resolve) => {
      const unsub = remote.listenProjects(_uid, (projects) => {
        unsub();
        resolve(projects);
      });
    });
  }
  return local.localGetProjects();
}

export async function createProject(data) {
  if (!_isPremium) {
    const projects = await local.localGetProjects();
    if (projects.length >= FREE_PROJECT_LIMIT) {
      throw new Error('FREE_LIMIT');
    }
    return local.localCreateProject(_uid, data);
  }
  return remote.createProject(_uid, data);
}

export async function updateProject(projectId, data) {
  if (_isPremium) return remote.updateProject(projectId, data);
  return local.localUpdateProject(projectId, data);
}

export async function deleteProject(projectId) {
  if (_isPremium) return remote.deleteProject(projectId);
  return local.localDeleteProject(projectId);
}

// ── COLUMNS ───────────────────────────────────────────────────────────────

export async function getColumns(projectId) {
  if (_isPremium) {
    return new Promise((resolve) => {
      const unsub = remote.listenColumns(projectId, (cols) => {
        unsub();
        resolve(cols);
      });
    });
  }
  return local.localGetColumns(projectId);
}

export async function createColumn(projectId, data) {
  if (_isPremium) return remote.createColumn(projectId, data);
  return local.localCreateColumn(projectId, data);
}

export async function updateColumn(projectId, columnId, data) {
  if (_isPremium) return remote.updateColumn(projectId, columnId, data);
  return local.localUpdateColumn(projectId, columnId, data);
}

export async function deleteColumn(projectId, columnId) {
  if (_isPremium) return remote.deleteColumn(projectId, columnId);
  return local.localDeleteColumn(projectId, columnId);
}

// ── CARDS ─────────────────────────────────────────────────────────────────

export async function getCards(projectId, columnId) {
  if (_isPremium) {
    return new Promise((resolve) => {
      const unsub = remote.listenCards(projectId, columnId, (cards) => {
        unsub();
        resolve(cards);
      });
    });
  }
  return local.localGetCards(projectId, columnId);
}

export async function createCard(projectId, columnId, data) {
  if (_isPremium) return remote.createCard(projectId, columnId, data);
  return local.localCreateCard(projectId, columnId, data);
}

export async function updateCard(projectId, columnId, cardId, data) {
  if (_isPremium) return remote.updateCard(projectId, columnId, cardId, data);
  return local.localUpdateCard(projectId, columnId, cardId, data);
}

export async function deleteCard(projectId, columnId, cardId) {
  if (_isPremium) return remote.deleteCard(projectId, columnId, cardId);
  return local.localDeleteCard(projectId, columnId, cardId);
}

export async function moveCard(params) {
  if (_isPremium) return remote.moveCard(params);
  return local.localMoveCard(params);
}

// ── FILE STORAGE (Premium only) ───────────────────────────────────────────

/**
 * Returns the user's storage quota and current usage.
 * Shows 0 / 512 MB for non-premium / unauthenticated users.
 */
export async function getStorageUsage() {
  if (!_isPremium || !_uid) {
    return { usedBytes: 0, extraBytes: 0, quotaBytes: STORAGE_FREE_QUOTA_BYTES };
  }
  const { usedBytes, extraBytes } = await remote.getStorageUsage(_uid);
  return {
    usedBytes:  Math.max(0, usedBytes),
    extraBytes,
    quotaBytes: STORAGE_FREE_QUOTA_BYTES + extraBytes,
  };
}

/**
 * Throws 'STORAGE_QUOTA_EXCEEDED' if adding `fileSizeBytes` would exceed
 * the user's total quota (free 512 MB + any purchased extra storage).
 */
async function _enforceStorageQuota(fileSizeBytes) {
  const { usedBytes, extraBytes } = await remote.getStorageUsage(_uid);
  const quotaBytes = STORAGE_FREE_QUOTA_BYTES + extraBytes;
  if (usedBytes + fileSizeBytes > quotaBytes) {
    throw new Error('STORAGE_QUOTA_EXCEEDED');
  }
}

/**
 * Upload a cover image for a card.
 * Free tier: only color covers are supported; this is only called for image uploads.
 */
export async function uploadCover(projectId, cardId, file) {
  if (!_isPremium) throw new Error('PREMIUM_REQUIRED');
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) throw new Error('FILE_TOO_LARGE');
  await _enforceStorageQuota(file.size);

  const path = `covers/${projectId}/${cardId}`;
  const url  = await remote.uploadFile(path, file);

  // Track usage — non-fatal if this fails
  await remote.adjustStorageUsed(_uid, file.size).catch(() => {});
  return url;
}

/**
 * Upload an attachment file for a card.
 * Enforces the 10 MB per-file cap and the user's total storage quota.
 * Returns the download URL.
 */
export async function uploadAttachment(projectId, cardId, file) {
  if (!_isPremium) throw new Error('PREMIUM_REQUIRED');
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) throw new Error('FILE_TOO_LARGE');
  await _enforceStorageQuota(file.size);

  const timestamp = Date.now();
  const path = `attachments/${projectId}/${cardId}/${timestamp}_${file.name}`;
  const url  = await remote.uploadFile(path, file);

  // Track usage — non-fatal if this fails
  await remote.adjustStorageUsed(_uid, file.size).catch(() => {});
  return url;
}

/**
 * Delete an attachment from Firebase Storage by its full storage path.
 * Pass fileSize so the usage counter is decremented correctly.
 */
export async function deleteAttachment(storagePath, fileSize = 0) {
  if (!_isPremium) throw new Error('PREMIUM_REQUIRED');
  await remote.deleteFile(storagePath);
  if (fileSize > 0) {
    await remote.adjustStorageUsed(_uid, -fileSize).catch(() => {});
  }
}

// ── DATA MIGRATION (local → cloud on upgrade) ─────────────────────────────

export async function migrateLocalToCloud(uid) {
  const localData = await local.exportLocalData();
  const { projects, columns, cards } = localData;

  // Nothing to migrate — bail out early
  if (Object.keys(projects).length === 0) return;

  // If the user already has projects in Firestore, skip to avoid duplicates
  const existingCloud = await new Promise((resolve) => {
    const unsub = remote.listenProjects(uid, (ps) => { unsub(); resolve(ps); });
  });
  if (existingCloud.length > 0) {
    await local.clearLocalData();
    return;
  }

  for (const [localProjectId, project] of Object.entries(projects)) {
    const newProjectId = await remote.createProject(uid, {
      name:        project.name,
      description: project.description ?? '',
      color:       project.color ?? '#6366f1',
    }, { seedColumns: false });

    const projectCols = Object.values(columns[localProjectId] ?? {});
    projectCols.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const col of projectCols) {
      const newColId = await remote.createColumn(newProjectId, {
        name:  col.name,
        color: col.color ?? '#7d8590',
        order: col.order ?? 0,
      });

      const colCards = Object.values(cards[localProjectId]?.[col.id] ?? {});
      for (const card of colCards) {
        await remote.createCard(newProjectId, newColId, {
          title:       card.title ?? '',
          description: card.description ?? '',
          labels:      card.labels ?? [],
          priority:    card.priority ?? 'none',
          dueDate:     card.dueDate ?? null,
          assigneeId:  card.assigneeId ?? null,
          order:       card.order ?? 0,
          checklist:   card.checklist ?? [],
        });
      }
    }
  }

  await local.clearLocalData();
}
