/**
 * db.js – Firestore operations (Premium users)
 *
 * Data model:
 *   users/{uid}
 *   projects/{projectId}
 *     columns/{columnId}
 *       cards/{cardId}
 *   presence/{projectId}/users/{uid}
 *   invites/{inviteId}
 */

import { getFirestore, doc, collection,
  getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, where, orderBy,
  writeBatch, deleteField, runTransaction, increment,
} from 'firebase/firestore';
import {
  getStorage, ref as storageRef,
  uploadBytes, getDownloadURL, deleteObject,
} from 'firebase/storage';
import { app } from './auth.js';

export const db      = getFirestore(app);
export const storage = getStorage(app);

const SOFT_DELETE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// USER
// ---------------------------------------------------------------------------

export async function getUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function upsertUser(uid, data) {
  await setDoc(doc(db, 'users', uid), {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function logUserAction(uid, action, details = {}) {
  if (!uid || !action) return;
  await addDoc(collection(db, 'users', uid, 'actionLogs'), {
    action,
    details,
    timestamp: serverTimestamp(),
  });
}

function normalizeInviteContactEmail(email = '') {
  return email.trim().toLowerCase();
}

export async function getInviteContacts(uid) {
  if (!uid) return [];

  const snap = await getDocs(collection(db, 'users', uid, 'contacts'));
  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => {
      const nameA = (a.name ?? a.email ?? '').toLowerCase();
      const nameB = (b.name ?? b.email ?? '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
}

export async function upsertInviteContact(uid, { name, email }) {
  const normalizedEmail = normalizeInviteContactEmail(email);
  if (!uid || !normalizedEmail) return null;

  const contactRef = doc(db, 'users', uid, 'contacts', normalizedEmail);
  await setDoc(contactRef, {
    name: (name ?? '').trim(),
    email: normalizedEmail,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  return normalizedEmail;
}

export function listenUser(uid, callback) {
  return onSnapshot(doc(db, 'users', uid), (snap) => {
    callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/**
 * Returns the current storage usage for a user.
 * @returns {{ usedBytes: number, extraBytes: number }}
 */
export async function getStorageUsage(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  const data = snap.data() ?? {};
  return {
    usedBytes:  data.storageUsedBytes  ?? 0,
    extraBytes: data.storageQuotaExtra ?? 0,
  };
}

/**
 * Atomically adjusts the user's storage usage counter.
 * Pass a positive value on upload, negative on delete.
 */
export async function adjustStorageUsed(uid, deltaBytes) {
  await updateDoc(doc(db, 'users', uid), {
    storageUsedBytes: increment(deltaBytes),
  });
}

// ---------------------------------------------------------------------------
// PROJECTS
// ---------------------------------------------------------------------------

export async function getProject(projectId) {
  const snap = await getDoc(doc(db, 'projects', projectId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createProject(uid, data, { seedColumns = true } = {}) {
  const ref = await addDoc(collection(db, 'projects'), {
    ...data,
    ownerId:       uid,
    collaborators: { [uid]: 'admin' },
    projectStatus: 'new',
    openedAt:      serverTimestamp(),
    createdAt:     serverTimestamp(),
    updatedAt:     serverTimestamp(),
  });

  if (seedColumns) {
    const batch = writeBatch(db);
    const defaultColumns = [
      { name: 'To Do',       color: '#6366f1', order: 0 },
      { name: 'In Progress', color: '#f59e0b', order: 1 },
      { name: 'Done',        color: '#10b981', order: 2 },
    ];
    for (const col of defaultColumns) {
      const colRef = doc(collection(db, 'projects', ref.id, 'columns'));
      batch.set(colRef, { ...col, createdAt: serverTimestamp() });
    }
    await batch.commit();
  }

  return ref.id;
}

export async function updateProject(projectId, data) {
  await updateDoc(doc(db, 'projects', projectId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Update project status with date tracking and optional remarks.
 * Only admins should call this (enforced in UI).
 */
export async function updateProjectStatus(projectId, newStatus, remarks = '', changedByUid = null) {
  const updates = {
    projectStatus: newStatus,
    updatedAt: serverTimestamp(),
  };

  if (newStatus === 'completed') {
    updates.completedAt = serverTimestamp();
    updates.completionRemarks = remarks;
  } else if (newStatus === 'cancelled') {
    updates.cancelledAt = serverTimestamp();
    updates.cancellationRemarks = remarks;
  } else if (newStatus === 'deferred') {
    updates.deferredAt = serverTimestamp();
    updates.deferralRemarks = remarks;
  } else if (newStatus === 'in-progress') {
    updates.inProgressAt = serverTimestamp();
  }

  await updateDoc(doc(db, 'projects', projectId), updates);

  // Audit trail entry
  await addDoc(collection(db, 'projects', projectId, 'auditLog'), {
    action:    'status_change',
    newStatus,
    remarks:   remarks || null,
    changedBy: changedByUid,
    timestamp: serverTimestamp(),
  });
}

export async function getProjectAuditLog(projectId) {
  const q = query(
    collection(db, 'projects', projectId, 'auditLog'),
    orderBy('timestamp', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getArchivedProjectContent(collectionName, projectId) {
  const columnsSnap = await getDocs(collection(db, collectionName, projectId, 'columns'));
  const columns = columnsSnap.docs.map((colDoc) => ({ id: colDoc.id, ...colDoc.data() }));
  const cardsByColumn = {};

  for (const column of columns) {
    const cardsSnap = await getDocs(
      collection(db, collectionName, projectId, 'columns', column.id, 'cards')
    );
    cardsByColumn[column.id] = cardsSnap.docs.map((cardDoc) => ({ id: cardDoc.id, ...cardDoc.data() }));
  }

  return { columns, cardsByColumn };
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date?.getTime?.()) ? 0 : date.getTime();
  }
  if (typeof value?.seconds === 'number') {
    return value.seconds * 1000;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getRestoreUntilMs(data = {}) {
  return toMillis(data.restoreUntil) || (toMillis(data.deletedAt) ? toMillis(data.deletedAt) + SOFT_DELETE_RETENTION_MS : 0);
}

async function commitBatchOperations(operations) {
  if (!operations.length) return;

  let batch = writeBatch(db);
  let operationCount = 0;

  for (const operation of operations) {
    if (operation.type === 'set') {
      batch.set(operation.ref, operation.data);
    } else if (operation.type === 'delete') {
      batch.delete(operation.ref);
    }

    operationCount += 1;
    if (operationCount === 400) {
      await batch.commit();
      batch = writeBatch(db);
      operationCount = 0;
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }
}

function stripDeletedProjectMetadata(data = {}) {
  const { originalProjectId, deletedAt, restoreUntil, deleteMode, ...projectData } = data;
  return projectData;
}

async function permanentlyDeleteProjectData(projectId, collectionName = 'projects') {
  const { columns, cardsByColumn } = await getArchivedProjectContent(collectionName, projectId);
  const baseRef = doc(db, collectionName, projectId);
  const deleteOperations = [];

  for (const column of columns) {
    for (const card of cardsByColumn[column.id] ?? []) {
      deleteOperations.push({
        type: 'delete',
        ref: doc(db, collectionName, projectId, 'columns', column.id, 'cards', card.id),
      });
    }
    deleteOperations.push({
      type: 'delete',
      ref: doc(db, collectionName, projectId, 'columns', column.id),
    });
  }
  deleteOperations.push({ type: 'delete', ref: baseRef });
  await commitBatchOperations(deleteOperations);
}

export async function deleteProject(projectId) {
  const projectRef = doc(db, 'projects', projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) return;

  const projectData = projectSnap.data();
  const { columns, cardsByColumn } = await getArchivedProjectContent('projects', projectId);
  const deletedProjectRef = doc(db, 'deletedProjects', projectId);

  await setDoc(deletedProjectRef, {
    ...projectData,
    originalProjectId: projectId,
    deletedAt: serverTimestamp(),
    restoreUntil: new Date(Date.now() + SOFT_DELETE_RETENTION_MS),
    deleteMode: 'soft',
  });

  const archiveOperations = [];
  for (const column of columns) {
    const { id: columnId, ...columnData } = column;
    archiveOperations.push({
      type: 'set',
      ref: doc(db, 'deletedProjects', projectId, 'columns', columnId),
      data: columnData,
    });

    for (const card of cardsByColumn[columnId] ?? []) {
      const { id: cardId, ...cardData } = card;
      archiveOperations.push({
        type: 'set',
        ref: doc(db, 'deletedProjects', projectId, 'columns', columnId, 'cards', cardId),
        data: cardData,
      });
    }
  }
  await commitBatchOperations(archiveOperations);

  await permanentlyDeleteProjectData(projectId, 'projects');
}

export async function hardDeleteProject(projectId) {
  const projectRef = doc(db, 'projects', projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) return;
  await permanentlyDeleteProjectData(projectId, 'projects');
}

async function purgeDeletedProjectArchive(projectId, uid = null) {
  const deletedProjectRef = doc(db, 'deletedProjects', projectId);
  const deletedProjectSnap = await getDoc(deletedProjectRef);
  if (!deletedProjectSnap.exists()) return;

  const deletedProjectData = deletedProjectSnap.data();
  if (uid && deletedProjectData.ownerId && deletedProjectData.ownerId !== uid) {
    throw new Error('OWNER_ONLY');
  }

  await permanentlyDeleteProjectData(projectId, 'deletedProjects');
}

export async function getDeletedProjects(uid) {
  if (!uid) return [];

  const deletedQuery = query(
    collection(db, 'deletedProjects'),
    where('ownerId', '==', uid)
  );
  const snap = await getDocs(deletedQuery);
  const allProjects = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  const now = Date.now();
  const activeProjects = [];
  const expiredIds = [];

  for (const project of allProjects) {
    const restoreUntilMs = getRestoreUntilMs(project);
    if (restoreUntilMs && restoreUntilMs < now) {
      expiredIds.push(project.id);
      continue;
    }
    activeProjects.push(project);
  }

  if (expiredIds.length) {
    await Promise.allSettled(expiredIds.map((projectId) => purgeDeletedProjectArchive(projectId, uid)));
  }

  return activeProjects.sort((a, b) => toMillis(b.deletedAt) - toMillis(a.deletedAt));
}

export async function restoreDeletedProject(projectId, uid = null) {
  if (!projectId) return null;

  const deletedProjectRef = doc(db, 'deletedProjects', projectId);
  const deletedProjectSnap = await getDoc(deletedProjectRef);
  if (!deletedProjectSnap.exists()) return null;

  const deletedProjectData = deletedProjectSnap.data();
  if (uid && deletedProjectData.ownerId && deletedProjectData.ownerId !== uid) {
    throw new Error('OWNER_ONLY');
  }
  const restoreUntilMs = getRestoreUntilMs(deletedProjectData);
  if (restoreUntilMs && restoreUntilMs < Date.now()) {
    await purgeDeletedProjectArchive(projectId, uid).catch(() => {});
    throw new Error('RESTORE_EXPIRED');
  }

  const restoredProjectId = deletedProjectData.originalProjectId ?? projectId;
  const restoredProjectRef = doc(db, 'projects', restoredProjectId);
  const existingProjectSnap = await getDoc(restoredProjectRef);
  if (existingProjectSnap.exists()) {
    throw new Error('PROJECT_ALREADY_EXISTS');
  }

  const { columns, cardsByColumn } = await getArchivedProjectContent('deletedProjects', projectId);

  await setDoc(restoredProjectRef, {
    ...stripDeletedProjectMetadata(deletedProjectData),
    restoredAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const restoreOperations = [];
  for (const column of columns) {
    const { id: columnId, ...columnData } = column;
    restoreOperations.push({
      type: 'set',
      ref: doc(db, 'projects', restoredProjectId, 'columns', columnId),
      data: columnData,
    });

    for (const card of cardsByColumn[columnId] ?? []) {
      const { id: cardId, ...cardData } = card;
      restoreOperations.push({
        type: 'set',
        ref: doc(db, 'projects', restoredProjectId, 'columns', columnId, 'cards', cardId),
        data: cardData,
      });
    }
  }
  await commitBatchOperations(restoreOperations);

  await purgeDeletedProjectArchive(projectId, uid);

  return restoredProjectId;
}

export function listenProjects(uid, callback) {
  const q = query(
    collection(db, 'projects'),
    where(`collaborators.${uid}`, 'in', ['admin', 'editor', 'viewer'])
  );
  return onSnapshot(q, (snap) => {
    const projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Sort by createdAt client-side (avoids composite index requirement)
    projects.sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return ta - tb;
    });
    callback(projects);
  });
}

// ---------------------------------------------------------------------------
// COLUMNS
// ---------------------------------------------------------------------------

export async function createColumn(projectId, data) {
  const ref = await addDoc(
    collection(db, 'projects', projectId, 'columns'),
    { ...data, createdAt: serverTimestamp() }
  );
  return ref.id;
}

export async function updateColumn(projectId, columnId, data) {
  await updateDoc(
    doc(db, 'projects', projectId, 'columns', columnId),
    data
  );
}

export async function deleteColumn(projectId, columnId) {
  const cards = await getDocs(
    collection(db, 'projects', projectId, 'columns', columnId, 'cards')
  );
  const batch = writeBatch(db);
  for (const card of cards.docs) batch.delete(card.ref);
  batch.delete(doc(db, 'projects', projectId, 'columns', columnId));
  await batch.commit();
}

export function listenColumns(projectId, callback) {
  return onSnapshot(
    collection(db, 'projects', projectId, 'columns'),
    (snap) => {
      const cols = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cols.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      callback(cols);
    }
  );
}

// ---------------------------------------------------------------------------
// CARDS
// ---------------------------------------------------------------------------

export async function createCard(projectId, columnId, data) {
  const projectRef = doc(db, 'projects', projectId);
  const cardColRef = collection(db, 'projects', projectId, 'columns', columnId, 'cards');

  const result = await runTransaction(db, async (tx) => {
    const projectSnap = await tx.get(projectRef);
    const counter = (projectSnap.data()?.cardCounter ?? 0) + 1;
    const code    = projectSnap.data()?.code ?? 'CARD';
    const key     = `${code}-${counter}`;

    tx.update(projectRef, { cardCounter: counter });

    const newCardRef = doc(cardColRef);
    tx.set(newCardRef, {
      ...data,
      key,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { id: newCardRef.id, key };
  });

  return result;
}

export async function updateCard(projectId, columnId, cardId, data) {
  await updateDoc(
    doc(db, 'projects', projectId, 'columns', columnId, 'cards', cardId),
    { ...data, updatedAt: serverTimestamp() }
  );
}

export async function deleteCard(projectId, columnId, cardId) {
  await deleteDoc(
    doc(db, 'projects', projectId, 'columns', columnId, 'cards', cardId)
  );
}

/**
 * Move a card from one column to another.
 * Updates the order field on all affected cards in a single batch.
 */
export async function moveCard({ projectId, cardId, fromColumnId, toColumnId, newIndex }) {
  const batch = writeBatch(db);

  const cardRef = doc(
    db, 'projects', projectId, 'columns', fromColumnId, 'cards', cardId
  );
  const cardSnap = await getDoc(cardRef);
  if (!cardSnap.exists()) return;

  const cardData = cardSnap.data();

  if (fromColumnId !== toColumnId) {
    batch.delete(cardRef);
    const newCardRef = doc(
      db, 'projects', projectId, 'columns', toColumnId, 'cards', cardId
    );
    batch.set(newCardRef, {
      ...cardData,
      order: newIndex,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.update(cardRef, { order: newIndex, updatedAt: serverTimestamp() });
  }

  await batch.commit();
}

export function listenCards(projectId, columnId, callback) {
  return onSnapshot(
    collection(db, 'projects', projectId, 'columns', columnId, 'cards'),
    (snap) => {
      const cards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      callback(cards);
    }
  );
}

// ---------------------------------------------------------------------------
// COMMENTS (Premium)
// ---------------------------------------------------------------------------

export async function addComment(projectId, columnId, cardId, uid, text) {
  await addDoc(
    collection(
      db, 'projects', projectId, 'columns', columnId, 'cards', cardId, 'comments'
    ),
    {
      uid,
      text,
      createdAt: serverTimestamp(),
    }
  );
}

export function listenComments(projectId, columnId, cardId, callback) {
  const q = query(
    collection(
      db, 'projects', projectId, 'columns', columnId, 'cards', cardId, 'comments'
    ),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---------------------------------------------------------------------------
// COLLABORATION / INVITES
// ---------------------------------------------------------------------------

export async function inviteCollaborator(projectId, email, role, inviter = {}) {
  let projectName = 'a project';
  try {
    const pSnap = await getDoc(doc(db, 'projects', projectId));
    if (pSnap.exists()) projectName = pSnap.data().name ?? projectName;
  } catch (_) {}

  await addDoc(collection(db, 'invites'), {
    projectId,
    projectName,
    email,
    role,
    status:          'pending',
    invitedByUid:    inviter.uid    ?? null,
    invitedByName:   inviter.name   ?? 'A FlowLane user',
    createdAt:       serverTimestamp(),
  });
}

/**
 * Accept a collaboration invite directly via Firestore (no Cloud Function).
 * Atomically: marks the invite as accepted + adds the user to the project.
 */
export async function acceptInvite(inviteId, projectId, role, uid) {
  const batch = writeBatch(db);

  batch.update(doc(db, 'invites', inviteId), {
    status:        'accepted',
    acceptedByUid: uid,
    acceptedAt:    serverTimestamp(),
  });

  batch.update(doc(db, 'projects', projectId), {
    [`collaborators.${uid}`]: role,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
}

/** Fetch all pending invites for a given email address. */
export async function getPendingInvites(email) {
  if (!email) return [];
  const q = query(
    collection(db, 'invites'),
    where('email',  '==', email),
    where('status', '==', 'pending')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Fetch all invites created by a given inviter. */
export async function getSentInvites(invitedByUid) {
  if (!invitedByUid) return [];
  const q = query(
    collection(db, 'invites'),
    where('invitedByUid', '==', invitedByUid)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return tb - ta;
    });
}

/** Fetch all accepted invites for the signed-in recipient, including legacy records. */
export async function getAcceptedInvites(acceptedByUid, email = '') {
  const inviteQueries = [];
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';

  if (acceptedByUid) {
    inviteQueries.push(
      getDocs(query(
        collection(db, 'invites'),
        where('acceptedByUid', '==', acceptedByUid)
      ))
    );
  }

  if (trimmedEmail) {
    inviteQueries.push(
      getDocs(query(
        collection(db, 'invites'),
        where('email', '==', trimmedEmail),
        where('status', '==', 'accepted')
      ))
    );
  }

  if (!inviteQueries.length) return [];

  const snapshots = await Promise.all(inviteQueries);
  const invites = new Map();

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      const invite = { id: docSnap.id, ...docSnap.data() };
      if ((invite.status ?? 'pending') !== 'accepted') continue;
      invites.set(docSnap.id, invite);
    }
  }

  return Array.from(invites.values()).sort((a, b) => {
    const ta = a.acceptedAt?.seconds || a.createdAt?.seconds || 0;
    const tb = b.acceptedAt?.seconds || b.createdAt?.seconds || 0;
    return tb - ta;
  });
}

export async function declineInvite(inviteId, declinedByUid = null) {
  await updateDoc(doc(db, 'invites', inviteId), {
    status: 'declined',
    declinedByUid,
    declinedAt: serverTimestamp(),
  });
}

export async function revokeInvite(inviteId, revokedByUid = null) {
  await updateDoc(doc(db, 'invites', inviteId), {
    status: 'revoked',
    revokedByUid,
    revokedAt: serverTimestamp(),
  });
}

/**
 * Sync a collaborator's display info to the project's collaboratorNames map.
 * Called when a user opens a project or accepts an invite, so the assignee
 * dropdown can show real names instead of UIDs.
 */
export async function syncCollaboratorInfo(projectId, uid, info) {
  await updateDoc(doc(db, 'projects', projectId), {
    [`collaboratorNames.${uid}`]: {
      name:     info.name     ?? null,
      email:    info.email    ?? null,
      photoURL: info.photoURL ?? null,
    },
  });
}

export async function removeCollaborator(projectId, uid) {
  await updateDoc(doc(db, 'projects', projectId), {
    [`collaborators.${uid}`]: deleteField(),
  });
}

export async function updateCollaboratorRole(projectId, uid, role) {
  await updateDoc(doc(db, 'projects', projectId), {
    [`collaborators.${uid}`]: role,
    updatedAt: serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// PRESENCE (Real-time)
// ---------------------------------------------------------------------------

export async function updatePresence(projectId, uid, data) {
  await setDoc(
    doc(db, 'presence', projectId, 'users', uid),
    {
      ...data,
      lastSeen: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function clearPresence(projectId, uid) {
  await deleteDoc(doc(db, 'presence', projectId, 'users', uid)).catch(() => {});
}

export function listenPresence(projectId, callback) {
  return onSnapshot(
    collection(db, 'presence', projectId, 'users'),
    (snap) => {
      const presence = {};
      snap.docs.forEach((d) => {
        presence[d.id] = { uid: d.id, ...d.data() };
      });
      callback(presence);
    }
  );
}

// ---------------------------------------------------------------------------
// FIREBASE STORAGE
// ---------------------------------------------------------------------------

/**
 * Upload a File object to Firebase Storage at the given path.
 * Returns the public download URL.
 */
export async function uploadFile(path, file) {
  const ref  = storageRef(storage, path);
  const snap = await uploadBytes(ref, file);
  return getDownloadURL(snap.ref);
}

/**
 * Delete a file from Firebase Storage at the given path.
 * Silently ignores "object not found" errors.
 */
export async function deleteFile(path) {
  try {
    await deleteObject(storageRef(storage, path));
  } catch (err) {
    if (err.code !== 'storage/object-not-found') throw err;
  }
}
