// js/ui-notes.js
// Notes tab UI: a list view and an editor view with debounced autosave.

import {
  NOTE_CONTENT_MAX,
  NoteError,
  createNote,
  createNoteAutosaver,
  deleteNote,
  loadNotes,
} from './notes.js';
import { StorageError } from './storage.js';

const els = {
  listView: document.getElementById('note-list-view'),
  editorView: document.getElementById('note-editor-view'),
  newButton: document.getElementById('note-new'),
  list: document.getElementById('note-list'),
  empty: document.getElementById('note-empty'),
  emptyTitle: document.getElementById('note-empty-title'),
  emptyText: document.getElementById('note-empty-text'),
  back: document.getElementById('note-back'),
  status: document.getElementById('note-status'),
  title: document.getElementById('note-title'),
  content: document.getElementById('note-content'),
  counter: document.getElementById('note-counter'),
  error: document.getElementById('note-error'),
  deleteButton: document.getElementById('note-delete'),
  confirm: document.getElementById('note-confirm'),
  confirmYes: document.getElementById('note-confirm-yes'),
  confirmNo: document.getElementById('note-confirm-no'),
};

const SAVE_TEXT = { unsaved: 'Unsaved changes\u2026', saving: 'Saving\u2026', saved: 'All changes saved' };

let ctx = { showBanner() {} };
const state = { status: 'loading', loadError: '', notes: [], currentId: null, leaveArmed: false };

const autosaver = createNoteAutosaver({ delayMs: 600, onStatus: handleSaveStatus });

/* ---------- messages ---------- */

function messageFor(error) {
  if (error instanceof NoteError) return error.message;
  if (error instanceof StorageError) {
    return `${error.message} Your latest edits are still on screen but are not saved.`;
  }
  console.error('[FocusFlow] Unexpected notes error:', error);
  return 'Something unexpected went wrong while saving.';
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function clearEditorError() {
  els.error.hidden = true;
  els.error.textContent = '';
  els.title.removeAttribute('aria-invalid');
}

function handleSaveStatus(kind, detail) {
  if (kind === 'saved') {
    state.notes = detail;
    state.leaveArmed = false;
    clearEditorError();
    setStatus(SAVE_TEXT.saved, 'saved');
  } else if (kind === 'error') {
    if (detail instanceof NoteError && detail.code === 'not-found') {
      ctx.showBanner('That note no longer exists, so it could not be saved.', 'warning');
      void refreshNotesUI();
      return;
    }
    setStatus('Not saved', 'error');
    els.error.textContent = messageFor(detail);
    els.error.hidden = false;
    if (detail instanceof NoteError && detail.code === 'invalid-title') {
      els.title.setAttribute('aria-invalid', 'true');
    }
  } else {
    setStatus(SAVE_TEXT[kind] ?? '', '');
  }
}

/* ---------- list view ---------- */

function showEmpty(title, text) {
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
  els.empty.hidden = false;
  els.list.replaceChildren();
}

function createNoteButton(note) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note-item';
  button.dataset.id = note.id;

  const title = document.createElement('span');
  title.className = 'note-item-title';
  title.textContent = note.title;

  const preview = document.createElement('span');
  preview.className = 'note-item-preview';
  preview.textContent = note.content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'No content yet';

  const date = document.createElement('span');
  date.className = 'note-item-date';
  date.textContent = new Date(note.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  button.append(title, preview, date);
  item.append(button);
  return item;
}

function renderList() {
  els.newButton.disabled = state.status !== 'ready';
  if (state.status === 'loading') return showEmpty('Loading notes\u2026', '');
  if (state.status === 'error') return showEmpty('Notes unavailable', state.loadError);
  if (state.notes.length === 0) {
    return showEmpty('No notes yet', 'Press "New note" to write your first one. Changes save automatically.');
  }

  const sorted = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  els.empty.hidden = true;
  els.list.replaceChildren(...sorted.map(createNoteButton));
}

/* ---------- editor view ---------- */

function updateCounter() {
  els.counter.textContent = `${els.content.value.length} / ${NOTE_CONTENT_MAX} characters`;
}

function openEditor(id) {
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) return;

  state.currentId = id;
  state.leaveArmed = false;
  els.title.value = note.title; // .value is never parsed as HTML
  els.content.value = note.content;
  clearEditorError();
  els.confirm.hidden = true;
  setStatus(SAVE_TEXT.saved, 'saved');
  updateCounter();
  els.listView.hidden = true;
  els.editorView.hidden = false;
  els.title.focus();
  els.title.select();
}

function closeEditor() {
  state.currentId = null;
  els.editorView.hidden = true;
  els.listView.hidden = false;
  renderList();
  els.newButton.focus();
}

function onEditorInput() {
  if (state.currentId === null) return;
  state.leaveArmed = false;
  clearEditorError();
  updateCounter();
  autosaver.schedule(state.currentId, { title: els.title.value, content: els.content.value });
}

async function handleBack() {
  const result = await autosaver.flush();
  if (!result.ok && !state.leaveArmed) {
    state.leaveArmed = true; // second click leaves without saving
    els.error.textContent = `${messageFor(result.error)} Press "Back to notes" again to leave without saving.`;
    els.error.hidden = false;
    return;
  }
  if (!result.ok) autosaver.cancel();
  closeEditor();
}

async function handleNew() {
  try {
    const { notes, note } = await createNote();
    state.notes = notes;
    openEditor(note.id);
  } catch (error) {
    ctx.showBanner(messageFor(error), 'error');
  }
}

async function handleDeleteConfirmed() {
  const id = state.currentId;
  if (id === null) return;
  autosaver.cancel(); // the note is going away; do not save it again
  try {
    state.notes = await deleteNote(id);
    closeEditor();
    ctx.showBanner('Note deleted.', 'success');
  } catch (error) {
    if (error instanceof NoteError && error.code === 'not-found') {
      ctx.showBanner(error.message, 'warning');
      await refreshNotesUI();
    } else {
      ctx.showBanner(messageFor(error), 'error');
      els.confirm.hidden = true;
    }
  }
}

/* ---------- public API ---------- */

/** Saves any unsaved edit right now. Called when leaving the tab and when the popup closes. */
export function flushNotes() {
  return autosaver.flush();
}

/** Forgets unsaved edits. Used before "reset all data" so a late autosave cannot restore a note. */
export function cancelNoteAutosave() {
  autosaver.cancel();
}

/** Reloads notes from storage and returns to the list view. */
export async function refreshNotesUI() {
  autosaver.cancel();
  state.currentId = null;
  els.editorView.hidden = true;
  els.listView.hidden = false;
  try {
    const { notes, skippedCount } = await loadNotes();
    state.notes = notes;
    state.status = 'ready';
    if (skippedCount > 0) {
      ctx.showBanner(
        `${skippedCount} saved note${skippedCount === 1 ? '' : 's'} could not be read and ` +
          `${skippedCount === 1 ? 'was' : 'were'} skipped. Details are in the console.`,
        'warning'
      );
    }
  } catch (error) {
    console.error('[FocusFlow] Could not load notes:', error);
    state.status = 'error';
    state.loadError = error.message || 'Could not load your notes.';
  }
  renderList();
}

export async function initNotesUI(context) {
  ctx = context;
  els.title.maxLength = 100;
  els.content.maxLength = NOTE_CONTENT_MAX;

  els.newButton.addEventListener('click', () => void handleNew());
  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]');
    if (button) openEditor(button.dataset.id);
  });
  els.back.addEventListener('click', () => void handleBack());
  els.title.addEventListener('input', onEditorInput);
  els.content.addEventListener('input', onEditorInput);
  els.title.addEventListener('blur', () => void autosaver.flush());
  els.content.addEventListener('blur', () => void autosaver.flush());

  els.deleteButton.addEventListener('click', () => {
    els.confirm.hidden = false;
    els.confirmNo.focus(); // safest default: the non-destructive button
  });
  els.confirmNo.addEventListener('click', () => {
    els.confirm.hidden = true;
    els.deleteButton.focus();
  });
  els.confirmYes.addEventListener('click', () => void handleDeleteConfirmed());
  els.confirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.confirm.hidden = true;
      els.deleteButton.focus();
    }
  });

  await refreshNotesUI();
}