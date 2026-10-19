// service-worker.js
// Background layer (Manifest V3). It can be suspended at any time, so it never relies on
// in-memory variables: every handler re-reads state from chrome.storage.local.
// All listeners are registered at the top level, synchronously, so Chrome can wake this
// worker for the right event.

import { initializeStorage } from './js/storage.js';
import { recoverTimer } from './js/timer.js';
import { handleBreakAlarm, recoverReminders } from './js/eye-comfort.js';
import { BREAK_ALARM_NAME, TIMER_ALARM_NAME } from './js/config.js';import { TRANSLATE_MENU_ID, TRANSLATE_MENU_TITLE } from './js/config.js';
import { PRIVACY_NOTICE, TranslationError, translateText, validateSelection } from './js/translation-service.js';
import {
  SELECTION_ORIGINS,
  loadTranslationPrefs,
  saveTranslationPrefs,
  syncFloatingScript,
} from './js/translation-prefs.js';

/** Install/update and browser startup: make sure storage is valid, the timer is consistent and reminders are scheduled. */
async function recoverOnLifecycleEvent(reason) {
  try {
    const { createdKeys, repairedKeys } = await initializeStorage();
    const result = await recoverTimer({ notify: true });
    console.log(`[FocusFlow] Recovery after ${reason}.`, {
      createdKeys,
      repairedKeys,
      timerStatus: result.state.status,
      completedWhileAway: result.completed,
    });
  } catch (error) {
    console.error(`[FocusFlow] Recovery after ${reason} failed:`, error);
  }

  // Separate step so a timer problem can never stop reminders from being restored.
  try {
    const reminders = await recoverReminders();
    console.log(`[FocusFlow] Break reminders after ${reason}.`, reminders);
  } catch (error) {
    console.error(`[FocusFlow] Break reminder recovery after ${reason} failed:`, error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void recoverOnLifecycleEvent('install or update');
});

chrome.runtime.onStartup.addListener(() => {
  void recoverOnLifecycleEvent('browser startup');
});

// Alarms are only WAKE-UP calls. The timer's real timing comes from its saved endTime.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TIMER_ALARM_NAME) {
    recoverTimer({ notify: true })
      .then((result) => {
        console.log('[FocusFlow] Alarm handled.', {
          completed: result.completed,
          sessionRecorded: result.sessionRecorded ?? false,
          timerStatus: result.state.status,
        });
      })
      .catch((error) => {
        console.error('[FocusFlow] Alarm handling failed:', error);
      });
  } else if (alarm.name === BREAK_ALARM_NAME) {
    handleBreakAlarm()
      .then((result) => {
        console.log('[FocusFlow] Break reminder handled.', result);
      })
      .catch((error) => {
        console.error('[FocusFlow] Break reminder failed:', error);
      });
  }
});

/* ================================================================== */
/* Phase 3: translation (context menu, message handling, opt-in script) */
/* ================================================================== */

function createTranslateMenu() {
  // removeAll first, so a reload or update can never leave a duplicate or throw "duplicate id".
  chrome.contextMenus
    .removeAll()
    .then(() => {
      chrome.contextMenus.create(
        { id: TRANSLATE_MENU_ID, title: TRANSLATE_MENU_TITLE, contexts: ['selection'] },
        () => {
          if (chrome.runtime.lastError) {
            console.error('[FocusFlow] Could not create the translate menu:', chrome.runtime.lastError.message);
          }
        }
      );
    })
    .catch((error) => console.error('[FocusFlow] Could not reset context menus:', error));
}

async function reconcileTranslation(reason) {
  try {
    const result = await syncFloatingScript(await loadTranslationPrefs());
    console.log(`[FocusFlow] Translation script after ${reason}.`, result);
  } catch (error) {
    console.error(`[FocusFlow] Translation script sync after ${reason} failed:`, error && error.name);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  createTranslateMenu();
  void reconcileTranslation('install or update');
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileTranslation('browser startup');
});

/** Restricted pages (chrome://, Web Store...) cannot be scripted. A per-tab badge explains why. */
async function signalUnsupportedPage(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8a4b00' });
    await chrome.action.setBadgeText({ tabId, text: 'N/A' });
    await chrome.action.setTitle({
      tabId,
      title: 'FocusFlow cannot translate on this page. Chrome does not allow extensions to run here.',
    });
  } catch {
    /* the tab may be gone */
  }
}

async function handleMenuClick(info, tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ['js/content-translate.js'],
    });
    await chrome.tabs.sendMessage(
      tab.id,
      { type: 'ff-open-panel', text: typeof info.selectionText === 'string' ? info.selectionText : '' },
      { frameId }
    );
  } catch (error) {
    console.warn('[FocusFlow] Could not open the translation panel:', error && error.name);
    await signalUnsupportedPage(tab.id);
  }
}

// activeTab is granted for the clicked tab by this user action.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== TRANSLATE_MENU_ID) return;
  void handleMenuClick(info, tab);
});

// In-memory guards. Best effort only: a suspended worker forgets them, which is harmless here.
let translating = false;
let lastFinishedAt = 0;
const MIN_GAP_MS = 1000;

function fail(code, message) {
  return { ok: false, code, message };
}

async function handleTranslateRequest(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab) {
    return fail('bad-sender', 'This request was not accepted.');
  }
  if (typeof message.text !== 'string') return fail('invalid-text', 'The selection must be text.');

  let text;
  try {
    text = validateSelection(message.text);
  } catch (error) {
    return fail(error.code || 'invalid-text', error.message);
  }

  const prefs = await loadTranslationPrefs();
  if (!prefs.privacyAccepted) {
    if (message.acceptPrivacy !== true) return fail('needs-consent', PRIVACY_NOTICE);
    await saveTranslationPrefs({ privacyAccepted: true });
  }

  if (translating) return fail('busy', 'A translation is already in progress.');
  if (Date.now() - lastFinishedAt < MIN_GAP_MS) {
    return fail('too-fast', 'Please wait a moment before translating again.');
  }

  translating = true;
  try {
    return { ok: true, ...(await translateText(text)) };
  } catch (error) {
    // Log the error code only. Never log the selected text or the translation.
    console.warn('[FocusFlow] Translation failed:', error && (error.code || error.name));
    return error instanceof TranslationError
      ? fail(error.code, error.message)
      : fail('failed', 'Translation failed unexpectedly. Please try again.');
  } finally {
    translating = false;
    lastFinishedAt = Date.now();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'ff-translate') return false;
  handleTranslateRequest(message, sender).then(sendResponse, () =>
    sendResponse(fail('failed', 'Translation failed unexpectedly. Please try again.'))
  );
  return true; // keep the channel open for the async answer
});

// Granting or revoking site access (from Settings or Chrome's extension menu) keeps the script in sync.
function touchesSelectionOrigins(permissions) {
  return Boolean(
    permissions && Array.isArray(permissions.origins) &&
      permissions.origins.some((origin) => SELECTION_ORIGINS.includes(origin))
  );
}

chrome.permissions.onAdded.addListener((permissions) => {
  if (!touchesSelectionOrigins(permissions)) return;
  saveTranslationPrefs({ floatingButton: true })
    .then(() => reconcileTranslation('permission granted'))
    .catch((error) => console.error('[FocusFlow] Permission-added handling failed:', error && error.name));
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (!touchesSelectionOrigins(permissions)) return;
  saveTranslationPrefs({ floatingButton: false })
    .then(() => reconcileTranslation('permission removed'))
    .catch((error) => console.error('[FocusFlow] Permission-removed handling failed:', error && error.name));
});