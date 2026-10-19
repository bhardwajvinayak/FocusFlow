// js/ui-coach.js
// Coach card inside the Progress tab. Read-only: it never changes tasks, timers or settings.
// All text is inserted with textContent. Task text is never displayed or logged.

import { DEV_MODE } from './config.js';
import { STORAGE_KEYS, getValue } from './storage.js';
import { loadTasks } from './tasks.js';
import { flattenSessions } from './statistics.js';
import { loadSettings } from './settings.js';
import { computeCoach } from './coach.js';

const $ = (id) => document.getElementById(id);

const els = {
  empty: $('coach-empty'),
  recs: $('coach-recs'),
  indicators: $('coach-indicators'),
  weeklyNote: $('coach-weekly-note'),
  weekly: $('coach-weekly'),
  error: $('coach-error'),
};

let renderToken = 0;

function item(text, className) {
  const li = document.createElement('li');
  if (className) li.className = className;
  li.textContent = text;
  return li;
}

function indicator(label, value) {
  const li = document.createElement('li');
  li.className = 'coach-indicator';
  const name = document.createElement('span');
  name.textContent = label;
  const number = document.createElement('strong');
  number.textContent = String(value);
  li.append(name, number);
  return li;
}

function formatDay(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

function signed(value, unit) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value} ${unit}`;
}

function render(result) {
  const { summary, recommendations, weekly } = result;

  els.empty.hidden = result.hasData;
  els.empty.textContent = result.hasData ? '' : 'No tasks or focus sessions yet, so there is nothing to summarise.';

  els.recs.replaceChildren(
    ...recommendations.map((rec) => {
      const li = document.createElement('li');
      li.className = 'coach-rec';
      const text = document.createElement('span');
      text.className = 'coach-rec-text';
      text.textContent = rec.text;
      const reason = document.createElement('span');
      reason.className = 'coach-rec-reason';
      reason.textContent = `Why: ${rec.reason}`;
      li.append(text, reason);
      return li;
    })
  );

  els.indicators.replaceChildren(
    indicator('Completed today', summary.completedToday),
    indicator('Pending', summary.pending),
    indicator('Overdue', summary.overdue),
    indicator('Due today', summary.dueToday),
    indicator('Focus sessions today', summary.focusSessionsToday),
    indicator('Focus minutes today', summary.focusMinutesToday),
    indicator('Focus streak (days)', summary.focusStreakDays)
  );

  els.weeklyNote.textContent = weekly.note;
  const rows = weekly.days.map((day) =>
    item(
      `${formatDay(day.date)}: ${day.tasksCompleted} task${day.tasksCompleted === 1 ? '' : 's'}, ` +
        `${day.focusMinutes} focus min`,
      'coach-week-row'
    )
  );
  if (weekly.comparison) {
    rows.push(
      item(
        `Compared with the 7 days before: ${signed(weekly.comparison.tasksCompletedDelta, 'tasks')}, ` +
          `${signed(weekly.comparison.focusMinutesDelta, 'focus minutes')}. This is only a count, not a judgement.`,
        'coach-week-compare'
      )
    );
  }
  els.weekly.replaceChildren(...rows);
}

/** Recomputes and redraws the card. Never throws, so it cannot break the Progress tab. */
export async function refreshCoachUI() {
  const token = ++renderToken;
  try {
    const [{ tasks }, rawStats, settings] = await Promise.all([
      loadTasks(),
      getValue(STORAGE_KEYS.DAILY_STATS),
      loadSettings(),
    ]);
    const sessions = flattenSessions(rawStats).filter((session) => DEV_MODE || !session.dev);
    const result = computeCoach({ tasks, sessions, now: new Date(), focusMinutes: settings.focusMinutes });
    if (token !== renderToken) return; // a newer refresh is already in progress
    render(result);
    els.error.hidden = true;
  } catch (error) {
    if (token !== renderToken) return;
    console.error('[FocusFlow] Coach could not load:', error && error.name);
    els.error.textContent = 'The coach could not load your data. The statistics above are unaffected.';
    els.error.hidden = false;
  }
}