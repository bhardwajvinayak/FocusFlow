// tools/test-report-export.js
// Usage (project root):  node tools/test-report-export.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-export-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['focus-intelligence.js', 'goals.js', 'report.js', 'habits.js', 'insights.js', 'report-export.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', f), path.join(dir, f));
}

const NOW = new Date(2026, 9, 22, 14, 0, 0);
const ts = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();

(async () => {
  const { buildProductivityInsights } = await import(pathToFileURL(path.join(dir, 'insights.js')).href);
  const x = await import(pathToFileURL(path.join(dir, 'report-export.js')).href);
  const insights = buildProductivityInsights({
    sessions: [{ id: 'a', durationSeconds: 1500, completedAt: ts(10, 19) }, { id: 'b', durationSeconds: 3000, completedAt: ts(10, 21) }],
    tasks: [{ id: 't', completed: true, createdAt: ts(10, 1), completedAt: ts(10, 21) }],
    habits: [{ id: 'h', name: 'SecretHabit (x)', createdAt: ts(10, 1), archivedAt: null, completions: ['2026-10-19', '2026-10-21'] }],
    evidenceTimestamps: [ts(10, 1)],
    now: NOW,
  });
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  };
  const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

  await test('CSV: one header, seven rows, stable columns and blanks for missing data', () => {
    const lines = x.productivityCsv(insights).split('\r\n');
    assert.strictEqual(lines.length, 9); // header + 7 rows + empty after the final CRLF
    assert.strictEqual(lines[0], 'date,weekday,status,focus_minutes,sessions,tasks_completed,habits_done,habits_tracked');
    assert.strictEqual(lines[1], '2026-10-19,Monday,recorded,25,1,0,1,1');
    assert.strictEqual(lines[2], '2026-10-20,Tuesday,none,0,0,0,0,1');
    assert.strictEqual(lines[3], '2026-10-21,Wednesday,recorded,50,1,1,1,1');
    assert.strictEqual(lines[5], '2026-10-23,Friday,unavailable,,,,,');
    assert.strictEqual(x.productivityCsv(null), '');
    assert.strictEqual(x.productivityCsv({ days: [] }), '');
  });

  await test('CSV contains totals only: no habit names or task titles', () => {
    assert.ok(!x.productivityCsv(insights).includes('SecretHabit'));
    assert.ok(/^[0-9A-Za-z,\r\n_-]*$/.test(x.productivityCsv(insights)));
  });

  await test('CSV escaping, Unicode and formula-injection protection use the shared escaper', async () => {
    const report = await import(pathToFileURL(path.join(dir, 'report.js')).href);
    assert.strictEqual(report.csvField('a,b'), '"a,b"');
    assert.strictEqual(report.csvField('say "hi"'), '"say ""hi"""');
    assert.strictEqual(report.csvField('line1\nline2'), '"line1\nline2"');
    assert.strictEqual(report.csvField('\u0928\u092e\u0938\u094d\u0924\u0947'), '\u0928\u092e\u0938\u094d\u0924\u0947');
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x']) assert.strictEqual(report.csvField(bad), `'${bad}`);
  });

  await test('filenames contain the report period', () => {
    assert.strictEqual(x.productivityCsvFilename(insights), 'focusflow-productivity-2026-10-19_to_2026-10-25.csv');
    assert.strictEqual(x.productivityPdfFilename(insights), 'focusflow-productivity-2026-10-19_to_2026-10-25.pdf');
    assert.strictEqual(x.productivityCsvFilename(null), 'focusflow-productivity.csv');
  });

  await test('PDF is structurally valid: header, trailer, xref offsets and stream length', () => {
    const pdf = latin1(x.buildProductivityPdf(insights, { generatedAt: NOW }));
    assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.trimEnd().endsWith('%%EOF'));
    const start = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
    assert.ok(pdf.slice(start).startsWith('xref'));
    const entries = pdf.slice(start).split('\n').slice(3, 9);
    entries.forEach((line, i) => {
      assert.strictEqual(line.length, 19);
      assert.ok(pdf.slice(Number(line.slice(0, 10))).startsWith(`${i + 1} 0 obj`));
    });
    const length = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)[1]);
    const body = pdf.slice(pdf.indexOf('stream\n') + 7);
    assert.strictEqual(body.slice(0, length).length, length);
    assert.ok(body.slice(length).startsWith('\nendstream'));
  });

  await test('PDF shows the period, summary, chart bars and daily rows; habit names are absent', () => {
    const pdf = latin1(x.buildProductivityPdf(insights, { generatedAt: NOW }));
    assert.ok(pdf.includes('2026-10-19 to 2026-10-25'));
    assert.ok(pdf.includes('weekly productivity report'));
    assert.ok(pdf.includes('Focus minutes per day'));
    assert.ok(pdf.includes(' re f'));
    assert.ok(pdf.includes('(2026-10-21) Tj'));
    assert.ok(pdf.includes('Generated on 2026-10-22'));
    assert.ok(!pdf.includes('SecretHabit'));
  });

  await test('PDF text is escaped and limited to Latin-1', () => {
    const odd = JSON.parse(JSON.stringify(insights));
    odd.lines = [{ id: 'x', text: 'Test (parens) back\\slash \u0928\u092e\u0938\u094d\u0924\u0947 \u{1F600}' }];
    const bytes = x.buildProductivityPdf(odd, { generatedAt: NOW });
    assert.ok(bytes instanceof Uint8Array);
    const pdf = latin1(bytes);
    assert.ok(pdf.includes('Test \\(parens\\) back\\\\slash ??????? ?'.replace('???????', '??????')) || pdf.includes('Test \\(parens\\) back\\\\slash'));
    assert.ok(Array.from(bytes).every((b) => b < 256));
  });

  await test('invalid input returns null without throwing', () => {
    assert.strictEqual(x.buildProductivityPdf(null), null);
    assert.strictEqual(x.buildProductivityPdf({ days: [] }), null);
    assert.doesNotThrow(() => x.buildProductivityPdf(insights, { generatedAt: 'nope' }));
  });

  await test('empty data still produces a valid report, with blanks rather than zeros', () => {
    const empty = buildProductivityInsights({ now: NOW });
    const csv = x.productivityCsv(empty).split('\r\n');
    assert.strictEqual(csv[1], '2026-10-19,Monday,unavailable,,,,,');
    assert.strictEqual(csv[4], '2026-10-22,Thursday,none,0,0,,,');
    assert.ok(x.buildProductivityPdf(empty, { generatedAt: NOW }).length > 500);
  });

  await test('exports do not modify their input and are deterministic', () => {
    const copy = JSON.stringify(insights);
    x.productivityCsv(insights);
    x.buildProductivityPdf(insights, { generatedAt: NOW });
    assert.strictEqual(JSON.stringify(insights), copy);
    assert.strictEqual(x.productivityCsv(insights), x.productivityCsv(insights));
    assert.deepStrictEqual(Array.from(x.buildProductivityPdf(insights, { generatedAt: NOW })), Array.from(x.buildProductivityPdf(insights, { generatedAt: NOW })));
  });

  await test('export modules make no network, storage or browser API calls', () => {
    for (const f of ['report-export.js', 'insights.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
      assert.ok(!/(fetch\(|XMLHttpRequest|chrome\.|localStorage|document\.|import\(|https?:\/\/)/.test(src), f);
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();