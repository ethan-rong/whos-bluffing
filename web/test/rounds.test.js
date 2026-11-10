// Rounds (docs/api-rounds.md) on a real SQLite database (test/d1.js) with a fixture pool, pairs and ranked days, plus
// the challenge page, the KPI engagement numbers and checks on the real items/pairs.json and daily/rounds.json.
// HTTP wiring is covered by test/smoke.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openD1 } from './d1.js';
import { addDays } from '../functions/_daily.js';
import {
  loadRounds, points, typeOf, scoreRound, shareText, parseRoundId, getRound, answer, complete, compare, roundStats,
  dailyQuestion, reveal, recordEvent, flagPair, settleQuestions, newToken, binHist, histIndex, ROASTS, MIX, DIFFICULTIES, CONFS,
} from '../functions/_rounds.js';
import { challengePage, challengeTitle, HEADERS } from '../functions/_challenge.js';
import { computeKpi, runKpi, latestKpi } from '../functions/_kpi.js';
import { headerMatches, isBot } from '../functions/_util.js';
import { validatePairs, validateRounds, compactPairs, serverPool } from '../scripts/sync-items.js';

// --- fixture: 3 categories x 16 items, pairs of neighbours two and four apart --------------------------------------
const CATS = [
  { category: 'river_length', unit: 'km', prompt: 'Which is longer?', more: 'was longer', less: 'was shorter', value: (k) => Math.round(100 * 1.5 ** k) },
  { category: 'mountain_elevation', unit: 'm', prompt: 'Which is higher?', more: 'was higher', less: 'was lower', value: (k) => 300 + 250 * k },
  { category: 'first_flight', unit: 'year', prompt: 'Which came first?', more: 'came first', less: 'came later', value: (k) => 1900 + 7 * k },
];
const PER = 16;
const items = [];
CATS.forEach((c, ci) => {
  for (let k = 0; k < PER; k += 1) {
    const n = ci * PER + k + 1;
    items.push({ id: `w${String(n).padStart(4, '0')}`, category: c.category, en: { prompt: `Q${n}?`, unit: c.unit }, answer: c.value(k),
      accept: [0, 1e9], source: `https://www.wikidata.org/wiki/Q${1000 + n}#P1`, name: `${c.category.split('_')[0]} ${k}` });
  }
});
items[PER].source = items[0].source; // w0017 (a mountain) is about the same entity as w0001 (a river)
const pairRows = [];
CATS.forEach((c, ci) => {
  for (let k = 0; k < PER; k += 1) {
    for (const step of [2, 4]) {
      if (k + step >= PER) continue;
      const a = ci * PER + k + 1;
      const b = a + step;
      const earlierWins = c.unit === 'year';
      const flip = (k + step) % 2 === 0; // alternate A/B
      const [x, y] = flip ? [b, a] : [a, b];
      const vx = items[x - 1].answer;
      const vy = items[y - 1].answer;
      const truth = earlierWins ? (vx < vy ? 0 : 1) : (vx > vy ? 0 : 1);
      const n = pairRows.length + 1;
      const band = n % 5 === 0 ? 0 : n % 5 === 1 ? 1 : 2; // obscure, known, famous
      pairRows.push([n, x, y, truth, step === 4 ? 0 : (k % 2 ? 1 : 2), band, n % 7 === 0 ? 0 : 1]);
    }
  }
});
const COMPACT = { templates: CATS.map(({ category, unit, prompt, more, less }) => ({ category, unit, prompt, more, less })), pairs: pairRows };
const pid = (n) => `p${String(n).padStart(5, '0')}`;
const DAY = '2026-11-10';
const PREV = addDays(DAY, -1);
const OLD = addDays(DAY, -2);
const NEXT = addDays(DAY, 1);
const RANKED = Array.from({ length: 10 }, (_, k) => pid(1 + 3 * k)); // p00001, p00004, …, p00028
const DAYS = {
  [OLD]: { ranked: Array.from({ length: 10 }, (_, k) => pid(30 + k)), question: pid(41) },
  [PREV]: { ranked: Array.from({ length: 10 }, (_, k) => pid(50 + k)), question: pid(42) },
  [DAY]: { ranked: RANKED, question: pid(2) },
  [NEXT]: { ranked: Array.from({ length: 10 }, (_, k) => pid(60 + k)), question: pid(43) },
};
const DATA = loadRounds({ items }, COMPACT, DAYS);
const NOW = new Date(`${DAY}T12:00:00Z`);
const ORIGIN = 'https://whosbluffing.example';
const anon = (k) => `anon-${k}`.padEnd(22, 'x');
const seeded = (seed) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };

// Plays a round for `who`: right[k] says whether item k is answered correctly; conf[k] (default 80).
async function playRound(db, who, roundId, ids, right, { conf = () => 80, surface = 'web', community, now = NOW, nickname, challenge, origin = ORIGIN } = {}) {
  for (const [k, id] of ids.entries()) {
    const truth = DATA.pairs.get(id).truth;
    const r = await answer(db, DATA, { round_id: roundId, item_id: id, choice: right[k] ? truth : 1 - truth, conf: conf(k), rt_ms: 3000, anon_id: anon(who), surface, community }, now);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return complete(db, DATA, { round_id: roundId, anon_id: anon(who), surface, community, nickname, challenge }, now, origin);
}
const all = (v) => Array(10).fill(v);

test('points: 100 - 400 (c - y)^2, the brief\'s vectors, always a multiple of 4', () => {
  assert.equal(points(100, 1), 100);
  assert.equal(points(50, 1), 0);
  assert.equal(points(50, 0), 0);
  assert.equal(points(100, 0), -300);
  assert.equal(points(80, 0), -156);
  assert.equal(points(80, 1), 84);
  assert.deepEqual([60, 70, 90].map((c) => points(c, 1)), [36, 64, 96]);
  for (const c of [50, 60, 70, 80, 90, 100]) for (const y of [0, 1]) assert.equal(Math.abs(points(c, y)) % 4, 0);
  assert.deepEqual([histIndex(-3000), histIndex(0), histIndex(1000)], [0, 750, 1000]);
});

test('types: overconfidence = mean confidence - accuracy; boundaries at exactly +15, +5, -5, -15', () => {
  // ten answers, 7 right (70%); mean confidence 85 / 84 / 75 / 74 / 66 / 65 / 56 / 55
  const at = (meanConf) => typeOf(meanConf * 10, 7, 10);
  assert.deepEqual([85, 84, 75, 74, 70, 66, 65, 56, 55].map(at),
    ['Bluffer', 'Hot-headed', 'Hot-headed', 'Calibrated', 'Calibrated', 'Calibrated', 'Modest', 'Modest', 'Hedger']);
  const s = scoreRound([{ conf: 90, correct: 1, points: 96 }, { conf: 70, correct: 0, points: -96 }]);
  assert.deepEqual(s, { score: 0, accuracy: 50, mean_conf: 80, overconfidence: 30, brier: 0.25, type: 'Bluffer', exact_overconf: 30 });
  assert.equal(shareText(s, 'https://h/c/X/Y'), "Who's Bluffing? · Bluffer · 0 pts · 50% right at 80% sure · https://h/c/X/Y");
});

test('round ids: rk-/dq- dates and 12-character quick ids; everything else is invalid', () => {
  assert.deepEqual(parseRoundId('rk-2026-11-10'), { kind: 'ranked', date: '2026-11-10' });
  assert.deepEqual(parseRoundId('dq-2026-11-10'), { kind: 'question', date: '2026-11-10' });
  assert.deepEqual(parseRoundId('ABCDEFGHJK23'), { kind: 'quick' });
  for (const bad of ['rk-2026-02-30', 'xx-2026-11-10', 'abcdefghijkl', 'ABCDEFGHJK2', null, 42]) assert.equal(parseRoundId(bad), null, String(bad));
});

test('old dare round ids (dr-<slug>) get the clean bad round_id answer everywhere, never an exception', async () => {
  // Arrange
  const db = openD1();
  const roundId = 'dr-altman';
  const player = { round_id: roundId, anon_id: anon('d'), surface: 'web' };
  // Act
  const replies = [
    await getRound(db, DATA, { round_id: roundId }, NOW),
    await answer(db, DATA, { ...player, item_id: RANKED[0], choice: 0, conf: 80 }, NOW),
    await complete(db, DATA, player, NOW, ORIGIN),
    await compare(db, DATA, roundId, anon('d'), 'abcdefghij', NOW),
  ];
  // Assert
  assert.equal(parseRoundId(roundId), null); // the /c/<round>/<token> page answers its branded 404 for this
  for (const r of replies) assert.deepEqual(r, { status: 400, body: { error: 'bad round_id' } });
});

test('GET ranked: today\'s ten for everyone, prompts and names only, never early', async () => {
  const db = openD1();
  const r = await getRound(db, DATA, { mode: 'ranked' }, NOW);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.round_id, r.body.mode, r.body.date], [`rk-${DAY}`, 'ranked', DAY]);
  assert.deepEqual([...r.body.items.map((i) => i.id)].sort(), [...RANKED].sort());
  assert.notDeepEqual(r.body.items.map((i) => i.id), RANKED); // shuffled by date, the same for everyone
  assert.deepEqual((await getRound(db, DATA, { mode: 'ranked' }, NOW)).body.items, r.body.items);
  for (const it of r.body.items) assert.deepEqual(Object.keys(it).sort(), ['a', 'b', 'id', 'prompt']);
  assert.ok(!/wikidata|truth|value|answer/.test(JSON.stringify(r.body)));
  assert.equal((await getRound(db, DATA, { round_id: `rk-${NEXT}` }, NOW)).status, 404); // tomorrow's is not served
  assert.equal((await getRound(db, DATA, { mode: 'ranked' }, new Date('2027-06-01T00:00:00Z'))).status, 404);
  assert.equal((await getRound(db, DATA, { mode: 'other' }, NOW)).status, 400);
  assert.equal((await getRound(db, DATA, { round_id: `dq-${DAY}` }, NOW)).status, 400);
});

test('GET quick: 3 easy + 4 medium + 3 hard, unseen first, never today\'s pairs, no entity twice; the round is stored', async () => {
  const db = openD1();
  const level = (id) => DATA.pairs.get(id).level;
  const avoid = new Set([...RANKED, DAYS[DAY].question]);
  const [s1, s2] = DATA.lists.normal.easy.filter((id) => !avoid.has(id)); // plenty of easy pairs: no fallback to seen ones
  for (let seed = 1; seed <= 25; seed += 1) {
    const r = await getRound(db, DATA, { mode: 'quick', seen: `${s1},${s2},bogus` }, NOW, seeded(seed));
    assert.equal(r.status, 200);
    const ids = r.body.items.map((i) => i.id);
    assert.equal(ids.length, 10);
    assert.deepEqual(['easy', 'medium', 'hard'].map((lv) => ids.filter((id) => level(id) === lv).length), [MIX.easy, MIX.medium, MIX.hard]);
    assert.ok(!ids.some((id) => avoid.has(id) || id === s1 || id === s2), ids.join());
    const ents = ids.flatMap((id) => [DATA.pairs.get(id).a_id, DATA.pairs.get(id).b_id]).map((i) => DATA.entity.get(i));
    assert.equal(new Set(ents).size, ents.length); // w0001 and w0017 share an entity: never together
    assert.match(r.body.round_id, /^[A-Z2-9]{12}$/);
    const row = await db.prepare('SELECT mode, date, items FROM rounds WHERE round_id = ?').bind(r.body.round_id).first();
    assert.deepEqual({ ...row, items: JSON.parse(row.items) }, { mode: 'quick', date: DAY, items: ids });
  }
  const again = await getRound(db, DATA, { round_id: (await db.prepare('SELECT round_id FROM rounds LIMIT 1').first()).round_id }, NOW);
  assert.equal(again.body.items.length, 10); // a challenge link loads the same round
});

test('difficulty: normal by default (known pairs, at most one under 50,000), easy = famous and far apart, brutal = referenced, close', async () => {
  const db = openD1();
  const of = (id) => DATA.pairs.get(id);
  const draw = async (difficulty, seed) => (await getRound(db, DATA, { mode: 'quick', difficulty }, NOW, seeded(seed))).body;
  let obscureInBrutal = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const normal = await draw(undefined, seed);
    const n = normal.items.map((i) => of(i.id));
    assert.equal(normal.difficulty, 'normal');
    assert.equal(n.length, 10);
    assert.ok(n.every((p) => p.band >= 1), 'no obscure pair in a normal round');
    assert.ok(n.filter((p) => p.band === 1).length <= 1, 'at most one pair under 50,000 views');
    const easy = (await draw('easy', seed)).items.map((i) => of(i.id));
    assert.ok(easy.length === 10 && easy.every((p) => p.band === 2 && p.level === 'easy'), `easy seed ${seed}`);
    const brutal = (await draw('brutal', seed)).items.map((i) => of(i.id));
    assert.ok(brutal.length === 10 && brutal.every((p) => p.ref === 1), `brutal seed ${seed}`);
    assert.deepEqual(['easy', 'medium', 'hard'].map((lv) => brutal.filter((p) => p.level === lv).length), [0, 4, 6]);
    obscureInBrutal += brutal.filter((p) => p.band === 0).length;
  }
  assert.ok(obscureInBrutal > 0, 'brutal rounds include obscure pairs');
  const row = await db.prepare("SELECT difficulty, COUNT(*) AS n FROM rounds GROUP BY difficulty ORDER BY difficulty").all();
  assert.deepEqual(row.results, [{ difficulty: 'brutal', n: 20 }, { difficulty: 'easy', n: 20 }, { difficulty: 'normal', n: 20 }]);
  assert.deepEqual(await getRound(db, DATA, { mode: 'quick', difficulty: 'nightmare' }, NOW), { status: 400, body: { error: 'difficulty must be easy, normal or brutal' } });
  assert.deepEqual(Object.keys(DIFFICULTIES), ['easy', 'normal', 'brutal']);
});

test('answer: server scores it; the first answer is final; 404 for a pair outside the round or an unknown round', async () => {
  const db = openD1();
  const id = RANKED[0];
  const p = DATA.pairs.get(id);
  const body = { round_id: `rk-${DAY}`, item_id: id, choice: p.truth, conf: 80, rt_ms: 2500, anon_id: anon('a'), surface: 'web' };
  const first = await answer(db, DATA, body, NOW);
  const [a, b] = [DATA.items.get(p.a_id), DATA.items.get(p.b_id)];
  assert.deepEqual(first.body, { correct: true, truth: { a_value: a.answer, b_value: b.answer, unit: a.en.unit, a_source: a.source, b_source: b.source, category: a.category },
    points: 84, total: 84, choice: p.truth, conf: 80 });
  const repeat = await answer(db, DATA, { ...body, choice: 1 - p.truth, conf: 100 }, NOW);
  assert.deepEqual(repeat, first); // idempotent per (anon_id, round_id, item_id)
  const second = await answer(db, DATA, { ...body, item_id: RANKED[1], choice: 1 - DATA.pairs.get(RANKED[1]).truth, conf: 100 }, NOW);
  assert.deepEqual([second.body.correct, second.body.points, second.body.total], [false, -300, -216]);
  assert.deepEqual(await db.prepare('SELECT n, n_correct, sum_conf FROM pair_runtime WHERE pair_id = ?').bind(id).first(), { n: 1, n_correct: 1, sum_conf: 80 });
  const status = (patch) => answer(db, DATA, { ...body, ...patch }, NOW).then((r) => [r.status, r.body.error]);
  assert.deepEqual(await status({ item_id: pid(45) }), [404, 'item is not in this round']);
  assert.deepEqual(await status({ round_id: 'ZZZZZZZZZZZZ' }), [404, 'unknown round']);
  assert.deepEqual(await status({ round_id: `rk-${NEXT}` }), [404, 'unknown round']);
  assert.deepEqual(await status({ conf: 55 }), [400, 'conf must be 50, 60, 70, 80, 90 or 100']);
  assert.deepEqual(await status({ choice: 2 }), [400, 'choice must be 0 or 1']);
  assert.deepEqual(await status({ anon_id: 'no spaces allowed' }), [400, 'bad anon_id']);
  assert.deepEqual(await status({ surface: 'classroom' }), [400, 'surface must be web, slack, discord or room']);
  assert.deepEqual(await status({ surface: 'slack', community: 'discord:abc' }), [400, 'community must start with the surface']);
  assert.deepEqual(await status({ surface: 'room', community: 'room code' }), [400, 'bad community']);
  assert.deepEqual(await status({ round_id: 'nope' }), [400, 'bad round_id']);
  assert.equal((await answer(db, DATA, null, NOW)).status, 400);
});

test('complete: every pair first; scores, type, share text, challenge link; counted once; the token is never the anon_id', async () => {
  const db = openD1();
  const ids = (await getRound(db, DATA, { mode: 'ranked' }, NOW)).body.items.map((i) => i.id);
  assert.deepEqual((await complete(db, DATA, { round_id: `rk-${DAY}`, anon_id: anon('a'), surface: 'web' }, NOW, ORIGIN)).body,
    { error: 'answer every question first' });
  const right = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  const conf = (k) => (k < 7 ? 90 : 100); // 7 right at 90, 3 wrong at 100: 7*96 - 3*300 = -228
  const r = await playRound(db, 'a', `rk-${DAY}`, ids, right, { conf });
  assert.equal(r.status, 200);
  const token = r.body.challenge_url.split('/').at(-1);
  assert.deepEqual({ ...r.body, roast: undefined, today: undefined }, {
    score: -228, accuracy: 70, mean_conf: 93, overconfidence: 23, brier: 0.307, type: 'Bluffer', streak: 1,
    challenge_url: `${ORIGIN}/c/rk-${DAY}/${token}`, share_text: `Who's Bluffing? · Bluffer · -228 pts · 70% right at 93% sure · ${ORIGIN}/c/rk-${DAY}/${token}`,
    rank_today: 1, players_today: 1, roast: undefined, today: undefined,
  });
  assert.deepEqual([r.body.today.players, r.body.today.score_hist[Math.floor((-228 + 3000) / 100)], r.body.today.mean_overconfidence], [1, 1, 23]);
  assert.match(token, /^[A-Za-z0-9_-]{10}$/);
  assert.notEqual(token, anon('a'));
  assert.ok(r.body.roast.includes('100%'), r.body.roast); // the most confident miss
  const again = await complete(db, DATA, { round_id: `rk-${DAY}`, anon_id: anon('a'), surface: 'web', nickname: '  Sam  B ' }, NOW, ORIGIN);
  assert.deepEqual(again.body, r.body); // same play, same token, not counted twice
  assert.equal((await db.prepare('SELECT nickname FROM round_plays WHERE anon_id = ?').bind(anon('a')).first()).nickname, 'Sam B');
  assert.equal((await roundStats(db, DATA, DAY, NOW)).body.players, 1);
  const b = await playRound(db, 'b', `rk-${DAY}`, ids, all(1), { conf: () => 50 }); // all right at 50%: 0 points, no roast
  assert.deepEqual([b.body.score, b.body.type, b.body.rank_today, b.body.players_today, 'roast' in b.body], [0, 'Hedger', 1, 2, false]);
  assert.equal((await complete(db, DATA, { round_id: `rk-${DAY}`, anon_id: anon('a'), surface: 'web' }, NOW, ORIGIN)).body.rank_today, 2);
  assert.equal(newToken('x'.repeat(10), (() => { const seq = ['x'.repeat(10), 'y'.repeat(10)]; return () => seq.shift(); })()), 'y'.repeat(10));
  assert.deepEqual((await complete(db, DATA, { round_id: `rk-${DAY}`, anon_id: anon('c'), surface: 'web', nickname: '<b>' }, NOW, ORIGIN)).body,
    { error: "nickname: 1-24 letters, digits, spaces or . ' _ -" });
  assert.equal((await complete(db, DATA, { round_id: `dq-${DAY}`, anon_id: anon('c'), surface: 'slack' }, NOW, ORIGIN)).status, 400);
});

test('bot completions share the public game host, including replaying an existing completion', async () => {
  const db = openD1();
  const round = (await getRound(db, DATA, { mode: 'quick' }, NOW, seeded(42))).body;
  for (const surface of ['discord', 'slack']) {
    const community = `${surface}:test`;
    const played = await playRound(db, surface, round.round_id, round.items.map((i) => i.id), all(1), { surface, community, origin: 'https://bots.whosbluffing.com' });
    assert.equal(new URL(played.body.challenge_url).origin, 'https://whosbluffing.com');
    const token = played.body.challenge_url.split('/').at(-1);
    const b = { round_id: round.round_id, anon_id: anon(surface), surface, community };
    for (const [origin, expected] of [
      ['https://bots.whosbluffing.com', 'https://whosbluffing.com'],
      ['https://preview.whosbluffing.pages.dev', 'https://preview.whosbluffing.pages.dev'],
      ['http://localhost:8788', 'http://localhost:8788'],
    ]) {
      const result = await complete(db, DATA, b, NOW, origin);
      assert.equal(result.status, 200);
      assert.equal(result.body.challenge_url, `${expected}/c/${round.round_id}/${token}`);
      assert.ok(result.body.share_text.endsWith(result.body.challenge_url));
    }
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM round_plays').first()).n, 2);
});

test('streak: consecutive days with a completed round, one missed day forgiven, two missed days start again', async () => {
  const db = openD1();
  const day = (d) => new Date(`${d}T10:00:00Z`);
  const quick = async (d) => {
    const r = await getRound(db, DATA, { mode: 'quick' }, day(d), seeded(d.length + Number(d.slice(-2))));
    return playRound(db, 's', r.body.round_id, r.body.items.map((i) => i.id), all(1), { now: day(d) });
  };
  const streaks = [];
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05', '2026-11-08']) streaks.push((await quick(d)).body.streak);
  assert.deepEqual(streaks, [1, 2, 3, 4, 1]); // 11-03 missed: kept; 11-06 and 11-07 missed: reset
  assert.equal((await quick('2026-11-08')).body.streak, 1); // a second round the same day keeps it
  assert.equal((await db.prepare("SELECT rounds FROM player_days WHERE day = '2026-11-08'").first()).rounds, 2);
});

test('challenge: compare rescored side by side; 404 for a token of another round; me is null before playing', async () => {
  const db = openD1();
  const q = (await getRound(db, DATA, { mode: 'quick' }, NOW, seeded(3))).body;
  const ids = q.items.map((i) => i.id);
  const host = await playRound(db, 'h', q.round_id, ids, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0], { nickname: 'Ana' });
  const token = host.body.challenge_url.split('/').at(-1);
  const before = await compare(db, DATA, q.round_id, anon('f'), token, NOW);
  assert.equal(before.body.me, null);
  assert.deepEqual(before.body.them, { nickname: 'Ana', score: host.body.score, accuracy: 80, mean_conf: 80, overconfidence: 0, type: 'Calibrated' });
  const friend = await playRound(db, 'f', q.round_id, ids, all(1), { challenge: token });
  const after = await compare(db, DATA, q.round_id, anon('f'), token, NOW);
  assert.deepEqual(after.body.me, { nickname: null, score: friend.body.score, accuracy: 100, mean_conf: 80, overconfidence: -20, type: 'Hedger' });
  assert.deepEqual(after.body.record, { played: 1, wins: 1, losses: 0, ties: 0 });
  const friendToken = friend.body.challenge_url.split('/').at(-1);
  assert.equal(after.body.my_token, friendToken);
  const owner = await compare(db, DATA, q.round_id, anon('h'), token, NOW);
  assert.equal(owner.body.own, true);
  assert.deepEqual(owner.body.replies, [{ public_token: friendToken, nickname: null }]);
  assert.equal(before.body.replies, undefined, 'visitors cannot list another player’s friends');
  assert.equal(after.body.replies, undefined);
  assert.ok(!JSON.stringify(owner.body).includes(anon('f')), 'no anonymous IDs exposed');
  const back = await compare(db, DATA, q.round_id, anon('h'), friendToken, NOW);
  assert.deepEqual(back.body.record, { played: 1, wins: 0, losses: 1, ties: 0 });
  const next = (await getRound(db, DATA, { mode: 'quick' }, NOW, seeded(9))).body;
  const nextIds = next.items.map((i) => i.id);
  const friendNext = await playRound(db, 'f', next.round_id, nextIds, all(1));
  const nextToken = friendNext.body.challenge_url.split('/').at(-1);
  await playRound(db, 'h', next.round_id, nextIds, all(1), { challenge: nextToken });
  await complete(db, DATA, { round_id: next.round_id, anon_id: anon('h'), surface: 'web', challenge: nextToken }, NOW, ORIGIN);
  assert.deepEqual((await compare(db, DATA, next.round_id, anon('h'), nextToken, NOW)).body.record, { played: 2, wins: 0, losses: 1, ties: 1 });
  for (const challenge of [token, 'XXXXXXXXXX', nextToken]) {
    const who = challenge === nextToken ? 'f' : 'h';
    assert.equal((await complete(db, DATA, { round_id: next.round_id, anon_id: anon(who), surface: 'web', challenge }, NOW, ORIGIN)).status, 400, 'wrong-round, unknown and self challenges rejected');
  }
  assert.equal((await db.prepare('SELECT challenge_of FROM round_plays WHERE anon_id = ? AND round_id = ?').bind(anon('f'), q.round_id).first()).challenge_of, token);
  assert.equal((await compare(db, DATA, `rk-${DAY}`, anon('f'), token, NOW)).status, 404);
  assert.equal((await compare(db, DATA, q.round_id, anon('f'), 'short', NOW)).status, 400);
});

test('daily question: today or yesterday; answers locked in without truth or points; revision; 409 later', async () => {
  const db = openD1();
  const dq = dailyQuestion(DATA, null, NOW);
  assert.deepEqual(dq.body, { round_id: `dq-${DAY}`, item_id: DAYS[DAY].question, ...(({ prompt, a, b }) => ({ prompt, a, b }))(dq.body) });
  assert.equal(dailyQuestion(DATA, PREV, NOW).body.round_id, `dq-${PREV}`);
  assert.equal(dailyQuestion(DATA, OLD, NOW).status, 404);
  assert.equal(dailyQuestion(DATA, NEXT, NOW).status, 404);
  assert.equal(dailyQuestion(DATA, '2026-13-01', NOW).status, 400);
  const p = DATA.pairs.get(DAYS[DAY].question);
  const body = { round_id: `dq-${DAY}`, item_id: p.id, choice: 1 - p.truth, conf: 90, anon_id: 'f'.repeat(64), surface: 'slack', community: 'slack:team1' };
  const locked = { status: 200, body: { locked: true, points_pending: true } };
  assert.deepEqual(await answer(db, DATA, body, NOW), locked); // no correct, truth, points or total: no early peeking
  assert.deepEqual(await answer(db, DATA, { ...body, choice: p.truth }, NOW), locked); // no revision flag: unchanged
  const stored = () => db.prepare('SELECT choice, conf, correct, points FROM round_answers WHERE anon_id = ?').bind('f'.repeat(64)).first();
  assert.deepEqual(await stored(), { choice: 1 - p.truth, conf: 90, correct: null, points: null });
  assert.deepEqual(await answer(db, DATA, { ...body, choice: p.truth, conf: 70, revision: true }, NOW), locked);
  assert.deepEqual(await stored(), { choice: p.truth, conf: 70, correct: null, points: null });
  const late = await answer(db, DATA, { ...body, round_id: `dq-${OLD}`, item_id: DAYS[OLD].question }, NOW);
  assert.deepEqual(late, { status: 409, body: { error: 'locked' } });
  assert.equal((await answer(db, DATA, { ...body, round_id: `dq-${NEXT}`, item_id: DAYS[NEXT].question }, NOW)).status, 404);
  assert.equal((await answer(db, DATA, { ...body, item_id: RANKED[0] }, NOW)).status, 404);
  const yesterday = await answer(db, DATA, { ...body, round_id: `dq-${PREV}`, item_id: DAYS[PREV].question }, NOW);
  assert.deepEqual(yesterday, locked); // yesterday's question still takes answers
  assert.equal((await db.prepare('SELECT rounds FROM player_days WHERE anon_id = ? AND day = ?').bind('f'.repeat(64), DAY).first()).rounds, 0);
});

test('reveal: today and yesterday need the bot header (403), older days are public; settles points; counts, split and biggest bluff per community', async () => {
  const db = openD1();
  const p = DATA.pairs.get(DAYS[DAY].question);
  const say = (who, right, conf, community = 'slack:team1', at = '10:00') => answer(db, DATA, { round_id: `dq-${DAY}`, item_id: p.id,
    choice: right ? p.truth : 1 - p.truth, conf, anon_id: who.padEnd(64, '0'), surface: community.split(':')[0], community }, new Date(`${DAY}T${at}:00Z`));
  await say('a', true, 80);
  await say('b', false, 90, 'slack:team1', '10:01');
  await say('c', false, 90, 'slack:team1', '10:02'); // same confidence, later: not the biggest bluff
  await say('d', false, 100, 'discord:guild9'); // another community
  const peek = { status: 403, body: { error: 'the question still takes answers: its reveal needs the bot header' } };
  assert.deepEqual(await reveal(db, DATA, { community: 'slack:team1' }, NOW, false), peek);
  assert.deepEqual(await reveal(db, DATA, { date: PREV, community: 'slack:team1' }, NOW, false), peek); // yesterday's still takes answers
  const r = await reveal(db, DATA, { community: 'slack:team1' }, NOW, true);
  const [a, b] = [DATA.items.get(p.a_id), DATA.items.get(p.b_id)];
  const wrong = 1 - p.truth;
  assert.deepEqual(r.body, { n: 3, pct_a: wrong === 0 ? 67 : 33, pct_b: wrong === 0 ? 33 : 67, correct: p.truth, a_value: a.answer, b_value: b.answer,
    unit: a.en.unit, a_source: a.source, b_source: b.source, biggest_bluff: { anon_id: 'b'.padEnd(64, '0'), conf: 90, choice: wrong } });
  const pts = await db.prepare('SELECT anon_id, correct, points FROM round_answers WHERE round_id = ? ORDER BY anon_id').bind(`dq-${DAY}`).all();
  assert.deepEqual(pts.results.map((x) => [x.anon_id[0], x.correct, x.points]), [['a', 1, 84], ['b', 0, -224], ['c', 0, -224], ['d', null, null]]);
  assert.deepEqual((await reveal(db, DATA, { date: PREV, community: 'slack:team1' }, NOW, true)).body.n, 0); // with the header
  assert.equal((await reveal(db, DATA, { date: OLD, community: 'slack:team1' }, NOW, false)).status, 200); // closed questions are public
  assert.equal((await reveal(db, DATA, { date: NEXT, community: 'slack:team1' }, NOW, true)).status, 404);
  assert.equal((await reveal(db, DATA, { community: 'team1' }, NOW, true)).status, 400);
  // The KPI run settles what nobody revealed once the question is closed (before yesterday).
  assert.equal(await settleQuestions(db, DATA, new Date(`${addDays(DAY, 2)}T00:10:00Z`)), 3); // DAY, PREV and OLD are closed by then
  assert.deepEqual(await db.prepare("SELECT correct, points FROM round_answers WHERE anon_id LIKE 'd%'").first(), { correct: 0, points: -300 });
});

test('bot header: constant-time match against BOT_KEY; no key configured refuses everyone', async () => {
  const req = (key) => new Request('https://h/api/round/reveal', { headers: key ? { 'x-bluff-bot': key } : {} });
  assert.equal(await isBot(req('k1'), { BOT_KEY: 'k1' }), true);
  assert.equal(await isBot(req('k2'), { BOT_KEY: 'k1' }), false);
  assert.equal(await isBot(req(null), { BOT_KEY: 'k1' }), false);
  assert.equal(await isBot(req('k1'), {}), false);
  assert.equal(await headerMatches(req('k1'), 'x-other', 'k1'), false);
});

test('flag: only answerers; the third flag retires the pair and both values; pairs sharing a value retire; ranked day recomputed', async () => {
  const db = openD1();
  const ids = (await getRound(db, DATA, { mode: 'ranked' }, NOW)).body.items.map((i) => i.id);
  const target = RANKED[0];
  const k = ids.indexOf(target);
  const players = { a: all(1), b: all(1), c: all(0) };
  for (const [who, right] of Object.entries(players)) await playRound(db, who, `rk-${DAY}`, ids, right);
  const before = (await roundStats(db, DATA, DAY, NOW)).body;
  assert.equal(before.players, 3);
  const f = (who, extra = {}) => flagPair(db, DATA, { item_id: target, round_id: `rk-${DAY}`, anon_id: anon(who), reason: 'source disagrees', ...extra }, NOW);
  assert.deepEqual(await f('z'), { status: 403, body: { error: 'answer this question before flagging it' } });
  assert.equal((await f('a', { round_id: undefined })).status, 400);
  assert.equal((await flagPair(db, DATA, { item_id: 'p99999', round_id: `rk-${DAY}`, anon_id: anon('a') }, NOW)).status, 404);
  await f('a'); await f('a'); await f('b');
  assert.equal((await db.prepare('SELECT retired_at FROM pair_runtime WHERE pair_id = ?').bind(target).first()).retired_at, null);
  await f('c');
  const t = DATA.pairs.get(target);
  const retired = await db.prepare('SELECT item_id FROM items_runtime WHERE retired_at IS NOT NULL ORDER BY item_id').all();
  assert.deepEqual(retired.results.map((r) => r.item_id), [t.a_id, t.b_id].sort());
  // Recomputed without the pair: a and b lose 84 (80% right), c gains 156 back (80% wrong).
  const after = (await roundStats(db, DATA, DAY, NOW)).body;
  assert.equal(after.players, 3);
  const expect = binHist(Array.from({ length: 1001 }, () => 0));
  for (const s of [9 * 84, 9 * 84, 9 * -156]) expect[Math.floor((s + 3000) / 100)] += 1;
  assert.deepEqual(after.score_hist, expect);
  assert.equal((await getRound(db, DATA, { mode: 'ranked' }, NOW)).body.items.length, 9);
  const replay = await complete(db, DATA, { round_id: `rk-${DAY}`, anon_id: anon('a'), surface: 'web' }, NOW, ORIGIN);
  assert.deepEqual([replay.body.score, replay.body.accuracy], [9 * 84, 100]); // rescored without the retired pair
  // Any other pair with one of the retired values is gone too, from quick rounds and from scoring.
  const sharing = [...DATA.pairs.values()].filter((p) => p.id !== target && [p.a_id, p.b_id].some((i) => i === t.a_id || i === t.b_id)).map((p) => p.id);
  assert.ok(sharing.length > 0);
  for (let seed = 1; seed <= 30; seed += 1) {
    const q = (await getRound(db, DATA, { mode: 'quick' }, NOW, seeded(seed))).body.items.map((i) => i.id);
    assert.ok(!q.some((id) => sharing.includes(id) || id === target), `seed ${seed}`);
  }
  assert.equal(k >= 0, true);
});

test('events: anonymous counters per day and type; bad type 400', async () => {
  const db = openD1();
  for (const type of ['share', 'share', 'play_again', 'challenge_view']) assert.deepEqual((await recordEvent(db, { type, anon_id: anon('a') }, NOW)).body, { ok: true });
  const rows = await db.prepare('SELECT day, type, n FROM events ORDER BY type').all();
  assert.deepEqual(rows.results, [{ day: DAY, type: 'challenge_view', n: 1 }, { day: DAY, type: 'play_again', n: 1 }, { day: DAY, type: 'share', n: 2 }]);
  assert.equal((await recordEvent(db, { type: 'click' }, NOW)).status, 400);
  assert.equal((await recordEvent(db, { type: 'share', anon_id: 'bad id!' }, NOW)).status, 400);
});

test('stats: ranked players, 100-point bins from -3000, mean overconfidence; yesterday\'s game counts the next morning', async () => {
  const db = openD1();
  const ids = (await getRound(db, DATA, { mode: 'ranked' }, NOW)).body.items.map((i) => i.id);
  await playRound(db, 'a', `rk-${DAY}`, ids, all(1), { conf: () => 100 }); // 1000, overconfidence 0
  await playRound(db, 'b', `rk-${DAY}`, ids, all(0), { conf: () => 60, surface: 'discord', community: 'discord:g1' }); // -440, +60
  const late = (await getRound(db, DATA, { mode: 'ranked' }, new Date(`${PREV}T23:00:00Z`))).body;
  await playRound(db, 'c', late.round_id, late.items.map((i) => i.id), all(1), { now: new Date(`${DAY}T00:30:00Z`) }); // PREV, finished after midnight
  const s = (await roundStats(db, DATA, DAY, NOW)).body;
  assert.deepEqual([s.date, s.players, s.mean_overconfidence, s.bin_from, s.bin_width, s.score_hist.length], [DAY, 2, 30, -3000, 100, 41]);
  assert.equal(s.score_hist[40], 1); // 1000
  assert.equal(s.score_hist[25], 1); // -440 is in [-500, -400)
  assert.equal((await roundStats(db, DATA, PREV, NOW)).body.players, 1);
  assert.equal((await roundStats(db, DATA, NEXT, NOW)).status, 404);
});

test('stats bluffs and calibration: the costliest misses at 90%+, one per pair, at most 3, most recent on a tie; none below 5 players; no ids; answers right per confidence; retired pairs drop out of both', async () => {
  const db = openD1();
  const round = (await getRound(db, DATA, { mode: 'ranked' }, NOW)).body;
  const ids = round.items.map((i) => i.id);
  const view = (k, conf) => {
    const it = round.items[k];
    return { prompt: it.prompt, pick: DATA.pairs.get(it.id).truth ? it.a : it.b, conf, points: points(conf, 0) };
  };
  // [who, minute, {question: confidence of a miss}]; every other answer is right at 80%. 80% and 70% misses are no bluffs.
  const plays = [['b1', 0, { 0: 100, 1: 90 }], ['b2', 1, { 2: 100 }], ['b3', 2, { 1: 100, 3: 90 }], ['b4', 3, { 4: 80, 5: 70 }], ['b5', 4, {}]];
  for (const [who, minute, miss] of plays) {
    const at = new Date(NOW.getTime() + minute * 60000);
    await playRound(db, who, `rk-${DAY}`, ids, ids.map((_, k) => !(k in miss)), { conf: (k) => miss[k] ?? 80, now: at });
    const s = (await roundStats(db, DATA, DAY, at)).body;
    if (s.players < 5) assert.deepEqual(s.bluffs, [], `${s.players} players: no bluffs yet`);
  }
  const s = (await roundStats(db, DATA, DAY, NOW)).body;
  assert.equal(s.players, 5);
  // -300 at 12:02 (question 1), 12:01 (2), 12:00 (0); then -224 (question 3) is the fourth and is left out
  assert.deepEqual(s.bluffs, [view(1, 100), view(2, 100), view(0, 100)]);
  for (const b of s.bluffs) assert.deepEqual(Object.keys(b).sort(), ['conf', 'pick', 'points', 'prompt']);
  const calibration = (live) => CONFS.map((conf) => { // the plays above, counted over the live questions
    const at = plays.flatMap(([, , miss]) => ids.map((_, k) => (live(k) && (miss[k] ?? 80) === conf ? [k in miss ? 0 : 1] : [])).flat());
    return { conf, n: at.length, right: at.reduce((a, c) => a + c, 0) };
  });
  assert.deepEqual(s.calibration, calibration(() => true));
  assert.deepEqual(s.calibration.find((c) => c.conf === 80), { conf: 80, n: 44, right: 43 });
  assert.doesNotMatch(JSON.stringify(s.bluffs), /anon-|\bp\d{5}\b|\bw\d{4}\b/, 'no player, pair or item ids');
  // Retire question 1: its misses (and those of any pair sharing one of its values) leave the list.
  for (const who of ['b1', 'b2', 'b3']) await flagPair(db, DATA, { item_id: ids[1], round_id: `rk-${DAY}`, anon_id: anon(who), reason: 'wrong' }, NOW);
  const gone = new Set([DATA.pairs.get(ids[1]).a_id, DATA.pairs.get(ids[1]).b_id]);
  const live = (k) => ![DATA.pairs.get(ids[k]).a_id, DATA.pairs.get(ids[k]).b_id].some((i) => gone.has(i));
  const after = (await roundStats(db, DATA, DAY, NOW)).body;
  assert.deepEqual(after.bluffs, [[2, 100], [0, 100], [3, 90]].filter(([k]) => live(k)).map(([k, conf]) => view(k, conf)));
  assert.deepEqual(after.calibration, calibration(live)); // rebuilt with the day's aggregates
  // Five players whose misses are all under 90%: nothing to show.
  const calm = openD1();
  for (const who of ['c1', 'c2', 'c3', 'c4', 'c5']) await playRound(calm, who, `rk-${DAY}`, ids, ids.map((_, k) => k > 1), { conf: (k) => (k ? 80 : 70) });
  assert.deepEqual((await roundStats(calm, DATA, DAY, NOW)).body.bluffs, []);
});

test('KPI: plays = completed rounds + daily-question answers + full assessments; communities per platform; engagement', async () => {
  const db = openD1();
  const ins = (sql, ...v) => db.sqlite.prepare(sql).run(...v);
  const play = (id, round, day, surface = 'web', community = null, challengeOf = null) => ins(`INSERT INTO round_plays (anon_id, round_id, surface,
    community, score, accuracy, mean_conf, overconf, brier, type, public_token, completed_at, day, mode, challenge_of)
    VALUES (?, ?, ?, ?, 0, 50, 50, 0, 0.25, 'Calibrated', ?, ?, ?, 'quick', ?)`, id, round, surface, community, `${id}-${round}`.slice(-10).padStart(10, 't'), `${day}T09:00:00Z`, day, challengeOf);
  const chat = (id, date, surface, community) => ins(`INSERT INTO round_answers (anon_id, round_id, item_id, choice, conf, answered_at, surface, community)
    VALUES (?, ?, 'p00002', 0, 80, ?, ?, ?)`, id, `dq-${date}`, `${date}T10:00:00Z`, surface, community);
  const pday = (id, day, rounds) => ins('INSERT INTO player_days (anon_id, day, rounds, streak) VALUES (?, ?, ?, 1)', id, day, rounds);
  const session = (id, created, anonId, cls = null) => ins(`INSERT INTO sessions (id, created_at, lang, class_code, answers, anon_id) VALUES (?, ?, 'en', ?, '[]', ?)`, id, created, cls, anonId);

  play('w1', 'AAAAAAAAAAA1', '2026-10-30'); play('w1', 'AAAAAAAAAAA2', '2026-10-31'); play('w1', 'AAAAAAAAAAA3', '2026-10-31');
  play('w2', 'AAAAAAAAAAA4', '2026-10-31', 'web', null, 'tokenhost1');
  play('d1', 'AAAAAAAAAAA5', '2026-10-20', 'discord', 'discord:g1');
  play('r1', 'AAAAAAAAAAA6', '2026-10-31', 'room', 'room:ABC');
  play('old', 'AAAAAAAAAAA7', '2026-09-01'); // outside the window
  chat('s1', '2026-10-31', 'slack', 'slack:t1'); chat('s2', '2026-10-15', 'slack', 'slack:t1'); chat('s3', '2026-10-31', 'slack', 'slack:t2');
  chat('d2', '2026-10-31', 'discord', 'discord:g2');
  session('x1', '2026-10-31T10:00:00Z', 'w1'); // same browser as w1's rounds: one web player
  session('x2', '2026-10-25T10:00:00Z', 'a9');
  for (let i = 1; i <= 5; i += 1) session(`c${i}`, '2026-10-10T10:00:00Z', null, 'ABC234');
  // player days: w1 first played 10-29 and came back the next day; w2 first 10-24, back on day 7; d1 never came back
  pday('w1', '2026-10-29', 1); pday('w1', '2026-10-30', 1); pday('w1', '2026-10-31', 2);
  pday('w2', '2026-10-24', 1); pday('w2', '2026-10-31', 1);
  pday('d1', '2026-10-20', 1);
  pday('s1', '2026-10-31', 0); // a chat answer: a play day without a round
  ins("INSERT INTO events (day, type, n) VALUES ('2026-10-31', 'share', 3), ('2026-10-31', 'challenge_view', 4), ('2026-08-01', 'share', 50)");

  const k = await computeKpi(db, '2026-10-31');
  assert.deepEqual(k, {
    as_of: '2026-10-31', mau: 9, dau: 6, mau_web: 3, mau_slack: 3, mau_discord: 2, mau_room: 1, mau_classroom: 0, // web: w1, w2, a9
    workspaces: 2, guilds: 2, rooms: 1, classrooms: 1,
    rounds_per_player_day: 1.17, // 7 rounds over 6 player-days with a round
    d1_return: 0.25, // first days in 10-01..10-30: w1 (back 10-30), w2 (not 10-25), d1 (not 10-21), a9 (assessment only)
    d7_return: 0.5, // first days in 09-25..10-24: w2 (back 10-31), d1 (not)
    challenge_conversion: 0.25, // 1 completed challenge round / 4 views
    share_rate: 0.5, // 3 shares / 6 completed rounds in the window
  });
  await runKpi(db, '2026-10-31', new Date('2026-11-01T00:10:00Z'));
  const pub = await latestKpi(db);
  assert.deepEqual(pub.mau_by_surface, { web: 3, slack: 3, discord: 2, room: 1, classroom: 0 });
  assert.deepEqual(pub.communities, { workspaces: 2, guilds: 2, rooms: 1, classrooms: 1 });
  assert.deepEqual([pub.rounds_per_player_day, pub.d1_return, pub.d7_return, pub.challenge_conversion, pub.share_rate], [1.17, 0.25, 0.5, 0.25, 0.5]);
  const empty = await computeKpi(openD1(), '2026-10-31');
  assert.deepEqual([empty.mau, empty.rounds_per_player_day, empty.d1_return, empty.challenge_conversion, empty.share_rate], [0, null, null, null, null]);
});

test('challenge page: per-link Open Graph tags, noindex, the app, escaped nickname; same security headers as _headers', () => {
  const template = readFileSync(new URL('../scripts/page.html', import.meta.url), 'utf8');
  const play = { round_id: 'ABCDEFGHJK23', public_token: 'Tok_en-123', nickname: 'Sam "<b>"', score: 640, type: 'Calibrated', accuracy: 80, mean_conf: 82 };
  const page = challengePage(template, play);
  const title = 'Sam &quot;&lt;b&gt;&quot; scored 640. Can you beat them?';
  assert.ok(page.includes(`<title>${title}</title>`));
  assert.ok(page.includes(`<meta property="og:title" content="${title}">`));
  assert.ok(page.includes('<meta property="og:description" content="Spot on: 80% right at 82% sure. Play the same ten questions on Who&#39;s Bluffing.">')); // esc() turns ' into &#39;
  assert.ok(page.includes('<meta property="og:image" content="https://whosbluffing.com/og.png">'));
  assert.ok(page.includes('<meta property="og:url" content="https://whosbluffing.com/c/ABCDEFGHJK23/Tok_en-123">'));
  assert.ok(page.includes('<meta name="robots" content="noindex">'));
  assert.ok(page.includes('<script src="/site.js"></script>\n<script type="module" src="/app.js"></script>'));
  assert.ok(page.includes(`<h1 id="hero-title">${title}</h1>`));
  assert.ok(!page.includes('<b>') && !page.includes('{{'));
  assert.equal(challengeTitle(null, -40), 'Someone scored -40. Can you beat them?');
  const csp = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').match(/Content-Security-Policy: (.*)/)[1];
  assert.equal(HEADERS['content-security-policy'], csp);
});

test('roasts: twenty lines that read for every comparison and none of the forbidden words', () => {
  assert.equal(ROASTS.length, 20);
  for (const line of ROASTS) {
    assert.ok(/\{conf\}/.test(line) && /\{(right|wrong|Right|Wrong)\}/.test(line), line);
    assert.ok(!/first|largest|AI\b|analytics/i.test(line.replace(/\{\w+\}/g, '')), line);
  }
});

// The real files: the referenced-items rule and the shapes sync-items enforces, plus the scheduling rules pairs.py promises.
test('real items/pairs.json and daily/rounds.json: valid; ranked days famous and referenced; rules hold; bundle loads', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const pool = read('../../items/pool.json');
  const doc = read('../../items/pairs.json');
  const rounds = read('../../daily/rounds.json');
  assert.deepEqual(validatePairs(doc, pool.items), []);
  const byId = new Map(doc.pairs.map((p) => [p.id, p]));
  assert.deepEqual(validateRounds(rounds, byId, pool.items), []);
  assert.ok(doc.pairs.length >= 20000, `${doc.pairs.length} pairs`);
  const views = new Map(pool.items.map((i) => [i.id, i.views_month]));
  assert.ok(pool.items.every((i) => Number.isInteger(i.views_month)), 'every item has views_month');
  for (const p of doc.pairs.slice(0, 2000)) assert.equal(p.fame, Math.min(views.get(p.a_id), views.get(p.b_id)), p.id);
  const degree = new Map();
  for (const p of doc.pairs) for (const i of [p.a_id, p.b_id]) degree.set(i, (degree.get(i) ?? 0) + 1);
  assert.ok(Math.max(...degree.values()) <= 25);
  const share = doc.pairs.filter((p) => p.truth === 0).length / doc.pairs.length;
  assert.ok(Math.abs(share - 0.5) < 0.02, String(share));
  const items = new Map(pool.items.map((i) => [i.id, i]));
  const entity = (id) => (items.get(id).replaces || items.get(id).source).match(/\/(Q\d+)#/)?.[1] ?? id;
  const lastPair = new Map();
  const lastItem = new Map();
  const days = Object.keys(rounds).sort();
  assert.ok(days.length >= 60, `${days.length} days`); // famous, referenced supply; the coordinator accepts 60
  for (const date of days) {
    const ps = [...rounds[date].ranked, rounds[date].question].map((id) => byId.get(id));
    for (const p of ps) assert.ok(views.get(p.a_id) >= 50000 && views.get(p.b_id) >= 50000 && p.ref_quality === 'referenced', `${date} ${p.id}`);
    const cats = ps.slice(0, 10).map((p) => p.category);
    assert.ok(cats.every((c) => cats.filter((x) => x === c).length <= 4), date); // the ladder's floor (2 while it works)
    assert.deepEqual(['easy', 'medium', 'hard'].map((lv) => ps.slice(0, 10).filter((p) => p.difficulty_hint === lv).length), [3, 4, 3], date);
    assert.equal(new Set(ps.flatMap((p) => [entity(p.a_id), entity(p.b_id)])).size, 22, date);
    const t = Date.parse(date) / 86400000;
    for (const p of ps) {
      assert.ok(!lastPair.has(p.id) || t - lastPair.get(p.id) >= 180, `${date} ${p.id}`);
      lastPair.set(p.id, t);
      for (const i of [p.a_id, p.b_id]) {
        assert.ok(!lastItem.has(i) || t - lastItem.get(i) >= 5, `${date} ${i}`); // the ladder's floor (25 while it works)
        lastItem.set(i, t);
      }
    }
  }
  const data = loadRounds(serverPool(pool), compactPairs(doc), rounds);
  const today = days[0];
  for (const id of rounds[today].ranked) {
    const v = { id, ...data.pairs.get(id) };
    assert.ok(data.items.get(v.a_id).name && data.templates.get(`${data.items.get(v.a_id).category}|${data.items.get(v.a_id).en.unit}`), id);
  }
});
