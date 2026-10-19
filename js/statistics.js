// js/statistics.js
// Statistics + the ONLY code that writes completed focus sessions to "dailyStats".
//
// Storage shape: { "YYYY-MM-DD": { sessions: [ { id, durationSeconds, completedAt, dev } ] } }
// Everything shown on the dashboard is DERIVED from this session list and from the tasks,
// so there are no separate counters that could drift out of sync.

import { STORAGE_KEYS, getLocalDateKey, getValue, setValue } from './storage.js';
import { loadTasks } from './tasks.js';
import { DEV_MODE } from './config.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSession(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (!Number.isInteger(raw.durationSeconds) || raw.durationSeconds <= 0) return null;
  if (!Number.isFinite(raw.completedAt)) return null;
  return {
    id: raw.id,
    durationSeconds: raw.durationSeconds,
    completedAt: raw.completedAt,
    dev: raw.dev === true,
  };
}

/** Collects every valid session from all days, dropping duplicates by id. */
export function flattenSessions(rawDailyStats) {
  const sessions = [];
  const seen = new Set();
  if (!isPlainObject(rawDailyStats)) return sessions;

  for (const day of Object.values(rawDailyStats)) {
    const list = isPlainObject(day) && Array.isArray(day.sessions) ? day.sessions : [];
    for (const item of list) {
      const session = normalizeSession(item);
      if (session === null || seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  return sessions;
}

/**
 * Records one completed focus session. Safe to call twice with the same id:
 * the second call finds the id already stored and does nothing (idempotent).
 * Callers must hold the timer lock (see timer.js) so two writers do not interleave.
 */
export async function recordFocusSession({ id, durationSeconds, completedAt }) {
  const raw = await getValue(STORAGE_KEYS.DAILY_STATS);
  const base = isPlainObject(raw) ? raw : {};

  if (flattenSessions(base).some((session) => session.id === id)) {
    return { recorded: false };
  }
  if (typeof id !== 'string' || !Number.isInteger(durationSeconds) || !Number.isFinite(completedAt)) {
    throw new Error('Invalid focus session data.');
  }

  const dayKey = getLocalDateKey(new Date(completedAt));
  const day = isPlainObject(base[dayKey]) ? base[dayKey] : {};
  const existing = Array.isArray(day.sessions) ? day.sessions : [];

  const next = {
    ...base,
    [dayKey]: { ...day, sessions: [...existing, { id, durationSeconds, completedAt, dev: DEV_MODE }] },
  };
  await setValue(STORAGE_KEYS.DAILY_STATS, next);
  return { recorded: true };
}

/** Pure: focus numbers for today and all time. Dev-mode sessions count only while DEV_MODE is on. */
export function computeFocusStats(rawDailyStats, now = new Date()) {
  const today = getLocalDateKey(now);
  const sessions = flattenSessions(rawDailyStats).filter((session) => DEV_MODE || !session.dev);
  const todays = sessions.filter((session) => getLocalDateKey(new Date(session.completedAt)) === today);

  const sumSeconds = (list) => list.reduce((total, session) => total + session.durationSeconds, 0);
  const activeDays = new Set(sessions.map((session) => getLocalDateKey(new Date(session.completedAt))));

  return {
    todaySessions: todays.length,
    todayMinutes: Math.round(sumSeconds(todays) / 60),
    allTimeSessions: sessions.length,
    allTimeMinutes: Math.round(sumSeconds(sessions) / 60),
    activeDays: activeDays.size,
  };
}

/** Pure: everything the Progress tab shows. */
export function computeStats(tasks, rawDailyStats, now = new Date()) {
  const today = getLocalDateKey(now);
  const total = tasks.length;
  const completed = tasks.filter((task) => task.completed).length;
  const completedToday = tasks.filter(
    (task) =>
      task.completed &&
      Number.isFinite(task.completedAt) &&
      getLocalDateKey(new Date(task.completedAt)) === today
  ).length;

  return {
    dateKey: today,
    tasks: {
      total,
      completed,
      pending: total - completed,
      completedToday,
      completionPercent: total === 0 ? 0 : Math.round((completed / total) * 100),
    },
    focus: computeFocusStats(rawDailyStats, now),
  };
}

export async function loadStats() {
  const { tasks } = await loadTasks();
  const rawDailyStats = await getValue(STORAGE_KEYS.DAILY_STATS);
  return computeStats(tasks, rawDailyStats);
}

export async function loadFocusToday() {
  const rawDailyStats = await getValue(STORAGE_KEYS.DAILY_STATS);
  return computeFocusStats(rawDailyStats).todaySessions;
}