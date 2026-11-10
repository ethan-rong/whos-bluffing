// Validates the item sources and writes the generated, git-ignored copies (never hand-edit them):
//   items/items.json    -> web/public/items.json, web/functions/_items.json   (full assessment, English only)
//   items/pool.json     -> web/public/pool.json (prompts only: no answers, no sources) and web/functions/_pool.json
//                          (only the fields the API reads)
//   daily/schedule.json -> web/functions/_schedule.json                         (daily range game)
//   items/pairs.json    -> web/functions/_pairs.json (compact: [n, a, b, truth, level, band, ref, tier] per pair) (rounds)
//   daily/rounds.json   -> web/functions/_rounds.json                           (ranked rounds, daily questions)
//   web/scripts/page.html -> web/functions/_page.json                          (template of the challenge page)
//   PRIVACY.md, TERMS.md, CHANGELOG.md, docs/api-*.md -> web/public/privacy.html, terms.html, changelog.html,
//                          docs/api.html (sync-docs.js)
//   the question count, pack chips, question list and command cards inside committed pages, press screenshots (sync-pages.js)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDate } from '../functions/_daily.js';
import { syncDocs } from './sync-docs.js';
import { syncPages } from './sync-pages.js';

const ROOT = new URL('../../', import.meta.url);
const TYPES = ['2afc', 'interval', 'attention'];
const DOMAINS = ['physics', 'biology', 'geography', 'history', 'math', 'everyday'];
const LEVELS = ['easy', 'medium', 'hard'];
const MIN = { '2afc': 12, interval: 6 }; // one session needs this many; attention needs exactly 2

const text = (x) => typeof x === 'string' && x.trim() !== '';

function itemErrors(it) {
  const errs = [];
  if (!/^[a-z][0-9]{3}$/.test(it.id ?? '')) errs.push('bad id');
  if (!TYPES.includes(it.type)) errs.push('bad type');
  if (!DOMAINS.includes(it.domain)) errs.push('bad domain');
  if (!LEVELS.includes(it.difficulty_hint)) errs.push('bad difficulty_hint');
  if (!text(it.source)) errs.push('missing source');
  const q = it.en ?? {};
  if (!text(q.prompt)) errs.push('missing en.prompt');
  if (it.type === 'interval' && !text(q.unit)) errs.push('missing en.unit');
  if (it.type !== 'interval' && !(Array.isArray(q.options) && q.options.length === 2 && q.options.every(text))) {
    errs.push('en.options must be two strings');
  }
  if (it.type === 'interval') {
    const [lo, hi] = Array.isArray(it.accept) ? it.accept : [];
    if (!Number.isFinite(it.answer)) errs.push('answer must be a number');
    else if (!(lo <= it.answer && it.answer <= hi)) errs.push('accept must be [low, high] around the answer');
  } else if (it.answer !== 0 && it.answer !== 1) {
    errs.push('answer must be 0 or 1');
  }
  return errs.map((e) => `${it.id ?? '?'}: ${e}`);
}

// Returns a list of problems; empty means the bank is usable by the web test.
export function validateBank(bank) {
  if (!Number.isInteger(bank?.version) || !Array.isArray(bank?.items)) return ['bank needs integer version and items array'];
  const errs = bank.items.flatMap(itemErrors);
  const ids = bank.items.map((i) => i.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) errs.push(`duplicate ids: ${dupes.join(', ')}`);
  const count = (t) => bank.items.filter((i) => i.type === t).length;
  for (const [t, n] of Object.entries(MIN)) if (count(t) < n) errs.push(`need at least ${n} ${t} items`);
  if (count('attention') !== 2) errs.push('need exactly 2 attention items');
  return errs;
}

// Authored quick questions are bundled server-side only. Once deployed, retire IDs instead of changing their answer.
export function validateCurated(bank) {
  if (!Number.isInteger(bank?.version) || !Array.isArray(bank?.items)) return ['bank needs integer version and items array'];
  const errs = [], ids = new Set(), prompts = new Set();
  for (const q of bank.items) {
    const e = (msg) => errs.push(`${q?.id ?? '?'}: ${msg}`);
    if (!q || typeof q !== 'object') { e('question must be an object'); continue; }
    if (!/^q\d{5}$/.test(q.id ?? '') || ids.has(q.id)) e('bad or duplicate id');
    ids.add(q.id);
    if (!['science', 'nature', 'world', 'culture', 'everyday', 'math', 'ai', 'memes', 'history', 'languages'].includes(q.topic)) e('bad topic');
    if (!['comparison', 'mechanism', 'origin', 'classification', 'probability', 'scenario', 'chronology', 'recognition', 'completion'].includes(q.family)) e('bad family');
    if (!LEVELS.includes(q.difficulty)) e('bad difficulty');
    if (['history', 'languages'].includes(q.topic)) {
      if (!text(q.subtopic) || !Array.isArray(q.subjects) || !q.subjects.length || !q.subjects.every(text)) e('need subtopic and subjects');
      if (q.topic === 'history' && (!['ancient', 'medieval', 'early-modern', 'modern'].includes(q.era) || !text(q.region))) e('need era and region');
    }
    if (!text(q.prompt) || q.prompt.length > 180 || prompts.has(q.prompt)) e('bad or duplicate prompt');
    prompts.add(q.prompt);
    if (!Array.isArray(q.options) || q.options.length !== 2 || !q.options.every((x) => text(x) && x.length <= 80)
      || q.options[0] === q.options[1]) e('need two distinct options of at most 80 characters');
    if (![0, 1].includes(q.answer)) e('answer must be 0 or 1');
    if (!text(q.explanation) || q.explanation.length > 300) e('need explanation of at most 300 characters');
    try { if (!text(q.source) || new URL(q.source).protocol !== 'https:' || /\s/.test(q.source)) throw Error(); }
    catch { e('source must be an https URL'); }
  }
  return errs;
}

const POOL_DOMAINS = new Set(DOMAINS);

// Problems with the daily pool (items/pool.json); empty means usable.
export function validatePool(pool) {
  if (!Array.isArray(pool?.items)) return ['pool needs an items array'];
  const errs = [];
  const ids = new Set();
  for (const it of pool.items) {
    const e = (msg) => errs.push(`${it.id ?? '?'}: ${msg}`);
    if (!/^w[0-9]{4}$/.test(it.id ?? '')) e('bad id');
    else if (ids.has(it.id)) e('duplicate id');
    ids.add(it.id);
    if (it.type !== 'interval') e('type must be interval');
    if (!text(it.category)) e('missing category');
    if (!POOL_DOMAINS.has(it.domain)) e('bad domain');
    if (!text(it.en?.prompt) || !text(it.en?.unit)) e('missing en.prompt or en.unit');
    const [lo, hi] = Array.isArray(it.accept) ? it.accept : [];
    if (!Number.isFinite(it.answer)) e('answer must be a number');
    else if (!(lo <= it.answer && it.answer <= hi)) e('accept must be [low, high] around the answer');
    if (!/^https:\/\/[^ ]+$/.test(it.source ?? '')) e('source must be an https URL (Wikidata statement link or an authoritative reference)');
  }
  return errs;
}

// Problems with daily/schedule.json against the pool's ids; empty means usable.
export function validateSchedule(schedule, ids) {
  const errs = [];
  for (const [date, day] of Object.entries(schedule)) {
    if (!isDate(date)) errs.push(`${date}: bad date`);
    if (!Array.isArray(day) || day.length !== 5 || new Set(day).size !== 5) errs.push(`${date}: needs 5 different item ids`);
    else for (const id of day) if (!ids.has(id)) errs.push(`${date}: ${id} is not in items/pool.json`);
  }
  return errs;
}

// The browser copy of the pool: prompts only. Answers and sources (a Wikidata link shows the answer) stay server-side.
export const publicPool = (pool) => ({
  version: pool.version, items: pool.items.map((i) => ({ id: i.id, category: i.category, prompt: i.en.prompt, unit: i.en.unit })),
});

// The API's copy of the pool: the fields functions/_daily.js and functions/_rounds.js read (keeps the bundle small), plus
// `fun`, an optional reveal line on some curated AI items (items/ai_curated.json). Never in publicPool: it is answer-free.
export const serverPool = (pool) => ({
  version: pool.version,
  items: pool.items.map(({ id, category, en, answer, accept, source, name, replaces, fun }) => ({ id, category, en, answer, accept, source, name, replaces, ...(fun ? { fun } : {}) })),
});

const LEVELS_R = ['easy', 'medium', 'hard'];
const num = (id) => Number(id.slice(1));
const rankedOk = (item) => item?.ref_quality === 'referenced' || item?.fact_checked === true; // ranked rounds: Wikidata reference or fact-check

// Problems with items/pairs.json against the pool; empty means usable.
export function validatePairs(doc, poolItems) {
  if (!Array.isArray(doc?.pairs) || !Array.isArray(doc?.templates)) return ['pairs.json needs templates and pairs arrays'];
  const items = new Map(poolItems.map((i) => [i.id, i]));
  const templates = new Set(doc.templates.map((t) => `${t.category}|${t.unit}`));
  const errs = [];
  const ids = new Set();
  for (const p of doc.pairs) {
    const e = (msg) => errs.push(`${p.id ?? '?'}: ${msg}`);
    if (!/^p\d{5}$/.test(p.id ?? '')) e('bad id');
    else if (ids.has(p.id)) e('duplicate id');
    ids.add(p.id);
    const [a, b] = [items.get(p.a_id), items.get(p.b_id)];
    if (!a || !b) { e('both items must be in items/pool.json'); continue; }
    if (p.a_id === p.b_id) e('an item cannot be compared with itself');
    if (!a.name || !b.name) e('both items need a name');
    if (a.category !== b.category || a.en.unit !== b.en.unit) e('items must share category and unit');
    if (!templates.has(`${a.category}|${a.en.unit}`)) e('no template for its category and unit');
    if (p.truth !== 0 && p.truth !== 1) e('truth must be 0 or 1');
    if (!LEVELS_R.includes(p.difficulty_hint)) e('bad difficulty_hint');
  }
  return errs;
}

// Problems with daily/rounds.json: its shape, and the rule that ranked rounds (and the chat question) use only
// items with a Wikidata reference or a fact-check. The scheduling heuristics (at most 2 per category, the 3/4/3 mix,
// reuse gaps, distinct entities) belong to pairs.py and scripts/check.sh, so a hand swap is not blocked by them.
export function validateRounds(rounds, pairsById, poolItems) {
  const items = new Map(poolItems.map((i) => [i.id, i]));
  const errs = [];
  for (const [date, day] of Object.entries(rounds)) {
    if (!isDate(date)) errs.push(`${date}: bad date`);
    const ranked = Array.isArray(day?.ranked) ? day.ranked : [];
    if (ranked.length !== 10 || new Set(ranked).size !== 10) errs.push(`${date}: needs 10 different ranked pair ids`);
    if (ranked.includes(day?.question)) errs.push(`${date}: the question must not be one of the ranked pairs`);
    for (const id of [...ranked, day?.question]) {
      const p = pairsById.get(id);
      if (!p) errs.push(`${date}: ${id} is not in items/pairs.json`);
      else if (!rankedOk(items.get(p.a_id)) || !rankedOk(items.get(p.b_id))) errs.push(`${date}: ${id} uses an item without a reference or fact-check`);
    }
  }
  return errs;
}

// band: 2 = both items famous (>= 50,000 monthly views), 1 = known (>= 20,000), 0 = obscure; ref: 1 = both referenced.
export const fameBand = (fame = 0) => (fame >= 50000 ? 2 : fame >= 20000 ? 1 : 0);
// tier: the AI pack's 1-3 (items/ai_curated.json; the higher of the pair's two items), 0 for everything else.
export const compactPairs = (doc) => ({
  templates: doc.templates,
  pairs: doc.pairs.map((p) => [num(p.id), num(p.a_id), num(p.b_id), p.truth, LEVELS_R.indexOf(p.difficulty_hint), fameBand(p.fame),
    p.ref_quality === 'referenced' ? 1 : 0, p.tier ?? 0]),
});

function readOptional(path, fallback) {
  if (existsSync(new URL(path, ROOT))) return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
  console.warn(`warning: ${path} not found; the daily game has no items until it exists (see web/README.md)`);
  return fallback;
}

function fail(file, errs) {
  console.error(`${file} is invalid:\n${errs.slice(0, 20).join('\n')}${errs.length > 20 ? `\n… and ${errs.length - 20} more` : ''}`);
  process.exit(1);
}

function main() {
  const bank = JSON.parse(readFileSync(new URL('items/items.json', ROOT), 'utf8'));
  const errs = validateBank(bank);
  if (errs.length) fail('items/items.json', errs);
  const curated = JSON.parse(readFileSync(new URL('items/quick_curated.json', ROOT), 'utf8'));
  const curatedErrs = validateCurated(curated);
  if (curatedErrs.length) fail('items/quick_curated.json', curatedErrs);
  const pool = readOptional('items/pool.json', { version: 1, items: [] });
  const poolErrs = validatePool(pool);
  if (poolErrs.length) fail('items/pool.json', poolErrs);
  const schedule = readOptional('daily/schedule.json', {});
  const scheduleErrs = validateSchedule(schedule, new Set(pool.items.map((i) => i.id)));
  if (scheduleErrs.length) fail('daily/schedule.json', scheduleErrs);
  const pairs = readOptional('items/pairs.json', { templates: [], pairs: [] });
  const pairErrs = validatePairs(pairs, pool.items);
  if (pairErrs.length) fail('items/pairs.json', pairErrs);
  const rounds = readOptional('daily/rounds.json', {});
  const roundErrs = validateRounds(rounds, new Map(pairs.pairs.map((p) => [p.id, p])), pool.items);
  if (roundErrs.length) fail('daily/rounds.json', roundErrs);

  // English only: the zh fields stay in items/items.json (repo checks read them) but are never shipped.
  const out = JSON.stringify({ ...bank, items: bank.items.map(({ zh, ...it }) => it) });
  for (const dest of ['web/public/items.json', 'web/functions/_items.json']) writeFileSync(new URL(dest, ROOT), out);
  writeFileSync(new URL('web/public/pool.json', ROOT), JSON.stringify(publicPool(pool)));
  const server = serverPool(pool);
  const compact = compactPairs(pairs);
  writeFileSync(new URL('web/functions/_pool.json', ROOT), JSON.stringify(server));
  writeFileSync(new URL('web/functions/_schedule.json', ROOT), JSON.stringify(schedule));
  writeFileSync(new URL('web/functions/_pairs.json', ROOT), JSON.stringify(compact));
  writeFileSync(new URL('web/functions/_rounds.json', ROOT), JSON.stringify(rounds));
  writeFileSync(new URL('web/functions/_page.json', ROOT), JSON.stringify({ html: readFileSync(new URL('web/scripts/page.html', ROOT), 'utf8') }));
  const n = (t) => bank.items.filter((i) => i.type === t).length;
  const days = Object.keys(schedule).sort();
  console.log(`synced items v${bank.version}: ${n('2afc')} two-alternative, ${n('interval')} interval, ${n('attention')} attention; `
    + `pool ${pool.items.length} items; schedule ${days.length} days${days.length ? ` (${days[0]} to ${days.at(-1)})` : ''}; `
    + `${pairs.pairs.length} pairs; ranked rounds ${Object.keys(rounds).length} days`);
  console.log(`synced docs: ${syncDocs().join(', ')}`);
  const pages = syncPages({ pool: server, compact, rounds, pairs, curated: curated.items });
  console.log(`synced pages: ${pages.files.join(', ')} (${pages.count.toLocaleString('en-US')} servable pairs)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
