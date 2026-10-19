// tools/test-planner.js
// Usage (project root):  node tools/test-planner.js
// Loads js/planner.js (an ES module) through a temporary .mjs copy. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const temp = path.join(os.tmpdir(), `ff-planner-${process.pid}.mjs`);
fs.copyFileSync(path.join(__dirname, '..', 'js', 'planner.js'), temp);

const TODAY = '2026-10-19';
const S = { startTime: '09:00', availableMinutes: 120, sessionMinutes: 25, breakMinutes: 5, defaultTaskMinutes: 25 };
const mk = (id, over = {}) => ({ id, title: id, completed: false, priority: 'medium', dueDate: null, createdAt: 1, ...over });
const labels = (plan) => plan.blocks.map((b) => `${b.type}:${b.startLabel}-${b.endLabel}`);
const order = (plan) => plan.scheduled.map((t) => t.taskId);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const { planDay, planToText, validatePlannerSettings } = await import(pathToFileURL(temp).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const run = (tasks, settings = S, estimates = {}) => planDay({ tasks, settings, estimates, today: TODAY });

  await test('empty task list', () => {
    const plan = run([]);
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(plan.blocks, []);
    assert.deepStrictEqual(plan.unscheduled, []);
    assert.strictEqual(plan.totals.freeMinutes, 120);
    assert.strictEqual(plan.totals.endsAt, '09:00');
  });

  await test('all tasks completed', () => {
    const plan = run([mk('a', { completed: true }), mk('b', { completed: true })]);
    assert.strictEqual(plan.blocks.length, 0);
    assert.strictEqual(plan.ignored.completed, 2);
  });

  await test('overdue tasks rank above everything, regardless of priority', () => {
    const plan = run([
      mk('A', { dueDate: '2026-10-25', priority: 'high' }),
      mk('B', { dueDate: '2026-10-10', priority: 'low' }),
      mk('C', { priority: 'high' }),
    ]);
    assert.deepStrictEqual(order(plan), ['B', 'A', 'C']);
    assert.strictEqual(plan.scheduled[0].overdue, true);
    assert.deepStrictEqual(labels(plan), [
      'work:09:00-09:25', 'break:09:25-09:30', 'work:09:30-09:55', 'break:09:55-10:00', 'work:10:00-10:25',
    ]);
  });

  await test('deadline tiers and priority tie-breaking', () => {
    const plan = run(
      [
        mk('D1', { dueDate: '2026-10-19', priority: 'medium' }),
        mk('D2', { dueDate: '2026-10-21', priority: 'high' }),
        mk('D3', { dueDate: '2026-10-21', priority: 'low' }),
        mk('D4', { dueDate: '2026-10-19', priority: 'high' }),
        mk('E', { priority: 'high' }),
        mk('F', { dueDate: '2026-10-30', priority: 'high' }),
      ],
      { ...S, availableMinutes: 480 }
    );
    assert.deepStrictEqual(order(plan), ['D4', 'D1', 'D2', 'D3', 'F', 'E']);
  });

  await test('older task first, then id, as the final tie-breaks', () => {
    const plan = run([mk('b', { createdAt: 5 }), mk('a', { createdAt: 5 }), mk('c', { createdAt: 1 })]);
    assert.deepStrictEqual(order(plan), ['c', 'a', 'b']);
  });

  await test('tasks fit exactly within the available time', () => {
    const plan = run([mk('p1', { priority: 'high' }), mk('p2', { priority: 'low' })], { ...S, availableMinutes: 55 });
    assert.deepStrictEqual(labels(plan), ['work:09:00-09:25', 'break:09:25-09:30', 'work:09:30-09:55']);
    assert.strictEqual(plan.totals.freeMinutes, 0);
    assert.strictEqual(plan.totals.endsAt, '09:55');
    assert.strictEqual(plan.unscheduled.length, 0);
  });

  await test('task that would overrun the window is not scheduled', () => {
    const plan = run([mk('p1', { priority: 'high' }), mk('p2', { priority: 'low' })], { ...S, availableMinutes: 50 });
    assert.deepStrictEqual(order(plan), ['p1']);
    assert.strictEqual(plan.unscheduled[0].taskId, 'p2');
    assert.strictEqual(plan.unscheduled[0].reason, 'no-time');
    assert.ok(plan.blocks.every((b) => b.end <= 9 * 60 + 50));
  });

  await test('a task longer than the whole window is reported, and a shorter later task still fits', () => {
    const plan = run(
      [mk('big', { priority: 'high' }), mk('small', { priority: 'low' })],
      { ...S, availableMinutes: 50, sessionMinutes: 60 },
      { big: 60 }
    );
    assert.strictEqual(plan.unscheduled[0].taskId, 'big');
    assert.strictEqual(plan.unscheduled[0].reason, 'longer-than-window');
    assert.deepStrictEqual(order(plan), ['small']);
  });

  await test('breaks: none after the last task, and none when break length is 0', () => {
    const plan = run([mk('a'), mk('b')]);
    assert.strictEqual(plan.blocks[plan.blocks.length - 1].type, 'work');
    const noBreaks = run([mk('a'), mk('b')], { ...S, breakMinutes: 0 });
    assert.deepStrictEqual(labels(noBreaks), ['work:09:00-09:25', 'work:09:25-09:50']);
  });

  await test('long task is split into balanced parts with breaks between them', () => {
    const plan = run([mk('long')], S, { long: 60 });
    assert.deepStrictEqual(labels(plan), [
      'work:09:00-09:20', 'break:09:20-09:25', 'work:09:25-09:45', 'break:09:45-09:50', 'work:09:50-10:10',
    ]);
    assert.deepStrictEqual(plan.blocks.filter((b) => b.type === 'work').map((b) => `${b.part}/${b.parts}`), ['1/3', '2/3', '3/3']);
  });

  await test('missing, zero, negative, text and huge estimates use the default safely', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => mk(id));
    const plan = run(tasks, { ...S, availableMinutes: 720 }, { a: 0, b: -5, c: 'abc', d: 10000, e: 30, f: '45' });
    const by = Object.fromEntries(plan.scheduled.map((t) => [t.taskId, t]));
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.strictEqual(by[id].minutes, 25);
      assert.strictEqual(by[id].estimateSource, 'default');
      assert.notStrictEqual(by[id].estimateNote, '');
    }
    assert.strictEqual(by.g.estimateSource, 'default');
    assert.strictEqual(by.g.estimateNote, '');
    assert.strictEqual(by.e.minutes, 30);
    assert.strictEqual(by.f.minutes, 45);
    assert.strictEqual(plan.unscheduled.length, 0);
  });

  await test('malformed tasks are ignored; bad due date and priority are neutralised', () => {
    const plan = run([null, 5, 'x', mk(''), mk('t', { title: '   ' }), mk('u', { completed: 'no' }), mk('ok'),
      mk('z', { dueDate: '2026-02-31', priority: 'urgent' })]);
    assert.strictEqual(plan.ignored.invalid, 6);
    const z = plan.scheduled.find((t) => t.taskId === 'z');
    assert.strictEqual(z.dueDate, null);
    assert.strictEqual(z.priority, 'medium');
  });

  await test('no task is scheduled twice', () => {
    const plan = run([mk('a'), mk('a'), mk('b')]);
    assert.strictEqual(plan.ignored.duplicates, 1);
    const ids = plan.scheduled.map((t) => t.taskId);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(plan.scheduled.length + plan.unscheduled.length, 2);
  });

  await test('deterministic: same input, and shuffled input, give identical output', () => {
    const tasks = [mk('a', { priority: 'low' }), mk('b', { dueDate: '2026-10-10' }), mk('c', { priority: 'high' }), mk('d')];
    const first = run(tasks);
    assert.deepStrictEqual(first, run(tasks));
    assert.deepStrictEqual(first, run([...tasks].reverse()));
  });

  await test('planning never mutates its inputs', () => {
    const tasks = deepFreeze([mk('a', { dueDate: '2026-10-10' }), mk('b')]);
    const settings = deepFreeze({ ...S });
    const estimates = deepFreeze({ a: 40 });
    const before = JSON.stringify({ tasks, settings, estimates });
    assert.doesNotThrow(() => planDay({ tasks, settings, estimates, today: TODAY }));
    assert.strictEqual(JSON.stringify({ tasks, settings, estimates }), before);
  });

  await test('invalid planning settings are rejected with clear messages', () => {
    const bad = (over) => run([mk('a')], { ...S, ...over });
    assert.strictEqual(bad({ startTime: '25:00' }).ok, false);
    assert.strictEqual(bad({ startTime: '9:00' }).ok, false);
    assert.strictEqual(bad({ startTime: '' }).ok, false);
    assert.strictEqual(bad({ availableMinutes: 5 }).ok, false);
    assert.strictEqual(bad({ availableMinutes: 721 }).ok, false);
    assert.strictEqual(bad({ availableMinutes: 'abc' }).ok, false);
    assert.strictEqual(bad({ availableMinutes: 90.5 }).ok, false);
    assert.strictEqual(bad({ sessionMinutes: 4 }).ok, false);
    assert.strictEqual(bad({ breakMinutes: 61 }).ok, false);
    assert.strictEqual(bad({ defaultTaskMinutes: 3 }).ok, false);
    assert.strictEqual(planDay({ tasks: [], today: TODAY }).ok, false);
    assert.strictEqual(planDay({ tasks: [], settings: S, today: 'nope' }).ok, false);
    const many = bad({ startTime: '', availableMinutes: 'x' });
    assert.ok(many.errors.length >= 2);
  });

  await test('the plan may end at midnight but not pass it', () => {
    assert.strictEqual(validatePlannerSettings({ ...S, startTime: '22:00', availableMinutes: 120 }).ok, true);
    const over = validatePlannerSettings({ ...S, startTime: '22:00', availableMinutes: 121 });
    assert.strictEqual(over.ok, false);
    assert.ok(over.errors.join(' ').includes('midnight'));
  });

  await test('non-array tasks are treated as empty; plain-text export works', () => {
    assert.strictEqual(planDay({ tasks: 'nope', settings: S, today: TODAY }).blocks.length, 0);
    const text = planToText(run([mk('Write report', { priority: 'high' })]));
    assert.ok(text.includes('09:00-09:25  Write report [High priority]'));
  });

  fs.unlinkSync(temp);
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();