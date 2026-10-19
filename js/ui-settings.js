// js/ui-settings.js
// Settings panel: durations, theme, and "reset all data" with a typed confirmation.

import { DEV_MODE } from './config.js';
import { SETTINGS_LIMITS, StorageError } from './storage.js';
import { SettingsError, loadSettings, saveSettings } from './settings.js';

const CONFIRM_WORD = 'DELETE';

const els = {
  form: document.getElementById('settings-form'),
  focus: document.getElementById('set-focus'),
  short: document.getElementById('set-short'),
  long: document.getElementById('set-long'),
  sessions: document.getElementById('set-sessions'),
  theme: document.getElementById('set-theme'),
  save: document.getElementById('settings-save'),
  error: document.getElementById('settings-error'),
  dev: document.getElementById('settings-dev'),
  resetStart: document.getElementById('reset-start'),
  resetConfirm: document.getElementById('reset-confirm'),
  resetInput: document.getElementById('reset-input'),
  resetConfirmButton: document.getElementById('reset-confirm-btn'),
  resetCancel: document.getElementById('reset-cancel'),
};

let ctx = { showBanner() {}, performReset: async () => {} };
let saving = false;
let resetting = false;

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function fillForm(settings) {
  els.focus.value = String(settings.focusMinutes);
  els.short.value = String(settings.shortBreakMinutes);
  els.long.value = String(settings.longBreakMinutes);
  els.sessions.value = String(settings.sessionsBeforeLongBreak);
  els.theme.value = settings.theme;
}

export async function refreshSettingsUI() {
  try {
    const settings = await loadSettings();
    fillForm(settings);
    applyTheme(settings.theme);
    clearError();
  } catch (error) {
    console.error('[FocusFlow] Could not load settings:', error);
    showError(error.message || 'Could not load settings.');
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (saving) return;
  saving = true;
  els.save.disabled = true;
  clearError();

  try {
    const saved = await saveSettings({
      focusMinutes: els.focus.value,
      shortBreakMinutes: els.short.value,
      longBreakMinutes: els.long.value,
      sessionsBeforeLongBreak: els.sessions.value,
      theme: els.theme.value,
    });
    fillForm(saved);
    applyTheme(saved.theme);
    ctx.showBanner('Settings saved. New durations apply to the next session you start.', 'success');
  } catch (error) {
    if (error instanceof SettingsError) {
      showError(error.message);
    } else if (error instanceof StorageError) {
      console.error('[FocusFlow] Storage error:', error.cause ?? error);
      ctx.showBanner(`${error.message} Settings were not changed.`, 'error');
    } else {
      console.error('[FocusFlow] Unexpected settings error:', error);
      ctx.showBanner('Something unexpected went wrong while saving settings.', 'error');
    }
  } finally {
    saving = false;
    els.save.disabled = false;
  }
}

/* ---------- reset all data ---------- */

function hideResetConfirm() {
  els.resetConfirm.hidden = true;
  els.resetInput.value = '';
  els.resetConfirmButton.disabled = true;
  els.resetStart.hidden = false;
}

async function handleResetConfirmed() {
  if (resetting || els.resetInput.value !== CONFIRM_WORD) return;
  resetting = true;
  els.resetConfirmButton.disabled = true;
  try {
    await ctx.performReset();
    hideResetConfirm();
    ctx.showBanner('All FocusFlow data was deleted and defaults were restored.', 'success');
  } catch (error) {
    console.error('[FocusFlow] Reset failed:', error);
    ctx.showBanner(
      error instanceof StorageError ? `${error.message} Some data may still be stored.` : 'Reset failed. Please try again.',
      'error'
    );
    els.resetConfirmButton.disabled = els.resetInput.value !== CONFIRM_WORD;
  } finally {
    resetting = false;
  }
}

export async function initSettingsUI(context) {
  ctx = context;

  const inputs = {
    focusMinutes: els.focus,
    shortBreakMinutes: els.short,
    longBreakMinutes: els.long,
    sessionsBeforeLongBreak: els.sessions,
  };
  for (const [field, input] of Object.entries(inputs)) {
    input.min = String(SETTINGS_LIMITS[field].min);
    input.max = String(SETTINGS_LIMITS[field].max);
    input.step = '1';
  }

  els.dev.hidden = !DEV_MODE;
  els.form.addEventListener('submit', handleSubmit);

  els.resetStart.addEventListener('click', () => {
    els.resetStart.hidden = true;
    els.resetConfirm.hidden = false;
    els.resetInput.value = '';
    els.resetConfirmButton.disabled = true;
    els.resetInput.focus();
  });
  els.resetInput.addEventListener('input', () => {
    els.resetConfirmButton.disabled = els.resetInput.value !== CONFIRM_WORD;
  });
  els.resetInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleResetConfirmed();
    }
  });
  els.resetConfirmButton.addEventListener('click', () => void handleResetConfirmed());
  els.resetCancel.addEventListener('click', () => {
    hideResetConfirm();
    els.resetStart.focus();
  });

  await refreshSettingsUI();
}