// tools/test-coach.js
// Usage (project root):  node tools/test-coach.js
// Loads js/coach.js (an ES module) through a temporary .mjs copy. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const temp = path.join(os.tmpdir(), `ff-coach-${process.pid}.mjs`);
fs.copyFileSync(path.join(__dirname, '..', 'js', 'coach.js'), temp);

// Monday 19 Oct 2026, 14:00 local time.
const NOW = new Date(2026, 9, 19, 14, 0, 0);
const ts = (y, m, d, h = 12, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();
let counter = 0;
const task = (over = {}) => ({
  id: `t${(counter += 1)}`, title: 'Private title', completed: false, createdAt: ts(2026, 10, 15),
  dueDate: null, completedAt: null, priority: 'medium', ...over,
});
const session = (id, completedAt, durationSeconds = 1500) => ({ id, durationSeconds, completedAt, dev: false });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const { computeCoach } = await import(pathToFileURL(temp).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const ids = (result) => result.recommendations.map((r) => r.id);

  await test('empty data: starter suggestion, no weekly data, all zeros', () => {
    const r = computeCoach({ tasks: [], sessions: [], now: NOW });
    assert.strictEqual(r.hasData, false);
    assert.deepStrictEqual(ids(r), ['starter']);
    assert.strictEqual(r.weekly.available, false);
    assert.strictEqual(r.weekly.evidenceDays, 0);
    assert.deepStrictEqual(Object.values(r.summary).every((n) => n === 0), true);
  });

  await test('task counts: completed today, pending, total', () => {
    const r = computeCoach({
      now: NOW, sessions: [],
      tasks: [
        task({ completed: true, completedAt: ts(2026, 10, 19, 9) }),
        task({ completed: true, completedAt: ts(2026, 10, 19, 11) }),
        task({ completed: true, completedAt: ts(2026, 10, 18, 11) }),
        task(), task(),
      ],
    });
    assert.strictEqual(r.summary.totalTasks, 5);
    assert.strictEqual(r.summary.completedToday, 2);
    assert.strictEqual(r.summary.pending, 2);
  });

  await test('overdue and due-today (completed tasks are never overdue)', () => {
    const r = computeCoach({
      now: NOW, sessions: [],
      tasks: [
        task({ dueDate: '2026-10-18' }),
        task({ dueDate: '2026-10-19' }),
        task({ dueDate: '2026-10-20' }),
        task({ dueDate: '2026-10-10', completed: true, completedAt: ts(2026, 10, 12) }),
      ],
    });
    assert.strictEqual(r.summary.overdue, 1);
    assert.strictEqual(r.summary.dueToday, 1);
    assert.ok(ids(r).includes('overdue-few'));
  });

  await test('many overdue tasks: pick-one suggestion comes first', () => {
    const tasks = Array.from({ length: 4 }, () => task({ dueDate: '2026-10-10' }));
    const r = computeCoach({ tasks, sessions: [], now: NOW });
    assert.strictEqual(ids(r)[0], 'overdue-many');
  });

  await test('focus sessions: duplicates, invalid items, minutes', () => {
    const r = computeCoach({
      now: NOW, tasks: [],
      sessions: [
        session('a', ts(2026, 10, 19, 9), 1500),
        session('a', ts(2026, 10, 19, 9), 1500),
        session('b', ts(2026, 10, 19, 10), 600),
        session('c', ts(2026, 10, 18, 10), 1500),
        { id: '', durationSeconds: 1500, completedAt: ts(2026, 10, 19) },
        { id: 'd', durationSeconds: 0, completedAt: ts(2026, 10, 19) },
        { id: 'e', durationSeconds: 1500, completedAt: NaN },
        null, 'x',
      ],
    });
    assert.strictEqual(r.summary.focusSessionsToday, 2);
    assert.strictEqual(r.summary.focusMinutesToday, 35);
  });

  await test('pending tasks and no sessions today suggests one focus session', () => {
    const r = computeCoach({ tasks: [task()], sessions: [], now: NOW, focusMinutes: 30 });
    const rec = r.recommendations.find((x) => x.id === 'start-focus');
    assert.ok(rec && rec.text.includes('30-minute'));
  });

  await test('many completed tasks: acknowledges and suggests rest, no push for more', () => {
    const tasks = Array.from({ length: 6 }, () => task({ completed: true, completedAt: ts(2026, 10, 19, 10) }));
    const r = computeCoach({ tasks, sessions: [], now: NOW });
    const rec = r.recommendations.find((x) => x.id === 'good-progress');
    assert.ok(rec && /rest/i.test(rec.text));
  });

  await test('local-day boundary around midnight', () => {
    const justBefore = ts(2026, 10, 18, 23, 59, 59);
    const justAfter = ts(2026, 10, 19, 0, 0, 1);
    const sessions = [session('x', justBefore), session('y', justAfter)];
    assert.strictEqual(computeCoach({ tasks: [], sessions, now: new Date(2026, 9, 19, 0, 0, 2) }).summary.focusSessionsToday, 1);
    assert.strictEqual(computeCoach({ tasks: [], sessions, now: new Date(2026, 9, 18, 23, 59, 59) }).summary.focusSessionsToday, 1);
    assert.strictEqual(computeCoach({ tasks: [], sessions: [session('z', justBefore)], now: new Date(2026, 9, 19, 0, 0, 2) }).summary.focusSessionsToday, 0);
  });

  await test('focus streak', () => {
    const run = (days) => computeCoach({ tasks: [], now: NOW, sessions: days.map((d, i) => session(`s${i}`, ts(2026, 10, d))) }).summary.focusStreakDays;
    assert.strictEqual(run([19, 18, 17]), 3);
    assert.strictEqual(run([18, 17]), 2); // no session yet today does not break the streak
    assert.strictEqual(run([19, 17]), 1); // a gap ends it
    assert.strictEqual(run([]), 0);
  });

  await test('insufficient history: no weekly summary and an honest note', () => {
    const r = computeCoach({ tasks: [task({ createdAt: ts(2026, 10, 16) })], sessions: [], now: NOW });
    assert.strictEqual(r.weekly.available, false);
    assert.strictEqual(r.weekly.evidenceDays, 4);
    assert.ok(r.weekly.note.includes('4 days'));
    assert.deepStrictEqual(r.weekly.days, []);
  });

  await test('weekly summary at 7 days, comparison only from 14 days', () => {
    const seven = computeCoach({ tasks: [task({ createdAt: ts(2026, 10, 13) })], sessions: [], now: NOW });
    assert.strictEqual(seven.weekly.available, true);
    assert.strictEqual(seven.weekly.days.length, 7);
    assert.strictEqual(seven.weekly.comparison, null);

    const fourteen = computeCoach({
      now: NOW, tasks: [
        task({ createdAt: ts(2026, 10, 6), completed: true, completedAt: ts(2026, 10, 8) }),
        task({ createdAt: ts(2026, 10, 6), completed: true, completedAt: ts(2026, 10, 18) }),
        task({ createdAt: ts(2026, 10, 6), completed: true, completedAt: ts(2026, 10, 19) }),
      ],
      sessions: [session('p', ts(2026, 10, 9), 1500), session('q', ts(2026, 10, 18), 3000)],
    });
    assert.strictEqual(fourteen.weekly.evidenceDays, 14);
    assert.deepStrictEqual(fourteen.weekly.comparison, {
      tasksCompletedDelta: 1, focusMinutesDelta: 25, previousTasksCompleted: 1, previousFocusMinutes: 25,
    });
    assert.strictEqual(fourteen.weekly.days[6].date, '2026-10-19');
  });

  await test('week window is correct across a daylight-saving change', () => {
    const r = computeCoach({ tasks: [task({ createdAt: ts(2026, 10, 20) })], sessions: [], now: new Date(2026, 10, 5, 12) });
    const dates = r.weekly.days.map((d) => d.date);
    assert.deepStrictEqual(dates, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  });

  await test('malformed data never throws', () => {
    const bad = [null, 5, 'x', [], { completed: 'yes' }, { id: 'a', completed: false, dueDate: '2026-02-31' },
      { id: 'b', completed: true, completedAt: NaN, createdAt: 'x' }];
    const r = computeCoach({ tasks: bad, sessions: 'nope', now: NOW });
    assert.strictEqual(r.summary.totalTasks, 2);
    assert.strictEqual(r.summary.overdue, 0);
    assert.strictEqual(r.summary.completedToday, 0);
    assert.doesNotThrow(() => computeCoach({ tasks: 'nope', sessions: null, now: NOW }));
    assert.doesNotThrow(() => computeCoach({ now: 'not a date' }));
    assert.doesNotThrow(() => computeCoach());
  });

  await test('far-future and missing timestamps are ignored for date metrics', () => {
    const r = computeCoach({
      now: NOW, sessions: [session('f', ts(2099, 1, 1))],
      tasks: [task({ completed: true, completedAt: ts(2099, 1, 1) }), task({ completed: true, completedAt: null })],
    });
    assert.strictEqual(r.summary.completedToday, 0);
    assert.strictEqual(r.summary.focusSessionsToday, 0);
  });

  await test('recommendations are deterministic and capped at 3', () => {
    const tasks = [
      ...Array.from({ length: 4 }, () => task({ dueDate: '2026-10-10' })),
      ...Array.from({ length: 6 }, () => task({ dueDate: '2026-10-19' })),
      ...Array.from({ length: 6 }, () => task({ completed: true, completedAt: ts(2026, 10, 19, 10) })),
    ];
    const sessions = [session('a', ts(2026, 10, 18)), session('b', ts(2026, 10, 17))];
    const first = computeCoach({ tasks, sessions, now: NOW });
    const second = computeCoach({ tasks, sessions, now: NOW });
    assert.deepStrictEqual(first, second);
    assert.ok(first.recommendations.length <= 3);
    assert.strictEqual(first.recommendations[0].id, 'overdue-many');
  });

  await test('input data is never mutated', () => {
    const tasks = deepFreeze([task({ dueDate: '2026-10-10' }), task({ completed: true, completedAt: ts(2026, 10, 19, 9) })]);
    const sessions = deepFreeze([session('a', ts(2026, 10, 19, 9))]);
    const before = JSON.stringify({ tasks, sessions });
    computeCoach({ tasks, sessions, now: NOW });
    assert.strictEqual(JSON.stringify({ tasks, sessions }), before);
  });

  await test('wording stays neutral and task titles never appear in output', () => {
    const tasks = [task({ title: 'SECRET-TITLE', dueDate: '2026-10-01' }), task({ completed: true, completedAt: ts(2026, 10, 19, 9) })];
    const text = JSON.stringify(computeCoach({ tasks, sessions: [], now: NOW }));
    assert.ok(!/(lazy|fail|failed|behind|should have|guilt|ashamed|wasted|worthless)/i.test(text));
    assert.ok(!text.includes('SECRET-TITLE'));
  });

  fs.unlinkSync(temp);
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();