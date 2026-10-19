// js/storage.js
// Persistence layer. Every read and write of chrome.storage.local goes through this file.
// It owns: storage keys, default values, validation, repair, and the local-date helper.

/** Error type so the UI can tell storage failures apart from other bugs. */
export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

export const STORAGE_KEYS = Object.freeze({
  TASKS: 'tasks',
  NOTES: 'notes',
  TIMER_STATE: 'timerState',
  DAILY_STATS: 'dailyStats',
  SETTINGS: 'settings',
  EYE_COMFORT: 'eyeComfort',
});
const ALL_KEYS = Object.values(STORAGE_KEYS);

export const SCHEMA_VERSION = 1;

/** Allowed whole-number ranges for numeric settings (shared by storage and the Settings form). */
export const SETTINGS_LIMITS = Object.freeze({
  focusMinutes: Object.freeze({ min: 1, max: 180 }),
  shortBreakMinutes: Object.freeze({ min: 1, max: 60 }),
  longBreakMinutes: Object.freeze({ min: 1, max: 120 }),
  sessionsBeforeLongBreak: Object.freeze({ min: 2, max: 12 }),
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  theme: 'light',
});

export const DEFAULT_TIMER_STATE = Object.freeze({
  status: 'idle',            // 'idle' | 'running' | 'paused'
  mode: 'focus',             // 'focus' | 'shortBreak' | 'longBreak'
  sessionId: null,           // set when a session starts; used to prevent double counting
  durationSeconds: DEFAULT_SETTINGS.focusMinutes * 60,
  endTime: null,             // epoch ms; only set while running
  remainingSeconds: null,    // integer; only set while paused
  cycleFocusCount: 0,        // focus sessions completed in the current long-break cycle
  lastCompletedSessionId: null,
});

/** Allowed range for the warm-filter strength (percent). */
export const EYE_COMFORT_LIMITS = Object.freeze({
  filterIntensity: Object.freeze({ min: 10, max: 60 }),
});

/** Screen-break reminder intervals offered in the UI (minutes). */
export const REMINDER_INTERVALS = Object.freeze([20, 30, 45, 60]);

export const DEFAULT_EYE_COMFORT = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  filterIntensity: 30, // percent. Whether the filter is ON is per-page state and is NOT stored.
  remindersEnabled: false,
  reminderIntervalMinutes: 20,
});

const TIMER_STATUSES = ['idle', 'running', 'paused'];
const TIMER_MODES = ['focus', 'shortBreak', 'longBreak'];
const THEMES = ['light', 'dark'];

/** Returns a fresh default value (never a shared object) for a storage key. */
export function getDefaultValue(key) {
  switch (key) {
    case STORAGE_KEYS.TASKS:
    case STORAGE_KEYS.NOTES:
      return [];
    case STORAGE_KEYS.DAILY_STATS:
      return {};
    case STORAGE_KEYS.SETTINGS:
      return { ...DEFAULT_SETTINGS };
    case STORAGE_KEYS.TIMER_STATE:
      return { ...DEFAULT_TIMER_STATE };
    case STORAGE_KEYS.EYE_COMFORT:
      return { ...DEFAULT_EYE_COMFORT };
    default:
      throw new Error(`Unknown storage key: ${key}`);
  }
}

/**
 * Returns the local calendar day as "YYYY-MM-DD".
 * The whole app uses this one helper so everyone agrees on what "today" means.
 */
export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isWithinLimits(field, value) {
  const { min, max } = SETTINGS_LIMITS[field];
  return isIntInRange(value, min, max);
}

function isStringOrNull(value) {
  return value === null || typeof value === 'string';
}

/**
 * Migration hook. Version 1 is the first schema, so nothing needs converting yet.
 * When the schema changes, convert old shapes here, e.g.:
 *   if (raw.schemaVersion === 1) raw = { ...raw, newField: 'default', schemaVersion: 2 };
 */
function migrateSettings(raw) {
  return raw;
}

/**
 * Merges stored settings with defaults, field by field.
 * Any missing, invalid or outdated field falls back to its default.
 * Returns { value, repaired }.
 */
export function normalizeSettings(rawInput) {
  if (!isPlainObject(rawInput)) {
    return { value: getDefaultValue(STORAGE_KEYS.SETTINGS), repaired: true };
  }

  const raw = migrateSettings(rawInput);
  const defaults = DEFAULT_SETTINGS;
  const value = {
    schemaVersion: SCHEMA_VERSION,
    focusMinutes: isWithinLimits('focusMinutes', raw.focusMinutes) ? raw.focusMinutes : defaults.focusMinutes,
    shortBreakMinutes: isWithinLimits('shortBreakMinutes', raw.shortBreakMinutes)
      ? raw.shortBreakMinutes
      : defaults.shortBreakMinutes,
    longBreakMinutes: isWithinLimits('longBreakMinutes', raw.longBreakMinutes)
      ? raw.longBreakMinutes
      : defaults.longBreakMinutes,
    sessionsBeforeLongBreak: isWithinLimits('sessionsBeforeLongBreak', raw.sessionsBeforeLongBreak)
      ? raw.sessionsBeforeLongBreak
      : defaults.sessionsBeforeLongBreak,
    theme: THEMES.includes(raw.theme) ? raw.theme : defaults.theme,
  };

  const repaired = Object.keys(value).some((field) => value[field] !== rawInput[field]);
  return { value, repaired };
}
/** Merges stored eye-comfort preferences with defaults, field by field. Returns { value, repaired }. */
export function normalizeEyeComfort(raw) {
  if (!isPlainObject(raw)) {
    return { value: { ...DEFAULT_EYE_COMFORT }, repaired: true };
  }

  const defaults = DEFAULT_EYE_COMFORT;
  const { min, max } = EYE_COMFORT_LIMITS.filterIntensity;
  const value = {
    schemaVersion: SCHEMA_VERSION,
    filterIntensity: isIntInRange(raw.filterIntensity, min, max) ? raw.filterIntensity : defaults.filterIntensity,
    remindersEnabled: typeof raw.remindersEnabled === 'boolean' ? raw.remindersEnabled : defaults.remindersEnabled,
    reminderIntervalMinutes: REMINDER_INTERVALS.includes(raw.reminderIntervalMinutes)
      ? raw.reminderIntervalMinutes
      : defaults.reminderIntervalMinutes,
  };

  const repaired = Object.keys(value).some((field) => value[field] !== raw[field]);
  return { value, repaired };
}
/** Checks that timerState is internally consistent (status matches which fields are set). */
export function isValidTimerState(raw) {
  if (!isPlainObject(raw)) return false;
  if (!TIMER_STATUSES.includes(raw.status)) return false;
  if (!TIMER_MODES.includes(raw.mode)) return false;
  if (!Number.isInteger(raw.durationSeconds) || raw.durationSeconds <= 0) return false;
  if (!Number.isInteger(raw.cycleFocusCount) || raw.cycleFocusCount < 0) return false;
  if (!isStringOrNull(raw.sessionId) || !isStringOrNull(raw.lastCompletedSessionId)) return false;

  switch (raw.status) {
    case 'running':
      return Number.isFinite(raw.endTime) && raw.remainingSeconds === null;
    case 'paused':
      return Number.isInteger(raw.remainingSeconds) && raw.remainingSeconds >= 0 && raw.endTime === null;
    default: // idle
      return raw.endTime === null && raw.remainingSeconds === null;
  }
}

/**
 * Inspects one stored value.
 * outcome: 'ok' (keep), 'created' (was missing), 'repaired' (was invalid or outdated).
 */
function checkKey(key, raw) {
  if (raw === undefined) {
    return { value: getDefaultValue(key), outcome: 'created' };
  }

  switch (key) {
    case STORAGE_KEYS.SETTINGS: {
      const { value, repaired } = normalizeSettings(raw);
      return { value, outcome: repaired ? 'repaired' : 'ok' };
    }
    case STORAGE_KEYS.TIMER_STATE:
      return isValidTimerState(raw)
        ? { value: raw, outcome: 'ok' }
        : { value: getDefaultValue(key), outcome: 'repaired' };
    case STORAGE_KEYS.TASKS:
    case STORAGE_KEYS.NOTES:
      // Individual items get validated by their own modules (tasks.js, notes.js).
      return Array.isArray(raw)
        ? { value: raw, outcome: 'ok' }
        : { value: getDefaultValue(key), outcome: 'repaired' };
    case STORAGE_KEYS.EYE_COMFORT: {
      const { value, repaired } = normalizeEyeComfort(raw);
      return { value, outcome: repaired ? 'repaired' : 'ok' };
    }
    case STORAGE_KEYS.DAILY_STATS:
      // Individual sessions get validated by statistics.js.
      return isPlainObject(raw)
        ? { value: raw, outcome: 'ok' }
        : { value: getDefaultValue(key), outcome: 'repaired' };
    default:
      throw new Error(`Unknown storage key: ${key}`);
  }
}

/* ------------------------------------------------------------------ */
/* Safe read / write                                                   */
/* ------------------------------------------------------------------ */

function assertKnownKey(key) {
  if (!ALL_KEYS.includes(key)) {
    throw new Error(`Unknown storage key: ${key}`);
  }
}

async function readKeys(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    throw new StorageError('Could not read your saved data.', error);
  }
}

async function writeKeys(items) {
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    throw new StorageError('Could not save your changes.', error);
  }
}

/** Reads one key. Returns the default value if it has never been saved (does not write). */
export async function getValue(key) {
  assertKnownKey(key);
  const result = await readKeys(key);
  return result[key] === undefined ? getDefaultValue(key) : result[key];
}

/** Writes one key. Only that key is touched, so unrelated keys are never overwritten. */
export async function setValue(key, value) {
  assertKnownKey(key);
  await writeKeys({ [key]: value });
}

/* ------------------------------------------------------------------ */
/* Initialization and reset                                            */
/* ------------------------------------------------------------------ */

/**
 * Makes sure all five keys exist and are valid.
 * - Missing keys are created with defaults.
 * - Invalid keys are repaired (reset to defaults) and reported in `warnings`.
 * - Valid keys are never rewritten.
 *
 * Safe to call from both the popup and the service worker.
 * Returns: { state, createdKeys, repairedKeys, warnings }
 */
export async function initializeStorage() {
  const stored = await readKeys(ALL_KEYS);

  const state = {};
  const toWrite = {};
  const createdKeys = [];
  const repairedKeys = [];
  const warnings = [];

  for (const key of ALL_KEYS) {
    const { value, outcome } = checkKey(key, stored[key]);
    state[key] = value;

    if (outcome === 'created') {
      toWrite[key] = value;
      createdKeys.push(key);
    } else if (outcome === 'repaired') {
      toWrite[key] = value;
      repairedKeys.push(key);
      warnings.push(`Saved "${key}" data was invalid or outdated and has been repaired.`);
      // Keep the original in the console so nothing is lost silently.
      console.warn(`[FocusFlow] Repaired "${key}". Original value:`, stored[key]);
    }
  }

  if (Object.keys(toWrite).length > 0) {
    await writeKeys(toWrite);
  }

  return { state, createdKeys, repairedKeys, warnings };
}

/**
 * Deletes EVERYTHING this extension stored, then recreates defaults.
 * Call it through resetAllAppData() in timer.js, which also clears the alarm under the timer lock.
 */
export async function resetAllData() {
  try {
    await chrome.storage.local.clear();
  } catch (error) {
    throw new StorageError('Could not delete your data.', error);
  }
  return initializeStorage();
}