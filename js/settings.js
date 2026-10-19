// js/settings.js
// Loads, validates and saves user settings. No DOM code.
// Owner of the "settings" key: the popup (via this file).

import {
  SCHEMA_VERSION,
  SETTINGS_LIMITS,
  STORAGE_KEYS,
  getValue,
  normalizeSettings,
  setValue,
} from './storage.js';

const THEMES = ['light', 'dark'];

const LABELS = Object.freeze({
  focusMinutes: 'Focus length',
  shortBreakMinutes: 'Short break',
  longBreakMinutes: 'Long break',
  sessionsBeforeLongBreak: 'Sessions before long break',
});

/** Thrown for invalid form input. `problems` is a list of readable messages. */
export class SettingsError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.name = 'SettingsError';
    this.problems = problems;
  }
}

/** Always returns a complete, valid settings object (invalid fields fall back to defaults). */
export async function loadSettings() {
  const stored = await getValue(STORAGE_KEYS.SETTINGS);
  return normalizeSettings(stored).value;
}

/** Validates raw form values (strings or numbers). Returns clean values or throws SettingsError. */
export function validateSettingsInput(input) {
  const problems = [];
  const values = {};

  for (const [field, { min, max }] of Object.entries(SETTINGS_LIMITS)) {
    const text = String(input[field] ?? '').trim();
    const number = Number(text);
    if (!/^\d+$/.test(text) || number < min || number > max) {
      problems.push(`${LABELS[field]} must be a whole number from ${min} to ${max}.`);
    } else {
      values[field] = number;
    }
  }

  if (THEMES.includes(input.theme)) {
    values.theme = input.theme;
  } else {
    problems.push('Theme must be Light or Dark.');
  }

  if (problems.length > 0) throw new SettingsError(problems);
  return values;
}

/** Validates, merges with the current settings and saves. Returns the saved settings. */
export async function saveSettings(input) {
  const values = validateSettingsInput(input);
  const current = await loadSettings();
  const next = { ...current, ...values, schemaVersion: SCHEMA_VERSION };
  await setValue(STORAGE_KEYS.SETTINGS, next);
  return next;
}