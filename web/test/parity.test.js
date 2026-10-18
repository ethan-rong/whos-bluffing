// The parity-plus pass: quick-round packs on the real data, the generated parts of the pages (question count, pack
// chips, command cards), CORS on the public reads, the bots' host gate, the picker's rules, the share text, the licence
// wording and the status page's verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openD1 } from './d1.js';
import { loadRounds, getRound, packAvailability, servablePairs, PACKS, DIFFICULTIES, MIN_PACK_PAIRS } from '../functions/_rounds.js';
import { questionCount, packChips, promptLines, promptList, commandCards, inject, pngSize } from '../scripts/sync-pages.js';
import { onRequest as gate } from '../functions/_middleware.js';
import { nearestDifficulty, settle, choose, shareWith, quickLabel, initPicker, rememberChoice } from '../public/picker.js';
import { store } from '../public/ui.js';
import { apiVerdict } from '../public/status.js';
import { COMMANDS } from '../../discord/src/commands.js';
import { questionPost, confidencePicker, revealMessage } from '../../discord/src/game.js';
import { USAGE, questionMessage } from '../../slack/src/game.js';

const WEB = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, WEB), 'utf8');
const json = (path) => JSON.parse(read(path));
const DATA = loadRounds(json('functions/_pool.json'), json('functions/_pairs.json'), json('functions/_rounds.json'),
  { curated: json('../items/quick_curated.json').items });
const NOW = new Date(`${Object.keys(DATA.rounds).sort()[3]}T12:00:00Z`); // a day with a ranked round
const seeded = (seed) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };

test('linked and played challenge choices survive Play again without another chip click', (t) => {
  const saved = new Map();
  t.mock.method(store, 'get', (key, fallback) => saved.get(key) ?? fallback);
  t.mock.method(store, 'set', (key, value) => saved.set(key, value));
  const previous = globalThis.location;
  const doc = { querySelectorAll: () => [], querySelector: () => null };
  try {
    globalThis.location = { search: '?pack=memes&difficulty=brutal' };
    assert.deepEqual(initPicker(doc).current(), { pack: 'memes', difficulty: 'brutal' });
    globalThis.location.search = '';
    assert.deepEqual(initPicker(doc).current(), { pack: 'memes', difficulty: 'brutal' });
    // A challenge starts directly, without a picker or pack query parameter.
    rememberChoice({ pack: 'history', difficulty: 'easy' });
    assert.deepEqual(initPicker(doc).current(), { pack: 'history', difficulty: 'easy' });
    rememberChoice({ pack: 'not-a-pack', difficulty: 'normal' });
    rememberChoice({ pack: 'memes', difficulty: 'not-a-difficulty' });
    assert.deepEqual(initPicker(doc).current(), { pack: 'history', difficulty: 'easy' });
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('packs: every offered pack and difficulty fills full rounds from its own categories under the difficulty rules', async () => {
  const db = openD1();
  const offer = packAvailability(DATA);
  assert.deepEqual(Object.keys(offer), Object.keys(DIFFICULTIES));
  for (const [difficulty, packs] of Object.entries(offer)) {
    assert.equal(packs[0], 'all');
    for (const pack of packs) {
      const cats = PACKS[pack].categories;
      for (let seed = 1; seed <= 4; seed += 1) {
        const r = await getRound(db, DATA, { mode: 'quick', difficulty, pack }, NOW, seeded(seed));
        assert.equal(r.status, 200, `${pack}/${difficulty}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.pack, pack);
        assert.equal(r.body.difficulty, difficulty);
        const pairs = r.body.items.map((i) => DATA.pairs.get(i.id));
        assert.equal(pairs.length, 10, `${pack}/${difficulty} seed ${seed}`);
        if (cats) assert.ok(pairs.every((p) => (p.authored ? p.authored.topic === pack : cats.includes(DATA.items.get(p.a_id).category))), `${pack}: a pair from outside the pack`);
        assert.ok(pairs.every((p) => p.authored || DIFFICULTIES[difficulty].ok(p)), `${pack}/${difficulty}: a pair the difficulty does not allow`);
        if (difficulty === 'normal') assert.ok(pairs.filter((p) => p.band < 2).length <= 1, `${pack}: more than one lesser-known pair`);
      }
    }
  }
});

test('packs: unknown pack 400; a pack the difficulty cannot fill 400 (never a short round); ranked rounds ignore it', async () => {
  const db = openD1();
  const offer = packAvailability(DATA);
  assert.deepEqual(await getRound(db, DATA, { mode: 'quick', pack: 'cheese' }, NOW), { status: 400, body: { error: 'unknown pack' } });
  const missing = Object.keys(PACKS).filter((k) => !offer.normal.includes(k));
  assert.ok(missing.length > 0);
  for (const pack of missing) {
    assert.deepEqual(await getRound(db, DATA, { mode: 'quick', difficulty: 'normal', pack }, NOW),
      { status: 400, body: { error: 'not enough questions in this pack at this difficulty' } });
  }
  const ranked = await getRound(db, DATA, { mode: 'ranked', pack: 'cheese' }, NOW);
  assert.equal(ranked.status, 200);
  assert.equal(ranked.body.items.length, 10);
  assert.equal((await getRound(db, DATA, { mode: 'quick' }, NOW, seeded(3))).body.pack, 'all');
});

test('packs: the bar is 200 eligible pairs, and small fixtures can lower it', () => {
  assert.equal(MIN_PACK_PAIRS, 200);
  const lowBar = loadRounds(json('functions/_pool.json'), json('functions/_pairs.json'), json('functions/_rounds.json'), { minPackPairs: 1 });
  assert.ok(packAvailability(lowBar).brutal.length >= packAvailability(DATA).brutal.length);
});

test('chat topic availability matches the real web question pool', () => {
  assert.deepEqual(json('public/pack-availability.json'), packAvailability(DATA));
});

test('home page: the question count, the pack chips and the question list are what the data says (scripts/sync-pages.js)', () => {
  const home = read('public/index.html');
  const count = servablePairs(DATA).size;
  assert.ok(count > 10000 && count < json('functions/_pairs.json').pairs.length, `${count} servable pairs`);
  assert.ok(home.includes(`<h2 id="questions-title"><!-- questions -->${questionCount(count)}<!-- /questions --> questions, each with a source</h2>`));
  assert.equal(questionCount(17142), '17,000+');
  assert.ok(home.includes(`<!-- packs -->${packChips(packAvailability(DATA))}<!-- /packs -->`));
  const chips = [...home.matchAll(/data-pack="([a-z]+)" data-difficulties="([a-z ]+)"/g)].map((m) => [m[1], m[2]]);
  assert.equal(chips[0][0], 'all');
  for (const [pack, levels] of chips) for (const d of levels.split(' ')) assert.ok(packAvailability(DATA)[d].includes(pack), `${pack} at ${d}`);
  assert.throws(() => inject('<p></p>', 'packs', 'x'), /marker <!-- packs --> not found/);
  // The list: 24 real prompts of famous pairs, no AI drama, each name once, written twice (the copy hidden) for the loop.
  const pairs = JSON.parse(readFileSync(new URL('../items/pairs.json', WEB), 'utf8'));
  const lines = promptLines(pairs);
  assert.ok(home.includes(`<!-- prompts -->${promptList(lines)}<!-- /prompts -->`));
  assert.equal(lines.length, 24);
  const byLine = new Map(pairs.pairs.map((p) => [`${p.prompt.replace(/\?$/, '')}: ${p.a} or ${p.b}?`, p]));
  for (const line of lines) {
    const p = byLine.get(line);
    assert.ok(p && p.fame >= 50000 && p.category !== 'ai_drama' && line.length <= 64, line);
  }
  const names = lines.flatMap((l) => l.replace(/^[^:]+: |\?$/g, '').split(' or '));
  assert.equal(new Set(names).size, names.length, 'a name twice');
  assert.equal([...home.matchAll(/<ul class="prompts-list" aria-hidden="true">/g)].length, 1);
  // The hero: Play now (the game's #play), Add to Discord, and Add to Slack as a text link; the band repeats all three.
  const hero = home.match(/<section class="hero home-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<button class="primary" id="play" type="button" data-play><svg[^>]*>.*?<\/svg><span>Play now<\/span><\/button>/);
  assert.match(hero, /<a class="button" href="\/discord"><svg[^>]*>.*?<\/svg><span>Add to Discord<\/span><\/a>/);
  assert.match(hero, /<a class="text-link" href="\/slack"><span>Add to Slack<\/span>/);
  const band = home.match(/<section class="band band-start"[\s\S]*?<\/section>/)[0];
  assert.match(band, /data-play><svg[^>]*>.*?<\/svg><span>Play now<\/span>/);
  assert.match(band, /href="\/discord"><svg[^>]*>.*?<\/svg><span>Add to Discord<\/span>/);
  assert.match(band, /href="\/slack"><svg[^>]*>.*?<\/svg><span>Add to Slack<\/span>/);
  assert.equal([...home.matchAll(/ data-play>/g)].length, 3);
});

test('commands.json: the Discord and Slack cards match the bots\' own command definitions', () => {
  const commands = json('public/commands.json');
  const subs = COMMANDS[0].options;
  assert.deepEqual(commands.discord.commands.map((c) => c.name), subs.map((s) => `/bluff ${s.name}`));
  for (const s of subs) {
    const card = commands.discord.commands.find((c) => c.name === `/bluff ${s.name}`);
    assert.deepEqual(card.options.map((o) => o.name), (s.options ?? []).map((o) => o.name), s.name);
  }
  const usage = [...USAGE.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(commands.slack.commands.map((c) => c.name), usage);
  for (const p of ['discord', 'slack', 'web']) {
    assert.ok(commands[p].commands.every((c) => c.does && c.who && Array.isArray(c.options)), p);
    assert.ok(commands[p].trouble.length >= 4, `${p}: "not working?" answers`);
  }
  assert.ok(commands.discord.commands.filter((c) => c.who === 'Manage Server').map((c) => c.name).join() === '/bluff setup,/bluff reveal');
});

test('command cards are written into /commands, /discord and /slack', () => {
  const commands = json('public/commands.json');
  const pages = { 'public/commands.html': ['discord', 'slack', 'web'], 'public/discord.html': ['discord'], 'public/slack.html': ['slack'] };
  for (const [file, platforms] of Object.entries(pages)) {
    const page = read(file);
    for (const p of platforms) assert.ok(page.includes(`<!-- commands:${p} -->${commandCards(commands[p])}<!-- /commands -->`), `${file}: ${p}`);
  }
  const page = read('public/commands.html');
  assert.equal([...page.matchAll(/role="tab"/g)].length, 3);
  assert.match(page, /data-filter="cmd-discord cmd-slack cmd-web"/);
});

test('host gate: bots.* serves /api/* only, and only with the bot key; other hosts pass untouched', async () => {
  const next = () => new Response('next');
  const call = async (url, key, env = { BOT_KEY: 'k3y' }) => {
    const res = await gate({ request: new Request(url, { headers: key ? { 'x-bluff-bot': key } : {} }), env, next });
    return [res.status, res.status === 200 ? await res.text() : (await res.json()).error];
  };
  assert.deepEqual(await call('https://whosbluffing.com/api/kpi'), [200, 'next']);
  assert.deepEqual(await call('https://whosbluffing.com/'), [200, 'next']);
  assert.deepEqual(await call('https://www.whosbluffing.com/api/players', 'wrong'), [200, 'next']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/api/kpi', 'k3y'), [200, 'next']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/api/round/reveal?date=2026-10-20', 'k3y'), [200, 'next']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/api/kpi'), [403, 'bot host requires key']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/api/kpi', 'wrong'), [403, 'bot host requires key']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/api/kpi', 'k3y', {}), [403, 'bot host requires key']); // no key set: nobody
  assert.deepEqual(await call('https://bots.whosbluffing.com/', 'k3y'), [404, 'not found']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/slack', 'k3y'), [404, 'not found']);
  assert.deepEqual(await call('https://bots.whosbluffing.com/apix', 'k3y'), [404, 'not found']);
});

test('picker: a pack moves the difficulty to the nearest one it plays at; a difficulty moves the pack to All', () => {
  const offer = { all: ['easy', 'normal', 'brutal'], elements: ['brutal'], products: ['normal'], companies: ['easy', 'normal'] };
  assert.equal(nearestDifficulty('normal', ['brutal']), 'brutal');
  assert.equal(nearestDifficulty('normal', ['easy', 'brutal']), 'easy'); // a tie goes to the easier one
  assert.equal(nearestDifficulty('easy', ['normal', 'brutal']), 'normal');
  assert.deepEqual(settle({ pack: 'elements', difficulty: 'easy' }, offer), { pack: 'elements', difficulty: 'brutal' });
  assert.deepEqual(settle({ pack: 'nope', difficulty: 'hard' }, offer), { pack: 'all', difficulty: 'normal' });
  assert.deepEqual(settle(null, offer), { pack: 'all', difficulty: 'normal' });
  assert.deepEqual(choose({ pack: 'all', difficulty: 'normal' }, { pack: 'elements' }, offer),
    { pack: 'elements', difficulty: 'brutal', note: 'Elements needs Brutal, so the difficulty is Brutal now.' });
  assert.deepEqual(choose({ pack: 'companies', difficulty: 'easy' }, { difficulty: 'normal' }, offer), { pack: 'companies', difficulty: 'normal', note: '' });
  assert.deepEqual(choose({ pack: 'products', difficulty: 'normal' }, { difficulty: 'brutal' }, offer),
    { pack: 'all', difficulty: 'brutal', note: 'Products has too few Brutal questions, so the pack is All now.' });
  assert.equal(quickLabel('geography', 'brutal'), 'Geography · Brutal');
  assert.equal(quickLabel(undefined, undefined), 'All · Normal');
});

test('share text: the pack after the name unless it is All; the best line under the score, before the link', () => {
  const url = 'https://whosbluffing.com/c/ABCDEFGHJKLM/abcdefghij';
  const text = `Who's Bluffing? · Bluffer · 420 pts · 70% right at 80% sure · ${url}`;
  assert.equal(shareWith(text, { pack: 'all', url }), text);
  assert.equal(shareWith(text, { pack: 'history', url }), `Who's Bluffing? · History pack · Bluffer · 420 pts · 70% right at 80% sure · ${url}`);
  assert.equal(shareWith(text, { pack: 'history', line: 'Called it.', url }),
    `Who's Bluffing? · History pack · Bluffer · 420 pts · 70% right at 80% sure\n“Called it.”\n${url}`);
  assert.equal(shareWith('odd text', { line: 'Hi', url }), 'odd text\n“Hi”');
  assert.equal(shareWith(text, { pack: 'not-a-pack', url }), text);
});

test('licence wording: the new footer line everywhere; no "open source" in web copy except the terms\' negation', () => {
  const line = '<p class="foot-note">An independent, non-commercial project. Source published for transparency; all rights reserved (see <a href="https://github.com/ethan-rong/whos-bluffing/blob/main/LICENSE">LICENSE on GitHub</a>).</p>';
  const pages = readdirSync(new URL('public/', WEB), { recursive: true }).filter((f) => f.endsWith('.html'));
  for (const f of pages) {
    const h = read(`public/${f}`);
    assert.ok(h.includes(line), `${f}: footer line`);
    const copy = f === 'terms.html' ? h.replace('It is not open source', '') : h;
    assert.doesNotMatch(copy, /open[- ]source/i, `${f}: "open source"`);
  }
  assert.match(read('public/terms.html'), /<h2 id="source-and-licence">Source and licence<\/h2>\n<p>The source code is published on/);
  const pkg = json('package.json');
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.equal(pkg.private, true);
  for (const f of ['public/site.js', 'public/home.js', 'public/rounds.js', 'README.md', 'NOTES.md']) assert.doesNotMatch(read(f), /open[- ]source/i, f);
});

test('status page: verdicts for the server check and the KPI run; press files exist and images are sized from their PNGs', () => {
  assert.deepEqual(apiVerdict({ ok: true, status: 200 }, 123.4), { state: 'up', text: '' });
  assert.equal(apiVerdict({ ok: true, status: 200 }, 2400).state, 'slow');
  assert.deepEqual(apiVerdict({ ok: false, status: 503 }, 10), { state: 'down', text: 'Player count unavailable. Please try again later.' });
  assert.equal(apiVerdict({ ok: false, status: 0 }, 10).state, 'down');
  assert.deepEqual(pngSize(readFileSync(new URL('public/og.png', WEB))), [1200, 630]);
  const press = read('public/press.html');
  const files = readdirSync(new URL('public/press/', WEB));
  for (const [, file] of press.matchAll(/(?:src|href)="\/press\/([^"]+)"/g)) assert.ok(files.includes(file), `press.html lists a missing file: ${file}`);
  for (const [, file, w, h] of press.matchAll(/src="\/press\/([a-z0-9-]+\.png)" width="(\d+)" height="(\d+)"/g)) {
    assert.deepEqual(pngSize(readFileSync(new URL(`public/press/${file}`, WEB))), [Number(w), Number(h)], file);
  }
});

// --- the AI pack (items/ai_curated.json): months, reveal facts, reaction lines, the home example card --------------

test('AI pack: month values (YYYYMM) read as a short month and a four-digit year in every formatter', async () => {
  const { fmtValue: endValue } = await import('../public/round-end.js');
  const { fmtValue: dailyValue, fmtNumber } = await import('../public/daily.js');
  const { fmtMonth } = await import('../public/ui.js');
  for (const f of [endValue, dailyValue, fmtNumber]) {
    assert.equal(f(202101, 'month'), 'Jan 2021');
    assert.equal(f(202211, 'month'), 'Nov 2022');
  }
  assert.equal(fmtMonth(199304), 'Apr 1993');
  assert.equal(endValue(1969, 'year'), '1969'); // unchanged
  assert.equal(endValue(-2560, 'year'), '2560 BC');
  assert.equal(endValue(175000000000, 'parameters'), '175 billion parameters'); // big counts read as words (AI pack v2)
});

test('AI pack: the answer carries the pair\'s reveal fact and category; the fact never reaches the browser\'s pool.json', async () => {
  const { answer } = await import('../functions/_rounds.js');
  const { publicPool, serverPool } = await import('../scripts/sync-items.js');
  const day = DATA.rounds['2026-10-05'];
  assert.ok(day, 'the ranked day 2026-10-05 exists');
  const slot1 = DATA.pairs.get(day.ranked[0]);
  const [a, b] = [DATA.items.get(slot1.a_id), DATA.items.get(slot1.b_id)];
  assert.equal(a.category, 'ai_timeline'); // slot 1 is the day's AI pair (CHANGELOG 2026-10-04 night)
  const fun = a.fun || b.fun;
  assert.ok(fun && fun.length <= 140, 'slot 1 has a reveal fact');
  const db = openD1();
  const plain = [...DATA.pairs.values()].find((p) => !DATA.items.get(p.a_id).fun && !DATA.items.get(p.b_id).fun);
  await db.prepare('INSERT INTO rounds (round_id, mode, date, items, created_at, difficulty) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('AAAAAAAAAAA2', 'quick', NOW.toISOString().slice(0, 10), JSON.stringify([slot1.id, plain.id]), NOW.toISOString(), 'normal').run();
  const r = await answer(db, DATA, { round_id: 'AAAAAAAAAAA2', item_id: slot1.id, choice: slot1.truth, conf: 80, rt_ms: 3000, anon_id: 'aiPairTester'.padEnd(22, 'x'), surface: 'web' }, NOW);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.truth, { a_value: a.answer, b_value: b.answer, unit: 'month', a_source: a.source, b_source: b.source, fun, category: 'ai_timeline' });
  const other = await answer(db, DATA, { round_id: 'AAAAAAAAAAA2', item_id: plain.id, choice: 0, conf: 80, rt_ms: 1, anon_id: 'x'.repeat(22), surface: 'web' }, NOW);
  assert.equal(other.status, 200);
  assert.ok(!('fun' in other.body.truth), 'no fact when neither item has one');
  const pool = { version: 1, items: [{ id: 'w0001', category: 'ai_timeline', en: { prompt: 'p', unit: 'month' }, answer: 202101, accept: [1, 2], source: 's', name: 'n', fun: 'A fact.' }] };
  assert.equal(serverPool(pool).items[0].fun, 'A fact.');
  assert.ok(!('fun' in publicPool(pool).items[0]));
  assert.ok(!JSON.stringify(json('public/pool.json')).includes(fun), 'public/pool.json holds no reveal fact');
});

test('AI pack: the reveal and the detail card show the fact under the sources with a "Did you know" label, only when present', async () => {
  const { detailCard } = await import('../public/round-end.js');
  const en = json('public/i18n/en.json');
  const t = (key, vars = {}) => key.split('.').reduce((o, k) => o?.[k], en).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const truth = { a_value: 202211, b_value: 202101, unit: 'month', a_source: 'https://en.wikipedia.org/wiki/ChatGPT', b_source: 'https://en.wikipedia.org/wiki/Anthropic' };
  const st = (fun) => ({ items: [{ id: 'p00001', prompt: 'Which came first?', a: 'ChatGPT (released)', b: 'Anthropic (founded)' }],
    answers: { p00001: { choice: 1, conf: 80, correct: true, points: 84, truth: { ...truth, ...(fun && { fun }) } } } });
  const withFun = String(detailCard(st('Anthropic was founded in January 2021 by seven former OpenAI employees.'), 0, t));
  assert.match(withFun, /Nov 2022 .*Jan 2021|Jan 2021[\s\S]*Nov 2022/);
  assert.match(withFun, /<\/ul>\n<p class="fun"><span class="fun-label">Did you know<\/span> Anthropic was founded in January 2021 by seven former OpenAI employees\.<\/p>/);
  assert.doesNotMatch(String(detailCard(st(null), 0, t)), /class="fun"/);
  assert.match(read('public/rounds.js'), /\$\{a\.truth\.fun \? html`<p class="fun"><span class="fun-label">\$\{t\('rounds\.fun_label'\)\}<\/span> \$\{a\.truth\.fun\}<\/p>` : ''\}/);
});

test('AI pack: reaction lines are posts/ai-humor.md section 1, word for word, and only AI pairs outside class mode use them', async () => {
  const { REACTIONS, AI_SURE, reactionBucket, pickReaction, isAiPair } = await import('../public/reactions.js');
  const md = readFileSync(new URL('../../posts/ai-humor.md', import.meta.url), 'utf8');
  const sec = md.slice(md.indexOf('## 1.'), md.indexOf('## 2.'));
  const lines = (from, to) => [...sec.slice(sec.indexOf(from), to ? sec.indexOf(to) : undefined).matchAll(/^- (.+)$/gm)].map((m) => m[1]);
  const right = lines('**Right', '**Wrong');
  const wrong = lines('**Wrong');
  const strip = (l) => l.replace(/ \(sure\)$/, '');
  assert.deepEqual(REACTIONS.ai_right, right.map(strip));
  assert.deepEqual(REACTIONS.ai_wrong, wrong.map(strip));
  assert.deepEqual([...AI_SURE], [...right, ...wrong].filter((l) => l.endsWith(' (sure)')).map(strip));
  const ai = (correct, conf) => ({ correct, conf, truth: { category: 'ai_timeline' } });
  const plain = (correct, conf) => ({ correct, conf, truth: { category: 'river_length' } });
  assert.equal(isAiPair(ai(true, 80)), true);
  assert.equal(isAiPair({ category: 'ai_params' }), true);
  assert.equal(isAiPair(plain(true, 80)), false);
  assert.equal(reactionBucket([ai(true, 80)], 0, 10), 'ai_right');
  assert.equal(reactionBucket([ai(false, 50)], 0, 10), 'ai_wrong');
  assert.equal(reactionBucket([ai(true, 70), ai(true, 70), ai(true, 70)], 2, 10), 'ai_right'); // AI lines even on a streak
  assert.equal(reactionBucket([ai(false, 80)], 0, 10, { mild: true }), 'wrong_mid'); // class mode: the general lines
  assert.equal(reactionBucket([plain(true, 80)], 0, 10), 'right_mid');
  for (let seed = 1; seed <= 60; seed += 1) {
    const rand = seeded(seed);
    const low = pickReaction([ai(false, 60)], 0, 10, new Set(), { rand });
    assert.ok(REACTIONS.ai_wrong.includes(low.template) && !AI_SURE.has(low.template), `seed ${seed}: "${low.template}" at 60%`);
    const sure = pickReaction([ai(false, 100)], 0, 10, new Set(), { rand });
    assert.ok(REACTIONS.ai_wrong.includes(sure.template), sure.template);
    const mild = pickReaction([ai(true, 90)], 0, 10, new Set(), { rand, mild: true });
    assert.ok(!REACTIONS.ai_right.includes(mild.template), `class mode got "${mild.template}"`);
  }
  assert.equal(pickReaction([ai(false, 90)], 0, 10, new Set(), { rand: () => 0.3 }).text.includes('{conf}'), false);
});

test('home page: the Discord, Slack and web mocks say what the bots and the game say (their own builders)', () => {
  const home = read('public/index.html');
  const between = (from, to) => home.slice(home.indexOf(from), home.indexOf(to, home.indexOf(from)));
  const lines = (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<\/(?:p|div)>/g, '\n').replace(/<\/span>\s*<span[^>]*>/g, ' ').replace(/<[^>]+>/g, '')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const has = (got, line, where) => assert.ok(got.includes(line), `${where}: "${line}" not in ${JSON.stringify(got)}`);
  // Discord markdown as the client shows it: bold, small text, a 20:00 reveal, the ✅ (drawn), "source" links.
  const shown = (md) => md.replace(/\*\*/g, '').replace(/^-# /gm, '').replace(/<t:\d+:t> \(<t:\d+:R>\)/g, '20:00').replace(/✅ /g, '')
    .replace(/\[source\]\(<[^>]+>\)/g, 'source').split('\n');
  const q = { round_id: 'dq-2026-10-05', item_id: 'p06261', prompt: 'Which is longer: the Nile or the Danube?', a: 'the Nile', b: 'the Danube' };
  const discord = lines(between('data-mock="discord"', 'data-mock="slack"'));
  const post = questionPost(q, '2026-10-05', '2026-10-05T20:00:00Z');
  for (const line of shown(post.content)) has(discord, line, 'Discord post');
  has(discord, post.components[0].components.map((b) => b.label).join(' '), 'Discord buttons');
  const picker = confidencePicker('2026-10-05', q.round_id, q.item_id, 0);
  for (const line of shown(picker.content)) has(discord, line, 'Discord private reply');
  for (const row of picker.components) has(discord, row.components.map((b) => b.label).join(' '), 'Discord confidence row');
  const names = ['Jerry']; // the owner's name on the page; the other four have no name on the page, so the bot prints 'a member'
  const top = [100, 96, 84, 64, 36].map((points, i) => ({ anon_id: `m${i}`, points })); // right at 100, 90, 80, 70, 60% sure
  const r = { n: 12, pct_a: 75, pct_b: 25, correct: 0, a_value: 6650, b_value: 2850, unit: 'km', a_source: 'https://www.wikidata.org/wiki/Q3392', b_source: 'https://www.wikidata.org/wiki/Q1653' };
  const reveal = revealMessage({ q, r, top, names: new Map(top.slice(0, 1).map((t, i) => [t.anon_id, names[i]])), bluff: { anon_id: 'x', conf: 90, choice: 1 }, roast: 0 });
  const revealed = lines(between('class="mock mock-reveal"', '</section>'));
  for (const line of shown(reveal.content)) has(revealed, line, 'Discord reveal');
  assert.ok(reveal.content.endsWith("Someone was 90% sure the Danube is longer. It isn't.")); // roast off: no name
  // Slack mrkdwn: bold, and the reveal time as the client shows a date token.
  const slackShown = (md) => md.replace(/\*/g, '').replace(/<!date\^\d+\^[^|]+\|[^>]+>/g, 'today 20:00');
  const slack = lines(between('data-mock="slack"', 'data-mock="web"'));
  const msg = questionMessage({ ...q, prompt: 'Which is longer?' }, '2026-10-05', Date.parse('2026-10-05T20:00:00Z'));
  has(slack, slackShown(msg.blocks[0].text.text), 'Slack section');
  has(slack, msg.blocks[1].elements.map((b) => b.text.text).join(' '), 'Slack buttons');
  has(slack, slackShown(msg.blocks[2].elements[0].text), 'Slack context');
  // The web game's question card: its progress label and its "how sure" line.
  const en = json('public/i18n/en.json');
  const web = lines(between('data-mock="web"', '</section>'));
  has(web, en.rounds.progress.replace('{i}', 4).replace('{n}', 10), 'web progress');
  has(web, en.rounds.how_sure, 'web confidence');
  has(web, '50% 60% 70% 80% 90% 100%', 'web confidence row');
});

// --- type names players read (the owner: "use normal words that say how confident people are") ---------------------

test('types: display names and one-liners everywhere players read them; the API and stored data keep their names', async () => {
  const { TYPE_NAMES, typeName } = await import('../public/types.js');
  const { TYPES, typeOf } = await import('../functions/_rounds.js');
  const { challengeDescription } = await import('../functions/_challenge.js');
  const WANT = {
    Bluffer: ['Bluffer', 'bluffer', 'Way more sure than right: 15 or more points over.'],
    'Hot-headed': ['Too sure', 'hot_headed', '5 to 15 points more sure than right.'],
    Calibrated: ['Spot on', 'calibrated', "Your confidence matches how often you're right, within 5 points."],
    Modest: ['Too modest', 'modest', '5 to 15 points less sure than right.'],
    Hedger: ['Playing it safe', 'hedger', '15 or more points less sure than right.'],
  };
  assert.deepEqual(TYPES, Object.keys(WANT)); // internal names unchanged
  assert.equal(typeOf(800, 7, 10), 'Hot-headed');
  const en = json('public/i18n/en.json');
  const stats = read('public/stats.html'); // the type tiles (the live panel)
  const support = read('public/support.html'); // the FAQ
  for (const [api, [name, key, line]] of Object.entries(WANT)) {
    assert.equal(TYPE_NAMES[api], name);
    assert.equal(typeName(api), name);
    assert.equal(en.rounds[`type_${key}`], line, api);

  }
  const faq = support.match(/<summary>What do the types mean\?<\/summary><p>([^<]+)<\/p>/)[1];
  for (const [name] of Object.values(WANT)) assert.ok(faq.includes(name), `FAQ: ${name}`);
  for (const page of [stats, support, read('public/index.html')]) assert.doesNotMatch(page.replace(/data-type="[a-z-]+"/g, ''), /Hot-headed|Calibrated|Hedger|\bModest\b/);
  assert.equal(challengeDescription('Hedger', 100, 70), "Playing it safe: 100% right at 70% sure. Play the same ten questions on Who's Bluffing.");
  const url = 'https://whosbluffing.com/c/ABCDEFGHJKLM/abcdefghij';
  assert.equal(shareWith(`Who's Bluffing? · Hot-headed · 420 pts · 70% right at 80% sure · ${url}`, { type: 'Hot-headed', pack: 'ai', url }),
    `Who's Bluffing? · AI pack · Too sure · 420 pts · 70% right at 80% sure · ${url}`);
  const rounds = read('public/rounds.js');
  assert.match(rounds, /<p class="type-name">\$\{typeName\(res\.type\)\}<\/p>/);
  assert.match(rounds, /type: typeName\(res\.type\),/); // the share card's canvas text
  assert.match(rounds, /\(p\) => typeName\(p\.type\)/); // the side-by-side
});


// --- AI pack v2: tiers per difficulty, big values in words -------------------------------------------------------

test('AI pack v2: a pack with tiers draws by tier at each difficulty; `all` does not; the real AI pack counts', () => {
  const items = [1, 2, 3, 4].map((k) => ({ id: `w000${k}`, category: 'ai_tech', en: { prompt: 'p', unit: 'transistors' }, answer: 10 ** (6 + k),
    accept: [0, 1e18], source: `https://www.wikidata.org/wiki/Q${k}#P1`, name: `chip ${k}` }));
  const templates = [{ category: 'ai_tech', unit: 'transistors', prompt: 'Which chip has more transistors?', more: 'had more', less: 'had fewer' }];
  // [n, a, b, truth, level (0 easy, 1 medium, 2 hard), band (2 famous), ref, tier]
  const pairs = [[1, 1, 2, 1, 2, 2, 1, 3], [2, 3, 4, 1, 0, 2, 1, 1], [3, 1, 3, 1, 1, 2, 1, 2]];
  const data = loadRounds({ items }, { templates, pairs }, {}, { minPackPairs: 1 });
  const ids = (k, d) => Object.values(data.packLists[k][d]).flat();
  assert.equal(data.pairs.get('p00001').tier, 3);
  assert.ok(!ids('ai', 'easy').includes('p00001'), 'tier 3 is not Easy');
  assert.ok(ids('ai', 'brutal').includes('p00001'), 'tier 3 is Brutal');
  assert.ok(ids('ai', 'easy').includes('p00002') && !ids('ai', 'brutal').includes('p00002'), 'tier 1: Easy, not Brutal');
  assert.ok(ids('ai', 'normal').includes('p00003') && ids('ai', 'brutal').includes('p00003') && !ids('ai', 'easy').includes('p00003'), 'tier 2: Normal and Brutal');
  assert.ok(ids('all', 'easy').includes('p00001'), '`all` has no tiers');
  assert.deepEqual(loadRounds({ items }, { templates, pairs: [[1, 1, 2, 1, 2, 2, 1]] }, {}).pairs.get('p00001').tier, 0); // older rows: tier 0
  // The real AI pack: pairs each difficulty can put in its mix (brief: Easy 403, Normal 1,725, Brutal 359 at the time of v2).
  const count = (d) => Object.entries(DATA.packLists.ai[d]).reduce((n, [level, list]) => n + (DIFFICULTIES[d].mix[level] ? list.length : 0), 0);
  const real = { easy: count('easy'), normal: count('normal'), brutal: count('brutal') };
  for (const d of ['easy', 'normal', 'brutal']) assert.ok(real[d] >= 200, `${d}: ${real[d]}`);
  for (const id of Object.values(DATA.packLists.ai.easy).flat()) assert.equal(DATA.pairs.get(id).tier, 1);
  for (const id of Object.values(DATA.packLists.ai.brutal).flat()) assert.ok([2, 3].includes(DATA.pairs.get(id).tier));
});

test('AI pack v2: dollars and big counts read as words; small counts, compute and other units keep their digits', async () => {
  const { fmtValue, bigWords } = await import('../public/ui.js');
  const { fmtValue: endValue, detailCard } = await import('../public/round-end.js');
  const { fmtValue: dailyValue } = await import('../public/daily.js');
  const cases = [
    [157e9, 'USD', '$157 billion'], [14e9, 'USD', '$14 billion'], [650e6, 'USD', '$650 million'], [1.2e12, 'USD', '$1.2 trillion'],
    [13000000000.0, 'USD', '$13 billion'], [1.25e9, 'USD', '$1.3 billion'], [500000, 'USD', '$500,000'],
    [1.2e12, 'transistors', '1.2 trillion transistors'], [15e12, 'training tokens', '15 trillion training tokens'],
    [175e9, 'parameters', '175 billion parameters'], [14e6, 'images', '14 million images'], [2e6, 'tokens of context', '2 million tokens of context'],
    [100000, 'tokens of context', '100,000 tokens of context'], [38000, 'petaFLOP-days', '38,000 petaFLOP-days'],
    [3.14e9, 'petaFLOP-days', '3,140,000,000 petaFLOP-days'], [999960000, 'parameters', '1 billion parameters'],
    [1428627663, 'people', '1,428,627,663 people'], [8849, 'm', '8,849 m'], [202211, 'month', 'Nov 2022'], [-2560, 'year', '2560 BC'],
  ];
  for (const [v, unit, want] of cases) {
    assert.equal(fmtValue(v, unit), want, `${v} ${unit}`);
    assert.equal(endValue(v, unit), want, `round-end: ${v} ${unit}`);
    if (unit !== 'year') assert.equal(dailyValue(v, unit), want, `daily: ${v} ${unit}`);
  }
  assert.equal(bigWords(999999), null);
  assert.equal(bigWords(-2.5e9), '-2.5 billion');
  const truth = { a_value: 13e9, b_value: 4e9, unit: 'USD', a_source: 'https://www.anthropic.com/news', b_source: 'https://openai.com/news' };
  const card = String(detailCard({ items: [{ id: 'p00001', prompt: 'Which is bigger?', a: 'round A', b: 'round B' }],
    answers: { p00001: { choice: 0, conf: 80, correct: true, points: 84, truth } } }, 0, (k, vars = {}) => k.split('.').reduce((o, x) => o?.[x], json('public/i18n/en.json')).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? vars[x] : m))));
  assert.match(card, /round A<\/span>: \$13 billion /);
  assert.match(card, /round B<\/span>: \$4 billion /);
  assert.match(read('public/rounds.js'), /fmtValue\(values\[c\], a\.truth\.unit\)/); // the reveal uses the same formatter
});
