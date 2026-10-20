// js/insights.js
// Weekly productivity insights: focus + completed tasks + habit check-ins. PURE: no DOM, no chrome.*,
// no storage, no network. It never modifies its input and returns the same output for the same input.
//
// Focus numbers come from buildWeeklyReport (js/report.js), so they always agree with the focus report.
// Weeks are Monday to Sunday, local time. A metric with no data is null, never 0:
//   - tasks: null when there are no tasks at all, and for days with no history (before history / upcoming).
//     Counts only tasks that still exist (deleted or reopened tasks leave no trace).
//   - habits: ACTIVE habits only. A habit counts only from its start day, so earlier days are never "missed".
// "Most productive day" = the day with the most focus minutes (needs 3 active days).

import { buildWeeklyReport } from './report.js';
import { computeHabitStats } from './habits.js';
import { keyFromTimestamp, keyOf, shiftKey } from './focus-intelligence.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function cleanTasks(raw) {
  const tasks = [];
  let skipped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || typeof item.completed !== 'boolean' || !Number.isFinite(item.createdAt)) {
      skipped += 1;
      continue;
    }
    tasks.push({ completedKey: item.completed ? keyFromTimestamp(item.completedAt) : null });
  }
  return { tasks, skipped };
}

function activeHabits(raw, now) {
  const list = [];
  for (const habit of Array.isArray(raw) ? raw : []) {
    if (!isObject(habit) || typeof habit.id !== 'string' || typeof habit.name !== 'string') continue;
    if (habit.archivedAt !== null && habit.archivedAt !== undefined) continue;
    if (!Array.isArray(habit.completions) || !Number.isFinite(habit.createdAt)) continue;
    const stats = computeHabitStats(habit, now);
    list.push({
      id: habit.id,
      name: habit.name.trim(),
      set: new Set(habit.completions.filter((d) => typeof d === 'string')),
      startKey: stats.startKey,
      current: stats.current,
      best: stats.best,
    });
  }
  return list;
}

/** Done / eligible check-ins over `dates`, per habit and overall. A day is eligible from the habit's start day. */
function habitWeek(habits, dates) {
  const perHabit = habits.map((h) => {
    const eligibleDays = dates.filter((d) => d >= h.startKey);
    const done = eligibleDays.filter((d) => h.set.has(d)).length;
    return {
      id: h.id,
      name: h.name,
      eligible: eligibleDays.length,
      done,
      rate: eligibleDays.length > 0 ? Math.round((done * 100) / eligibleDays.length) : null,
      current: h.current,
      best: h.best,
    };
  });
  const eligible = perHabit.reduce((sum, h) => sum + h.eligible, 0);
  const done = perHabit.reduce((sum, h) => sum + h.done, 0);
  return { perHabit, eligible, done, rate: eligible > 0 ? Math.round((done * 100) / eligible) : null };
}

/**
 * input: { sessions, tasks, habits, evidenceTimestamps, now, weekStart }
 *   sessions - completed sessions (dev-mode ones already removed by the caller)
 *   tasks    - task objects (read only)
 *   habits   - habit objects from js/habits.js cleanHabits (read only)
 *   evidenceTimestamps - epoch ms proving FocusFlow was in use (task / habit creation times)
 */
export function buildProductivityInsights({ sessions = [], tasks = [], habits = [], evidenceTimestamps = [], now = new Date(), weekStart } = {}) {
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const today = keyOf(nowDate);
  const report = buildWeeklyReport({ sessions, evidenceTimestamps, now: nowDate, weekStart });

  const { tasks: cleanT, skipped: skippedTasks } = cleanTasks(tasks);
  const completedOn = new Map();
  for (const t of cleanT) if (t.completedKey) completedOn.set(t.completedKey, (completedOn.get(t.completedKey) || 0) + 1);
  const tasksAvailable = cleanT.length > 0;

  const habitList = activeHabits(habits, nowDate);
  const habitsAvailable = habitList.length > 0;

  const days = report.days.map((day) => {
    const evaluable = day.status !== 'unavailable';
    const tasksCompleted = tasksAvailable && evaluable ? completedOn.get(day.date) || 0 : null;
    let habitsTracked = null;
    let habitsDone = null;
    if (habitsAvailable && evaluable) {
      const eligible = habitList.filter((h) => h.startKey <= day.date);
      if (eligible.length > 0) {
        habitsTracked = eligible.length;
        habitsDone = eligible.filter((h) => h.set.has(day.date)).length;
      }
    }
    return {
      date: day.date, weekday: day.weekday, status: day.status, reason: day.reason,
      minutes: day.minutes, sessions: day.sessions, tasksCompleted, habitsDone, habitsTracked,
    };
  });

  const weekDates = report.days.filter((d) => d.date <= today).map((d) => d.date);
  const tasksTotal = days.reduce((sum, d) => sum + (d.tasksCompleted || 0), 0);
  const habitsThis = habitsAvailable ? habitWeek(habitList, weekDates) : null;

  // Comparisons need history reaching back to last Monday and data in BOTH periods.
  const prevStart = shiftKey(report.weekStartKey, -7);
  const covered = report.evidence.startKey <= prevStart;
  const prevDates = Array.from({ length: report.daysElapsed }, (_, i) => shiftKey(prevStart, i));

  let tasksComparison = null;
  if (tasksAvailable && covered && report.hasData) {
    const previous = prevDates.reduce((sum, d) => sum + (completedOn.get(d) || 0), 0);
    tasksComparison = { this: tasksTotal, previous, delta: tasksTotal - previous };
  }
  let habitsComparison = null;
  if (habitsThis && habitsThis.rate !== null && covered) {
    const prev = habitWeek(habitList, prevDates);
    if (prev.rate !== null) habitsComparison = { thisRate: habitsThis.rate, previousRate: prev.rate, deltaPoints: habitsThis.rate - prev.rate };
  }
  const focusComparison = report.comparison;
  const comparisonNote = covered ? '' : 'Comparisons need history that starts on or before last Monday.';

  const lines = [];
  if (!report.hasData) {
    lines.push({ id: 'no-history', text: 'This week is before your recorded history, so there is nothing to report.' });
  } else {
    lines.push({
      id: 'focus',
      text:
        report.totals.sessions > 0
          ? `${report.totals.minutes} min of focus in ${plural(report.totals.sessions, 'session', 'sessions')} on ${plural(report.totals.activeDays, 'day', 'days')}.`
          : 'No completed focus sessions are recorded for this week.',
    });
    if (report.bestDay) {
      const latest = report.bestDay.dates[report.bestDay.dates.length - 1];
      lines.push({
        id: 'best-day',
        text: report.bestDay.tied
          ? `Most focus minutes: tied at ${report.bestDay.minutes} min across ${report.bestDay.dates.length} days.`
          : `Most focus minutes: ${latest}, ${report.bestDay.minutes} min.`,
      });
    }
    lines.push({
      id: 'tasks',
      text: tasksAvailable
        ? `${plural(tasksTotal, 'task', 'tasks')} completed (counting tasks still in your list).`
        : 'No tasks exist yet, so there are no task numbers.',
    });
    if (habitsThis && habitsThis.rate !== null) {
      lines.push({ id: 'habits', text: `Habit check-ins: ${habitsThis.done} of ${habitsThis.eligible} possible days (${habitsThis.rate}%).` });
    } else {
      lines.push({ id: 'habits', text: habitsAvailable ? 'No habit days are due yet this week.' : 'No active habits, so there are no habit numbers.' });
    }
    const compare = [];
    if (focusComparison) compare.push(`focus ${focusComparison.deltaMinutes >= 0 ? '+' : ''}${focusComparison.deltaMinutes} min`);
    if (tasksComparison) compare.push(`tasks ${tasksComparison.delta >= 0 ? '+' : ''}${tasksComparison.delta}`);
    if (habitsComparison) compare.push(`habit check-ins ${habitsComparison.deltaPoints >= 0 ? '+' : ''}${habitsComparison.deltaPoints} points`);
    if (compare.length > 0) {
      lines.push({ id: 'comparison', text: `Compared with ${report.isCurrentWeek ? 'the same weekdays last week' : 'the previous week'}: ${compare.join(', ')}.` });
    } else if (comparisonNote) {
      lines.push({ id: 'no-comparison', text: comparisonNote });
    }
  }

  return {
    report,
    days,
    tasks: { available: tasksAvailable, total: tasksAvailable ? tasksTotal : null },
    habits: habitsThis
      ? { available: true, eligible: habitsThis.eligible, done: habitsThis.done, rate: habitsThis.rate, perHabit: habitsThis.perHabit }
      : { available: false, eligible: 0, done: 0, rate: null, perHabit: [] },
    comparison: { focus: focusComparison, tasks: tasksComparison, habits: habitsComparison, note: comparisonNote },
    bestDay: report.bestDay,
    lines,
    skippedTasks,
  };
}