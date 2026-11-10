// Unit tests for the non-metric logic: item bank, session builder, request validation, i18n, card text wrap,
// class aggregates. HTTP behaviour is covered by test/smoke.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateBank } from '../scripts/sync-items.js';
import { buildSession, pickBalanced } from '../public/test.js';
import { validateSubmit, DEMOGRAPHICS } from '../functions/_util.js';
import { wrap } from '../public/share.js';
import { html, store } from '../public/ui.js';
import { fmtValue, fmtNumber, noteKey, personalStats, hitsChart } from '../public/daily.js';
import { addSeen, scoreChart, fmtPoints, typeKey, fmtValue as roundValue, challengeFriend, renderChallenge } from '../public/rounds.js';
import { TYPES } from '../functions/_rounds.js';
import { classAggregate, toCsv } from '../functions/api/class/d/[secret].js';
import { overconfBin, intHitBin, histPercentile, percentiles, aggregateWrites, MIN_PERCENTILE_N } from '../functions/_aggregates.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const bank = read('../../items/items.json');
const items = bank.items;
const ITEMS = new Map(items.map((i) => [i.id, i]));
const en = read('../public/i18n/en.json');

test('friend challenges record a share only after copying succeeds', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const clipboard = {};
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator);
  t.mock.method(store, 'get', () => null); // first share must copy before asking for a nickname
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  });
  const url = 'https://whosbluffing.com/c/round/token';
  for (const outcome of ['success', 'rejected', 'unavailable']) {
    requests.length = 0;
    clipboard.writeText = (value) => {
      assert.equal(value, url);
      if (outcome === 'unavailable') throw new Error('Clipboard unavailable');
      return outcome === 'success' ? Promise.resolve() : Promise.reject(new Error('Copy denied'));
    };
    const panel = { hidden: true, querySelector: () => ({}) };
    challengeFriend({ t: (key) => key }, panel, { challenge_url: url }, { round_id: 'round' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.hidden, false);
    const markup = String(panel.innerHTML);
    assert.match(markup, /<label><span class="sr-only">rounds.nick_label<\/span><input name="nick"/);
    assert.equal(markup.replace(/<span class="sr-only">.*?<\/span>/g, '').match(/rounds.nick_label/g).length, 1);
    assert.equal(requests.length, outcome === 'success' ? 1 : 0);
    if (requests.length) {
      assert.equal(requests[0].url, '/api/event');
      assert.equal(requests[0].keepalive, true);
      assert.deepEqual(requests[0].body, { type: 'share', round_id: 'round' });
    }
  }
});

test('shared challenge keeps its named hero for the owner, a new friend and a returning friend', async (t) => {
  const roundId = 'ABCDEFGHJK23', token = 'abcdefghij';
  const hero = { textContent: 'Tom scored -200. Can you beat them?' };
  for (const [key, value] of Object.entries({
    document: { addEventListener() {}, getElementById: () => hero },
    location: { pathname: `/c/${roundId}/${token}` },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  t.mock.method(store, 'get', () => null);
  t.mock.method(store, 'set', () => {});
  const translate = (key, values = {}) => key.split('.').reduce((v, part) => v[part], en)
    .replace(/\{(\w+)\}/g, (_, name) => values[name]);
  const challenger = { nickname: 'Tom', score: -200, type: 'Bluffer', accuracy: 20, mean_conf: 80 };
  for (const viewer of ['owner', 'new', 'returning']) {
    const data = { own: viewer === 'owner', them: challenger, replies: [],
      me: viewer === 'new' ? null : viewer === 'owner' ? challenger : { ...challenger, nickname: 'Sam', score: 400 } };
    t.mock.method(globalThis, 'fetch', async (url) => Response.json(url.includes('/compare?') ? data : { round_id: roundId }));
    const refresh = {};
    const panel = { isConnected: true, querySelector: (selector) => selector === '[data-refresh]' ? refresh : {}, querySelectorAll: () => [] };
    const app = { replaceChildren() {}, querySelector: () => panel };
    let playLabel;
    await renderChallenge({ app, t: translate, setPlay: (label) => { playLabel = label; } }, roundId, token);
    assert.equal(hero.textContent, 'Tom scored -200. Can you beat them?', viewer);
    assert.equal(playLabel, translate(viewer === 'new' ? 'rounds.play' : 'rounds.rematch'));
    if (viewer === 'owner') {
      assert.ok(String(panel.innerHTML).includes(translate('rounds.friends_waiting')));
      await refresh.onclick();
      assert.equal(hero.textContent, 'Tom scored -200. Can you beat them?', 'owner refresh');
    }
    if (viewer === 'returning') {
      assert.match(String(panel.innerHTML), /<th scope="col">You<\/th><th scope="col">Tom<\/th>/);
      assert.match(String(panel.innerHTML), /data-race="400"/);
      assert.match(String(panel.innerHTML), /data-race="-200"/);
    }
  }
});

test('round confidence explains the stakes on the first question and stays short after it', async (t) => {
  for (const [key, value] of Object.entries({
    document: { addEventListener() {} },
    window: { scrollTo() {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const hint = '50% = guessing. 100% = certain. Being confidently wrong costs more. Tap a percentage to lock in.';
  const translate = (key, values = {}) => key.split('.').reduce((v, part) => v[part], en)
    .replace(/\{(\w+)\}/g, (_, name) => values[name]);
  const saved = { round_id: 'ABCDEFGHJK23', challenge: 'abcdefghij', mode: 'quick', total: 0,
    items: Array.from({ length: 10 }, (_, k) => ({ id: `q${k}`, prompt: `Question ${k + 1}`, a: 'A', b: 'B' })), answers: {} };
  t.mock.method(store, 'get', (key, fallback) => key === 'whosbluffing_round' ? saved : fallback);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Resuming must not submit an answer'); });
  for (const k of [0, 1, 9]) {
    saved.answers = Object.fromEntries(saved.items.slice(0, k).map((item) => [item.id, { correct: true }]));
    const panel = { hidden: true };
    const picks = [0, 1].map((c) => ({ dataset: { c }, setAttribute() {} }));
    const confidence = [50, 60, 70, 80, 90, 100].map((conf) => ({ dataset: { conf }, setAttribute() {} }));
    const app = { replaceChildren() {},
      querySelector: (selector) => selector === '#conf' ? panel : { focus() {} },
      querySelectorAll: (selector) => selector === '.pick' ? picks : confidence };
    let resume;
    await renderChallenge({ app, t: translate, chrome() {}, setPlay: (_, action) => { resume = action; } }, saved.round_id, saved.challenge);
    resume();
    const markup = String(app.innerHTML);
    assert.ok(markup.includes(`<p class="sub">${k === 0 ? hint : en.rounds.how_sure}</p>`), `question ${k + 1}`);
    assert.equal(markup.includes(hint), k === 0);
    assert.match(markup, /<div id="conf" hidden>/);
    assert.equal((markup.match(/data-conf="/g) ?? []).length, 6);
    assert.equal(panel.hidden, true);
    picks[0].onclick();
    assert.equal(panel.hidden, false, 'choosing an answer reveals confidence without an extra step');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

// Deterministic PRNG so failures reproduce.
function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test('item bank: valid, 40/20/2, every domain has enough items for two balanced sessions', () => {
  assert.deepEqual(validateBank(bank), []);
  const of = (t) => items.filter((i) => i.type === t);
  assert.equal(of('2afc').length, 40);
  assert.equal(of('interval').length, 20);
  assert.equal(of('attention').length, 2);
  const domains = ['physics', 'biology', 'geography', 'history', 'math', 'everyday'];
  for (const d of domains) {
    assert.ok(of('2afc').filter((i) => i.domain === d).length >= 4, `2afc ${d}`);
    assert.ok(of('interval').filter((i) => i.domain === d).length >= 2, `interval ${d}`);
  }
  for (const level of ['easy', 'medium', 'hard']) {
    const share = items.filter((i) => i.type !== 'attention' && i.difficulty_hint === level).length / 60;
    assert.ok(share > 0.25 && share < 0.42, `${level} share ${share}`);
  }
});

test('item bank validator rejects broken items', () => {
  const broken = (patch) => validateBank({ version: 1, items: items.map((i) => (i.id === 'r001' ? { ...i, ...patch } : i)) });
  assert.match(broken({ accept: [6000, 9000] }).join(), /accept/);
  assert.match(broken({ source: '' }).join(), /source/);
  assert.match(broken({ id: 'R1' }).join(), /bad id/);
  assert.match(validateBank({ version: 1, items: items.filter((i) => i.type !== 'attention') }).join(), /attention/);
});

test('buildSession: 12 + 6 + 2, balanced 2 per domain, attention at positions 5–15, no duplicates', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const s = buildSession(items, new Set(), seeded(seed));
    assert.equal(s.length, 20);
    assert.equal(new Set(s.map((i) => i.id)).size, 20);
    const two = s.filter((i) => i.type === '2afc');
    assert.equal(two.length, 12);
    assert.equal(s.filter((i) => i.type === 'interval').length, 6);
    const perDomain = Object.values(Object.groupBy(two, (i) => i.domain)).map((g) => g.length);
    assert.deepEqual(perDomain, [2, 2, 2, 2, 2, 2]);
    const positions = s.map((i, k) => (i.type === 'attention' ? k + 1 : null)).filter(Boolean);
    assert.equal(positions.length, 2);
    for (const p of positions) assert.ok(p >= 5 && p <= 15, `attention at ${p}`);
  }
});

test('buildSession: second run avoids seen items but keeps both attention checks', () => {
  const first = buildSession(items, new Set(), seeded(7));
  const seen = new Set(first.map((i) => i.id));
  const second = buildSession(items, seen, seeded(8));
  const repeats = second.filter((i) => seen.has(i.id)).map((i) => i.type);
  assert.deepEqual(repeats.sort(), ['attention', 'attention']);
});

test('pickBalanced falls back to the whole pool when too few unseen items remain', () => {
  const pool = items.filter((i) => i.type === 'interval');
  const seen = new Set(pool.slice(0, 18).map((i) => i.id));
  const picked = pickBalanced(pool, 6, seen, seeded(3));
  assert.equal(picked.length, 6);
  assert.equal(new Set(picked.map((i) => i.id)).size, 6);
});

function validBody() {
  const of = (t, n) => items.filter((i) => i.type === t).slice(0, n);
  return {
    lang: 'en',
    website: '',
    answers: [
      ...of('2afc', 12).map((i) => ({ id: i.id, choice: 1, conf: 80, rt_ms: 2000 })),
      ...of('interval', 6).map((i) => ({ id: i.id, low: 1, high: 2, rt_ms: 3000 })),
      ...of('attention', 2).map((i) => ({ id: i.id, choice: i.answer, conf: 100, rt_ms: 1000 })),
    ],
  };
}

test('validateSubmit accepts a complete session and rejects each kind of bad input', () => {
  assert.equal(validateSubmit(validBody(), ITEMS), null);
  assert.equal(validateSubmit({ ...validBody(), class_code: 'ABC234', first_session_id: crypto.randomUUID(), anon_id: 'Ab3_-xYz012345678901_Q', demographics: { age: '18_24', region: 'europe' } }, ITEMS), null);
  const bad = (mutate) => { const b = validBody(); mutate(b); return validateSubmit(b, ITEMS); };
  assert.match(bad((b) => { b.lang = 'fr'; }), /lang/);
  assert.match(bad((b) => { b.lang = 'zh'; }), /lang must be en/); // English only
  assert.match(bad((b) => { b.answers[0].conf = 55; }), /conf/);
  assert.match(bad((b) => { b.answers[0].choice = 2; }), /choice/);
  assert.match(bad((b) => { b.answers[12].low = 5; }), /range/);
  assert.match(bad((b) => { b.answers[12].high = Infinity; }), /range/);
  assert.match(bad((b) => { b.answers[0].rt_ms = -1; }), /rt_ms/);
  assert.match(bad((b) => { b.answers[0].id = 'x999'; }), /unknown item/);
  assert.match(bad((b) => { b.answers[1].id = b.answers[0].id; }), /duplicate/);
  assert.match(bad((b) => { b.answers.pop(); }), /expected 2 attention/);
  assert.match(bad((b) => { b.class_code = 'abc'; }), /class_code/);
  assert.match(bad((b) => { b.first_session_id = 'nope'; }), /first_session_id/);
  assert.match(bad((b) => { b.anon_id = 'x'.repeat(65); }), /anon_id/);
  assert.match(bad((b) => { b.demographics = { age: '99' }; }), /age/);
  assert.match(bad((b) => { b.demographics = { email: 'x' }; }), /unknown demographic/);
  assert.match(validateSubmit([], ITEMS), /object/);
  // Out-of-bounds ranges are analysis-time exclusions, not rejections.
  assert.equal(bad((b) => { b.answers[12].low = -1e9; b.answers[12].high = 1e12; }), null);
});

const at = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const PUBLIC = new URL('../public/', import.meta.url);

test('i18n: one English file; every t() key used in public/*.js exists; demographic codes match the API', () => {
  assert.deepEqual(readdirSync(new URL('i18n/', PUBLIC)), ['en.json']);
  const keys = readdirSync(PUBLIC).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...readFileSync(new URL(f, PUBLIC), 'utf8').matchAll(/\bt\('([a-z_]+(?:\.[a-z0-9_]+)+)'/g)].map((m) => m[1]));
  assert.ok(keys.length > 60, `found only ${keys.length} keys`);
  for (const k of keys) assert.equal(typeof at(en, k), 'string', `missing string ${k}`);
  for (const [field, codes] of Object.entries(DEMOGRAPHICS)) assert.deepEqual(Object.keys(en.demo.options[field]), codes, field);
});

test('English only: no Chinese characters in any shipped file', () => {
  const CJK = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/;
  const files = readdirSync(PUBLIC, { recursive: true }).filter((f) => /\.(js|json|html|css|txt|xml)$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) assert.ok(!CJK.test(readFileSync(new URL(f, PUBLIC), 'utf8')), f);
});

test('i18n: consent and headline copy match the brief', () => {
  assert.equal(en.landing.consent, '5 minutes. Anonymous — no account, no tracking. Your answers go into a public research dataset. Close the page any time to stop.');
  const fill = (str, v) => str.replace(/\{(\w+)\}/g, (_, k) => v[k]);
  assert.equal(fill(en.results.int_headline, { k: 4, n: 6 }), 'Your 90% ranges were right 4 of 6 times.');
  assert.equal(fill(en.results.over_headline, { x: 12 }), 'You were 12 points more confident than you were right.');
});

test('html template escapes interpolated text but not nested templates', () => {
  const label = '<img src=x onerror=alert(1)>';
  assert.equal(String(html`<p>${label}</p>`), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(String(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b</li></ul>');
});

test('wrap: greedy word wrap; long words and emoji grids stay whole', () => {
  const measure = (s) => [...s].length; // one unit per character
  assert.deepEqual(wrap('Your 90% ranges were right', 12, measure), ['Your 90%', 'ranges were', 'right']);
  assert.deepEqual(wrap('#12 🟩🟩🟥🟩🟩 4/5', 6, measure), ['#12', '🟩🟩🟥🟩🟩', '4/5']);
  assert.deepEqual(wrap('  spaced   out  ', 40, measure), ['spaced out']);
  assert.deepEqual(wrap('', 10, measure), []);
});

function fakeEnv(rows, secretKnown = true) {
  const stmt = (sql) => ({
    bind: () => ({
      first: async () => (sql.includes('FROM classes') && secretKnown ? { code: 'ABC234' } : null),
      all: async () => ({ results: rows }),
    }),
  });
  return { DB: { prepare: stmt } };
}
const row = (overconf, int_hit, answers) => ({ overconf, int_hit, answers: JSON.stringify(answers) });
const SECRET = 'A'.repeat(24);

test('class dashboard: only the count below 5 students, aggregates from 5, never rows', async () => {
  const answers = [{ type: '2afc', conf: 80, correct: 1 }, { type: '2afc', conf: 80, correct: 0 }, { type: 'interval', hit: 1 }];
  const four = [0.1, 0.2, 0.3, -0.1].map((oc) => row(oc, 0.5, answers));
  assert.deepEqual(await classAggregate(fakeEnv(four), SECRET), { n: 4 });
  const five = [...four, row(0.45, 1, answers)];
  const agg = await classAggregate(fakeEnv(five), SECRET);
  assert.deepEqual(Object.keys(agg).sort(), ['bins', 'int_hit_mean', 'n', 'overconf_hist', 'overconf_mean']);
  assert.equal(agg.n, 5);
  assert.equal(agg.overconf_mean, 0.19);
  assert.equal(agg.int_hit_mean, 0.6);
  assert.deepEqual(agg.bins.find((b) => b.conf === 0.8), { conf: 0.8, n: 10, acc: 0.5 });
  assert.equal(agg.overconf_hist.reduce((s, h) => s + h.n, 0), 5);
  assert.equal(agg.overconf_hist.find((h) => h.from === 40).n, 1); // 0.45 -> 40..50
  assert.equal(agg.overconf_hist.find((h) => h.from === -10).n, 1); // -0.1 -> -10..0
  assert.match(toCsv(agg), /^metric,bucket,n,value\nstudents,,5,\n/);
  assert.equal(toCsv({ n: 3 }), 'metric,bucket,n,value\nstudents,,3,\n');
  assert.equal(await classAggregate(fakeEnv(five, false), SECRET), null);
  assert.equal(await classAggregate(fakeEnv(five), 'short'), null);
});

test('aggregate bins: 0.05-wide overconfidence clamped to ±0.5, exact hit-rate bins', () => {
  assert.equal(overconfBin(0.083333), 2); // 1.67 -> 2
  assert.equal(overconfBin(0.025), 1); // halves round up
  assert.equal(overconfBin(-0.025), 0); // -0.5 -> 0, never -0
  assert.equal(overconfBin(-0.5), -10);
  assert.equal(overconfBin(0.9), 10); // clamped
  assert.equal(intHitBin(0), 0);
  assert.equal(intHitBin(0.833333), 5);
  assert.equal(intHitBin(1), 6);
});

test('histogram percentile: mid-rank = lower bins + half of your own bin', () => {
  const rows = [{ bin: -2, n: 10 }, { bin: 0, n: 20 }, { bin: 3, n: 10 }];
  assert.equal(histPercentile(rows, 0), 50); // (10 + 20/2) / 40
  assert.equal(histPercentile(rows, -2), 13); // (0 + 10/2) / 40 = 12.5%
  assert.equal(histPercentile(rows, 1), 75); // own bin empty: 30 / 40
  assert.equal(histPercentile(rows, 10), 100);
  assert.equal(histPercentile(rows, -10), 0);
  assert.equal(histPercentile([{ bin: 1, n: 7 }], 1), 50); // everyone tied
  assert.equal(histPercentile([], 0), null);
});

test('percentiles: null below 30 same-language sessions, histogram mid-rank from 30', () => {
  const tied = (n) => [{ metric: 'overconf', bin: 2, n }, { metric: 'int_hit', bin: 3, n }];
  const scores = { overconf: 0.083333, int_hit: 0.5 };
  assert.equal(percentiles(tied(MIN_PERCENTILE_N - 1), scores), null);
  assert.deepEqual(percentiles(tied(MIN_PERCENTILE_N), scores), { overconf: 50, int_hit: 50 });
  const spread = [
    { metric: 'overconf', bin: 0, n: 20 }, { metric: 'overconf', bin: 4, n: 20 },
    { metric: 'int_hit', bin: 2, n: 30 }, { metric: 'int_hit', bin: 6, n: 10 },
  ];
  // overconf 0.1 -> bin 2: 20 below of 40; int_hit 1 -> bin 6: (30 + 10/2) / 40 = 87.5%
  assert.deepEqual(percentiles(spread, { overconf: 0.1, int_hit: 1 }), { overconf: 50, int_hit: 88 });
  assert.equal(percentiles([], scores), null);
});

test('aggregate writes: four upserts for a passed session, none after a failed attention check', () => {
  const db = { prepare: (sql) => ({ bind: (...params) => ({ sql, params }) }) };
  const s = {
    passed_attention: true, n_2afc: 12, n_interval: 6, scores: { overconf: 0.25, int_hit: 0.5 },
    answers: [
      { type: '2afc', conf: 80, correct: 1 }, { type: '2afc', conf: 80, correct: 0 }, { type: '2afc', conf: 100, correct: 1 },
      { type: 'attention', conf: 100, correct: 1 }, { type: 'interval', hit: 1 },
    ],
  };
  const w = aggregateWrites(db, 'zh', 'CN', s);
  assert.deepEqual(w.map((x) => x.sql.match(/INTO (\w+)/)[1]), ['agg_totals', 'agg_hist', 'agg_bins', 'agg_country']);
  assert.deepEqual(w[0].params, ['zh', 18, 0.25, 0.5]);
  assert.deepEqual(w[1].params, ['zh', 5, 'zh', 3]); // overconf bin 5, int_hit bin 3
  assert.deepEqual(w[2].params, ['zh', 80, 2, 1, 'zh', 100, 1, 1]); // attention answers never enter the curve
  assert.deepEqual(w[3].params, ['CN']);
  assert.deepEqual(aggregateWrites(db, 'zh', 'CN', { ...s, passed_attention: false }), []);
});

test('daily UI: years without separators, units elsewhere; calibration note; 30-day stats from local plays', () => {
  assert.equal(fmtValue(1969, 'year'), '1969');
  assert.equal(fmtValue(8038, 'm'), '8,038 m');
  assert.equal(fmtValue(-38.8, '°C'), '-38.8 °C');
  assert.equal(fmtNumber(2748109, 'people'), '2,748,109');
  assert.equal(noteKey({ hit: true, truth: 5, low: 1, high: 9 }), 'daily.note_hit');
  assert.equal(noteKey({ hit: false, truth: 50, low: 1, high: 9 }), 'daily.note_above');
  assert.equal(noteKey({ hit: false, truth: 0, low: 1, high: 9 }), 'daily.note_below');
  const plays = {
    '2026-09-20': { result: { hits: 5, n: 5 } }, // 31 days before: outside the window
    '2026-09-21': { result: { hits: 2, n: 5 } },
    '2026-10-10': { answers: {} }, // started, not finished
    '2026-10-20': { result: { hits: 3, n: 4 } },
  };
  assert.deepEqual(personalStats(plays, '2026-10-20'), { plays: 2, hits: 5, n: 9, rate: 5 / 9 });
  assert.deepEqual(personalStats({}, '2026-10-20'), { plays: 0, hits: 0, n: 0, rate: null });
  const svg = String(hitsChart([1, 0, 2, 0, 5, 1], 4, 'Today'));
  assert.equal((svg.match(/<rect /g) ?? []).length, 6);
  assert.equal((svg.match(/class="bar mine"/g) ?? []).length, 1);
  assert.match(svg, /aria-label="Today"/);
});

test('rounds UI: the newest 300 seen pairs, oldest first; signed points; a string for every type; the chart marks your bin', () => {
  const seen = Array.from({ length: 295 }, (_, k) => `p${String(k + 1).padStart(5, '0')}`);
  const next = addSeen(seen, ['p00003', 'p90001', 'p90002', 'p90003', 'p90004', 'p90005', 'p90006']);
  assert.equal(next.length, 300);
  assert.deepEqual(next.slice(-7), ['p00003', 'p90001', 'p90002', 'p90003', 'p90004', 'p90005', 'p90006']); // replayed ids move to the end
  assert.equal(next[0], 'p00002'); // the oldest fell off
  assert.deepEqual([fmtPoints(84), fmtPoints(0), fmtPoints(-156)], ['+84', '0', '−156']);
  assert.deepEqual([roundValue(-2560, 'year'), roundValue(1889, 'year'), roundValue(6650, 'km')], ['2560 BC', '1889', '6,650 km']);
  for (const type of TYPES) assert.equal(typeof at(en, typeKey(type)), 'string', type);
  assert.equal(new Set(TYPES.map(typeKey)).size, 5);
  const stats = { score_hist: Array.from({ length: 41 }, (_, k) => (k === 30 ? 4 : k === 35 ? 1 : 0)), bin_from: -3000, bin_width: 100 };
  const svg = String(scoreChart(stats, 520, 'Scores'));
  assert.equal((svg.match(/<rect /g) ?? []).length, 9); // bins 29..36 with one empty bin each side, widened to 9 bins
  assert.equal((svg.match(/class="bar anim anim-grow mine"/g) ?? []).length, 1); // the bars grow in (motion.js)
  assert.match(svg, /<title>500 to 599: 1<\/title>/);
  assert.equal(String(scoreChart({ ...stats, score_hist: Array(41).fill(0) }, null, 'x')), '');
});
