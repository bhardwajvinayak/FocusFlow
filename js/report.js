// js/report.js
// Weekly focus report and CSV builder. PURE: no DOM, no chrome.* calls, no storage, no network.
// Imports only the shared date/session logic (js/focus-intelligence.js) and goal normalization.
//
// Weeks are Monday to Sunday in LOCAL time. The current week is WEEK TO DATE and is compared with the
// SAME weekdays of the previous week. Day statuses:
//   recorded     valid completed sessions exist that day
//   none         inside the known history window, but nothing recorded
//   unavailable  no data can exist: before your first recorded activity (reason 'before-history')
//                or a day that has not happened yet (reason 'upcoming')
// "Evidence start" matches Focus Intelligence: the earliest of the first session and any supplied
// activity timestamps (for example task creation times), else today.

import { cleanSessions, formatDayLabel, isValidKey, keyFromTimestamp, keyOf, mondayOf, shiftKey } from './focus-intelligence.js';
import { normalizeStoredGoals } from './goals.js';

export const REPORT_LIMITS = Object.freeze({ maxWeeks: 52, bestDayMinActiveDays: 3 });
export const CSV_HEADER = Object.freeze(['date', 'weekday', 'focus_minutes', 'sessions', 'status']);
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function resolveToday(now) {
  return keyOf(now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());
}

function evidenceStartKey(cleanList, evidenceTimestamps, today) {
  const keys = cleanList.map((session) => session.key);
  for (const timestamp of Array.isArray(evidenceTimestamps) ? evidenceTimestamps : []) {
    const key = keyFromTimestamp(timestamp);
    if (key !== null && key <= today) keys.push(key);
  }
  return keys.length > 0 ? keys.reduce((a, b) => (a < b ? a : b)) : today;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Weeks that can be reported, newest first (current week first), at most REPORT_LIMITS.maxWeeks. */
export function listReportWeeks({ sessions = [], evidenceTimestamps = [], now = new Date() } = {}) {
  const today = resolveToday(now);
  const { sessions: clean } = cleanSessions(sessions, today);
  const first = mondayOf(evidenceStartKey(clean, evidenceTimestamps, today));
  const current = mondayOf(today);
  const weeks = [];
  let cursor = current;
  while (weeks.length < REPORT_LIMITS.maxWeeks && cursor >= first) {
    weeks.push({ startKey: cursor, endKey: shiftKey(cursor, 6), isCurrent: cursor === current });
    cursor = shiftKey(cursor, -7);
  }
  return weeks;
}

/**
 * input: { sessions, evidenceTimestamps, now, weekStart, goals }
 * weekStart: any local date inside the wanted week ("YYYY-MM-DD"); invalid or future -> current week.
 * Never throws. Same input gives the same output.
 */
export function buildWeeklyReport({ sessions = [], evidenceTimestamps = [], now = new Date(), weekStart, goals } = {}) {
  const today = resolveToday(now);
  const { sessions: clean, skipped } = cleanSessions(sessions, today);
  const evidenceStart = evidenceStartKey(clean, evidenceTimestamps, today);
  const currentMonday = mondayOf(today);
  let start = isValidKey(weekStart) ? mondayOf(weekStart) : currentMonday;
  if (start > currentMonday) start = currentMonday;
  const end = shiftKey(start, 6);
  const isCurrentWeek = start === currentMonday;
  const g = normalizeStoredGoals(goals).value;

  const byDay = new Map();
  for (const session of clean) {
    const day = byDay.get(session.key) || { seconds: 0, count: 0 };
    day.seconds += session.seconds;
    day.count += 1;
    byDay.set(session.key, day);
  }

  const days = WEEKDAYS.map((weekday, index) => {
    const date = shiftKey(start, index);
    const data = byDay.get(date);
    let status;
    let reason = '';
    if (date > today) {
      status = 'unavailable';
      reason = 'upcoming';
    } else if (date < evidenceStart) {
      status = 'unavailable';
      reason = 'before-history';
    } else {
      status = data ? 'recorded' : 'none';
    }
    const seconds = status === 'recorded' ? data.seconds : 0;
    return {
      date,
      weekday,
      status,
      reason,
      seconds,
      minutes: status === 'unavailable' ? null : Math.round(seconds / 60),
      sessions: status === 'unavailable' ? null : data ? data.count : 0,
    };
  });

  const evaluable = days.filter((day) => day.status !== 'unavailable');
  const daysElapsed = days.filter((day) => day.date <= today).length;
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  const sessionCount = days.reduce((sum, day) => sum + (day.sessions || 0), 0);
  const activeDays = days.filter((day) => day.status === 'recorded').length;
  const totals = {
    minutes: Math.round(totalSeconds / 60),
    sessions: sessionCount,
    averageMinutes: sessionCount > 0 ? Math.round((totalSeconds / sessionCount / 60) * 10) / 10 : null,
    activeDays,
  };
  const hasData = evaluable.length > 0;

  let bestDay = null;
  if (activeDays >= REPORT_LIMITS.bestDayMinActiveDays) {
    const max = Math.max(...days.map((day) => day.seconds));
    const dates = days.filter((day) => day.seconds === max).map((day) => day.date);
    bestDay = { dates, minutes: Math.round(max / 60), tied: dates.length > 1 };
  }

  // Comparison with the previous week (same weekdays when this week is partial).
  const prevStart = shiftKey(start, -7);
  const covered = evidenceStart <= prevStart;
  let comparison = null;
  let comparisonNote = '';
  if (hasData) {
    if (covered) {
      let prevSeconds = 0;
      for (let offset = 0; offset < daysElapsed; offset += 1) {
        const day = byDay.get(shiftKey(prevStart, offset));
        if (day) prevSeconds += day.seconds;
      }
      const thisMinutes = totals.minutes;
      const previousMinutes = Math.round(prevSeconds / 60);
      const deltaMinutes = thisMinutes - previousMinutes;
      comparison = {
        thisMinutes,
        previousMinutes,
        deltaMinutes,
        percent: previousMinutes > 0 ? Math.round((deltaMinutes / previousMinutes) * 100) : null,
        label: isCurrentWeek ? 'the same weekdays last week' : 'the previous week',
      };
    } else {
      comparisonNote =
        `A comparison needs history that starts on or before ${formatDayLabel(prevStart)}. ` +
        `Your recorded history starts ${formatDayLabel(evidenceStart)}.`;
    }
  }

  const weeklyDone = Math.floor(totalSeconds / 60);
  const goalsOut = {
    anyGoalSet: g.dailyFocusMinutes !== null || g.weeklyFocusMinutes !== null || g.dailySessions !== null,
    weeklyFocus:
      g.weeklyFocusMinutes === null
        ? { set: false }
        : {
            set: true,
            goal: g.weeklyFocusMinutes,
            done: weeklyDone,
            met: weeklyDone >= g.weeklyFocusMinutes,
            percent: Math.floor((weeklyDone * 100) / g.weeklyFocusMinutes),
          },
    dailyFocusDays:
      g.dailyFocusMinutes === null
        ? { set: false }
        : {
            set: true,
            goal: g.dailyFocusMinutes,
            daysMet: evaluable.filter((day) => day.seconds >= g.dailyFocusMinutes * 60).length,
            daysEvaluated: evaluable.length,
          },
    dailySessionsDays:
      g.dailySessions === null
        ? { set: false }
        : {
            set: true,
            goal: g.dailySessions,
            daysMet: evaluable.filter((day) => day.sessions >= g.dailySessions).length,
            daysEvaluated: evaluable.length,
          },
  };

  const summary = [];
  if (!hasData) {
    summary.push('This week is before your recorded history, so there is nothing to report.');
  } else if (sessionCount === 0) {
    summary.push('No completed focus sessions are recorded for this week.');
  } else {
    summary.push(`${totals.minutes} min of focus in ${plural(sessionCount, 'session', 'sessions')} on ${plural(activeDays, 'day', 'days')}.`);
    summary.push(`Average session: ${totals.averageMinutes} min.`);
    if (bestDay) {
      const latest = bestDay.dates[bestDay.dates.length - 1];
      summary.push(
        bestDay.tied
          ? `Highest focus days were tied at ${bestDay.minutes} min.`
          : `Highest focus day: ${formatDayLabel(latest)}, ${bestDay.minutes} min.`
      );
    }
  }
  if (comparison) {
    const { thisMinutes, previousMinutes, deltaMinutes, label } = comparison;
    const how = deltaMinutes > 0 ? `${deltaMinutes} min more than` : deltaMinutes < 0 ? `${-deltaMinutes} min less than` : 'the same as';
    summary.push(`${thisMinutes} min, ${how} ${label} (${previousMinutes} min).`);
  } else if (comparisonNote) {
    summary.push(comparisonNote);
  }

  return {
    weekStartKey: start,
    weekEndKey: end,
    throughKey: today < end ? today : end,
    isCurrentWeek,
    daysElapsed,
    hasData,
    evidence: { startKey: evidenceStart },
    days,
    totals,
    bestDay,
    comparison,
    comparisonNote,
    goals: goalsOut,
    summary,
    skipped,
  };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** Escapes one CSV field. Strings that a spreadsheet could read as a formula get a leading apostrophe. */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One header row plus exactly seven data rows (one per day), CRLF line endings.
 * Unavailable days have blank minutes and sessions, never 0. No task titles, notes or other text.
 * Returns '' if the report is not valid.
 */
export function reportToCsv(report) {
  if (!report || !Array.isArray(report.days) || report.days.length !== 7) return '';
  const lines = [CSV_HEADER.join(',')];
  for (const day of report.days) {
    lines.push([day.date, day.weekday, day.minutes, day.sessions, day.status].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** focusflow-week-YYYY-MM-DD.csv, where the date is the week's Monday. */
export function csvFilename(report) {
  return report && isValidKey(report.weekStartKey) ? `focusflow-week-${report.weekStartKey}.csv` : 'focusflow-week.csv';
}