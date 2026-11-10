// Daily game and KPI logic on a real SQLite database (test/d1.js) with a fixture pool and schedule.
// HTTP wiring is covered by test/smoke.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1.js';
import {
  EPOCH, dayNumber, todayUTC, isDate, addDays, shareText, logRatioError, scorePlay, histFromPatterns, sumAgg,
  loadDaily, getDay, answer, complete, dayStats, flag,
} from '../functions/_daily.js';
import { computeKpi, runKpi, latestKpi, authorized } from '../functions/_kpi.js';

const item = (id, category, prompt, unit, answerValue, accept) => ({
  id, type: 'interval', category, domain: 'geography', en: { prompt, unit }, answer: answerValue, accept,
  source: `https://www.wikidata.org/wiki/Q${id.slice(1)}#P2044`,
});
const POOL = {
  items: [
    item('w0001', 'mountain_elevation', 'How high is Mont Blanc above sea level?', 'm', 4806, [0, 9000]),
    item('w0002', 'river_length', 'How long is the Danube river?', 'km', 2850, [1, 8000]),
    item('w0003', 'element_melting_point', 'At what temperature does mercury melt?', '°C', -38.8, [-273, 4000]),
    item('w0004', 'building_height', 'How tall is Burj Khalifa?', 'm', 828, [1, 1000]),
    item('w0005', 'first_flight', 'In what year did the Boeing 747 first fly?', 'year', 1969, [1890, 2030]),
    item('w0006', 'country_area', 'What is the area of Portugal?', 'km²', 92212, [0.1, 20000000]),
  ],
};
// Fixture days around day #1, derived from EPOCH so a new launch date or a re-curated live schedule never breaks
// these tests (only the day-number test below pins the actual epoch). PREV is a pre-launch day (#0).
const DAY = EPOCH;
const PREV = addDays(EPOCH, -1);
const NEXT = addDays(EPOCH, 1);
const SCHEDULE = {
  [PREV]: ['w0006', 'w0001', 'w0003', 'w0004', 'w0005'],
  [DAY]: ['w0001', 'w0002', 'w0003', 'w0004', 'w0005'],
  [NEXT]: ['w0006', 'w0002', 'w0003', 'w0004', 'w0005'],
};
const DATA = loadDaily(POOL, SCHEDULE);
const NOW = new Date(`${DAY}T12:00:00Z`);
const URL_ = 'https://whosbluffing.example/';
const truth = (id) => DATA.items.get(id).answer;
const inside = (t) => [t - 10 - Math.abs(t), t + 10 + Math.abs(t)];
const above = (t) => [t + 10 + Math.abs(t), t + 20 + 2 * Math.abs(t)];
const anon = (k) => `anon-${k}`.padEnd(22, 'x');

// Answers every non-retired item of `date` (hits: one boolean per scheduled item), then completes.
async function play(db, who, hits, { date = DAY, surface = 'web', community, now = NOW } = {}) {
  const day = await getDay(db, DATA, date, now);
  for (const it of day.body.items) {
    const k = SCHEDULE[date].indexOf(it.id);
    const [low, high] = (hits[k] ? inside : above)(truth(it.id));
    const r = await answer(db, DATA, { date, item_id: it.id, low, high, anon_id: anon(who), surface, community, rt_ms: 4200 }, now);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return complete(db, DATA, { date, anon_id: anon(who), surface, community }, now, URL_);
}

test('day number and UTC day: 2026-10-17 is #1, earlier days are #0, days change at midnight UTC', () => {
  assert.equal(EPOCH, '2026-10-17');
  assert.equal(dayNumber('2026-10-17'), 1);
  assert.equal(dayNumber('2026-10-18'), 2);
  assert.equal(dayNumber('2026-10-20'), 4);
  assert.equal(dayNumber('2027-01-01'), 77);
  assert.equal(dayNumber('2026-10-16'), 0); // pre-launch days clamp to #0, never negative
  assert.equal(dayNumber('2026-10-03'), 0);
  assert.equal(dayNumber('2025-01-01'), 0);
  assert.equal(dayNumber('2028-03-01') - dayNumber('2028-02-28'), 2); // leap day
  assert.equal(todayUTC(new Date('2026-10-20T23:59:59Z')), '2026-10-20');
  assert.equal(todayUTC(new Date('2026-10-21T01:30:00+02:00')), '2026-10-20'); // 23:30 UTC
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '', null, 20261020]) assert.equal(isDate(bad), false, String(bad));
  assert.equal(isDate('2028-02-29'), true);
});

test('share text: brief format, 🟩 hit / 🟥 miss, one decimal average', () => {
  const grid = [true, true, false, true, true];
  assert.equal(shareText({ number: 12, grid, hits: 4, n: 5, avg: 2.8, url: 'https://whosbluffing.com/' }),
    "Who's Bluffing? #12 🟩🟩🟥🟩🟩 4/5 at 90%\nToday's average 2.8/5\nhttps://whosbluffing.com/");
  assert.equal(shareText({ number: 3, grid: [true, false, true, true], hits: 3, n: 4, avg: 3, url: 'u' }),
    "Who's Bluffing? #3 🟩🟥🟩🟩 3/4 at 90%\nToday's average 3.0/4\nu");
});

test('log ratio error: signed log10(midpoint / truth), null unless both are positive', () => {
  assert.equal(logRatioError(100, 300, 100), 0.30103);
  assert.equal(logRatioError(0, 200, 100), 0);
  assert.equal(logRatioError(1, 9, 50), -1);
  assert.equal(logRatioError(-50, -30, -38.8), null);
  assert.equal(logRatioError(-300, 100, 50), null);
});

test('scoring: retired items leave hits, n and the grid; hit patterns rebuild the histogram', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const answers = [{ item_id: 'a', hit: 1 }, { item_id: 'b', hit: 0 }, { item_id: 'c', hit: 1 }, { item_id: 'e', hit: 1 }];
  const s = scorePlay(ids, new Set(['c']), answers);
  assert.deepEqual(s, { hits: 2, n: 4, grid: [true, false, false, true], mask: 0b10101, missing: ['d'] });
  const patterns = Array(32).fill(0);
  patterns[0b10101] = 2; // a, c, e hit
  patterns[0b11111] = 1;
  patterns[0] = 4;
  assert.deepEqual(histFromPatterns(patterns, 0), [4, 0, 0, 2, 0, 1]);
  assert.deepEqual(histFromPatterns(patterns, 0b00100), [4, 0, 2, 0, 1, 0]); // c retired
  assert.deepEqual(sumAgg([{ players: 2, hits_hist: '[0,0,1,0,1,0]' }, { players: 1, hits_hist: '[1,0,0,0,0,0]' }]),
    { players: 3, avg_hits: 2, hist: [1, 0, 1, 0, 1, 0] });
  assert.deepEqual(sumAgg([{ players: 3, hits_hist: '[0,1,0,0,0,2]' }]), { players: 3, avg_hits: 3.67, hist: [0, 1, 0, 0, 0, 2] });
  assert.deepEqual(sumAgg([]), { players: 0, avg_hits: null, hist: [0, 0, 0, 0, 0, 0] });
});

test('GET daily: prompts only (no answers or sources); future and unscheduled days are 404', async () => {
  const db = openD1();
  const r = await getDay(db, DATA, null, NOW);
  assert.equal(r.status, 200);
  assert.equal(r.body.date, DAY);
  assert.equal(r.body.number, 1);
  assert.deepEqual(r.body.items.map((i) => i.id), SCHEDULE[DAY]);
  for (const it of r.body.items) assert.deepEqual(Object.keys(it).sort(), ['accept', 'id', 'prompt', 'unit']);
  assert.ok(!JSON.stringify(r.body).includes('wikidata'));
  assert.equal((await getDay(db, DATA, NEXT, NOW)).status, 404); // tomorrow
  assert.equal((await getDay(db, DATA, addDays(DAY, -10), NOW)).status, 404); // nothing scheduled
  assert.equal((await getDay(db, DATA, PREV, NOW)).body.number, 0); // pre-launch day
  assert.equal((await getDay(db, DATA, '2026-10-32', NOW)).status, 400);
});

test('answer: server computes the hit; a repeat returns the first result; the item is counted once', async () => {
  const db = openD1();
  const body = { date: DAY, item_id: 'w0001', low: 4000, high: 5000, anon_id: anon('a'), surface: 'web', rt_ms: 3000 };
  const first = await answer(db, DATA, body, NOW);
  assert.deepEqual(first, { status: 200, body: { hit: true, truth: 4806, source: 'https://www.wikidata.org/wiki/Q0001#P2044', log_ratio_error: -0.028571 } });
  const again = await answer(db, DATA, { ...body, low: 1, high: 2 }, NOW);
  assert.deepEqual(again, first);
  const rt = await db.prepare('SELECT * FROM items_runtime WHERE item_id = ?').bind('w0001').first();
  assert.deepEqual(rt, { item_id: 'w0001', retired_at: null, n_answers: 1, n_hits: 1, mean_log_err: 0.028571, n_log_err: 1 });
  const stored = await db.prepare('SELECT low, high, hit, rt_ms FROM daily_answers WHERE anon_id = ?').bind(anon('a')).all();
  assert.deepEqual(stored.results, [{ low: 4000, high: 5000, hit: 1, rt_ms: 3000 }]);
  await answer(db, DATA, { ...body, anon_id: anon('b'), low: 1, high: 2 }, NOW); // miss: log10(1.5 / 4806) = -3.505706
  const rt2 = await db.prepare('SELECT n_answers, n_hits, round(mean_log_err, 4) AS m FROM items_runtime WHERE item_id = ?').bind('w0001').first();
  assert.deepEqual(rt2, { n_answers: 2, n_hits: 1, m: 1.7671 }); // mean of |errors| (0.028571 + 3.505706) / 2
  const bad = (patch) => answer(db, DATA, { ...body, ...patch }, NOW).then((r) => [r.status, r.body.error]);
  assert.deepEqual(await bad({ low: 6000 }), [400, 'low and high must be numbers with low <= high']);
  assert.deepEqual(await bad({ high: 'x' }), [400, 'low and high must be numbers with low <= high']);
  assert.deepEqual(await bad({ item_id: 'w0006' }), [400, "item is not in that day's game"]);
  assert.deepEqual(await bad({ anon_id: 'not ok!' }), [400, 'bad anon_id']);
  assert.deepEqual(await bad({ anon_id: 42 }), [400, 'bad anon_id']);
  assert.deepEqual(await bad({ surface: 'discord' }), [400, 'surface must be web, slack or classroom']);
  assert.deepEqual(await bad({ date: NEXT }), [400, 'date must be today or yesterday (UTC)']); // tomorrow
  assert.deepEqual(await bad({ rt_ms: -5 }), [400, 'bad rt_ms']);
  assert.equal((await answer(db, DATA, null, NOW)).status, 400);
});

test('complete: every item first; counted once; streak over consecutive days; share text and day stats', async () => {
  const db = openD1();
  const early = await complete(db, DATA, { date: DAY, anon_id: anon('a'), surface: 'web' }, NOW, URL_);
  assert.deepEqual(early, { status: 400, body: { error: 'answer every question first' } });

  const yesterday = new Date(`${PREV}T20:00:00Z`);
  assert.equal((await play(db, 'a', [true, true, true, true, true], { date: PREV, now: yesterday })).body.streak, 1);
  const a = await play(db, 'a', [true, true, false, true, true]);
  assert.equal(a.status, 200);
  assert.equal(a.body.hits, 4);
  assert.equal(a.body.n, 5);
  assert.equal(a.body.streak, 2);
  assert.equal(a.body.share_text, `Who's Bluffing? #1 🟩🟩🟥🟩🟩 4/5 at 90%\nToday's average 4.0/5\n${URL_}`);
  assert.deepEqual(a.body.today, { players: 1, avg_hits: 4, hist: [0, 0, 0, 0, 1, 0] });

  assert.equal((await play(db, 'b', [true, false, false, true, false])).body.streak, 1);
  const c = await play(db, 'c', [false, false, false, false, false], { surface: 'slack', community: 'team-hash-1' });
  assert.deepEqual(c.body.today, { players: 3, avg_hits: 2, hist: [1, 0, 1, 0, 1, 0] });

  const again = await complete(db, DATA, { date: DAY, anon_id: anon('a'), surface: 'web' }, NOW, URL_);
  assert.equal(again.body.hits, 4);
  assert.equal(again.body.streak, 2);
  assert.equal(again.body.today.players, 3); // not counted twice
  const otherSurface = await complete(db, DATA, { date: DAY, anon_id: anon('a'), surface: 'classroom' }, NOW, URL_);
  assert.equal(otherSurface.body.today.players, 3); // one play per id and day, whatever the surface
  assert.deepEqual((await dayStats(db, DATA, DAY, NOW)).body, { players: 3, avg_hits: 2, hist: [1, 0, 1, 0, 1, 0] });

  const players = await db.prepare('SELECT anon_id, surface, plays, community FROM players ORDER BY anon_id').all();
  assert.deepEqual(players.results, [
    { anon_id: anon('a'), surface: 'web', plays: 2, community: null },
    { anon_id: anon('b'), surface: 'web', plays: 1, community: null },
    { anon_id: anon('c'), surface: 'slack', plays: 1, community: 'team-hash-1' },
  ]);
  const agg = await db.prepare('SELECT surface, players, hits_hist FROM daily_agg WHERE date = ? ORDER BY surface').bind(DAY).all();
  assert.deepEqual(agg.results, [
    { surface: 'slack', players: 1, hits_hist: '[1,0,0,0,0,0]' },
    { surface: 'web', players: 2, hits_hist: '[0,0,1,0,1,0]' },
  ]);
});

test('date rule: answer and complete take today or yesterday (UTC) only; yesterday scores its own items', async () => {
  const db = openD1();
  const justAfterMidnight = new Date(`${DAY}T00:05:00Z`);
  const yHits = [true, false, true, true, true]; // over yesterday's (PREV) schedule
  const r = await play(db, 'late', yHits, { date: PREV, now: justAfterMidnight });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.hits, r.body.n], [4, 5]);
  assert.match(r.body.share_text, /^Who's Bluffing\? #0 🟩🟥🟩🟩🟩 4\/5 at 90%/); // pre-launch day: #0
  const row = await db.prepare('SELECT date, surface, hits FROM plays WHERE anon_id = ?').bind(anon('late')).first();
  assert.deepEqual(row, { date: PREV, surface: 'web', hits: 4 });
  const w0006 = await db.prepare('SELECT hit FROM daily_answers WHERE anon_id = ? AND item_id = ?').bind(anon('late'), 'w0006').first();
  assert.deepEqual(w0006, { hit: 1 }); // w0006 is on yesterday's schedule, not today's
  for (const date of [addDays(DAY, -2), NEXT, addDays(PREV, -365)]) {
    const a = await answer(db, DATA, { date, item_id: 'w0003', low: -50, high: 0, anon_id: anon('late'), surface: 'web' }, justAfterMidnight);
    assert.deepEqual(a, { status: 400, body: { error: 'date must be today or yesterday (UTC)' } }, date);
    const c = await complete(db, DATA, { date, anon_id: anon('late'), surface: 'web' }, justAfterMidnight, URL_);
    assert.deepEqual(c, { status: 400, body: { error: 'date must be today or yesterday (UTC)' } }, date);
  }
  assert.equal((await getDay(db, DATA, PREV, NOW)).status, 200); // reading an earlier day is still allowed
});

test('community: stored on the player record from answer and complete; never for web', async () => {
  const db = openD1();
  const who = (k) => db.prepare('SELECT surface, plays, community FROM players WHERE anon_id = ?').bind(anon(k)).first();
  const body = { date: DAY, item_id: 'w0001', low: 1, high: 9000, anon_id: anon('s'), surface: 'slack', community: 'team-hash-1' };
  await answer(db, DATA, body, NOW);
  assert.deepEqual(await who('s'), { surface: 'slack', plays: 0, community: 'team-hash-1' }); // before completing
  await play(db, 's', [true, true, true, true, true], { surface: 'slack', community: 'team-hash-1' });
  assert.deepEqual(await who('s'), { surface: 'slack', plays: 1, community: 'team-hash-1' });
  await answer(db, DATA, { ...body, anon_id: anon('k'), surface: 'classroom', community: 'ABC234' }, NOW);
  assert.deepEqual(await who('k'), { surface: 'classroom', plays: 0, community: 'ABC234' });
  await play(db, 'w', [true, true, true, true, true], { community: 'ignored-on-web' });
  assert.deepEqual(await who('w'), { surface: 'web', plays: 1, community: null });
  const bad = await answer(db, DATA, { ...body, anon_id: anon('x'), community: 'has spaces' }, NOW);
  assert.deepEqual(bad, { status: 400, body: { error: 'bad community' } });
  assert.equal((await answer(db, DATA, { ...body, anon_id: 'a'.repeat(65) }, NOW)).status, 400);
  assert.equal((await answer(db, DATA, { ...body, anon_id: 'f'.repeat(64) }, NOW)).status, 200); // Slack: sha256 hex
});

test('flag: three players who answered retire an item; the day is recomputed; later players get 4 items', async () => {
  const db = openD1();
  await play(db, 'a', [true, true, false, true, true]); // 4
  await play(db, 'b', [true, false, false, true, false]); // 2
  await play(db, 'c', [false, false, false, false, false], { surface: 'slack', community: 'team-hash-1' }); // 0
  const f = (who, itemId = 'w0002') => flag(db, DATA, { item_id: itemId, anon_id: anon(who), reason: 'source disagrees' }, NOW);

  assert.deepEqual(await f('d'), { status: 403, body: { error: 'answer this question before flagging it' } });
  assert.equal((await flag(db, DATA, { item_id: 'w9999', anon_id: anon('a') }, NOW)).status, 400);
  assert.deepEqual((await f('a')).body, { ok: true });
  assert.deepEqual((await f('a')).body, { ok: true }); // same id twice = one flag
  await f('b');
  const before = await db.prepare('SELECT retired_at FROM items_runtime WHERE item_id = ?').bind('w0002').first();
  assert.equal(before.retired_at, null);
  await f('c');
  const after = await db.prepare('SELECT retired_at FROM items_runtime WHERE item_id = ?').bind('w0002').first();
  assert.equal(after.retired_at, NOW.toISOString());

  // a: 4 -> 3 (hit w0002), b: 2 -> 2, c: 0 -> 0
  assert.deepEqual((await dayStats(db, DATA, DAY, NOW)).body, { players: 3, avg_hits: 1.67, hist: [1, 0, 1, 1, 0, 0] });
  const day = await getDay(db, DATA, DAY, NOW);
  assert.deepEqual(day.body.items.map((i) => i.id), ['w0001', 'w0003', 'w0004', 'w0005']);
  const e = await play(db, 'e', [true, false, true, true, true]); // never sees w0002
  assert.equal(e.body.n, 4);
  assert.equal(e.body.hits, 4);
  assert.match(e.body.share_text, /^Who's Bluffing\? #1 🟩🟩🟩🟩 4\/4 at 90%\nToday's average 2\.3\/4\n/);
  assert.deepEqual(e.body.today, { players: 4, avg_hits: 2.25, hist: [1, 0, 1, 1, 1, 0] });
  const repeat = await complete(db, DATA, { date: DAY, anon_id: anon('a'), surface: 'web' }, NOW, URL_);
  assert.deepEqual([repeat.body.hits, repeat.body.n], [3, 4]); // a's play, rescored without the retired item
  assert.deepEqual((await f('d', 'w0006')).body, { error: 'answer this question before flagging it' }); // d never answered it
  const flags = await db.prepare('SELECT COUNT(*) AS n FROM item_flags').first();
  assert.equal(flags.n, 3);
});

test('KPI on a fixture DB: full assessments count per surface, classrooms from 5 sessions; daily range-game plays no longer count', async () => {
  const db = openD1();
  const playRow = (id, date, surface) => db.sqlite.prepare(`INSERT INTO plays (anon_id, date, surface, hits, n, completed_at, streak)
    VALUES (?, ?, ?, 3, 5, ?, 1)`).run(id, date, surface, `${date}T09:00:00.000Z`);
  const session = (id, created, anonId, classCode = null) => db.sqlite.prepare(`INSERT INTO sessions (id, created_at, lang, class_code, answers, anon_id)
    VALUES (?, ?, 'en', ?, '[]', ?)`).run(id, created, classCode, anonId);

  playRow('a1', '2026-10-20', 'web'); playRow('s1', '2026-10-31', 'slack'); // the retired daily game: not a play
  session('x-a1', '2026-10-31T10:00:00.000Z', 'a1');
  session('x-w9', '2026-10-25T10:00:00.000Z', 'w9');
  session('x-none', '2026-10-25T10:00:00.000Z', null); // no anonymous id: not counted
  for (let i = 1; i <= 5; i += 1) session(`x-c${i}`, '2026-10-10T10:00:00.000Z', i === 1 ? 'x1' : null, 'ABC234');
  for (let i = 1; i <= 4; i += 1) session(`x-z${i}`, '2026-10-10T10:00:00.000Z', null, 'ZZZ999');

  const k = await computeKpi(db, '2026-10-31');
  assert.deepEqual({ ...k, rounds_per_player_day: undefined, d1_return: undefined, d7_return: undefined, challenge_conversion: undefined, share_rate: undefined }, {
    as_of: '2026-10-31', mau: 3, dau: 1, mau_web: 2, mau_slack: 0, mau_discord: 0, mau_room: 0, mau_classroom: 1,
    workspaces: 0, guilds: 0, rooms: 0, classrooms: 1,
    rounds_per_player_day: undefined, d1_return: undefined, d7_return: undefined, challenge_conversion: undefined, share_rate: undefined,
  });
  assert.deepEqual((await computeKpi(db, '2026-10-01')).mau, 0);
  const empty = {
    as_of: null, mau: 0, dau: 0, mau_by_surface: { web: 0, slack: 0, discord: 0, room: 0, classroom: 0 },
    communities: { workspaces: 0, guilds: 0, rooms: 0, classrooms: 0 },
    rounds_per_player_day: null, d1_return: null, d7_return: null, challenge_conversion: null, share_rate: null,
  };
  assert.deepEqual(await latestKpi(db), empty);
  const now = new Date('2026-11-01T00:10:00Z');
  await runKpi(db, '2026-10-31', now);
  await runKpi(db, '2026-10-01', now);
  assert.deepEqual(await latestKpi(db), { ...empty, as_of: '2026-10-31', mau: 3, dau: 1,
    mau_by_surface: { ...empty.mau_by_surface, web: 2, classroom: 1 }, communities: { ...empty.communities, classrooms: 1 }, d1_return: 0, d7_return: 0 });
  await runKpi(db, '2026-10-31', now); // re-running a day overwrites it
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM kpi').get().n, 2);
});

test('KPI run key: matching header only; an unset KPI_KEY refuses everyone', async () => {
  const req = (key) => new Request('https://h/api/kpi/run', { method: 'POST', headers: key ? { 'x-kpi-key': key } : {} });
  assert.equal(await authorized(req('s3cret'), { KPI_KEY: 's3cret' }), true);
  assert.equal(await authorized(req('s3cre'), { KPI_KEY: 's3cret' }), false);
  assert.equal(await authorized(req(null), { KPI_KEY: 's3cret' }), false);
  assert.equal(await authorized(req('anything'), {}), false);
  assert.equal(await authorized(req(''), { KPI_KEY: '' }), false);
});
