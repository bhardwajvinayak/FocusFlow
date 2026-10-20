// script.js
// Popup entry point (coordinator): tabs, messages, storage initialization, and starting the
// tab modules. Business rules live in js/*.js; each tab's UI lives in js/ui-*.js.

import { initializeStorage } from './js/storage.js';
import { resetAllAppData } from './js/timer.js';
import { initFocusUI, refreshFocusUI } from './js/ui-focus.js';
import { cancelNoteAutosave, flushNotes, initNotesUI, refreshNotesUI } from './js/ui-notes.js';
import { refreshProgressUI } from './js/ui-progress.js';
import { applyTheme, initSettingsUI, refreshSettingsUI } from './js/ui-settings.js';
import { initEyeUI, refreshEyeUI } from './js/ui-eye.js';
import { initTranslationSettingsUI, refreshTranslationUI } from './js/ui-translate-settings.js';
import { initPlannerUI, refreshPlannerUI } from './js/ui-planner.js';
import { initRecommendationsUI, refreshRecommendationsUI } from './js/ui-recommendations.js';
import {
  initTasksUI,
  loadTasksUI,
  reloadTasks,
  resetTasksForm,
  setTasksLoadError,
} from './js/ui-tasks.js';

const elements = {
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  bannerDismiss: document.getElementById('banner-dismiss'),
  storageStatus: document.getElementById('storage-status'),
  tablist: document.querySelector('[role="tablist"]'),
  tabs: Array.from(document.querySelectorAll('[role="tab"]')),
  panels: Array.from(document.querySelectorAll('[role="tabpanel"]')),
  settingsToggle: document.getElementById('settings-toggle'),
  settingsPanel: document.getElementById('panel-settings'),
};

let activeTab = 'tasks';

/* ================================================================== */
/* Messages                                                            */
/* ================================================================== */

/** type: 'info' | 'success' | 'warning' | 'error'. One banner at a time: a new message replaces the old. */
function showBanner(message, type = 'info') {
  elements.bannerText.textContent = message; // textContent: never interpret text as HTML
  elements.banner.className = `banner banner-${type}`;
  elements.banner.setAttribute('role', type === 'error' ? 'alert' : 'status');
  elements.banner.hidden = false;
}

function hideBanner() {
  elements.banner.hidden = true;
  elements.bannerText.textContent = '';
}

/* ================================================================== */
/* Tab modules (Focus, Notes, Progress, Settings)                      */
/* ================================================================== */

const modules = {
  focus: { started: false, refresh: refreshFocusUI },
  eye: { started: false, refresh: refreshEyeUI },
  recommendations: { started: false, refresh: refreshRecommendationsUI },
  translation: { started: false, refresh: refreshTranslationUI },
  planner: { started: false, refresh: refreshPlannerUI },
  notes: { started: false, refresh: refreshNotesUI },
  progress: { started: false, refresh: refreshProgressUI },
  settings: { started: false, refresh: refreshSettingsUI },
};

function refreshModule(name) {
  const module = modules[name];
  return module && module.started ? module.refresh() : Promise.resolve();
}

async function startModule(name, init) {
  try {
    await init();
    modules[name].started = true;
  } catch (error) {
    console.error(`[FocusFlow] The ${name} module failed to start:`, error);
    showBanner(`The ${name} section could not be loaded: ${error.message || 'unknown error'}`, 'error');
  }
}

/** Deletes everything, then reloads every view from the fresh defaults. */
async function performFullReset() {
  cancelNoteAutosave(); // a pending autosave must not bring a deleted note back
  await resetAllAppData();

  resetTasksForm();
  await reloadTasks();

  await Promise.all([
    refreshModule('notes'),
    refreshModule('focus'),
    refreshModule('eye'),
    refreshModule('translation'),
    refreshModule('planner'),
    refreshModule('progress'),
    refreshModule('settings'),
  ]);
}

const moduleContext = { showBanner, performReset: performFullReset };

async function startModules() {
  // Eyes starts BEFORE Focus: it must read the "BREAK" badge before the timer UI clears the badge.
  await startModule('eye', () => initEyeUI(moduleContext));
  await startModule('focus', () => initFocusUI(moduleContext));
  await startModule('notes', () => initNotesUI(moduleContext));
  await startModule('progress', () => refreshProgressUI());
  await startModule('settings', () => initSettingsUI(moduleContext));
  await startModule('translation', () => initTranslationSettingsUI(moduleContext));
  await startModule('planner', () => initPlannerUI(moduleContext));
    await startModule('recommendations', () => initRecommendationsUI());
}

/* ================================================================== */
/* Tabs and the settings panel                                         */
/* ================================================================== */

function showPanels(settingsOpen) {
  elements.settingsPanel.hidden = !settingsOpen;
  elements.settingsToggle.setAttribute('aria-expanded', String(settingsOpen));
  for (const panel of elements.panels) {
    panel.hidden = settingsOpen || panel.id !== `panel-${activeTab}`;
  }
  for (const tab of elements.tabs) {
    tab.setAttribute('aria-selected', String(!settingsOpen && tab.dataset.tab === activeTab));
    tab.tabIndex = tab.dataset.tab === activeTab ? 0 : -1;
  }
}

function activateTab(tabId, { moveFocus = false } = {}) {
  if (activeTab === 'notes' && tabId !== 'notes') void flushNotes();
  activeTab = tabId;
  showPanels(false);
  if (moveFocus) elements.tabs.find((tab) => tab.dataset.tab === tabId).focus();

  if (tabId === 'focus') void refreshModule('focus');
  if (tabId === 'progress') void refreshModule('progress');
  if (tabId === 'eye') void refreshModule('eye');
  if (tabId === 'planner') void refreshModule('planner');
    if (tabId === 'focus') void refreshModule('recommendations');
}

function toggleSettings() {
  const willOpen = elements.settingsPanel.hidden;
  if (willOpen && activeTab === 'notes') void flushNotes();
  showPanels(willOpen);
  if (willOpen) void refreshModule('settings');
}

function handleTabClick(event) {
  const tab = event.target.closest('[role="tab"]');
  if (tab) activateTab(tab.dataset.tab);
}

function handleTabKeydown(event) {
  const currentIndex = elements.tabs.indexOf(event.target);
  if (currentIndex === -1) return;

  const lastIndex = elements.tabs.length - 1;
  let nextIndex = null;

  switch (event.key) {
    case 'ArrowRight':
      nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
      break;
    case 'ArrowLeft':
      nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = lastIndex;
      break;
    default:
      return; // ignore other keys
  }

  event.preventDefault();
  activateTab(elements.tabs[nextIndex].dataset.tab, { moveFocus: true });
}

function setupTabs() {
  elements.tablist.addEventListener('click', handleTabClick);
  elements.tablist.addEventListener('keydown', handleTabKeydown);
  elements.settingsToggle.addEventListener('click', toggleSettings);
}

/** Best-effort final save of a note being edited when the popup is closing or hidden. */
function setupSafetyFlush() {
  window.addEventListener('pagehide', () => void flushNotes());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNotes();
  });
}

/* ================================================================== */
/* Startup                                                             */
/* ================================================================== */

async function init() {
  setupTabs();
  setupSafetyFlush();
  elements.bannerDismiss.addEventListener('click', hideBanner);
  initTasksUI(moduleContext); // shows "Loading tasks..." until storage is ready

  try {
    const { state, createdKeys, warnings } = await initializeStorage();
    applyTheme(state.settings.theme);

    const { skippedCount } = await loadTasksUI();

    elements.storageStatus.textContent = `Storage ready (schema v${state.settings.schemaVersion})`;

    const messages = [...warnings];
    if (skippedCount > 0) {
      messages.push(
        `${skippedCount} saved task${skippedCount === 1 ? '' : 's'} could not be read and ` +
          `${skippedCount === 1 ? 'was' : 'were'} skipped. ` +
          'Skipped items are removed the next time tasks are saved. Details are in the console.'
      );
    }

    if (messages.length > 0) {
      showBanner(messages.join(' '), 'warning');
    } else if (createdKeys.length > 0) {
      showBanner('Local storage was set up. Your data stays on this device.', 'success');
    }
  } catch (error) {
    console.error('[FocusFlow] Startup failed:', error);
    const message = error.message || 'Something went wrong while starting FocusFlow.';
    elements.storageStatus.textContent = 'Storage unavailable';
    showBanner(message, 'error');
    setTasksLoadError(message);
    return; // storage is unusable, so the other tabs are not started
  }

  await startModules();
}

init();