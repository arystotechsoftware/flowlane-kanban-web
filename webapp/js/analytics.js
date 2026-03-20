/**
 * analytics.js – Project analytics dashboard renderer (Web App)
 *
 * Renders stats and charts into #analytics-view based on
 * the columns + cardsByColumn data snapshot from board.js.
 */

import { SWIMLANE_STATUSES } from './board.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRIORITY_META = [
  { id: 'high',   label: 'High',   color: '#f85149' },
  { id: 'medium', label: 'Medium', color: '#d29922' },
  { id: 'low',    label: 'Low',    color: '#3fb950' },
  { id: 'none',   label: 'None',   color: '#484f58' },
];

// ── Main renderer ─────────────────────────────────────────────────────────

/**
 * Render the analytics dashboard into #analytics-view.
 * @param {{ columns: ColumnDoc[], cardsByColumn: Object }} data
 */
export function renderAnalytics({ columns, cardsByColumn }) {
  const view = document.getElementById('analytics-view');
  if (!view) return;

  // ── Gather all cards ────────────────────────────────────────────────────
  const allCards = Object.values(cardsByColumn).flat();
  const total    = allCards.length;

  if (total === 0) {
    view.querySelector('.analytics-body').innerHTML = `
      <div class="analytics-empty">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-8"/>
        </svg>
        <p>No cards yet in this project.</p>
      </div>`;
    return;
  }

  // ── Compute stats ───────────────────────────────────────────────────────
  const today      = new Date(); today.setHours(0, 0, 0, 0);
  const completed  = allCards.filter((c) => c.status === 'completed').length;
  const overdue    = allCards.filter((c) => {
    if (!c.dueDate || c.status === 'completed' || c.status === 'cancelled') return false;
    return new Date(c.dueDate) < today;
  }).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Status distribution
  const statusCounts = {};
  SWIMLANE_STATUSES.forEach((s) => { statusCounts[s.id] = 0; });
  allCards.forEach((c) => {
    const sid = c.status ?? 'new';
    statusCounts[sid] = (statusCounts[sid] ?? 0) + 1;
  });

  // Priority distribution
  const priorityCounts = { high: 0, medium: 0, low: 0, none: 0 };
  allCards.forEach((c) => {
    const p = c.priority ?? 'none';
    priorityCounts[p] = (priorityCounts[p] ?? 0) + 1;
  });

  // Cards per column
  const colStats = columns.map((col) => ({
    name:  col.name,
    color: col.color ?? '#7d8590',
    count: (cardsByColumn[col.id] ?? []).length,
  }));

  // Cards created in last 14 days
  const activityMap = buildActivityMap(allCards, 14);

  // ── Render body ─────────────────────────────────────────────────────────
  const body = view.querySelector('.analytics-body');
  body.innerHTML = `
    <!-- Stat cards -->
    <div class="an-stats-row">
      ${statCard('Total Cards',      total,          '',         'card')}
      ${statCard('Completed',        completed,      'success',  'check')}
      ${statCard('Overdue',          overdue,        overdue > 0 ? 'danger' : '', 'clock')}
      ${statCard('Completion Rate',  completionRate + '%', completionRate >= 50 ? 'success' : '', 'pie')}
    </div>

    <!-- Charts row -->
    <div class="an-charts-row">
      <div class="an-card">
        <div class="an-card-title">Status Distribution</div>
        <div class="an-chart-bars">
          ${buildStatusBars(statusCounts, total)}
        </div>
      </div>
      <div class="an-card">
        <div class="an-card-title">Priority Breakdown</div>
        <div class="an-chart-bars">
          ${buildPriorityBars(priorityCounts, total)}
        </div>
      </div>
    </div>

    <!-- Columns row -->
    <div class="an-card an-card--wide">
      <div class="an-card-title">Cards per Column</div>
      <div class="an-chart-bars">
        ${buildColumnBars(colStats)}
      </div>
    </div>

    <!-- Activity sparkline -->
    <div class="an-card an-card--wide">
      <div class="an-card-title">Cards Created — Last 14 Days</div>
      <div class="an-sparkline-wrap">
        ${buildSparkline(activityMap)}
      </div>
    </div>
  `;
}

// ── Stat card ─────────────────────────────────────────────────────────────

function statCard(label, value, variant, iconType) {
  const cls = variant ? `an-stat an-stat--${variant}` : 'an-stat';
  return `
    <div class="${cls}">
      <div class="an-stat-icon">${statIcon(iconType)}</div>
      <div class="an-stat-value">${escapeHtml(String(value))}</div>
      <div class="an-stat-label">${escapeHtml(label)}</div>
    </div>`;
}

function statIcon(type) {
  const icons = {
    card:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    clock: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    pie:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`,
  };
  return icons[type] ?? '';
}

// ── Bar charts ────────────────────────────────────────────────────────────

function buildStatusBars(counts, total) {
  return SWIMLANE_STATUSES.map(({ id, label, color }) => {
    const count = counts[id] ?? 0;
    return barRow(label, color, count, total);
  }).join('');
}

function buildPriorityBars(counts, total) {
  return PRIORITY_META.map(({ id, label, color }) => {
    const count = counts[id] ?? 0;
    return barRow(label, color, count, total);
  }).join('');
}

function buildColumnBars(colStats) {
  const max = Math.max(...colStats.map((c) => c.count), 1);
  return colStats.map(({ name, color, count }) =>
    barRow(name, color, count, max)
  ).join('');
}

function barRow(label, color, count, max) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return `
    <div class="an-bar-row">
      <span class="an-bar-label">${escapeHtml(label)}</span>
      <div class="an-bar-track">
        <div class="an-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="an-bar-count">${count}</span>
    </div>`;
}

// ── Activity sparkline ────────────────────────────────────────────────────

function buildActivityMap(cards, days) {
  const map = {};
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    map[toDateKey(d)] = 0;
  }
  cards.forEach((c) => {
    if (!c.createdAt) return;
    const key = toDateKey(new Date(c.createdAt));
    if (key in map) map[key]++;
  });
  return map;
}

function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildSparkline(activityMap) {
  const entries  = Object.entries(activityMap); // [dateKey, count][]
  const maxCount = Math.max(...entries.map(([, v]) => v), 1);
  const W = 540; const H = 56; const BAR_W = Math.floor(W / entries.length) - 2;

  const bars = entries.map(([dateKey, count], i) => {
    const barH  = Math.max(Math.round((count / maxCount) * H), count > 0 ? 4 : 2);
    const x     = i * (BAR_W + 2);
    const y     = H - barH;
    const [, , dayStr] = dateKey.split('-');
    const label = count > 0 ? `${dayStr}: ${count}` : dayStr;
    return `<rect x="${x}" y="${y}" width="${BAR_W}" height="${barH}"
              fill="var(--accent)" rx="2" opacity="${count > 0 ? '0.85' : '0.2'}"
              title="${escapeHtml(label)}"/>`;
  }).join('');

  // X-axis day labels (every 7 days)
  const labels = entries.map(([dateKey], i) => {
    if (i % 7 !== 0 && i !== entries.length - 1) return '';
    const [, , day] = dateKey.split('-');
    const x = i * (BAR_W + 2) + BAR_W / 2;
    return `<text x="${x}" y="${H + 14}" text-anchor="middle" class="an-spark-label">${day}</text>`;
  }).join('');

  const totalThisPeriod = entries.reduce((s, [, v]) => s + v, 0);

  return `
    <div class="an-spark-meta">${totalThisPeriod} card${totalThisPeriod !== 1 ? 's' : ''} created in last 14 days</div>
    <svg class="an-sparkline" viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none">
      ${bars}
      ${labels}
    </svg>`;
}
