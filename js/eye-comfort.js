// js/eye-comfort.js
// Eye-comfort preferences and screen-break reminders. NO DOM code, so the service worker
// can import this file.
//
// Owner of the "eyeComfort" key: the popup. The service worker only READS it.

import {
  EYE_COMFORT_LIMITS,
  REMINDER_INTERVALS,
  STORAGE_KEYS,
  getValue,
  normalizeEyeComfort,
  setValue,
} from './storage.js';
import { BREAK_ALARM_NAME, DEV_MODE, DEV_REMINDER_MINUTES } from './config.js';

export const BREAK_BADGE_TEXT = 'BREAK';

/** Invalid form input. `problems` is a list of readable messages. */
export class EyeSettingsError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.name = 'EyeSettingsError';
    this.problems = problems;
  }
}

/** The reminder alarm could not be created, read or cleared. */
export class ReminderAlarmError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ReminderAlarmError';
    this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

/** Always returns a complete, valid object (invalid fields fall back to defaults). */
export async function loadEyeComfort() {
  const stored = await getValue(STORAGE_KEYS.EYE_COMFORT);
  return normalizeEyeComfort(stored).value;
}

/** Validates only the fields present in `changes`. Returns clean values or throws EyeSettingsError. */
export function validateEyeComfortChanges(changes = {}) {
  const clean = {};
  const problems = [];

  if ('filterIntensity' in changes) {
    const { min, max } = EYE_COMFORT_LIMITS.filterIntensity;
    const number = Number(changes.filterIntensity);
    if (!Number.isInteger(number) || number < min || number > max) {
      problems.push(`Filter strength must be a whole number from ${min} to ${max}.`);
    } else {
      clean.filterIntensity = number;
    }
  }

  if ('remindersEnabled' in changes) {
    if (typeof changes.remindersEnabled !== 'boolean') {
      problems.push('Reminders must be switched on or off.');
    } else {
      clean.remindersEnabled = changes.remindersEnabled;
    }
  }

  if ('reminderIntervalMinutes' in changes) {
    const number = Number(changes.reminderIntervalMinutes);
    if (!REMINDER_INTERVALS.includes(number)) {
      problems.push(`Reminder interval must be one of: ${REMINDER_INTERVALS.join(', ')} minutes.`);
    } else {
      clean.reminderIntervalMinutes = number;
    }
  }

  if (problems.length > 0) throw new EyeSettingsError(problems);
  return clean;
}

// Saves run one at a time so quick changes cannot overwrite each other.
let writeQueue = Promise.resolve();

/** Validates `changes`, merges them with the latest stored values and saves. Returns the saved object. */
export async function saveEyeComfort(changes) {
  const clean = validateEyeComfortChanges(changes);
  const run = writeQueue.then(async () => {
    const current = await loadEyeComfort();
    const next = { ...current, ...clean };
    await setValue(STORAGE_KEYS.EYE_COMFORT, next);
    return next;
  });
  writeQueue = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* Reminder alarm                                                      */
/* ------------------------------------------------------------------ */

/** The real repeat interval. Development mode shortens it so it can be tested. */
export function getEffectiveReminderMinutes(intervalMinutes) {
  return DEV_MODE ? DEV_REMINDER_MINUTES : intervalMinutes;
}

export async function getReminderAlarm() {
  try {
    return (await chrome.alarms.get(BREAK_ALARM_NAME)) || null;
  } catch (error) {
    console.warn('[FocusFlow] Could not read the reminder alarm.', error);
    return null;
  }
}

/**
 * Makes the alarm match the preferences, without creating duplicates:
 *  - disabled                      -> clears the alarm
 *  - enabled, same interval exists -> leaves it alone (the countdown is NOT reset)
 *  - enabled, otherwise            -> creates it (same name replaces any old alarm)
 * Safe to call from the popup and from the service worker.
 */
export async function syncReminderAlarm(prefs) {
  try {
    if (!prefs.remindersEnabled) {
      await chrome.alarms.clear(BREAK_ALARM_NAME);
      return { scheduled: false };
    }

    const period = getEffectiveReminderMinutes(prefs.reminderIntervalMinutes);
    const existing = await chrome.alarms.get(BREAK_ALARM_NAME);
    if (existing && existing.periodInMinutes === period) {
      return { scheduled: true, nextAt: existing.scheduledTime };
    }

    await chrome.alarms.create(BREAK_ALARM_NAME, { delayInMinutes: period, periodInMinutes: period });
    const created = await chrome.alarms.get(BREAK_ALARM_NAME);
    return { scheduled: true, nextAt: created ? created.scheduledTime : null };
  } catch (error) {
    throw new ReminderAlarmError('Could not schedule the screen-break reminder.', error);
  }
}

/** Service worker: after install, update or browser start, make sure the alarm is correct. */
export async function recoverReminders() {
  return syncReminderAlarm(await loadEyeComfort());
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

async function showBreakBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: '#8a4b00' });
  await chrome.action.setBadgeText({ text: BREAK_BADGE_TEXT });
}

/** Service worker: the alarm fired. A stale alarm (reminders now off) cleans itself up. */
export async function handleBreakAlarm() {
  const prefs = await loadEyeComfort();
  if (!prefs.remindersEnabled) {
    await chrome.alarms.clear(BREAK_ALARM_NAME);
    return { shown: false };
  }
  await showBreakBadge();
  return { shown: true };
}

/** Popup: if a reminder badge is waiting, clears it and returns true. */
export async function consumeBreakBadge() {
  const text = await chrome.action.getBadgeText({});
  if (text !== BREAK_BADGE_TEXT) return false;
  await chrome.action.setBadgeText({ text: '' });
  return true;
}