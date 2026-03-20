/**
 * export.js – Data export for FlowLane (web app version)
 *
 * Exports the current user's full board data to JSON.
 * Works while the user is still in premium mode (Firestore),
 * enabling graceful data retrieval before downgrading to free.
 */

import { getProjects, getColumns, getCards } from './storage.js';

// -- Data gathering ---------------------------------------------------------

/**
 * Full-fidelity data -- preserves all objects (labels, checklist, cover,
 * attachments) exactly as stored. Used for JSON export and import round-trips.
 */
async function gatherFullData() {
  const projects = await getProjects();
  const result = {
    exportedAt: new Date().toISOString(),
    version: 2,
    projects: [],
  };

  for (const project of projects) {
    const columns = await getColumns(project.id);
    const projectEntry = {
      name:        project.name        ?? '',
      description: project.description ?? '',
      color:       project.color       ?? '#6366f1',
      createdAt:   project.createdAt   ?? null,
      columns:     [],
    };

    for (const column of columns) {
      const cards = await getCards(project.id, column.id);
      projectEntry.columns.push({
        name:  column.name  ?? '',
        color: column.color ?? '#7d8590',
        order: column.order ?? 0,
        cards: cards.map((card) => ({
          title:       card.title       ?? '',
          description: card.description ?? '',
          priority:    card.priority    ?? 'none',
          status:      card.status      ?? 'to-do',
          dueDate:     card.dueDate     ?? null,
          completedAt: card.completedAt ?? null,
          labels:      card.labels      ?? [],
          checklist:   card.checklist   ?? [],
          assigneeId:  card.assigneeId  ?? null,
          cover:       card.cover       ?? null,
          attachments: card.attachments ?? [],
          order:       card.order       ?? 0,
          createdAt:   card.createdAt   ?? null,
        })),
      });
    }

    result.projects.push(projectEntry);
  }

  return result;
}

// -- Export ------------------------------------------------------------------

export async function exportToJSON() {
  const data = await gatherFullData();
  const json = JSON.stringify(data, null, 2);
  downloadFile(
    `flowlane-export-${dateSuffix()}.json`,
    json,
    'application/json'
  );
}

// -- Helpers -----------------------------------------------------------------

function dateSuffix() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
