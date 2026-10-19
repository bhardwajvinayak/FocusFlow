// js/content-selection.js
// Floating "Translate" button near selected text. Registered only after the user turns on the
// floating button in Settings and grants site access. Classic script: NO import/export.
// It reads only the current selection, never page content, and sends nothing until the user
// clicks the button (or presses Alt+Shift+H while it is visible).

(() => {
  'use strict';
  if (globalThis.__focusflowSelection) return;
  globalThis.__focusflowSelection = true;

  const MAX_SHOW_CHARS = 2000; // longer selections show no button (the panel rejects > 500 bytes anyway)
  const CSS = `
    :host { all: initial; }
    button {
      position:fixed; z-index:2147483647; padding:4px 10px; border:1px solid #4f46e5; border-radius:6px;
      background:#4f46e5; color:#ffffff; font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
      cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.25);
    }
    button:hover { background:#4338ca; }
    button:focus-visible { outline:2px solid #ffffff; outline-offset:2px; box-shadow:0 0 0 4px #4f46e5; }
  `;

  let host = null;
  let control = null;
  let pendingText = '';

  function ensureButton() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-focusflow-owned', 'translate-button');
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
    control = document.createElement('button');
    control.type = 'button';
    control.textContent = 'Translate';
    control.setAttribute('aria-label', 'Translate selected text to Hindi');
    control.title = 'Translate to Hindi (Alt+Shift+H)';
    control.addEventListener('mousedown', (event) => event.preventDefault()); // keep the selection
    control.addEventListener('click', activate);
    root.appendChild(control);
  }

  function hide() {
    pendingText = '';
    if (host && host.isConnected) host.remove();
  }

  function show(text, rect) {
    ensureButton();
    pendingText = text;
    const width = 90;
    const left = Math.min(Math.max(8, rect.right), Math.max(8, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    const top = below + 34 > window.innerHeight ? Math.max(8, rect.top - 38) : below;
    control.style.left = `${Math.round(left)}px`;
    control.style.top = `${Math.round(top)}px`;
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function inEditableContext(selection) {
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return true;
    const node = selection.anchorNode;
    const element = node && (node.nodeType === 1 ? node : node.parentElement);
    return Boolean(
      element && (element.isContentEditable ||
        element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
    );
  }

  function evaluate() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return hide();
    if (inEditableContext(selection)) return hide(); // never over form fields or password inputs
    const text = selection.toString().trim();
    if (text === '' || text.length > MAX_SHOW_CHARS) return hide();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return hide();
    show(text, rect);
  }

  function activate() {
    const text = pendingText;
    hide();
    const api = globalThis.__focusflowTranslate;
    if (api && text) api.open(text);
  }

  document.addEventListener('mouseup', () => setTimeout(evaluate, 10), true);
  document.addEventListener('keyup', (event) => {
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Shift' || key.startsWith('Arrow') || key === 'a' || key === 'A') {
      setTimeout(evaluate, 10);
    }
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (host && !event.composedPath().includes(host)) hide();
  }, true);
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hide();
  });
   document.addEventListener('keydown', (event) => {
    if (!host || !host.isConnected) return;
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Escape') hide();
    else if (event.altKey && event.shiftKey && key.toLowerCase() === 'h') {
      event.preventDefault();
      activate();
    }
  }, true);
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide, { passive: true });
})();