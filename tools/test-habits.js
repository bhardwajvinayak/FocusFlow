// tools/test-habits.js
// Usage (project root):  node tools/test-habits.js
// Copies js/focus-intelligence.js and js/habits.js into a temporary ES-module folder. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-habits-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const file of ['focus-intelligence.js', 'habits.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', file), path.join(dir, file));
}

// Thursday 22 Oct 2026, 14:00 local.
const NOW = new Date(2026, 9, 22, 14, 0, 0);
const ts = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const mk = (id, name, completions = [], over = {}) => ({ id, name, createdAt: ts(10, 1), archivedAt: null, completions, ...over });
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
// n consecutive days ending on y-m-d (independent calendar arithmetic for the tests)
const run = (y, m, d, n) => Array.from({ length: n }, (_, i) => keyOf(new Date(y, m - 1, d - (n - 1 - i))));
const many = (n, archived = 0) =>
  Array.from({ length: n }, (_, i) => mk(`a${i}`, `Habit ${i}`, [], i < archived ? { archivedAt: 5 } : {}));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const h = await import(pathToFileURL(path.join(dir, 'habits.js')).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const stats = (completions, now = NOW, over = {}) => h.computeHabitStats(mk('h', 'H', completions, over), now);
  const cellOf = (cal, date) => cal.weeks.flat().find((c) => c.date === date);

  await test('habit names: trimmed, 1 to 40 characters, text only', () => {
    assert.strictEqual(h.validateHabitName('  Read  ').value, 'Read');
    assert.strictEqual(h.validateHabitName('x'.repeat(40)).ok, true);
    for (const bad of ['', '   ', 'x'.repeat(41), null, 5, undefined]) {
      const r = h.validateHabitName(bad);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'invalid-name');
    }
  });

  await test('create a habit: trimmed name, empty completions, creation time', () => {
    const r = h.addHabit([], { name: ' Meditate ', id: 'h1', now: NOW });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.habit, { id: 'h1', name: 'Meditate', createdAt: NOW.getTime(), archivedAt: null, completions: [] });
    assert.strictEqual(r.habits.length, 1);
  });

  await test('create: invalid name or id leaves the list untouched', () => {
    const list = [mk('h1', 'A')];
    for (const r of [h.addHabit(list, { name: '', id: 'x' }), h.addHabit(list, { name: 'B', id: 'h1' }), h.addHabit(list, { name: 'B', id: '' })]) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.habits, list);
    }
  });

  await test('duplicate names: blocked among active habits (any case), allowed against archived ones', () => {
    const list = [mk('h1', 'Meditate')];
    assert.strictEqual(h.addHabit(list, { name: ' meditate ', id: 'x' }).code, 'duplicate-name');
    const withArchived = [mk('h1', 'Meditate', [], { archivedAt: 5 })];
    assert.strictEqual(h.addHabit(withArchived, { name: 'Meditate', id: 'x' }).ok, true);
  });

  await test('limits: 12 active and 40 total', () => {
    assert.strictEqual(h.addHabit(many(11), { name: 'New', id: 'n' }).ok, true);
    assert.strictEqual(h.addHabit(many(12), { name: 'New', id: 'n' }).code, 'limit-active');
    assert.strictEqual(h.addHabit(many(40, 30), { name: 'New', id: 'n' }).code, 'limit-total'); // 10 active, 30 archived
    assert.strictEqual(h.addHabit(many(39, 29), { name: 'New', id: 'n' }).ok, true);
  });

  await test('rename: success, same name, case change, conflicts, archived and missing', () => {
    const list = [mk('a', 'Meditate'), mk('b', 'Read'), mk('c', 'Old', [], { archivedAt: 5 })];
    const ok = h.renameHabit(list, 'a', ' Meditation ');
    assert.strictEqual(ok.habits[0].name, 'Meditation');
    assert.strictEqual(ok.changed, true);
    assert.strictEqual(h.renameHabit(list, 'a', 'Meditate').changed, false);
    assert.strictEqual(h.renameHabit(list, 'a', 'meditate').changed, true);
    assert.strictEqual(h.renameHabit(list, 'a', 'READ').code, 'duplicate-name');
    assert.strictEqual(h.renameHabit(list, 'c', 'New').code, 'archived');
    assert.strictEqual(h.renameHabit(list, 'zz', 'New').code, 'not-found');
    assert.strictEqual(h.renameHabit(list, 'a', '').code, 'invalid-name');
    assert.strictEqual(h.renameHabit(list, 'a', '').habits, list);
  });

  await test('archive and restore keep the history; restore respects the limits', () => {
    const list = [mk('a', 'Meditate', ['2026-10-20'])];
    const archived = h.archiveHabit(list, 'a', NOW);
    assert.strictEqual(archived.habits[0].archivedAt, NOW.getTime());
    assert.deepStrictEqual(archived.habits[0].completions, ['2026-10-20']);
    assert.strictEqual(h.archiveHabit(archived.habits, 'a', NOW).changed, false);
    assert.strictEqual(h.archiveHabit(list, 'zz', NOW).code, 'not-found');

    const restored = h.restoreHabit(archived.habits, 'a');
    assert.strictEqual(restored.habits[0].archivedAt, null);
    assert.strictEqual(h.restoreHabit(list, 'a').changed, false);

    const full = [...many(12), mk('z', 'Zzz', [], { archivedAt: 5 })];
    assert.strictEqual(h.restoreHabit(full, 'z').code, 'limit-active');
    const clash = [mk('a', 'Read'), mk('b', 'Read', [], { archivedAt: 5 })];
    assert.strictEqual(h.restoreHabit(clash, 'b').code, 'duplicate-name');
  });

  await test('completion window: today and 6 previous days only; no future; archived blocked', () => {
    const list = [mk('a', 'Meditate'), mk('z', 'Old', [], { archivedAt: 5 })];
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-22', true, NOW).ok, true);
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-16', true, NOW).ok, true);
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-15', true, NOW).code, 'outside-window');
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-23', true, NOW).code, 'future');
    assert.strictEqual(h.setCompletion(list, 'a', '2026-02-31', true, NOW).code, 'invalid-date');
    assert.strictEqual(h.setCompletion(list, 'a', 'nope', true, NOW).code, 'invalid-date');
    assert.strictEqual(h.setCompletion(list, 'zz', '2026-10-22', true, NOW).code, 'not-found');
    assert.strictEqual(h.setCompletion(list, 'z', '2026-10-22', true, NOW).code, 'archived');
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-22', 'yes', NOW).code, 'invalid');
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-23', true, NOW).habits, list);
  });

  await test('duplicate completion is a no-op; completions stay sorted; un-ticking works', () => {
    const list = [mk('a', 'Meditate', ['2026-10-21'])];
    const again = h.setCompletion(list, 'a', '2026-10-21', true, NOW);
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.habits, list);
    const added = h.setCompletion(list, 'a', '2026-10-19', true, NOW);
    assert.deepStrictEqual(added.habits[0].completions, ['2026-10-19', '2026-10-21']);
    const removed = h.setCompletion(added.habits, 'a', '2026-10-21', false, NOW);
    assert.deepStrictEqual(removed.habits[0].completions, ['2026-10-19']);
    assert.strictEqual(h.setCompletion(list, 'a', '2026-10-20', false, NOW).changed, false);
  });

  await test('current and best streaks', () => {
    assert.deepStrictEqual([stats([]).current, stats([]).best, stats([]).doneToday], [0, 0, false]);
    const withToday = stats(['2026-10-20', '2026-10-21', '2026-10-22']);
    assert.deepStrictEqual([withToday.current, withToday.best, withToday.doneToday], [3, 3, true]);
    assert.deepStrictEqual([stats(['2026-10-20', '2026-10-21']).current, stats(['2026-10-20', '2026-10-21']).best], [2, 2]); // today not ticked yet
    const gapped = stats(['2026-10-17', '2026-10-18', '2026-10-20', '2026-10-21']);
    assert.deepStrictEqual([gapped.current, gapped.best], [2, 2]);
    const old = stats(['2026-10-18']);
    assert.deepStrictEqual([old.current, old.best], [0, 1]);
    const afterBreak = stats([...run(2026, 10, 16, 7), '2026-10-21']);
    assert.deepStrictEqual([afterBreak.current, afterBreak.best], [1, 7]);
    assert.strictEqual(stats(['2026-10-21', '2026-10-20', '2026-10-21']).current, 2); // unsorted and duplicated
    assert.strictEqual(stats(['2026-10-23', '2026-10-21']).current, 1);               // a future date is ignored
  });

  await test('milestone boundaries at 3, 7, 14 and 30 days, with the date each was reached', () => {
    const earned = (n) => stats(run(2026, 10, 21, n)).milestones.map((m) => m.earned);
    assert.deepStrictEqual(earned(2), [false, false, false, false]);
    assert.deepStrictEqual(earned(3), [true, false, false, false]);
    assert.deepStrictEqual(earned(6), [true, false, false, false]);
    assert.deepStrictEqual(earned(7), [true, true, false, false]);
    assert.deepStrictEqual(earned(13), [true, true, false, false]);
    assert.deepStrictEqual(earned(14), [true, true, true, false]);
    assert.deepStrictEqual(earned(29), [true, true, true, false]);
    assert.deepStrictEqual(earned(30), [true, true, true, true]);
    const days = run(2026, 10, 21, 30);
    const dates = stats(days).milestones.map((m) => m.date);
    assert.deepStrictEqual(dates, [days[2], days[6], days[13], days[29]]);
    assert.strictEqual(stats(run(2026, 10, 21, 2)).milestones[0].date, null);
  });

  await test('a milestone stays earned after the current streak ends; next milestone follows the current streak', () => {
    const s = stats(run(2026, 10, 10, 7)); // ended long ago: current 0, best 7
    assert.strictEqual(s.current, 0);
    assert.strictEqual(s.milestones[1].earned, true);
    assert.deepStrictEqual(s.nextMilestone, { days: 3, remaining: 3 });
    assert.deepStrictEqual(stats(['2026-10-20', '2026-10-21']).nextMilestone, { days: 3, remaining: 1 });
    assert.deepStrictEqual(stats(run(2026, 10, 22, 3)).nextMilestone, { days: 7, remaining: 4 });
    assert.strictEqual(stats(run(2026, 10, 22, 30)).nextMilestone, null);
  });

  await test('newMilestones reports only a milestone that a change has just reached', () => {
    const before = stats(['2026-10-20', '2026-10-21']);
    const after = stats(['2026-10-20', '2026-10-21', '2026-10-22']);
    assert.deepStrictEqual(h.newMilestones(before, after), [3]);
    assert.deepStrictEqual(h.newMilestones(after, after), []);
    assert.deepStrictEqual(h.newMilestones(after, before), []);
  });

  await test('boundaries: Sunday to Monday, month, year, leap day and daylight-saving changes', () => {
    assert.strictEqual(stats(['2026-10-25', '2026-10-26'], new Date(2026, 9, 27, 12)).current, 2);
    assert.strictEqual(stats(['2026-02-27', '2026-02-28', '2026-03-01'], new Date(2026, 2, 2, 12)).current, 3);
    assert.strictEqual(stats(['2025-12-30', '2025-12-31', '2026-01-01'], new Date(2026, 0, 2, 12)).current, 3);
    assert.strictEqual(stats(['2028-02-28', '2028-02-29', '2028-03-01'], new Date(2028, 2, 2, 12)).current, 3);
    assert.strictEqual(stats(['2026-10-31', '2026-11-01', '2026-11-02'], new Date(2026, 10, 3, 12)).current, 3); // US clocks go back
    assert.strictEqual(stats(['2026-03-07', '2026-03-08', '2026-03-09'], new Date(2026, 2, 10, 12)).current, 3); // US clocks go forward
  });

  await test('local midnight: a streak survives until the day after tomorrow begins', () => {
    const done = ['2026-10-21'];
    const evening = stats(done, new Date(2026, 9, 21, 23, 59, 59));
    assert.deepStrictEqual([evening.doneToday, evening.current], [true, 1]);
    const justAfter = stats(done, new Date(2026, 9, 22, 0, 0, 1));
    assert.deepStrictEqual([justAfter.doneToday, justAfter.current], [false, 1]);
    assert.strictEqual(stats(done, new Date(2026, 9, 23, 0, 0, 1)).current, 0);
  });

  await test('loading: malformed habits are skipped and counted, completions are cleaned', () => {
    const raw = {
      schemaVersion: 1,
      habits: [
        null, 5, 'x', [],
        { id: '', name: 'A', createdAt: 1 },
        { id: 'b', name: '   ', createdAt: 1 },
        { id: 'c', name: 'x'.repeat(41), createdAt: 1 },
        { id: 'd', name: 'D', createdAt: NaN },
        { id: 'e', name: 'E', createdAt: 1, archivedAt: 'yes' },
        mk('ok', '  Read  ', ['2026-10-21', '2026-10-19', '2026-10-21', '2026-10-30', 'nope', '2026-02-31']),
        mk('ok', 'Dup'),
      ],
    };
    const { habits, skipped } = h.cleanHabits(raw, NOW);
    assert.strictEqual(habits.length, 1);
    assert.strictEqual(habits[0].name, 'Read');
    assert.deepStrictEqual(habits[0].completions, ['2026-10-19', '2026-10-21']);
    assert.deepStrictEqual(skipped, { invalid: 9, duplicates: 1, overLimit: 0, droppedDates: 4 });
    assert.deepStrictEqual(h.cleanHabits('junk').habits, []);
    assert.deepStrictEqual(h.cleanHabits({ habits: 'x' }).habits, []);
    assert.doesNotThrow(() => h.cleanHabits());
  });

  await test('loading: more than 40 habits keeps the first 40 and counts the rest', () => {
    const raw = { habits: Array.from({ length: 45 }, (_, i) => mk(`h${i}`, `H${i}`)) };
    const { habits, skipped } = h.cleanHabits(raw, NOW);
    assert.strictEqual(habits.length, 40);
    assert.strictEqual(skipped.overLimit, 5);
  });

  await test('storage container check: valid shapes are kept, broken ones become empty', () => {
    const good = { schemaVersion: 1, habits: [] };
    assert.deepStrictEqual(h.normalizeHabitsContainer(good), { value: good, repaired: false });
    for (const bad of [null, 'x', 5, {}, { habits: 'x' }]) {
      const r = h.normalizeHabitsContainer(bad);
      assert.deepStrictEqual(r.value, { schemaVersion: 1, habits: [] });
      assert.strictEqual(r.repaired, true);
    }
    assert.strictEqual(h.normalizeHabitsContainer({ habits: [] }).repaired, true);
    const withBadHabit = { schemaVersion: 1, habits: [null, { id: 'x' }] };
    assert.strictEqual(h.normalizeHabitsContainer(withBadHabit).value, withBadHabit); // never rewritten at startup
  });

  await test('calendar: days before the habit started are never "not-done"', () => {
    const habit = mk('h', 'H', ['2026-10-12', '2026-10-21'], { createdAt: ts(10, 10) });
    const cal = h.computeHabitCalendar(habit, NOW);
    assert.strictEqual(cal.weeks.length, 5);
    assert.ok(cal.weeks.every((week) => week.length === 7));
    assert.strictEqual(cal.startKey, '2026-09-21');
    assert.strictEqual(cal.endKey, '2026-10-25');
    assert.strictEqual(cellOf(cal, '2026-09-21').status, 'before-start');
    assert.strictEqual(cellOf(cal, '2026-10-09').status, 'before-start');
    assert.strictEqual(cellOf(cal, '2026-10-10').status, 'not-done');
    assert.strictEqual(cellOf(cal, '2026-10-12').status, 'done');
    assert.strictEqual(cellOf(cal, '2026-10-21').status, 'done');
    assert.strictEqual(cellOf(cal, '2026-10-22').status, 'not-done');
    assert.strictEqual(cellOf(cal, '2026-10-23').status, 'upcoming');
    assert.strictEqual(cellOf(cal, '2026-10-25').status, 'upcoming');
    const backfilled = h.computeHabitCalendar(mk('h', 'H', ['2026-10-17'], { createdAt: ts(10, 20) }), NOW);
    assert.strictEqual(cellOf(backfilled, '2026-10-16').status, 'before-start');
    assert.strictEqual(cellOf(backfilled, '2026-10-17').status, 'done');
  });

  await test('calendar and the seven day buttons: editable only within the window and for active habits', () => {
    const habit = mk('h', 'H', ['2026-10-21']);
    const cal = h.computeHabitCalendar(habit, NOW);
    assert.strictEqual(cellOf(cal, '2026-10-16').editable, true);
    assert.strictEqual(cellOf(cal, '2026-10-15').editable, false);
    assert.strictEqual(cellOf(cal, '2026-10-22').editable, true);
    assert.strictEqual(cellOf(cal, '2026-10-23').editable, false);
    const last = h.computeLastDays(habit, NOW);
    assert.deepStrictEqual(last.map((d) => d.date), run(2026, 10, 22, 7));
    assert.deepStrictEqual(last.map((d) => d.done), [false, false, false, false, false, true, false]);
    assert.ok(last.every((d) => d.editable));
    const archived = mk('h', 'H', ['2026-10-21'], { archivedAt: 5 });
    assert.ok(h.computeLastDays(archived, NOW).every((d) => !d.editable));
    assert.ok(h.computeHabitCalendar(archived, NOW).weeks.flat().every((c) => !c.editable));
  });

  await test('deterministic, and no function modifies its input', () => {
    const list = deepFreeze([mk('a', 'Meditate', ['2026-10-20', '2026-10-21']), mk('z', 'Old', [], { archivedAt: 5 })]);
    const before = JSON.stringify(list);
    assert.doesNotThrow(() => {
      h.addHabit(list, { name: 'New', id: 'n', now: NOW });
      h.renameHabit(list, 'a', 'Renamed');
      h.archiveHabit(list, 'a', NOW);
      h.restoreHabit(list, 'z');
      h.setCompletion(list, 'a', '2026-10-22', true, NOW);
      h.computeHabitStats(list[0], NOW);
      h.computeHabitCalendar(list[0], NOW);
      h.computeLastDays(list[0], NOW);
      h.cleanHabits({ habits: list }, NOW);
    });
    assert.strictEqual(JSON.stringify(list), before);
    assert.deepStrictEqual(h.computeHabitStats(list[0], NOW), h.computeHabitStats(list[0], NOW));
    assert.deepStrictEqual(h.computeHabitCalendar(list[0], NOW), h.computeHabitCalendar(list[0], NOW));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();