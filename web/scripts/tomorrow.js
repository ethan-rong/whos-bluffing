// npm run tomorrow [-- YYYY-MM-DD]: prints tomorrow's (UTC) ranked round, the ten pairs with both values and both
// sources, plus the day's Slack/Discord question, for the nightly review. To swap a pair, replace its id in
// daily/rounds.json (one line per day) with another referenced pair from items/pairs.json, then npm run sync-items
// (it checks that ranked rounds use only referenced or fact-checked items) and deploy. review() prints the retired daily range game's five items (kept for its data).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays, dayNumber, todayUTC, isDate } from '../functions/_daily.js';
import { fmtValue as fmt } from '../public/ui.js'; // years as "2560 BC", months as "Nov 2022", "$157 billion", "175 billion parameters"


// The daily range game's review for one date (throws if nothing is scheduled).
export function review(pool, schedule, date) {
  const ids = schedule[date];
  if (!ids) throw new Error(`nothing scheduled for ${date}: run npm run schedule`);
  const items = new Map(pool.map((i) => [i.id, i]));
  const lines = [`Who's Bluffing? #${dayNumber(date)} · ${date} (UTC)`, ''];
  ids.forEach((id, k) => {
    const it = items.get(id);
    if (!it) throw new Error(`${id} (${date}) is not in items/pool.json`);
    lines.push(`${k + 1}. ${id} [${it.category}] ${it.en.prompt}`, `   answer: ${fmt(it.answer, it.en.unit)}`, `   source: ${it.source}`, '');
  });
  lines.push('Swap an item: replace its id in daily/schedule.json, then npm run sync-items and deploy.');
  return lines.join('\n');
}

// The ranked round and chat question for one date: each pair's prompt, both items with value and source, the answer.
export function reviewRounds(pool, pairs, rounds, date) {
  const day = rounds[date];
  if (!day) throw new Error(`no ranked round for ${date}: run python3 analysis/items_pipeline/pairs.py`);
  const items = new Map(pool.map((i) => [i.id, i]));
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const pair = (id, label) => {
    const p = byId.get(id);
    if (!p) throw new Error(`${id} (${date}) is not in items/pairs.json`);
    const [a, b] = [items.get(p.a_id), items.get(p.b_id)];
    if (!a || !b) throw new Error(`${id} (${date}) uses an item missing from items/pool.json`);
    return [`${label} ${id} [${p.category}, ${p.difficulty_hint}] ${p.prompt}`,
      `   A ${a.name}: ${fmt(a.answer, a.en.unit)} · ${a.source}`,
      `   B ${b.name}: ${fmt(b.answer, b.en.unit)} · ${b.source}`,
      `   answer: ${'AB'[p.truth]} (${p.truth === 0 ? a.name : b.name})`, ''];
  };
  return [`Who's Bluffing? ranked round · ${date} (UTC)`, '', ...day.ranked.flatMap((id, k) => pair(id, `${k + 1}.`)),
    'Slack and Discord question of the day:', ...pair(day.question, 'Q.'),
    'Swap a pair: replace its id in daily/rounds.json with another referenced pair, then npm run sync-items and deploy.'].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url);
  const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
  const date = process.argv[2] ?? addDays(todayUTC(), 1);
  try {
    if (!isDate(date)) throw new Error('date must be YYYY-MM-DD');
    console.log(reviewRounds(read('items/pool.json').items, read('items/pairs.json').pairs, read('daily/rounds.json'), date));
  } catch (e) {
    console.error(`tomorrow: ${e.message}`);
    process.exit(1);
  }
}
