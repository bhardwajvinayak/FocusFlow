// js/ui-planner.js
// Planner tab UI. READ-ONLY: it reads tasks and shows a proposed schedule. It never edits,
// completes or reorders tasks, and it saves nothing. Estimates entered here live in memory only.
// All task text is inserted with textContent / .value. Task text is never logged.

import { StorageError, getLocalDateKey } from './storage.js';
import { loadTasks } from './tasks.js';
import { PLANNER_LIMITS, formatTime, planDay, planToText } from './planner.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('planner-form'),
  start: $('pl-start'),
  available: $('pl-available'),
  unit: $('pl-unit'),
  session: $('pl-session'),
  breakLength: $('pl-break'),
  defaultLength: $('pl-default'),
  estimatesList: $('pl-estimates'),
  error: $('planner-error'),
  generate: $('planner-generate'),
  copy: $('planner-copy'),
  status: $('planner-status'),
  empty: $('planner-empty'),
  emptyTitle: $('planner-empty-title'),
  emptyText: $('planner-empty-text'),
  result: $('planner-result'),
  summary: $('planner-summary'),
  blocks: $('planner-blocks'),
  notScheduledHeading: $('planner-unscheduled-heading'),
  unscheduled: $('planner-unscheduled'),
  notes: $('planner-notes'),
};

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

let ctx = { showBanner() {} };
let tasks = [];
let signature = '';
let loadFailed = false;
const estimates = Object.create(null); // taskId -> text typed by the user (memory only)
let currentPlan = null;

/* ------------------------------------------------------------------ */
/* Defaults and form reading                                           */
/* ------------------------------------------------------------------ */

function fillDefaults() {
  const now = new Date();
  let start = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  if (1440 - start < 60) start = 9 * 60; // too late in the day: suggest a morning start instead
  const available = Math.min(240, Math.floor((1440 - start) / 15) * 15);

  els.start.value = formatTime(start);
  els.available.value = String(available);
  els.unit.value = 'minutes';
  els.session.value = '25';
  els.breakLength.value = '5';
  els.defaultLength.value = '25';

  els.session.min = String(PLANNER_LIMITS.sessionMinutes.min);
  els.session.max = String(PLANNER_LIMITS.sessionMinutes.max);
  els.breakLength.min = String(PLANNER_LIMITS.breakMinutes.min);
  els.breakLength.max = String(PLANNER_LIMITS.breakMinutes.max);
  els.defaultLength.min = String(PLANNER_LIMITS.defaultTaskMinutes.min);
  els.defaultLength.max = String(PLANNER_LIMITS.defaultTaskMinutes.max);
}

function readSettings() {
  let available = els.available.value.trim();
  if (els.unit.value === 'hours') {
    const hours = Number(available);
    available = Number.isFinite(hours) && hours > 0 ? String(Math.round(hours * 60)) : 'invalid';
  }
  return {
    startTime: els.start.value,
    availableMinutes: available,
    sessionMinutes: els.session.value,
    breakMinutes: els.breakLength.value,
    defaultTaskMinutes: els.defaultLength.value,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function span(className, text) {
  const node = document.createElement('span');
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function priorityBadge(priority) {
  return span(`badge badge-${priority}`, `${PRIORITY_LABELS[priority]} priority`);
}

function renderEstimates() {
  const pending = tasks.filter((task) => !task.completed);
  els.estimatesList.replaceChildren(
    ...pending.map((task) => {
      const li = document.createElement('li');
      li.className = 'planner-estimate';
      const name = span('planner-estimate-title', task.title);
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'text-input planner-estimate-input';
      input.min = String(PLANNER_LIMITS.taskEstimateMinutes.min);
      input.max = String(PLANNER_LIMITS.taskEstimateMinutes.max);
      input.step = '1';
      input.dataset.id = task.id;
      input.placeholder = 'default';
      input.value = estimates[task.id] || '';
      input.setAttribute('aria-label', `Estimated minutes for: ${task.title}`);
      li.append(name, input);
      return li;
    })
  );
}

function renderEmptyState() {
  const pending = tasks.filter((task) => !task.completed).length;
  const show = loadFailed || pending === 0;
  els.empty.hidden = !show;
  els.generate.disabled = show;
  if (loadFailed) {
    els.emptyTitle.textContent = 'Tasks unavailable';
    els.emptyText.textContent = 'FocusFlow could not read your tasks. Close and reopen the popup to try again.';
  } else if (show) {
    els.emptyTitle.textContent = 'No pending tasks to plan';
    els.emptyText.textContent = 'Add a task in the Tasks tab, then come back to build a plan.';
  }
}

function clearPlan() {
  currentPlan = null;
  els.result.hidden = true;
  els.copy.hidden = true;
  els.blocks.replaceChildren();
  els.unscheduled.replaceChildren();
}

function renderPlan(plan) {
  currentPlan = plan;
  const { totals } = plan;
  els.result.hidden = false;
  els.copy.hidden = false;

  els.summary.textContent =
    `${plan.scheduled.length} task${plan.scheduled.length === 1 ? '' : 's'} scheduled between ` +
    `${totals.startsAt} and ${totals.endsAt}: ${totals.workMinutes} min of work, ${totals.breakMinutes} min of breaks, ` +
    `${totals.freeMinutes} min of the window unused.`;

  if (plan.blocks.length === 0) {
    els.blocks.replaceChildren(
      Object.assign(document.createElement('li'), {
        className: 'planner-none',
        textContent: 'No task fit in this window. Try a longer window or shorter estimates.',
      })
    );
  } else {
    els.blocks.replaceChildren(
      ...plan.blocks.map((block) => {
        const li = document.createElement('li');
        const time = span('planner-time', `${block.startLabel} - ${block.endLabel}`);
        if (block.type === 'break') {
          li.className = 'planner-break';
          li.append(time, span('planner-label', `Break, ${block.minutes} min`));
        } else {
          li.className = 'planner-block';
          li.dataset.priority = block.priority;
          const main = span('planner-title', block.title);
          const meta = document.createElement('span');
          meta.className = 'planner-meta';
          meta.append(priorityBadge(block.priority));
          if (block.overdue) meta.append(span('planner-flag', 'Overdue'));
          if (block.parts > 1) meta.append(span('planner-part', `Part ${block.part} of ${block.parts}`));
          li.append(time, main, meta);
        }
        return li;
      })
    );
  }

  els.notScheduledHeading.hidden = plan.unscheduled.length === 0;
  els.unscheduled.replaceChildren(
    ...plan.unscheduled.map((item) => {
      const li = document.createElement('li');
      li.className = 'planner-skipped';
      const meta = document.createElement('span');
      meta.className = 'planner-meta';
      meta.append(priorityBadge(item.priority));
      li.append(span('planner-title', item.title), meta, span('planner-reason', item.reasonText));
      return li;
    })
  );

  const all = [...plan.scheduled, ...plan.unscheduled];
  const defaults = all.filter((item) => item.estimateSource === 'default').length;
  const ignoredEstimates = all.filter((item) => item.estimateNote !== '').length;
  const notes = [];
  if (defaults > 0) {
    notes.push(
      `${defaults} of ${all.length} task${all.length === 1 ? '' : 's'} used the default length. ` +
        'Add estimates above for a more accurate plan.'
    );
  }
  if (ignoredEstimates > 0) {
    notes.push(`${ignoredEstimates} estimate${ignoredEstimates === 1 ? ' was' : 's were'} ignored because they were outside the allowed range.`);
  }
  notes.push('This is a suggestion built from fixed rules. It is not saved and does not change your tasks.');
  els.notes.textContent = notes.join(' ');
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function handleSubmit(event) {
  event.preventDefault();
  els.error.hidden = true;
  els.status.textContent = '';
  if (loadFailed) return;

  const plan = planDay({
    tasks,
    settings: readSettings(),
    estimates,
    today: getLocalDateKey(),
  });
  if (!plan.ok) {
    clearPlan();
    showError(plan.errors.join(' '));
    return;
  }
  renderPlan(plan);
  els.status.textContent = `Plan generated: ${plan.scheduled.length} scheduled, ${plan.unscheduled.length} not scheduled.`;
}

async function handleCopy() {
  if (!currentPlan) return;
  try {
    await navigator.clipboard.writeText(planToText(currentPlan));
    els.status.textContent = 'Plan copied to the clipboard.';
  } catch {
    els.status.textContent = 'Copying was blocked. You can select the schedule and copy it manually.';
  }
}

function handleEstimateInput(event) {
  const input = event.target.closest('.planner-estimate-input');
  if (!input) return;
  if (input.value.trim() === '') delete estimates[input.dataset.id];
  else estimates[input.dataset.id] = input.value;
  // The shown plan no longer matches the estimates, so ask for a new one.
  if (currentPlan) {
    clearPlan();
    els.status.textContent = 'Estimates changed. Press Generate plan to update the schedule.';
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Reloads tasks (read only). If they changed since the plan was made, the plan is cleared. */
export async function refreshPlannerUI() {
  try {
    const loaded = await loadTasks();
    const nextSignature = JSON.stringify(
      loaded.tasks.map((t) => [t.id, t.title, t.completed, t.priority, t.dueDate])
    );
    const changed = nextSignature !== signature;
    tasks = loaded.tasks;
    signature = nextSignature;
    loadFailed = false;

    const ids = new Set(tasks.map((task) => task.id));
    for (const id of Object.keys(estimates)) if (!ids.has(id)) delete estimates[id];

    if (changed && currentPlan) {
      clearPlan();
      els.status.textContent = 'Your tasks changed, so the earlier plan was cleared. Press Generate plan again.';
    }
  } catch (error) {
    loadFailed = true;
    console.error('[FocusFlow] Planner could not load tasks:', error instanceof StorageError ? 'StorageError' : error && error.name);
  }
  renderEstimates();
  renderEmptyState();
}

export async function initPlannerUI(context) {
  ctx = context;
  fillDefaults();
  els.form.addEventListener('submit', handleSubmit);
  els.copy.addEventListener('click', () => void handleCopy());
  els.estimatesList.addEventListener('input', handleEstimateInput);
  for (const input of [els.start, els.available, els.unit, els.session, els.breakLength, els.defaultLength]) {
    input.addEventListener('input', () => {
      els.error.hidden = true;
    });
  }
  await refreshPlannerUI();
}