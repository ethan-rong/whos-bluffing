import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recentGames, recentGame, rememberGame } from '../public/recent-games.js';
import { getRound, answer, complete, loadRounds } from '../functions/_rounds.js';
import { openD1 } from './d1.js';

const KEY = 'whosbluffing_recent_games';
const completedAt = '2026-10-08T12:00:00.000Z';
function fixture(id = 'AAAAAAAAAAAA') {
  const items = Array.from({ length: 10 }, (_, k) => ({ id: `p${k}`, prompt: `Which came first? ${k}`, a: 'A', b: 'B' }));
  return {
    round: { round_id: id, mode: 'quick', date: '2026-10-08', pack: 'history', difficulty: 'normal', items, total: 0,
      answers: Object.fromEntries(items.map((item) => [item.id, { choice: 0, conf: 50, correct: false, points: 0,
        truth: { a_value: 1800, b_value: 1700, unit: 'year', a_source: 'https://example.com/a', b_source: 'http://example.com/b' } }])) },
    result: { score: 0, accuracy: 0, mean_conf: 50, streak: 1, type: 'Bluffer', share_text: 'Try these ten.', challenge_url: `https://whosbluffing.com/c/${id}/abcdefghij` }, completedAt,
  };
}
function storage(t) {
  const data = new Map();
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  } });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'localStorage', old); else delete globalThis.localStorage; });
  return data;
}
const save = (entry) => rememberGame(entry.round, entry.result, entry.completedAt);

test('recent games: keep newest ten distinct rounds; reopening does not reorder or change completion time', (t) => {
  const data = storage(t);
  data.set('whosbluffing_round', '{"unfinished":true}');
  for (let k = 0; k < 12; k += 1) {
    const entry = fixture(`${'A'.repeat(11)}${String.fromCharCode(65 + k)}`);
    entry.completedAt = `2026-10-08T12:${String(k).padStart(2, '0')}:00.000Z`;
    assert.equal(save(entry), true);
  }
  const saved = recentGames();
  assert.equal(saved.length, 10);
  assert.equal(saved[0].round.round_id, 'AAAAAAAAAAAL');
  assert.equal(saved[9].round.round_id, 'AAAAAAAAAAAC');
  assert.equal(recentGame('AAAAAAAAAAAA'), null);
  assert.equal(recentGame('unknown'), null);
  assert.equal(rememberGame(saved[4].round, saved[4].result, '2026-10-09T00:00:00Z'), true);
  assert.deepEqual(recentGames(), saved);
  assert.equal(data.get('whosbluffing_round'), '{"unfinished":true}');
  assert.ok(saved.every((entry) => entry.result.challenge_url.startsWith('/c/')));
});

test('recent games: corruption, partial rounds and unsafe URLs are ignored independently', (t) => {
  const data = storage(t);
  data.set(KEY, '{broken');
  assert.deepEqual(recentGames(), []);
  data.set(KEY, '{"rounds":[]}');
  assert.deepEqual(recentGames(), []);
  const changes = [
    (e) => { e.round.items.pop(); },
    (e) => { e.round.items[1].id = e.round.items[0].id; },
    (e) => { delete e.round.answers.p0; },
    (e) => { e.round.answers.p0.truth = null; },
    (e) => { e.round.answers.p0.truth.a_source = 'javascript:alert(1)'; },
    (e) => { e.round.answers.p0.truth.b_source = 'data:text/html,<script>alert(1)</script>'; },
    (e) => { e.round.answers.p0.truth.a_value = {}; },
    (e) => { e.round.answers.p0.correct = 'false'; },
    (e) => { e.result.score = '0'; },
    (e) => { e.result.mean_conf = 101; },
    (e) => { e.result.type = 'toString'; },
    (e) => { e.result.challenge_url = 'https://evil.example/c/AAAAAAAAAAAA/abcdefghij'; },
    (e) => { e.result.challenge_url = '/c/BBBBBBBBBBBB/abcdefghij'; },
    (e) => { e.result.challenge_url = 'javascript:alert(1)'; },
    (e) => { e.result.challenge_url = 'https://whosbluffing.com.evil.example/c/AAAAAAAAAAAA/abcdefghij'; },
    (e) => { e.result.challenge_url = 'https://evil@whosbluffing.com/c/AAAAAAAAAAAA/abcdefghij'; },
    (e) => { e.result.challenge_url += '?redirect=https://evil.example'; },
    (e) => { e.round.mode = 'question'; },
    (e) => { e.round.mode = { toString: null }; },
    (e) => { e.result.type = { toString: null }; },
    (e) => { e.round.pack = { toString: null }; },
    (e) => { e.round.pack = 'unknown'; },
    (e) => { e.round.difficulty = 'unknown'; },
    (e) => { e.round.date = '2026-02-31'; },
    (e) => { e.completedAt = 'not-a-date'; },
  ];
  for (const change of changes) {
    const entry = fixture();
    change(entry);
    assert.equal(save(entry), false, change.toString());
    data.set(KEY, JSON.stringify([null, entry, fixture('BBBBBBBBBBBB')]));
    assert.deepEqual(recentGames().map((e) => e.round.round_id), ['BBBBBBBBBBBB'], change.toString());
    data.clear();
  }
});

test('recent games: safe local URLs, negative scores and ranked rounds survive reload; saved dare entries drop out', (t) => {
  const data = storage(t);
  const quick = fixture();
  quick.result.score = -100;
  quick.result.challenge_url = 'http://localhost:8788/c/AAAAAAAAAAAA/abcdefghij';
  assert.equal(save(quick), true);
  assert.equal(recentGame(quick.round.round_id).result.score, -100);
  const ranked = fixture('rk-2026-10-08');
  ranked.round.mode = 'ranked';
  delete ranked.round.pack;
  delete ranked.round.difficulty;
  assert.equal(save(ranked), true);
  const dare = fixture('dr-acme');
  dare.round.mode = 'dare';
  delete dare.round.pack;
  delete dare.round.difficulty;
  Object.assign(dare.result, { challenge_url: '/dare/acme', rank: 1, players: 5, dare: { slug: 'acme', name: 'Ada Acme', address: 'Ms. Acme' } });
  assert.equal(save(dare), false);
  data.set(KEY, JSON.stringify([dare, ...JSON.parse(data.get(KEY))])); // saved before the dare board was removed
  assert.equal(recentGame('dr-acme'), null);
  assert.equal(recentGames().length, 2);
});

test('recent games: unavailable or full storage never interrupts completion or reports a false save', (t) => {
  storage(t);
  globalThis.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  assert.equal(save(fixture()), false);
  assert.deepEqual(recentGames(), []);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  assert.equal(save(fixture()), false);
  assert.deepEqual(recentGames(), []);
});

test('recent games: actual quick completions reopen with original answers and sources intact', async (t) => {
  storage(t);
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const data = loadRounds(read('../functions/_pool.json'), read('../functions/_pairs.json'), read('../functions/_rounds.json'),
    { curated: read('../../items/quick_curated.json').items });
  const db = openD1();
  t.after(() => db.sqlite.close());
  const now = new Date(completedAt);
  for (const params of [{ mode: 'quick', pack: 'history', difficulty: 'normal' }]) {
    const fresh = await getRound(db, data, params, now);
    assert.equal(fresh.status, 200);
    const round = { ...fresh.body, answers: {}, total: 0 };
    const player = { anon_id: 'a'.repeat(22), surface: 'web', round_id: round.round_id };
    for (const item of round.items) {
      const reply = await answer(db, data, { ...player, item_id: item.id, choice: 0, conf: 80 }, now);
      assert.equal(reply.status, 200);
      const { choice, conf, correct, points, truth, total } = reply.body;
      round.answers[item.id] = { choice, conf, correct, points, truth };
      round.total = total;
    }
    const finished = await complete(db, data, player, now, 'https://whosbluffing.com');
    assert.equal(finished.status, 200);
    assert.equal(rememberGame(round, finished.body, completedAt), true);
    assert.deepEqual(recentGame(round.round_id).round, round);
    assert.equal(recentGame(round.round_id).result.score, finished.body.score);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM round_plays').first()).n, 1);
});
