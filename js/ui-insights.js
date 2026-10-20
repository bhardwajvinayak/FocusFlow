// js/ui-insights.js
// "Weekly insights" card in the Progress tab, with CSV and PDF download. Read-only: it never writes to
// storage. All text uses textContent. Nothing is logged except error names. It never throws into Progress.

import { DEV_MODE } from './config.js';
import { STORAGE_KEYS, getValue } from './storage.js';
import { flattenSessions } from './statistics.js';
import { loadTasks } from './tasks.js';
import { cleanHabits } from './habits.js';
import { excludeDevSessions } from './goals.js';
import { formatDayLabel } from './focus-intelligence.js';
import { listReportWeeks } from './report.js';
import { buildProductivityInsights } from './insights.js';
import {
  buildProductivityPdf, productivityCsv, productivityCsvFilename, productivityPdfFilename,
} from './report-export.js';

const $ = (id) => document.getElementById(id);
const els = {
  week: $('in-week'), label: $('in-label'), lines: $('in-lines'), days: $('in-days'), habits: $('in-habits'),
  note: $('in-note'), csv: $('in-csv'), pdf: $('in-pdf'), status: $('in-status'), error: $('in-error'),
};

let bound = false;
let token = 0;
let selectedWeek = '';
let data = null;
let current = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const show = (value) => (value === null || value === undefined ? '\u2013' : String(value));

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function render(insights) {
  current = insights;
  const r = insights.report;
  els.label.textContent =
    `${formatDayLabel(r.weekStartKey)} to ${formatDayLabel(r.weekEndKey)}` + (r.isCurrentWeek ? ` (week to date, through ${formatDayLabel(r.throughKey)})` : '');
  els.lines.replaceChildren(...insights.lines.map((line) => el('li', '', line.text)));

  const head = document.createElement('tr');
  for (const name of ['Date', 'Focus min', 'Sessions', 'Tasks', 'Habits']) {
    const th = el('th', '', name);
    th.scope = 'col';
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const d of insights.days) {
    const tr = document.createElement('tr');
    const rowHead = el('th', '', formatDayLabel(d.date));
    rowHead.scope = 'row';
    tr.append(rowHead, el('td', '', show(d.minutes)), el('td', '', show(d.sessions)), el('td', '', show(d.tasksCompleted)),
      el('td', '', d.habitsTracked === null ? '\u2013' : `${d.habitsDone}/${d.habitsTracked}`));
    tbody.append(tr);
  }
  els.days.replaceChildren(el('caption', 'fi-caption', 'Per day ("\u2013" means no data)'), thead, tbody);

  els.habits.replaceChildren(
    ...insights.habits.perHabit.map((h) =>
      el('li', '', h.rate === null
        ? `${h.name}: no days due yet`
        : `${h.name}: ${h.done} of ${h.eligible} days (${h.rate}%) \u00b7 current streak ${h.current} \u00b7 best ${h.best} (as of today)`))
  );
  els.note.textContent =
    'Task counts include only tasks still in your list. Habit numbers use active habits from the day each was added. ' +
    'Exports contain these totals only: no habit names, task titles or notes.';
  els.csv.disabled = false;
  els.pdf.disabled = false;
}

async function load() {
  const [rawStats, rawHabits, { tasks }] = await Promise.all([
    getValue(STORAGE_KEYS.DAILY_STATS), getValue(STORAGE_KEYS.HABITS), loadTasks(),
  ]);
  const { habits } = cleanHabits(rawHabits, new Date());
  return {
    sessions: excludeDevSessions(flattenSessions(rawStats), DEV_MODE),
    tasks,
    habits,
    evidenceTimestamps: [...tasks.map((t) => t.createdAt), ...habits.map((h) => h.createdAt)],
  };
}

function draw() {
  const now = new Date();
  const weeks = listReportWeeks({ sessions: data.sessions, evidenceTimestamps: data.evidenceTimestamps, now });
  selectedWeek = weeks.some((w) => w.startKey === selectedWeek) ? selectedWeek : weeks[0].startKey;
  els.week.replaceChildren(...weeks.map((w) => {
    const option = document.createElement('option');
    option.value = w.startKey;
    option.textContent = `${formatDayLabel(w.startKey)} to ${formatDayLabel(w.endKey)}${w.isCurrent ? ' (current)' : ''}`;
    return option;
  }));
  els.week.value = selectedWeek;
  render(buildProductivityInsights({ ...data, now, weekStart: selectedWeek }));
}

function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function handleExport(kind) {
  els.error.hidden = true;
  els.status.textContent = '';
  try {
    if (!current) throw new Error('no-report');
    if (kind === 'csv') {
      const csv = productivityCsv(current);
      if (csv === '') throw new Error('empty');
      download(csv, 'text/csv;charset=utf-8', productivityCsvFilename(current));
      els.status.textContent = `Download started: ${productivityCsvFilename(current)}`;
    } else {
      const pdf = buildProductivityPdf(current, { generatedAt: new Date() });
      if (pdf === null) throw new Error('empty');
      download(pdf, 'application/pdf', productivityPdfFilename(current));
      els.status.textContent = `Download started: ${productivityPdfFilename(current)}`;
    }
  } catch (error) {
    console.error('[FocusFlow] Export failed:', error && error.message);
    showError('The report could not be exported. Nothing was changed. Please try again.');
  }
}

function bind() {
  if (bound) return;
  bound = true;
  els.week.addEventListener('change', () => {
    selectedWeek = els.week.value;
    els.status.textContent = '';
    if (data) draw();
  });
  els.csv.addEventListener('click', () => handleExport('csv'));
  els.pdf.addEventListener('click', () => handleExport('pdf'));
}

/** Reloads data and redraws. Never throws. */
export async function refreshInsightsUI() {
  bind();
  const mine = ++token;
  try {
    const loaded = await load();
    if (mine !== token) return;
    data = loaded;
    els.error.hidden = true;
    draw();
  } catch (error) {
    if (mine !== token) return;
    console.error('[FocusFlow] Insights could not load:', error && error.name);
    els.csv.disabled = true;
    els.pdf.disabled = true;
    showError('Weekly insights could not load your data. The rest of Progress is unaffected.');
  }
}