// js/translation-prefs.js
// Translation preferences and the opt-in floating-button content script. NO DOM code, so the
// service worker can import it.

import { STORAGE_KEYS, getValue, normalizeTranslation, setValue } from './storage.js';

export const CONTENT_SCRIPT_ID = 'focusflow-translate';
export const SELECTION_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);
const CONTENT_SCRIPT_FILES = ['js/content-translate.js', 'js/content-selection.js'];

/** Always returns a complete, valid object. */
export async function loadTranslationPrefs() {
  return normalizeTranslation(await getValue(STORAGE_KEYS.TRANSLATION)).value;
}

let writeQueue = Promise.resolve();

/** Merges `changes` (booleans only) into the latest stored preferences. Returns the saved object. */
export function saveTranslationPrefs(changes) {
  const run = writeQueue.then(async () => {
    const clean = {};
    for (const field of ['privacyAccepted', 'floatingButton']) {
      if (field in changes) {
        if (typeof changes[field] !== 'boolean') throw new Error(`Invalid value for ${field}.`);
        clean[field] = changes[field];
      }
    }
    const next = { ...(await loadTranslationPrefs()), ...clean };
    await setValue(STORAGE_KEYS.TRANSLATION, next);
    return next;
  });
  writeQueue = run.catch(() => {});
  return run;
}

async function hasSelectionAccess() {
  return chrome.permissions.contains({ origins: [...SELECTION_ORIGINS] });
}

async function isScriptRegistered() {
  const list = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  return list.length > 0;
}

async function unregisterScript() {
  if (await isScriptRegistered()) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
}

/**
 * Makes the registered content script match the preferences. Idempotent, so it is safe to call
 * from both the popup and the service worker:
 *  - off                       -> unregisters the script and gives the site access back
 *  - on but access was revoked -> unregisters the script and switches the preference off
 *  - on with access            -> registers the script if it is missing
 * Returns { active, reason? }.
 */
export async function syncFloatingScript(prefs) {
  if (!prefs.floatingButton) {
    await unregisterScript();
    if (await hasSelectionAccess()) await chrome.permissions.remove({ origins: [...SELECTION_ORIGINS] });
    return { active: false };
  }

  if (!(await hasSelectionAccess())) {
    await unregisterScript();
    await saveTranslationPrefs({ floatingButton: false });
    return { active: false, reason: 'permission-missing' };
  }

  if (!(await isScriptRegistered())) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          matches: [...SELECTION_ORIGINS],
          js: CONTENT_SCRIPT_FILES,
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } catch (error) {
      // The popup and the service worker can race; a duplicate id means it is already registered.
      if (!/duplicate/i.test(String((error && error.message) || error))) throw error;
    }
  }
  return { active: true };
}

/** For the Settings UI. */
export async function getFloatingStatus() {
  const prefs = await loadTranslationPrefs();
  const [permission, registered] = await Promise.all([hasSelectionAccess(), isScriptRegistered()]);
  return { enabled: prefs.floatingButton, permission, registered, privacyAccepted: prefs.privacyAccepted };
}