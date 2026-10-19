// js/eye-page.js
// Applies the warm filter and reading colours to the CURRENT tab. Popup only.
//
// Uses chrome.scripting.executeScript with a function that ships inside this extension
// (no remote code, no eval). It only runs after the user opens the Eyes tab or uses one of
// its controls, and only on the active tab (permission: activeTab).

import { DEFAULT_EYE_COMFORT, EYE_COMFORT_LIMITS } from './storage.js';

export class EyePageError extends Error {
  /** code: 'no-tab' | 'restricted' | 'permission' | 'failed' */
  constructor(message, code) {
    super(message);
    this.name = 'EyePageError';
    this.code = code;
  }
}

const MESSAGES = {
  noTab: 'FocusFlow could not find the current tab.',
  restricted:
    'Chrome does not let extensions change this kind of page (for example chrome:// pages, the Chrome ' +
    'Web Store, other extensions\' pages and some built-in viewers). Open a regular website to use these tools.',
  permission:
    'FocusFlow does not have permission to change this page right now. This happens after the page reloads ' +
    'or navigates. Close this popup and click the FocusFlow icon again while you are on the page. ' +
    'Local files also need "Allow access to file URLs" turned on in the extension\'s details.',
  unsupportedDocument: 'This page is not a standard web page, so it cannot be changed.',
  failed: 'The page could not be changed. It may still be loading or may have been closed. Please try again.',
};

const RESTRICTED_PROTOCOLS = [
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'edge:',
  'about:', 'view-source:', 'devtools:', 'data:', 'blob:', 'javascript:',
];

/* ------------------------------------------------------------------ */
/* Runs INSIDE the webpage. It must be fully self-contained: it cannot use imports,     */
/* variables from this file, or anything else outside its own body.                     */
/* config (all parts optional; null = only report the current state):                   */
/*   { filter: { on, intensity }, reading: { on } }                                     */
/* ------------------------------------------------------------------ */

function injectedSync(config) {
  const OWNER_ATTR = 'data-focusflow-owned';
  const OWNER_VALUE = 'eye-filter';
  const READING_ATTR = 'data-focusflow-reading';
  const STORE_KEY = '__focusflowEyeReadingStore';
  const READING_BG = '#f4ecd8';
  const READING_FG = '#2e2a24';

  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'html') {
    return { ok: false, reason: 'unsupported-document' };
  }

  const findOverlay = () => document.querySelector('[' + OWNER_ATTR + '="' + OWNER_VALUE + '"]');

  function parseColor(value) {
    const match = /^rgba?\(([^)]+)\)$/.exec(String(value || '').trim());
    if (!match) return null;
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function brightness(color) {
    return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255; // approximate, 0..1
  }

  // Pages that already have a dark look are left alone: replacing only the body colours there
  // would leave light text on a light background.
  function looksDark(body) {
    const solid = (el) => {
      const color = parseColor(getComputedStyle(el).backgroundColor);
      return color && color.a > 0.05 ? color : null;
    };
    const background = solid(body) || solid(root);
    if (background) return brightness(background) < 0.4;
    const text = parseColor(getComputedStyle(body).color);
    return Boolean(text) && brightness(text) > 0.6;
  }

  /* ---------- warm filter ---------- */
  if (config && config.filter) {
    let overlay = findOverlay();
    if (config.filter.on) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'focusflow-eye-filter';
        overlay.setAttribute(OWNER_ATTR, OWNER_VALUE);
        overlay.setAttribute('aria-hidden', 'true');
        const rules = {
          position: 'fixed',
          top: '0',
          right: '0',
          bottom: '0',
          left: '0',
          margin: '0',
          padding: '0',
          border: '0',
          display: 'block',
          visibility: 'visible',
          background: 'rgb(255, 147, 41)',
          'mix-blend-mode': 'multiply',
          'pointer-events': 'none', // never intercepts clicks, typing, links or scrolling
          'z-index': '2147483647',
        };
        for (const [name, value] of Object.entries(rules)) {
          overlay.style.setProperty(name, value, 'important');
        }
        root.appendChild(overlay);
      }
      const percent = Math.min(100, Math.max(0, Number(config.filter.intensity) || 0));
      overlay.style.setProperty('opacity', String(percent / 100), 'important');
    } else if (overlay) {
      overlay.remove();
    }
  }

  /* ---------- reading colours ---------- */
  let readingSkipped = '';
  if (config && config.reading) {
    const isOn = root.getAttribute(READING_ATTR) === '1';
    const body = document.body;

    if (config.reading.on && !isOn) {
      if (!body) {
        readingSkipped = 'no-body';
      } else if (looksDark(body)) {
        readingSkipped = 'dark-page';
      } else {
        // Remember the page's own inline values so removal restores exactly what was there.
        const saved = [];
        for (const el of [root, body]) {
          for (const prop of ['background-color', 'color']) {
            saved.push({
              el,
              prop,
              value: el.style.getPropertyValue(prop),
              priority: el.style.getPropertyPriority(prop),
            });
          }
        }
        globalThis[STORE_KEY] = saved;
        for (const el of [root, body]) {
          el.style.setProperty('background-color', READING_BG, 'important');
          el.style.setProperty('color', READING_FG, 'important');
        }
        root.setAttribute(READING_ATTR, '1');
      }
    } else if (!config.reading.on && isOn) {
      const saved = globalThis[STORE_KEY];
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (!item.el.isConnected) continue;
          if (item.value) item.el.style.setProperty(item.prop, item.value, item.priority);
          else item.el.style.removeProperty(item.prop);
        }
      } else {
        for (const el of [root, body]) {
          if (!el) continue;
          el.style.removeProperty('background-color');
          el.style.removeProperty('color');
        }
      }
      globalThis[STORE_KEY] = undefined;
      root.removeAttribute(READING_ATTR);
    }
  }

  /* ---------- report the resulting state ---------- */
  const overlay = findOverlay();
  const opacity = overlay ? parseFloat(overlay.style.getPropertyValue('opacity')) : NaN;
  return {
    ok: true,
    filterActive: Boolean(overlay),
    intensity: Number.isFinite(opacity) ? Math.round(opacity * 100) : null,
    readingActive: root.getAttribute(READING_ATTR) === '1',
    readingSkipped,
  };
}

/* ------------------------------------------------------------------ */
/* Popup side                                                          */
/* ------------------------------------------------------------------ */

// Page operations run one at a time so quick clicks cannot interleave.
let queue = Promise.resolve();

function runExclusive(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

async function getActiveTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    console.error('[FocusFlow] Could not query tabs:', error);
    throw new EyePageError(MESSAGES.noTab, 'no-tab');
  }
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') throw new EyePageError(MESSAGES.noTab, 'no-tab');
  return tab;
}

/** Decides from the URL whether the tab can be changed. An unknown URL is allowed (we just try). */
function describeTab(tab) {
  const url = typeof tab.url === 'string' ? tab.url : '';
  if (url === '') return { supported: true, hostname: '' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { supported: false, hostname: '' };
  }
  if (RESTRICTED_PROTOCOLS.includes(parsed.protocol)) return { supported: false, hostname: '' };

  const isWebStore =
    parsed.hostname === 'chromewebstore.google.com' ||
    (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  if (isWebStore) return { supported: false, hostname: '' };

  return { supported: true, hostname: parsed.hostname || 'a local file' };
}

function mapScriptingError(error) {
  const text = String((error && error.message) || error);
  if (/chrome:\/\/|extensions gallery|cannot be scripted/i.test(text)) {
    return new EyePageError(MESSAGES.restricted, 'restricted');
  }
  if (/cannot access|must request permission|activeTab/i.test(text)) {
    return new EyePageError(MESSAGES.permission, 'permission');
  }
  console.error('[FocusFlow] Page script failed:', error);
  return new EyePageError(MESSAGES.failed, 'failed');
}

/** Clamps and normalizes values before they are sent into the page. */
function sanitizeConfig(config) {
  if (!config) return null;
  const clean = {};
  if (config.filter) {
    const { min, max } = EYE_COMFORT_LIMITS.filterIntensity;
    const number = Math.round(Number(config.filter.intensity));
    clean.filter = {
      on: config.filter.on === true,
      intensity: Number.isFinite(number)
        ? Math.min(max, Math.max(min, number))
        : DEFAULT_EYE_COMFORT.filterIntensity,
    };
  }
  if (config.reading) clean.reading = { on: config.reading.on === true };
  return clean;
}

async function run(config) {
  const tab = await getActiveTab();
  const info = describeTab(tab);
  if (!info.supported) throw new EyePageError(MESSAGES.restricted, 'restricted');

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedSync,
      args: [sanitizeConfig(config)],
    });
  } catch (error) {
    throw mapScriptingError(error);
  }

  const result = results && results[0] ? results[0].result : null;
  if (!result || result.ok !== true) {
    const message =
      result && result.reason === 'unsupported-document' ? MESSAGES.unsupportedDocument : MESSAGES.failed;
    throw new EyePageError(message, 'failed');
  }
  return { hostname: info.hostname, ...result };
}

/** Read-only: reports whether the filter / reading colours are currently on for this tab. */
export function readPage() {
  return runExclusive(() => run(null));
}

/** Applies { filter: { on, intensity }, reading: { on } } (either part optional). Returns the new state. */
export function changePage(config) {
  return runExclusive(() => run(config));
}