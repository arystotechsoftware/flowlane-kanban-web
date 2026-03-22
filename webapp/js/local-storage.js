/**
 * local-storage.js – Local storage layer for Free-tier users
 *
 * Uses window.localStorage (web app replacement for chrome.storage.local).
 * Mirrors the Firestore data model as closely as possible so the
 * storage.js abstraction can swap between the two seamlessly.
 *
 * Schema (all stored under the "flowlane_v1" key):
 * {
 *   projects:        { [id]: ProjectDoc },
 *   deletedProjects: { [id]: DeletedProjectDoc },
 *   columns:         { [projectId]: { [id]: ColumnDoc } },
 *   cards:           { [projectId]: { [columnId]: { [id]: CardDoc } } },
 * }
 */

let _rootKey = 'flowlane_v1';
const SOFT_DELETE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/** Call this when a user signs in or signs out to namespace data per account. */
export function setLocalUser(uid) {
  _rootKey = uid ? `flowlane_v1_${uid}` : 'flowlane_v1';
}

// -- low-level localStorage helpers -----------------------------------------

function getRoot() {
  try {
    const raw = localStorage.getItem(_rootKey);
    const data = raw ? JSON.parse(raw) : null;
    return {
      projects: {},
      deletedProjects: {},
      columns: {},
      cards: {},
      ...(data ?? {}),
    };
  } catch {
    return { projects: {}, deletedProjects: {}, columns: {}, cards: {} };
  }
}

function saveRoot(root) {
  localStorage.setItem(_rootKey, JSON.stringify(root));
}

// -- ID generation ----------------------------------------------------------

export function localId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function cloneLocalData(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function getRestoreUntilMs(project = {}) {
  return project.restoreUntil ?? ((project.deletedAt ?? 0) ? (project.deletedAt + SOFT_DELETE_RETENTION_MS) : 0);
}

// -- PROJECTS ---------------------------------------------------------------

export async function localCreateProject(uid, data) {
  const root = getRoot();
  const id = localId();
  root.projects[id] = {
    ...data,
    id,
    ownerId:       uid ?? 'local',
    projectStatus: 'new',
    openedAt:      Date.now(),
    createdAt:     Date.now(),
    updatedAt:     Date.now(),
  };

  // Seed default columns
  if (!root.columns[id]) root.columns[id] = {};
  const defaultCols = [
    { name: 'To Do',       color: '#6366f1', order: 0 },
    { name: 'In Progress', color: '#f59e0b', order: 1 },
    { name: 'Done',        color: '#10b981', order: 2 },
  ];
  for (const col of defaultCols) {
    const colId = localId();
    root.columns[id][colId] = { ...col, id: colId, createdAt: Date.now() };
  }

  saveRoot(root);
  return id;
}

export async function localGetProjects() {
  const root = getRoot();
  return Object.values(root.projects)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export async function localUpdateProject(projectId, data) {
  const root = getRoot();
  if (!root.projects[projectId]) return;
  root.projects[projectId] = {
    ...root.projects[projectId],
    ...data,
    updatedAt: Date.now(),
  };
  saveRoot(root);
}

export async function localDeleteProject(projectId) {
  const root = getRoot();
  const project = root.projects[projectId];
  if (!project) return;

  const deletedAt = Date.now();

  root.deletedProjects[projectId] = {
    id: projectId,
    name: project.name ?? 'Untitled Project',
    color: project.color ?? '#6366f1',
    code: project.code ?? '',
    ownerId: project.ownerId ?? 'local',
    projectStatus: project.projectStatus ?? 'new',
    createdAt: project.createdAt ?? Date.now(),
    deletedAt,
    restoreUntil: deletedAt + SOFT_DELETE_RETENTION_MS,
    deleteMode: 'soft',
    project: cloneLocalData(project),
    columns: cloneLocalData(root.columns[projectId]),
    cards: cloneLocalData(root.cards[projectId]),
  };

  delete root.projects[projectId];
  delete root.columns[projectId];
  delete root.cards[projectId];
  saveRoot(root);
}

export async function localGetDeletedProjects() {
  const root = getRoot();
  const now = Date.now();
  const deletedProjects = Object.values(root.deletedProjects ?? {});
  let removedExpired = false;

  for (const project of deletedProjects) {
    const restoreUntil = getRestoreUntilMs(project);
    if (restoreUntil && restoreUntil < now) {
      delete root.deletedProjects[project.id];
      removedExpired = true;
    }
  }

  if (removedExpired) {
    saveRoot(root);
  }

  return Object.values(root.deletedProjects ?? {})
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

export async function localRestoreDeletedProject(projectId) {
  const root = getRoot();
  const archived = root.deletedProjects?.[projectId];
  if (!archived) return null;
  if (getRestoreUntilMs(archived) && getRestoreUntilMs(archived) < Date.now()) {
    delete root.deletedProjects[projectId];
    saveRoot(root);
    throw new Error('RESTORE_EXPIRED');
  }

  root.projects[projectId] = {
    ...cloneLocalData(archived.project),
    id: projectId,
    updatedAt: Date.now(),
    restoredAt: Date.now(),
  };
  root.columns[projectId] = cloneLocalData(archived.columns);
  root.cards[projectId] = cloneLocalData(archived.cards);

  delete root.deletedProjects[projectId];
  saveRoot(root);
  return projectId;
}

export async function localHardDeleteProject(projectId) {
  const root = getRoot();
  delete root.projects[projectId];
  delete root.columns[projectId];
  delete root.cards[projectId];
  saveRoot(root);
}

// -- COLUMNS ----------------------------------------------------------------

export async function localGetColumns(projectId) {
  const root = getRoot();
  const cols = Object.values(root.columns[projectId] ?? {});
  return cols.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function localCreateColumn(projectId, data) {
  const root = getRoot();
  if (!root.columns[projectId]) root.columns[projectId] = {};
  const id = localId();
  root.columns[projectId][id] = { ...data, id, createdAt: Date.now() };
  saveRoot(root);
  return id;
}

export async function localUpdateColumn(projectId, columnId, data) {
  const root = getRoot();
  if (!root.columns[projectId]?.[columnId]) return;
  root.columns[projectId][columnId] = {
    ...root.columns[projectId][columnId],
    ...data,
  };
  saveRoot(root);
}

export async function localDeleteColumn(projectId, columnId) {
  const root = getRoot();
  delete root.columns[projectId]?.[columnId];
  delete root.cards[projectId]?.[columnId];
  saveRoot(root);
}

// -- CARDS ------------------------------------------------------------------

export async function localGetCards(projectId, columnId) {
  const root = getRoot();
  const cards = Object.values(root.cards[projectId]?.[columnId] ?? {});
  return cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function localCreateCard(projectId, columnId, data) {
  const root = getRoot();

  // Atomically increment project card counter and build key
  const project = root.projects[projectId];
  const counter = (project?.cardCounter ?? 0) + 1;
  if (project) project.cardCounter = counter;
  const code = project?.code ?? 'CARD';
  const key  = `${code}-${counter}`;

  if (!root.cards[projectId]) root.cards[projectId] = {};
  if (!root.cards[projectId][columnId]) root.cards[projectId][columnId] = {};
  const id = localId();
  root.cards[projectId][columnId][id] = {
    ...data,
    key,
    cover:       data.cover       ?? null,
    attachments: data.attachments ?? [],
    status:      data.status      ?? 'new',
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveRoot(root);
  return { id, key };
}

export async function localUpdateCard(projectId, columnId, cardId, data) {
  const root = getRoot();
  if (!root.cards[projectId]?.[columnId]?.[cardId]) return;
  root.cards[projectId][columnId][cardId] = {
    ...root.cards[projectId][columnId][cardId],
    ...data,
    updatedAt: Date.now(),
  };
  saveRoot(root);
}

export async function localDeleteCard(projectId, columnId, cardId) {
  const root = getRoot();
  delete root.cards[projectId]?.[columnId]?.[cardId];
  saveRoot(root);
}

export async function localMoveCard({ projectId, cardId, fromColumnId, toColumnId, newIndex }) {
  const root = getRoot();
  const card = root.cards[projectId]?.[fromColumnId]?.[cardId];
  if (!card) return;

  if (fromColumnId !== toColumnId) {
    delete root.cards[projectId][fromColumnId][cardId];
    if (!root.cards[projectId][toColumnId]) {
      root.cards[projectId][toColumnId] = {};
    }
    root.cards[projectId][toColumnId][cardId] = {
      ...card,
      order: newIndex,
      updatedAt: Date.now(),
    };
  } else {
    root.cards[projectId][fromColumnId][cardId].order = newIndex;
  }

  saveRoot(root);
}

// -- EXPORT / IMPORT (for migrating free -> premium) ------------------------

export async function exportLocalData() {
  return getRoot();
}

export async function clearLocalData() {
  saveRoot({ projects: {}, deletedProjects: {}, columns: {}, cards: {} });
}

/**
 * Called on sign-in: if the user-namespaced key is empty but anonymous data
 * exists under 'flowlane_v1_local' (the key used when uid='local' / skipAuth),
 * move it to the user-namespaced key so migration can find it.
 */
export async function adoptAnonymousData(newUid) {
  const newKey  = `flowlane_v1_${newUid}`;
  const anonKey = 'flowlane_v1_local';

  let newData, anonData;
  try {
    const rawNew = localStorage.getItem(newKey);
    newData = rawNew ? JSON.parse(rawNew) : null;
  } catch {
    newData = null;
  }
  try {
    const rawAnon = localStorage.getItem(anonKey);
    anonData = rawAnon ? JSON.parse(rawAnon) : null;
  } catch {
    anonData = null;
  }

  const hasNewData  = newData  && Object.keys(newData.projects  ?? {}).length > 0;
  const hasAnonData = anonData && Object.keys(anonData.projects ?? {}).length > 0;

  if (!hasNewData && hasAnonData) {
    localStorage.setItem(newKey, JSON.stringify(anonData));
    localStorage.removeItem(anonKey);
  }
}
