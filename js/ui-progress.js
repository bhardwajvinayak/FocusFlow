// js/ui-progress.js
// Progress tab UI. All numbers come from statistics.js (derived from stored data).

import { loadStats } from './statistics.js';
import { refreshCoachUI } from './ui-coach.js';
import { refreshFocusIntelligenceUI } from './ui-focus-intelligence.js';
import { refreshGoalsUI } from './ui-goals.js';
import { refreshInsightsUI } from './ui-insights.js';
import { refreshHabitsUI } from './ui-habits.js';
const $ = (id) => document.getElementById(id);

const els = {
  empty: $('progress-empty'),
  date: $('progress-date'),
  todayTasks: $('stat-today-tasks'),
  todaySessions: $('stat-today-sessions'),
  todayMinutes: $('stat-today-minutes'),
  total: $('stat-total'),
  completed: $('stat-completed'),
  pending: $('stat-pending'),
  bar: $('stat-bar'),
  percent: $('stat-percent'),
  allSessions: $('stat-all-sessions'),
  allMinutes: $('stat-all-minutes'),
  allDays: $('stat-all-days'),
  error: $('progress-error'),
};

function render(stats) {
  els.date.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  els.todayTasks.textContent = String(stats.tasks.completedToday);
  els.todaySessions.textContent = String(stats.focus.todaySessions);
  els.todayMinutes.textContent = String(stats.focus.todayMinutes);

  els.total.textContent = String(stats.tasks.total);
  els.completed.textContent = String(stats.tasks.completed);
  els.pending.textContent = String(stats.tasks.pending);
  els.bar.value = stats.tasks.completionPercent;
  els.percent.textContent = `${stats.tasks.completionPercent}%`;

  els.allSessions.textContent = String(stats.focus.allTimeSessions);
  els.allMinutes.textContent = String(stats.focus.allTimeMinutes);
  els.allDays.textContent = String(stats.focus.activeDays);

  els.empty.hidden = stats.tasks.total > 0 || stats.focus.allTimeSessions > 0;
}

export async function refreshProgressUI() {
  try {
    render(await loadStats());
    void refreshCoachUI(); // independent: a coach problem never breaks the statistics
    void refreshFocusIntelligenceUI(); // independent: this card can never break the statistics
    void refreshGoalsUI(); // independent: goals and reports can never break the statistics
    void refreshHabitsUI(); // independent: habits can never break the statistics
        void refreshInsightsUI(); // independent: insights and export can never break the statistics
    els.error.hidden = true;
  } catch (error) {
    console.error('[FocusFlow] Could not load statistics:', error);
    els.error.textContent = error.message || 'Could not load statistics.';
    els.error.hidden = false;
  }
}