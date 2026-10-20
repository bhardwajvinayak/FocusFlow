// js/habits.js
// Habits and per-habit streaks. PURE: no DOM, no chrome.* calls, no storage, no network.
// Its only import is the shared local-date helpers in js/focus-intelligence.js.
//
// Rules (approved design):
//  - A streak is CONSECUTIVE CALENDAR DAYS (local time). There is no scheduled-day support yet.
//  - Current streak = the run of consecutive completed days ending today OR yesterday, so an unticked
//    today does not break a streak that ended yesterday. Best streak = the longest run ever recorded.
//  - Milestones 3, 7, 14 and 30 are earned when the BEST streak ever reached them (computed on demand,
//    never stored). The date is the day the run first reached that length.
//  - Completions can be changed for today and the 6 previous days only, never for the future.
//  - A habit has a start day (its creation day or earliest completion). Days before it are
//    "before-start", never "not-done": the app does not claim a day was missed when it cannot know that.
//  - Completions are a sorted SET of "YYYY-MM-DD" strings, so a duplicate record cannot exist.
//
// Reducers never modify their input. When they fail they return { ok: false, habits: <same array>, code, error }.

import { dayNumber, isValidKey, keyFromTimestamp, keyOf, mondayOf, shiftKey } from './focus-intelligence.js';

export const HABITS_SCHEMA_VERSION = 1;
export const HABIT_LIMITS = Object.freeze({ nameMax: 40, activeMax: 12, totalMax: 40, backfillDays: 6 });
export const MILESTONE_DAYS = Object.freeze([3, 7, 14, 30]);
export const DEFAULT_HABITS = Object.freeze({ schemaVersion: HABITS_SCHEMA_VERSION, habits: Object.freeze([]) });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validNow(now) {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

function resolveToday(now) {
  return keyOf(validNow(now));
}

function fail(habits, code, error) {
  return { ok: false, habits, code, error };
}

const isActive = (habit) => habit.archivedAt === null;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/* ------------------------------------------------------------------ */
/* Loading and normalization                                           */
/* ------------------------------------------------------------------ */

/**
 * Light check used by js/storage.js: the stored value must be an object with a "habits" array.
 * Individual habits are validated by cleanHabits(), so a startup repair never rewrites (and so never
 * silently loses) a record. Returns { value, repaired }.
 */
export function normalizeHabitsContainer(raw) {
  if (!isObject(raw) || !Array.isArray(raw.habits)) {
    return { value: { schemaVersion: HABITS_SCHEMA_VERSION, habits: [] }, repaired: true };
  }
  if (raw.schemaVersion === HABITS_SCHEMA_VERSION) return { value: raw, repaired: false };
  return { value: { ...raw, schemaVersion: HABITS_SCHEMA_VERSION }, repaired: true };
}

/**
 * Validates every stored habit. Invalid or duplicate-id habits are skipped and counted; habits past the
 * total limit are skipped and counted; invalid, future-dated and duplicate completion dates are dropped
 * and counted. Never throws. Returns { habits, skipped: { invalid, duplicates, overLimit, droppedDates } }.
 */
export function cleanHabits(rawContainer, now = new Date()) {
  const today = resolveToday(now);
  const skipped = { invalid: 0, duplicates: 0, overLimit: 0, droppedDates: 0 };
  const habits = [];
  const seen = new Set();
  const list = isObject(rawContainer) && Array.isArray(rawContainer.habits) ? rawContainer.habits : [];

  for (const raw of list) {
    if (!isObject(raw)) {
      skipped.invalid += 1;
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const archivedOk =
      raw.archivedAt === null || raw.archivedAt === undefined || (typeof raw.archivedAt === 'number' && Number.isFinite(raw.archivedAt));
    if (
      typeof raw.id !== 'string' || raw.id === '' ||
      name === '' || name.length > HABIT_LIMITS.nameMax ||
      typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) ||
      !archivedOk
    ) {
      skipped.invalid += 1;
      continue;
    }
    if (seen.has(raw.id)) {
      skipped.duplicates += 1;
      continue;
    }
    if (habits.length >= HABIT_LIMITS.totalMax) {
      skipped.overLimit += 1;
      continue;
    }
    seen.add(raw.id);

    const dates = new Set();
    for (const date of Array.isArray(raw.completions) ? raw.completions : []) {
      if (!isValidKey(date) || date > today || dates.has(date)) {
        skipped.droppedDates += 1;
        continue;
      }
      dates.add(date);
    }
    habits.push({
      id: raw.id,
      name,
      createdAt: raw.createdAt,
      archivedAt: raw.archivedAt === undefined ? null : raw.archivedAt,
      completions: [...dates].sort(),
    });
  }
  return { habits, skipped };
}

/* ------------------------------------------------------------------ */
/* Reducers                                                            */
/* ------------------------------------------------------------------ */

export function validateHabitName(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid-name', error: 'The habit name must be text.' };
  const value = raw.trim();
  if (value === '') return { ok: false, code: 'invalid-name', error: 'Please enter a habit name.' };
  if (value.length > HABIT_LIMITS.nameMax) {
    return { ok: false, code: 'invalid-name', error: `A habit name must be ${HABIT_LIMITS.nameMax} characters or fewer.` };
  }
  return { ok: true, value };
}

/** options: { name, id, now }. The caller supplies the id (crypto.randomUUID() in the UI) so this stays pure. */
export function addHabit(habits, { name, id, now } = {}) {
  const checked = validateHabitName(name);
  if (!checked.ok) return fail(habits, checked.code, checked.error);
  if (typeof id !== 'string' || id === '' || habits.some((habit) => habit.id === id)) {
    return fail(habits, 'invalid-id', 'The habit could not be created. Please try again.');
  }
  if (habits.filter(isActive).length >= HABIT_LIMITS.activeMax) {
    return fail(habits, 'limit-active', `You can have up to ${HABIT_LIMITS.activeMax} active habits. Archive one to add another.`);
  }
  if (habits.length >= HABIT_LIMITS.totalMax) {
    return fail(habits, 'limit-total', `FocusFlow keeps up to ${HABIT_LIMITS.totalMax} habits in total, including archived ones.`);
  }
  if (habits.some((habit) => isActive(habit) && sameName(habit.name, checked.value))) {
    return fail(habits, 'duplicate-name', 'You already have an active habit with that name.');
  }
  const habit = { id, name: checked.value, createdAt: validNow(now).getTime(), archivedAt: null, completions: [] };
  return { ok: true, changed: true, habits: [...habits, habit], habit };
}

export function renameHabit(habits, id, name) {
  const habit = habits.find((item) => item.id === id);
  if (!habit) return fail(habits, 'not-found', 'That habit no longer exists.');
  if (!isActive(habit)) return fail(habits, 'archived', 'Restore this habit before renaming it.');
  const checked = validateHabitName(name);
  if (!checked.ok) return fail(habits, checked.code, checked.error);
  if (habits.some((item) => item.id !== id && isActive(item) && sameName(item.name, checked.value))) {
    return fail(habits, 'duplicate-name', 'You already have an active habit with that name.');
  }
  if (habit.name === checked.value) return { ok: true, changed: false, habits };
  return { ok: true, changed: true, habits: habits.map((item) => (item.id === id ? { ...item, name: checked.value } : item)) };
}

export function archiveHabit(habits, id, now = new Date()) {
  const habit = habits.find((item) => item.id === id);
  if (!habit) return fail(habits, 'not-found', 'That habit no longer exists.');
  if (!isActive(habit)) return { ok: true, changed: false, habits };
  return {
    ok: true,
    changed: true,
    habits: habits.map((item) => (item.id === id ? { ...item, archivedAt: validNow(now).getTime() } : item)),
  };
}

export function restoreHabit(habits, id) {
  const habit = habits.find((item) => item.id === id);
  if (!habit) return fail(habits, 'not-found', 'That habit no longer exists.');
  if (isActive(habit)) return { ok: true, changed: false, habits };
  if (habits.filter(isActive).length >= HABIT_LIMITS.activeMax) {
    return fail(habits, 'limit-active', `You can have up to ${HABIT_LIMITS.activeMax} active habits. Archive one first.`);
  }
  if (habits.some((item) => isActive(item) && sameName(item.name, habit.name))) {
    return fail(habits, 'duplicate-name', 'An active habit already uses this name. Rename that one first.');
  }
  return { ok: true, changed: true, habits: habits.map((item) => (item.id === id ? { ...item, archivedAt: null } : item)) };
}

/** Sets or clears one day. Allowed: an active habit, and a date from (today - 6 days) through today. */
export function setCompletion(habits, id, dateKey, done, now = new Date()) {
  if (typeof done !== 'boolean') return fail(habits, 'invalid', 'The request was not understood.');
  const habit = habits.find((item) => item.id === id);
  if (!habit) return fail(habits, 'not-found', 'That habit no longer exists.');
  if (!isActive(habit)) return fail(habits, 'archived', 'Restore this habit before changing its days.');
  if (!isValidKey(dateKey)) return fail(habits, 'invalid-date', 'That date is not valid.');

  const today = resolveToday(now);
  if (dateKey > today) return fail(habits, 'future', 'You cannot mark a day that has not happened yet.');
  if (dateKey < shiftKey(today, -HABIT_LIMITS.backfillDays)) {
    return fail(habits, 'outside-window', `Only today and the previous ${HABIT_LIMITS.backfillDays} days can be changed.`);
  }

  const has = habit.completions.includes(dateKey);
  if (has === done) return { ok: true, changed: false, habits }; // a duplicate tick is a no-op
  const completions = done ? [...habit.completions, dateKey].sort() : habit.completions.filter((date) => date !== dateKey);
  return { ok: true, changed: true, habits: habits.map((item) => (item.id === id ? { ...item, completions } : item)) };
}

/* ------------------------------------------------------------------ */
/* Streaks, milestones and calendars                                   */
/* ------------------------------------------------------------------ */

function usableDays(habit, today) {
  const list = isObject(habit) && Array.isArray(habit.completions) ? habit.completions : [];
  return [...new Set(list.filter((date) => isValidKey(date) && date <= today))].sort();
}

/**
 * Per-habit numbers, computed from the completion dates (nothing is stored):
 * { todayKey, startKey, total, doneToday, current, best, milestones[], nextMilestone }
 * nextMilestone is the smallest milestone above the CURRENT streak: { days, remaining } or null.
 */
export function computeHabitStats(habit, now = new Date()) {
  const today = resolveToday(now);
  const days = usableDays(habit, today);
  const set = new Set(days);

  let run = 0;
  let best = 0;
  let previous = null;
  const reached = {};
  for (const key of days) {
    run = previous !== null && dayNumber(key) - dayNumber(previous) === 1 ? run + 1 : 1;
    previous = key;
    if (run > best) best = run;
    for (const n of MILESTONE_DAYS) if (run >= n && reached[n] === undefined) reached[n] = key;
  }

  let cursor = set.has(today) ? today : shiftKey(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor = shiftKey(cursor, -1);
  }

  const createdKey = isObject(habit) ? keyFromTimestamp(habit.createdAt) : null;
  const startCandidates = [createdKey, days[0]].filter((key) => typeof key === 'string' && key <= today);
  const startKey = startCandidates.length > 0 ? startCandidates.reduce((a, b) => (a < b ? a : b)) : today;

  const next = MILESTONE_DAYS.find((n) => n > current);
  return {
    todayKey: today,
    startKey,
    total: days.length,
    doneToday: set.has(today),
    current,
    best,
    milestones: MILESTONE_DAYS.map((n) => ({ days: n, earned: best >= n, date: reached[n] === undefined ? null : reached[n] })),
    nextMilestone: next === undefined ? null : { days: next, remaining: next - current },
  };
}

/** Milestones that are earned in `after` but were not in `before` (used to celebrate only a NEW one). */
export function newMilestones(before, after) {
  return after.milestones
    .filter((m) => m.earned && !before.milestones.some((b) => b.days === m.days && b.earned))
    .map((m) => m.days);
}

/** The seven buttons: today and the 6 previous days, oldest first. editable = active habit. */
export function computeLastDays(habit, now = new Date()) {
  const today = resolveToday(now);
  const set = new Set(usableDays(habit, today));
  const editable = isObject(habit) && habit.archivedAt === null;
  const days = [];
  for (let offset = HABIT_LIMITS.backfillDays; offset >= 0; offset -= 1) {
    const date = shiftKey(today, -offset);
    days.push({ date, done: set.has(date), editable });
  }
  return days;
}

/**
 * Monday-to-Sunday calendar ending with the current week (default 5 weeks). cell.status:
 *   done | not-done | before-start (no data exists) | upcoming
 * cell.editable = the day can be toggled (active habit, within today and the previous 6 days).
 */
export function computeHabitCalendar(habit, now = new Date(), weeks = 5) {
  const today = resolveToday(now);
  const count = Number.isInteger(weeks) ? Math.min(12, Math.max(1, weeks)) : 5;
  const { startKey: habitStart } = computeHabitStats(habit, now);
  const set = new Set(usableDays(habit, today));
  const active = isObject(habit) && habit.archivedAt === null;
  const oldestEditable = shiftKey(today, -HABIT_LIMITS.backfillDays);

  const firstMonday = shiftKey(mondayOf(today), -7 * (count - 1));
  const rows = [];
  for (let w = 0; w < count; w += 1) {
    const row = [];
    for (let d = 0; d < 7; d += 1) {
      const date = shiftKey(firstMonday, w * 7 + d);
      let status = 'not-done';
      if (date > today) status = 'upcoming';
      else if (date < habitStart) status = 'before-start';
      else if (set.has(date)) status = 'done';
      row.push({ date, status, editable: active && date <= today && date >= oldestEditable });
    }
    rows.push(row);
  }
  return { startKey: firstMonday, endKey: shiftKey(firstMonday, count * 7 - 1), weeks: rows };
}