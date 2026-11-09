// Self-reported boards (docs/api-rounds.md), one per pack that has one (public/packs.js BOARDS): after a quick round in
// the AI pack a player can say which lab they are with (POST /api/round/lab, GET /api/labs). (The Politics pack's
// party board, migration 0009, was removed; its rows stay in lab_claims and lab_agg with board 'parties'.) Self-reported and anonymous: one claim per round
// with its board, the play's day, the round's difficulty and the stored play's score and overconfidence (migrations
// 0008, 0009). Bounded: a claim reads the round and its play by key, then one batch writes the claim and two lab_agg rows
// and reads the board; the board sums lab_agg (at most 6 sides x 3 difficulties a day), never lab_claims.
import { ANON_RE, todayUTC, addDays } from './_daily.js';
import { parseRoundId } from './_rounds.js';
import { PACKS, BOARDS } from '../public/packs.js';

const MIN_PLAYERS = 10; // averages are shown from this many claims
const RANGES = { all: null, '30d': 30 }; // range -> trailing UTC days, today included (null = every day)
const ok = (body) => ({ status: 200, body });
const err = (status, error) => ({ status, body: { error } });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const r1 = (x) => Math.round(x * 10) / 10;
const or = (ids) => `${ids.slice(0, -1).join(', ')} or ${ids.at(-1)}`;
const badSide = (pack) => `${BOARDS[pack].key} must be ${or(Object.keys(BOARDS[pack].sides))}`;
const notInPack = (pack) => `only quick rounds in the ${PACKS[pack].label} pack can be claimed`;

// ponytail: sums every lab_agg row of the board in the range (up to 18 a day); add an all-time totals row if the days
// pile up.
const BOARD_SQL = `SELECT lab, SUM(players) AS players, SUM(sum_score) AS sum_score, SUM(sum_overconf) AS sum_overconf
  FROM lab_agg WHERE board = ? AND date >= ? GROUP BY lab`;

// A claim is one batch, so lab_agg always equals the sums over lab_claims: UNCLAIM takes the stored claim (if any) off
// its row, ADD puts the new one on its row, CLAIM stores it. A moved claim leaves the old side's row and joins the new
// one; the same side again nets out. A round belongs to one pack, so its claim never changes board.
const UNCLAIM_SQL = `UPDATE lab_agg SET players = players - 1, sum_score = sum_score - c.score, sum_overconf = sum_overconf - c.overconfidence
  FROM lab_claims c WHERE c.round_id = ? AND lab_agg.lab = c.lab AND lab_agg.date = c.date AND lab_agg.difficulty = c.difficulty`;
const ADD_SQL = `INSERT INTO lab_agg (board, lab, date, difficulty, players, sum_score, sum_overconf) VALUES (?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT (lab, date, difficulty) DO UPDATE SET players = players + 1,
  sum_score = sum_score + excluded.sum_score, sum_overconf = sum_overconf + excluded.sum_overconf`;
const CLAIM_SQL = `INSERT INTO lab_claims (round_id, board, lab, date, difficulty, score, overconfidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (round_id) DO UPDATE SET lab = excluded.lab, date = excluded.date, difficulty = excluded.difficulty,
  score = excluded.score, overconfidence = excluded.overconfidence`;

// The rounds table does not keep the pack, so a round is in a pack when every pair comes from its categories.
const inPack = (data, ids, pack) => ids.length > 0
  && ids.every((id) => PACKS[pack].categories.includes(data.items.get(data.pairs.get(id)?.a_id)?.category));

// rows: [{lab, players, sum_score, sum_overconf}] summed over the range (`lab` holds the side). Every side of the pack's
// board, means only from MIN_PLAYERS; those first by average score, then the rest by players (ties keep the list order).
export function boardBody(pack, rows, range, now) {
  const { key, list, sides } = BOARDS[pack];
  const by = new Map(rows.map((r) => [r.lab, r]));
  const entries = Object.entries(sides).map(([id, name]) => {
    const r = by.get(id);
    const players = r?.players ?? 0;
    const shown = players >= MIN_PLAYERS;
    return { [key]: id, name, players, mean_score: shown ? r1(r.sum_score / players) : null, mean_overconfidence: shown ? r1(r.sum_overconf / players) : null };
  });
  const ranked = entries.filter((e) => e.mean_score !== null).sort((x, y) => y.mean_score - x.mean_score);
  const rest = entries.filter((e) => e.mean_score === null).sort((x, y) => y.players - x.players);
  return { as_of: now.toISOString(), range, min_players: MIN_PLAYERS, [list]: [...ranked, ...rest] };
}

const fromDate = (range, now) => (RANGES[range] ? addDays(todayUTC(now), 1 - RANGES[range]) : '');

// GET /api/labs?range=all|30d
export async function sideBoard(db, pack, range, now) {
  if (!Object.hasOwn(RANGES, range)) return err(400, 'range must be all or 30d');
  const { results } = await db.prepare(BOARD_SQL).bind(BOARDS[pack].list, fromDate(range, now)).all();
  return ok(boardBody(pack, results, range, now));
}

function claimBodyError(pack, b) {
  if (!isObject(b)) return err(400, 'body must be a JSON object');
  if (typeof b.anon_id !== 'string' || !ANON_RE.test(b.anon_id)) return err(400, 'bad anon_id');
  const r = parseRoundId(b.round_id);
  if (r === null) return err(400, 'bad round_id');
  if (r.kind !== 'quick') return err(400, notInPack(pack));
  const side = b[BOARDS[pack].key];
  if (typeof side !== 'string' || !Object.hasOwn(BOARDS[pack].sides, side)) return err(400, badSide(pack));
  return null;
}

// POST /api/round/lab {round_id, anon_id, lab} -> {ok, lab, board}: the board fresh, with this claim (range all).
export async function claimSide(db, data, pack, b, now) {
  const bad = claimBodyError(pack, b);
  if (bad) return bad;
  const { key, list } = BOARDS[pack];
  const [round, play] = await db.batch([
    db.prepare('SELECT items, difficulty FROM rounds WHERE round_id = ?').bind(b.round_id),
    db.prepare('SELECT score, overconf, day FROM round_plays WHERE anon_id = ? AND round_id = ?').bind(b.anon_id, b.round_id),
  ]);
  const r = round.results[0];
  if (!r) return err(404, 'unknown round');
  if (!inPack(data, JSON.parse(r.items), pack)) return err(400, notInPack(pack));
  const p = play.results[0];
  if (!p) return err(404, 'finish this round first');
  const claimed = [b[key], p.day, r.difficulty ?? 'normal', p.score, p.overconf]; // pre-0006 quick rounds were all normal
  const out = await db.batch([
    db.prepare(UNCLAIM_SQL).bind(b.round_id),
    db.prepare(ADD_SQL).bind(list, ...claimed),
    db.prepare(CLAIM_SQL).bind(b.round_id, list, ...claimed, now.toISOString()),
    db.prepare(BOARD_SQL).bind(list, ''),
  ]);
  return ok({ ok: true, [key]: b[key], board: boardBody(pack, out.at(-1).results, 'all', now) });
}
