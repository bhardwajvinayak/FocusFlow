// tools/test-insights.js
// Usage (project root):  node tools/test-insights.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-insights-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['focus-intelligence.js', 'goals.js', 'report.js', 'habits.js', 'insights.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', f), path.join(dir, f));
}

const NOW = new Date(2026, 9, 22, 14, 0, 0); // Thursday; its week is Mon 19 to Sun 25 Oct
const ts = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const ses = (id, m, d, sec) => ({ id, durationSeconds: sec, completedAt: ts(m, d) });
const task = (id, created, done) => ({ id, completed: done !== undefined, createdAt: created, completedAt: done === undefined ? null : done });
const habit = (id, name, created, completions, over = {}) => ({ id, name, createdAt: created, archivedAt: null, completions, ...over });

const SESSIONS = [ses('a', 10, 19, 1500), ses('b', 10, 21, 3000), ses('c', 10, 22, 1500), ses('p1', 10, 12, 1500), ses('p2', 10, 14, 3000)];
const TASKS = [task('t1', ts(10, 1), ts(10, 19)), task('t2', ts(10, 1), ts(10, 21)), task('t3', ts(10, 1), ts(10, 21)), task('t4', ts(10, 10)), task('t5', ts(10, 1), ts(10, 12))];
const HABITS = [
  habit('h1', 'One', ts(10, 1), ['2026-10-12', '2026-10-13', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']),
  habit('h2', 'Two', ts(10, 20), ['2026-10-21']),
];
const EVIDENCE = [ts(10, 1), ts(10, 1)];

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); }
  return v;
}

(async () => {
  const { buildProductivityInsights } = await import(pathToFileURL(path.join(dir, 'insights.js')).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  };
  const build = (over = {}) => buildProductivityInsights({ sessions: SESSIONS, tasks: TASKS, habits: HABITS, evidenceTimestamps: EVIDENCE, now: NOW, ...over });

  await test('empty data: no numbers invented, no comparisons', () => {
    const r = buildProductivityInsights({ now: NOW });
    assert.strictEqual(r.tasks.available, false);
    assert.strictEqual(r.tasks.total, null);
    assert.strictEqual(r.habits.available, false);
    assert.strictEqual(r.habits.rate, null);
    assert.deepStrictEqual([r.comparison.focus, r.comparison.tasks, r.comparison.habits], [null, null, null]);
    assert.ok(r.days.every((d) => d.tasksCompleted === null && d.habitsTracked === null));
  });

  await test('week boundaries are Monday to Sunday and the current week is week to date', () => {
    const r = build();
    assert.strictEqual(r.report.weekStartKey, '2026-10-19');
    assert.strictEqual(r.report.weekEndKey, '2026-10-25');
    assert.strictEqual(r.report.isCurrentWeek, true);
    assert.deepStrictEqual(r.days.map((d) => d.status), ['recorded', 'none', 'recorded', 'recorded', 'unavailable', 'unavailable', 'unavailable']);
    assert.strictEqual(build({ weekStart: '2026-10-14' }).report.weekStartKey, '2026-10-12');
    assert.strictEqual(buildProductivityInsights({ now: new Date(2026, 0, 1, 12) }).report.weekStartKey, '2025-12-29');
  });

  await test('daily focus, weekly total and most productive day', () => {
    const r = build();
    assert.deepStrictEqual(r.days.map((d) => d.minutes), [25, 0, 50, 25, null, null, null]);
    assert.strictEqual(r.report.totals.minutes, 100);
    assert.deepStrictEqual(r.bestDay, { dates: ['2026-10-21'], minutes: 50, tied: false });
  });

  await test('tasks: only completed tasks in the week, no data is not zero', () => {
    const r = build();
    assert.deepStrictEqual(r.days.map((d) => d.tasksCompleted), [1, 0, 2, 0, null, null, null]);
    assert.strictEqual(r.tasks.total, 3);
    const noTasks = build({ tasks: [] });
    assert.strictEqual(noTasks.tasks.total, null);
    assert.ok(noTasks.days.every((d) => d.tasksCompleted === null));
  });

  await test('habit completion rate counts from each habit start day', () => {
    const r = build();
    assert.deepStrictEqual(r.days.map((d) => d.habitsDone), [1, 1, 2, 1, null, null, null]);
    assert.deepStrictEqual(r.days.map((d) => d.habitsTracked), [1, 2, 2, 2, null, null, null]);
    assert.strictEqual(r.habits.done, 5);
    assert.strictEqual(r.habits.eligible, 7);
    assert.strictEqual(r.habits.rate, 71);
    const one = r.habits.perHabit.find((h) => h.id === 'h1');
    const two = r.habits.perHabit.find((h) => h.id === 'h2');
    assert.deepStrictEqual([one.rate, one.current], [100, 4]);
    assert.deepStrictEqual([two.eligible, two.rate, two.current], [3, 33, 1]);
  });

  await test('archived habits are excluded', () => {
    const r = build({ habits: [...HABITS, habit('h3', 'Old', ts(10, 1), ['2026-10-22'], { archivedAt: 5 })] });
    assert.strictEqual(r.habits.perHabit.length, 2);
    assert.strictEqual(r.habits.eligible, 7);
  });

  await test('comparison with the same weekdays last week, only when both periods have data', () => {
    const r = build();
    assert.deepStrictEqual([r.comparison.focus.deltaMinutes, r.comparison.focus.previousMinutes], [25, 75]);
    assert.deepStrictEqual(r.comparison.tasks, { this: 3, previous: 1, delta: 2 });
    assert.deepStrictEqual(r.comparison.habits, { thisRate: 71, previousRate: 50, deltaPoints: 21 });
    assert.ok(r.lines.some((l) => l.id === 'comparison'));
    const young = buildProductivityInsights({ sessions: [ses('x', 10, 20, 1500)], tasks: [task('t', ts(10, 20), ts(10, 21))], habits: [habit('h', 'H', ts(10, 20), ['2026-10-21'])], evidenceTimestamps: [ts(10, 20)], now: NOW });
    assert.deepStrictEqual([young.comparison.focus, young.comparison.tasks, young.comparison.habits], [null, null, null]);
    assert.ok(young.comparison.note.includes('last Monday'));
    assert.ok(young.lines.some((l) => l.id === 'no-comparison'));
  });

  await test('habit comparison needs habit days in the previous period', () => {
    const r = build({ habits: [HABITS[1]], evidenceTimestamps: [ts(10, 1)] }); // the habit started on the 20th
    assert.strictEqual(r.comparison.habits, null);
    assert.ok(r.habits.rate !== null);
  });

  await test('malformed tasks, sessions and habits are skipped safely', () => {
    const r = build({ tasks: [null, 5, 'x', { completed: 'y' }, task('ok', ts(10, 1), ts(10, 19))], sessions: [null, 'x', { id: '', durationSeconds: 0, completedAt: NaN }, ses('s', 10, 19, 1500)],
      habits: [null, { id: 'x' }, habit('h', 'H', ts(10, 1), ['2026-10-19', 'nope'])] });
    assert.strictEqual(r.skippedTasks, 4);
    assert.strictEqual(r.tasks.total, 1);
    assert.doesNotThrow(() => buildProductivityInsights({ sessions: 'x', tasks: 7, habits: {}, now: 'nope' }));
    assert.doesNotThrow(() => buildProductivityInsights());
  });

  await test('a task with a missing or invalid completion time is not counted', () => {
    const r = build({ tasks: [{ id: 'a', completed: true, createdAt: ts(10, 1), completedAt: NaN }, task('b', ts(10, 1), ts(10, 19))] });
    assert.strictEqual(r.tasks.total, 1);
  });

  await test('month and year boundaries and week before history', () => {
    const r = buildProductivityInsights({ sessions: [{ id: 'a', durationSeconds: 1500, completedAt: new Date(2025, 11, 31, 12).getTime() }], now: new Date(2026, 0, 1, 12), weekStart: '2025-12-29' });
    assert.deepStrictEqual(r.days.map((d) => d.date).slice(2, 4), ['2025-12-31', '2026-01-01']);
    assert.strictEqual(r.days[2].minutes, 25);
    const early = build({ weekStart: '2026-09-28' });
    assert.ok(early.days.every((d) => d.status === 'unavailable'));
    assert.ok(early.lines.some((l) => l.id === 'no-history'));
  });

  await test('deterministic, and no input is modified', () => {
    assert.deepStrictEqual(build(), build());
    const s = deepFreeze(SESSIONS.map((x) => ({ ...x })));
    const t = deepFreeze(TASKS.map((x) => ({ ...x })));
    const h = deepFreeze(HABITS.map((x) => ({ ...x, completions: [...x.completions] })));
    const before = JSON.stringify({ s, t, h });
    assert.doesNotThrow(() => buildProductivityInsights({ sessions: s, tasks: t, habits: h, evidenceTimestamps: EVIDENCE, now: NOW }));
    assert.strictEqual(JSON.stringify({ s, t, h }), before);
  });

  await test('the module has no storage, network or browser API calls', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'insights.js'), 'utf8');
    assert.ok(!/(fetch\(|XMLHttpRequest|chrome\.|localStorage|document\.)/.test(src));
  });

  await test('wording is neutral', () => {
    assert.ok(!/(lazy|fail|guilt|should have|wasted|poor|bad|productivity score)/i.test(JSON.stringify(build().lines)));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();