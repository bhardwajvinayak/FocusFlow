// tools/test-report.js
// Usage (project root):  node tools/test-report.js
// Copies js/focus-intelligence.js, js/goals.js and js/report.js into a temporary ES-module folder.
// No network, no Chrome. The actual file download is a manual Chrome check.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-report-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const file of ['focus-intelligence.js', 'goals.js', 'report.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', file), path.join(dir, file));
}

// Thursday 22 Oct 2026, 14:00 local. Its week runs Mon 19 Oct to Sun 25 Oct.
const NOW = new Date(2026, 9, 22, 14, 0, 0);
const ts = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const ses = (id, m, d, seconds = 1500) => ({ id, durationSeconds: seconds, completedAt: ts(m, d) });
const G = (over = {}) => ({ schemaVersion: 1, dailyFocusMinutes: null, weeklyFocusMinutes: null, dailySessions: null, ...over });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const r = await import(pathToFileURL(path.join(dir, 'report.js')).href);
  const fi = await import(pathToFileURL(path.join(dir, 'focus-intelligence.js')).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const build = (sessions, extra = {}, now = NOW) => r.buildWeeklyReport({ sessions, now, ...extra });
  const statuses = (report) => report.days.map((d) => d.status);

  // Dataset for week 12-18 Oct: Mon 2 sessions (50 min), Tue 10 min, Wed 50 min.
  const W12 = [ses('a', 10, 12), ses('b', 10, 12), ses('c', 10, 13, 600), ses('d', 10, 14, 3000)];

  await test('empty history: honest current week, nothing invented', () => {
    const rep = build([]);
    assert.strictEqual(rep.weekStartKey, '2026-10-19');
    assert.strictEqual(rep.isCurrentWeek, true);
    assert.deepStrictEqual(statuses(rep), ['unavailable', 'unavailable', 'unavailable', 'none', 'unavailable', 'unavailable', 'unavailable']);
    assert.deepStrictEqual(rep.days.map((d) => d.reason), ['before-history', 'before-history', 'before-history', '', 'upcoming', 'upcoming', 'upcoming']);
    assert.strictEqual(rep.totals.minutes, 0);
    assert.strictEqual(rep.totals.averageMinutes, null);
    assert.strictEqual(rep.bestDay, null);
    assert.strictEqual(rep.comparison, null);
  });

  await test('recorded / none / unavailable statuses in the current week', () => {
    const rep = build([ses('m', 10, 19), ses('w', 10, 21, 3000)]);
    assert.deepStrictEqual(statuses(rep), ['recorded', 'none', 'recorded', 'none', 'unavailable', 'unavailable', 'unavailable']);
    assert.deepStrictEqual(rep.days.map((d) => d.minutes), [25, 0, 50, 0, null, null, null]);
    assert.deepStrictEqual(rep.days.map((d) => d.sessions), [1, 0, 1, 0, null, null, null]);
    assert.deepStrictEqual(rep.days.map((d) => d.weekday).slice(0, 2), ['Monday', 'Tuesday']);
    assert.strictEqual(rep.daysElapsed, 4);
    assert.strictEqual(rep.throughKey, '2026-10-22');
  });

  await test('an earlier complete week, with a previous-week comparison when history covers it', () => {
    const rep = build([ses('x', 10, 12), ses('y', 10, 6, 3000)], { weekStart: '2026-10-12', evidenceTimestamps: [ts(10, 5)] });
    assert.strictEqual(rep.isCurrentWeek, false);
    assert.strictEqual(rep.daysElapsed, 7);
    assert.deepStrictEqual(statuses(rep), ['recorded', 'none', 'none', 'none', 'none', 'none', 'none']);
    assert.deepStrictEqual(rep.comparison, { thisMinutes: 25, previousMinutes: 50, deltaMinutes: -25, percent: -50, label: 'the previous week' });
  });

  await test('week selection: any weekday maps to its Monday, bad or future values use the current week', () => {
    assert.strictEqual(build([], { weekStart: '2026-10-14' }).weekStartKey, '2026-10-12');
    assert.strictEqual(build([], { weekStart: '2026-12-01' }).weekStartKey, '2026-10-19');
    assert.strictEqual(build([], { weekStart: 'x' }).weekStartKey, '2026-10-19');
    assert.strictEqual(build([], { weekStart: '2026-02-31' }).weekStartKey, '2026-10-19');
  });

  await test('partial current week compares the SAME weekdays; missing history gives no comparison', () => {
    const data = [ses('p1', 10, 12), ses('p2', 10, 17, 6000), ses('t1', 10, 19), ses('t2', 10, 22, 3000)];
    assert.deepStrictEqual(build(data).comparison, { thisMinutes: 75, previousMinutes: 25, deltaMinutes: 50, percent: 200, label: 'the same weekdays last week' });
    const young = build([ses('only', 10, 20)]);
    assert.strictEqual(young.comparison, null);
    assert.ok(young.comparisonNote.includes('history'));
    assert.ok(young.summary.some((line) => line.includes('history')));
  });

  await test('totals, average, active days, best day and ties', () => {
    const rep = build(W12, { weekStart: '2026-10-12' });
    assert.deepStrictEqual(rep.totals, { minutes: 110, sessions: 4, averageMinutes: 27.5, activeDays: 3 });
    assert.deepStrictEqual(rep.bestDay, { dates: ['2026-10-12', '2026-10-14'], minutes: 50, tied: true });
    assert.strictEqual(rep.comparison, null); // history starts on the 12th, so last week is not covered
  });

  await test('best day needs at least three active days', () => {
    const rep = build([ses('a', 10, 12), ses('b', 10, 13, 3000)], { weekStart: '2026-10-12' });
    assert.strictEqual(rep.bestDay, null);
  });

  await test('agrees with Focus Intelligence for the same data', () => {
    const data = [ses('p1', 10, 12), ses('p2', 10, 17), ses('t1', 10, 19), ses('t2', 10, 22, 3000), ses('f1', 10, 24)];
    const f = fi.computeFocusIntelligence({ sessions: data, now: NOW });
    const rep = build(data);
    assert.strictEqual(rep.totals.minutes, f.thisWeek.minutes);
    assert.strictEqual(rep.comparison.previousMinutes, f.previousWeek.samePeriodMinutes);
    assert.strictEqual(rep.comparison.deltaMinutes, f.comparison.deltaMinutes);
    assert.strictEqual(rep.comparison.percent, f.comparison.percent);
    const map = { recorded: 'recorded', none: 'none', unavailable: 'unavailable', future: 'unavailable' };
    f.heatmap.weeks[3].forEach((cell, i) => {
      assert.strictEqual(rep.days[i].date, cell.date);
      assert.strictEqual(rep.days[i].status, map[cell.status]);
      if (cell.status === 'recorded') assert.strictEqual(rep.days[i].minutes, cell.minutes);
    });
  });

  await test('goal progress inside the report (week to date)', () => {
    const data = [ses('p1', 10, 12), ses('t1', 10, 19), ses('t2', 10, 22, 3000)];
    const none = build(data).goals;
    assert.strictEqual(none.anyGoalSet, false);
    assert.strictEqual(none.weeklyFocus.set, false);
    const rep = build(data, { goals: G({ weeklyFocusMinutes: 100, dailyFocusMinutes: 25, dailySessions: 1 }) });
    assert.deepStrictEqual(rep.goals.weeklyFocus, { set: true, goal: 100, done: 75, met: false, percent: 75 });
    assert.deepStrictEqual(rep.goals.dailyFocusDays, { set: true, goal: 25, daysMet: 2, daysEvaluated: 4 });
    assert.deepStrictEqual(rep.goals.dailySessionsDays, { set: true, goal: 1, daysMet: 2, daysEvaluated: 4 });
  });

  await test('CSV: exactly one header and seven rows with the right values', () => {
    const csv = r.reportToCsv(build(W12, { weekStart: '2026-10-12' }));
    assert.ok(csv.endsWith('\r\n'));
    const lines = csv.split('\r\n').slice(0, -1);
    assert.deepStrictEqual(lines, [
      'date,weekday,focus_minutes,sessions,status',
      '2026-10-12,Monday,50,2,recorded',
      '2026-10-13,Tuesday,10,1,recorded',
      '2026-10-14,Wednesday,50,1,recorded',
      '2026-10-15,Thursday,0,0,none',
      '2026-10-16,Friday,0,0,none',
      '2026-10-17,Saturday,0,0,none',
      '2026-10-18,Sunday,0,0,none',
    ]);
    assert.strictEqual(r.csvFilename(build(W12, { weekStart: '2026-10-12' })), 'focusflow-week-2026-10-12.csv');
  });

  await test('CSV: unavailable days are blank, never zero; only safe characters appear', () => {
    const partial = r.reportToCsv(build([ses('w', 10, 21)])).split('\r\n');
    assert.strictEqual(partial[1], '2026-10-19,Monday,,,unavailable');
    assert.strictEqual(partial[3], '2026-10-21,Wednesday,25,1,recorded');
    assert.strictEqual(partial[4], '2026-10-22,Thursday,0,0,none');
    assert.strictEqual(partial[5], '2026-10-23,Friday,,,unavailable');
    assert.ok(/^[0-9A-Za-z,\r\n_-]*$/.test(r.reportToCsv(build(W12, { weekStart: '2026-10-12' }))));
    assert.strictEqual(r.reportToCsv(null), '');
    assert.strictEqual(r.reportToCsv({ days: [] }), '');
  });

  await test('CSV escaping and formula-injection protection', () => {
    assert.strictEqual(r.csvField('a,b'), '"a,b"');
    assert.strictEqual(r.csvField('he said "hi"'), '"he said ""hi"""');
    assert.strictEqual(r.csvField('line1\nline2'), '"line1\nline2"');
    for (const [input, expected] of [['=SUM(A1)', "'=SUM(A1)"], ['+1', "'+1"], ['-1', "'-1"], ['@x', "'@x"], ['\tx', "'\tx"], ['=1,2', '"\'=1,2"']]) {
      assert.strictEqual(r.csvField(input), expected, JSON.stringify(input));
    }
    assert.strictEqual(r.csvField(25), '25');
    assert.strictEqual(r.csvField(-5), '-5');
    assert.strictEqual(r.csvField(null), '');
    assert.strictEqual(r.csvField(undefined), '');
  });

  await test('month, year and daylight-saving week boundaries', () => {
    const newYear = r.buildWeeklyReport({ sessions: [], now: new Date(2026, 0, 1, 12) });
    assert.deepStrictEqual(newYear.days.map((d) => d.date), ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    const dst = r.buildWeeklyReport({ sessions: [], now: new Date(2026, 10, 4, 12), weekStart: '2026-10-26' });
    assert.deepStrictEqual(dst.days.map((d) => d.date), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    assert.strictEqual(r.buildWeeklyReport({ sessions: [], now: new Date(2026, 10, 4, 12) }).weekStartKey, '2026-11-02');
  });

  await test('listReportWeeks: newest first, bounded by history, capped at 52', () => {
    assert.deepStrictEqual(r.listReportWeeks({ sessions: [], now: NOW }).map((w) => w.startKey), ['2026-10-19']);
    const three = r.listReportWeeks({ sessions: [ses('x', 10, 7)], evidenceTimestamps: [ts(10, 5)], now: NOW });
    assert.deepStrictEqual(three.map((w) => w.startKey), ['2026-10-19', '2026-10-12', '2026-10-05']);
    assert.strictEqual(three[0].isCurrent, true);
    assert.strictEqual(three[1].isCurrent, false);
    const old = r.listReportWeeks({ sessions: [{ id: 'o', durationSeconds: 1500, completedAt: new Date(2023, 0, 2, 12).getTime() }], now: NOW });
    assert.strictEqual(old.length, 52);
  });

  await test('malformed, duplicate and future records are skipped', () => {
    const rep = build([null, 5, 'x', ses('a', 10, 20), ses('a', 10, 20), { id: 'b', durationSeconds: 0, completedAt: ts(10, 20) }, ses('fut', 10, 24)]);
    assert.strictEqual(rep.totals.sessions, 1);
    assert.strictEqual(rep.skipped.duplicates, 1);
    assert.doesNotThrow(() => r.buildWeeklyReport());
    assert.doesNotThrow(() => r.buildWeeklyReport({ sessions: 'nope', now: 'not a date', goals: 5 }));
  });

  await test('deterministic, order-independent and never mutating', () => {
    const first = build(W12, { weekStart: '2026-10-12', goals: G({ weeklyFocusMinutes: 100 }) });
    assert.deepStrictEqual(first, build(W12, { weekStart: '2026-10-12', goals: G({ weeklyFocusMinutes: 100 }) }));
    assert.deepStrictEqual(first, build([...W12].reverse(), { weekStart: '2026-10-12', goals: G({ weeklyFocusMinutes: 100 }) }));
    assert.strictEqual(r.reportToCsv(first), r.reportToCsv(build(W12, { weekStart: '2026-10-12', goals: G({ weeklyFocusMinutes: 100 }) })));
    const sessions = deepFreeze(W12.map((s) => ({ ...s })));
    const evidence = deepFreeze([ts(10, 1)]);
    const goals = deepFreeze(G({ dailyFocusMinutes: 30 }));
    const before = JSON.stringify({ sessions, evidence, goals });
    assert.doesNotThrow(() => build(sessions, { evidenceTimestamps: evidence, goals, weekStart: '2026-10-12' }));
    assert.strictEqual(JSON.stringify({ sessions, evidence, goals }), before);
  });

  await test('report wording stays neutral', () => {
    const rep = build(W12, { weekStart: '2026-10-12', goals: G({ weeklyFocusMinutes: 100 }) });
    assert.ok(!/(productiv|healthy|burnout|lazy|guilt|should have|wasted|poor|bad)/i.test(JSON.stringify(rep.summary)));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();