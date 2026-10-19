// js/translation-service.js
// Provider configuration, input validation and the network call. NO DOM code and NO chrome.* calls,
// so it can be unit-tested in Node. Used by the service worker only.
// Privacy: never log the text or the translation from this file.

export const TRANSLATION_PROVIDER = Object.freeze({
  name: 'MyMemory',
  endpoint: 'https://api.mymemory.translated.net/get',
  sourceLanguage: 'en',
  targetLanguage: 'hi',
  maxBytes: 500,      // per the provider's API specification
  timeoutMs: 10000,
  contactEmail: '',   // optional. If set, it is sent as "de" and the provider raises the daily quota.
});

export const PRIVACY_NOTICE =
  'The text you select is sent over HTTPS to MyMemory (api.mymemory.translated.net), a third-party ' +
  'translation service, so it can be translated. FocusFlow does not store or log it. Do not translate ' +
  'private or sensitive text. The free service has a daily limit.';

export class TranslationError extends Error {
  /** code: invalid-text | empty | too-long | timeout | network | http | rate-limit | quota | provider | invalid-response */
  constructor(message, code) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const HARD_INPUT_LIMIT = 5000; // refuse absurdly large input before doing any work

/** Collapses whitespace, trims and enforces the provider's byte limit. Returns the clean text. */
export function validateSelection(raw) {
  if (typeof raw !== 'string') throw new TranslationError('The selection must be text.', 'invalid-text');
  if (raw.length > HARD_INPUT_LIMIT) {
    throw new TranslationError('The selection is too long. Select a shorter passage (under about 500 characters).', 'too-long');
  }
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') throw new TranslationError('No text is selected. Select some English text first.', 'empty');

  const bytes = encoder.encode(text).length;
  if (bytes > TRANSLATION_PROVIDER.maxBytes) {
    throw new TranslationError(
      `The selection is too long (${text.length} characters, ${bytes} bytes). The free service accepts up to ` +
        `${TRANSLATION_PROVIDER.maxBytes} bytes at a time. Select a shorter passage.`,
      'too-long'
    );
  }
  return text;
}

const NAMED_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** Providers sometimes return HTML entities. The result is shown with textContent, so this is display-only. */
function decodeBasicEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);|&#(\d{1,6});/g, (match, number) => {
    if (NAMED_ENTITIES[match]) return NAMED_ENTITIES[match];
    try {
      return String.fromCodePoint(Number(number));
    } catch {
      return match;
    }
  });
}

/** Validates the provider's JSON. Returns { translation, unchanged } or throws TranslationError. */
export function parseResponse(data, sourceText) {
  if (typeof data !== 'object' || data === null) {
    throw new TranslationError('The translation service sent an unexpected response.', 'invalid-response');
  }
  const status = Number(data.responseStatus);
  if (status === 429) {
    throw new TranslationError('The translation service is limiting requests. Please wait and try again.', 'rate-limit');
  }

  const translated = data.responseData && data.responseData.translatedText;
  if (typeof translated === 'string' && /MYMEMORY WARNING/i.test(translated)) {
    throw new TranslationError('The free daily translation limit has been reached. Try again tomorrow.', 'quota');
  }
  if (status !== 200) {
    throw new TranslationError('The translation service could not translate this text.', 'provider');
  }
  if (typeof translated !== 'string' || translated.trim() === '') {
    throw new TranslationError('The translation service returned an empty result.', 'invalid-response');
  }

  const translation = decodeBasicEntities(translated).trim();
  const unchanged = translation.toLowerCase() === String(sourceText).trim().toLowerCase();
  return { translation, unchanged };
}

/**
 * Translates validated text. options (for tests): { fetchImpl, timeoutMs }.
 * Resolves { translation, unchanged, provider } or throws TranslationError.
 */
export async function translateText(rawText, options = {}) {
  const text = validateSelection(rawText);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || TRANSLATION_PROVIDER.timeoutMs;

  const url = new URL(TRANSLATION_PROVIDER.endpoint);
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${TRANSLATION_PROVIDER.sourceLanguage}|${TRANSLATION_PROVIDER.targetLanguage}`);
  if (TRANSLATION_PROVIDER.contactEmail) url.searchParams.set('de', TRANSLATION_PROVIDER.contactEmail);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new TranslationError('The translation service took too long to answer. Please try again.', 'timeout');
      }
      throw new TranslationError('Could not reach the translation service. Check your internet connection.', 'network');
    }

    if (response.status === 429) {
      throw new TranslationError('The translation service is limiting requests. Please wait and try again.', 'rate-limit');
    }
    if (!response.ok) {
      throw new TranslationError(`The translation service returned an error (HTTP ${response.status}).`, 'http');
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new TranslationError('The translation service took too long to answer. Please try again.', 'timeout');
      }
      throw new TranslationError('The translation service sent an unreadable response.', 'invalid-response');
    }

    return { ...parseResponse(data, text), provider: TRANSLATION_PROVIDER.name };
  } finally {
    clearTimeout(timer);
  }
}