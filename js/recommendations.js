// js/recommendations.js
// Explainable, deterministic "what next" suggestions. PURE: no DOM, no chrome.* calls, no storage,
// no network, and it never modifies its input. Its only import is the Planner's shared ranking.
//
// Everything shown is derived from real data: the task list, completed focus sessions, the saved
// settings and the live timer state. Nothing is estimated or invented, and no claim is made about
// productivity or health. Tasks have no stored duration, so "does it fit in one session" is never claimed.
// "today" is a local "YYYY-MM-DD" string supplied by the caller so results are repeatable.

import { rankPendingTasks } from './planner.js';

export const REC_LIMITS = Object.freeze({
  alternatives: 2,
  historyMinSessions: 5,
  historyMinDays: 3,
  historyMinDiffMinutes: 5,
});

const DEFAULT_SETTINGS = Object.freeze({ focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4 });
const PRIORITY_LABEL = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });

const TIER_RULE = [
  'Overdue tasks are suggested first.',
  'Nothing is overdue, so tasks due today come first.',
  'Nothing is overdue or due today, so the nearest deadline within 3 days comes next.',
  'Nothing is due within 3 days, so the nearest upcoming deadline is suggested.',
  'No pending task has a due date, so higher priority and older tasks come first.',
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function dayNumber(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

function keyFromTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function wholeInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function cleanSettings(raw) {
  const s = isObject(raw) ? raw : {};
  return {
    focusMinutes: wholeInRange(s.focusMinutes, 1, 180, DEFAULT_SETTINGS.focusMinutes),
    shortBreakMinutes: wholeInRange(s.shortBreakMinutes, 1, 60, DEFAULT_SETTINGS.shortBreakMinutes),
    longBreakMinutes: wholeInRange(s.longBreakMinutes, 1, 120, DEFAULT_SETTINGS.longBreakMinutes),
    sessionsBeforeLongBreak: wholeInRange(s.sessionsBeforeLongBreak, 2, 12, DEFAULT_SETTINGS.sessionsBeforeLongBreak),
  };
}

function cleanTimer(raw) {
  const t = isObject(raw) ? raw : {};
  return {
    status: ['idle', 'running', 'paused'].includes(t.status) ? t.status : 'idle',
    mode: ['focus', 'shortBreak', 'longBreak'].includes(t.mode) ? t.mode : 'focus',
    cycleFocusCount: Number.isInteger(t.cycleFocusCount) && t.cycleFocusCount >= 0 ? t.cycleFocusCount : 0,
  };
}

function cleanSessions(raw, today) {
  const sessions = [];
  if (!Array.isArray(raw)) return sessions;
  const seen = new Set();
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (item.completed === false || item.cancelled === true || item.canceled === true) continue;
    const key = keyFromTimestamp(item.completedAt);
    const valid = Number.isInteger(item.durationSeconds) && item.durationSeconds > 0 && item.durationSeconds <= 86400;
    if (typeof item.id !== 'string' || item.id === '' || !valid || key === null || key > today || seen.has(item.id)) continue;
    seen.add(item.id);
    sessions.push({ seconds: item.durationSeconds, key });
  }
  return sessions;
}

/* ------------------------------------------------------------------ */
/* Explanations                                                        */
/* ------------------------------------------------------------------ */

function dueReason(task, today) {
  if (task.dueDate === null) return 'No due date, so it is ranked after tasks with deadlines.';
  const days = dayNumber(task.dueDate) - dayNumber(today);
  if (days < 0) return `Overdue by ${plural(-days, 'day', 'days')}.`;
  if (days === 0) return 'Due today.';
  if (days === 1) return 'Due tomorrow.';
  return `Due in ${days} days.`;
}

function tieReason(top, second) {
  if (!second || second.tier !== top.tier) return null;
  if (second.priority !== top.priority) return 'Higher priority than the next task in the same group.';
  if (second.dueDate !== top.dueDate) return 'Earlier deadline than the next task with the same priority.';
  if (second.createdAt !== top.createdAt) return 'Same priority and deadline as other tasks; this is the oldest.';
  return 'Tied with another task on every rule, so a fixed order was used.';
}

function explainTop(top, second, today) {
  const reasons = [dueReason(top, today), `${PRIORITY_LABEL[top.priority]} priority.`];
  const tie = tieReason(top, second);
  if (tie) reasons.push(tie);
  reasons.push(TIER_RULE[top.tier]);
  return reasons;
}

function briefReason(task, today) {
  return `${dueReason(task, today).replace(/\.$/, '')}; ${PRIORITY_LABEL[task.priority].toLowerCase()} priority.`;
}

function nextBreakText(timer, s) {
  const long = timer.cycleFocusCount + 1 >= s.sessionsBeforeLongBreak;
  const minutes = long ? s.longBreakMinutes : s.shortBreakMinutes;
  return (
    `After this session your timer will offer a ${minutes}-minute ${long ? 'long' : 'short'} break. ` +
    'Breaks follow your timer settings. They are not a measurement of fatigue or health.'
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * input: { tasks, sessions, settings, timer, today }
 *   tasks    - task objects from js/tasks.js (read only)
 *   sessions - completed sessions { id, durationSeconds, completedAt } (dev-mode ones already removed)
 *   settings - { focusMinutes, shortBreakMinutes, longBreakMinutes, sessionsBeforeLongBreak }
 *   timer    - { status, mode, cycleFocusCount } from the saved timerState
 *   today    - local date "YYYY-MM-DD"
 * Never throws. Same input gives the same output.
 * state: 'ready' | 'no-tasks' | 'all-done' | 'invalid-date'
 */
export function computeRecommendations({ tasks, sessions, settings, timer, today } = {}) {
  const base = { state: 'invalid-date', nextTask: null, alternatives: [], session: null, break: '', notes: [], skippedTasks: 0 };
  if (!isValidKey(today)) return base;

  const s = cleanSettings(settings);
  const t = cleanTimer(timer);
  const list = Array.isArray(tasks) ? tasks : [];
  const ranked = rankPendingTasks(list, today);
  const pendingRaw = list.filter((item) => !(isObject(item) && item.completed === true)).length;
  const completedCount = list.length - pendingRaw;
  const result = { ...base, state: 'ready', skippedTasks: Math.max(0, pendingRaw - ranked.length) };

  const top = ranked[0] || null;
  if (top === null) {
    result.state = completedCount > 0 ? 'all-done' : 'no-tasks';
  } else {
    result.nextTask = {
      id: top.id,
      title: top.title,
      priority: top.priority,
      dueDate: top.dueDate,
      reasons: explainTop(top, ranked[1], today),
    };
    result.alternatives = ranked.slice(1, 1 + REC_LIMITS.alternatives).map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      reason: briefReason(task, today),
    }));
  }

  // Session and break suggestion, based on the REAL timer state.
  if (t.status !== 'idle') {
    result.session = {
      kind: 'in-progress',
      minutes: null,
      text: t.mode === 'focus' ? 'A focus session is already in progress.' : 'A break is in progress.',
    };
  } else if (t.mode !== 'focus') {
    const minutes = t.mode === 'longBreak' ? s.longBreakMinutes : s.shortBreakMinutes;
    result.session = {
      kind: 'break-ready',
      minutes,
      text:
        `A ${minutes}-minute ${t.mode === 'longBreak' ? 'long' : 'short'} break is ready on the timer. ` +
        `When it ends, you can start a ${s.focusMinutes}-minute focus session${top ? ' on the suggested task' : ''}.`,
    };
  } else if (top) {
    result.session = {
      kind: 'start-focus',
      minutes: s.focusMinutes,
      text: `Start one ${s.focusMinutes}-minute focus session on the suggested task.`,
    };
    result.break = nextBreakText(t, s);
  } else {
    result.session = { kind: 'none', minutes: null, text: 'There is nothing pending to focus on right now.' };
  }

  // Notes: only facts that the data supports.
  const history = cleanSessions(sessions, today);
  const todayCount = history.filter((x) => x.key === today).length;
  if (todayCount > 0) result.notes.push(`You have completed ${plural(todayCount, 'focus session', 'focus sessions')} today.`);

  const activeDays = new Set(history.map((x) => x.key)).size;
  if (history.length >= REC_LIMITS.historyMinSessions && activeDays >= REC_LIMITS.historyMinDays) {
    const average = Math.round(history.reduce((sum, x) => sum + x.seconds, 0) / history.length / 60);
    if (Math.abs(average - s.focusMinutes) >= REC_LIMITS.historyMinDiffMinutes) {
      result.notes.push(
        `Your recorded sessions average ${average} min, while your timer is set to ${s.focusMinutes} min. ` +
          'You can change the focus length in Settings if you like.'
      );
    }
  }
  if (top) result.notes.push('Tasks do not store a duration, so this does not check whether the task fits in one session.');
  if (result.skippedTasks > 0) {
    result.notes.push(`${plural(result.skippedTasks, 'saved task was', 'saved tasks were')} unreadable and left out.`);
  }
  return result;
}