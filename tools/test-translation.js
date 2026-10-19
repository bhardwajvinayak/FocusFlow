// tools/test-translation.js
// Usage (project root):  node tools/test-translation.js
// Loads js/translation-service.js (an ES module) through a temporary .mjs copy.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const temp = path.join(os.tmpdir(), `ff-translation-${process.pid}.mjs`);
fs.copyFileSync(path.join(__dirname, '..', 'js', 'translation-service.js'), temp);

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const good = (text) => jsonResponse({ responseStatus: 200, responseData: { translatedText: text } });

(async () => {
  const svc = await import(pathToFileURL(temp).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const rejects = async (promise, code) => {
    try { await promise; } catch (error) { assert.strictEqual(error.code, code); return; }
    assert.fail(`expected error ${code}`);
  };

  await test('empty and whitespace-only text rejected', async () => {
    assert.throws(() => svc.validateSelection(''), { code: 'empty' });
    assert.throws(() => svc.validateSelection('   \n '), { code: 'empty' });
    assert.throws(() => svc.validateSelection(42), { code: 'invalid-text' });
  });
  await test('oversized text rejected (500 bytes)', async () => {
    assert.strictEqual(svc.validateSelection('a'.repeat(500)).length, 500);
    assert.throws(() => svc.validateSelection('a'.repeat(501)), { code: 'too-long' });
    assert.throws(() => svc.validateSelection('\u0928'.repeat(200)), { code: 'too-long' }); // 3 bytes each
  });
  await test('HTML-like text is passed through as plain text', async () => {
    assert.strictEqual(svc.validateSelection('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  });
  await test('success builds the correct request', async () => {
    let seen;
    const result = await svc.translateText('Hello world', {
      fetchImpl: async (url, options) => { seen = { url: new URL(url), options }; return good('\u0928\u092e\u0938\u094d\u0924\u0947'); },
    });
    assert.strictEqual(result.translation, '\u0928\u092e\u0938\u094d\u0924\u0947');
    assert.strictEqual(seen.url.origin, 'https://api.mymemory.translated.net');
    assert.strictEqual(seen.url.searchParams.get('langpair'), 'en|hi');
    assert.strictEqual(seen.url.searchParams.get('q'), 'Hello world');
    assert.strictEqual(seen.options.credentials, 'omit');
  });
  await test('HTML entities are decoded for display', async () => {
    const r = await svc.translateText('x', { fetchImpl: async () => good('a &amp; b &quot;c&quot; &#39;d&#39;') });
    assert.strictEqual(r.translation, `a & b "c" 'd'`);
  });
  await test('same text is flagged as unchanged', async () => {
    const r = await svc.translateText('Hello', { fetchImpl: async () => good('hello') });
    assert.strictEqual(r.unchanged, true);
  });
  await test('malformed responses rejected', async () => {
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse(null) }), 'invalid-response');
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({ responseStatus: 200, responseData: {} }) }), 'invalid-response');
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({ responseStatus: 200, responseData: { translatedText: '  ' } }) }), 'invalid-response');
    await rejects(svc.translateText('x', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) }), 'invalid-response');
  });
  await test('HTTP 429, HTTP 500 and quota text handled', async () => {
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({}, 429) }), 'rate-limit');
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({}, 500) }), 'http');
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({ responseStatus: 429 }) }), 'rate-limit');
    await rejects(svc.translateText('x', { fetchImpl: async () => good('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY') }), 'quota');
    await rejects(svc.translateText('x', { fetchImpl: async () => jsonResponse({ responseStatus: 403, responseData: { translatedText: 'x' } }) }), 'provider');
  });
  await test('network failure and timeout handled', async () => {
    await rejects(svc.translateText('x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), 'network');
    await rejects(
      svc.translateText('x', {
        timeoutMs: 30,
        fetchImpl: (url, { signal }) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      }),
      'timeout'
    );
  });

  fs.unlinkSync(temp);
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();