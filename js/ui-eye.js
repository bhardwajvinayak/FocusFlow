// js/ui-eye.js
// Eyes tab UI: warm filter, reading colours and screen-break reminders.
// The page is NOT touched until the Eyes tab is opened (read-only status check) or a control is used.

import { DEV_MODE, DEV_REMINDER_MINUTES } from './config.js';
import { EYE_COMFORT_LIMITS, REMINDER_INTERVALS, StorageError } from './storage.js';
import {
  EyeSettingsError,
  ReminderAlarmError,
  consumeBreakBadge,
  getEffectiveReminderMinutes,
  getReminderAlarm,
  loadEyeComfort,
  saveEyeComfort,
  syncReminderAlarm,
} from './eye-comfort.js';
import { EyePageError, changePage, readPage } from './eye-page.js';

const $ = (id) => document.getElementById(id);

const els = {
  panel: $('panel-eye'),
  pageStatus: $('eye-page-status'),
  pageError: $('eye-page-error'),
  filterToggle: $('eye-filter-toggle'),
  filterIntensity: $('eye-filter-intensity'),
  filterValue: $('eye-filter-value'),
  filterRemove: $('eye-filter-remove'),
  readingToggle: $('eye-reading-toggle'),
  readingMessage: $('eye-reading-message'),
  reminderToggle: $('eye-reminder-toggle'),
  reminderInterval: $('eye-reminder-interval'),
  reminderStatus: $('eye-reminder-status'),
  reminderError: $('eye-reminder-error'),
  dev: $('eye-dev'),
};

const READING_MESSAGES = {
  'dark-page': 'This page already uses a dark background, so reading colours were not applied.',
  'no-body': 'This page has no standard body element, so reading colours were not applied.',
};

let ctx = { showBanner() {} };
let settings = null;      // saved preferences
let pageState = null;     // last known state of the current tab (null = unknown)
let pageReady = false;    // true when the current tab can be changed
let sliderTimer = null;

/* ================================================================== */
/* Page controls                                                       */
/* ================================================================== */

function showPageError(message) {
  els.pageError.textContent = message;
  els.pageError.hidden = false;
}

function clearPageError() {
  els.pageError.hidden = true;
  els.pageError.textContent = '';
}

function renderIntensity() {
  els.filterValue.textContent = `${els.filterIntensity.value}%`;
}

function renderPage() {
  const active = pageReady && pageState !== null;
  els.filterToggle.disabled = !active;
  els.readingToggle.disabled = !active;
  els.filterRemove.disabled = !(active && pageState.filterActive);
  els.filterToggle.checked = active && pageState.filterActive;
  els.readingToggle.checked = active && pageState.readingActive;
}

function applyPageState(state) {
  pageState = state;
  pageReady = true;
  clearPageError();
  els.pageStatus.textContent = state.hostname ? `Current page: ${state.hostname}` : 'Current page is ready.';
  renderPage();
}

function handlePageError(error) {
  pageState = null;
  pageReady = false;
  els.pageStatus.textContent = 'This page cannot be changed.';
  if (error instanceof EyePageError) {
    showPageError(error.message);
  } else {
    console.error('[FocusFlow] Eye comfort error:', error);
    showPageError('Something unexpected went wrong while changing the page.');
  }
  renderPage();
}

/** Sends a change to the current tab. Returns the new state, or null if it failed. */
async function sendToPage(config) {
  try {
    const state = await changePage(config);
    applyPageState(state);
    return state;
  } catch (error) {
    handlePageError(error);
    return null;
  }
}

async function refreshPageState() {
  els.pageStatus.textContent = 'Checking the current page\u2026';
  try {
    const state = await readPage();
    applyPageState(state);
    if (state.filterActive && state.intensity !== null) {
      els.filterIntensity.value = String(state.intensity);
      renderIntensity();
    }
  } catch (error) {
    handlePageError(error);
  }
}

async function handleFilterToggle() {
  await sendToPage({ filter: { on: els.filterToggle.checked, intensity: Number(els.filterIntensity.value) } });
}

async function handleRemoveFilter() {
  await sendToPage({ filter: { on: false } });
  els.filterToggle.focus(); // the Remove button disables itself, so keep keyboard focus nearby
}

async function handleReadingToggle() {
  const on = els.readingToggle.checked;
  els.readingMessage.textContent = '';
  const state = await sendToPage({ reading: { on } });
  if (state && on && state.readingSkipped) {
    els.readingMessage.textContent =
      READING_MESSAGES[state.readingSkipped] || 'Reading colours were not applied.';
  }
}

function handleSliderInput() {
  renderIntensity();
  if (!pageState || !pageState.filterActive) return;
  // Live preview while dragging, but not on every single pixel of movement.
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => {
    void sendToPage({ filter: { on: true, intensity: Number(els.filterIntensity.value) } });
  }, 100);
}

async function handleSliderChange() {
  try {
    settings = await saveEyeComfort({ filterIntensity: els.filterIntensity.value });
  } catch (error) {
    reportSettingsError(error);
  }
}

/* ================================================================== */
/* Reminders                                                           */
/* ================================================================== */

function showReminderError(message) {
  els.reminderError.textContent = message;
  els.reminderError.hidden = false;
}

function reportSettingsError(error) {
  if (error instanceof EyeSettingsError) {
    showReminderError(error.message);
  } else if (error instanceof ReminderAlarmError) {
    console.error('[FocusFlow] Reminder alarm error:', error.cause ?? error);
    showReminderError(`${error.message} It will be retried the next time FocusFlow opens.`);
  } else if (error instanceof StorageError) {
    console.error('[FocusFlow] Storage error:', error.cause ?? error);
    ctx.showBanner(`${error.message} Your eye comfort settings were not changed.`, 'error');
  } else {
    console.error('[FocusFlow] Unexpected eye comfort settings error:', error);
    ctx.showBanner('Something unexpected went wrong while saving eye comfort settings.', 'error');
  }
}

async function renderReminders() {
  els.reminderToggle.checked = settings.remindersEnabled;
  els.reminderInterval.value = String(settings.reminderIntervalMinutes);

  if (!settings.remindersEnabled) {
    els.reminderStatus.textContent = 'Reminders are off.';
    return;
  }
  const minutes = getEffectiveReminderMinutes(settings.reminderIntervalMinutes);
  const alarm = await getReminderAlarm();
  const every = `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  els.reminderStatus.textContent = alarm
    ? `Next reminder around ${new Date(alarm.scheduledTime).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })}, then ${every}.`
    : `Reminders are on (${every}) but are not scheduled yet.`;
}

async function handleReminderChange() {
  els.reminderError.hidden = true;
  try {
    settings = await saveEyeComfort({
      remindersEnabled: els.reminderToggle.checked,
      reminderIntervalMinutes: els.reminderInterval.value,
    });
    await syncReminderAlarm(settings);
  } catch (error) {
    reportSettingsError(error);
    try {
      settings = await loadEyeComfort(); // show what is really saved
    } catch {
      /* keep the last known settings */
    }
  }
  await renderReminders();
}

/* ================================================================== */
/* Public API                                                          */
/* ================================================================== */

async function loadAndRender() {
  settings = await loadEyeComfort();
  els.filterIntensity.value = String(settings.filterIntensity);
  renderIntensity();
  els.reminderError.hidden = true;
  try {
    await syncReminderAlarm(settings); // restores a lost alarm; never creates duplicates
  } catch (error) {
    reportSettingsError(error);
  }
  await renderReminders();
}

/** Reloads preferences; if the Eyes tab is visible, also re-checks the current page. */
export async function refreshEyeUI() {
  try {
    await loadAndRender();
  } catch (error) {
    reportSettingsError(error);
  }
  if (!els.panel.hidden) await refreshPageState();
}

export async function initEyeUI(context) {
  ctx = context;

  const { min, max } = EYE_COMFORT_LIMITS.filterIntensity;
  els.filterIntensity.min = String(min);
  els.filterIntensity.max = String(max);
  els.filterIntensity.step = '5';

  els.reminderInterval.replaceChildren(
    ...REMINDER_INTERVALS.map((minutes) => {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = `${minutes} minutes`;
      return option;
    })
  );

  els.dev.hidden = !DEV_MODE;
  if (DEV_MODE) {
    els.dev.textContent =
      `Development mode is ON: reminders repeat every ${DEV_REMINDER_MINUTES} minute(s), ` +
      'whatever interval you choose. Set DEV_MODE to false in js/config.js for normal use.';
  }

  els.filterToggle.addEventListener('change', () => void handleFilterToggle());
  els.filterRemove.addEventListener('click', () => void handleRemoveFilter());
  els.filterIntensity.addEventListener('input', handleSliderInput);
  els.filterIntensity.addEventListener('change', () => void handleSliderChange());
  els.readingToggle.addEventListener('change', () => void handleReadingToggle());
  els.reminderToggle.addEventListener('change', () => void handleReminderChange());
  els.reminderInterval.addEventListener('change', () => void handleReminderChange());

  await loadAndRender();

  // A reminder fired while the popup was closed: show it here and clear the badge.
  try {
    if (await consumeBreakBadge()) {
      ctx.showBanner(
        'Time for a screen break. Look away from the screen for a minute, stretch, or look at something far away. ' +
          'This is a timed reminder, not a measurement of your screen time.',
        'info'
      );
    }
  } catch (error) {
    console.warn('[FocusFlow] Could not check the reminder badge.', error);
  }
}