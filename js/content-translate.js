// js/content-translate.js
// Result panel injected into the page (closed shadow root, so page CSS cannot affect it and it
// does not touch the page layout). Classic script: NO import/export.
// Selected text arrives by message, is shown with textContent only, and is never stored or logged.

(() => {
  'use strict';
  if (globalThis.__focusflowTranslate) return;

  const HOST_ID = 'focusflow-translate-host';
  const DISPLAY_LIMIT = 300;
  const NOT_RETRYABLE = ['empty', 'too-long', 'invalid-text', 'bad-sender'];

  const CSS = `
    :host { all: initial; }
    .panel {
      --bg:#ffffff; --text:#1f2933; --muted:#616e7c; --border:#d9dee5; --soft:#f7f8fa;
      --accent:#4f46e5; --accent-hover:#4338ca; --on-accent:#ffffff; --danger:#b42318;
      position:fixed; right:16px; bottom:16px; z-index:2147483647; box-sizing:border-box;
      width:min(360px, calc(100vw - 32px)); max-height:min(70vh, 520px); overflow:auto;
      padding:12px 14px; background:var(--bg); color:var(--text); border:1px solid var(--border);
      border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.22); text-align:left;
      font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    }
    .panel[data-theme="dark"] {
      --bg:#1a2029; --text:#e6e9ee; --muted:#9aa5b1; --border:#323b48; --soft:#11151c;
      --accent:#8b86ff; --accent-hover:#a19dff; --on-accent:#10122b; --danger:#ff8a80;
    }
    .head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    h2 { margin:0; font-size:16px; line-height:1.2; }
    h2:focus { outline:none; }
    .label { margin:8px 0 2px; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
    .text { margin:0; padding:6px 8px; background:var(--soft); border:1px solid var(--border);
      border-radius:6px; overflow-wrap:anywhere; white-space:pre-wrap; }
    .result { min-height:1.6em; font-size:16px;
      font-family:"Nirmala UI","Noto Sans Devanagari","Mangal",system-ui,sans-serif; }
    .status { margin:8px 0 0; font-size:12px; color:var(--muted); }
    .status[data-kind="error"] { color:var(--danger); font-weight:600; }
    .notice { margin:8px 0 0; padding:6px 8px; border:1px dashed var(--accent); border-radius:6px; font-size:12px; }
    .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    button { padding:5px 12px; border:1px solid var(--border); border-radius:6px; background:var(--bg);
      color:var(--text); font:inherit; font-size:13px; cursor:pointer; }
    button:hover:not(:disabled) { background:var(--soft); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
    button.primary:hover:not(:disabled) { background:var(--accent-hover); }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    [hidden] { display:none !important; }
  `;

  let host = null;
  let root = null;
  let ui = null;
  let previousFocus = null;
  let requestId = 0;
  let currentText = '';
  let lastTranslation = '';

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = make('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  // Constructable stylesheets are not blocked by a page's style-src policy; fall back to <style>.
  function applyStyles(shadowRoot) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadowRoot.adoptedStyleSheets = [sheet];
    } catch {
      shadowRoot.appendChild(make('style', '', CSS));
    }
  }

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-focusflow-owned', 'translate-panel');
    root = host.attachShadow({ mode: 'closed' });
    applyStyles(root);

    const panel = make('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'ff-title');
    panel.dataset.theme = 'light';

    const title = make('h2', '', 'Translate to Hindi');
    title.id = 'ff-title';
    title.tabIndex = -1;
    const close = button('Close', '', closePanel);
    close.setAttribute('aria-label', 'Close translation panel');
    const head = make('div', 'head');
    head.append(title, close);

    const originalLabel = make('p', 'label', 'English (original)');
    const original = make('p', 'text');
    const resultLabel = make('p', 'label', 'Hindi');
    const result = make('p', 'text result');
    result.lang = 'hi';
    const status = make('p', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const notice = make('p', 'notice');
    notice.hidden = true;

    const accept = button('Accept and translate', 'primary', () => void run(true));
    const copy = button('Copy translation', 'primary', () => void copyResult());
    const retry = button('Retry', '', () => void run(false));
    const actions = make('div', 'actions');
    actions.append(accept, copy, retry);

    panel.append(head, originalLabel, original, resultLabel, result, status, notice, actions);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePanel();
      }
    });
    root.appendChild(panel);
    ui = { panel, title, original, result, status, notice, accept, copy, retry };
    document.documentElement.appendChild(host);

    try {
      chrome.storage.local.get('settings').then((stored) => {
        const theme = stored && stored.settings && stored.settings.theme;
        if (ui) ui.panel.dataset.theme = theme === 'dark' ? 'dark' : 'light';
      }, () => {});
    } catch {
      /* keep the light theme */
    }
  }

  function setState(state, message) {
    ui.status.textContent = message || '';
    ui.status.dataset.kind = state === 'error' ? 'error' : '';
    ui.notice.hidden = state !== 'consent';
    ui.accept.hidden = state !== 'consent';
    ui.retry.hidden = true;
    ui.copy.disabled = state !== 'success';
    if (state !== 'success') {
      ui.result.textContent = '';
      lastTranslation = '';
    }
  }

  async function run(acceptPrivacy) {
    const id = ++requestId;
    setState('loading', 'Translating\u2026');
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'ff-translate',
        text: currentText,
        acceptPrivacy: acceptPrivacy === true,
      });
    } catch {
      response = {
        ok: false,
        code: 'extension',
        message: 'FocusFlow could not reach its background service. Reload this page and try again.',
      };
    }
    if (id !== requestId || !host) return; // a newer selection replaced this request, or the panel was closed

    if (!response || typeof response !== 'object') {
      setState('error', 'FocusFlow received an unexpected answer. Please try again.');
      ui.retry.hidden = false;
      return;
    }
    if (response.ok === true && typeof response.translation === 'string') {
      setState('success', 'Translation ready.');
      lastTranslation = response.translation;
      ui.result.textContent = response.translation; // textContent only
      if (response.unchanged) {
        ui.status.textContent =
          'The service returned the same text. The selection may not be English, or no translation was found.';
      }
      return;
    }
    if (response.code === 'needs-consent') {
      setState('consent', 'Please read this notice before the first translation.');
      ui.notice.textContent = String(response.message || '');
      ui.accept.focus();
      return;
    }
    setState('error', String(response.message || 'Translation failed. Please try again.'));
    ui.retry.hidden = NOT_RETRYABLE.includes(response.code);
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    root.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }

  async function copyResult() {
    if (!lastTranslation) return;
    try {
      await navigator.clipboard.writeText(lastTranslation);
    } catch {
      if (!fallbackCopy(lastTranslation)) {
        ui.status.textContent = 'Copying was blocked by this page. Select the Hindi text and copy it manually.';
        ui.status.dataset.kind = 'error';
        return;
      }
    }
    ui.status.textContent = 'Translation copied to the clipboard.';
    ui.status.dataset.kind = '';
  }

  function closePanel() {
    requestId += 1; // ignore any answer that arrives later
    if (host) host.remove();
    host = null;
    root = null;
    ui = null;
    currentText = '';
    lastTranslation = '';
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        /* the element may be gone */
      }
    }
    previousFocus = null;
  }

  function open(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!host) {
      previousFocus = document.activeElement;
      build();
    }
    currentText = text;
    ui.original.textContent = text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT)}\u2026` : text;
    ui.title.focus();
    void run(false);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message && message.type === 'ff-open-panel') {
      open(message.text);
      sendResponse({ ok: true });
    }
  });

  globalThis.__focusflowTranslate = Object.freeze({ open });
})();