// Rounds (docs/api-rounds.md): ten two-choice questions per round, quadratic points, calibration types, challenge links,
// the Slack/Discord daily question, pair flags. Pairs and ranked days come in as data from loadRounds (unit tests use
// fixtures; _rounds_data.js loads the bundled copies). Request functions return {status, body}.
// Bounded: a request reads the round's own rows (<= 10 answers, its pairs and their items, one play, the day's <= 4
// round_agg rows; a dare's complete counts that round's plays) and aggregates in SQL. The exception is retiring a pair: the affected ranked days are recomputed
// in SQL from their answers (once per retired pair).
import { ANON_RE, RETIRE_FLAGS, todayUTC, addDays, isDate } from './_daily.js';
import { randomString, CODE_ALPHABET, SECRET_ALPHABET } from './_util.js';
import { DARE_RE, dareShareText } from './_dares.js';
import { PACKS } from '../public/packs.js';

export { PACKS };

export const SURFACES = ['web', 'slack', 'discord', 'room'];
export const CONFS = [50, 60, 70, 80, 90, 100];
export const LEVELS = ['easy', 'medium', 'hard'];
export const MIX = { easy: 3, medium: 4, hard: 3 };
// Quick-round difficulty (GET /api/round?difficulty=): which pairs, and how many of each level. normal (the default):
// both items known (>= 20,000 monthly English Wikipedia views), at most one pair under 50,000; easy: both famous
// (>= 50,000) and far apart (ratio >= 3, or 50+ years); brutal: any pair of referenced items, close ones preferred.
export const DIFFICULTIES = {
  easy: { mix: { easy: 10, medium: 0, hard: 0 }, ok: (p) => p.band === 2 },
  normal: { mix: MIX, ok: (p) => p.band >= 1, maxKnown: 1 },
  brutal: { mix: { easy: 0, medium: 4, hard: 6 }, ok: (p) => p.ref === 1 },
};
// A pack other than `all` is offered at a difficulty only when its pairs can fill that difficulty's mix: at least this
// many pairs that may take a main slot (for normal: famous pairs; its one lesser-known slot comes on top) and at least
// the mix's count at every level the mix uses. `all` is always offered.
export const MIN_PACK_PAIRS = 200;
export const MAX_SEEN = 300;
const AUTHORED_PACKS = ['memes', 'history', 'languages'];
export const TYPES =['Bluffer', 'Hot-headed', 'Calibrated', 'Modest', 'Hedger'];
export const EVENT_TYPES = ['share', 'challenge_view', 'play_again'];
export const TOKEN_RE = /^[A-Za-z0-9_-]{10}$/;
export const PAIR_RE = /^[pq]\d{5}$/; // p: generated comparisons; q: immutable authored questions
export const HIST_MIN = -3000; // ten answers at 100% and wrong
export const HIST_BUCKETS = 1001; // scores are multiples of 4 from -3000 to 1000
export const BIN_WIDTH = 100; // /api/round/stats bins
export const CONFIDENT_MISS = 70; // a wrong answer at this confidence or more can be roasted
// /api/round/stats `bluffs`: the ranked round's costliest misses at 90% or surer (BLUFF_SQL and migration 0007 say 90),
// one per pair, at most MAX_BLUFFS, shown only once MIN_BLUFF_PLAYERS have finished the round.
export const MAX_BLUFFS = 3;
export const MIN_BLUFF_PLAYERS = 5;
// round_agg.calib: answers and right answers at each confidence, in CONFS order: [n50, right50, n60, right60, ...].
export function calibOf(answers) {
  const c = Array(2 * CONFS.length).fill(0);
  for (const a of answers) {
    const k = 2 * CONFS.indexOf(a.conf);
    c[k] += 1;
    c[k + 1] += a.correct ? 1 : 0;
  }
  return c;
}
const CALIB_ADD = Array.from({ length: 2 * CONFS.length }, (_, k) => `'$[${k}]', json_extract(calib, '$[${k}]') + json_extract(excluded.calib, '$[${k}]')`).join(', ');
// A daily question is open on its UTC day and the next: it takes answers and revisions, and revealing it needs the bot
// header (no peeking). Afterwards answers get 409 locked, the reveal is public and the KPI run settles leftover points.
export const QUESTION_OPEN_DAYS = 2;
const openFrom = (today) => addDays(today, 1 - QUESTION_OPEN_DAYS);
const COMMUNITY_RE = /^(slack|discord|room):[A-Za-z0-9_-]{1,64}$/;
const QUICK_RE = /^[A-Z2-9]{12}$/; // CODE_ALPHABET
const NICK_RE = /^[\p{L}\p{N} .'_-]{1,24}$/u;
const MAX_REASON = 280;
const SPARE = 2; // extra quick-round candidates per difficulty, in case some turn out to be retired

const ok = (body) => ({ status: 200, body });
const err = (status, error) => ({ status, body: { error } });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const qs = (n) => Array(n).fill('?').join(', ');
const r1 = (x) => Math.round(x * 10) / 10;
const pairId = (n) => `p${String(n).padStart(5, '0')}`;
const itemId = (n) => `w${String(n).padStart(4, '0')}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// pool: items/pool.json; compact: functions/_pairs.json ({templates, pairs: [[n, a, b, truth, level, band, ref, tier]]},
// written by sync-items); rounds: daily/rounds.json ({date: {ranked: [10 ids], question: id}}).
// packLists[pack][difficulty][level] = the pair ids that difficulty may draw for that pack (lists = packLists.all);
// available[difficulty] = the set of packs offered there (minPackPairs: a lower bar for small test fixtures).
// dares: functions/_dares.json (the dare board's fixed rounds dr-<slug>, _dares.js), kept as data.dares by slug.
export function loadRounds(pool, compact, rounds, { minPackPairs = MIN_PACK_PAIRS, dares = [], curated = [] } = {}) {
  const items = new Map(pool.items.map((i) => [i.id, i]));
  const templates = new Map(compact.templates.map((t) => [`${t.category}|${t.unit}`, t]));
  const pairs = new Map();
  const packLists = Object.fromEntries(Object.keys(PACKS).map((k) => [k, Object.fromEntries(Object.keys(DIFFICULTIES).map((d) => [d, { easy: [], medium: [], hard: [] }]))]));
  const packsOf = new Map(); // category -> the packs it belongs to, `all` first
  // Every category joins `all` except the Politics pack's: politics stays behind its own chip and the dare pages, out of
  // the default rounds that classrooms, Slack workspaces and Discord servers draw (owner's rule, 2026-10-05).
  for (const [k, pack] of Object.entries(PACKS)) for (const c of pack.categories ?? []) packsOf.set(c, [...(packsOf.get(c) ?? (c.startsWith('pol_') ? [] : ['all'])), k]);
  for (const [n, a, b, truth, level, band = 0, ref = 0, tier = 0] of compact.pairs) {
    const p = { id: pairId(n), a_id: itemId(a), b_id: itemId(b), truth, level: LEVELS[level], band, ref, tier };
    pairs.set(p.id, p);
    const packs = packsOf.get(items.get(p.a_id)?.category) ?? ['all'];
    // A pack with `tiers` (the AI pack) also draws by tier at each difficulty; `all` has none.
    for (const [d, spec] of Object.entries(DIFFICULTIES)) {
      if (!spec.ok(p)) continue;
      for (const k of packs) if (!PACKS[k].tiers || PACKS[k].tiers[d].includes(p.tier)) packLists[k][d][p.level].push(p.id);
    }
  }
  const lists = packLists.all;
  const available = Object.fromEntries(Object.entries(DIFFICULTIES).map(([d, spec]) => [d, new Set(Object.keys(PACKS).filter((k) => k === 'all'
    || fillable(spec, packLists[k][d], pairs, minPackPairs)))]));
  const entity = new Map([...items.values()].map((i) => [i.id, (i.replaces || i.source).match(/\/(Q\d+)#/)?.[1] ?? i.id]));
  // Adapt authored choices to the existing scoring, retirement and challenge paths. Their ids never overlap the
  // generated bank, and they never enter ranked schedules or fixed dares. Text verdicts use the same reveal fields.
  for (const q of curated) {
    const ids = q.options.map((name, k) => {
      const id = `${q.id}-${k}`;
      items.set(id, { id, name, category: q.topic === 'ai' ? 'ai_curated' : q.topic, en: { unit: '' },
        answer: k === q.answer ? 'Correct' : 'Incorrect', source: q.source });
      // A meme may have several questions, but appears only once in a round.
      entity.set(id, q.subjects?.[0] ?? (q.topic === 'memes' ? q.source : id));
      return id;
    });
    pairs.set(q.id, { id: q.id, a_id: ids[0], b_id: ids[1], truth: q.answer, level: q.difficulty,
      authored: q, ref: 1, topic: q.topic, family: q.family });
  }
  const rankedDatesByItem = new Map(); // for the recompute after a retirement
  for (const [date, day] of Object.entries(rounds)) {
    for (const id of day.ranked) {
      const p = pairs.get(id);
      for (const i of [p.a_id, p.b_id]) rankedDatesByItem.set(i, [...(rankedDatesByItem.get(i) ?? []), date]);
    }
  }
  const data = { items, pairs, templates, lists, packLists, available, rounds, entity, rankedDatesByItem,
    curated: curated.map((q) => q.id), dares: new Map(dares.map((d) => [d.slug, d])) };
  // This authored-only pack needs a complete, varied round, not 200 generated comparisons.
  for (const pack of AUTHORED_PACKS) for (const d of Object.keys(DIFFICULTIES)) {
    available[d].delete(pack);
    const ids = curated.filter((q) => q.topic === pack).map((q) => q.id);
    if (sampleVaried(data, ids, new Set(), () => 0.5, d, pack)) available[d].add(pack);
  }
  return data;
}

// Can a pack's lists for one difficulty fill its mix? Counts the pairs that may take a main slot at each level the mix
// uses (normal's lesser-known pairs only ever fill one slot, so they do not count).
function fillable(spec, lists, pairs, minPairs) {
  let total = 0;
  for (const level of LEVELS) {
    if (!spec.mix[level]) continue;
    const n = spec.maxKnown == null ? lists[level].length : lists[level].filter((id) => pairs.get(id).band === 2).length;
    if (n < spec.mix[level]) return false;
    total += n;
  }
  return total >= minPairs;
}

// {difficulty: [pack ids offered there]} in PACKS order (sync-pages writes the home page's chips from it).
export const packAvailability = (data) => Object.fromEntries(Object.entries(data.available).map(([d, set]) => [d, Object.keys(PACKS).filter((k) => set.has(k))]));

// The pair ids any round can serve: what each difficulty draws from at the levels its mix uses, plus the ranked days and
// chat questions. The home page's "N+ questions" counts these.
export function servablePairs(data) {
  const ids = new Set();
  for (const [d, spec] of Object.entries(DIFFICULTIES)) for (const level of LEVELS) if (spec.mix[level]) data.lists[d][level].forEach((id) => ids.add(id));
  for (const day of Object.values(data.rounds)) [...day.ranked, day.question].forEach((id) => ids.add(id));
  data.curated.forEach((id) => ids.add(id));
  return ids;
}

// --- scoring ------------------------------------------------------------------------------------------------------

// 100 - 400 (c - y)^2 with c = conf / 100 and y = 1 if right: in whole numbers, 100 - (conf - 100y)^2 / 25.
export const points = (conf, correct) => 100 - ((conf - 100 * (correct ? 1 : 0)) ** 2) / 25;

// overconfidence = mean confidence - accuracy, in points; d = n * overconfidence, so the boundaries are exact.
// >= +15 Bluffer, +5 to +15 Hot-headed, between -5 and +5 Calibrated, -15 to -5 Modest, <= -15 Hedger.
export function typeOf(sumConf, nCorrect, n) {
  const d = sumConf - 100 * nCorrect;
  if (d >= 15 * n) return 'Bluffer';
  if (d >= 5 * n) return 'Hot-headed';
  if (d > -5 * n) return 'Calibrated';
  if (d > -15 * n) return 'Modest';
  return 'Hedger';
}

// answers: [{conf, correct, points}] for the round's live pairs.
export function scoreRound(answers) {
  const n = answers.length;
  const sumConf = answers.reduce((s, a) => s + a.conf, 0);
  const nCorrect = answers.reduce((s, a) => s + (a.correct ? 1 : 0), 0);
  const accuracy = (100 * nCorrect) / n;
  const meanConf = sumConf / n;
  return {
    score: answers.reduce((s, a) => s + a.points, 0),
    accuracy: r1(accuracy),
    mean_conf: r1(meanConf),
    overconfidence: r1(meanConf - accuracy),
    brier: Math.round((answers.reduce((s, a) => s + (a.conf / 100 - (a.correct ? 1 : 0)) ** 2, 0) / n) * 1e4) / 1e4,
    type: typeOf(sumConf, nCorrect, n),
    exact_overconf: meanConf - accuracy,
  };
}

export const shareText = ({ type, score, accuracy, mean_conf: meanConf }, url) =>
  `Who's Bluffing? · ${type} · ${score} pts · ${Math.round(accuracy)}% right at ${Math.round(meanConf)}% sure · ${url}`;

// Twenty roast lines for the most confident miss. {right}/{wrong}: the options as named; {more}/{less}: the pair's
// template phrases ("was longer" / "was shorter"); a capital letter = the name with its first letter capitalised.
export const ROASTS = [
  '{conf}% sure {right} {less}? {Right} would like a word.',
  '{conf}% sure {wrong} {more}. Bold. Wrong, but bold.',
  '{Wrong} {more}, at {conf}%? Not this time.',
  '{conf}% on {wrong}. The source begs to differ.',
  '{Right} {more}. Your {conf}% did not get the memo.',
  '{conf}% sure {wrong} {more}? Somewhere a fact-checker sighed.',
  'That {conf}% on {wrong} aged like milk.',
  '{conf}% sure about {wrong}. The reference disagrees, politely.',
  'You called {wrong} at {conf}%. {Right} {more}. Ouch.',
  'You bet {conf}% on {wrong}. The house always wins: {right} {more}.',
  '{conf}% sure {wrong} {more}. We admire the confidence, not the answer.',
  '{Right} {more}. Your {conf}% is now a cautionary tale.',
  '{conf}% sure {right} {less}. {Right} has receipts.',
  'Big call: {conf}% on {wrong}. Bigger fact: {right} {more}.',
  '{conf}% on {wrong}? The numbers had other plans.',
  '{Wrong} {more}? Not at {conf}%, not at any percent.',
  '{conf}% sure, and still wrong: {right} {more}.',
  '{Right} {more}, and your {conf}% is filing a complaint.',
  'Plot twist for your {conf}%: {right} {more}.',
  '{conf}% confident, 0% correct. {Right} {more}.',
];

export const hash = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);

// The roast for the round's most confident miss (conf >= 70, first in round order on a tie), or null.
export function roastFor(data, roundId, ids, byItem) {
  let miss = null;
  for (const id of ids) {
    const a = byItem.get(id);
    if (a && !a.correct && a.conf >= CONFIDENT_MISS && (!miss || a.conf > miss.a.conf)) miss = { id, a };
  }
  if (!miss) return null;
  const p = data.pairs.get(miss.id);
  if (p.authored) return `You backed "${p.authored.options[1 - p.truth]}" at ${miss.a.conf}%. The answer was "${p.authored.options[p.truth]}".`;
  const t = template(data, p);
  const names = [data.items.get(p.a_id).name, data.items.get(p.b_id).name];
  const fill = { conf: miss.a.conf, right: names[p.truth], wrong: names[1 - p.truth], more: t.more, less: t.less };
  const line = ROASTS[hash(`${roundId}|${miss.id}`) % ROASTS.length];
  return line.replace(/\{(\w+)\}/g, (m, k) => (k in fill ? fill[k] : cap(fill[k.toLowerCase()])));
}

// --- views and validation ---------------------------------------------------------------------------------------

const template = (data, p) => {
  const a = data.items.get(p.a_id);
  return data.templates.get(`${a.category}|${a.en.unit}`);
};

// Equivalent prompts keep the answer direction unchanged. Stable per pair, including saved/shared rounds.
const PROMPT_VARIANTS = {
  'Which came first?': ['Put these on a timeline. Which goes first?', 'Pick the earlier event.'],
  'Which is larger by area?': ['Compare their areas. Which takes up more space?', 'Pick the one with the greater area.'],
  'Which is higher?': ['Compare their elevations. Which reaches higher?', 'Pick the one with the greater elevation.'],
  'Which is longer?': ['Pick the longer of these two.', 'Length check: which measures more from end to end?'],
  'Which is deeper?': ['Compare their depths. Which reaches farther down?', 'Pick the deeper of these two.'],
  'Which is taller?': ['Imagine these side by side. Which stands taller?', 'Pick the one with the greater height.'],
  'Which has the bigger diameter?': ['Compare them edge to edge. Which has the greater diameter?', 'Pick the wider of these two worlds.'],
  'Which is farther from the Sun?': ['Compare their distances from the Sun. Which is farther out?', 'Pick the one farther from the Sun.'],
  'Which orbits farther from its planet?': ['Compare their orbits. Which is farther from its own planet?', 'Pick the one orbiting farther from its planet.'],
  'Which melts at a higher temperature?': ['Heat them separately. Which needs a higher temperature to melt?', 'Pick the element with the higher melting point.'],
  'Which was founded first?': ['Compare their founding dates. Which goes back further?', 'Pick the university founded earlier.'],
  'Which was first climbed earlier?': ['Compare the first successful ascents. Which happened earlier?', 'Pick the mountain whose first ascent came earlier.'],
  'Which country has more people?': ['Compare their populations. Which country has more residents?', 'Pick the more populous country.'],
  'Which company was founded first?': ['Compare their founding dates. Which company started earlier?', 'Pick the company founded earlier.'],
  'Which came out first?': ['Put these releases on a timeline. Which goes first?', 'Pick the earlier release.'],
  'Which language has more native speakers?': ['Count native speakers only. Which language has more?', 'Pick the language with the larger native-speaking population.'],
  'Which is older?': ['Compare when these were built. Which dates back further?', 'Pick the older landmark.'],
  'Which model has more parameters?': ['Compare parameter counts. Which model has more?', 'Pick the model with the larger parameter count.'],
  'Which is bigger?': ['Compare the two figures. Which is greater?', 'Pick the larger of these two figures.'],
  'Which has the longer context window?': ['Compare context limits. Which can fit more tokens?', 'Pick the one with the larger context window.'],
  'Which was trained on more tokens?': ['Compare their training data in tokens. Which used more?', 'Pick the one trained on the greater token count.'],
  'Which took more compute to train?': ['Compare training compute. Which used more?', 'Pick the one with the larger training-compute total.'],
  'Which chip has more transistors?': ['Compare transistor counts. Which chip has more?', 'Pick the chip with the larger transistor count.'],
  'Which dataset has more images?': ['Compare image counts. Which dataset has more?', 'Pick the larger image collection.'],
  'Which has more memory?': ['Compare memory capacity. Which holds more?', 'Pick the one with the greater memory capacity.'],
  'Which paper has more authors?': ['Compare the author lists. Which paper has more names?', 'Pick the paper with the larger author team.'],
  'Which model has more experts?': ['Compare expert counts. Which model has more?', 'Pick the model with the greater number of experts.'],
};

export function pairView(data, id) {
  const p = data.pairs.get(id);
  const base = p.authored?.prompt ?? template(data, p).prompt;
  const prompts = p.authored ? [base] : [base, ...(PROMPT_VARIANTS[base] ?? [])];
  return { id, prompt: prompts[hash(id) % prompts.length], a: data.items.get(p.a_id).name, b: data.items.get(p.b_id).name };
}

// Both values and sources; `fun`, a curated reveal fact (the AI pack), when either item has one (the first non-empty).
function truthView(data, p) {
  const a = data.items.get(p.a_id);
  const b = data.items.get(p.b_id);
  const fun = p.authored?.explanation || a.fun || b.fun;
  return { a_value: a.answer, b_value: b.answer, unit: a.en.unit, a_source: a.source, b_source: b.source, ...(fun && { fun }) };
}

// {kind: 'ranked'|'question', date}, {kind: 'dare', slug} or {kind: 'quick'}; null when the id has no valid shape.
export function parseRoundId(id) {
  if (typeof id !== 'string') return null;
  const m = id.match(/^(rk|dq)-(\d{4}-\d{2}-\d{2})$/);
  if (m) return isDate(m[2]) ? { kind: m[1] === 'rk' ? 'ranked' : 'question', date: m[2] } : null;
  const dare = id.match(DARE_RE);
  if (dare) return { kind: 'dare', slug: dare[1] };
  return QUICK_RE.test(id) ? { kind: 'quick' } : null;
}

function playerError(b) {
  if (!isObject(b)) return err(400, 'body must be a JSON object');
  if (typeof b.anon_id !== 'string' || !ANON_RE.test(b.anon_id)) return err(400, 'bad anon_id');
  if (!SURFACES.includes(b.surface)) return err(400, 'surface must be web, slack, discord or room');
  if (b.community != null) {
    if (typeof b.community !== 'string' || !COMMUNITY_RE.test(b.community)) return err(400, 'bad community');
    if (b.surface !== 'web' && !b.community.startsWith(`${b.surface}:`)) return err(400, 'community must start with the surface');
  }
  if (parseRoundId(b.round_id) === null) return err(400, 'bad round_id');
  return null;
}
const communityOf = (b) => (b.surface === 'web' ? null : b.community ?? null);

// The round's pair ids. Ranked rounds and daily questions come from the bundled days (never before their day), a dare
// from the bundled dares (not a removed one); quick rounds from the rounds table.
async function resolveRound(db, data, roundId, now) {
  const r = parseRoundId(roundId);
  if (r.kind === 'dare') {
    const dare = data.dares.get(r.slug);
    return dare && dare.status !== 'removed' ? { kind: 'dare', date: dare.issued, ids: dare.items, dare } : { error: err(404, 'unknown round') };
  }
  if (r.kind === 'quick') {
    const row = await db.prepare('SELECT mode, date, items, pack, difficulty FROM rounds WHERE round_id = ?').bind(roundId).first();
    if (!row) return { error: err(404, 'unknown round') };
    const ids = JSON.parse(row.items);
    // Old Memes links predate the pack column; Memes questions never appear in All.
    const pack = row.pack ?? (ids.length && ids.every((id) => data.pairs.get(id)?.topic === 'memes') ? 'memes' : 'all');
    return { kind: 'quick', date: row.date, ids, pack, difficulty: row.difficulty ?? 'normal' };
  }
  const day = r.date <= todayUTC(now) ? data.rounds[r.date] : null;
  if (!day) return { error: err(404, 'unknown round') };
  return { kind: r.kind, date: r.date, ids: r.kind === 'ranked' ? orderRanked(day.ranked, r.date) : [day.question] };
}

// The same shuffled order for everyone, seeded by the date (the file lists hard, easy, medium).
// The file's first id stays first (from 2026-10-05 it is the day's AI question); the other nine are shuffled, same for everyone.
const orderRanked = (ids, date) => (date >= '2026-10-05' ? [ids[0], ...ids.slice(1).sort((x, y) => hash(`${date}|${x}`) - hash(`${date}|${y}`))] : [...ids].sort((x, y) => hash(`${date}|${x}`) - hash(`${date}|${y}`)));

// Statements that find which of the pair ids are retired or share a retired item (a pair sharing a retired
// value retires too); deadFrom reads their results.
function deadStatements(db, data, ids) {
  const items = [...new Set(ids.flatMap((id) => [data.pairs.get(id).a_id, data.pairs.get(id).b_id]))];
  return [
    db.prepare(`SELECT pair_id FROM pair_runtime WHERE retired_at IS NOT NULL AND pair_id IN (${qs(ids.length)})`).bind(...ids),
    db.prepare(`SELECT item_id FROM items_runtime WHERE retired_at IS NOT NULL AND item_id IN (${qs(items.length)})`).bind(...items),
  ];
}
function deadFrom(data, ids, [pairRows, itemRows]) {
  const items = new Set(itemRows.results.map((r) => r.item_id));
  const dead = new Set(pairRows.results.map((r) => r.pair_id));
  for (const id of ids) {
    const p = data.pairs.get(id);
    if (items.has(p.a_id) || items.has(p.b_id)) dead.add(id);
  }
  return dead;
}
async function liveIds(db, data, ids) {
  const live = [];
  // D1 allows 100 bindings per statement; each question has two underlying items.
  for (let k = 0; k < ids.length; k += 40) {
    const chunk = ids.slice(k, k + 40);
    const dead = deadFrom(data, chunk, await db.batch(deadStatements(db, data, chunk)));
    live.push(...chunk.filter((id) => !dead.has(id)));
  }
  return live;
}

// --- GET /api/round -----------------------------------------------------------------------------------------------

// The difficulty's mix of pairs per level from the pack, then SPARE more of each level it uses, none in `avoid`, unseen
// first, no item or entity twice in the round, and (normal) at most one pair under 50,000 views. [{id, level}] in pick
// order, so the main slots come first.
export function sampleQuick(data, avoid, seen, rand, difficulty = 'normal', pack = 'all') {
  const spec = DIFFICULTIES[difficulty];
  const picked = [];
  const entities = new Set();
  const formats = {};
  let known = 0;
  for (const [level, count] of [...LEVELS.map((l) => [l, spec.mix[l]]), ...LEVELS.map((l) => [l, spec.mix[l] ? SPARE : 0])]) {
    if (!count) continue;
    const ids = data.packLists[pack][difficulty][level];
    const forms = [...new Set(ids.map((id) => template(data, data.pairs.get(id)).prompt))];
    let need = count;
    for (let tries = 0; need > 0 && tries < 600 && ids.length; tries += 1) {
      const id = ids[Math.floor(rand() * ids.length)];
      const p = data.pairs.get(id);
      const ents = [data.entity.get(p.a_id), data.entity.get(p.b_id)];
      const unseenOnly = tries < 400; // a player who has seen nearly everything still gets a round
      if (avoid.has(id) || picked.some((x) => x.id === id) || ents.some((e) => entities.has(e)) || (unseenOnly && seen.has(id))) continue;
      if (spec.maxKnown != null && p.band < 2 && known >= spec.maxKnown) continue;
      const form = template(data, p).prompt;
      // Prefer underrepresented comparisons; relax for narrow packs or exhausted/retired content.
      if (ids.length >= MIN_PACK_PAIRS && tries < 300 && (formats[form] ?? 0) > Math.min(...forms.map((f) => formats[f] ?? 0))) continue;
      picked.push({ id, level });
      formats[form] = (formats[form] ?? 0) + 1;
      ents.forEach((e) => entities.add(e));
      if (p.band < 2) known += 1;
      need -= 1;
    }
  }
  return picked;
}

const shuffle = (xs, rand) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Spread comparison types and equivalent wordings apart, including packs with only one kind of fact.
function orderQuick(data, ids, rand) {
  const left = shuffle(ids, rand).map((id) => ({ id, form: template(data, data.pairs.get(id)).prompt, prompt: pairView(data, id).prompt }));
  const picked = [];
  while (left.length) {
    const last = picked.at(-1);
    left.sort((a, b) => Number(a.form === last?.form) - Number(b.form === last?.form)
      || Number(a.prompt === last?.prompt) - Number(b.prompt === last?.prompt)
      || left.filter((x) => x.form === b.form && x.prompt === b.prompt).length - left.filter((x) => x.form === a.form && x.prompt === a.prompt).length);
    picked.push(left.shift());
  }
  return picked.map((p) => p.id);
}

// New quick rounds only: authored questions first, topic-balanced, with a real explanation on every authored reveal.
// Keep the 3/4/3 difficulty contract; generated candidates cover sparse/retired levels. A bounded search
// avoids greedy dead ends where the last difficulty has only topics already used. Seen questions are a last resort.
export function sampleVaried(data, ids, seen, rand, difficulty, pack) {
  const variedTopic = ['history', 'languages'].includes(pack);
  const recentSubjects = new Set([...seen].flatMap((id) => data.pairs.get(id)?.authored?.subjects ?? []));
  const candidates = shuffle(ids, rand).map((id) => {
    const p = data.pairs.get(id);
    const a = data.items.get(p.a_id);
    const topic = p.topic ?? (a.category.startsWith('ai_') ? 'ai'
      : a.category.startsWith('country_') ? 'world' : a.category);
    const family = p.family ?? (['year', 'month'].includes(a.en.unit) ? 'chronology' : 'comparison');
    return { id, p, topic, family, entities: p.authored?.subjects ?? [data.entity.get(p.a_id), data.entity.get(p.b_id)],
      subtopic: p.authored?.subtopic, era: p.authored?.era, region: p.authored?.region };
  });
  for (const [freshOnly, authoredOnly, freshSubjects] of [[true, true, true], [true, true, false], [true, false, false], [false, false, false]]) {
    const mix = DIFFICULTIES[difficulty].mix;
    const pool = candidates.filter((c) => mix[c.p.level] && (!freshOnly || !seen.has(c.id)) && (!authoredOnly || c.p.authored)
      && (!freshSubjects || !c.entities.some((s) => recentSubjects.has(s))));
    if (LEVELS.some((lv) => pool.filter((c) => c.p.level === lv).length < mix[lv])) continue;
    const familyCounts = {};
    for (const c of pool) familyCounts[c.family] = (familyCounts[c.family] ?? 0) + 1;
    if (Object.entries(familyCounts).reduce((sum, [f, n]) => sum + Math.min(n, f === 'chronology' ? 2 : 3), 0) < 10) continue;
    const includeAI = pack === 'all' && pool.some((c) => c.topic === 'ai' && DIFFICULTIES[difficulty].mix[c.p.level]);
    const left = { ...DIFFICULTIES[difficulty].mix }, topics = {}, families = {}, subtopics = {}, eras = {}, regions = {}, entities = new Set(), picked = [];
    let visits = 0;
    const search = () => {
      if (picked.length === 10) return true;
      if (++visits > 10000) return false;
      const eligible = pool.filter((c) => left[c.p.level] > 0 && !picked.includes(c)
        && !c.entities.some((e) => entities.has(e))
        && (pack !== 'all' || (topics[c.topic] ?? 0) < (c.topic === 'ai' ? 1 : 2))
        && (families[c.family] ?? 0) < (c.family === 'chronology' ? 2 : 3)
        && (!variedTopic || ((subtopics[c.subtopic] ?? 0) < 3
          && (!['chronology', 'comparison'].includes(c.family) || (families.chronology ?? 0) + (families.comparison ?? 0) < 2)))
        && (pack !== 'history' || ((eras[c.era] ?? 0) < 4 && (regions[c.region] ?? 0) < 4))
        && (!includeAI || picked.length !== 9 || topics.ai || c.topic === 'ai'));
      // Stop a dead branch before permuting its remaining questions. Adjacency is checked afterwards:
      // a family or region blocked for the next slot can still fill a later slot.
      if (LEVELS.some((lv) => eligible.filter((c) => c.p.level === lv).length < left[lv])) return false;
      const options = eligible.filter((c) => c.family !== picked.at(-1)?.family
        && (pack !== 'history' || (c.region !== picked.at(-1)?.region
          && (picked.length !== 3 || new Set([...picked.map((q) => q.region), c.region]).size >= 3))));
      // Stable sort preserves the initial random order within equally underrepresented topics and formats.
      options.sort((a, b) => Number(seen.has(a.id)) - Number(seen.has(b.id))
        || Number(Boolean(b.p.authored)) - Number(Boolean(a.p.authored))
        || (topics[a.topic] ?? 0) - (topics[b.topic] ?? 0) || (families[a.family] ?? 0) - (families[b.family] ?? 0));
      for (const c of options) {
        picked.push(c); left[c.p.level]--; topics[c.topic] = (topics[c.topic] ?? 0) + 1;
        families[c.family] = (families[c.family] ?? 0) + 1;
        for (const [counts, key] of [[subtopics, c.subtopic], [eras, c.era], [regions, c.region]]) counts[key] = (counts[key] ?? 0) + 1;
        c.entities.forEach((e) => entities.add(e));
        if (search()) return true;
        picked.pop(); left[c.p.level]++; topics[c.topic]--; families[c.family]--;
        for (const [counts, key] of [[subtopics, c.subtopic], [eras, c.era], [regions, c.region]]) counts[key]--;
        c.entities.forEach((e) => entities.delete(e));
      }
      return false;
    };
    if (search()) return picked.map((c) => c.id);
  }
  return null;
}

const parseSeen = (s) => new Set((typeof s === 'string' ? s.split(',') : []).filter((x) => PAIR_RE.test(x)).slice(-MAX_SEEN));

// params: {mode, seen, round_id, difficulty, pack}. round_id (an addition to the contract) loads an existing round, for
// challenge links; difficulty and pack apply to quick rounds (default normal, all). A pack the difficulty cannot fill is
// refused rather than served short.
export async function getRound(db, data, params, now, rand = Math.random) {
  const today = todayUTC(now);
  if (params.round_id != null) {
    const r = parseRoundId(params.round_id);
    if (!r || r.kind === 'question') return err(400, 'bad round_id');
    const round = await resolveRound(db, data, params.round_id, now);
    if (round.error) return round.error;
    const ids = await liveIds(db, data, round.ids);
    const d = round.dare; // a dare also names its pack, difficulty and person
    return ok({ round_id: params.round_id, mode: round.kind, date: round.date,
      ...(round.kind === 'quick' && { pack: round.pack, difficulty: round.difficulty }),
      ...(d && { pack: d.pack, difficulty: d.difficulty, dare: { slug: d.slug, name: d.name, address: d.address } }), items: ids.map((id) => pairView(data, id)) });
  }
  if (params.mode === 'ranked') {
    const day = data.rounds[today];
    if (!day) return err(404, 'no ranked round today');
    const ids = await liveIds(db, data, orderRanked(day.ranked, today));
    return ok({ round_id: `rk-${today}`, mode: 'ranked', date: today, items: ids.map((id) => pairView(data, id)) });
  }
  if (params.mode !== 'quick') return err(400, 'mode must be ranked or quick');
  let previous;
  if (params.rematch != null) {
    if (parseRoundId(params.rematch)?.kind !== 'quick') return err(400, 'bad rematch');
    previous = await resolveRound(db, data, params.rematch, now);
    if (previous.error) return previous.error;
  }
  const difficulty = previous?.difficulty ?? (params.difficulty || 'normal');
  if (!Object.hasOwn(DIFFICULTIES, difficulty)) return err(400, 'difficulty must be easy, normal or brutal');
  const pack = previous?.pack ?? (params.pack || 'all');
  if (!Object.hasOwn(PACKS, pack)) return err(400, 'unknown pack');
  if (!data.available[difficulty].has(pack)) return err(400, 'not enough questions in this pack at this difficulty');
  const day = data.rounds[today];
  const avoid = new Set(day ? [...day.ranked, day.question] : []); // never today's ranked pairs or chat question
  previous?.ids.forEach((id) => avoid.add(id)); // a rematch never repeats the round it follows, even after pool exhaustion
  const seen = parseSeen(params.seen);
  const candidates = AUTHORED_PACKS.includes(pack) ? [] : sampleQuick(data, avoid, seen, rand, difficulty, pack);
  const authored = data.curated.filter((id) => {
    if (avoid.has(id)) return false;
    const topic = data.pairs.get(id).topic;
    return pack === 'all' ? topic !== 'memes' : topic === pack;
  });
  const live = new Set(await liveIds(db, data, [...authored, ...candidates.map((c) => c.id)]));
  const mix = DIFFICULTIES[difficulty].mix;
  const comparisonRound = () => orderQuick(data, LEVELS.flatMap((level) => candidates.filter((c) => c.level === level && live.has(c.id)).slice(0, mix[level]).map((c) => c.id)), rand);
  let ids = authored.length ? sampleVaried(data, [...live], seen, rand, difficulty, pack) : comparisonRound();
  // AI's small authored pool can run out on a rematch; use its existing sourced comparisons, with the same difficulty/tier and no previous questions.
  if (!ids && previous && pack === 'ai') ids = comparisonRound();
  if (!ids || ids.length !== 10) return err(503, 'Not enough live questions for this round. Try another pack or difficulty.');
  const roundId = randomString(12, CODE_ALPHABET);
  await db.prepare('INSERT INTO rounds (round_id, mode, date, items, created_at, difficulty, pack) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(roundId, 'quick', today, JSON.stringify(ids), now.toISOString(), difficulty, pack).run();
  return ok({ round_id: roundId, mode: 'quick', difficulty, pack, date: today, items: ids.map((id) => pairView(data, id)) });
}

// --- POST /api/round/answer ---------------------------------------------------------------------------------------

const ANSWER_SQL = 'SELECT choice, conf, correct, points FROM round_answers WHERE anon_id = ? AND round_id = ? AND item_id = ?';
const TOTAL_SQL = 'SELECT COALESCE(SUM(points), 0) AS total FROM round_answers WHERE anon_id = ? AND round_id = ?';
const PENDING = { locked: true, points_pending: true };

function answerBodyError(b) {
  const bad = playerError(b);
  if (bad) return bad;
  if (typeof b.item_id !== 'string' || !PAIR_RE.test(b.item_id)) return err(400, 'bad item_id');
  if (b.choice !== 0 && b.choice !== 1) return err(400, 'choice must be 0 or 1');
  if (!CONFS.includes(b.conf)) return err(400, 'conf must be 50, 60, 70, 80, 90 or 100');
  if (b.rt_ms != null && !(Number.isFinite(b.rt_ms) && b.rt_ms >= 0)) return err(400, 'bad rt_ms');
  if (b.revision != null && typeof b.revision !== 'boolean') return err(400, 'revision must be true or false');
  return null;
}

// truth.category lets the web game pick the AI pack's reaction lines (categories ai_*).
const answerBody = (data, p, a, total) => ({ correct: Boolean(a.correct), truth: { ...truthView(data, p), category: data.items.get(p.a_id).category }, points: a.points, total, choice: a.choice, conf: a.conf });

export async function answer(db, data, b, now) {
  const bad = answerBodyError(b);
  if (bad) return bad;
  const today = todayUTC(now);
  const parsed = parseRoundId(b.round_id);
  if (parsed.kind === 'question' && parsed.date < openFrom(today)) return err(409, 'locked');
  const round = await resolveRound(db, data, b.round_id, now);
  if (round.error) return round.error;
  if (!round.ids.includes(b.item_id)) return err(404, 'item is not in this round');
  const key = [b.anon_id, b.round_id, b.item_id];
  const rt = b.rt_ms == null ? null : Math.round(b.rt_ms);
  const at = now.toISOString();
  if (round.kind === 'question') return answerQuestion(db, b, key, rt, at, round.date);

  const p = data.pairs.get(b.item_id);
  const [first, total] = await db.batch([db.prepare(ANSWER_SQL).bind(...key), db.prepare(TOTAL_SQL).bind(b.anon_id, b.round_id)]);
  if (first.results[0]) return ok(answerBody(data, p, first.results[0], total.results[0].total));
  const correct = b.choice === p.truth ? 1 : 0;
  const a = { choice: b.choice, conf: b.conf, correct, points: points(b.conf, correct) };
  try {
    const out = await db.batch([
      db.prepare(`INSERT INTO round_answers (anon_id, round_id, item_id, choice, conf, correct, points, rt_ms, answered_at, surface, community)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...key, a.choice, a.conf, a.correct, a.points, rt, at, b.surface, communityOf(b)),
      db.prepare(`INSERT INTO pair_runtime (pair_id, n, n_correct, sum_conf) VALUES (?, 1, ?, ?)
        ON CONFLICT (pair_id) DO UPDATE SET n = n + 1, n_correct = n_correct + excluded.n_correct, sum_conf = sum_conf + excluded.sum_conf`)
        .bind(b.item_id, a.correct, a.conf),
      db.prepare(TOTAL_SQL).bind(b.anon_id, b.round_id),
    ]);
    return ok(answerBody(data, p, a, out[2].results[0].total));
  } catch (e) {
    const [raced, t] = await db.batch([db.prepare(ANSWER_SQL).bind(...key), db.prepare(TOTAL_SQL).bind(b.anon_id, b.round_id)]);
    if (!raced.results[0]) throw e; // a concurrent first answer won; it is final
    return ok(answerBody(data, p, raced.results[0], t.results[0].total));
  }
}

// Daily question: no truth and no points until the reveal (no early peeking). revision: true replaces the answer
// (and makes it pending again); without it a repeat changes nothing. The day counts as a play day for the KPI job.
async function answerQuestion(db, b, key, rt, at, date) {
  const first = await db.prepare(ANSWER_SQL).bind(...key).first();
  if (first && !b.revision) return ok(PENDING);
  if (first) {
    await db.prepare(`UPDATE round_answers SET choice = ?, conf = ?, correct = NULL, points = NULL, rt_ms = ?, answered_at = ?
      WHERE anon_id = ? AND round_id = ? AND item_id = ?`).bind(b.choice, b.conf, rt, at, ...key).run();
    return ok(PENDING);
  }
  await db.batch([
    db.prepare(`INSERT INTO round_answers (anon_id, round_id, item_id, choice, conf, correct, points, rt_ms, answered_at, surface, community)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(...key, b.choice, b.conf, rt, at, b.surface, communityOf(b)),
    db.prepare('INSERT INTO player_days (anon_id, day, rounds, streak) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING').bind(b.anon_id, date),
  ]);
  return ok(PENDING);
}

// Points for pending daily-question answers, as SQL over the stored choice and confidence (truth = the pair's).
const SETTLE_SQL = `UPDATE round_answers SET correct = (choice = ?1),
  points = 100 - ((conf - 100 * (choice = ?1)) * (conf - 100 * (choice = ?1))) / 25
  WHERE round_id = ?2 AND points IS NULL`;

// KPI-run pass: settles every daily question that no longer takes answers, within `days` back.
export async function settleQuestions(db, data, now, days = 35) {
  const today = todayUTC(now);
  const stmts = [];
  for (let k = QUESTION_OPEN_DAYS; k <= days; k += 1) {
    const date = addDays(today, -k);
    const q = data.rounds[date]?.question;
    if (q) stmts.push(db.prepare(SETTLE_SQL).bind(data.pairs.get(q).truth, `dq-${date}`));
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// --- POST /api/round/complete -------------------------------------------------------------------------------------

const PLAY_SQL = 'SELECT score, nickname, public_token, day, surface FROM round_plays WHERE anon_id = ? AND round_id = ?';
const AGG_SQL = 'SELECT surface, players, score_hist, sum_overconf, calib FROM round_agg WHERE date = ?';
// A dare round's completed plays and how many scored higher (idx_round_plays_round). ponytail: counts the round's rows
// on every complete; add an index on round_plays(round_id, score) if one dare passes ~100,000 plays.
const DARE_RANK_SQL = 'SELECT COUNT(*) AS players, COALESCE(SUM(score > ?), 0) AS above FROM round_plays WHERE round_id = ?';

function completeBodyError(b) {
  const bad = playerError(b);
  if (bad) return bad;
  if (b.nickname != null && !(typeof b.nickname === 'string' && NICK_RE.test(b.nickname.trim().replace(/\s+/g, ' ')))) {
    return err(400, "nickname: 1-24 letters, digits, spaces or . ' _ -");
  }
  if (b.challenge != null && !(typeof b.challenge === 'string' && TOKEN_RE.test(b.challenge))) return err(400, 'bad challenge');
  return null;
}

export const histIndex = (score) => (score - HIST_MIN) / 4;

// {rank, players} over the day's round_agg rows: rank = 1 + players with a higher score.
export function rankIn(aggRows, score) {
  let players = 0;
  let above = 0;
  for (const r of aggRows) {
    players += r.players;
    JSON.parse(r.score_hist).forEach((c, k) => { if (k > histIndex(score)) above += c; });
  }
  return { rank: above + 1, players };
}

// A fresh public token (never equal to the anon_id it stands for).
export function newToken(anonId, rand = () => randomString(10, SECRET_ALPHABET)) {
  let t = rand();
  while (t === anonId) t = rand();
  return t;
}

export async function complete(db, data, b, now, origin) {
  const bad = completeBodyError(b);
  if (bad) return bad;
  // The bot-only API host cannot serve the game pages that friends open.
  const publicUrl = new URL(origin);
  publicUrl.hostname = publicUrl.hostname.replace(/^bots\./, '');
  origin = publicUrl.origin;
  const round = await resolveRound(db, data, b.round_id, now);
  if (round.error) return round.error;
  if (round.kind === 'question') return err(400, 'the daily question has no complete; its answer is the play');
  if (b.challenge != null) {
    const challenger = await db.prepare('SELECT anon_id, round_id FROM round_plays WHERE public_token = ?').bind(b.challenge).first();
    if (!challenger || challenger.round_id !== b.round_id || challenger.anon_id === b.anon_id) return err(400, 'challenge must belong to another player of this round');
  }
  const today = todayUTC(now);
  const [answers, prior, ...deadRows] = await db.batch([
    db.prepare('SELECT item_id, choice, conf, correct, points FROM round_answers WHERE anon_id = ? AND round_id = ?').bind(b.anon_id, b.round_id),
    db.prepare(PLAY_SQL).bind(b.anon_id, b.round_id),
    ...deadStatements(db, data, round.ids),
  ]);
  const dead = deadFrom(data, round.ids, deadRows);
  const live = round.ids.filter((id) => !dead.has(id));
  const byItem = new Map(answers.results.map((a) => [a.item_id, a]));
  if (!live.length || live.some((id) => !byItem.has(id))) return err(400, 'answer every question first');
  const s = scoreRound(live.map((id) => byItem.get(id)));
  const nickname = b.nickname == null ? null : b.nickname.trim().replace(/\s+/g, ' ');
  const aggregated = round.kind === 'ranked' && (round.date === today || round.date === addDays(today, -1));
  // A dare's link is its page (the same ten for everyone), its share text names the person, and it ranks the play
  // among the round's completed plays: rank = 1 + plays with a higher score.
  const { dare } = round;
  const rankDare = () => db.prepare(DARE_RANK_SQL).bind(s.score, b.round_id);
  const respond = (token, streak, aggRows, rankRow) => {
    const url = dare ? `${origin}/dare/${dare.slug}` : `${origin}/c/${b.round_id}/${token}`;
    const { exact_overconf: _, ...scores } = s;
    const body = { ...scores, streak, challenge_url: url, share_text: dare ? dareShareText(dare, s.score, new URL(origin).host) : shareText(s, url) };
    if (aggRows) {
      const { rank, players } = rankIn(aggRows, s.score);
      Object.assign(body, { rank_today: rank, players_today: players, today: statsBody(round.date, aggRows) }); // fresh, unlike the cached stats
    }
    if (rankRow) Object.assign(body, { rank: rankRow.above + 1, players: rankRow.players, dare: { slug: dare.slug, name: dare.name, address: dare.address } });
    const roast = roastFor(data, b.round_id, live, byItem);
    if (roast) body.roast = roast;
    return ok(body);
  };
  const replay = async () => {
    const play = await db.prepare(PLAY_SQL).bind(b.anon_id, b.round_id).first();
    if (!play) return null;
    const stmts = [db.prepare('SELECT streak FROM player_days WHERE anon_id = ? AND day = ?').bind(b.anon_id, play.day)];
    if (aggregated) stmts.push(db.prepare(AGG_SQL).bind(round.date));
    if (dare) stmts.push(rankDare()); // never both: out[1] is one or the other
    if (nickname && nickname !== play.nickname) {
      stmts.push(db.prepare('UPDATE round_plays SET nickname = ? WHERE anon_id = ? AND round_id = ?').bind(nickname, b.anon_id, b.round_id));
    }
    const out = await db.batch(stmts);
    return respond(play.public_token, out[0].results[0]?.streak ?? 0, aggregated ? out[1].results : null, dare ? out[1].results[0] : null);
  };
  if (prior.results[0]) return replay();

  const token = newToken(b.anon_id);
  const at = now.toISOString();
  const idx = histIndex(s.score);
  const stmts = [
    db.prepare(`INSERT INTO round_plays (anon_id, round_id, surface, community, score, accuracy, mean_conf, overconf, brier, type,
      nickname, public_token, completed_at, day, mode, challenge_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(b.anon_id, b.round_id, b.surface, communityOf(b), s.score, s.accuracy, s.mean_conf, s.overconfidence, s.brier, s.type,
        nickname, token, at, today, round.kind, b.challenge ?? null),
    // streak: yesterday's or the day before's (one missed day forgiven) + 1; a day that so far had only a daily-question
    // answer (rounds = 0) gets its streak now.
    db.prepare(`INSERT INTO player_days (anon_id, day, rounds, streak) VALUES (?1, ?2, 1,
      COALESCE((SELECT streak FROM player_days WHERE anon_id = ?1 AND day IN (?3, ?4) AND rounds > 0 ORDER BY day DESC LIMIT 1), 0) + 1)
      ON CONFLICT (anon_id, day) DO UPDATE SET streak = CASE WHEN rounds = 0 THEN excluded.streak ELSE streak END, rounds = rounds + 1`)
      .bind(b.anon_id, today, addDays(today, -1), addDays(today, -2)),
    db.prepare('SELECT streak FROM player_days WHERE anon_id = ? AND day = ?').bind(b.anon_id, today),
  ];
  if (aggregated) {
    const path = `$[${idx}]`;
    const fresh = JSON.stringify(Array.from({ length: HIST_BUCKETS }, (_, k) => (k === idx ? 1 : 0)));
    stmts.push(
      db.prepare(`INSERT INTO round_agg (date, surface, players, score_hist, sum_overconf, calib) VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT (date, surface) DO UPDATE SET players = players + 1,
        score_hist = json_set(score_hist, ?, json_extract(score_hist, ?) + 1), sum_overconf = sum_overconf + excluded.sum_overconf,
        calib = json_set(calib, ${CALIB_ADD})`)
        .bind(round.date, b.surface, fresh, s.exact_overconf, JSON.stringify(calibOf(live.map((id) => byItem.get(id)))), path, path),
      db.prepare(AGG_SQL).bind(round.date),
    );
  }
  if (dare) stmts.push(rankDare()); // after the insert, so the count includes this play
  try {
    const out = await db.batch(stmts);
    return respond(token, out[2].results[0].streak, aggregated ? out[4].results : null, dare ? out[3].results[0] : null);
  } catch (e) {
    const raced = await replay(); // a concurrent complete won (the batch rolled back, nothing counted twice)
    if (!raced) throw e;
    return raced;
  }
}

// --- GET /api/round/:round_id/compare -----------------------------------------------------------------------------

const publicScores = (s, nickname) => ({ nickname: nickname ?? null, score: s.score, accuracy: s.accuracy, mean_conf: s.mean_conf, overconfidence: s.overconfidence, type: s.type });

// Both players rescored over the round's live pairs, so a pair retired in between counts for neither.
export async function compare(db, data, roundId, me, them, now) {
  if (parseRoundId(roundId) === null || parseRoundId(roundId).kind === 'question') return err(400, 'bad round_id');
  if (typeof them !== 'string' || !TOKEN_RE.test(them)) return err(400, 'bad them');
  if (me != null && !(typeof me === 'string' && ANON_RE.test(me))) return err(400, 'bad me');
  const round = await resolveRound(db, data, roundId, now);
  if (round.error) return round.error;
  const ANS = 'SELECT a.item_id, a.choice, a.conf, a.correct, a.points FROM round_answers a';
  const [themPlay, themAnswers, mePlay, meAnswers, ...deadRows] = await db.batch([
    db.prepare('SELECT anon_id, round_id, nickname FROM round_plays WHERE public_token = ?').bind(them),
    db.prepare(`${ANS} JOIN round_plays p ON p.anon_id = a.anon_id AND p.round_id = a.round_id WHERE p.public_token = ? AND a.round_id = ?`).bind(them, roundId),
    db.prepare('SELECT nickname, public_token FROM round_plays WHERE anon_id = ? AND round_id = ?').bind(me ?? '', roundId),
    db.prepare(`${ANS} WHERE a.anon_id = ? AND a.round_id = ?`).bind(me ?? '', roundId),
    ...deadStatements(db, data, round.ids),
  ]);
  const t = themPlay.results[0];
  if (!t || t.round_id !== roundId) return err(404, 'no such challenge for this round');
  const dead = deadFrom(data, round.ids, deadRows);
  const live = round.ids.filter((id) => !dead.has(id));
  const rescore = (rows) => {
    const by = new Map(rows.map((a) => [a.item_id, a]));
    const answered = live.filter((id) => by.has(id)).map((id) => by.get(id));
    return answered.length ? scoreRound(answered) : null;
  };
  const meScores = mePlay.results[0] ? rescore(meAnswers.results) : null;
  const themScores = rescore(themAnswers.results);
  if (!themScores) return err(404, 'no live questions in this challenge');
  const body = { me: meScores ? publicScores(meScores, mePlay.results[0].nickname) : null, them: publicScores(themScores, t.nickname), own: me === t.anon_id };
  if (meScores) body.my_token = mePlay.results[0].public_token;
  if (body.own) {
    // Only the owner sees replies to their link. Each link exposes a score, never an anonymous player ID.
    const replies = await db.prepare(`SELECT public_token, nickname FROM round_plays
      WHERE round_id = ? AND challenge_of = ? AND anon_id != ? ORDER BY completed_at DESC LIMIT 20`)
      .bind(roundId, them, me).all();
    body.replies = replies.results;
  } else if (meScores) {
    // The record uses scores at completion, like a match result. Current-round comparison is rescored above.
    // Indexed by each player's anonymous ID; no visitor-wide scan and no extra stored profile.
    body.record = await db.prepare(`SELECT COUNT(*) AS played,
      COALESCE(SUM(a.score > b.score), 0) AS wins, COALESCE(SUM(a.score < b.score), 0) AS losses,
      COALESCE(SUM(a.score = b.score), 0) AS ties
      FROM round_plays a JOIN round_plays b ON b.anon_id = ? AND b.round_id = a.round_id
      WHERE a.anon_id = ? AND (a.challenge_of = b.public_token OR b.challenge_of = a.public_token)`)
      .bind(t.anon_id, me).first();
  }
  return ok(body);
}

// --- GET /api/round/stats -----------------------------------------------------------------------------------------

// Bins of BIN_WIDTH points from HIST_MIN (the last bin holds 1000 only).
export function binHist(hist) {
  const per = BIN_WIDTH / 4;
  return Array.from({ length: Math.ceil(HIST_BUCKETS / per) }, (_, k) => hist.slice(k * per, (k + 1) * per).reduce((s, c) => s + c, 0));
}

export function sumAgg(rows) {
  const hist = Array(HIST_BUCKETS).fill(0);
  let players = 0;
  let overconf = 0;
  for (const r of rows) {
    players += r.players;
    overconf += r.sum_overconf;
    JSON.parse(r.score_hist).forEach((c, k) => { hist[k] += c; });
  }
  return { players, hist, mean_overconfidence: players ? r1(overconf / players) : null };
}

const statsBody = (date, rows) => {
  const s = sumAgg(rows);
  return { date, players: s.players, score_hist: binHist(s.hist), bin_from: HIST_MIN, bin_width: BIN_WIDTH, mean_overconfidence: s.mean_overconfidence };
};

// One pair's costliest miss at 90% or surer, the most recent on a tie. The literal 90 (not a bound parameter) lets SQLite
// use the partial index of migration 0007, so each lookup reads one entry. No player id is read.
const BLUFF_SQL = `SELECT item_id, choice, conf, points, answered_at FROM round_answers
  WHERE round_id = ? AND item_id = ? AND correct = 0 AND conf >= 90 ORDER BY points, answered_at DESC LIMIT 1`;
// All-time totals for /status: completed rounds on every surface plus the chat apps' daily-question answers, and the
// distinct anonymous ids behind them. ponytail: two full scans, cached 60 s with the rest; a running counter if they slow.
const ALLTIME_SQL = `SELECT (SELECT COUNT(*) FROM round_plays) + (SELECT COUNT(*) FROM round_answers WHERE round_id LIKE 'dq-%') AS played,
  (SELECT COUNT(*) FROM (SELECT anon_id FROM round_plays UNION SELECT anon_id FROM round_answers WHERE round_id LIKE 'dq-%')) AS players`;

// calibration: [{conf, n, right}] for 50, 60 ... 100% over the day's plays (round_agg). bluffs: up to MAX_BLUFFS of the
// day's live pairs, costliest miss first (the most recent on a tie), each {prompt, pick, conf, points}; [] until
// MIN_BLUFF_PLAYERS have finished the round.
export async function roundStats(db, data, dateParam, now) {
  const date = dateParam || todayUTC(now);
  if (!isDate(date)) return err(400, 'date must be YYYY-MM-DD');
  if (date > todayUTC(now) || !data.rounds[date]) return err(404, 'no ranked round for that date');
  const ids = data.rounds[date].ranked;
  const [agg, totals, pairRows, itemRows, ...misses] = await db.batch([
    db.prepare(AGG_SQL).bind(date),
    db.prepare(ALLTIME_SQL),
    ...deadStatements(db, data, ids),
    ...ids.map((id) => db.prepare(BLUFF_SQL).bind(`rk-${date}`, id)),
  ]);
  const body = statsBody(date, agg.results);
  body.total_played = totals.results[0]?.played ?? 0;
  body.total_players = totals.results[0]?.players ?? 0;
  const calib = agg.results.reduce((sum, r) => JSON.parse(r.calib).map((c, k) => sum[k] + c), Array(2 * CONFS.length).fill(0));
  body.calibration = CONFS.map((conf, k) => ({ conf, n: calib[2 * k], right: calib[2 * k + 1] }));
  const dead = deadFrom(data, ids, [pairRows, itemRows]);
  const worst = misses.flatMap((m) => m.results).filter((m) => !dead.has(m.item_id))
    .sort((x, y) => x.points - y.points || (x.answered_at < y.answered_at) - (x.answered_at > y.answered_at)); // then the most recent
  body.bluffs = body.players < MIN_BLUFF_PLAYERS ? [] : worst.slice(0, MAX_BLUFFS).map((m) => {
    const p = data.pairs.get(m.item_id);
    return { prompt: pairView(data, p.id).prompt, pick: data.items.get(m.choice ? p.b_id : p.a_id).name, conf: m.conf, points: m.points };
  });
  return ok(body);
}

// --- daily question and reveal (Slack, Discord) ---------------------------------------------------------------------

export function dailyQuestion(data, dateParam, now) {
  const today = todayUTC(now);
  const date = dateParam || today;
  if (!isDate(date)) return err(400, 'date must be YYYY-MM-DD');
  const q = date >= openFrom(today) && date <= today && data.rounds[date]?.question;
  if (!q) return err(404, 'no daily question for that date (today or yesterday only)');
  const { prompt, a, b } = pairView(data, q);
  return ok({ round_id: `dq-${date}`, item_id: q, prompt, a, b });
}

// Settles the community's pending answers, then counts them. While the question is open (today or yesterday) the reveal
// needs the bot header; earlier days are public. biggest_bluff = the most confident wrong answer (earliest on a tie).
export async function reveal(db, data, params, now, isBot) {
  const today = todayUTC(now);
  const date = params.date || today;
  if (!isDate(date)) return err(400, 'date must be YYYY-MM-DD');
  if (typeof params.community !== 'string' || !COMMUNITY_RE.test(params.community)) return err(400, 'community is required (slack:…, discord:… or room:…)');
  const q = date <= today && data.rounds[date]?.question;
  if (!q) return err(404, 'no daily question for that date');
  if (date >= openFrom(today) && !isBot) return err(403, 'the question still takes answers: its reveal needs the bot header');
  const p = data.pairs.get(q);
  const roundId = `dq-${date}`;
  const [, counts, bluff] = await db.batch([
    db.prepare(`${SETTLE_SQL} AND community = ?3`).bind(p.truth, roundId, params.community),
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(choice = 0), 0) AS a FROM round_answers WHERE round_id = ? AND community = ?').bind(roundId, params.community),
    db.prepare(`SELECT anon_id, conf, choice FROM round_answers WHERE round_id = ? AND community = ? AND correct = 0
      ORDER BY conf DESC, answered_at LIMIT 1`).bind(roundId, params.community),
  ]);
  const { n, a } = counts.results[0];
  const pctA = n ? Math.round((100 * a) / n) : 0;
  return ok({ n, pct_a: pctA, pct_b: n ? 100 - pctA : 0, correct: p.truth, ...truthView(data, p), biggest_bluff: bluff.results[0] ?? null });
}

// --- POST /api/event ----------------------------------------------------------------------------------------------

export async function recordEvent(db, b, now) {
  if (!isObject(b) || !EVENT_TYPES.includes(b.type)) return err(400, 'type must be share, challenge_view or play_again');
  if (b.anon_id != null && !(typeof b.anon_id === 'string' && ANON_RE.test(b.anon_id))) return err(400, 'bad anon_id');
  if (b.round_id != null && parseRoundId(b.round_id) === null) return err(400, 'bad round_id');
  await countEvent(db, b.type, now);
  return ok({ ok: true });
}

// One anonymous counter per day and type; ids are never stored.
export const countEvent = (db, type, now) => db.prepare('INSERT INTO events (day, type, n) VALUES (?, ?, 1) ON CONFLICT (day, type) DO UPDATE SET n = n + 1')
  .bind(todayUTC(now), type).run();

// --- POST /api/flag with a pair id ----------------------------------------------------------------------------------

// Only someone who answered the pair in that round can flag it. The third distinct flag retires the pair and both its
// values (any pair sharing a retired value retires too), then recomputes every ranked day up to today that used
// one of them.
export async function flagPair(db, data, b, now) {
  if (!isObject(b) || typeof b.anon_id !== 'string' || !ANON_RE.test(b.anon_id)) return err(400, 'bad anon_id');
  if (parseRoundId(b.round_id) === null) return err(400, 'round_id is required to flag a pair');
  if (b.reason != null && !(typeof b.reason === 'string' && b.reason.length <= MAX_REASON)) return err(400, `reason must be text of at most ${MAX_REASON} characters`);
  const p = data.pairs.get(b.item_id);
  if (!p) return err(404, 'unknown item');
  const answered = await db.prepare('SELECT 1 FROM round_answers WHERE anon_id = ? AND round_id = ? AND item_id = ?').bind(b.anon_id, b.round_id, p.id).first();
  if (!answered) return err(403, 'answer this question before flagging it');
  const [, count, runtime] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO item_flags (item_id, anon_id, reason, created_at) VALUES (?, ?, ?, ?)')
      .bind(p.id, b.anon_id, b.reason?.trim() || null, now.toISOString()),
    db.prepare('SELECT COUNT(*) AS n FROM item_flags WHERE item_id = ?').bind(p.id),
    db.prepare('SELECT retired_at FROM pair_runtime WHERE pair_id = ?').bind(p.id),
  ]);
  if (count.results[0].n >= RETIRE_FLAGS && !runtime.results[0]?.retired_at) await retirePair(db, data, p, now);
  return ok({ ok: true });
}

async function retirePair(db, data, p, now) {
  const at = now.toISOString();
  const retireItem = (id) => db.prepare(`INSERT INTO items_runtime (item_id, retired_at) VALUES (?, ?)
    ON CONFLICT (item_id) DO UPDATE SET retired_at = COALESCE(retired_at, excluded.retired_at)`).bind(id, at);
  await db.batch([
    db.prepare(`INSERT INTO pair_runtime (pair_id, retired_at) VALUES (?, ?)
      ON CONFLICT (pair_id) DO UPDATE SET retired_at = COALESCE(retired_at, excluded.retired_at)`).bind(p.id, at),
    retireItem(p.a_id),
    retireItem(p.b_id),
  ]);
  const today = todayUTC(now);
  const dates = new Set([...(data.rankedDatesByItem.get(p.a_id) ?? []), ...(data.rankedDatesByItem.get(p.b_id) ?? [])]);
  for (const date of [...dates].filter((d) => d <= today).sort()) await recomputeRanked(db, data, date);
}

// Rebuilds a ranked day's round_agg rows from its plays' answers over the live pairs, in SQL (the one scan outside the
// KPI job). ponytail: a complete that commits between the read and the write here is lost from the day's histogram
// until the next recompute; rerunning this fixes it.
export async function recomputeRanked(db, data, date) {
  const live = await liveIds(db, data, data.rounds[date].ranked);
  const roundId = `rk-${date}`;
  const binds = [roundId, date, addDays(date, 1), ...live];
  const PLAYS = `FROM round_plays p JOIN round_answers a ON a.anon_id = p.anon_id AND a.round_id = p.round_id
      WHERE p.round_id = ? AND p.day IN (?, ?) AND a.item_id IN (${qs(live.length)})`;
  const [rows, confRows] = live.length ? (await db.batch([
    db.prepare(`SELECT surface, score, COUNT(*) AS n, SUM(oc) AS soc FROM (
      SELECT p.surface AS surface, SUM(a.points) AS score, AVG(a.conf) - 100.0 * AVG(a.correct) AS oc ${PLAYS} GROUP BY p.anon_id)
    GROUP BY surface, score`).bind(...binds),
    db.prepare(`SELECT p.surface AS surface, a.conf AS conf, COUNT(*) AS n, SUM(a.correct) AS r ${PLAYS} GROUP BY p.surface, a.conf`).bind(...binds),
  ])).map((r) => r.results) : [[], []];
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.surface) ?? { players: 0, hist: Array(HIST_BUCKETS).fill(0), overconf: 0, calib: Array(2 * CONFS.length).fill(0) };
    s.players += r.n;
    s.hist[histIndex(r.score)] += r.n;
    s.overconf += r.soc;
    by.set(r.surface, s);
  }
  for (const r of confRows) {
    const k = 2 * CONFS.indexOf(r.conf);
    by.get(r.surface).calib[k] += r.n;
    by.get(r.surface).calib[k + 1] += r.r;
  }
  await db.batch([
    db.prepare('DELETE FROM round_agg WHERE date = ?').bind(date),
    ...[...by].map(([surface, s]) => db.prepare('INSERT INTO round_agg (date, surface, players, score_hist, sum_overconf, calib) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(date, surface, s.players, JSON.stringify(s.hist), s.overconf, JSON.stringify(s.calib))),
  ]);
}
