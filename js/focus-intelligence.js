// js/focus-intelligence.js
// Pure, deterministic focus analytics. NO DOM, NO chrome.* calls, NO storage, NO imports,
// NO network, and it never modifies its input.
//
// Data used: completed focus sessions { id, durationSeconds, completedAt } (from "dailyStats").
// Only COMPLETED sessions are ever stored by FocusFlow. Records flagged as incomplete or cancelled
// are rejected anyway. Nothing is estimated or invented.
//
// Time rules (all LOCAL time):
//  - A session belongs to the local calendar day of completedAt.
//  - Weeks run Monday to Sunday. "This week" means Monday through today (week to date).
//  - The comparison uses the SAME weekdays of last week, so a partial week is never compared
//    with a full one, and it needs history that starts on or before last Monday.
//  - "Evidence start" = the earliest of the first recorded session and any supplied activity
//    timestamps (for example task creation times), or today if there is none. Days before it
//    are "unavailable" (no data exists), which is different from "none" (nothing recorded).
//
// The date helpers mirror getLocalDateKey() in js/storage.js (same local-day convention).

export const FI_LIMITS = Object.freeze({
  maxSessionSeconds: 86400,
  heatmapWeeks: 4,
  bestDayMinActiveDays: 3,
  trendMinEvidenceDays: 7,
  averageMinSessions: 3,
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INCOMPLETE_STATUSES = ['cancelled', 'canceled', 'abandoned', 'incomplete'];

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
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

/** Monday of the week containing `key`. */
function mondayOf(key) {
  const [year, month, day] = key.split('-').map(Number);
  const sinceMonday = (new Date(year, month - 1, day).getDay() + 6) % 7;
  return shiftKey(key, -sinceMonday);
}

function keyFromTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const key = keyOf(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null; // rejects years outside 0000-9999
}

/** "2026-10-21" -> "Wed 21 Oct". Fixed English format, so output never depends on the locale. */
export function formatDayLabel(key) {
  if (!isValidKey(key)) return String(key);
  const [year, month, day] = key.split('-').map(Number);
  return `${WEEKDAYS[new Date(year, month - 1, day).getDay()]} ${day} ${MONTHS[month - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Input cleaning                                                      */
/* ------------------------------------------------------------------ */

function cleanSessions(raw, todayKey) {
  const skipped = { invalid: 0, duplicates: 0, future: 0, incomplete: 0 };
  const sessions = [];
  if (!Array.isArray(raw)) return { sessions, skipped };

  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      skipped.invalid += 1;
      continue;
    }
    if (
      item.completed === false ||
      item.cancelled === true ||
      item.canceled === true ||
      INCOMPLETE_STATUSES.includes(item.status)
    ) {
      skipped.incomplete += 1;
      continue;
    }
    const key = keyFromTimestamp(item.completedAt);
    const validDuration =
      Number.isInteger(item.durationSeconds) &&
      item.durationSeconds > 0 &&
      item.durationSeconds <= FI_LIMITS.maxSessionSeconds;
    if (typeof item.id !== 'string' || item.id === '' || !validDuration || key === null) {
      skipped.invalid += 1;
      continue;
    }
    if (key > todayKey) {
      skipped.future += 1; // a session that "ends" after today cannot be real
      continue;
    }
    if (seen.has(item.id)) {
      skipped.duplicates += 1; // the first record with an id wins
      continue;
    }
    seen.add(item.id);
    sessions.push({ id: item.id, seconds: item.durationSeconds, key });
  }
  return { sessions, skipped };
}

/* ------------------------------------------------------------------ */
/* Calculations                                                        */
/* ------------------------------------------------------------------ */

const toMinutes = (seconds) => Math.round(seconds / 60);

function sumRange(byDay, startKey, days) {
  let seconds = 0;
  let count = 0;
  for (let offset = 0; offset < days; offset += 1) {
    const day = byDay.get(shiftKey(startKey, offset));
    if (day) {
      seconds += day.seconds;
      count += day.count;
    }
  }
  return { seconds, count };
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function buildInsights(r) {
  const insights = [];
  const { totals, evidence, comparison, bestDay } = r;

  if (totals.sessions === 0) {
    insights.push({
      id: 'no-history',
      text: 'No completed focus sessions are recorded yet. Finish a session from the Focus tab and your history will appear here.',
    });
    return insights;
  }

  if (totals.activeDays < FI_LIMITS.bestDayMinActiveDays || evidence.days < FI_LIMITS.trendMinEvidenceDays) {
    insights.push({
      id: 'little-history',
      text:
        `Only ${plural(totals.sessions, 'completed focus session', 'completed focus sessions')} on ` +
        `${plural(totals.activeDays, 'day', 'days')} ${totals.sessions === 1 ? 'is' : 'are'} recorded so far. ` +
        'Trends and comparisons appear after about a week of use.',
    });
  }

  if (comparison && !(comparison.thisMinutes === 0 && comparison.previousMinutes === 0)) {
    const { thisMinutes, previousMinutes, deltaMinutes } = comparison;
    const how =
      deltaMinutes > 0
        ? `${deltaMinutes} min more than`
        : deltaMinutes < 0
          ? `${-deltaMinutes} min less than`
          : 'the same as';
    insights.push({
      id: 'week-vs-last',
      text: `You have focused ${thisMinutes} min so far this week, ${how} the same days last week (${previousMinutes} min).`,
    });
  }

  if (bestDay) {
    const latest = bestDay.dates[bestDay.dates.length - 1];
    insights.push({
      id: 'best-day',
      text: bestDay.tied
        ? `Your highest recorded focus days were tied at ${bestDay.minutes} min (${bestDay.dates.length} days; the most recent was ${formatDayLabel(latest)}).`
        : `Your highest recorded focus day was ${formatDayLabel(latest)} with ${bestDay.minutes} min.`,
    });
  }

  if (totals.sessions >= FI_LIMITS.averageMinSessions && totals.averageMinutes !== null) {
    insights.push({
      id: 'average',
      text: `Your recorded sessions average ${totals.averageMinutes} min each.`,
    });
  }
  return insights;
}

/**
 * input: { sessions, now, evidenceTimestamps }
 *   sessions           - array of { id, durationSeconds, completedAt } (callers should already
 *                        have removed dev-mode sessions; duplicates and bad items are skipped here)
 *   now                - Date (injected so results are repeatable)
 *   evidenceTimestamps - optional epoch-ms values proving FocusFlow was in use (for example task createdAt)
 * Never throws. Same input gives the same output.
 */
export function computeFocusIntelligence({ sessions = [], now = new Date(), evidenceTimestamps = [] } = {}) {
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const todayKey = keyOf(nowDate);
  const { sessions: clean, skipped } = cleanSessions(sessions, todayKey);

  const byDay = new Map();
  for (const session of clean) {
    const day = byDay.get(session.key) || { seconds: 0, count: 0 };
    day.seconds += session.seconds;
    day.count += 1;
    byDay.set(session.key, day);
  }

  // Evidence start: where real history begins.
  const evidenceKeys = clean.map((session) => session.key);
  for (const timestamp of Array.isArray(evidenceTimestamps) ? evidenceTimestamps : []) {
    const key = keyFromTimestamp(timestamp);
    if (key !== null && key <= todayKey) evidenceKeys.push(key);
  }
  const evidenceStart = evidenceKeys.length > 0 ? evidenceKeys.reduce((a, b) => (a < b ? a : b)) : todayKey;
  const evidence = { startKey: evidenceStart, days: dayNumber(todayKey) - dayNumber(evidenceStart) + 1 };

  const totalSeconds = clean.reduce((sum, session) => sum + session.seconds, 0);
  const totals = {
    sessions: clean.length,
    seconds: totalSeconds,
    minutes: toMinutes(totalSeconds),
    averageMinutes: clean.length > 0 ? Math.round((totalSeconds / clean.length / 60) * 10) / 10 : null,
    activeDays: byDay.size,
    firstSessionKey: clean.length > 0 ? clean.map((s) => s.key).reduce((a, b) => (a < b ? a : b)) : null,
  };

  const todayDay = byDay.get(todayKey);
  const today = { minutes: todayDay ? toMinutes(todayDay.seconds) : 0, sessions: todayDay ? todayDay.count : 0 };

  // Weeks (Monday to Sunday, local)
  const weekStart = mondayOf(todayKey);
  const daysElapsed = dayNumber(todayKey) - dayNumber(weekStart) + 1;
  const prevStart = shiftKey(weekStart, -7);
  const covered = evidenceStart <= prevStart; // history covers the whole of last week

  const thisSum = sumRange(byDay, weekStart, daysElapsed);
  const prevFull = sumRange(byDay, prevStart, 7);
  const prevSame = sumRange(byDay, prevStart, daysElapsed);

  const thisWeek = {
    startKey: weekStart,
    throughKey: todayKey,
    endKey: shiftKey(weekStart, 6),
    daysElapsed,
    minutes: toMinutes(thisSum.seconds),
    sessions: thisSum.count,
  };
  const previousWeek = {
    startKey: prevStart,
    endKey: shiftKey(weekStart, -1),
    samePeriodEndKey: shiftKey(prevStart, daysElapsed - 1),
    covered,
    minutes: toMinutes(prevFull.seconds),
    sessions: prevFull.count,
    samePeriodMinutes: toMinutes(prevSame.seconds),
  };

  let comparison = null;
  let comparisonNote = '';
  if (covered) {
    const deltaMinutes = thisWeek.minutes - previousWeek.samePeriodMinutes;
    comparison = {
      thisMinutes: thisWeek.minutes,
      previousMinutes: previousWeek.samePeriodMinutes,
      deltaMinutes,
      percent:
        previousWeek.samePeriodMinutes > 0 ? Math.round((deltaMinutes / previousWeek.samePeriodMinutes) * 100) : null,
    };
  } else {
    comparisonNote =
      `A comparison needs history that starts on or before last Monday (${formatDayLabel(prevStart)}). ` +
      `Your recorded history starts ${formatDayLabel(evidenceStart)}.`;
  }

  // Best day (all recorded days)
  let bestDay = null;
  if (byDay.size >= FI_LIMITS.bestDayMinActiveDays) {
    const max = Math.max(...[...byDay.values()].map((day) => day.seconds));
    const dates = [...byDay.entries()].filter(([, day]) => day.seconds === max).map(([key]) => key).sort();
    bestDay = { dates, minutes: toMinutes(max), tied: dates.length > 1 };
  }

  // Heatmap: last N weeks, Monday to Sunday rows, ending this week's Sunday.
  const heatStart = shiftKey(weekStart, -7 * (FI_LIMITS.heatmapWeeks - 1));
  const heatEnd = shiftKey(weekStart, 6);
  let maxSeconds = 0;
  for (let offset = 0; offset < FI_LIMITS.heatmapWeeks * 7; offset += 1) {
    const day = byDay.get(shiftKey(heatStart, offset));
    if (day && day.seconds > maxSeconds) maxSeconds = day.seconds;
  }
  const weeks = [];
  for (let w = 0; w < FI_LIMITS.heatmapWeeks; w += 1) {
    const row = [];
    for (let d = 0; d < 7; d += 1) {
      const key = shiftKey(heatStart, w * 7 + d);
      const day = byDay.get(key);
      let status = 'none';
      if (key > todayKey) status = 'future';
      else if (key < evidenceStart) status = 'unavailable';
      else if (day) status = 'recorded';
      row.push({
        date: key,
        status,
        minutes: status === 'recorded' ? toMinutes(day.seconds) : 0,
        sessions: status === 'recorded' ? day.count : 0,
        level: status === 'recorded' ? Math.min(4, Math.max(1, Math.ceil((day.seconds / maxSeconds) * 4))) : 0,
      });
    }
    weeks.push(row);
  }
  const heatmap = {
    startKey: heatStart,
    endKey: heatEnd,
    weeks,
    note:
      `${formatDayLabel(heatStart)} to ${formatDayLabel(heatEnd)}, Monday to Sunday weeks, local time. ` +
      'Shading is relative to your busiest day in this range. Days before your first recorded activity are ' +
      'marked unavailable, not zero.',
  };

  const daily = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, day]) => ({ date, minutes: toMinutes(day.seconds), sessions: day.count }));

  const result = { todayKey, evidence, totals, today, thisWeek, previousWeek, comparison, comparisonNote, bestDay, heatmap, daily, skipped };
  result.insights = buildInsights(result);
  return result;
}