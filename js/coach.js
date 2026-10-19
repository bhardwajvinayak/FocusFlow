// js/coach.js
// Local, deterministic, rule-based productivity coach. PURE: no DOM, no chrome.* calls, no
// network, no storage, no imports, and it never changes its input.
//
// These are simple rules over the user's own data, NOT a validated measure of productivity.
// Nothing is estimated or invented: a metric appears only when the data supports it.
// Focus sessions are NOT linked to individual tasks, and this file never implies they are.
//
// The date helper below mirrors getLocalDateKey() in js/storage.js (local calendar day).

export const COACH_LIMITS = Object.freeze({
  overdueMany: 3,        // this many overdue tasks -> "pick one" suggestion
  heavyLoad: 8,          // overdue + due today at or above this -> "list looks full"
  completedMany: 6,      // completed today at or above this -> acknowledge and rest
  maxRecommendations: 3,
  weeklyMinDays: 7,      // days of evidence before a weekly summary is shown
  compareMinDays: 14,    // days of evidence before comparing with the previous week
});

/* ------------------------------------------------------------------ */
/* Date helpers (local calendar days as "YYYY-MM-DD")                   */
/* ------------------------------------------------------------------ */

function keyOf(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** Calendar arithmetic (not 24-hour steps), so daylight-saving changes cannot shift a day. */
function shiftKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return keyOf(new Date(year, month - 1, day + days));
}

function dayNumber(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

function keyFromTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : keyOf(date);
}

/* ------------------------------------------------------------------ */
/* Input cleaning (invalid items are skipped, never repaired or guessed) */
/* ------------------------------------------------------------------ */

function cleanTasks(raw) {
  if (!Array.isArray(raw)) return [];
  const tasks = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    if (typeof item.id !== 'string' || item.id === '') continue;
    if (typeof item.completed !== 'boolean') continue;
    tasks.push({
      completed: item.completed,
      dueKey: isValidKey(item.dueDate) ? item.dueDate : null,
      completedKey: item.completed ? keyFromTimestamp(item.completedAt) : null,
      createdKey: keyFromTimestamp(item.createdAt),
    });
  }
  return tasks;
}

function cleanSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const sessions = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    if (typeof item.id !== 'string' || item.id === '' || seen.has(item.id)) continue;
    if (!Number.isInteger(item.durationSeconds) || item.durationSeconds <= 0) continue;
    const key = keyFromTimestamp(item.completedAt);
    if (key === null) continue;
    seen.add(item.id);
    sessions.push({ durationSeconds: item.durationSeconds, key });
  }
  return sessions;
}

/* ------------------------------------------------------------------ */
/* Calculations                                                        */
/* ------------------------------------------------------------------ */

/** Consecutive local days with at least one session. Today not yet having one does not break it. */
function focusStreak(sessionKeys, today) {
  let cursor = sessionKeys.has(today) ? today : shiftKey(today, -1);
  let streak = 0;
  while (sessionKeys.has(cursor)) {
    streak += 1;
    cursor = shiftKey(cursor, -1);
  }
  return streak;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function buildRecommendations(summary, focusMinutes) {
  const { overdue, dueToday, pending, completedToday, focusSessionsToday, focusStreakDays } = summary;
  const load = overdue + dueToday;
  const list = [];

  if (overdue >= COACH_LIMITS.overdueMany) {
    list.push({
      id: 'overdue-many',
      text: 'Pick one overdue task and give it a short, focused try. Finishing or rescheduling just one is a good start.',
      reason: `${plural(overdue, 'task is', 'tasks are')} past the due date.`,
    });
  } else if (overdue > 0) {
    list.push({
      id: 'overdue-few',
      text: 'A task is past its due date. Consider finishing, rescheduling or removing it when it suits you.',
      reason: `${plural(overdue, 'task is', 'tasks are')} past the due date.`,
    });
  }

  if (load >= COACH_LIMITS.heavyLoad) {
    list.push({
      id: 'heavy-load',
      text: "Today's list looks full. If it feels like too much, consider moving a few due dates to later.",
      reason: `${plural(load, 'task is', 'tasks are')} due today or earlier.`,
    });
  }

  if (pending > 0 && focusSessionsToday === 0) {
    list.push({
      id: 'start-focus',
      text: `You have pending tasks and no focus session yet today. A ${focusMinutes}-minute focus session could help you begin.`,
      reason: 'No completed focus sessions are recorded for today.',
    });
  }

  if (completedToday >= COACH_LIMITS.completedMany) {
    list.push({
      id: 'good-progress',
      text: 'Good progress today. Taking a break and resting is part of working well.',
      reason: `${plural(completedToday, 'task was', 'tasks were')} completed today.`,
    });
  } else if (completedToday > 0 && load === 0) {
    list.push({
      id: 'all-clear',
      text: 'Everything due today is done. You can stop here or plan something for tomorrow.',
      reason: 'No tasks are due today or overdue.',
    });
  }

  if (focusStreakDays >= 2) {
    list.push({
      id: 'streak',
      text: `You have focused on ${focusStreakDays} days in a row. Keep whatever routine is working for you.`,
      reason: 'Counted from days with at least one completed focus session.',
    });
  }

  if (list.length === 0) {
    list.push({
      id: 'nothing-urgent',
      text: 'Nothing needs attention right now.',
      reason: 'No overdue tasks or other signals were found.',
    });
  }
  return list.slice(0, COACH_LIMITS.maxRecommendations);
}

function buildWeekly(tasks, sessions, today) {
  const keys = [
    ...tasks.map((task) => task.createdKey),
    ...sessions.map((session) => session.key),
  ].filter(Boolean);

  if (keys.length === 0) {
    return { available: false, evidenceDays: 0, note: 'Weekly insights appear after you have used FocusFlow for a few days.', days: [], comparison: null };
  }

  const earliest = keys.reduce((a, b) => (a < b ? a : b));
  const evidenceDays = Math.max(1, dayNumber(today) - dayNumber(earliest) + 1);

  if (evidenceDays < COACH_LIMITS.weeklyMinDays) {
    return {
      available: false,
      evidenceDays,
      note: `Only ${plural(evidenceDays, 'day', 'days')} of data so far. Weekly insights appear after ${COACH_LIMITS.weeklyMinDays} days.`,
      days: [],
      comparison: null,
    };
  }

  const tasksOn = (key) => tasks.filter((task) => task.completed && task.completedKey === key).length;
  const sessionsOn = (key) => sessions.filter((session) => session.key === key);
  const minutesOf = (list) => Math.round(list.reduce((sum, s) => sum + s.durationSeconds, 0) / 60);

  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = shiftKey(today, -offset);
    const onDay = sessionsOn(key);
    days.push({ date: key, tasksCompleted: tasksOn(key), focusSessions: onDay.length, focusMinutes: minutesOf(onDay) });
  }

  let comparison = null;
  if (evidenceDays >= COACH_LIMITS.compareMinDays) {
    let previousTasks = 0;
    let previousMinutes = 0;
    for (let offset = 7; offset <= 13; offset += 1) {
      const key = shiftKey(today, -offset);
      previousTasks += tasksOn(key);
      previousMinutes += minutesOf(sessionsOn(key));
    }
    const thisTasks = days.reduce((sum, day) => sum + day.tasksCompleted, 0);
    const thisMinutes = days.reduce((sum, day) => sum + day.focusMinutes, 0);
    comparison = {
      tasksCompletedDelta: thisTasks - previousTasks,
      focusMinutesDelta: thisMinutes - previousMinutes,
      previousTasksCompleted: previousTasks,
      previousFocusMinutes: previousMinutes,
    };
  }

  return {
    available: true,
    evidenceDays,
    note: 'Task counts come from tasks still in your list, so deleted or reopened tasks are not included.',
    days,
    comparison,
  };
}

/**
 * input: { tasks, sessions, now, focusMinutes }
 *   tasks    - array of task objects (see js/tasks.js)
 *   sessions - array of { id, durationSeconds, completedAt } (already de-duplicated and
 *              dev-filtered by the caller; duplicates and bad items are still skipped here)
 *   now      - Date (injected so results are repeatable)
 * Returns { dateKey, hasData, summary, recommendations, weekly }. Same input, same output.
 */
export function computeCoach({ tasks = [], sessions = [], now = new Date(), focusMinutes = 25 } = {}) {
  const today = keyOf(now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());
  const cleanT = cleanTasks(tasks);
  const cleanS = cleanSessions(sessions);
  const minutes = Number.isInteger(focusMinutes) && focusMinutes > 0 ? focusMinutes : 25;

  const pendingTasks = cleanT.filter((task) => !task.completed);
  const todaySessions = cleanS.filter((session) => session.key === today);

  const summary = {
    totalTasks: cleanT.length,
    pending: pendingTasks.length,
    overdue: pendingTasks.filter((task) => task.dueKey !== null && task.dueKey < today).length,
    dueToday: pendingTasks.filter((task) => task.dueKey === today).length,
    completedToday: cleanT.filter((task) => task.completed && task.completedKey === today).length,
    focusSessionsToday: todaySessions.length,
    focusMinutesToday: Math.round(todaySessions.reduce((sum, s) => sum + s.durationSeconds, 0) / 60),
    focusStreakDays: focusStreak(new Set(cleanS.map((session) => session.key)), today),
  };

  const hasData = cleanT.length > 0 || cleanS.length > 0;
  const recommendations = hasData
    ? buildRecommendations(summary, minutes)
    : [
        {
          id: 'starter',
          text: 'Add one small task or start one short focus session to get going. Suggestions appear as you use FocusFlow.',
          reason: 'No tasks or focus sessions are recorded yet.',
        },
      ];

  return { dateKey: today, hasData, summary, recommendations, weekly: buildWeekly(cleanT, cleanS, today) };
}