// tools/test-focus-intelligence.js
// Usage (project root):  node tools/test-focus-intelligence.js
// Loads js/focus-intelligence.js (an ES module) through a temporary .mjs copy. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const temp = path.join(os.tmpdir(), `ff-fi-${process.pid}.mjs`);
fs.copyFileSync(path.join(__dirname, '..', 'js', 'focus-intelligence.js'), temp);

// Thursday 22 Oct 2026, 14:00 local. Its week runs Mon 19 Oct to Sun 25 Oct.
const NOW = new Date(2026, 9, 22, 14, 0, 0);
const ts = (m, d, h = 12, mi = 0, s = 0) => new Date(2026, m - 1, d, h, mi, s).getTime();
const ses = (id, m, d, seconds = 1500, h = 12) => ({ id, durationSeconds: seconds, completedAt: ts(m, d, h), dev: false });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const { computeFocusIntelligence, formatDayLabel } = await import(pathToFileURL(temp).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const run = (sessions, extra = {}, now = NOW) => computeFocusIntelligence({ sessions, now, ...extra });
  const cells = (r) => r.heatmap.weeks.flat();
  const cell = (r, key) => cells(r).find((c) => c.date === key);
  const ids = (r) => r.insights.map((i) => i.id);

  // Reused data: last week has 2 sessions, this week 2, plus one session dated after "today".
  const D = [ses('p1', 10, 12), ses('p2', 10, 17), ses('t1', 10, 19), ses('t2', 10, 22, 3000), ses('f1', 10, 24)];

  await test('empty history: honest zeros, no trends, past days unavailable', () => {
    const r = run([]);
    assert.strictEqual(r.totals.sessions, 0);
    assert.strictEqual(r.totals.averageMinutes, null);
    assert.strictEqual(r.bestDay, null);
    assert.strictEqual(r.comparison, null);
    assert.deepStrictEqual(ids(r), ['no-history']);
    assert.strictEqual(r.heatmap.weeks.length, 4);
    assert.ok(r.heatmap.weeks.every((w) => w.length === 7));
    const count = (s) => cells(r).filter((c) => c.status === s).length;
    assert.strictEqual(count('unavailable'), 24);
    assert.strictEqual(count('none'), 1); // today
    assert.strictEqual(count('future'), 3);
    assert.strictEqual(count('recorded'), 0);
  });

  await test('invalid or future evidence timestamps are ignored', () => {
    const r = run([], { evidenceTimestamps: [NaN, 'x', null, Infinity, ts(12, 1)] });
    assert.strictEqual(r.evidence.startKey, '2026-10-22');
  });

  await test('daily aggregation and unavailable-versus-none distinction', () => {
    const r = run([ses('a', 10, 20, 1500), ses('b', 10, 20, 600), ses('c', 10, 21, 1500)]);
    assert.deepStrictEqual(r.daily, [
      { date: '2026-10-20', minutes: 35, sessions: 2 },
      { date: '2026-10-21', minutes: 25, sessions: 1 },
    ]);
    assert.strictEqual(cell(r, '2026-10-20').status, 'recorded');
    assert.strictEqual(cell(r, '2026-10-20').minutes, 35);
    assert.strictEqual(cell(r, '2026-10-19').status, 'unavailable'); // before the first record
    assert.strictEqual(cell(r, '2026-10-22').status, 'none');        // today, nothing recorded yet
    assert.strictEqual(cell(r, '2026-10-23').status, 'future');
  });

  await test('weekly totals (week to date) and the full previous week', () => {
    const r = run(D);
    assert.strictEqual(r.skipped.future, 1);
    assert.strictEqual(r.totals.sessions, 4);
    assert.strictEqual(r.thisWeek.startKey, '2026-10-19');
    assert.strictEqual(r.thisWeek.throughKey, '2026-10-22');
    assert.strictEqual(r.thisWeek.daysElapsed, 4);
    assert.strictEqual(r.thisWeek.minutes, 75);
    assert.strictEqual(r.thisWeek.sessions, 2);
    assert.strictEqual(r.previousWeek.startKey, '2026-10-12');
    assert.strictEqual(r.previousWeek.endKey, '2026-10-18');
    assert.strictEqual(r.previousWeek.minutes, 50);
    assert.strictEqual(r.previousWeek.sessions, 2);
  });

  await test('previous-week comparison uses the same weekdays', () => {
    const r = run(D);
    assert.strictEqual(r.previousWeek.samePeriodMinutes, 25); // Mon 12 only; Sat 17 is outside Mon-Thu
    assert.deepStrictEqual(r.comparison, { thisMinutes: 75, previousMinutes: 25, deltaMinutes: 50, percent: 200 });
    assert.ok(r.insights.find((i) => i.id === 'week-vs-last').text.includes('50 min more'));
  });

  await test('comparison: decrease, previous zero, both zero, and not enough history', () => {
    const down = run([ses('a', 10, 12, 3000), ses('b', 10, 19, 1500)]);
    assert.strictEqual(down.comparison.deltaMinutes, -25);
    assert.ok(down.insights.find((i) => i.id === 'week-vs-last').text.includes('25 min less'));

    const fromZero = run([ses('a', 10, 20)], { evidenceTimestamps: [ts(10, 1)] });
    assert.deepStrictEqual(fromZero.comparison, { thisMinutes: 25, previousMinutes: 0, deltaMinutes: 25, percent: null });

    const bothZero = run([], { evidenceTimestamps: [ts(10, 1)] });
    assert.strictEqual(bothZero.comparison.deltaMinutes, 0);
    assert.ok(!ids(bothZero).includes('week-vs-last'));

    const young = run([ses('x', 10, 14)]); // history starts after last Monday (12 Oct)
    assert.strictEqual(young.comparison, null);
    assert.ok(young.comparisonNote.includes('history'));
    assert.strictEqual(young.previousWeek.covered, false);
  });

  await test('week boundaries: Sunday night, Monday morning, and a daylight-saving week', () => {
    const sundayNight = new Date(2026, 9, 25, 23, 59, 30);
    const a = run([ses('s', 10, 25, 1500, 23)], {}, sundayNight);
    assert.strictEqual(a.thisWeek.startKey, '2026-10-19');
    assert.strictEqual(a.thisWeek.daysElapsed, 7);
    assert.strictEqual(a.thisWeek.minutes, 25);

    const mondayMorning = new Date(2026, 9, 26, 0, 0, 10);
    const b = run([ses('s', 10, 25, 1500, 23), { id: 'm', durationSeconds: 600, completedAt: ts(10, 26, 0, 0, 5) }], {}, mondayMorning);
    assert.strictEqual(b.thisWeek.startKey, '2026-10-26');
    assert.strictEqual(b.thisWeek.daysElapsed, 1);
    assert.strictEqual(b.thisWeek.minutes, 10);
    assert.strictEqual(b.previousWeek.startKey, '2026-10-19');
    assert.strictEqual(b.previousWeek.minutes, 25); // the Sunday session

    const dst = run([], {}, new Date(2026, 10, 4, 12)); // US clocks change on 1 Nov
    assert.strictEqual(dst.thisWeek.startKey, '2026-11-02');
    assert.strictEqual(dst.heatmap.startKey, '2026-10-12');
    assert.strictEqual(dst.heatmap.endKey, '2026-11-08');
    const expected = [];
    for (let i = 0; i < 28; i += 1) expected.push(new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10));
    assert.deepStrictEqual(cells(dst).map((c) => c.date), expected);
  });

  await test('average session duration', () => {
    const a = run([ses('a', 10, 19, 1500), ses('b', 10, 20, 1500), ses('c', 10, 21, 600)]);
    assert.strictEqual(a.totals.averageMinutes, 20);
    const b = run([ses('a', 10, 19, 1500), ses('b', 10, 20, 1500), ses('c', 10, 21, 1800)]);
    assert.strictEqual(b.totals.averageMinutes, 26.7);
    assert.ok(ids(b).includes('average'));
    assert.ok(!ids(run([ses('a', 10, 19), ses('b', 10, 20)])).includes('average')); // needs 3 sessions
  });

  await test('best focus day, ties, and the 3-active-day minimum', () => {
    const tie = run([ses('a', 10, 19, 1500), ses('b', 10, 20, 3000), ses('c', 10, 21, 3000)]);
    assert.deepStrictEqual(tie.bestDay, { dates: ['2026-10-20', '2026-10-21'], minutes: 50, tied: true });
    const text = tie.insights.find((i) => i.id === 'best-day').text;
    assert.ok(text.includes('tied') && text.includes('Wed 21 Oct'));

    const single = run([ses('a', 10, 19, 1500), ses('b', 10, 20, 3000), ses('c', 10, 21, 3000), ses('d', 10, 21, 1500)]);
    assert.deepStrictEqual(single.bestDay, { dates: ['2026-10-21'], minutes: 75, tied: false });

    assert.strictEqual(run([ses('a', 10, 19), ses('b', 10, 20)]).bestDay, null);
    assert.strictEqual(formatDayLabel('2026-10-21'), 'Wed 21 Oct');
  });

  await test('missing or invalid timestamps are skipped and counted', () => {
    const bad = [NaN, 'x', null, undefined, Infinity, 1e20, -1e20].map((completedAt, i) => ({ id: `b${i}`, durationSeconds: 1500, completedAt }));
    const r = run([...bad, ses('ok', 10, 20)]);
    assert.strictEqual(r.skipped.invalid, 7);
    assert.strictEqual(r.totals.sessions, 1);
  });

  await test('invalid durations are skipped; the 24-hour boundary is accepted', () => {
    const bad = [0, -5, 12.5, '1500', 90000, NaN, null, undefined].map((durationSeconds, i) => ({ id: `d${i}`, durationSeconds, completedAt: ts(10, 20) }));
    const r = run([...bad, ses('ok', 10, 20, 1500), ses('max', 10, 21, 86400)]);
    assert.strictEqual(r.skipped.invalid, 8);
    assert.strictEqual(r.totals.sessions, 2);
  });

  await test('incomplete and cancelled records are never counted', () => {
    const base = { durationSeconds: 1500, completedAt: ts(10, 20) };
    const r = run([
      { id: 'a', ...base, completed: false },
      { id: 'b', ...base, cancelled: true },
      { id: 'c', ...base, status: 'cancelled' },
      { id: 'd', ...base, status: 'abandoned' },
      { id: 'e', ...base, status: 'incomplete' },
      { id: 'f', ...base, status: 'completed' }, // a genuinely completed record is kept
    ]);
    assert.strictEqual(r.skipped.incomplete, 5);
    assert.strictEqual(r.totals.sessions, 1);
  });

  await test('duplicates and malformed records; non-array input never throws', () => {
    const r = run([ses('a', 10, 20), ses('a', 10, 20), null, 5, 'x', [], {}]);
    assert.strictEqual(r.skipped.duplicates, 1);
    assert.strictEqual(r.skipped.invalid, 5);
    assert.strictEqual(r.totals.sessions, 1);
    assert.strictEqual(r.totals.minutes, 25);
    assert.doesNotThrow(() => run('nope'));
    assert.doesNotThrow(() => computeFocusIntelligence());
    assert.doesNotThrow(() => computeFocusIntelligence({ now: 'not a date', sessions: null, evidenceTimestamps: 7 }));
  });

  await test('heatmap shading is relative to the busiest day; no-data days stay at level 0', () => {
    const r = run([ses('a', 10, 12, 3000), ses('b', 10, 13, 1500), ses('c', 10, 14, 300)]);
    assert.strictEqual(cell(r, '2026-10-12').level, 4);
    assert.strictEqual(cell(r, '2026-10-13').level, 2);
    assert.strictEqual(cell(r, '2026-10-14').level, 1);
    assert.strictEqual(cell(r, '2026-10-15').status, 'none');
    assert.strictEqual(cell(r, '2026-10-15').level, 0);
    assert.strictEqual(cell(r, '2026-10-11').status, 'unavailable');
  });

  await test('deterministic, including when the input order changes', () => {
    const one = run(D);
    assert.deepStrictEqual(one, run(D));
    assert.deepStrictEqual(one, run([...D].reverse()));
  });

  await test('inputs are never mutated', () => {
    const sessions = deepFreeze([ses('a', 10, 20), ses('a', 10, 20), ses('b', 10, 21, 3000)]);
    const evidence = deepFreeze([ts(10, 1)]);
    const before = JSON.stringify({ sessions, evidence });
    assert.doesNotThrow(() => computeFocusIntelligence({ sessions, now: NOW, evidenceTimestamps: evidence }));
    assert.strictEqual(JSON.stringify({ sessions, evidence }), before);
  });

  await test('insufficient history: honest output, no invented trend or best day', () => {
    const r = run([ses('only', 10, 22)]);
    assert.deepStrictEqual(ids(r), ['little-history']);
    assert.strictEqual(r.comparison, null);
    assert.strictEqual(r.bestDay, null);
    assert.strictEqual(cell(r, '2026-10-22').status, 'recorded');
    assert.strictEqual(cell(r, '2026-10-21').status, 'unavailable');
    assert.ok(r.insights[0].text.includes('1 completed focus session on 1 day is recorded'));
  });

  await test('wording stays neutral and makes no productivity claims', () => {
    const rich = run([...D, ses('x', 10, 20, 3000), ses('y', 10, 21, 3000)]);
    const text = JSON.stringify(rich.insights);
    assert.ok(!/(productiv|lazy|fail|behind|poor|bad|guilt|should have|wasted)/i.test(text));
  });

  fs.unlinkSync(temp);
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();