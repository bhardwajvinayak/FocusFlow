// js/config.js
// Shared constants. Imported by the popup AND the service worker.

// DEVELOPMENT MODE: set to true to test the timer quickly, then set back to false.
// When true, session lengths come from DEV_DURATIONS_SECONDS and ignore the Settings values.
// When false, focus sessions recorded in dev mode are hidden from statistics.
export const DEV_MODE = false;

// 40 s focus on purpose: Chrome may enforce a ~30 s minimum alarm delay, so a 40 s session
// lets you test the background (popup closed) completion path reliably.
export const DEV_DURATIONS_SECONDS = Object.freeze({
  focus: 40,
  shortBreak: 20,
  longBreak: 30,
});

export const TIMER_ALARM_NAME = 'focusflow-timer';

// Screen-break reminders (Eye comfort).
export const BREAK_ALARM_NAME = 'focusflow-break-reminder';

// In DEV_MODE the reminder repeats this often (minutes) so it can be tested quickly.
export const DEV_REMINDER_MINUTES = 1;

// Translation (context menu).
export const TRANSLATE_MENU_ID = 'focusflow-translate-hi';
export const TRANSLATE_MENU_TITLE = 'Translate to Hindi';