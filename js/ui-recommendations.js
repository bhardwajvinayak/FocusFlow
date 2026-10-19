// js/ui-recommendations.js
// "Next up" card on the Focus tab. READ-ONLY: it never starts the timer or changes tasks, sessions or
// settings, and it stores nothing. All text is inserted with textContent. Nothing is logged.

import { DEV_MODE } from './config.js';
import { STORAGE_KEYS, getLocalDateKey, getValue } from './storage.js';
import { loadTasks } from './tasks.js';
import { flattenSessions } from './statistics.js';
import { loadSettings } from './settings.js';
import { readTimerState } from './timer.js';
import { computeRecommendations } from './recommendations.js';

const $ = (id) => document.getElementById(id);

const els = {
  empty: $('rec-empty'),
  next: $('rec-next'),
  title: $('rec-title'),
  meta: $('rec-meta'),
  reasons: $('rec-reasons'),
  alsoHeading: $('rec-also-heading'),
  also: $('rec-also'),
  session: $('rec-session'),
  breakText: $('rec-break'),
  notes: $('rec-notes'),
  error: $('rec-error'),
};

const EMPTY_TEXT = {
  'no-tasks': 'No tasks yet. Add one in the Tasks tab and a suggestion will appear here.',
  'all-done': 'Every task is completed. Nothing is pending right now.',
  'invalid-date': 'The date could not be read, so no suggestion is shown.',
};

let renderToken = 0;
let timerId = null;

function listItem(text, className) {
  const li = document.createElement('li');
  if (className) li.className = className;
  li.textContent = text;
  return li;
}

function render(result) {
  const showEmpty = result.state !== 'ready' || result.nextTask === null;
  els.empty.hidden = !showEmpty;
  els.empty.textContent = showEmpty ? EMPTY_TEXT[result.state] || 'Nothing is pending right now.' : '';

  els.next.hidden = result.nextTask === null;
  if (result.nextTask) {
    els.title.textContent = result.nextTask.title;
    els.meta.textContent = `${result.nextTask.priority[0].toUpperCase()}${result.nextTask.priority.slice(1)} priority`;
    els.reasons.replaceChildren(...result.nextTask.reasons.map((reason) => listItem(reason, 'rec-reason')));
  }

  els.alsoHeading.hidden = result.alternatives.length === 0;
  els.also.replaceChildren(
    ...result.alternatives.map((task) => listItem(`${task.title} (${task.reason})`, 'rec-also-item'))
  );

  els.session.hidden = result.session === null;
  els.session.textContent = result.session ? result.session.text : '';
  els.breakText.textContent = result.break;
  els.breakText.hidden = result.break === '';

  els.notes.replaceChildren(...result.notes.map((note) => listItem(note)));
}

/** Recomputes and redraws the card. Never throws, so it cannot break the Focus tab. */
export async function refreshRecommendationsUI() {
  const token = ++renderToken;
  try {
    const [{ tasks }, rawStats, settings, timer] = await Promise.all([
      loadTasks(),
      getValue(STORAGE_KEYS.DAILY_STATS),
      loadSettings(),
      readTimerState(),
    ]);
    const sessions = flattenSessions(rawStats).filter((session) => DEV_MODE || !session.dev);
    const result = computeRecommendations({ tasks, sessions, settings, timer, today: getLocalDateKey() });
    if (token !== renderToken) return; // a newer refresh is already in progress
    render(result);
    els.error.hidden = true;
  } catch (error) {
    if (token !== renderToken) return;
    console.error('[FocusFlow] Next-up card could not load:', error && error.name);
    els.error.textContent = 'The suggestion could not load your data. The timer is unaffected.';
    els.error.hidden = false;
  }
}

function handleStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (!(changes.tasks || changes.dailyStats || changes.timerState || changes.settings)) return;
  clearTimeout(timerId); // several keys often change together
  timerId = setTimeout(() => void refreshRecommendationsUI(), 150);
}

export async function initRecommendationsUI() {
  chrome.storage.onChanged.addListener(handleStorageChanged);
  await refreshRecommendationsUI();
}