// js/ui-focus.js
// Focus tab UI. The 250 ms interval only REDRAWS the clock; the time itself is always
// computed from the saved endTime (see timer.js).

import { DEV_DURATIONS_SECONDS, DEV_MODE } from './config.js';
import { StorageError } from './storage.js';
import { loadSettings } from './settings.js';
import { loadFocusToday } from './statistics.js';
import {
  TimerError,
  clearCompletionBadge,
  getDisplaySeconds,
  pauseTimer,
  readTimerState,
  recoverTimer,
  resetTimer,
  resumeTimer,
  startTimer,
  switchMode,
} from './timer.js';

const els = {
  dev: document.getElementById('focus-dev'),
  modes: document.getElementById('focus-modes'),
  modeButtons: Array.from(document.querySelectorAll('#focus-modes [data-mode]')),
  time: document.getElementById('timer-time'),
  status: document.getElementById('timer-status'),
  primary: document.getElementById('timer-primary'),
  reset: document.getElementById('timer-reset'),
  cycle: document.getElementById('timer-cycle'),
  today: document.getElementById('timer-today'),
};

const MODE_LABELS = { focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break' };
const PRIMARY_LABELS = { idle: 'Start', running: 'Pause', paused: 'Resume' };

let ctx = { showBanner() {} };
let state = null;
let settings = null;
let todayCount = 0;
let tickId = null;
let busy = false;
let completing = false;
let completeFailedAt = 0;

function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function statusText() {
  const label = MODE_LABELS[state.mode];
  if (state.status === 'running') return `${label} in progress`;
  if (state.status === 'paused') return `${label} paused`;
  return state.mode === 'focus' ? 'Ready to focus' : `${label} ready`;
}

function render() {
  if (!state || !settings) return;

  els.time.textContent = formatTime(getDisplaySeconds(state, settings, Date.now()));
  els.status.textContent = statusText();
  els.primary.textContent = PRIMARY_LABELS[state.status];
  els.primary.disabled = false; // never disabled while busy: that would drop keyboard focus
  els.reset.disabled = busy || state.status === 'idle';

  for (const button of els.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    button.disabled = busy || state.status !== 'idle';
  }

  els.cycle.textContent =
    `Focus sessions toward a long break: ${state.cycleFocusCount} of ${settings.sessionsBeforeLongBreak}`;
  els.today.textContent = `Focus sessions completed today: ${todayCount}`;
}

/* ---------- ticking (display only) ---------- */

function syncTick() {
  if (state && state.status === 'running') {
    if (tickId === null) tickId = setInterval(onTick, 250);
  } else if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
}

async function onTick() {
  if (!state || state.status !== 'running') {
    syncTick();
    return;
  }
  if (Date.now() >= state.endTime) {
    await completeNow();
    return;
  }
  render();
}

async function completeNow() {
  if (completing || Date.now() - completeFailedAt < 5000) return;
  completing = true;
  try {
    const result = await recoverTimer({ notify: false });
    applyState(result.state);
  } catch (error) {
    completeFailedAt = Date.now();
    handleError(error);
  } finally {
    completing = false;
  }
}

/* ---------- state updates ---------- */

async function refreshTodayCount() {
  try {
    todayCount = await loadFocusToday();
    render();
  } catch (error) {
    console.error('[FocusFlow] Could not load today\'s focus count:', error);
  }
}

function announceCompletion(completedMode, nextMode) {
  const message =
    completedMode === 'focus'
      ? `Focus session complete. ${MODE_LABELS[nextMode]} is ready.`
      : 'Break finished. Ready for the next focus session.';
  ctx.showBanner(message, 'success');
  void refreshTodayCount();
}

/** Single place where new timer state arrives. Announces a completion once. */
function applyState(next) {
  const previous = state;
  state = next;
  if (
    previous &&
    previous.status === 'running' &&
    next.status === 'idle' &&
    next.lastCompletedSessionId !== null &&
    next.lastCompletedSessionId === previous.sessionId
  ) {
    announceCompletion(previous.mode, next.mode);
  }
  syncTick();
  render();
}

function handleError(error) {
  if (error instanceof TimerError) {
    ctx.showBanner(error.message, 'warning');
  } else if (error instanceof StorageError) {
    console.error('[FocusFlow] Storage error:', error.cause ?? error);
    ctx.showBanner(`${error.message} The timer was not changed.`, 'error');
  } else {
    console.error('[FocusFlow] Timer error:', error);
    ctx.showBanner('Something unexpected went wrong with the timer.', 'error');
  }
}

async function runAction(action) {
  if (busy) return; // ignore repeated clicks while an action is running
  busy = true;
  render();
  try {
    applyState(await action());
  } catch (error) {
    handleError(error);
    await reloadFromStorage();
  } finally {
    busy = false;
    render();
    if (document.activeElement === document.body) els.primary.focus();
  }
}

async function reloadFromStorage() {
  try {
    settings = await loadSettings();
    applyState(await readTimerState());
  } catch (error) {
    handleError(error);
  }
}

function handleStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.timerState || changes.settings) void reloadFromStorage();
  if (changes.dailyStats) void refreshTodayCount();
}

/* ---------- public API ---------- */

/** Re-reads everything and lets the timer recover itself (expired timers complete here). */
export async function refreshFocusUI() {
  try {
    await clearCompletionBadge();
    settings = await loadSettings();
    const previous = state;
    const result = await recoverTimer({ notify: false });
    applyState(result.state);
    if (result.completed && !previous) announceCompletion(result.completedMode, result.state.mode);
    todayCount = await loadFocusToday();
    render();
  } catch (error) {
    handleError(error);
  }
}

export async function initFocusUI(context) {
  ctx = context;

  els.dev.hidden = !DEV_MODE;
  if (DEV_MODE) {
    const d = DEV_DURATIONS_SECONDS;
    els.dev.textContent =
      `Development mode is ON: sessions last ${d.focus} / ${d.shortBreak} / ${d.longBreak} seconds ` +
      '(focus / short break / long break). Set DEV_MODE to false in js/config.js for normal use.';
  }

  els.primary.addEventListener('click', () => {
    if (!state) return;
    const actions = { idle: startTimer, running: pauseTimer, paused: resumeTimer };
    void runAction(actions[state.status]);
  });
  els.reset.addEventListener('click', () => void runAction(resetTimer));
  els.modes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (button && !button.disabled) void runAction(() => switchMode(button.dataset.mode));
  });

  chrome.storage.onChanged.addListener(handleStorageChanged);
  await refreshFocusUI();
}