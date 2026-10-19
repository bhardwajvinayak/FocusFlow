// js/notes.js
// Notes: validation, CRUD and debounced autosave. No DOM code.
// Owner of the "notes" key: the popup (via this file).
//
// The popup is the only writer, so after the first load this file keeps the list in memory
// (`cache`) and writes it straight away. That avoids a storage READ right before a WRITE,
// which matters when the popup is closing and a final save must start immediately.

import { STORAGE_KEYS, getValue, setValue } from './storage.js';

export const NOTE_TITLE_MAX = 100;
export const NOTE_CONTENT_MAX = 10000;
export const DEFAULT_NOTE_TITLE = 'Untitled note';

export class NoteError extends Error {
  /** code: 'invalid-title' | 'invalid-content' | 'not-found' */
  constructor(message, code) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

export function validateNoteTitle(rawTitle) {
  if (typeof rawTitle !== 'string') throw new NoteError('Note title must be text.', 'invalid-title');
  const title = rawTitle.trim();
  if (title.length === 0) throw new NoteError('A note needs a title.', 'invalid-title');
  if (title.length > NOTE_TITLE_MAX) {
    throw new NoteError(`Title must be ${NOTE_TITLE_MAX} characters or fewer.`, 'invalid-title');
  }
  return title;
}

export function validateNoteContent(rawContent) {
  if (typeof rawContent !== 'string') throw new NoteError('Note content must be text.', 'invalid-content');
  if (rawContent.length > NOTE_CONTENT_MAX) {
    throw new NoteError(`Content must be ${NOTE_CONTENT_MAX} characters or fewer.`, 'invalid-content');
  }
  return rawContent;
}

function normalizeNote(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null;
  if (typeof raw.content !== 'string') return null;
  if (!Number.isFinite(raw.createdAt)) return null;
  return {
    id: raw.id,
    title: raw.title,
    content: raw.content,
    createdAt: raw.createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : raw.createdAt,
  };
}

let cache = null; // last known copy of the stored notes (null until loaded)

/** Reads and validates stored notes. Unusable items are skipped, logged and dropped on the next save. */
export async function loadNotes() {
  const stored = await getValue(STORAGE_KEYS.NOTES);
  const rawList = Array.isArray(stored) ? stored : [];
  const seen = new Set();
  const notes = [];
  let skippedCount = 0;

  for (const raw of rawList) {
    const note = normalizeNote(raw);
    if (note === null || seen.has(note.id)) {
      skippedCount += 1;
      console.warn('[FocusFlow] Skipped an invalid or duplicate note:', raw);
      continue;
    }
    seen.add(note.id);
    notes.push(note);
  }

  cache = notes;
  return { notes, skippedCount };
}

// Mutations run one at a time so two quick saves cannot interleave.
let writeQueue = Promise.resolve();

function mutateNotes(change) {
  const result = writeQueue.then(async () => {
    if (cache === null) await loadNotes();
    const updated = change(cache);
    if (updated !== cache) {
      await setValue(STORAGE_KEYS.NOTES, updated); // cache only changes if this succeeds
      cache = updated;
    }
    return updated;
  });
  writeQueue = result.catch(() => {});
  return result;
}

function requireNote(notes, id) {
  const note = notes.find((candidate) => candidate.id === id);
  if (!note) throw new NoteError('That note no longer exists.', 'not-found');
  return note;
}

/** Creates an empty "Untitled note". Returns { notes, note }. */
export async function createNote() {
  const now = Date.now();
  const note = { id: crypto.randomUUID(), title: DEFAULT_NOTE_TITLE, content: '', createdAt: now, updatedAt: now };
  const notes = await mutateNotes((current) => [...current, note]);
  return { notes, note };
}

/** Validates and saves a note's title and content. Returns the full updated list. */
export async function updateNote(id, draft) {
  const title = validateNoteTitle(draft.title);
  const content = validateNoteContent(draft.content);

  return mutateNotes((notes) => {
    const existing = requireNote(notes, id);
    if (existing.title === title && existing.content === content) return notes; // nothing changed
    return notes.map((note) => (note.id === id ? { ...note, title, content, updatedAt: Date.now() } : note));
  });
}

export async function deleteNote(id) {
  return mutateNotes((notes) => {
    requireNote(notes, id);
    return notes.filter((note) => note.id !== id);
  });
}

/**
 * Debounced autosave controller.
 *  - schedule(id, draft): remember the newest draft and save it after `delayMs` of quiet.
 *  - flush(): save right now. Resolves { ok: true } or { ok: false, error }.
 *  - cancel(): forget the pending draft.
 * A failed save keeps the draft pending, so a later flush retries it.
 * onStatus(kind, detail): kind is 'unsaved' | 'saving' | 'saved' (detail = notes) | 'error' (detail = error).
 */
export function createNoteAutosaver({ save = updateNote, delayMs = 600, onStatus = () => {} } = {}) {
  let pending = null;
  let timerId = null;
  let chain = Promise.resolve({ ok: true });

  function schedule(id, draft) {
    pending = { id, title: draft.title, content: draft.content };
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      void flush();
    }, delayMs);
    onStatus('unsaved');
  }

  function flush() {
    clearTimeout(timerId);
    timerId = null;
    // Chained so two saves never overlap.
    chain = chain.then(async () => {
      if (pending === null) return { ok: true };
      const job = pending;
      pending = null;
      onStatus('saving');
      try {
        const notes = await save(job.id, { title: job.title, content: job.content });
        onStatus(pending === null ? 'saved' : 'unsaved', notes);
        return { ok: true };
      } catch (error) {
        const gone = error instanceof NoteError && error.code === 'not-found';
        if (pending === null && !gone) pending = job; // keep the draft so a retry is possible
        onStatus('error', error);
        return { ok: false, error };
      }
    });
    return chain;
  }

  function cancel() {
    clearTimeout(timerId);
    timerId = null;
    pending = null;
  }

  return { schedule, flush, cancel, hasPending: () => pending !== null };
}