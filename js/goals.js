// js/goals.js
// Goal validation, goal progress and computed achievements. PURE: no DOM, no chrome.* calls, no
// storage, no network. Its only import is the shared date/session logic of js/focus-intelligence.js.
//
// Nothing here is stored except the goal numbers themselves (the "goals" storage key).
// Achievements are COMPUTED each time from completed focus sessions, so they can never be "unlocked"
// falsely and they disappear when the underlying data is cleared.
// Weeks are Monday to Sunday in LOCAL time. Goals apply to history as it is NOW: changing a goal
// changes how past days are judged.

import { cleanSessions, dayNumber, keyOf, mondayOf, shiftKey } from './focus-intelligence.js';

export const GOALS_SCHEMA_VERSION = 1;

export const GOAL_LIMITS = Object.freeze({
  dailyFocusMinutes: Object.freeze({ min: 5, max: 720 }),
  weeklyFocusMinutes: Object.freeze({ min: 15, max: 5040 }),
  dailySessions: Object.freeze({ min: 1, max: 24 }),
});

export const DEFAULT_GOALS = Object.freeze({
  schemaVersion: GOALS_SCHEMA_VERSION,
  dailyFocusMinutes: null, // null = no goal. Goals are never given invented defaults.
  weeklyFocusMinutes: null,
  dailySessions: null,
});

const FIELDS = Object.keys(GOAL_LIMITS);
const LABELS = {
  dailyFocusMinutes: 'Daily focus goal',
  weeklyFocusMinutes: 'Weekly focus goal',
  dailySessions: 'Daily sessions goal',
};
const UNITS = { dailyFocusMinutes: ' minutes', weeklyFocusMinutes: ' minutes', dailySessions: ' sessions' };

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveToday(now) {
  return keyOf(now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Whole numbers only: an integer, or a string of digits. Anything else gives null. */
function parseWhole(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * input: { dailyFocusMinutes, weeklyFocusMinutes, dailySessions }
 *   null / undefined = "no goal" (explicitly unset)
 *   a blank string is REJECTED (the form turns an empty box into null before calling this)
 * Returns { ok, value, errors }. Never throws.
 */
export function validateGoals(input) {
  if (!isObject(input)) return { ok: false, value: null, errors: ['Goals are missing.'] };

  const errors = [];
  const value = {};
  for (const field of FIELDS) {
    const raw = input[field];
    if (raw === null || raw === undefined) {
      value[field] = null;
      continue;
    }
    const { min, max } = GOAL_LIMITS[field];
    if (typeof raw === 'string' && raw.trim() === '') {
      errors.push(`${LABELS[field]} cannot be blank. Leave it unset if you do not want this goal.`);
      continue;
    }
    const number = parseWhole(raw);
    if (number === null || number < min || number > max) {
      errors.push(`${LABELS[field]} must be a whole number from ${min} to ${max}${UNITS[field]}.`);
    } else {
      value[field] = number;
    }
  }

  if (
    errors.length === 0 &&
    value.dailyFocusMinutes !== null &&
    value.weeklyFocusMinutes !== null &&
    value.weeklyFocusMinutes < value.dailyFocusMinutes
  ) {
    errors.push('The weekly focus goal must be at least as large as the daily focus goal.');
  }

  return errors.length === 0
    ? { ok: true, value: { schemaVersion: GOALS_SCHEMA_VERSION, ...value }, errors: [] }
    : { ok: false, value: null, errors };
}

/**
 * Normalizes whatever is stored. Any invalid field becomes null (unset); valid fields are kept.
 * Returns { value, repaired }. Used by js/storage.js and everywhere goals are read.
 */
export function normalizeStoredGoals(raw) {
  if (!isObject(raw)) return { value: { ...DEFAULT_GOALS }, repaired: true };

  const value = { schemaVersion: GOALS_SCHEMA_VERSION };
  for (const field of FIELDS) {
    const { min, max } = GOAL_LIMITS[field];
    const n = raw[field];
    value[field] = Number.isInteger(n) && n >= min && n <= max ? n : null;
  }
  if (
    value.dailyFocusMinutes !== null &&
    value.weeklyFocusMinutes !== null &&
    value.weeklyFocusMinutes < value.dailyFocusMinutes
  ) {
    value.weeklyFocusMinutes = null; // a contradictory pair cannot both be trusted
  }
  const repaired = Object.keys(value).some((key) => value[key] !== raw[key]);
  return { value, repaired };
}

/**
 * Pure "save" decision. Invalid input NEVER changes the saved goals:
 * returns { ok: false, goals: <current, unchanged>, errors } or { ok: true, goals: <new>, errors: [] }.
 */
export function applyGoalsUpdate(current, input) {
  const result = validateGoals(input);
  if (!result.ok) return { ok: false, goals: normalizeStoredGoals(current).value, errors: result.errors };
  return { ok: true, goals: result.value, errors: [] };
}

/** Dev-mode sessions count only while DEV_MODE is on (same rule as Progress, Coach and Focus history). */
export function excludeDevSessions(sessions, devMode) {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((session) => devMode === true || !(isObject(session) && session.dev === true));
}

/* ------------------------------------------------------------------ */
/* Goal progress                                                       */
/* ------------------------------------------------------------------ */

function measure(done, goal) {
  if (goal === null) return { set: false };
  return {
    set: true,
    goal,
    done,
    met: done >= goal,
    remaining: Math.max(0, goal - done),
    percent: Math.floor((done * 100) / goal), // floored so it never shows 100% before the goal is met; may exceed 100
  };
}

/**
 * input: { sessions, goals, now }  (sessions: { id, durationSeconds, completedAt } with duplicates
 * and invalid items skipped by the shared cleaner). Minutes are floored (exact seconds decide "met").
 * Weekly progress is WEEK TO DATE: Monday through today, local time. No projections.
 */
export function computeGoalProgress({ sessions = [], goals, now = new Date() } = {}) {
  const today = resolveToday(now);
  const { sessions: clean } = cleanSessions(sessions, today);
  const g = normalizeStoredGoals(goals).value;
  const weekStart = mondayOf(today);

  let todaySeconds = 0;
  let todaySessions = 0;
  let weekSeconds = 0;
  let weekSessions = 0;
  for (const session of clean) {
    if (session.key === today) {
      todaySeconds += session.seconds;
      todaySessions += 1;
    }
    if (session.key >= weekStart && session.key <= today) {
      weekSeconds += session.seconds;
      weekSessions += 1;
    }
  }
  const todayMinutes = Math.floor(todaySeconds / 60);
  const weekMinutes = Math.floor(weekSeconds / 60);

  return {
    dateKey: today,
    weekStartKey: weekStart,
    weekEndKey: shiftKey(weekStart, 6),
    daysElapsed: dayNumber(today) - dayNumber(weekStart) + 1,
    anyGoalSet: FIELDS.some((field) => g[field] !== null),
    totals: { todayMinutes, todaySessions, weekMinutes, weekSessions },
    daily: { focusMinutes: measure(todayMinutes, g.dailyFocusMinutes), sessions: measure(todaySessions, g.dailySessions) },
    weekly: { focusMinutes: measure(weekMinutes, g.weeklyFocusMinutes) },
  };
}

/* ------------------------------------------------------------------ */
/* Achievements                                                        */
/* ------------------------------------------------------------------ */

/**
 * Computed on demand from completed sessions and the CURRENT goals. status:
 *   'earned'     the criterion is met by stored data (date = earliest day it was reached)
 *   'locked'     not yet met (progress shown only when it can be calculated)
 *   'needs-goal' a goal achievement whose goal is not set
 * Streaks use local calendar days. A missing session today does not break a streak ending yesterday.
 */
export function computeAchievements({ sessions = [], goals, now = new Date() } = {}) {
  const today = resolveToday(now);
  const { sessions: clean } = cleanSessions(sessions, today);
  const g = normalizeStoredGoals(goals).value;

  const byDay = new Map();
  for (const session of clean) {
    const day = byDay.get(session.key) || { seconds: 0, count: 0 };
    day.seconds += session.seconds;
    day.count += 1;
    byDay.set(session.key, day);
  }
  const days = [...byDay.keys()].sort();
  const orderedKeys = clean.map((session) => session.key).sort();
  const totalSessions = clean.length;
  const totalSeconds = clean.reduce((sum, session) => sum + session.seconds, 0);

  const nthSessionDate = (n) => (totalSessions >= n ? orderedKeys[n - 1] : null);

  let cumulative = 0;
  let focus300Date = null;
  for (const key of days) {
    cumulative += byDay.get(key).seconds;
    if (cumulative >= 18000 && focus300Date === null) focus300Date = key;
  }

  let run = 0;
  let longest = 0;
  let previous = null;
  let reached3 = null;
  let reached7 = null;
  for (const key of days) {
    run = previous !== null && dayNumber(key) - dayNumber(previous) === 1 ? run + 1 : 1;
    previous = key;
    if (run > longest) longest = run;
    if (run >= 3 && reached3 === null) reached3 = key;
    if (run >= 7 && reached7 === null) reached7 = key;
  }

  let cursor = byDay.has(today) ? today : shiftKey(today, -1);
  let currentStreak = 0;
  while (byDay.has(cursor)) {
    currentStreak += 1;
    cursor = shiftKey(cursor, -1);
  }

  let dailyGoalDate = null;
  let bestDaySeconds = 0;
  for (const key of days) {
    const { seconds } = byDay.get(key);
    if (seconds > bestDaySeconds) bestDaySeconds = seconds;
    if (g.dailyFocusMinutes !== null && seconds >= g.dailyFocusMinutes * 60 && dailyGoalDate === null) dailyGoalDate = key;
  }

  const weeks = new Map();
  for (const key of days) {
    const monday = mondayOf(key);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push(key);
  }
  let weeklyGoalDate = null;
  let bestWeekSeconds = 0;
  for (const monday of [...weeks.keys()].sort()) {
    let weekTotal = 0;
    for (const key of weeks.get(monday)) {
      weekTotal += byDay.get(key).seconds;
      if (g.weeklyFocusMinutes !== null && weekTotal >= g.weeklyFocusMinutes * 60 && weeklyGoalDate === null) {
        weeklyGoalDate = key;
      }
    }
    if (weekTotal > bestWeekSeconds) bestWeekSeconds = weekTotal;
  }

  const make = (id, title, criterion, earned, date, progress) => ({
    id,
    title,
    criterion,
    status: earned ? 'earned' : 'locked',
    date: earned ? date : null,
    progress: earned ? null : progress,
  });
  const needsGoal = (id, title, criterion) => ({ id, title, criterion, status: 'needs-goal', date: null, progress: null });

  const achievements = [
    make('first-session', 'First session', 'Complete one focus session.', totalSessions >= 1, nthSessionDate(1),
      { current: totalSessions, target: 1, unit: 'sessions' }),
    make('sessions-10', '10 sessions', 'Complete 10 focus sessions.', totalSessions >= 10, nthSessionDate(10),
      { current: totalSessions, target: 10, unit: 'sessions' }),
    make('sessions-50', '50 sessions', 'Complete 50 focus sessions.', totalSessions >= 50, nthSessionDate(50),
      { current: totalSessions, target: 50, unit: 'sessions' }),
    make('focus-300', 'Five hours focused', 'Record 300 minutes of completed focus time.', totalSeconds >= 18000, focus300Date,
      { current: Math.floor(totalSeconds / 60), target: 300, unit: 'minutes' }),
    make('streak-3', 'Three active days in a row', 'Complete a focus session on 3 consecutive days.', longest >= 3, reached3,
      { current: longest, target: 3, unit: 'days' }),
    make('streak-7', 'Seven active days in a row', 'Complete a focus session on 7 consecutive days.', longest >= 7, reached7,
      { current: longest, target: 7, unit: 'days' }),
    g.dailyFocusMinutes === null
      ? needsGoal('daily-goal', 'Daily focus goal met', 'Set a daily focus goal to track this.')
      : make('daily-goal', 'Daily focus goal met', `Reach ${g.dailyFocusMinutes} focus minutes on one day.`,
          dailyGoalDate !== null, dailyGoalDate,
          { current: Math.floor(bestDaySeconds / 60), target: g.dailyFocusMinutes, unit: 'minutes' }),
    g.weeklyFocusMinutes === null
      ? needsGoal('weekly-goal', 'Weekly focus goal met', 'Set a weekly focus goal to track this.')
      : make('weekly-goal', 'Weekly focus goal met', `Reach ${g.weeklyFocusMinutes} focus minutes in one Monday-to-Sunday week.`,
          weeklyGoalDate !== null, weeklyGoalDate,
          { current: Math.floor(bestWeekSeconds / 60), target: g.weeklyFocusMinutes, unit: 'minutes' }),
  ];

  return {
    achievements,
    summary: {
      totalSessions,
      totalMinutes: Math.floor(totalSeconds / 60),
      longestStreak: longest,
      currentStreak,
      earnedCount: achievements.filter((a) => a.status === 'earned').length,
    },
  };
}