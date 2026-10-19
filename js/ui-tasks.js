// js/ui-tasks.js
// Tasks tab UI. All rules live in js/tasks.js; this file reads input, calls it, and draws the result.
// User text is only ever inserted with textContent / .value (never innerHTML).

import { StorageError, getLocalDateKey } from './storage.js';
import {
  CATEGORY_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  PRIORITIES,
  RECURRENCES,
  SUBTASK_MAX_LENGTH,
  TASK_FILTERS,
  TASK_SORTS,
  TITLE_MAX_LENGTH,
  TaskError,
  addSubtask,
  addTask,
  countTasks,
  deleteSubtask,
  deleteTask,
  filterTasks,
  getCategories,
  getDailyProgress,
  getDueStatus,
  loadTasks,
  searchTasks,
  setSubtaskCompleted,
  setTaskCompleted,
  sortTasks,
  updateTask,
} from './tasks.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('task-form'),
  fields: $('task-fields'),
  title: $('task-title'),
  more: $('task-more'),
  description: $('task-description'),
  priority: $('task-priority'),
  category: $('task-category'),
  due: $('task-due'),
  recurrence: $('task-recurrence'),
  add: $('task-add'),
  formError: $('task-form-error'),
  categories: $('task-categories'),
  progress: $('task-progress'),
  progressText: $('task-progress-text'),
  progressBar: $('task-progress-bar'),
  search: $('task-search'),
  sort: $('task-sort'),
  filterButtons: Array.from(document.querySelectorAll('[data-filter]')),
  summary: $('task-summary'),
  list: $('task-list'),
  empty: $('task-empty'),
  emptyTitle: $('task-empty-title'),
  emptyText: $('task-empty-text'),
};

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const RECURRENCE_LABELS = {
  none: 'Does not repeat',
  daily: 'Repeats daily',
  weekly: 'Repeats weekly',
  monthly: 'Repeats monthly',
};
const ERROR_FIELD = {
  'invalid-title': 'title',
  'invalid-description': 'description',
  'invalid-category': 'category',
  'invalid-priority': 'priority',
  'invalid-recurrence': 'recurrence',
  'invalid-date': 'dueDate',
};

let ctx = { showBanner() {} };

// UI-only state. The real data lives in chrome.storage.local.
const ui = {
  status: 'loading', // 'loading' | 'ready' | 'error'
  loadError: '',
  tasks: [],
  filter: 'all',
  sort: 'newest',
  query: '',
  editingId: null,
  editDraft: null,
  editError: '',
  editErrorField: '',
  confirmDeleteId: null,
  expandedId: null,
  subtaskDraft: '',
  subtaskError: '',
  isAdding: false,
};

/* ================================================================== */
/* Rendering helpers                                                   */
/* ================================================================== */

/** "2026-10-20" -> "20 Oct 2026" (built from parts, so no timezone shifting). */
function formatDueDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function pluralDays(count) {
  return `${count} day${count === 1 ? '' : 's'}`;
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

function createBadge(text, className) {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.textContent = text;
  return badge;
}

function createDueMeta(task, today) {
  const { kind, days } = getDueStatus(task, today);
  if (kind === 'none') return null;

  const meta = document.createElement('span');
  meta.className = 'task-meta';
  const formatted = formatDueDate(task.dueDate);

  switch (kind) {
    case 'overdue':
      meta.textContent = `Overdue by ${pluralDays(-days)} (${formatted})`;
      meta.classList.add('is-overdue');
      break;
    case 'today':
      meta.textContent = 'Due today';
      meta.classList.add('is-today');
      break;
    case 'soon':
      meta.textContent = days === 1 ? 'Due tomorrow' : `Due in ${days} days (${formatted})`;
      meta.classList.add('is-soon');
      break;
    default:
      meta.textContent = `Due ${formatted}`;
  }
  return meta;
}

function createSelect(field, values, labelFor, selected, ariaLabel) {
  const select = document.createElement('select');
  select.className = 'text-input';
  select.dataset.field = field;
  select.setAttribute('aria-label', ariaLabel);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labelFor(value);
    select.append(option);
  }
  select.value = selected;
  return select;
}

function createEditForm() {
  const draft = ui.editDraft;
  const form = document.createElement('div');
  form.className = 'edit-form';

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'text-input';
  title.dataset.field = 'title';
  title.maxLength = TITLE_MAX_LENGTH;
  title.value = draft.title;
  title.setAttribute('aria-label', 'Task title');

  const description = document.createElement('textarea');
  description.className = 'text-area edit-description';
  description.dataset.field = 'description';
  description.rows = 2;
  description.maxLength = DESCRIPTION_MAX_LENGTH;
  description.value = draft.description;
  description.placeholder = 'Description (optional)';
  description.setAttribute('aria-label', 'Description');

  const rowA = document.createElement('div');
  rowA.className = 'edit-row';
  rowA.append(
    createSelect('priority', PRIORITIES, (v) => `${PRIORITY_LABELS[v]} priority`, draft.priority, 'Priority'),
    createSelect('recurrence', RECURRENCES, (v) => RECURRENCE_LABELS[v], draft.recurrence, 'Repeat')
  );

  const category = document.createElement('input');
  category.type = 'text';
  category.className = 'text-input';
  category.dataset.field = 'category';
  category.maxLength = CATEGORY_MAX_LENGTH;
  category.value = draft.category;
  category.placeholder = 'Category';
  category.setAttribute('list', 'task-categories');
  category.setAttribute('aria-label', 'Category');

  const due = document.createElement('input');
  due.type = 'date';
  due.className = 'text-input';
  due.dataset.field = 'dueDate';
  due.value = draft.dueDate;
  due.setAttribute('aria-label', 'Due date');

  const rowB = document.createElement('div');
  rowB.className = 'edit-row';
  rowB.append(category, due);

  form.append(title, description, rowA, rowB);

  if (ui.editError) {
    const target = form.querySelector(`[data-field="${ui.editErrorField}"]`);
    if (target) target.setAttribute('aria-invalid', 'true');
    const error = document.createElement('p');
    error.className = 'field-error';
    error.setAttribute('role', 'alert');
    error.textContent = ui.editError;
    form.append(error);
  }
  return form;
}

function createSteps(task) {
  const wrap = document.createElement('div');
  wrap.className = 'steps';

  if (task.subtasks.length > 0) {
    const list = document.createElement('ul');
    list.className = 'steps-list';
    list.setAttribute('aria-label', `Steps for ${task.title}`);
    for (const sub of task.subtasks) {
      const li = document.createElement('li');
      li.className = 'step-item';
      if (sub.completed) li.classList.add('is-completed');
      li.dataset.subId = sub.id;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'subtask-check';
      check.checked = sub.completed;
      check.setAttribute('aria-label', `${sub.completed ? 'Mark step not done' : 'Mark step done'}: ${sub.title}`);

      const text = document.createElement('span');
      text.className = 'step-title';
      text.textContent = sub.title;

      li.append(check, text, createButton('Remove', 'delete-subtask', 'btn-quiet', `Remove step: ${sub.title}`));
      list.append(li);
    }
    wrap.append(list);
  }

  const row = document.createElement('div');
  row.className = 'step-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input step-input';
  input.maxLength = SUBTASK_MAX_LENGTH;
  input.placeholder = 'Add a step';
  input.value = ui.subtaskDraft;
  input.setAttribute('aria-label', `Add a step to: ${task.title}`);
  row.append(input, createButton('Add', 'add-subtask'));
  wrap.append(row);

  if (ui.subtaskError) {
    input.setAttribute('aria-invalid', 'true');
    const error = document.createElement('p');
    error.className = 'field-error';
    error.setAttribute('role', 'alert');
    error.textContent = ui.subtaskError;
    wrap.append(error);
  }
  return wrap;
}

function createTaskItem(task, today) {
  const isEditing = ui.editingId === task.id;
  const isConfirming = ui.confirmDeleteId === task.id;
  const isExpanded = ui.expandedId === task.id;

  const item = document.createElement('li');
  item.className = 'task-item';
  if (task.completed) item.classList.add('is-completed');
  if (isConfirming) item.classList.add('is-confirming');
  item.dataset.id = task.id;
  item.dataset.priority = task.priority;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'task-check';
  checkbox.checked = task.completed;
  checkbox.setAttribute(
    'aria-label',
    `${task.completed ? 'Mark as not completed' : 'Mark as completed'}: ${task.title}`
  );

  const body = document.createElement('div');
  body.className = 'task-body';
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  if (isEditing) {
    body.append(createEditForm());
    actions.append(createButton('Save', 'save-edit', 'btn-primary'), createButton('Cancel', 'cancel-edit'));
    body.append(actions);
    item.append(checkbox, body);
    return item;
  }

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;
  body.append(title);

  const badges = document.createElement('div');
  badges.className = 'task-badges';
  badges.append(createBadge(`${PRIORITY_LABELS[task.priority]} priority`, `badge-${task.priority}`));
  if (task.category) badges.append(createBadge(task.category, 'badge-category'));
  if (task.recurrence !== 'none') badges.append(createBadge(RECURRENCE_LABELS[task.recurrence], 'badge-repeat'));
  body.append(badges);

  if (task.description) {
    const description = document.createElement('p');
    description.className = 'task-desc';
    description.textContent = task.description;
    body.append(description);
  }

  const meta = createDueMeta(task, today);
  if (meta) body.append(meta);

  if (isConfirming) {
    const confirmText = document.createElement('p');
    confirmText.className = 'confirm-text';
    confirmText.textContent = 'Delete this task and its steps? This cannot be undone.';
    body.append(confirmText);
    actions.append(createButton('Delete', 'confirm-delete', 'btn-danger'), createButton('Cancel', 'cancel-delete'));
    body.append(actions);
  } else {
    const done = task.subtasks.filter((sub) => sub.completed).length;
    const stepsLabel = task.subtasks.length > 0 ? `Steps ${done}/${task.subtasks.length}` : 'Add steps';
    const stepsButton = createButton(stepsLabel, 'toggle-steps', '', `${stepsLabel} for: ${task.title}`);
    stepsButton.setAttribute('aria-expanded', String(isExpanded));
    actions.append(
      stepsButton,
      createButton('Edit', 'edit', '', `Edit task: ${task.title}`),
      createButton('Delete', 'delete', '', `Delete task: ${task.title}`)
    );
    body.append(actions);
    if (isExpanded) body.append(createSteps(task));
  }

  item.append(checkbox, body);
  return item;
}

function showEmpty(title, text) {
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
  els.empty.hidden = false;
  els.list.replaceChildren();
}

function getEmptyMessage() {
  if (ui.tasks.length === 0) {
    return { title: 'No tasks yet', text: 'Type a task above and press Add to get started.' };
  }
  if (ui.query.trim() !== '') {
    return { title: 'No matching tasks', text: 'Try a different search or filter.' };
  }
  switch (ui.filter) {
    case 'pending':
      return { title: 'Nothing pending', text: 'Every task is completed. Nice work!' };
    case 'overdue':
      return { title: 'No overdue tasks', text: 'Nothing is past its due date.' };
    default:
      return { title: 'No completed tasks yet', text: 'Tick a task to see it here.' };
  }
}

function renderProgress(today) {
  if (ui.tasks.length === 0) {
    els.progress.hidden = true;
    return;
  }
  const progress = getDailyProgress(ui.tasks, today);
  els.progress.hidden = false;
  els.progressText.textContent =
    progress.target === 0
      ? 'Today: no tasks due. Completed tasks and tasks due today will show here.'
      : `Today: ${progress.completedToday} of ${progress.target} done` +
        (progress.remaining > 0 ? ` \u00b7 ${progress.remaining} left` : '');
  els.progressBar.value = progress.percent;
}

function renderCategories() {
  els.categories.replaceChildren(
    ...getCategories(ui.tasks).map((category) => {
      const option = document.createElement('option');
      option.value = category;
      return option;
    })
  );
}

function renderTasks() {
  for (const button of els.filterButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === ui.filter));
  }

  if (ui.status === 'loading') {
    els.summary.textContent = '';
    els.progress.hidden = true;
    showEmpty('Loading tasks\u2026', '');
    return;
  }
  if (ui.status === 'error') {
    els.summary.textContent = '';
    els.progress.hidden = true;
    showEmpty('Tasks unavailable', ui.loadError);
    return;
  }

  const today = getLocalDateKey();
  renderCategories();
  renderProgress(today);

  const counts = countTasks(ui.tasks, today);
  const visible = sortTasks(searchTasks(filterTasks(ui.tasks, ui.filter, today), ui.query), ui.sort);

  const parts = [];
  if (counts.total > 0) {
    parts.push(`${counts.pending} pending`, `${counts.completed} completed`);
    if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
    if (ui.filter !== 'all' || ui.query.trim() !== '') parts.push(`showing ${visible.length}`);
  }
  els.summary.textContent = parts.join(' \u00b7 ');

  if (visible.length === 0) {
    const { title, text } = getEmptyMessage();
    showEmpty(title, text);
    return;
  }

  els.empty.hidden = true;
  els.list.replaceChildren(...visible.map((task) => createTaskItem(task, today)));
}

/** Moves keyboard focus to an element inside a task row. Returns the element, or null. */
function focusItem(id, selector) {
  const item = els.list.querySelector(`.task-item[data-id="${CSS.escape(id)}"]`);
  const target = item ? item.querySelector(selector) : null;
  if (target) target.focus();
  return target;
}

/* ================================================================== */
/* Errors                                                              */
/* ================================================================== */

function clearFormError() {
  els.formError.hidden = true;
  els.formError.textContent = '';
  for (const control of [els.title, els.description, els.category, els.due]) {
    control.removeAttribute('aria-invalid');
  }
}

function showFormError(message, code) {
  const fieldName = ERROR_FIELD[code] || 'title';
  const controls = {
    title: els.title,
    description: els.description,
    category: els.category,
    dueDate: els.due,
    priority: els.priority,
    recurrence: els.recurrence,
  };
  const target = controls[fieldName] || els.title;
  if (fieldName !== 'title') els.more.open = true; // the field lives inside "More options"
  els.formError.textContent = message;
  els.formError.hidden = false;
  target.setAttribute('aria-invalid', 'true');
  target.focus();
}

export async function reloadTasks() {
  try {
    const { tasks } = await loadTasks();
    ui.tasks = tasks;
  } catch (error) {
    console.error('[FocusFlow] Reload failed:', error);
    ctx.showBanner('Could not refresh your tasks. Close and reopen FocusFlow.', 'error');
  }
  ui.editingId = null;
  ui.editDraft = null;
  ui.editError = '';
  ui.confirmDeleteId = null;
  ui.expandedId = null;
  ui.subtaskDraft = '';
  ui.subtaskError = '';
  renderTasks();
}

/**
 * One place for task errors.
 * - not-found: the list was out of date, so say so and reload it.
 * - validation errors: shown where the caller wants them (form, edit row, step row).
 * - storage errors: red banner. Nothing is reported as saved.
 */
async function handleTaskError(error, { onValidation } = {}) {
  if (error instanceof TaskError && error.code === 'not-found') {
    ctx.showBanner(error.message, 'warning');
    await reloadTasks();
    return;
  }
  if (error instanceof TaskError && onValidation) {
    onValidation(error.message, error.code);
    return;
  }
  if (error instanceof StorageError) {
    console.error('[FocusFlow] Storage error:', error.cause ?? error);
    ctx.showBanner(`${error.message} Your last change was not applied.`, 'error');
  } else {
    console.error('[FocusFlow] Unexpected error:', error);
    ctx.showBanner('Something unexpected went wrong. Please try again.', 'error');
  }
  renderTasks(); // redraw from the last known good data so the screen never lies
}

/* ================================================================== */
/* User actions                                                        */
/* ================================================================== */

async function handleTaskSubmit(event) {
  event.preventDefault();
  if (ui.isAdding || ui.status !== 'ready') return; // ignore repeated clicks

  clearFormError();
  ui.isAdding = true;
  els.add.disabled = true;

  try {
    ui.tasks = await addTask({
      title: els.title.value,
      description: els.description.value,
      priority: els.priority.value,
      category: els.category.value,
      dueDate: els.due.value,
      recurrence: els.recurrence.value,
    });
    els.form.reset();
    els.more.open = false;
    // Otherwise a filter or search could hide the task that was just added.
    if (ui.filter !== 'all' && ui.filter !== 'pending') ui.filter = 'all';
    if (ui.query !== '') {
      ui.query = '';
      els.search.value = '';
    }
    renderTasks();
    els.title.focus();
  } catch (error) {
    await handleTaskError(error, { onValidation: showFormError });
  } finally {
    ui.isAdding = false;
    els.add.disabled = false;
  }
}

async function toggleTask(id, completed) {
  const before = ui.tasks.length;
  try {
    ui.tasks = await setTaskCompleted(id, completed);
    if (ui.tasks.length > before) {
      ctx.showBanner('Repeating task: the next occurrence was added.', 'info');
    }
  } catch (error) {
    await handleTaskError(error);
  }
  renderTasks();
  if (!focusItem(id, '.task-check')) {
    const activeFilter = els.filterButtons.find((b) => b.dataset.filter === ui.filter);
    if (activeFilter) activeFilter.focus();
  }
}

function startEdit(id) {
  const task = ui.tasks.find((candidate) => candidate.id === id);
  if (!task) return;
  ui.editingId = id;
  ui.editDraft = {
    title: task.title,
    description: task.description,
    priority: task.priority,
    category: task.category,
    dueDate: task.dueDate || '',
    recurrence: task.recurrence,
  };
  ui.editError = '';
  ui.editErrorField = '';
  ui.confirmDeleteId = null;
  renderTasks();
  const input = focusItem(id, '[data-field="title"]');
  if (input) input.select();
}

function cancelEdit(id) {
  ui.editingId = null;
  ui.editDraft = null;
  ui.editError = '';
  renderTasks();
  focusItem(id, '[data-action="edit"]');
}

async function saveEdit(id) {
  if (!ui.editDraft) return;
  try {
    ui.tasks = await updateTask(id, ui.editDraft);
    ui.editingId = null;
    ui.editDraft = null;
    ui.editError = '';
    renderTasks();
    focusItem(id, '[data-action="edit"]');
  } catch (error) {
    await handleTaskError(error, {
      onValidation: (message, code) => {
        ui.editError = message;
        ui.editErrorField = ERROR_FIELD[code] || 'title';
        renderTasks();
        focusItem(id, `[data-field="${ui.editErrorField}"]`);
      },
    });
  }
}

function startDelete(id) {
  ui.confirmDeleteId = id;
  ui.editingId = null;
  ui.editDraft = null;
  ui.editError = '';
  renderTasks();
  focusItem(id, '[data-action="cancel-delete"]'); // safest default: the non-destructive button
}

function cancelDelete(id) {
  ui.confirmDeleteId = null;
  renderTasks();
  focusItem(id, '[data-action="delete"]');
}

async function confirmDelete(id) {
  try {
    ui.tasks = await deleteTask(id);
    ui.confirmDeleteId = null;
    if (ui.expandedId === id) ui.expandedId = null;
    renderTasks();
    els.title.focus();
  } catch (error) {
    await handleTaskError(error); // the confirmation stays open so the user can retry or cancel
  }
}

function toggleSteps(id) {
  const opening = ui.expandedId !== id;
  ui.expandedId = opening ? id : null;
  ui.subtaskDraft = '';
  ui.subtaskError = '';
  renderTasks();
  focusItem(id, opening ? '.step-input' : '[data-action="toggle-steps"]');
}

async function addStep(id) {
  try {
    ui.tasks = await addSubtask(id, ui.subtaskDraft);
    ui.subtaskDraft = '';
    ui.subtaskError = '';
    renderTasks();
    focusItem(id, '.step-input');
  } catch (error) {
    await handleTaskError(error, {
      onValidation: (message) => {
        ui.subtaskError = message;
        renderTasks();
        focusItem(id, '.step-input');
      },
    });
  }
}

async function toggleStep(id, subId, completed) {
  try {
    ui.tasks = await setSubtaskCompleted(id, subId, completed);
  } catch (error) {
    await handleTaskError(error);
  }
  renderTasks();
  focusItem(id, `.step-item[data-sub-id="${CSS.escape(subId)}"] .subtask-check`);
}

async function removeStep(id, subId) {
  try {
    ui.tasks = await deleteSubtask(id, subId);
  } catch (error) {
    await handleTaskError(error);
  }
  renderTasks();
  focusItem(id, '.step-input');
}

/* ================================================================== */
/* Event wiring (delegation: one listener per kind on the list)        */
/* ================================================================== */

function handleListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('.task-item');
  if (!item) return;
  const id = item.dataset.id;
  const stepItem = button.closest('.step-item');
  const subId = stepItem ? stepItem.dataset.subId : null;

  switch (button.dataset.action) {
    case 'edit':           startEdit(id); break;
    case 'save-edit':      void saveEdit(id); break;
    case 'cancel-edit':    cancelEdit(id); break;
    case 'delete':         startDelete(id); break;
    case 'confirm-delete': void confirmDelete(id); break;
    case 'cancel-delete':  cancelDelete(id); break;
    case 'toggle-steps':   toggleSteps(id); break;
    case 'add-subtask':    void addStep(id); break;
    case 'delete-subtask': if (subId) void removeStep(id, subId); break;
    default: break;
  }
}

function handleListChange(event) {
  const target = event.target;
  const item = target.closest('.task-item');
  if (!item) return;

  if (target.matches('.task-check')) {
    void toggleTask(item.dataset.id, target.checked);
  } else if (target.matches('.subtask-check')) {
    const stepItem = target.closest('.step-item');
    if (stepItem) void toggleStep(item.dataset.id, stepItem.dataset.subId, target.checked);
  } else if (target.matches('[data-field]') && ui.editDraft) {
    ui.editDraft[target.dataset.field] = target.value;
  }
}

function handleListInput(event) {
  const target = event.target;
  // Remember what the user typed so a re-render never wipes an edit in progress.
  if (target.matches('[data-field]') && ui.editDraft) ui.editDraft[target.dataset.field] = target.value;
  else if (target.matches('.step-input')) ui.subtaskDraft = target.value;
}

function handleListKeydown(event) {
  const target = event.target;
  const item = target.closest('.task-item');
  if (!item) return;
  const id = item.dataset.id;

  if (target.matches('.step-input')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addStep(id);
    }
    return;
  }

  if (ui.editingId === id && target.closest('.edit-form')) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(id);
    } else if (event.key === 'Enter' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT') {
      event.preventDefault();
      void saveEdit(id);
    }
    return;
  }

  if (event.key === 'Escape' && ui.confirmDeleteId === id) {
    event.preventDefault();
    cancelDelete(id);
  }
}

function handleFilterClick(event) {
  const button = event.target.closest('[data-filter]');
  if (!button || !TASK_FILTERS.includes(button.dataset.filter)) return;
  ui.filter = button.dataset.filter;
  renderTasks();
}

/* ================================================================== */
/* Public API                                                          */
/* ================================================================== */

/** Wires up all listeners. Call once, before loadTasksUI(). */
export function initTasksUI(context) {
  ctx = context;

  els.title.maxLength = TITLE_MAX_LENGTH;
  els.description.maxLength = DESCRIPTION_MAX_LENGTH;
  els.category.maxLength = CATEGORY_MAX_LENGTH;

  els.form.addEventListener('submit', handleTaskSubmit);
  els.title.addEventListener('input', clearFormError);
  els.description.addEventListener('input', clearFormError);
  els.category.addEventListener('input', clearFormError);
  els.due.addEventListener('change', clearFormError);

  els.search.addEventListener('input', () => {
    ui.query = els.search.value;
    renderTasks();
  });
  els.sort.addEventListener('change', () => {
    if (TASK_SORTS.includes(els.sort.value)) ui.sort = els.sort.value;
    renderTasks();
  });
  for (const button of els.filterButtons) button.addEventListener('click', handleFilterClick);

  els.list.addEventListener('click', handleListClick);
  els.list.addEventListener('change', handleListChange);
  els.list.addEventListener('input', handleListInput);
  els.list.addEventListener('keydown', handleListKeydown);

  renderTasks(); // shows "Loading tasks..." until loadTasksUI() finishes
}

/** Loads tasks into the UI. Returns { skippedCount }. Throws if storage cannot be read. */
export async function loadTasksUI() {
  const { tasks, skippedCount } = await loadTasks();
  ui.tasks = tasks;
  ui.status = 'ready';
  els.fields.disabled = false;
  renderTasks();
  els.title.focus();
  return { skippedCount };
}

export function setTasksLoadError(message) {
  ui.status = 'error';
  ui.loadError = message;
  renderTasks();
}

/** Clears the form, search, filter and sort. Call before reloadTasks() after "reset all data". */
export function resetTasksForm() {
  els.form.reset();
  els.more.open = false;
  clearFormError();
  ui.filter = 'all';
  ui.sort = 'newest';
  ui.query = '';
  els.search.value = '';
  els.sort.value = 'newest';
}