// tools/test-goals.js
// Usage (project root):  node tools/test-goals.js
// Copies js/focus-intelligence.js and js/goals.js into a temporary ES-module folder. No network, no Chrome.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-goals-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const file of ['focus-intelligence.js', 'goals.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'js', file), path.join(dir, file));
}

// Thursday 22 Oct 2026, 14:00 local. Its week runs Mon 19 Oct to Sun 25 Oct.
const NOW = new Date(2026, 9, 22, 14, 0, 0);
const ts = (m, d, h = 12, mi = 0, s = 0) => new Date(2026, m - 1, d, h, mi, s).getTime();
const ses = (id, m, d, seconds = 1500, h = 12) => ({ id, durationSeconds: seconds, completedAt: ts(m, d, h) });
const G = (over = {}) => ({ schemaVersion: 1, dailyFocusMinutes: null, weeklyFocusMinutes: null, dailySessions: null, ...over });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

(async () => {
  const g = await import(pathToFileURL(path.join(dir, 'goals.js')).href);
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (error) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
  };
  const prog = (sessions, goals = G(), now = NOW) => g.computeGoalProgress({ sessions, goals, now });
  const ach = (sessions, goals = G(), now = NOW) => g.computeAchievements({ sessions, goals, now });
  const byId = (r, id) => r.achievements.find((a) => a.id === id);

  /* ---------------- validation ---------------- */

  await test('all goals unset by default and when omitted', () => {
    assert.deepStrictEqual(g.DEFAULT_GOALS, G());
    for (const input of [{}, { dailyFocusMinutes: null, weeklyFocusMinutes: undefined, dailySessions: null }]) {
      const r = g.validateGoals(input);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.value, G());
    }
  });

  await test('minimum and maximum values are accepted (numbers and digit strings)', () => {
    assert.strictEqual(g.validateGoals({ dailyFocusMinutes: 5 }).ok, true);
    assert.strictEqual(g.validateGoals({ dailyFocusMinutes: '720' }).value.dailyFocusMinutes, 720);
    assert.strictEqual(g.validateGoals({ weeklyFocusMinutes: 15 }).ok, true);
    assert.strictEqual(g.validateGoals({ weeklyFocusMinutes: ' 5040 ' }).value.weeklyFocusMinutes, 5040);
    assert.strictEqual(g.validateGoals({ dailySessions: 1 }).ok, true);
    assert.strictEqual(g.validateGoals({ dailySessions: '24' }).value.dailySessions, 24);
    assert.strictEqual(g.validateGoals({ dailyFocusMinutes: 720, weeklyFocusMinutes: 5040 }).ok, true);
  });

  await test('just outside the limits is rejected', () => {
    for (const [field, value] of [['dailyFocusMinutes', 4], ['dailyFocusMinutes', 721], ['weeklyFocusMinutes', 14],
      ['weeklyFocusMinutes', 5041], ['dailySessions', 0], ['dailySessions', 25]]) {
      assert.strictEqual(g.validateGoals({ [field]: value }).ok, false, `${field}=${value}`);
    }
  });

  await test('blank, non-numeric, fractional, zero, negative and odd values are rejected for every goal', () => {
    const bad = ['', '   ', 'abc', '12.5', 12.5, 0, '0', -5, '-5', NaN, Infinity, true, '1e3', '5 0', '+10', {}, []];
    for (const field of ['dailyFocusMinutes', 'weeklyFocusMinutes', 'dailySessions']) {
      for (const value of bad) {
        const r = g.validateGoals({ [field]: value });
        assert.strictEqual(r.ok, false, `${field}=${JSON.stringify(value)}`);
        assert.strictEqual(r.value, null);
        assert.ok(r.errors.length >= 1);
      }
    }
    assert.ok(g.validateGoals({ dailyFocusMinutes: '' }).errors[0].includes('blank'));
    assert.strictEqual(g.validateGoals(null).ok, false);
  });

  await test('weekly goal must be at least the daily goal', () => {
    const bad = g.validateGoals({ dailyFocusMinutes: 120, weeklyFocusMinutes: 100 });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.errors[0].includes('at least'));
    assert.strictEqual(g.validateGoals({ dailyFocusMinutes: 120, weeklyFocusMinutes: 120 }).ok, true);
    assert.strictEqual(g.validateGoals({ weeklyFocusMinutes: 20 }).ok, true);
  });

  await test('invalid input never changes the saved goals (including partial updates)', () => {
    const current = G({ dailyFocusMinutes: 60, weeklyFocusMinutes: 300 });
    const frozen = deepFreeze({ ...current });
    const r = g.applyGoalsUpdate(frozen, { dailyFocusMinutes: 'abc', weeklyFocusMinutes: 400, dailySessions: 3 });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.goals, current);
    const ok = g.applyGoalsUpdate(frozen, { dailyFocusMinutes: 90, weeklyFocusMinutes: 400, dailySessions: 3 });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.goals, G({ dailyFocusMinutes: 90, weeklyFocusMinutes: 400, dailySessions: 3 }));
    assert.deepStrictEqual(frozen, current); // the stored object was not touched
  });

  await test('stored goals are normalized: bad fields become unset, good ones are kept', () => {
    const good = { schemaVersion: 1, dailyFocusMinutes: 60, weeklyFocusMinutes: 300, dailySessions: 4 };
    assert.deepStrictEqual(g.normalizeStoredGoals(good), { value: good, repaired: false });
    const bad = g.normalizeStoredGoals({ dailyFocusMinutes: '60', weeklyFocusMinutes: 99999, dailySessions: 2.5 });
    assert.deepStrictEqual(bad.value, G());
    assert.strictEqual(bad.repaired, true);
    assert.strictEqual(g.normalizeStoredGoals({ dailyFocusMinutes: 100, weeklyFocusMinutes: 50 }).value.weeklyFocusMinutes, null);
    assert.deepStrictEqual(g.normalizeStoredGoals('junk').value, G());
  });

  await test('reset: missing or cleared stored goals return to the unset state', () => {
    assert.deepStrictEqual(g.normalizeStoredGoals(undefined).value, G());
    assert.deepStrictEqual(g.normalizeStoredGoals({}).value, G());
  });

  /* ---------------- progress ---------------- */

  await test('unset goals: "Set a goal" state, no percentages', () => {
    const p = prog([ses('a', 10, 22)]);
    assert.strictEqual(p.daily.focusMinutes.set, false);
    assert.strictEqual(p.daily.sessions.set, false);
    assert.strictEqual(p.weekly.focusMinutes.set, false);
    assert.strictEqual(p.anyGoalSet, false);
    assert.strictEqual(p.totals.todayMinutes, 25);
  });

  await test('daily focus progress: floored minutes, never "met" early', () => {
    const goals = G({ dailyFocusMinutes: 60 });
    const almost = prog([ses('a', 10, 22, 2100), ses('b', 10, 22, 1440)], goals).daily.focusMinutes;
    assert.deepStrictEqual(almost, { set: true, goal: 60, done: 59, met: false, remaining: 1, percent: 98 });
    const exact = prog([ses('a', 10, 22, 2100), ses('b', 10, 22, 1440), ses('c', 10, 22, 60)], goals).daily.focusMinutes;
    assert.strictEqual(exact.done, 60);
    assert.strictEqual(exact.met, true);
    assert.strictEqual(exact.percent, 100);
  });

  await test('exceeding a goal shows the true total, not a capped one', () => {
    const m = prog([ses('a', 10, 22, 3000), ses('b', 10, 22, 3000), ses('c', 10, 22, 1500)], G({ dailyFocusMinutes: 25 })).daily.focusMinutes;
    assert.strictEqual(m.done, 125);
    assert.strictEqual(m.met, true);
    assert.strictEqual(m.percent, 500);
    assert.strictEqual(m.remaining, 0);
  });

  await test('daily session goal counts completed sessions once each', () => {
    const sessions = [ses('a', 10, 22), ses('a', 10, 22), ses('b', 10, 22), ses('c', 10, 22)];
    const three = prog(sessions, G({ dailySessions: 2 })).daily.sessions;
    assert.deepStrictEqual(three, { set: true, goal: 2, done: 3, met: true, remaining: 0, percent: 150 });
    const four = prog(sessions, G({ dailySessions: 4 })).daily.sessions;
    assert.deepStrictEqual([four.done, four.met, four.remaining, four.percent], [3, false, 1, 75]);
  });

  await test('weekly progress is week to date and excludes last week and future days', () => {
    const p = prog([ses('m', 10, 19), ses('w', 10, 21), ses('prevSun', 10, 18, 3000), ses('fut', 10, 24)], G({ weeklyFocusMinutes: 100 }));
    assert.strictEqual(p.weekStartKey, '2026-10-19');
    assert.strictEqual(p.daysElapsed, 4);
    assert.strictEqual(p.totals.weekSessions, 2);
    assert.strictEqual(p.weekly.focusMinutes.done, 50);
    assert.strictEqual(p.weekly.focusMinutes.percent, 50);
  });

  await test('invalid, cancelled, malformed and future records are ignored', () => {
    const p = prog([null, 5, 'x', { id: 'a', durationSeconds: 0, completedAt: ts(10, 22) }, { id: 'b', durationSeconds: 1500, completedAt: NaN },
      { id: 'c', durationSeconds: 1500, completedAt: ts(10, 22), cancelled: true }, { id: 'd', durationSeconds: 1500, completedAt: ts(11, 30) }, ses('ok', 10, 22)]);
    assert.strictEqual(p.totals.todaySessions, 1);
  });

  await test('dev-mode sessions are excluded unless DEV_MODE is on', () => {
    const list = [{ ...ses('a', 10, 22), dev: true }, { ...ses('b', 10, 22), dev: false }, ses('c', 10, 22)];
    assert.deepStrictEqual(g.excludeDevSessions(list, false).map((s) => s.id), ['b', 'c']);
    assert.strictEqual(g.excludeDevSessions(list, true).length, 3);
    assert.deepStrictEqual(g.excludeDevSessions('nope', false), []);
  });

  await test('local midnight and Sunday/Monday boundaries', () => {
    const sessions = [
      { id: 'x', durationSeconds: 1500, completedAt: new Date(2026, 9, 21, 23, 59, 59).getTime() },
      { id: 'y', durationSeconds: 1500, completedAt: new Date(2026, 9, 22, 0, 0, 1).getTime() },
    ];
    assert.strictEqual(prog(sessions, G(), new Date(2026, 9, 22, 0, 0, 2)).totals.todaySessions, 1);

    const sunday = [{ id: 's', durationSeconds: 1500, completedAt: new Date(2026, 9, 25, 23, 59, 50).getTime() }];
    const beforeMidnight = prog(sunday, G(), new Date(2026, 9, 25, 23, 59, 59));
    assert.strictEqual(beforeMidnight.totals.weekSessions, 1);
    assert.strictEqual(beforeMidnight.daysElapsed, 7);
    const afterMidnight = prog(sunday, G(), new Date(2026, 9, 26, 0, 0, 10));
    assert.strictEqual(afterMidnight.weekStartKey, '2026-10-26');
    assert.strictEqual(afterMidnight.totals.weekSessions, 0);
    assert.strictEqual(afterMidnight.totals.todaySessions, 0);
  });

  /* ---------------- achievements ---------------- */

  await test('no sessions: nothing earned, goal achievements need a goal', () => {
    const r = ach([]);
    assert.strictEqual(r.achievements.length, 8);
    for (const id of ['first-session', 'sessions-10', 'sessions-50', 'focus-300', 'streak-3', 'streak-7']) {
      assert.strictEqual(byId(r, id).status, 'locked');
      assert.strictEqual(byId(r, id).date, null);
    }
    assert.strictEqual(byId(r, 'daily-goal').status, 'needs-goal');
    assert.strictEqual(byId(r, 'weekly-goal').status, 'needs-goal');
    assert.strictEqual(r.summary.earnedCount, 0);
    assert.strictEqual(r.summary.currentStreak, 0);
  });

  await test('session-count thresholds at exactly 1, 10 and 50', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ses(`s${i}`, 10, 20));
    assert.strictEqual(byId(ach(many(1)), 'first-session').status, 'earned');
    assert.strictEqual(byId(ach(many(1)), 'first-session').date, '2026-10-20');
    assert.deepStrictEqual(byId(ach(many(9)), 'sessions-10').progress, { current: 9, target: 10, unit: 'sessions' });
    assert.strictEqual(byId(ach(many(9)), 'sessions-10').status, 'locked');
    assert.strictEqual(byId(ach(many(10)), 'sessions-10').status, 'earned');
    assert.strictEqual(byId(ach(many(49)), 'sessions-50').status, 'locked');
    assert.strictEqual(byId(ach(many(50)), 'sessions-50').status, 'earned');
    assert.strictEqual(byId(ach(many(50)), 'sessions-50').date, '2026-10-20');
  });

  await test('five hours: exactly 300 minutes earns it, one second less does not', () => {
    const twelve = [...Array.from({ length: 6 }, (_, i) => ses(`a${i}`, 10, 19)), ...Array.from({ length: 6 }, (_, i) => ses(`b${i}`, 10, 20))];
    const earned = byId(ach(twelve), 'focus-300');
    assert.strictEqual(earned.status, 'earned');
    assert.strictEqual(earned.date, '2026-10-20');
    const almost = [...Array.from({ length: 11 }, (_, i) => ses(`c${i}`, 10, 20)), ses('last', 10, 20, 1499)];
    const locked = byId(ach(almost), 'focus-300');
    assert.strictEqual(locked.status, 'locked');
    assert.deepStrictEqual(locked.progress, { current: 299, target: 300, unit: 'minutes' });
  });

  await test('streak boundaries (3 and 7 consecutive days) and the date they were reached', () => {
    const days = (list) => list.map((d, i) => ses(`d${i}`, 10, d));
    const three = ach(days([19, 20, 21]));
    assert.strictEqual(byId(three, 'streak-3').status, 'earned');
    assert.strictEqual(byId(three, 'streak-3').date, '2026-10-21');
    assert.deepStrictEqual(byId(three, 'streak-7').progress, { current: 3, target: 7, unit: 'days' });
    const seven = ach(days([16, 17, 18, 19, 20, 21, 22]));
    assert.strictEqual(byId(seven, 'streak-3').date, '2026-10-18');
    assert.strictEqual(byId(seven, 'streak-7').status, 'earned');
    assert.strictEqual(byId(seven, 'streak-7').date, '2026-10-22');
    assert.strictEqual(byId(ach(days([16, 17, 19, 20])), 'streak-3').status, 'locked');
    const yearEnd = [ses('a', 12, 30), { id: 'b', durationSeconds: 1500, completedAt: new Date(2025, 11, 31, 12).getTime() }, { id: 'c', durationSeconds: 1500, completedAt: new Date(2026, 0, 1, 12).getTime() }];
    const crossing = byId(ach([{ id: 'a', durationSeconds: 1500, completedAt: new Date(2025, 11, 30, 12).getTime() }, ...yearEnd.slice(1)], G(), new Date(2026, 0, 2, 12)), 'streak-3');
    assert.strictEqual(crossing.status, 'earned');
    assert.strictEqual(crossing.date, '2026-01-01');
  });

  await test('a missing session today does not break a streak that ended yesterday', () => {
    const days = (list) => list.map((d, i) => ses(`d${i}`, 10, d));
    assert.strictEqual(ach(days([20, 21])).summary.currentStreak, 2);
    assert.strictEqual(ach(days([20, 21, 22])).summary.currentStreak, 3);
    assert.strictEqual(ach(days([19, 21])).summary.currentStreak, 1);
    assert.strictEqual(ach(days([18, 19])).summary.currentStreak, 0);
  });

  await test('daily focus goal achievement', () => {
    assert.strictEqual(byId(ach([ses('a', 10, 20, 3000)]), 'daily-goal').status, 'needs-goal');
    const met = byId(ach([ses('a', 10, 20, 3000)], G({ dailyFocusMinutes: 50 })), 'daily-goal');
    assert.strictEqual(met.status, 'earned');
    assert.strictEqual(met.date, '2026-10-20');
    const near = byId(ach([ses('a', 10, 20, 2940)], G({ dailyFocusMinutes: 50 })), 'daily-goal');
    assert.strictEqual(near.status, 'locked');
    assert.deepStrictEqual(near.progress, { current: 49, target: 50, unit: 'minutes' });
  });

  await test('weekly focus goal achievement (partial week counts) and earliest date', () => {
    const goals = G({ weeklyFocusMinutes: 100 });
    const met = byId(ach([ses('a', 10, 19, 3000), ses('b', 10, 20, 3000)], goals), 'weekly-goal');
    assert.strictEqual(met.status, 'earned');
    assert.strictEqual(met.date, '2026-10-20');
    const near = byId(ach([ses('a', 10, 19, 3000), ses('b', 10, 20, 2940)], goals), 'weekly-goal');
    assert.strictEqual(near.status, 'locked');
    assert.strictEqual(near.progress.current, 99);
    const earlier = byId(ach([ses('x', 10, 12, 6000), ses('a', 10, 19, 3000), ses('b', 10, 20, 3000)], goals), 'weekly-goal');
    assert.strictEqual(earlier.date, '2026-10-12');
  });

  await test('duplicates and malformed records never create false achievements', () => {
    const dup = ach(Array.from({ length: 10 }, () => ses('same', 10, 20)));
    assert.strictEqual(byId(dup, 'first-session').status, 'earned');
    assert.strictEqual(byId(dup, 'sessions-10').status, 'locked');
    assert.strictEqual(byId(dup, 'sessions-10').progress.current, 1);
    const junk = ach([null, 5, 'x', { id: 'a', durationSeconds: -1, completedAt: ts(10, 20) }, { id: 'b', durationSeconds: 1500, completedAt: 'x' }, ses('f', 11, 30)]);
    assert.strictEqual(byId(junk, 'first-session').status, 'locked');
    assert.strictEqual(junk.summary.totalSessions, 0);
  });

  await test('deterministic, order-independent and never mutating', () => {
    const list = [ses('a', 10, 19), ses('b', 10, 20), ses('c', 10, 21, 3000)];
    const goals = G({ dailyFocusMinutes: 50, weeklyFocusMinutes: 200 });
    assert.deepStrictEqual(ach(list, goals), ach(list, goals));
    assert.deepStrictEqual(ach(list, goals), ach([...list].reverse(), goals));
    const frozenList = deepFreeze([ses('a', 10, 19), ses('a', 10, 19)]);
    const frozenGoals = deepFreeze(G({ dailyFocusMinutes: 50 }));
    const before = JSON.stringify({ frozenList, frozenGoals });
    assert.doesNotThrow(() => { ach(frozenList, frozenGoals); prog(frozenList, frozenGoals); });
    assert.strictEqual(JSON.stringify({ frozenList, frozenGoals }), before);
  });

  await test('achievement wording makes no health or productivity claims', () => {
    const text = JSON.stringify(ach([ses('a', 10, 20)], G({ dailyFocusMinutes: 50, weeklyFocusMinutes: 100 })));
    assert.ok(!/(productiv|healthy|burnout|lazy|guilt|should have|wasted|best ever)/i.test(text));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
})();