// js/ui-focus-intelligence.js
// Focus Intelligence card inside the Progress tab. Read-only: it never writes to storage and never
// changes tasks, sessions or settings. All text is inserted with textContent.

import { DEV_MODE } from './config.js';
import { STORAGE_KEYS, getValue } from './storage.js';
import { flattenSessions } from './statistics.js';
import { loadTasks } from './tasks.js';
import { computeFocusIntelligence, formatDayLabel } from './focus-intelligence.js';

const $ = (id) => document.getElementById(id);

const els = {
  metrics: $('fi-metrics'),
  compare: $('fi-compare'),
  insights: $('fi-insights'),
  heatmap: $('fi-heatmap'),
  heatmapNote: $('fi-heatmap-note'),
  error: $('fi-error'),
};

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let renderToken = 0;

function metric(label, value) {
  const li = document.createElement('li');
  li.className = 'coach-indicator';
  const name = document.createElement('span');
  name.textContent = label;
  const number = document.createElement('strong');
  number.textContent = value;
  li.append(name, number);
  return li;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function describeCell(cell) {
  const label = formatDayLabel(cell.date);
  switch (cell.status) {
    case 'recorded':
      return `${label}: ${cell.minutes} focus minute${cell.minutes === 1 ? '' : 's'}, ` +
        `${cell.sessions} session${cell.sessions === 1 ? '' : 's'}`;
    case 'none':
      return `${label}: no completed focus sessions recorded`;
    case 'unavailable':
      return `${label}: before your FocusFlow history, so no data is available`;
    default:
      return `${label}: upcoming day`;
  }
}

function cellText(cell) {
  if (cell.status === 'recorded') return String(cell.minutes);
  if (cell.status === 'none') return '0';
  if (cell.status === 'unavailable') return '\u2013';
  return '';
}

function renderHeatmap(heatmap) {
  const caption = document.createElement('caption');
  caption.className = 'fi-caption';
  caption.textContent = 'Focus minutes per day';

  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.scope = 'col';
  corner.textContent = 'Week of';
  headRow.append(corner);
  for (const name of WEEKDAY_HEADERS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    headRow.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const week of heatmap.weeks) {
    const tr = document.createElement('tr');
    const rowHead = document.createElement('th');
    rowHead.scope = 'row';
    rowHead.className = 'fi-week-label';
    rowHead.textContent = formatDayLabel(week[0].date).slice(4); // "28 Sep"
    tr.append(rowHead);

    for (const cell of week) {
      const td = document.createElement('td');
      td.className = `fi-cell fi-${cell.status}`;
      if (cell.status === 'recorded') td.classList.add(`fi-level-${cell.level}`);
      const description = describeCell(cell);
      td.title = description;
      const hidden = document.createElement('span');
      hidden.className = 'visually-hidden';
      hidden.textContent = description;
      const visible = document.createElement('span');
      visible.setAttribute('aria-hidden', 'true');
      visible.textContent = cellText(cell);
      td.append(hidden, visible);
      tr.append(td);
    }
    tbody.append(tr);
  }
  els.heatmap.replaceChildren(caption, thead, tbody);
  els.heatmapNote.textContent = heatmap.note;
}

function render(r) {
  const prev = r.previousWeek;
  els.metrics.replaceChildren(
    metric('Focus today', `${r.today.minutes} min`),
    metric('This week so far', `${r.thisWeek.minutes} min`),
    metric('Last week (full)', prev.covered ? `${prev.minutes} min` : 'Not available'),
    metric('Completed sessions', String(r.totals.sessions)),
    metric('Average session', r.totals.averageMinutes === null ? 'No data yet' : `${r.totals.averageMinutes} min`),
    metric(
      'Best recorded day',
      r.bestDay ? `${formatDayLabel(r.bestDay.dates[r.bestDay.dates.length - 1])}, ${r.bestDay.minutes} min` : 'Needs 3 active days'
    )
  );

  if (r.comparison) {
    const { previousMinutes, deltaMinutes, percent } = r.comparison;
    els.compare.textContent =
      `Same days last week: ${previousMinutes} min (${signed(deltaMinutes)} min` +
      `${percent === null ? '' : `, ${signed(percent)}%`}).`;
  } else {
    els.compare.textContent = r.comparisonNote;
  }

  els.insights.replaceChildren(
    ...r.insights.map((insight) => {
      const li = document.createElement('li');
      li.className = 'coach-rec';
      const text = document.createElement('span');
      text.className = 'coach-rec-text';
      text.textContent = insight.text;
      li.append(text);
      return li;
    })
  );

  renderHeatmap(r.heatmap);
}

/** Recomputes and redraws the card. Never throws, so it cannot break the Progress tab. */
export async function refreshFocusIntelligenceUI() {
  const token = ++renderToken;
  try {
    const [rawStats, { tasks }] = await Promise.all([getValue(STORAGE_KEYS.DAILY_STATS), loadTasks()]);
    const sessions = flattenSessions(rawStats).filter((session) => DEV_MODE || !session.dev);
    const result = computeFocusIntelligence({
      sessions,
      now: new Date(),
      evidenceTimestamps: tasks.map((task) => task.createdAt),
    });
    if (token !== renderToken) return; // a newer refresh is already in progress
    render(result);
    els.error.hidden = true;
  } catch (error) {
    if (token !== renderToken) return;
    console.error('[FocusFlow] Focus dashboard could not load:', error && error.name);
    els.error.textContent = 'The focus dashboard could not load your data. The rest of Progress is unaffected.';
    els.error.hidden = false;
  }
}