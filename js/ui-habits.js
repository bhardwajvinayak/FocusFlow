// js/ui-habits.js
// Habits card at the top of the Progress tab. All rules (limits, duplicates, the 7-day window, streaks,
// milestones, calendars) live in js/habits.js; this file reads input, calls those pure functions, saves
// through js/storage.js and draws the result. User text is only inserted with textContent / .value.
// Nothing is logged except error names and counts. It never throws into the Progress tab.

import { STORAGE_KEYS, StorageError, getValue, setValue } from './storage.js';
import { formatDayLabel } from './focus-intelligence.js';
import {
  HABITS_SCHEMA_VERSION,
  HABIT_LIMITS,
  addHabit,
  archiveHabit,
  cleanHabits,
  computeHabitCalendar,
  computeHabitStats,
  computeLastDays,
  newMilestones,
  renameHabit,
  restoreHabit,
  setCompletion,
} from './habits.js';

const $ = (id) => document.getElementById(id);

const els = {
  card: $('hb-card'),
  form: $('hb-form'),
  name: $('hb-name'),
  add: $('hb-add'),
  error: $('hb-error'),
  status: $('hb-status'),
  warning: $('hb-warning'),
  count: $('hb-count'),
  empty: $('hb-empty'),
  list: $('hb-list'),
  archived: $('hb-archived'),
  archivedSummary: $('hb-archived-summary'),
  archivedList: $('hb-archived-list'),
};

const STATE_TEXT = {
  done: 'done',
  'not-done': 'not done',
  'before-start': 'before this habit started, so no data',
  upcoming: 'upcoming',
};

// UI-only state. The real data lives in chrome.storage.local ("habits").
const ui = {
  status: 'loading', // 'loading' | 'ready' | 'error'
  loadError: '',
  habits: [],
  skipped: null,
  editingId: null,
  editDraft: '',
  editError: '',
  confirmArchiveId: null,
  openHistory: new Set(),
  archivedOpen: false,
};

let bound = false;
let queue = Promise.resolve();
let token = 0;

/* ================================================================== */
/* Small helpers                                                       */
/* ================================================================== */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function createButton(label, action, className = '', ariaLabel = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['btn', 'btn-small', className].filter(Boolean).join(' ');
  button.dataset.action = action;
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  return button;
}

function cell(tag, text, scope) {
  const node = el(tag, '', text);
  if (scope) node.scope = scope;
  return node;
}

function setStatus(text) {
  els.status.textContent = text;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = '';
  els.name.removeAttribute('aria-invalid');
}

function showError(message, invalidField) {
  els.error.textContent = message;
  els.error.hidden = false;
  if (invalidField) invalidField.setAttribute('aria-invalid', 'true');
}

/** Moves keyboard focus to the first element matching `selector` inside the card. */
function focusSelector(selector) {
  const target = els.card.querySelector(selector);
  if (target) target.focus();
  return target;
}

const itemSelector = (id, inner) => `.hb-item[data-id="${CSS.escape(id)}"] ${inner}`;

/* ================================================================== */
/* Storage: every change re-reads the latest habits, applies ONE pure   */
/* reducer from js/habits.js, and writes only if something changed      */
/* ================================================================== */

async function loadFromStorage() {
  const raw = await getValue(STORAGE_KEYS.HABITS);
  return cleanHabits(raw, new Date());
}

function mutate(reducer) {
  const run = queue.then(async () => {
    const { habits } = await loadFromStorage();
    const result = reducer(habits);
    if (result.ok && result.changed) {
      await setValue(STORAGE_KEYS.HABITS, { schemaVersion: HABITS_SCHEMA_VERSION, habits: result.habits });
    }
    return { result, before: habits };
  });
  queue = run.catch(() => {}); // a failed change must not block later ones
  return run;
}

async function reloadQuietly() {
  try {
    const { habits, skipped } = await loadFromStorage();
    ui.habits = habits;
    ui.skipped = skipped;
  } catch {
    /* keep what is on screen; the error message has already been shown */
  }
  render();
}

/** Runs a reducer. Returns { result, before }, or null after a storage failure (already reported). */
async function runAction(reducer) {
  try {
    const outcome = await mutate(reducer);
    ui.habits = outcome.result.habits;
    return outcome;
  } catch (error) {
    if (error instanceof StorageError) {
      console.error('[FocusFlow] Habit storage error:', error.cause && error.cause.name);
      showError(`${error.message} Your change was not saved.`);
    } else {
      console.error('[FocusFlow] Unexpected habit error:', error && error.name);
      showError('Something unexpected went wrong. Please try again.');
    }
    await reloadQuietly(); // show what is really stored
    return null;
  }
}

/* ================================================================== */
/* Rendering                                                           */
/* ================================================================== */

function createCalendar(habit, now) {
  const calendar = computeHabitCalendar(habit, now, 5);
  const table = el('table', 'hb-cal');
  table.append(el('caption', 'hb-cal-caption', 'Last 5 weeks, Monday to Sunday'));

  const head = document.createElement('tr');
  for (const name of ['Week of', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) head.append(cell('th', name, 'col'));
  const thead = document.createElement('thead');
  thead.append(head);

  const tbody = document.createElement('tbody');
  for (const week of calendar.weeks) {
    const row = document.createElement('tr');
    row.append(cell('th', formatDayLabel(week[0].date).slice(4), 'row')); // "28 Sep"
    for (const day of week) {
      const description = `${formatDayLabel(day.date)}: ${STATE_TEXT[day.status]}`;
      const td = el('td', `hb-cell hb-${day.status}`);
      td.title = description;
      const hidden = el('span', 'visually-hidden', description);
      const visible = el('span', '', String(Number(day.date.slice(8))));
      visible.setAttribute('aria-hidden', 'true');
      td.append(hidden, visible);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

function createHistory(habit, now) {
  const details = el('details', 'hb-history');
  details.dataset.historyFor = habit.id;
  details.open = ui.openHistory.has(habit.id);
  details.append(el('summary', '', 'History (last 5 weeks)'));
  details.append(createCalendar(habit, now));
  details.append(
    el(
      'p',
      'field-hint',
      'Filled = done. Outlined = not done. Hatched = before this habit started (no data, not a missed day). Dashed = upcoming.'
    )
  );
  return details;
}

function createDayButtons(habit, now, today) {
  const group = el('div', 'hb-days');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `Last 7 days for ${habit.name}`);
  for (const day of computeLastDays(habit, now)) {
    const isToday = day.date === today;
    const label = formatDayLabel(day.date); // "Wed 21 Oct"
    const parts = label.split(' ');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hb-day${day.done ? ' is-done' : ''}${isToday ? ' is-today' : ''}`;
    button.dataset.action = 'toggle-day';
    button.dataset.date = day.date;
    button.setAttribute('aria-pressed', String(day.done));
    button.setAttribute('aria-label', `${habit.name}, ${label}${isToday ? ' (today)' : ''}`);
    button.append(
      el('span', 'hb-day-name', isToday ? 'Today' : parts[0]),
      el('span', 'hb-day-num', parts[1]),
      el('span', 'hb-day-state', day.done ? 'Done' : '\u2013')
    );
    group.append(button);
  }
  return group;
}

function createMilestones(stats, archived) {
  const wrap = el('div', 'hb-milestones');
  const earned = stats.milestones.filter((m) => m.earned);
  if (earned.length > 0) {
    const list = el('ul', 'hb-badges');
    list.setAttribute('aria-label', 'Milestones reached');
    for (const m of earned) {
      const li = el('li', 'hb-badge', `${m.days} days`);
      if (m.date) li.title = `First reached ${formatDayLabel(m.date)}`;
      list.append(li);
    }
    wrap.append(list);
  }
  if (!archived) {
    wrap.append(
      el(
        'p',
        'hb-next',
        stats.nextMilestone
          ? `Next milestone: ${stats.nextMilestone.days} days in a row (${stats.nextMilestone.remaining} to go).`
          : 'All milestones reached.'
      )
    );
  } else if (earned.length === 0) {
    wrap.append(el('p', 'hb-next', 'No milestones reached.'));
  }
  return wrap;
}

function createItem(habit, now, today) {
  const archived = habit.archivedAt !== null;
  const stats = computeHabitStats(habit, now);
  const isEditing = ui.editingId === habit.id && !archived;
  const isConfirming = ui.confirmArchiveId === habit.id && !archived;

  const item = el('li', `hb-item${archived ? ' is-archived' : ''}`);
  item.dataset.id = habit.id;

  const head = el('div', 'hb-head');
  const actions = el('div', 'hb-actions');

  if (isEditing) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input hb-edit';
    input.dataset.field = 'name';
    input.maxLength = HABIT_LIMITS.nameMax;
    input.value = ui.editDraft; // .value is never parsed as HTML
    input.setAttribute('aria-label', 'Habit name');
    if (ui.editError) input.setAttribute('aria-invalid', 'true');
    head.append(input);
    actions.append(createButton('Save', 'save-rename', 'btn-primary'), createButton('Cancel', 'cancel-rename'));
  } else {
    head.append(el('span', 'hb-name', habit.name));
    if (archived) {
      actions.append(createButton('Restore', 'restore', '', `Restore habit: ${habit.name}`));
    } else if (!isConfirming) {
      actions.append(
        createButton('Rename', 'rename', '', `Rename habit: ${habit.name}`),
        createButton('Archive', 'archive', '', `Archive habit: ${habit.name}`)
      );
    }
  }
  head.append(actions);
  item.append(head);

  if (isEditing && ui.editError) {
    const error = el('p', 'field-error', ui.editError);
    error.setAttribute('role', 'alert');
    item.append(error);
  }

  if (isConfirming) {
    const box = el('div', 'hb-confirm');
    box.append(
      el('p', 'confirm-text', 'Archive this habit? Its history is kept and you can restore it later.'),
      createButton('Archive', 'confirm-archive', 'btn-primary'),
      createButton('Cancel', 'cancel-archive')
    );
    item.append(box);
  }

  item.append(
    el(
      'p',
      'hb-stats',
      `Current streak: ${plural(stats.current, 'day', 'days')} \u00b7 Best: ${plural(stats.best, 'day', 'days')} \u00b7 ` +
        `Days recorded: ${stats.total}`
    ),
    createMilestones(stats, archived)
  );
  if (!archived) item.append(createDayButtons(habit, now, today));
  item.append(createHistory(habit, now));
  return item;
}

function emptyText(activeCount, archivedCount) {
  if (activeCount > 0) return '';
  if (archivedCount > 0) return 'All your habits are archived. Restore one below, or add a new habit.';
  return 'No habits yet. Add one above, for example "Read 10 pages". Days before you add a habit are never counted as missed.';
}

function renderWarning() {
  const s = ui.skipped;
  const unreadable = s ? s.invalid + s.duplicates + s.overLimit : 0;
  const dates = s ? s.droppedDates : 0;
  if (!s || unreadable + dates === 0) {
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  const parts = [];
  if (unreadable > 0) parts.push(plural(unreadable, 'saved habit record', 'saved habit records'));
  if (dates > 0) parts.push(plural(dates, 'saved date', 'saved dates'));
  els.warning.textContent =
    `${parts.join(' and ')} could not be read and ${unreadable + dates === 1 ? 'is' : 'are'} not shown. ` +
    'They are removed the next time you change a habit. Your other habits are unaffected.';
  els.warning.hidden = false;
}

function render() {
  const ready = ui.status === 'ready';
  els.name.disabled = !ready;
  els.add.disabled = !ready;

  if (!ready) {
    els.count.textContent = '';
    els.warning.hidden = true;
    els.empty.hidden = false;
    els.empty.textContent = ui.status === 'error' ? ui.loadError : 'Loading habits\u2026';
    els.list.replaceChildren();
    els.archived.hidden = true;
    return;
  }

  const now = new Date();
  const today = computeHabitStats({ completions: [], createdAt: now.getTime() }, now).todayKey;
  const active = ui.habits.filter((habit) => habit.archivedAt === null);
  const archived = ui.habits
    .filter((habit) => habit.archivedAt !== null)
    .sort((a, b) => b.archivedAt - a.archivedAt || (a.id < b.id ? -1 : 1));

  renderWarning();
  els.count.textContent = `${active.length} of ${HABIT_LIMITS.activeMax} active habits (${ui.habits.length} of ${HABIT_LIMITS.totalMax} in total)`;

  const message = emptyText(active.length, archived.length);
  els.empty.hidden = message === '';
  els.empty.textContent = message;

  els.list.replaceChildren(...active.map((habit) => createItem(habit, now, today)));

  els.archived.hidden = archived.length === 0;
  els.archived.open = ui.archivedOpen;
  els.archivedSummary.textContent = `Archived habits (${archived.length})`;
  els.archivedList.replaceChildren(...archived.map((habit) => createItem(habit, now, today)));
}

/* ================================================================== */
/* User actions                                                        */
/* ================================================================== */

async function handleAdd(event) {
  event.preventDefault();
  if (ui.status !== 'ready') return;
  clearError();
  const outcome = await runAction((habits) =>
    addHabit(habits, { name: els.name.value, id: crypto.randomUUID(), now: new Date() })
  );
  if (!outcome) return;
  if (!outcome.result.ok) {
    showError(outcome.result.error, els.name);
    render();
    els.name.focus();
    return;
  }
  els.form.reset();
  setStatus(`Habit added: ${outcome.result.habit.name}.`);
  render();
  els.name.focus();
}

async function toggleDay(id, date, done) {
  clearError();
  const outcome = await runAction((habits) => setCompletion(habits, id, date, done, new Date()));
  if (!outcome) return;
  const { result, before } = outcome;
  render();
  focusSelector(itemSelector(id, `.hb-day[data-date="${date}"]`));
  if (!result.ok) {
    showError(result.error);
    return;
  }
  if (!result.changed) return;

  const now = new Date();
  const after = result.habits.find((habit) => habit.id === id);
  const prior = before.find((habit) => habit.id === id);
  if (!after || !prior) return;
  const statsAfter = computeHabitStats(after, now);
  const gained = newMilestones(computeHabitStats(prior, now), statsAfter);
  let message =
    `${after.name} ${done ? 'marked done for' : 'unmarked for'} ${formatDayLabel(date)}. ` +
    `Current streak: ${plural(statsAfter.current, 'day', 'days')}.`;
  if (gained.length > 0) {
    message += ` Milestone${gained.length > 1 ? 's' : ''} reached: ${gained.join(', ')} days in a row.`;
  }
  setStatus(message);
}

function startRename(id) {
  const habit = ui.habits.find((item) => item.id === id);
  if (!habit) return;
  ui.editingId = id;
  ui.editDraft = habit.name;
  ui.editError = '';
  ui.confirmArchiveId = null;
  render();
  const input = focusSelector(itemSelector(id, '[data-field="name"]'));
  if (input) input.select();
}

function cancelRename(id) {
  ui.editingId = null;
  ui.editDraft = '';
  ui.editError = '';
  render();
  focusSelector(itemSelector(id, '[data-action="rename"]'));
}

async function saveRename(id) {
  const outcome = await runAction((habits) => renameHabit(habits, id, ui.editDraft));
  if (!outcome) return;
  if (!outcome.result.ok) {
    if (outcome.result.code === 'not-found') {
      ui.editingId = null;
      showError(outcome.result.error);
      render();
      return;
    }
    ui.editError = outcome.result.error;
    render();
    focusSelector(itemSelector(id, '[data-field="name"]'));
    return;
  }
  ui.editingId = null;
  ui.editDraft = '';
  ui.editError = '';
  render();
  focusSelector(itemSelector(id, '[data-action="rename"]'));
  if (outcome.result.changed) {
    const renamed = outcome.result.habits.find((habit) => habit.id === id);
    if (renamed) setStatus(`Habit renamed to ${renamed.name}.`);
  }
}

function startArchive(id) {
  ui.confirmArchiveId = id;
  ui.editingId = null;
  ui.editError = '';
  render();
  focusSelector(itemSelector(id, '[data-action="cancel-archive"]')); // safest default: the non-destructive button
}

function cancelArchive(id) {
  ui.confirmArchiveId = null;
  render();
  focusSelector(itemSelector(id, '[data-action="archive"]'));
}

async function confirmArchive(id) {
  const outcome = await runAction((habits) => archiveHabit(habits, id, new Date()));
  if (!outcome) return;
  ui.confirmArchiveId = null;
  if (!outcome.result.ok) showError(outcome.result.error);
  else {
    const habit = outcome.result.habits.find((item) => item.id === id);
    if (habit) setStatus(`${habit.name} archived. Its history is kept. You can restore it under "Archived habits".`);
  }
  render();
  els.name.focus();
}

async function restore(id) {
  clearError();
  const outcome = await runAction((habits) => restoreHabit(habits, id));
  if (!outcome) return;
  if (!outcome.result.ok) {
    showError(outcome.result.error);
    render();
    return;
  }
  const habit = outcome.result.habits.find((item) => item.id === id);
  if (habit) setStatus(`${habit.name} restored. Its history is back.`);
  render();
  focusSelector(itemSelector(id, '[data-action="rename"]'));
}

/* ================================================================== */
/* Events (delegation on the card, wired once)                         */
/* ================================================================== */

function handleClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !els.card.contains(button)) return;
  const item = button.closest('.hb-item');
  const id = item ? item.dataset.id : null;
  if (!id) return;

  switch (button.dataset.action) {
    case 'toggle-day':
      void toggleDay(id, button.dataset.date, button.getAttribute('aria-pressed') !== 'true');
      break;
    case 'rename':         startRename(id); break;
    case 'save-rename':    void saveRename(id); break;
    case 'cancel-rename':  cancelRename(id); break;
    case 'archive':        startArchive(id); break;
    case 'confirm-archive': void confirmArchive(id); break;
    case 'cancel-archive': cancelArchive(id); break;
    case 'restore':        void restore(id); break;
    default: break;
  }
}

function handleInput(event) {
  // Remember what the user typed so a re-render never wipes an edit in progress.
  if (event.target.matches('[data-field="name"]') && ui.editingId) ui.editDraft = event.target.value;
}

function handleKeydown(event) {
  const item = event.target.closest('.hb-item');
  if (!item) return;
  const id = item.dataset.id;
  if (event.target.matches('[data-field="name"]')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveRename(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename(id);
    }
  } else if (event.key === 'Escape' && ui.confirmArchiveId === id) {
    event.preventDefault();
    cancelArchive(id);
  }
}

// "toggle" does not bubble, so it is caught in the capture phase.
function handleDetailsToggle(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement)) return;
  if (details.id === 'hb-archived') {
    ui.archivedOpen = details.open;
    return;
  }
  const id = details.dataset.historyFor;
  if (!id) return;
  if (details.open) ui.openHistory.add(id);
  else ui.openHistory.delete(id);
}

function bind() {
  if (bound) return;
  bound = true;
  els.name.maxLength = HABIT_LIMITS.nameMax;
  els.form.addEventListener('submit', (event) => void handleAdd(event));
  els.name.addEventListener('input', clearError);
  els.card.addEventListener('click', handleClick);
  els.card.addEventListener('input', handleInput);
  els.card.addEventListener('keydown', handleKeydown);
  els.card.addEventListener('toggle', handleDetailsToggle, true);
  // A popup left open past midnight: re-read when it becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshHabitsUI();
  });
}

/* ================================================================== */
/* Public                                                              */
/* ================================================================== */

/** Reloads habits from storage and redraws. Never throws, so it cannot break the Progress tab. */
export async function refreshHabitsUI() {
  bind();
  const current = ++token;
  try {
    await queue; // let any change that is still being saved finish first
    const { habits, skipped } = await loadFromStorage();
    if (current !== token) return; // a newer refresh is already running
    ui.habits = habits;
    ui.skipped = skipped;
    ui.status = 'ready';
    if (ui.editingId && !habits.some((habit) => habit.id === ui.editingId)) ui.editingId = null;
    if (ui.confirmArchiveId && !habits.some((habit) => habit.id === ui.confirmArchiveId)) ui.confirmArchiveId = null;
    setStatus('');
    render();
  } catch (error) {
    if (current !== token) return;
    console.error('[FocusFlow] Habits could not load:', error && error.name);
    ui.status = 'error';
    ui.loadError = 'Habits could not load your saved data. The rest of Progress is unaffected.';
    render();
  }
}