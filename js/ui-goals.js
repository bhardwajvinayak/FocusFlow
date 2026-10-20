// js/ui-goals.js
// Goals, achievements and weekly report inside the Progress tab. The ONLY thing it saves is the goal
// numbers (the "goals" key); sessions and tasks are read-only. All text uses textContent / .value.
// Nothing is logged except error names. It never throws into the Progress tab.

import { DEV_MODE } from './config.js';
import { STORAGE_KEYS, StorageError, getValue, setValue } from './storage.js';
import { flattenSessions } from './statistics.js';
import { loadTasks } from './tasks.js';
import { formatDayLabel } from './focus-intelligence.js';
import {
  DEFAULT_GOALS,
  GOAL_LIMITS,
  applyGoalsUpdate,
  computeAchievements,
  computeGoalProgress,
  excludeDevSessions,
  normalizeStoredGoals,
} from './goals.js';
import { buildWeeklyReport, csvFilename, listReportWeeks, reportToCsv } from './report.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('gl-form'), daily: $('gl-daily'), weekly: $('gl-weekly'), sessions: $('gl-sessions'),
  save: $('gl-save'), clear: $('gl-clear'), error: $('gl-error'), status: $('gl-status'),
  progress: $('gl-progress'), achSummary: $('gl-ach-summary'), achievements: $('gl-achievements'),
  week: $('wr-week'), label: $('wr-label'), summary: $('wr-summary'), days: $('wr-days'),
  goalsList: $('wr-goals'), download: $('wr-download'), reportStatus: $('wr-status'),
  reportError: $('wr-error'), note: $('wr-note'),
};

let bound = false;
let saving = false;
let token = 0;
let selectedWeek = '';
let lastData = null;
let lastReport = null;

const STATUS_TEXT = { recorded: 'Recorded', none: 'No sessions' };
const REASON_TEXT = { 'before-history': 'Before your history (no data)', upcoming: 'Upcoming' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function loadData() {
  const [rawStats, rawGoals, { tasks }] = await Promise.all([
    getValue(STORAGE_KEYS.DAILY_STATS),
    getValue(STORAGE_KEYS.GOALS),
    loadTasks(),
  ]);
  return {
    sessions: excludeDevSessions(flattenSessions(rawStats), DEV_MODE),
    goals: normalizeStoredGoals(rawGoals).value,
    evidenceTimestamps: tasks.map((task) => task.createdAt),
  };
}

/* ------------------------------------------------------------------ */
/* Goals: form, progress, achievements                                  */
/* ------------------------------------------------------------------ */

function fillForm(goals) {
  els.daily.value = goals.dailyFocusMinutes === null ? '' : String(goals.dailyFocusMinutes);
  els.weekly.value = goals.weeklyFocusMinutes === null ? '' : String(goals.weeklyFocusMinutes);
  els.sessions.value = goals.dailySessions === null ? '' : String(goals.dailySessions);
}

/** An empty box means "no goal" (null). Anything else goes to the validator exactly as typed. */
function readForm() {
  const read = (input) => (input.value.trim() === '' ? null : input.value);
  return {
    dailyFocusMinutes: read(els.daily),
    weeklyFocusMinutes: read(els.weekly),
    dailySessions: read(els.sessions),
  };
}

function progressRow(label, m, unit) {
  const li = el('li', 'gl-row');
  li.append(el('span', 'gl-row-label', label));
  const value = el('span', 'gl-row-value');
  if (!m.set) {
    value.textContent = 'Set a goal';
    li.append(value);
    return li;
  }
  value.textContent = m.met
    ? `Goal met: ${m.done} ${unit} (goal ${m.goal})`
    : `${m.done} / ${m.goal} ${unit} (${m.percent}%)`;
  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = Math.min(100, m.percent); // the bar is only visual; the text shows the true total
  bar.setAttribute('aria-label', `${label} progress`);
  li.append(value, bar);
  return li;
}

function renderProgress(progress) {
  els.progress.replaceChildren(
    progressRow('Today: focus', progress.daily.focusMinutes, 'min'),
    progressRow('Today: sessions', progress.daily.sessions, 'sessions'),
    progressRow(`This week (week to date, ${progress.daysElapsed} of 7 days)`, progress.weekly.focusMinutes, 'min')
  );
}

function achievementText(a) {
  if (a.status === 'earned') return a.date ? `Earned. First reached ${formatDayLabel(a.date)}.` : 'Earned.';
  if (a.status === 'needs-goal') return a.criterion;
  return a.progress ? `Not yet. ${a.progress.current} of ${a.progress.target} ${a.progress.unit}.` : 'Not yet.';
}

function renderAchievements(result) {
  const { summary } = result;
  els.achSummary.textContent =
    `${summary.earnedCount} of ${result.achievements.length} earned. Current streak: ` +
    `${summary.currentStreak} day${summary.currentStreak === 1 ? '' : 's'}. ` +
    'Achievements are calculated from your recorded sessions each time, not stored.';
  els.achievements.replaceChildren(
    ...result.achievements.map((a) => {
      const li = el('li', `gl-ach gl-ach-${a.status}`);
      li.append(el('span', 'gl-ach-title', a.title), el('span', 'gl-ach-criterion', a.criterion), el('span', 'gl-ach-status', achievementText(a)));
      return li;
    })
  );
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

async function handleSave(event) {
  event.preventDefault();
  if (saving) return;
  saving = true;
  els.save.disabled = true;
  els.error.hidden = true;
  els.status.textContent = '';
  try {
    const current = normalizeStoredGoals(await getValue(STORAGE_KEYS.GOALS)).value;
    const result = applyGoalsUpdate(current, readForm());
    if (!result.ok) {
      showError(result.errors.join(' ')); // nothing was saved; previous goals are unchanged
      return;
    }
    await setValue(STORAGE_KEYS.GOALS, result.goals);
    await refreshGoalsUI();
    els.status.textContent = 'Goals saved.';
  } catch (error) {
    showError(error instanceof StorageError ? `${error.message} Your goals were not changed.` : 'Could not save goals. Please try again.');
    if (!(error instanceof StorageError)) console.error('[FocusFlow] Goal save failed:', error && error.name);
  } finally {
    saving = false;
    els.save.disabled = false;
  }
}

async function handleClear() {
  if (saving) return;
  saving = true;
  els.error.hidden = true;
  try {
    await setValue(STORAGE_KEYS.GOALS, { ...DEFAULT_GOALS });
    await refreshGoalsUI();
    els.status.textContent = 'All goals cleared. Your session history is unchanged.';
  } catch (error) {
    showError(error instanceof StorageError ? `${error.message} Your goals were not changed.` : 'Could not clear goals.');
  } finally {
    saving = false;
  }
}

/* ------------------------------------------------------------------ */
/* Weekly report                                                       */
/* ------------------------------------------------------------------ */

function cell(tag, text, scope) {
  const node = el(tag, '', text);
  if (scope) node.scope = scope;
  return node;
}

function renderReport(report) {
  lastReport = report;
  els.label.textContent =
    `${formatDayLabel(report.weekStartKey)} to ${formatDayLabel(report.weekEndKey)}` +
    (report.isCurrentWeek ? ` (week to date, through ${formatDayLabel(report.throughKey)})` : '');

  els.summary.replaceChildren(...report.summary.map((line) => el('li', '', line)));

  const caption = el('caption', 'fi-caption', 'Focus by day');
  const head = document.createElement('tr');
  for (const name of ['Date', 'Focus min', 'Sessions', 'Status']) head.append(cell('th', name, 'col'));
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const day of report.days) {
    const tr = document.createElement('tr');
    const dash = '\u2013';
    tr.append(
      cell('th', formatDayLabel(day.date), 'row'),
      cell('td', day.minutes === null ? dash : String(day.minutes)),
      cell('td', day.sessions === null ? dash : String(day.sessions)),
      cell('td', day.status === 'unavailable' ? REASON_TEXT[day.reason] || 'Unavailable' : STATUS_TEXT[day.status])
    );
    tbody.append(tr);
  }
  els.days.replaceChildren(caption, thead, tbody);

  const lines = [];
  const g = report.goals;
  if (!g.anyGoalSet) {
    lines.push('No goals are set, so there is no goal progress to show.');
  } else {
    if (g.weeklyFocus.set) {
      lines.push(
        g.weeklyFocus.met
          ? `Weekly focus goal met: ${g.weeklyFocus.done} min (goal ${g.weeklyFocus.goal}).`
          : `Weekly focus: ${g.weeklyFocus.done} / ${g.weeklyFocus.goal} min (${g.weeklyFocus.percent}%).`
      );
    }
    if (g.dailyFocusDays.set) lines.push(`Daily focus goal (${g.dailyFocusDays.goal} min) met on ${g.dailyFocusDays.daysMet} of ${g.dailyFocusDays.daysEvaluated} days.`);
    if (g.dailySessionsDays.set) lines.push(`Daily sessions goal (${g.dailySessionsDays.goal}) met on ${g.dailySessionsDays.daysMet} of ${g.dailySessionsDays.daysEvaluated} days.`);
  }
  els.goalsList.replaceChildren(...lines.map((line) => el('li', '', line)));

  els.note.textContent =
    'Goal progress uses the goals you have set now. Totals are rounded, so daily rows can differ from the total by a minute.';
}

function renderReportSection(data) {
  const weeks = listReportWeeks({ sessions: data.sessions, evidenceTimestamps: data.evidenceTimestamps, now: new Date() });
  const keep = weeks.some((week) => week.startKey === selectedWeek) ? selectedWeek : weeks[0].startKey;
  selectedWeek = keep;
  els.week.replaceChildren(
    ...weeks.map((week) => {
      const option = document.createElement('option');
      option.value = week.startKey;
      option.textContent = `${formatDayLabel(week.startKey)} to ${formatDayLabel(week.endKey)}${week.isCurrent ? ' (current)' : ''}`;
      return option;
    })
  );
  els.week.value = keep;
  renderReport(
    buildWeeklyReport({ sessions: data.sessions, evidenceTimestamps: data.evidenceTimestamps, now: new Date(), weekStart: keep, goals: data.goals })
  );
}

function handleWeekChange() {
  selectedWeek = els.week.value;
  els.reportStatus.textContent = '';
  if (lastData) renderReportSection(lastData);
}

function handleDownload() {
  els.reportError.hidden = true;
  const csv = lastReport ? reportToCsv(lastReport) : '';
  if (csv === '') {
    els.reportError.textContent = 'There is no report to download yet.';
    els.reportError.hidden = false;
    return;
  }
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = csvFilename(lastReport);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.reportStatus.textContent = `Download started: ${csvFilename(lastReport)}`;
  } catch (error) {
    console.error('[FocusFlow] CSV download failed:', error && error.name);
    els.reportError.textContent = 'The download could not be started.';
    els.reportError.hidden = false;
  }
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

function bind() {
  if (bound) return;
  bound = true;
  for (const [field, input] of [['dailyFocusMinutes', els.daily], ['weeklyFocusMinutes', els.weekly], ['dailySessions', els.sessions]]) {
    input.placeholder = `${GOAL_LIMITS[field].min} to ${GOAL_LIMITS[field].max}`;
    input.addEventListener('input', () => { els.error.hidden = true; });
  }
  els.form.addEventListener('submit', (event) => void handleSave(event));
  els.clear.addEventListener('click', () => void handleClear());
  els.week.addEventListener('change', handleWeekChange);
  els.download.addEventListener('click', handleDownload);
}

/** Reloads everything from storage and redraws. Never throws, so it cannot break the Progress tab. */
export async function refreshGoalsUI() {
  bind();
  const current = ++token;
  try {
    const data = await loadData();
    if (current !== token) return; // a newer refresh is already running
    lastData = data;
    fillForm(data.goals);
    const now = new Date();
    renderProgress(computeGoalProgress({ sessions: data.sessions, goals: data.goals, now }));
    renderAchievements(computeAchievements({ sessions: data.sessions, goals: data.goals, now }));
    renderReportSection(data);
  } catch (error) {
    if (current !== token) return;
    console.error('[FocusFlow] Goals could not load:', error && error.name);
    showError('Goals and reports could not load your data. The rest of Progress is unaffected.');
  }
}