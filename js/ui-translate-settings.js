// js/ui-translate-settings.js
// "Translation" section inside the Settings panel: floating-button opt-in and privacy consent.
// This is also where the permission prompt is requested (it needs a user click).

import { StorageError } from './storage.js';
import {
  SELECTION_ORIGINS,
  getFloatingStatus,
  loadTranslationPrefs,
  saveTranslationPrefs,
  syncFloatingScript,
} from './translation-prefs.js';

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('tr-float-toggle'),
  status: $('tr-float-status'),
  error: $('tr-float-error'),
  consent: $('tr-consent-status'),
  consentReset: $('tr-consent-reset'),
};

let ctx = { showBanner() {} };
let busy = false;

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

async function render() {
  const status = await getFloatingStatus();
  els.toggle.checked = status.enabled && status.permission && status.registered;
  els.status.textContent = els.toggle.checked
    ? 'On. Pages you already had open need a reload before the button appears there.'
    : 'Off. The right-click menu item works either way.';
  els.consent.textContent = status.privacyAccepted
    ? 'You have accepted the notice that selected text is sent to MyMemory.'
    : 'You will see a notice before your first translation.';
  els.consentReset.hidden = !status.privacyAccepted;
}

async function handleToggle() {
  if (busy) return;
  busy = true;
  els.toggle.disabled = true;
  els.error.hidden = true;
  const wantOn = els.toggle.checked;
  try {
    if (wantOn) {
      // First await in the click handler, so the user gesture is still valid.
      const granted = await chrome.permissions.request({ origins: [...SELECTION_ORIGINS] });
      if (!granted) {
        showError('Site access was not granted, so the floating button stays off.');
      } else {
        await saveTranslationPrefs({ floatingButton: true });
        await syncFloatingScript(await loadTranslationPrefs());
      }
    } else {
      await saveTranslationPrefs({ floatingButton: false });
      await syncFloatingScript(await loadTranslationPrefs());
    }
  } catch (error) {
    if (error instanceof StorageError) {
      ctx.showBanner(`${error.message} Translation settings were not changed.`, 'error');
    } else {
      console.error('[FocusFlow] Floating button setting failed:', error && error.name);
      showError('Could not change this setting. Please try again.');
    }
  } finally {
    busy = false;
    els.toggle.disabled = false;
    try {
      await render();
    } catch {
      /* the next refresh will correct the display */
    }
  }
}

async function handleConsentReset() {
  try {
    await saveTranslationPrefs({ privacyAccepted: false });
    await render();
  } catch (error) {
    ctx.showBanner(error instanceof StorageError ? error.message : 'Could not update this setting.', 'error');
  }
}

/** Re-reads preferences. Also reconciles the content script (this repairs state after "Reset all data"). */
export async function refreshTranslationUI() {
  try {
    await syncFloatingScript(await loadTranslationPrefs());
    await render();
  } catch (error) {
    console.error('[FocusFlow] Translation settings refresh failed:', error && error.name);
    showError('Could not load translation settings.');
  }
}

export async function initTranslationSettingsUI(context) {
  ctx = context;
  els.toggle.addEventListener('change', () => void handleToggle());
  els.consentReset.addEventListener('click', () => void handleConsentReset());
  await refreshTranslationUI();
}