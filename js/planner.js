// js/planner.js
// Pure, deterministic daily-plan builder. NO DOM, NO chrome.* calls, NO storage, NO imports,
// NO network, and it never modifies its input.
//
// It is a transparent, rule-based SUGGESTION, not a globally optimal schedule.
// Task order (documented): sort by
//   1. tier: 0 overdue, 1 due today, 2 due in 1-3 days, 3 due later, 4 no due date
//   2. priority: high, medium, low
//   3. due date (earlier first; none last)
//   4. createdAt (older first)
//   5. id (final tie-break, so identical input always gives identical output)
// Tasks are placed greedily, all-or-nothing, so a later short task can fill leftover time.
// Times are minutes since local midnight on the planning day.

export const PLANNER_LIMITS = Object.freeze({
  availableMinutes: Object.freeze({ min: 15, max: 720 }),
  sessionMinutes: Object.freeze({ min: 5, max: 180 }),
  breakMinutes: Object.freeze({ min: 0, max: 60 }),
  defaultTaskMinutes: Object.freeze({ min: 5, max: 240 }),
  taskEstimateMinutes: Object.freeze({ min: 5, max: 480 }),
});

export const DEFAULT_PLANNER_SETTINGS = Object.freeze({
  startTime: '09:00',
  availableMinutes: 240,
  sessionMinutes: 25,
  breakMinutes: 5,
  defaultTaskMinutes: 25,
});

export const SOON_DAYS = 3;
const DAY_MINUTES = 1440;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const FIELD_LABELS = {
  availableMinutes: 'Available time',
  sessionMinutes: 'Longest work session',
  breakMinutes: 'Break length',
  defaultTaskMinutes: 'Default task length',
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
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

/** "HH:MM" (00:00 to 23:59) -> minutes since midnight, or null. */
export function parseTime(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(typeof text === 'string' ? text.trim() : '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/** Minutes since midnight -> "HH:MM" (1440 becomes "24:00", the end of the day). */
export function formatTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Whole numbers only: an integer, or a string of digits. Anything else gives null. */
function parseWholeNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/* ------------------------------------------------------------------ */
/* Settings and estimates                                              */
/* ------------------------------------------------------------------ */

/** Returns { ok, value, errors }. Never throws. value includes startMinutes when ok. */
export function validatePlannerSettings(input) {
  if (!isObject(input)) return { ok: false, value: null, errors: ['Planner settings are missing.'] };

  const errors = [];
  const value = {};

  const start = parseTime(input.startTime);
  if (start === null) errors.push('Choose a valid start time.');
  else {
    value.startTime = formatTime(start);
    value.startMinutes = start;
  }

  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const { min, max } = PLANNER_LIMITS[field];
    const number = parseWholeNumber(input[field]);
    if (number === null || number < min || number > max) {
      errors.push(`${label} must be a whole number from ${min} to ${max} minutes.`);
    } else {
      value[field] = number;
    }
  }

  if (errors.length === 0 && value.startMinutes + value.availableMinutes > DAY_MINUTES) {
    errors.push('The plan would run past midnight. Start earlier or shorten the available time.');
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

/** Per-task estimate -> { minutes, source: 'estimate' | 'default', note }. Bad values use the default. */
export function normalizeEstimate(raw, defaultMinutes) {
  if (raw === undefined || raw === null || raw === '') {
    return { minutes: defaultMinutes, source: 'default', note: '' };
  }
  const { min, max } = PLANNER_LIMITS.taskEstimateMinutes;
  const number = parseWholeNumber(raw);
  if (number === null || number < min || number > max) {
    return {
      minutes: defaultMinutes,
      source: 'default',
      note: `Estimate ignored (use ${min} to ${max} minutes), so the default length was used.`,
    };
  }
  return { minutes: number, source: 'estimate', note: '' };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

function cleanTask(raw, today) {
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null;
  if (raw.completed !== false) return null;
  const dueDate = isValidKey(raw.dueDate) ? raw.dueDate : null;
  let tier = 4;
  if (dueDate !== null) {
    const days = dayNumber(dueDate) - dayNumber(today);
    tier = days < 0 ? 0 : days === 0 ? 1 : days <= SOON_DAYS ? 2 : 3;
  }
  return {
    id: raw.id,
    title: raw.title.trim(),
    priority: Object.prototype.hasOwnProperty.call(PRIORITY_RANK, raw.priority) ? raw.priority : 'medium',
    dueDate,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    tier,
  };
}

function compareTasks(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Splits `minutes` into the fewest roughly equal parts, each at most `session` minutes. */
function splitIntoParts(minutes, session) {
  const parts = Math.ceil(minutes / session);
  const base = Math.floor(minutes / parts);
  const extra = minutes % parts;
  return Array.from({ length: parts }, (_, index) => (index < extra ? base + 1 : base));
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * input: { tasks, settings, estimates, today }
 *   tasks     - task objects (read only)
 *   settings  - { startTime 'HH:MM', availableMinutes, sessionMinutes, breakMinutes, defaultTaskMinutes }
 *   estimates - optional { [taskId]: minutes } (read only)
 *   today     - local date "YYYY-MM-DD" (injected so results are repeatable)
 * Returns { ok: false, errors } or
 *   { ok: true, settings, blocks, scheduled, unscheduled, ignored, totals }.
 */
export function planDay({ tasks, settings, estimates, today } = {}) {
  const checked = validatePlannerSettings(settings);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  if (!isValidKey(today)) return { ok: false, errors: ["Today's date is invalid."] };

  const s = checked.value;
  const estimateMap = isObject(estimates) ? estimates : {};
  const ignored = { completed: 0, invalid: 0, duplicates: 0 };
  const seen = new Set();
  const candidates = [];

  for (const raw of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(raw)) {
      ignored.invalid += 1;
      continue;
    }
    if (raw.completed === true) {
      ignored.completed += 1;
      continue;
    }
    const task = cleanTask(raw, today);
    if (task === null) {
      ignored.invalid += 1;
      continue;
    }
    if (seen.has(task.id)) {
      ignored.duplicates += 1;
      continue;
    }
    seen.add(task.id);
    const rawEstimate = Object.prototype.hasOwnProperty.call(estimateMap, task.id) ? estimateMap[task.id] : undefined;
    candidates.push({ ...task, ...normalizeEstimate(rawEstimate, s.defaultTaskMinutes) });
  }
  candidates.sort(compareTasks);

  const endLimit = s.startMinutes + s.availableMinutes;
  let cursor = s.startMinutes;
  const blocks = [];
  const scheduled = [];
  const unscheduled = [];

  const addBlock = (block) => {
    blocks.push({ ...block, startLabel: formatTime(block.start), endLabel: formatTime(block.end) });
  };

  for (const task of candidates) {
    const parts = splitIntoParts(task.minutes, s.sessionMinutes);
    const needed = task.minutes + (parts.length - 1) * s.breakMinutes; // work + breaks between its own parts
    const lead = blocks.length > 0 ? s.breakMinutes : 0;
    const base = {
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate,
      minutes: task.minutes,
      estimateSource: task.source,
      estimateNote: task.note,
    };

    if (needed > s.availableMinutes) {
      unscheduled.push({
        ...base,
        reason: 'longer-than-window',
        reasonText: `Needs ${needed} min including breaks, which is longer than the whole ${s.availableMinutes}-minute window.`,
      });
      continue;
    }
    if (cursor + lead + needed > endLimit) {
      unscheduled.push({
        ...base,
        reason: 'no-time',
        reasonText: `Needs ${needed} min including breaks, but not enough time is left in the window.`,
      });
      continue;
    }

    if (lead > 0) {
      addBlock({ type: 'break', start: cursor, end: cursor + lead, minutes: lead });
      cursor += lead;
    }
    const taskStart = cursor;
    parts.forEach((length, index) => {
      if (index > 0 && s.breakMinutes > 0) {
        addBlock({ type: 'break', start: cursor, end: cursor + s.breakMinutes, minutes: s.breakMinutes });
        cursor += s.breakMinutes;
      }
      addBlock({
        type: 'work',
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        dueDate: task.dueDate,
        overdue: task.tier === 0,
        start: cursor,
        end: cursor + length,
        minutes: length,
        part: index + 1,
        parts: parts.length,
      });
      cursor += length;
    });
    scheduled.push({
      ...base,
      overdue: task.tier === 0,
      start: taskStart,
      end: cursor,
      startLabel: formatTime(taskStart),
      endLabel: formatTime(cursor),
      parts: parts.length,
    });
  }

  const sum = (type) => blocks.filter((b) => b.type === type).reduce((total, b) => total + b.minutes, 0);
  return {
    ok: true,
    settings: s,
    blocks,
    scheduled,
    unscheduled,
    ignored,
    totals: {
      workMinutes: sum('work'),
      breakMinutes: sum('break'),
      freeMinutes: endLimit - cursor,
      startsAt: formatTime(s.startMinutes),
      endsAt: formatTime(cursor),
      windowEndsAt: formatTime(endLimit),
    },
  };
}

/** Plain-text version of a plan, for the optional "Copy plan" button. Pure. */
export function planToText(plan) {
  if (!plan || plan.ok !== true) return '';
  const label = { high: 'High', medium: 'Medium', low: 'Low' };
  const lines = [`FocusFlow plan, ${plan.totals.startsAt} to ${plan.totals.windowEndsAt}`];
  for (const block of plan.blocks) {
    if (block.type === 'break') {
      lines.push(`${block.startLabel}-${block.endLabel}  Break`);
    } else {
      const part = block.parts > 1 ? ` (part ${block.part} of ${block.parts})` : '';
      lines.push(`${block.startLabel}-${block.endLabel}  ${block.title}${part} [${label[block.priority]} priority]`);
    }
  }
  if (plan.unscheduled.length > 0) {
    lines.push('', 'Not scheduled:');
    for (const item of plan.unscheduled) lines.push(`- ${item.title}: ${item.reasonText}`);
  }
  return lines.join('\n');
}

/**
 * Pending tasks in the same order planDay() uses (overdue first, then due today, due within 3 days,
 * due later, no due date; then priority, due date, age, id). Pure. Invalid, completed and duplicate
 * items are skipped. Each result: { id, title, priority, dueDate, createdAt, tier }.
 * Shared so other features (recommendations) cannot disagree with the Planner.
 */
export function rankPendingTasks(tasks, today) {
  if (!isValidKey(today)) return [];
  const seen = new Set();
  const ranked = [];
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(raw) || raw.completed === true) continue;
    const task = cleanTask(raw, today);
    if (task === null || seen.has(task.id)) continue;
    seen.add(task.id);
    ranked.push(task);
  }
  return ranked.sort(compareTasks);
}