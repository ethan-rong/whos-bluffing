// The Politics pack end to end on its fixture (test/fixtures/politics_curated.json, the schema of items/ai_curated.json):
// the real pipeline (analysis/items_pipeline: wikidata_pool.py's curated items, pairs.py's pairs) writes the pool and the
// pairs, then the runtime takes them as sync-items.js would: the pack and its tiers per difficulty, the reveal line, the
// formatters, the reaction lines, the home page's question list, and a party claim after a real Politics round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openD1 } from './d1.js';
import { loadRounds, answer, complete, DIFFICULTIES } from '../functions/_rounds.js';
import { claimSide } from '../functions/_labs.js';
import { serverPool, compactPairs } from '../scripts/sync-items.js';
import { promptLines } from '../scripts/sync-pages.js';
import { PACKS } from '../public/packs.js';
import { fmtValue } from '../public/ui.js';
import { reactionBucket, isAiPair } from '../public/reactions.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PIPELINE = `
import json, sys
sys.path.insert(0, "analysis/items_pipeline")
import wikidata_pool as w, pairs as P
entries = json.load(open("web/test/fixtures/politics_curated.json"))["items"]
pool, _ = w.build_pool({}, politics=entries, generated_at="2026-10-05")
doc, _ = P.build_pairs(pool["items"], generated_at="2026-10-05")
print(json.dumps({"pool": pool, "doc": doc}))
`;
const { pool, doc } = JSON.parse(execFileSync('python3', ['-c', PIPELINE], { cwd: ROOT, encoding: 'utf8' }));
const DATA = loadRounds(serverPool(pool), compactPairs(doc), {}, { minPackPairs: 1 });
const byName = new Map(pool.items.map((i) => [i.name, i]));
const NOW = new Date('2026-11-10T12:00:00Z');

test('packs: Politics comes second after AI, with its five categories and the AI pack\'s tiers', () => {
  assert.deepEqual(Object.keys(PACKS).slice(0, 3), ['all', 'ai', 'politics']);
  assert.equal(PACKS.politics.label, 'Politics');
  assert.deepEqual(PACKS.politics.categories, ['pol_elected', 'pol_timeline', 'pol_numbers', 'pol_money', 'pol_drama']);
  assert.deepEqual(PACKS.politics.tiers, PACKS.ai.tiers);
  assert.equal(pool.items.length, 30);
  assert.deepEqual(new Set(pool.items.map((i) => i.category)), new Set(PACKS.politics.categories));
});

test('tiers: Easy draws tier 1, Normal tiers 1-2, Brutal tiers 2-3, every pair from the pack; All leaves politics out', () => {
  const ids = (pack, d) => Object.entries(DATA.packLists[pack][d]).flatMap(([level, list]) => (DIFFICULTIES[d].mix[level] ? list : []));
  const tiers = (d) => new Set(ids('politics', d).map((id) => DATA.pairs.get(id).tier));
  assert.deepEqual([tiers('easy'), tiers('normal'), tiers('brutal')], [new Set([1]), new Set([1, 2]), new Set([2, 3])]);
  for (const d of Object.keys(DIFFICULTIES)) {
    assert.ok(ids('politics', d).length > 0, d);
    for (const id of ids('politics', d)) assert.ok(PACKS.politics.categories.includes(DATA.items.get(DATA.pairs.get(id).a_id).category), id);
  }
  assert.ok(ids('politics', 'brutal').every((id) => !ids('all', 'brutal').includes(id)), 'politics pairs stay out of All');
  assert.ok(ids('ai', 'brutal').length === 0, 'no AI pairs in this fixture');
});

test('a Politics round: the reveal line of a drama pair, its category, the formatters, the general reaction lines, then a party claim', async () => {
  const db = openD1();
  const pair = (a, b) => [...DATA.pairs.values()].find((p) => [p.a_id, p.b_id].sort().join() === [byName.get(a).id, byName.get(b).id].sort().join());
  const drama = pair('Richard Nixon resigns the presidency', 'The House impeaches Bill Clinton');
  const money = pair("the 2009 Recovery Act's estimated cost (Feb 2009)", "the President's annual salary (since 2001)");
  const votes = pair("Joe Biden's popular vote in 2020", "Ronald Reagan's popular vote in 1984");
  const ids = [drama.id, money.id, votes.id];
  await db.prepare('INSERT INTO rounds (round_id, mode, date, items, created_at, difficulty) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('POLRNDAAAAAA', 'quick', '2026-11-10', JSON.stringify(ids), NOW.toISOString(), 'brutal').run();
  const anon = 'politicsTester'.padEnd(22, 'x');
  const answers = [];
  for (const p of [drama, money, votes]) {
    const r = await answer(db, DATA, { round_id: 'POLRNDAAAAAA', item_id: p.id, choice: p.truth, conf: 80, rt_ms: 2000, anon_id: anon, surface: 'web' }, NOW);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    answers.push(r.body);
  }
  const fun = DATA.items.get(drama.a_id).fun || DATA.items.get(drama.b_id).fun; // the first item's line, as for the AI pack
  assert.ok(['He is the only US president to have resigned.', 'The Senate acquitted him on both articles on 12 February 1999.'].includes(fun));
  assert.deepEqual([answers[0].truth.category, answers[0].truth.unit, answers[0].truth.fun], ['pol_drama', 'month', fun]);
  assert.ok(!('fun' in answers[1].truth), 'no reveal line on money');
  assert.deepEqual([answers[0].truth.a_value, answers[0].truth.b_value].map((v) => fmtValue(v, 'month')).sort(), ['Aug 1974', 'Dec 1998']);
  assert.deepEqual([answers[1].truth.a_value, answers[1].truth.b_value].map((v) => fmtValue(v, answers[1].truth.unit)).sort(), ['$400,000', '$787 billion']);
  assert.deepEqual([answers[2].truth.a_value, answers[2].truth.b_value].map((v) => fmtValue(v, answers[2].truth.unit)).sort(), ['54,455,472 votes', '81,283,501 votes']);
  assert.equal(fmtValue(byName.get('electoral votes in the Electoral College').answer, 'electoral votes'), '538 electoral votes');
  for (const a of answers) {
    assert.equal(isAiPair(a), false);
    assert.equal(reactionBucket([{ ...a, correct: true }], 0, 10), 'right_mid'); // the general lines, never the AI pack's
    assert.equal(reactionBucket([{ ...a, correct: false, conf: 100 }], 0, 10), 'wrong_sure');
  }
  assert.equal((await complete(db, DATA, { round_id: 'POLRNDAAAAAA', anon_id: anon, surface: 'web' }, NOW, 'https://h')).status, 200);
  assert.deepEqual((await claimSide(db, DATA, 'ai', { round_id: 'POLRNDAAAAAA', anon_id: anon, lab: 'openai' }, NOW)).body, { error: 'only quick rounds in the AI pack can be claimed' });
});

test('home page: the question list leaves Politics drama out, as it does AI drama', () => {
  // The fixture's names are longer than the list's 64 characters, so its famous pairs are given short names here.
  const short = { pairs: doc.pairs.filter((p) => p.fame >= 50000).map((p, k) => ({ ...p, a: `a${k}`, b: `b${k}` })) };
  const lines = promptLines(short, 200);
  const drama = short.pairs.filter((p) => p.category === 'pol_drama');
  assert.ok(drama.length > 0 && lines.length > 0);
  for (const p of drama) assert.ok(!lines.includes(`Which came first: ${p.a} or ${p.b}?`), p.id);
  assert.ok(short.pairs.some((p) => p.category === 'pol_timeline' && lines.includes(`Which came first: ${p.a} or ${p.b}?`)));
});
