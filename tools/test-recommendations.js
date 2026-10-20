// tools/test-recommendations.js
// Usage (project root):  node tools/test-recommendations.js
// Copies js/planner.js and js/recommendations.js into a temporary ES-module folder (they import each
// other) and tests the pure logic. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-rec-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const file of ['planner.js', 'recommendations.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', file), path.join(dir, file));
}

const TODAY = '2026-10-22'; // a Thursday
const SET = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4 };
const IDLE = { status: 'idle', mode: 'focus', cycleFocusCount: 0 };
const ts = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const task = (id, over = {}) => ({ id, title: `Task ${id}`, completed: false, priority: 'medium', dueDate: null, createdAt: 100, ...over });
const ses = (id, m, d, seconds = 1500) => ({ id, durationSeconds: seconds, completedAt: ts(m, d) });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const rec = await import(pathToFileURL(path.join(dir, 'recommendations.js')).href);
  const planner = await import(pathToFileURL(path.join(dir, 'planner.js')).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const run = (over = {}) => rec.computeRecommendations({ tasks: [], sessions: [], settings: SET, timer: IDLE, today: TODAY, ...over });
  const reasons = (r) => r.nextTask.reasons.join(' | ');

  await test('no tasks at all: honest empty state, nothing recommended', () => {
    const r = run();
    assert.strictEqual(r.state, 'no-tasks');
    assert.strictEqual(r.nextTask, null);
    assert.deepStrictEqual(r.alternatives, []);
    assert.strictEqual(r.session.kind, 'none');
  });

  await test('all tasks completed', () => {
    const r = run({ tasks: [task('a', { completed: true }), task('b', { completed: true })] });
    assert.strictEqual(r.state, 'all-done');
    assert.strictEqual(r.nextTask, null);
  });

  await test('overdue beats a higher-priority task, and the reasons say why', () => {
    const r = run({ tasks: [task('A', { dueDate: '2026-10-25', priority: 'high' }), task('B', { dueDate: '2026-10-10', priority: 'low' })] });
    assert.strictEqual(r.nextTask.id, 'B');
    assert.ok(reasons(r).includes('Overdue by 12 days.'));
    assert.ok(reasons(r).includes('Low priority.'));
    assert.ok(reasons(r).includes('Overdue tasks are suggested first.'));
    assert.strictEqual(r.alternatives[0].id, 'A');
  });

  await test('the top pick and alternatives match the Planner order', () => {
    const tasks = [
      task('a', { priority: 'low' }), task('b', { dueDate: '2026-10-12' }), task('c', { priority: 'high', dueDate: '2026-10-23' }),
      task('d', { dueDate: '2026-10-22', priority: 'low' }), task('e', { priority: 'high', createdAt: 5 }),
    ];
    const plan = planner.planDay({
      tasks, estimates: {}, today: TODAY,
      settings: { startTime: '06:00', availableMinutes: 720, sessionMinutes: 25, breakMinutes: 5, defaultTaskMinutes: 25 },
    });
    assert.strictEqual(plan.unscheduled.length, 0);
    const r = run({ tasks });
    const order = plan.scheduled.map((x) => x.taskId);
    assert.strictEqual(r.nextTask.id, order[0]);
    assert.deepStrictEqual(r.alternatives.map((x) => x.id), order.slice(1, 3));
  });

  await test('deadline wording: today, tomorrow, in N days, none', () => {
    assert.ok(reasons(run({ tasks: [task('a', { dueDate: '2026-10-22' })] })).includes('Due today.'));
    assert.ok(reasons(run({ tasks: [task('a', { dueDate: '2026-10-23' })] })).includes('Due tomorrow.'));
    const later = run({ tasks: [task('a', { dueDate: '2026-10-26' })] });
    assert.ok(reasons(later).includes('Due in 4 days.'));
    assert.ok(reasons(later).includes('nearest upcoming deadline'));
    assert.ok(reasons(run({ tasks: [task('a')] })).includes('No due date'));
  });

  await test('tie-break explanations', () => {
    const byPriority = run({ tasks: [task('a', { priority: 'high' }), task('b')] });
    assert.ok(reasons(byPriority).includes('Higher priority than the next task'));
    const byDue = run({ tasks: [task('a', { dueDate: '2026-10-23' }), task('b', { dueDate: '2026-10-24' })] });
    assert.ok(reasons(byDue).includes('Earlier deadline'));
    const byAge = run({ tasks: [task('a', { createdAt: 1 }), task('b', { createdAt: 2 })] });
    assert.ok(reasons(byAge).includes('this is the oldest'));
    const full = run({ tasks: [task('a'), task('b')] });
    assert.ok(reasons(full).includes('Tied with another task'));
    assert.ok(!reasons(run({ tasks: [task('only')] })).includes('Tied'));
  });

  await test('at most two alternatives', () => {
    const r = run({ tasks: ['a', 'b', 'c', 'd', 'e'].map((id, i) => task(id, { createdAt: i })) });
    assert.strictEqual(r.alternatives.length, 2);
  });

  await test('timer in progress or paused: no "start a session" advice', () => {
    for (const status of ['running', 'paused']) {
      const r = run({ tasks: [task('a')], timer: { status, mode: 'focus', cycleFocusCount: 0 } });
      assert.strictEqual(r.session.kind, 'in-progress');
      assert.strictEqual(r.break, '');
    }
    assert.ok(run({ tasks: [task('a')], timer: { status: 'running', mode: 'shortBreak', cycleFocusCount: 1 } }).session.text.includes('break'));
  });

  await test('a break waiting on the timer is suggested with its real length', () => {
    const short = run({ tasks: [task('a')], timer: { status: 'idle', mode: 'shortBreak', cycleFocusCount: 1 } });
    assert.strictEqual(short.session.kind, 'break-ready');
    assert.ok(short.session.text.includes('5-minute short break'));
    const long = run({ tasks: [task('a')], timer: { status: 'idle', mode: 'longBreak', cycleFocusCount: 0 } });
    assert.ok(long.session.text.includes('15-minute long break'));
  });

  await test('focus session suggestion and the break the timer will offer next', () => {
    const first = run({ tasks: [task('a')] });
    assert.strictEqual(first.session.kind, 'start-focus');
    assert.ok(first.session.text.includes('25-minute'));
    assert.ok(first.break.includes('5-minute short break'));
    const fourth = run({ tasks: [task('a')], timer: { status: 'idle', mode: 'focus', cycleFocusCount: 3 } });
    assert.ok(fourth.break.includes('15-minute long break'));
    assert.ok(first.break.includes('not a measurement'));
  });

  await test('invalid settings and timer fall back to defaults', () => {
    const r = run({ tasks: [task('a')], settings: { focusMinutes: 'x', shortBreakMinutes: -1 }, timer: { status: 'weird', mode: 5, cycleFocusCount: 'z' } });
    assert.ok(r.session.text.includes('25-minute'));
    assert.ok(r.break.includes('5-minute short break'));
    assert.doesNotThrow(() => run({ settings: null, timer: null }));
  });

  await test('invalid, duplicate and completed records are skipped and counted', () => {
    const r = run({ tasks: [null, 5, 'x', [], task(''), task('t', { title: '  ' }), task('ok'), task('ok'), task('done', { completed: true })] });
    assert.strictEqual(r.nextTask.id, 'ok');
    assert.strictEqual(r.skippedTasks, 7);
    assert.ok(r.notes.some((n) => n.includes('unreadable')));
    assert.doesNotThrow(() => run({ tasks: 'nope' }));
    assert.strictEqual(run({ tasks: 'nope' }).state, 'no-tasks');
  });

  await test('invalid date input never throws and recommends nothing', () => {
    for (const today of [undefined, 'nope', '2026-02-31']) {
      const r = rec.computeRecommendations({ tasks: [task('a')], today });
      assert.strictEqual(r.state, 'invalid-date');
      assert.strictEqual(r.nextTask, null);
    }
    assert.doesNotThrow(() => rec.computeRecommendations());
  });

  await test('history note needs 5 sessions on 3 days, and a real difference from the setting', () => {
    const base = [ses('a', 10, 20, 2700), ses('b', 10, 20, 2700), ses('c', 10, 21, 2700), ses('d', 10, 21, 2700)];
    assert.ok(!run({ tasks: [task('x')], sessions: base }).notes.some((n) => n.includes('average')));
    const five = [...base, ses('e', 10, 19, 2700)];
    const r = run({ tasks: [task('x')], sessions: five });
    assert.ok(r.notes.some((n) => n.includes('average 45 min') && n.includes('25 min')));
    const sameAsSetting = five.map((s) => ({ ...s, durationSeconds: 1500 }));
    assert.ok(!run({ tasks: [task('x')], sessions: sameAsSetting }).notes.some((n) => n.includes('average')));
  });

  await test('sessions: duplicates counted once, bad and future ones ignored, today count is honest', () => {
    const sessions = [ses('a', 10, 22), ses('a', 10, 22), ses('b', 10, 22), ses('future', 10, 30), { id: 'x', durationSeconds: 0, completedAt: ts(10, 22) }, null, 'q'];
    const r = run({ tasks: [task('x')], sessions });
    assert.ok(r.notes.includes('You have completed 2 focus sessions today.'));
    assert.ok(!run({ tasks: [task('x')], sessions: [] }).notes.some((n) => n.includes('completed')));
  });

  await test('always says that task duration is unknown', () => {
    assert.ok(run({ tasks: [task('a')] }).notes.some((n) => n.includes('do not store a duration')));
  });

  await test('deterministic, including when the task order changes', () => {
    const tasks = [task('a', { priority: 'low' }), task('b', { dueDate: '2026-10-10' }), task('c', { priority: 'high' }), task('d')];
    const first = run({ tasks });
    assert.deepStrictEqual(first, run({ tasks }));
    assert.deepStrictEqual(first, run({ tasks: [...tasks].reverse() }));
  });

  await test('inputs are never mutated', () => {
    const tasks = deepFreeze([task('a', { dueDate: '2026-10-10' }), task('b')]);
    const sessions = deepFreeze([ses('s', 10, 22)]);
    const settings = deepFreeze({ ...SET });
    const timer = deepFreeze({ ...IDLE });
    const before = JSON.stringify({ tasks, sessions, settings, timer });
    assert.doesNotThrow(() => rec.computeRecommendations({ tasks, sessions, settings, timer, today: TODAY }));
    assert.strictEqual(JSON.stringify({ tasks, sessions, settings, timer }), before);
  });

  await test('wording makes no productivity or health claims', () => {
    const r = run({ tasks: [task('a', { dueDate: '2026-10-01', priority: 'high' }), task('b')], sessions: [ses('s', 10, 22)] });
    const text = JSON.stringify(r);
    assert.ok(!/(improve|boost|prevent|cure|proven|optimal|burnout|lazy|guilt|should have|healthy)/i.test(text));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();