// js/timer.js
// Timer state machine. No DOM code. Used by BOTH the popup and the service worker.
//
// timerState while:
//   idle    -> endTime null,   remainingSeconds null
//   running -> endTime set,    remainingSeconds null   (absolute end timestamp, epoch ms)
//   paused  -> endTime null,   remainingSeconds set    (whole seconds left)
//
// Transitions: idle -start-> running -pause-> paused -resume-> running
//              running -(expires)-> idle (next mode)   running/paused -reset-> idle
//
// Safety rules:
//  1. All changes run inside withTimerLock() (Web Locks across popup + service worker).
//  2. Every action first completes an EXPIRED timer, so a served session is never lost.
//  3. A focus session is recorded by its sessionId (see statistics.js), so repeats are no-ops.
//  4. Write order on completion: dailyStats first, then timerState.

import {
  STORAGE_KEYS,
  getDefaultValue,
  getValue,
  isValidTimerState,
  resetAllData,
  setValue,
} from './storage.js';
import { loadSettings } from './settings.js';
import { recordFocusSession } from './statistics.js';
import { DEV_DURATIONS_SECONDS, DEV_MODE, TIMER_ALARM_NAME } from './config.js';

export const TIMER_MODES = Object.freeze(['focus', 'shortBreak', 'longBreak']);
const LOCK_NAME = 'focusflow-timer-lock';

export class TimerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimerError';
  }
}

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

let fallbackQueue = Promise.resolve();

/**
 * Runs `operation` while holding a lock shared by every extension context (popup and service
 * worker). If the Web Locks API is unavailable, falls back to a queue that only protects
 * ONE context. The sessionId deduplication still prevents double counting in that case.
 */
function withTimerLock(operation) {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(LOCK_NAME, operation);
  }
  const result = fallbackQueue.then(operation);
  fallbackQueue = result.catch(() => {});
  return result;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export function getDurationSeconds(mode, settings) {
  if (DEV_MODE) return DEV_DURATIONS_SECONDS[mode];
  switch (mode) {
    case 'shortBreak':
      return settings.shortBreakMinutes * 60;
    case 'longBreak':
      return settings.longBreakMinutes * 60;
    default:
      return settings.focusMinutes * 60;
  }
}

/** Seconds left. Recalculated from endTime on every call, never counted down. */
export function getRemainingSeconds(state, now = Date.now()) {
  if (state.status === 'running') return Math.max(0, Math.ceil((state.endTime - now) / 1000));
  if (state.status === 'paused') return state.remainingSeconds;
  return state.durationSeconds;
}

/** What the clock should show. An idle timer follows the CURRENT settings. */
export function getDisplaySeconds(state, settings, now = Date.now()) {
  if (state.status === 'idle') return getDurationSeconds(state.mode, settings);
  return getRemainingSeconds(state, now);
}

/* ------------------------------------------------------------------ */
/* Alarm and badge helpers (failures are non-fatal: the popup still recovers the timer) */
/* ------------------------------------------------------------------ */

async function scheduleAlarm(endTime) {
  try {
    await chrome.alarms.create(TIMER_ALARM_NAME, { when: Math.max(endTime, Date.now() + 1) });
  } catch (error) {
    console.warn('[FocusFlow] Could not schedule the timer alarm.', error);
  }
}

async function clearAlarm() {
  try {
    await chrome.alarms.clear(TIMER_ALARM_NAME);
  } catch (error) {
    console.warn('[FocusFlow] Could not clear the timer alarm.', error);
  }
}

/** Makes sure an alarm exists for endTime (alarms may be lost when the browser restarts). */
async function ensureAlarm(endTime) {
  try {
    const existing = await chrome.alarms.get(TIMER_ALARM_NAME);
    if (existing && Math.abs(existing.scheduledTime - endTime) < 1000) return;
  } catch (error) {
    console.warn('[FocusFlow] Could not read the timer alarm.', error);
  }
  await scheduleAlarm(endTime);
}

async function setCompletionBadge() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    await chrome.action.setBadgeText({ text: 'DONE' });
  } catch (error) {
    console.warn('[FocusFlow] Could not set the toolbar badge.', error);
  }
}

export async function clearCompletionBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch (error) {
    console.warn('[FocusFlow] Could not clear the toolbar badge.', error);
  }
}

/* ------------------------------------------------------------------ */
/* State access                                                        */
/* ------------------------------------------------------------------ */

/** Reads timerState; an invalid stored value is treated as the default (idle) state. */
export async function readTimerState() {
  const raw = await getValue(STORAGE_KEYS.TIMER_STATE);
  return isValidTimerState(raw) ? raw : getDefaultValue(STORAGE_KEYS.TIMER_STATE);
}

async function writeTimerState(state) {
  await setValue(STORAGE_KEYS.TIMER_STATE, state);
  return state;
}

/* ------------------------------------------------------------------ */
/* Completion (must be called while holding the lock)                  */
/* ------------------------------------------------------------------ */

async function completeExpiredLocked(now, notify) {
  const state = await readTimerState();
  if (state.status !== 'running' || now < state.endTime) {
    return { state, completed: false };
  }

  const settings = await loadSettings();

  // Step 1: record the focus session (idempotent by sessionId).
  let sessionRecorded = false;
  const alreadyProcessed = state.sessionId !== null && state.sessionId === state.lastCompletedSessionId;
  if (state.mode === 'focus' && state.sessionId && !alreadyProcessed) {
    const result = await recordFocusSession({
      id: state.sessionId,
      durationSeconds: state.durationSeconds,
      completedAt: state.endTime, // the moment the session actually ended
    });
    sessionRecorded = result.recorded;
  }

  // Step 2: move to the next state. The next session is NOT started automatically.
  let nextMode = 'focus';
  let cycleFocusCount = state.cycleFocusCount;
  if (state.mode === 'focus') {
    cycleFocusCount += 1;
    if (cycleFocusCount >= settings.sessionsBeforeLongBreak) {
      nextMode = 'longBreak';
      cycleFocusCount = 0;
    } else {
      nextMode = 'shortBreak';
    }
  }

  const next = {
    status: 'idle',
    mode: nextMode,
    sessionId: null,
    durationSeconds: getDurationSeconds(nextMode, settings),
    endTime: null,
    remainingSeconds: null,
    cycleFocusCount,
    lastCompletedSessionId: state.sessionId,
  };
  await writeTimerState(next);
  await clearAlarm();
  if (notify) await setCompletionBadge();

  return { state: next, completed: true, completedMode: state.mode, sessionRecorded };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Brings the timer into a correct state. Call it when the popup opens, on browser startup,
 * on install/update, and when the alarm fires:
 *  - expired running timer  -> completes it (once)
 *  - running, not expired   -> makes sure an alarm exists
 *  - idle or paused         -> makes sure no stray alarm exists
 */
export function recoverTimer({ notify = false } = {}) {
  return withTimerLock(async () => {
    const result = await completeExpiredLocked(Date.now(), notify);
    if (!result.completed) {
      if (result.state.status === 'running') await ensureAlarm(result.state.endTime);
      else await clearAlarm();
    }
    return result;
  });
}

export function startTimer() {
  return withTimerLock(async () => {
    const { state } = await completeExpiredLocked(Date.now(), false);
    if (state.status !== 'idle') return state; // repeated click: already running or paused

    const settings = await loadSettings();
    const durationSeconds = getDurationSeconds(state.mode, settings);
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
      throw new TimerError('The timer duration is invalid. Check Settings.');
    }

    const next = {
      ...state,
      status: 'running',
      sessionId: crypto.randomUUID(),
      durationSeconds,
      endTime: Date.now() + durationSeconds * 1000,
      remainingSeconds: null,
    };
    await writeTimerState(next);
    await scheduleAlarm(next.endTime);
    return next;
  });
}

export function pauseTimer() {
  return withTimerLock(async () => {
    const { state } = await completeExpiredLocked(Date.now(), false);
    if (state.status !== 'running') return state;

    const next = {
      ...state,
      status: 'paused',
      endTime: null,
      remainingSeconds: Math.max(1, Math.ceil((state.endTime - Date.now()) / 1000)),
    };
    await writeTimerState(next);
    await clearAlarm();
    return next;
  });
}

export function resumeTimer() {
  return withTimerLock(async () => {
    const { state } = await completeExpiredLocked(Date.now(), false);
    if (state.status !== 'paused') return state;

    const next = {
      ...state,
      status: 'running',
      endTime: Date.now() + state.remainingSeconds * 1000,
      remainingSeconds: null,
    };
    await writeTimerState(next);
    await scheduleAlarm(next.endTime);
    return next;
  });
}

/** Abandons the current session. Nothing is counted. Keeps the mode and the cycle count. */
export function resetTimer() {
  return withTimerLock(async () => {
    const { state } = await completeExpiredLocked(Date.now(), false);
    const settings = await loadSettings();
    const next = {
      ...state,
      status: 'idle',
      sessionId: null,
      durationSeconds: getDurationSeconds(state.mode, settings),
      endTime: null,
      remainingSeconds: null,
    };
    await writeTimerState(next);
    await clearAlarm();
    return next;
  });
}

/** Only allowed while idle, so a session in progress is never abandoned by accident. */
export function switchMode(mode) {
  return withTimerLock(async () => {
    if (!TIMER_MODES.includes(mode)) throw new TimerError('Unknown timer mode.');

    const { state } = await completeExpiredLocked(Date.now(), false);
    if (state.status !== 'idle') {
      throw new TimerError('Reset the timer before switching modes.');
    }
    const settings = await loadSettings();
    return writeTimerState({ ...state, mode, durationSeconds: getDurationSeconds(mode, settings) });
  });
}

/** Deletes ALL stored data (under the timer lock) and recreates defaults. */
export function resetAllAppData() {
  return withTimerLock(async () => {
    await clearAlarm();
    await clearCompletionBadge();
    return resetAllData();
  });
}