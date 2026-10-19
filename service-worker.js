// service-worker.js
// Background layer (Manifest V3). It can be suspended at any time, so it never relies on
// in-memory variables: every handler re-reads state from chrome.storage.local.
// All listeners are registered at the top level, synchronously, so Chrome can wake this
// worker for the right event.

import { initializeStorage } from './js/storage.js';
import { recoverTimer } from './js/timer.js';
import { handleBreakAlarm, recoverReminders } from './js/eye-comfort.js';
import { BREAK_ALARM_NAME, TIMER_ALARM_NAME } from './js/config.js';

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