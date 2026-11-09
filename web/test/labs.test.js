// The AI pack's side board on a real SQLite database (test/d1.js) with a small fixture of AI, river and Politics pairs:
// lab claims (POST /api/round/lab, GET /api/labs; docs/api-rounds.md): validation, the aggregates, a moved claim, the
// board's order and its hidden averages, and the end screen's block, table and share line. HTTP wiring is covered by test/smoke.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { openD1 } from './d1.js';
import { addDays } from '../functions/_daily.js';
import { loadRounds, answer, complete } from '../functions/_rounds.js';
import { claimSide, sideBoard, boardBody } from '../functions/_labs.js';
import { boardOf, sideBlock, sideTable, sideShareLine, withSideLine, overWords } from '../public/round-end.js';
import { LABS, BOARDS } from '../public/packs.js';

const CATS = [
  { category: 'ai_timeline', unit: 'month', prompt: 'Which came first?', more: 'came first', less: 'came later', value: (k) => 202001 + k },
  { category: 'river_length', unit: 'km', prompt: 'Which is longer?', more: 'was longer', less: 'was shorter', value: (k) => 100 * (k + 1) },
  { category: 'pol_drama', unit: 'month', prompt: 'Which came first?', more: 'came first', less: 'came later', value: (k) => 199001 + 100 * k },
];
const PER = 6;
const items = CATS.flatMap((c, ci) => Array.from({ length: PER }, (_, k) => {
  const n = ci * PER + k + 1;
  return { id: `w${String(n).padStart(4, '0')}`, category: c.category, en: { prompt: `Q${n}?`, unit: c.unit }, answer: c.value(k),
    source: `https://www.wikidata.org/wiki/Q${1000 + n}#P1`, name: `${c.category} ${k}` };
}));
// Neighbours: p00001-p00005 AI (A came first), p00006-p00010 rivers (B is longer), p00011-p00015 Politics.
const pairs = CATS.flatMap((c, ci) => Array.from({ length: PER - 1 }, (_, k) => [ci * (PER - 1) + k + 1, ci * PER + k + 1, ci * PER + k + 2, ci, 0, 2, 1, 1]));
const DATA = loadRounds({ items }, { templates: CATS.map(({ value, ...t }) => t), pairs }, {});
const AI = ['p00001', 'p00002', 'p00003', 'p00004', 'p00005'];
const RIVER = ['p00006', 'p00007', 'p00008'];
const DAY = '2026-11-10';
const NOW = new Date(`${DAY}T12:00:00Z`);
const NOT_AI = 'only quick rounds in the AI pack can be claimed';
const BAD_LAB = 'lab must be openai, anthropic, google, xai, meta or other';
const anon = (k) => `anon-${k}`.padEnd(22, 'x');
const rid = (k) => `LABQ${String(k).padStart(8, '0').replace(/\d/g, (d) => 'ABCDEFGHJK'[d])}`; // a quick id: 12 of A-Z, 2-9
const rows = (db, sql) => db.sqlite.prepare(sql).all().map((r) => ({ ...r }));
const AGG = 'SELECT lab, date, difficulty, players, sum_score, sum_overconf FROM lab_agg';

const addRound = (db, id, ids, difficulty = 'normal') => db.prepare('INSERT INTO rounds (round_id, mode, date, items, created_at, difficulty) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(id, 'quick', DAY, JSON.stringify(ids), NOW.toISOString(), difficulty).run();
// A completed play as complete() stores it; a claim reads only its score, overconf and day.
const addPlay = (db, id, who, score, overconf, day = DAY) => db.prepare(`INSERT INTO round_plays (anon_id, round_id, surface, score, accuracy,
  mean_conf, overconf, brier, type, public_token, completed_at, day, mode) VALUES (?, ?, 'web', ?, 50, 60, ?, 0.25, 'Bluffer', ?, ?, ?, 'quick')`)
  .bind(anon(who), id, score, overconf, `${id}-${who}`, NOW.toISOString(), day).run();
const claim = (db, k, lab) => claimSide(db, DATA, 'ai', { round_id: rid(k), anon_id: anon(k), lab }, NOW);

// lab_agg must equal the sums over lab_claims (rows a moved claim left at zero aside).
function assertAggIsClaims(db) {
  assert.deepEqual(rows(db, `${AGG} WHERE players > 0 ORDER BY 1, 2, 3`), rows(db, `SELECT lab, date, difficulty, COUNT(*) AS players,
    SUM(score) AS sum_score, SUM(overconfidence) AS sum_overconf FROM lab_claims GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`));
}

test('claim: refused for a bad body, a round outside the AI pack, an unknown round, or a round this id has not finished', async () => {
  const db = openD1();
  await addRound(db, rid(1), AI);
  await addRound(db, rid(2), RIVER);
  await addRound(db, rid(3), [...AI.slice(0, 4), RIVER[0]]);
  for (const k of [1, 2, 3]) await addPlay(db, rid(k), 1, 100, 10);
  const body = (x) => ({ round_id: rid(1), anon_id: anon(1), lab: 'openai', ...x });
  const cases = [
    [null, 400, 'body must be a JSON object'],
    [['openai'], 400, 'body must be a JSON object'],
    [body({ anon_id: 'not an id' }), 400, 'bad anon_id'],
    [body({ round_id: 'nope' }), 400, 'bad round_id'],
    [body({ round_id: 'rk-2026-11-10' }), 400, NOT_AI],
    [body({ round_id: 'dq-2026-11-10' }), 400, NOT_AI],
    [body({ lab: 'deepmind' }), 400, BAD_LAB],
    [body({ lab: ['openai'] }), 400, BAD_LAB],
    [body({ lab: 'toString' }), 400, BAD_LAB],
    [body({ lab: undefined }), 400, BAD_LAB],
    [body({ round_id: rid(9) }), 404, 'unknown round'],
    [body({ round_id: rid(2) }), 400, NOT_AI], // a river round
    [body({ round_id: rid(3) }), 400, NOT_AI], // four AI pairs and one river pair
    [body({ anon_id: anon(2) }), 404, 'finish this round first'], // finished by someone else
  ];
  for (const [b, status, error] of cases) assert.deepEqual(await claimSide(db, DATA, 'ai', b, NOW), { status, body: { error } }, JSON.stringify(b));
  assert.deepEqual([rows(db, 'SELECT * FROM lab_claims'), rows(db, AGG)], [[], []]);
});

test('claim: after a real AI round it keeps the stored play\'s score and overconfidence, its day and the difficulty', async () => {
  const db = openD1();
  await addRound(db, rid(1), AI, 'brutal');
  for (const [k, id] of AI.entries()) {
    const truth = DATA.pairs.get(id).truth;
    const r = await answer(db, DATA, { round_id: rid(1), item_id: id, choice: k < 3 ? truth : 1 - truth, conf: 90, rt_ms: 2000, anon_id: anon(1), surface: 'web' }, NOW);
    assert.equal(r.status, 200);
  }
  assert.equal((await claim(db, 1, 'anthropic')).status, 404); // not finished yet
  const done = await complete(db, DATA, { round_id: rid(1), anon_id: anon(1), surface: 'web' }, NOW, 'https://h');
  assert.deepEqual([done.body.score, done.body.overconfidence], [-160, 30]); // 3 x 96 + 2 x -224; 60% right at 90% sure
  const r = await claim(db, 1, 'anthropic');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'lab', 'board']);
  assert.deepEqual([r.body.ok, r.body.lab], [true, 'anthropic']);
  assert.deepEqual(Object.keys(r.body.board), ['as_of', 'range', 'min_players', 'labs']);
  assert.deepEqual([r.body.board.as_of, r.body.board.range, r.body.board.min_players], [NOW.toISOString(), 'all', 10]);
  assert.deepEqual(r.body.board.labs[0], { lab: 'anthropic', name: 'Anthropic', players: 1, mean_score: null, mean_overconfidence: null });
  assert.deepEqual(r.body.board.labs.map((l) => l.lab), ['anthropic', 'openai', 'google', 'xai', 'meta', 'other']);
  assert.deepEqual(rows(db, 'SELECT * FROM lab_claims'),
    [{ round_id: rid(1), lab: 'anthropic', date: DAY, difficulty: 'brutal', score: -160, overconfidence: 30, created_at: NOW.toISOString(), board: 'labs' }]);
  assert.deepEqual(rows(db, AGG), [{ lab: 'anthropic', date: DAY, difficulty: 'brutal', players: 1, sum_score: -160, sum_overconf: 30 }]);
});

test('claim: a moved claim leaves the old lab\'s row and joins the new one; the same lab again changes nothing', async () => {
  const db = openD1();
  const YESTERDAY = addDays(DAY, -1);
  for (const [k, score, oc, day] of [[1, 120, 12.5, DAY], [2, -40, -7.5, DAY], [3, 300, 2.25, YESTERDAY]]) {
    await addRound(db, rid(k), AI);
    await addPlay(db, rid(k), k, score, oc, day);
    assert.equal((await claim(db, k, 'openai')).status, 200);
  }
  const agg = (lab, date, players, sumScore, sumOver) => ({ lab, date, difficulty: 'normal', players, sum_score: sumScore, sum_overconf: sumOver });
  assert.deepEqual(rows(db, `${AGG} ORDER BY 1, 2`), [agg('openai', YESTERDAY, 1, 300, 2.25), agg('openai', DAY, 2, 80, 5)]);
  const moved = await claim(db, 1, 'meta');
  const after = [agg('meta', DAY, 1, 120, 12.5), agg('openai', YESTERDAY, 1, 300, 2.25), agg('openai', DAY, 1, -40, -7.5)];
  assert.deepEqual(rows(db, `${AGG} ORDER BY 1, 2`), after);
  assert.deepEqual(moved.body.board.labs.slice(0, 2).map((l) => [l.lab, l.players]), [['openai', 2], ['meta', 1]]);
  assert.equal((await claim(db, 1, 'meta')).status, 200);
  assert.deepEqual(rows(db, `${AGG} ORDER BY 1, 2`), after, 'a repeat with the same lab');
  assert.deepEqual(rows(db, 'SELECT round_id, lab FROM lab_claims ORDER BY 1'), [[1, 'meta'], [2, 'openai'], [3, 'openai']].map(([k, lab]) => ({ round_id: rid(k), lab })));
  await claim(db, 2, 'meta');
  await claim(db, 1, 'openai');
  assertAggIsClaims(db);
});

test('board: every lab; averages from 10 players; those by average score, then the rest by players (ties in list order)', () => {
  const body = boardBody('ai', [
    { lab: 'openai', players: 12, sum_score: 1200, sum_overconf: 150 },
    { lab: 'anthropic', players: 10, sum_score: 1503, sum_overconf: -42 },
    { lab: 'google', players: 9, sum_score: 9000, sum_overconf: 9 },
    { lab: 'xai', players: 3, sum_score: 30, sum_overconf: 3 },
    { lab: 'other', players: 9, sum_score: 90, sum_overconf: 9 },
    { lab: 'retired-lab', players: 50, sum_score: 50, sum_overconf: 5 },
  ], '30d', NOW);
  assert.deepEqual(body, { as_of: NOW.toISOString(), range: '30d', min_players: 10, labs: [
    { lab: 'anthropic', name: 'Anthropic', players: 10, mean_score: 150.3, mean_overconfidence: -4.2 },
    { lab: 'openai', name: 'OpenAI', players: 12, mean_score: 100, mean_overconfidence: 12.5 },
    { lab: 'google', name: 'Google', players: 9, mean_score: null, mean_overconfidence: null },
    { lab: 'other', name: 'Other', players: 9, mean_score: null, mean_overconfidence: null },
    { lab: 'xai', name: 'xAI', players: 3, mean_score: null, mean_overconfidence: null },
    { lab: 'meta', name: 'Meta', players: 0, mean_score: null, mean_overconfidence: null },
  ] });
});

test('board: 30d counts the 30 UTC days ending today, all counts every day; another range is 400', async () => {
  const db = openD1();
  const days = [...Array(8).fill(DAY), addDays(DAY, -29), addDays(DAY, -30)];
  for (const [k, day] of days.entries()) {
    await addRound(db, rid(k), AI);
    await addPlay(db, rid(k), k, 40 * k, k - 4.5, day);
    await claim(db, k, 'xai');
  }
  const all = await sideBoard(db, 'ai', 'all', NOW);
  assert.deepEqual(all.body.labs[0], { lab: 'xai', name: 'xAI', players: 10, mean_score: 180, mean_overconfidence: 0 });
  const recent = await sideBoard(db, 'ai', '30d', NOW);
  assert.deepEqual([recent.body.range, recent.body.labs[0]], ['30d', { lab: 'xai', name: 'xAI', players: 9, mean_score: null, mean_overconfidence: null }]);
  for (const bad of ['week', '', undefined, 'toString']) assert.deepEqual(await sideBoard(db, 'ai', bad, NOW), { status: 400, body: { error: 'range must be all or 30d' } });
});

const en = JSON.parse(readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'));
const t = (key, vars = {}) => key.split('.').reduce((o, k) => o?.[k], en).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

test('end screen: the lab block, the mini and full board, the share line before the link', () => {
  const fresh = String(sideBlock('ai', t, null));
  assert.equal(fresh.match(/<button type="button" class="chip" data-lab="[a-z]+" aria-pressed="false">/g).length, 6);
  assert.match(fresh, /<h3 id="lab-q">Which lab are you with\?<\/h3>/);
  assert.match(fresh, /<p class="lab-with" hidden>/);
  assert.match(fresh, /<a href="\/labs">Full board<\/a>/);
  const later = String(sideBlock('ai', t, 'xai'));
  assert.match(later, /<h3 id="lab-q" hidden>/);
  assert.match(later, /<p class="lab-with"><span data-lab-with>You’re with xAI<\/span> · <button type="button" class="link" data-lab-change>change<\/button><\/p>/);
  assert.match(later, /<div class="chips lab-chips" role="group" aria-labelledby="lab-q" hidden><button type="button" class="chip" data-lab="openai" aria-pressed="false">OpenAI<\/button>/);
  assert.match(later, /data-lab="xai" aria-pressed="true">xAI</);

  const board = boardBody('ai', [{ lab: 'anthropic', players: 10, sum_score: 1503, sum_overconf: -42 }, { lab: 'xai', players: 10, sum_score: -124, sum_overconf: 7.6 },
    { lab: 'openai', players: 9, sum_score: 900, sum_overconf: 90 }, { lab: 'meta', players: 1234, sum_score: 0, sum_overconf: 0 }], 'all', NOW);
  const mini = String(sideTable('ai', board, 'openai', t));
  assert.equal(mini.match(/<th scope="col">/g).length, 3);
  assert.match(mini, /<tr class=""><th scope="row">Anthropic<\/th><td>10<\/td><td>150<\/td><\/tr>/);
  assert.match(mini, /<th scope="row">xAI<\/th><td>10<\/td><td>−12<\/td><\/tr>/);
  assert.match(mini, /<th scope="row">Meta<\/th><td>1,234<\/td><td>0<\/td><\/tr>/);
  assert.match(mini, /<tr class="is-mine"><th scope="row">OpenAI <span class="lab-you">your lab<\/span><\/th><td>9<\/td><td class="lab-need" colspan="1">1 more player needed<\/td><\/tr>/);
  assert.match(mini, /<th scope="row">Google<\/th><td>0<\/td><td class="lab-need" colspan="1">10 more players needed<\/td>/);
  const full = String(sideTable('ai', board, null, t, { full: true }));
  assert.equal(full.match(/<th scope="col">/g).length, 4);
  assert.doesNotMatch(full, /is-mine/);
  assert.match(full, /<td>150<\/td><td>4 points less sure than right<\/td>/);
  assert.match(full, /<td>−12<\/td><td>1 point more sure than right<\/td>/);
  assert.match(full, /<td>0<\/td><td>as sure as right<\/td>/);
  assert.match(full, /<th scope="row">OpenAI<\/th><td>9<\/td><td class="lab-need" colspan="2">1 more player needed<\/td>/);
  assert.deepEqual([12.4, 1.6, 0.6, 0.4, -0.4, -1.2, -7.6].map((x) => overWords(x, t)), ['12 points more sure than right', '2 points more sure than right',
    '1 point more sure than right', 'as sure as right', 'as sure as right', '1 point less sure than right', '8 points less sure than right']);

  assert.equal(sideShareLine('ai', board, 'anthropic', t), "I'm with Anthropic. Anthropic averages 150 on the AI round.");
  assert.equal(sideShareLine('ai', board, 'xai', t), "I'm with xAI. xAI averages −12 on the AI round.");
  assert.equal(sideShareLine('ai', board, 'openai', t), null); // 9 players: no average yet
  assert.equal(sideShareLine('ai', null, 'openai', t), null); // no board yet
  const url = 'https://h/c/R/T';
  assert.equal(withSideLine(`Who's Bluffing? · AI pack · 40 pts\n“Line”\n${url}`, 'L', url), `Who's Bluffing? · AI pack · 40 pts\n“Line”\nL\n${url}`);
  assert.equal(withSideLine(`Who's Bluffing? · 40 pts · ${url}`, 'L', url), `Who's Bluffing? · 40 pts\nL\n${url}`);
  assert.equal(withSideLine('text', 'L', url), 'text\nL');
  assert.equal(withSideLine('text', null, url), 'text');
});

test('boards: one board, the AI pack\'s; the Politics party board and the /parties page are gone', () => {
  assert.deepEqual(Object.keys(BOARDS), ['ai']);
  assert.deepEqual([BOARDS.ai.key, BOARDS.ai.list, BOARDS.ai.sides], ['lab', 'labs', LABS]);
  for (const f of ['public/parties.html', 'functions/api/parties.js', 'functions/api/round/party.js']) assert.ok(!existsSync(new URL(`../${f}`, import.meta.url)), f);
  const pages = readdirSync(new URL('../public/', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.html'));
  for (const f of pages) assert.doesNotMatch(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), /href="\/parties"/, f);
});

test('end screen: a side block after an AI quick round only, never after a Politics one', () => {
  const st = (mode, pack) => ({ mode, pack });
  assert.deepEqual([st('quick', 'politics'), st('quick', 'ai'), st('quick', 'all'), st('quick', 'geography'), st('dare', 'ai'), st('dare', 'politics'), st('ranked', undefined)].map(boardOf),
    [null, 'ai', null, null, null, null, null]);
});
