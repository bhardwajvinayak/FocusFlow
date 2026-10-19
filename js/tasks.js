// js/tasks.js
// Application layer for tasks: validation, CRUD, subtasks, recurrence, search, sorting,
// filtering and counting. NO DOM code. Talks to storage only through js/storage.js.
//
// Ownership: the popup is the only writer of the "tasks" key.
// Older tasks (Stage 3 shape) are upgraded in memory with defaults when loaded.

import { STORAGE_KEYS, getLocalDateKey, getValue, setValue } from './storage.js';

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 500;
export const CATEGORY_MAX_LENGTH = 30;
export const SUBTASK_MAX_LENGTH = 100;
export const MAX_SUBTASKS = 20;
export const UPCOMING_DAYS = 3;

export const TASK_FILTERS = Object.freeze(['all', 'pending', 'completed', 'overdue']);
export const TASK_SORTS = Object.freeze(['newest', 'oldest', 'due', 'priority']);
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const RECURRENCES = Object.freeze(['none', 'daily', 'weekly', 'monthly']);

/** Expected problems (bad input, missing task). The UI shows error.message to the user. */
export class TaskError extends Error {
  /** code: 'invalid-title' | 'invalid-description' | 'invalid-category' | 'invalid-priority'
   *        | 'invalid-recurrence' | 'invalid-date' | 'invalid-subtask' | 'invalid-input' | 'not-found' */
  constructor(message, code) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Date helpers (all dates are local "YYYY-MM-DD" strings)              */
/* ------------------------------------------------------------------ */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True only for real calendar dates written as "YYYY-MM-DD" (rejects "2026-02-31"). */
function isValidDateKey(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function parseDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDaysToKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return getLocalDateKey(new Date(year, month - 1, day + days));
}

/** Adds months and clamps the day to the end of a shorter month (Jan 31 + 1 month = Feb 28/29). */
function addMonthsToKey(key, months) {
  const [year, month, day] = key.split('-').map(Number);
  const target = month - 1 + months;
  const lastDay = new Date(year, target + 1, 0).getDate();
  return getLocalDateKey(new Date(year, target, Math.min(day, lastDay)));
}

function daysBetween(fromKey, toKey) {
  return Math.round((parseDateKey(toKey) - parseDateKey(fromKey)) / 86400000);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Trims the title and checks it is 1-200 characters. Returns the clean title. */
export function validateTitle(rawTitle) {
  if (typeof rawTitle !== 'string') {
    throw new TaskError('Task title must be text.', 'invalid-title');
  }
  const title = rawTitle.trim();
  if (title.length === 0) {
    throw new TaskError('Please enter a task title.', 'invalid-title');
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TaskError(
      `Task title must be ${TITLE_MAX_LENGTH} characters or fewer (currently ${title.length}).`,
      'invalid-title'
    );
  }
  return title;
}

export function validateDescription(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new TaskError('Description must be text.', 'invalid-description');
  const text = raw.trim();
  if (text.length > DESCRIPTION_MAX_LENGTH) {
    throw new TaskError(
      `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer (currently ${text.length}).`,
      'invalid-description'
    );
  }
  return text;
}

export function validateCategory(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new TaskError('Category must be text.', 'invalid-category');
  const text = raw.trim();
  if (text.length > CATEGORY_MAX_LENGTH) {
    throw new TaskError(`Category must be ${CATEGORY_MAX_LENGTH} characters or fewer.`, 'invalid-category');
  }
  return text;
}

export function validatePriority(raw) {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  if (!PRIORITIES.includes(raw)) throw new TaskError('Please choose High, Medium or Low priority.', 'invalid-priority');
  return raw;
}

export function validateRecurrence(raw) {
  if (raw === undefined || raw === null || raw === '') return 'none';
  if (!RECURRENCES.includes(raw)) throw new TaskError('Please choose a valid repeat option.', 'invalid-recurrence');
  return raw;
}

/** Accepts "" / null / undefined (no due date) or a real "YYYY-MM-DD" date. Returns string or null. */
export function validateDueDate(rawDueDate) {
  if (rawDueDate === undefined || rawDueDate === null || rawDueDate === '') return null;
  if (!isValidDateKey(rawDueDate)) {
    throw new TaskError('Please choose a valid due date.', 'invalid-date');
  }
  return rawDueDate;
}

export function validateSubtaskTitle(raw) {
  if (typeof raw !== 'string') throw new TaskError('Step must be text.', 'invalid-subtask');
  const title = raw.trim();
  if (title.length === 0) throw new TaskError('Please enter a step.', 'invalid-subtask');
  if (title.length > SUBTASK_MAX_LENGTH) {
    throw new TaskError(`A step must be ${SUBTASK_MAX_LENGTH} characters or fewer.`, 'invalid-subtask');
  }
  return title;
}

/** Validates every editable field at once. Returns clean values or throws TaskError. */
export function validateTaskFields(raw = {}) {
  return {
    title: validateTitle(raw.title),
    description: validateDescription(raw.description),
    priority: validatePriority(raw.priority),
    category: validateCategory(raw.category),
    dueDate: validateDueDate(raw.dueDate),
    recurrence: validateRecurrence(raw.recurrence),
  };
}

/* ------------------------------------------------------------------ */
/* Loading (with in-memory upgrade of older tasks)                      */
/* ------------------------------------------------------------------ */

function normalizeSubtask(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null;
  return {
    id: raw.id,
    title: raw.title.trim().slice(0, SUBTASK_MAX_LENGTH),
    completed: raw.completed === true,
  };
}

/** Returns a clean task object (missing new fields get defaults), or null if unusable. */
function normalizeTask(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null;
  if (typeof raw.completed !== 'boolean') return null;
  if (!Number.isFinite(raw.createdAt)) return null;

  const subtasks = Array.isArray(raw.subtasks)
    ? raw.subtasks.map(normalizeSubtask).filter(Boolean).slice(0, MAX_SUBTASKS)
    : [];

  return {
    id: raw.id,
    title: raw.title,
    description: typeof raw.description === 'string' ? raw.description.slice(0, DESCRIPTION_MAX_LENGTH) : '',
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
    category: typeof raw.category === 'string' ? raw.category.trim().slice(0, CATEGORY_MAX_LENGTH) : '',
    recurrence: RECURRENCES.includes(raw.recurrence) ? raw.recurrence : 'none',
    subtasks,
    completed: raw.completed,
    createdAt: raw.createdAt,
    dueDate: isValidDateKey(raw.dueDate) ? raw.dueDate : null,
    completedAt: raw.completed && Number.isFinite(raw.completedAt) ? raw.completedAt : null,
  };
}

/**
 * Reads tasks from storage and validates every item.
 * Returns { tasks, skippedCount }. Unusable or duplicate-id items are skipped, logged, and
 * removed from storage the next time tasks are saved.
 */
export async function loadTasks() {
  const stored = await getValue(STORAGE_KEYS.TASKS);
  const rawList = Array.isArray(stored) ? stored : [];

  const seenIds = new Set();
  const tasks = [];
  let skippedCount = 0;

  for (const raw of rawList) {
    const task = normalizeTask(raw);
    if (task === null || seenIds.has(task.id)) {
      skippedCount += 1;
      console.warn('[FocusFlow] Skipped an invalid or duplicate task:', raw);
      continue;
    }
    seenIds.add(task.id);
    tasks.push(task);
  }

  return { tasks, skippedCount };
}

/* ------------------------------------------------------------------ */
/* Safe read-modify-write                                              */
/* ------------------------------------------------------------------ */

// Mutations run one at a time so two quick clicks cannot overwrite each other.
let writeQueue = Promise.resolve();

function runExclusive(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {}); // a failed operation must not block later ones
  return result;
}

/**
 * Loads the latest tasks, applies `change(tasks)`, saves, and returns the new list.
 * `change` returns a NEW array, or the same array to signal "nothing changed" (no write).
 */
function mutateTasks(change) {
  return runExclusive(async () => {
    const { tasks } = await loadTasks();
    const updated = change(tasks);
    if (updated !== tasks) {
      await setValue(STORAGE_KEYS.TASKS, updated);
    }
    return updated;
  });
}

function requireTask(tasks, id) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new TaskError('That task no longer exists.', 'not-found');
  return task;
}

function requireSubtask(task, subId) {
  const sub = task.subtasks.find((candidate) => candidate.id === subId);
  if (!sub) throw new TaskError('That step no longer exists.', 'not-found');
  return sub;
}

/* ------------------------------------------------------------------ */
/* Public operations (each returns the full updated task list)          */
/* ------------------------------------------------------------------ */

/** fields: { title, description?, priority?, category?, dueDate?, recurrence? } */
export async function addTask(fields = {}) {
  const clean = validateTaskFields(fields);
  const task = {
    id: crypto.randomUUID(),
    ...clean,
    subtasks: [],
    completed: false,
    createdAt: Date.now(),
    completedAt: null,
  };
  return mutateTasks((tasks) => [...tasks, task]);
}

/** Next due date for a repeating task, always AFTER today (so an overdue task does not pile up). */
function nextOccurrenceKey(dueDate, recurrence, today) {
  let next = dueDate || today;
  do {
    if (recurrence === 'daily') next = addDaysToKey(next, 1);
    else if (recurrence === 'weekly') next = addDaysToKey(next, 7);
    else next = addMonthsToKey(next, 1);
  } while (next <= today);
  return next;
}

export async function setTaskCompleted(id, completed) {
  if (typeof completed !== 'boolean') {
    throw new TaskError('Invalid completion value.', 'invalid-input');
  }

  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, id);
    if (existing.completed === completed) return tasks; // already in that state

    const now = Date.now();
    let updated = tasks.map((task) =>
      task.id === id ? { ...task, completed, completedAt: completed ? now : null } : task
    );

    // Completing a repeating task adds the next occurrence (once).
    if (completed && existing.recurrence !== 'none') {
      const nextDue = nextOccurrenceKey(existing.dueDate, existing.recurrence, getLocalDateKey());
      const alreadyExists = updated.some(
        (task) =>
          !task.completed &&
          task.id !== id &&
          task.title === existing.title &&
          task.recurrence === existing.recurrence &&
          task.dueDate === nextDue
      );
      if (!alreadyExists) {
        updated = [
          ...updated,
          {
            ...existing,
            id: crypto.randomUUID(),
            completed: false,
            completedAt: null,
            createdAt: now,
            dueDate: nextDue,
            subtasks: existing.subtasks.map((sub) => ({ ...sub, id: crypto.randomUUID(), completed: false })),
          },
        ];
      }
    }
    return updated;
  });
}

/** Saves all editable fields of one task. fields has the same shape as for addTask. */
export async function updateTask(id, fields) {
  const clean = validateTaskFields(fields);

  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, id);
    const unchanged = Object.keys(clean).every((key) => existing[key] === clean[key]);
    if (unchanged) return tasks; // skip the write

    return tasks.map((task) => (task.id === id ? { ...task, ...clean } : task));
  });
}

/** Kept for compatibility with the Stage 3 API. */
export async function updateTaskTitle(id, rawTitle) {
  const title = validateTitle(rawTitle);
  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, id);
    if (existing.title === title) return tasks;
    return tasks.map((task) => (task.id === id ? { ...task, title } : task));
  });
}

export async function deleteTask(id) {
  return mutateTasks((tasks) => {
    requireTask(tasks, id);
    return tasks.filter((task) => task.id !== id);
  });
}

export async function addSubtask(taskId, rawTitle) {
  const title = validateSubtaskTitle(rawTitle);
  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, taskId);
    if (existing.subtasks.length >= MAX_SUBTASKS) {
      throw new TaskError(`A task can have at most ${MAX_SUBTASKS} steps.`, 'invalid-subtask');
    }
    const sub = { id: crypto.randomUUID(), title, completed: false };
    return tasks.map((task) => (task.id === taskId ? { ...task, subtasks: [...task.subtasks, sub] } : task));
  });
}

export async function setSubtaskCompleted(taskId, subId, completed) {
  if (typeof completed !== 'boolean') throw new TaskError('Invalid completion value.', 'invalid-input');
  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, taskId);
    const sub = requireSubtask(existing, subId);
    if (sub.completed === completed) return tasks;
    return tasks.map((task) =>
      task.id === taskId
        ? { ...task, subtasks: task.subtasks.map((s) => (s.id === subId ? { ...s, completed } : s)) }
        : task
    );
  });
}

export async function deleteSubtask(taskId, subId) {
  return mutateTasks((tasks) => {
    const existing = requireTask(tasks, taskId);
    requireSubtask(existing, subId);
    return tasks.map((task) =>
      task.id === taskId ? { ...task, subtasks: task.subtasks.filter((s) => s.id !== subId) } : task
    );
  });
}

/* ------------------------------------------------------------------ */
/* Pure helpers for display                                            */
/* ------------------------------------------------------------------ */

/** Pending task whose due date is before today. */
export function isOverdue(task, today = getLocalDateKey()) {
  return !task.completed && task.dueDate !== null && task.dueDate < today;
}

/**
 * Deadline status for display.
 * kind: 'none' | 'done' | 'overdue' | 'today' | 'soon' (within UPCOMING_DAYS) | 'later'
 * days: whole days from today to the due date (negative when overdue).
 */
export function getDueStatus(task, today = getLocalDateKey()) {
  if (!task.dueDate) return { kind: 'none', days: 0 };
  const days = daysBetween(today, task.dueDate);
  if (task.completed) return { kind: 'done', days };
  if (days < 0) return { kind: 'overdue', days };
  if (days === 0) return { kind: 'today', days };
  if (days <= UPCOMING_DAYS) return { kind: 'soon', days };
  return { kind: 'later', days };
}

export function filterTasks(tasks, filter, today = getLocalDateKey()) {
  switch (filter) {
    case 'pending':
      return tasks.filter((task) => !task.completed);
    case 'completed':
      return tasks.filter((task) => task.completed);
    case 'overdue':
      return tasks.filter((task) => isOverdue(task, today));
    default:
      return tasks;
  }
}

/** Case-insensitive match on title, description, category and step titles. */
export function searchTasks(tasks, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle === '') return tasks;
  return tasks.filter((task) => {
    const haystack = [task.title, task.description, task.category, ...task.subtasks.map((s) => s.title)]
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** Pending tasks always come before completed ones. Returns a new array. */
export function sortTasks(tasks, sortKey = 'newest') {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    switch (sortKey) {
      case 'oldest':
        return a.createdAt - b.createdAt;
      case 'due':
        if (a.dueDate !== b.dueDate) {
          if (a.dueDate === null) return 1; // no due date goes last
          if (b.dueDate === null) return -1;
          return a.dueDate < b.dueDate ? -1 : 1;
        }
        return b.createdAt - a.createdAt;
      case 'priority': {
        const difference = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        return difference !== 0 ? difference : b.createdAt - a.createdAt;
      }
      default:
        return b.createdAt - a.createdAt;
    }
  });
}

export function countTasks(tasks, today = getLocalDateKey()) {
  const completed = tasks.filter((task) => task.completed).length;
  const overdue = tasks.filter((task) => isOverdue(task, today)).length;
  return { total: tasks.length, completed, pending: tasks.length - completed, overdue };
}

/**
 * Daily progress = completed today / (completed today + pending tasks due today or overdue).
 */
export function getDailyProgress(tasks, today = getLocalDateKey()) {
  let completedToday = 0;
  let remaining = 0;
  for (const task of tasks) {
    if (task.completed) {
      if (Number.isFinite(task.completedAt) && getLocalDateKey(new Date(task.completedAt)) === today) {
        completedToday += 1;
      }
    } else if (task.dueDate !== null && task.dueDate <= today) {
      remaining += 1;
    }
  }
  const target = completedToday + remaining;
  return {
    completedToday,
    remaining,
    target,
    percent: target === 0 ? 0 : Math.round((completedToday / target) * 100),
  };
}

/** Distinct non-empty categories, sorted. Used for autocomplete suggestions. */
export function getCategories(tasks) {
  return [...new Set(tasks.map((task) => task.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}