// KPI job (research metric and engagement numbers), run once a day through POST /api/kpi/run.
// Historical research snapshots stay private. Product counts are defined separately below.
//   Plays: a completed round of 10 (ranked or quick; counted on the day it was completed), an answer to the Slack or
//        Discord daily question (on the question's day), a completed full assessment (on the day it was finished,
//        surface "classroom" when it carried a class code, else "web"; only sessions with an anonymous id count).
//        The retired daily range game (table plays) no longer counts: it is not a play.
//   MAU: anonymous ids with >= 1 play in the trailing 30 days, per surface, summed without cross-surface
//        deduplication. DAU likewise for one UTC day.
//   Communities: distinct community values (slack:…, discord:…, room:…) with >= 1 play in the trailing 30 days, per
//        platform, plus classrooms with >= 5 finished assessments.
//   Engagement (trailing 30 days): rounds per player per day = completed rounds / player-days with a completed round;
//        day-1 (day-7) return = share of players whose first play day is in the 30 days ending as_of - 1 (as_of - 7)
//        who played again exactly 1 (7) days later; challenge conversion = completed challenge rounds / challenge
//        views; share rate = share events / completed rounds. null when the denominator is 0.
import { addDays } from './_daily.js';
import { headerMatches } from './_util.js';

const WINDOW_DAYS = 30;
const MIN_CLASS = 5;
export const KPI_SURFACES = ['web', 'slack', 'discord', 'room', 'classroom'];
const PLATFORMS = { slack: 'workspaces', discord: 'guilds', room: 'rooms' };

// ?1 = as_of, ?2 = window start
const ACTIVE_SQL = `SELECT surface, COUNT(DISTINCT anon_id) AS mau, COUNT(DISTINCT CASE WHEN d = ?1 THEN anon_id END) AS dau FROM (
  SELECT anon_id, surface, day AS d FROM round_plays WHERE day BETWEEN ?2 AND ?1
  UNION ALL SELECT anon_id, surface, substr(round_id, 4) FROM round_answers WHERE round_id BETWEEN 'dq-' || ?2 AND 'dq-' || ?1
  UNION ALL SELECT anon_id, CASE WHEN class_code IS NULL THEN 'web' ELSE 'classroom' END, substr(created_at, 1, 10)
    FROM sessions WHERE anon_id IS NOT NULL AND substr(created_at, 1, 10) BETWEEN ?2 AND ?1
) GROUP BY surface`;
const COMMUNITIES_SQL = `SELECT substr(c, 1, instr(c, ':') - 1) AS platform, COUNT(DISTINCT c) AS n FROM (
  SELECT community AS c FROM round_plays WHERE community IS NOT NULL AND day BETWEEN ?2 AND ?1
  UNION ALL SELECT community FROM round_answers WHERE community IS NOT NULL AND round_id BETWEEN 'dq-' || ?2 AND 'dq-' || ?1
) GROUP BY platform`;
const CLASSROOMS_SQL = `SELECT COUNT(*) AS n FROM (SELECT class_code FROM sessions
  WHERE class_code IS NOT NULL AND substr(created_at, 1, 10) <= ? GROUP BY class_code HAVING COUNT(*) >= ${MIN_CLASS})`;
const ROUNDS_SQL = `SELECT COALESCE(SUM(rounds), 0) AS rounds, COUNT(*) AS player_days FROM player_days
  WHERE rounds > 0 AND day BETWEEN ?2 AND ?1`;
// ?1..?2 = day-1 cohort window, ?3..?4 = day-7 cohort window
const RETURN_SQL = `WITH days AS (SELECT anon_id, day FROM player_days
    UNION SELECT anon_id, substr(created_at, 1, 10) FROM sessions WHERE anon_id IS NOT NULL),
  first AS (SELECT anon_id, MIN(day) AS f FROM days GROUP BY anon_id)
  SELECT COALESCE(SUM(f BETWEEN ?1 AND ?2), 0) AS c1,
    COALESCE(SUM(f BETWEEN ?1 AND ?2 AND EXISTS (SELECT 1 FROM days x WHERE x.anon_id = first.anon_id AND x.day = date(first.f, '+1 day'))), 0) AS r1,
    COALESCE(SUM(f BETWEEN ?3 AND ?4), 0) AS c7,
    COALESCE(SUM(f BETWEEN ?3 AND ?4 AND EXISTS (SELECT 1 FROM days x WHERE x.anon_id = first.anon_id AND x.day = date(first.f, '+7 day'))), 0) AS r7
  FROM first`;
const EVENTS_SQL = `SELECT COALESCE(SUM(CASE WHEN type = 'share' THEN n END), 0) AS shares,
  COALESCE(SUM(CASE WHEN type = 'challenge_view' THEN n END), 0) AS views FROM events WHERE day BETWEEN ?2 AND ?1`;
const PLAYS_SQL = 'SELECT COUNT(*) AS rounds, COUNT(challenge_of) AS challenge_rounds FROM round_plays WHERE day BETWEEN ?2 AND ?1';

const rate = (num, den, digits = 4) => (den ? Math.round((num / den) * 10 ** digits) / 10 ** digits : null);

export async function computeKpi(db, asOf) {
  const start = addDays(asOf, 1 - WINDOW_DAYS);
  const [active, communities, classrooms, rounds, ret, events, plays] = await db.batch([
    db.prepare(ACTIVE_SQL).bind(asOf, start),
    db.prepare(COMMUNITIES_SQL).bind(asOf, start),
    db.prepare(CLASSROOMS_SQL).bind(asOf),
    db.prepare(ROUNDS_SQL).bind(asOf, start),
    db.prepare(RETURN_SQL).bind(addDays(asOf, -WINDOW_DAYS), addDays(asOf, -1), addDays(asOf, -WINDOW_DAYS - 6), addDays(asOf, -7)),
    db.prepare(EVENTS_SQL).bind(asOf, start),
    db.prepare(PLAYS_SQL).bind(asOf, start),
  ]);
  const by = Object.fromEntries(KPI_SURFACES.map((s) => [s, active.results.find((r) => r.surface === s) ?? { mau: 0, dau: 0 }]));
  const total = (k) => KPI_SURFACES.reduce((sum, s) => sum + by[s][k], 0);
  const per = Object.fromEntries(Object.values(PLATFORMS).map((k) => [k, 0]));
  for (const r of communities.results) if (PLATFORMS[r.platform]) per[PLATFORMS[r.platform]] = r.n;
  const r = rounds.results[0];
  const t = ret.results[0];
  const e = events.results[0];
  const p = plays.results[0];
  return {
    as_of: asOf,
    mau: total('mau'),
    dau: total('dau'),
    mau_web: by.web.mau,
    mau_slack: by.slack.mau,
    mau_discord: by.discord.mau,
    mau_room: by.room.mau,
    mau_classroom: by.classroom.mau,
    workspaces: per.workspaces,
    guilds: per.guilds,
    rooms: per.rooms,
    classrooms: classrooms.results[0].n,
    rounds_per_player_day: rate(r.rounds, r.player_days, 2),
    d1_return: rate(t.r1, t.c1),
    d7_return: rate(t.r7, t.c7),
    challenge_conversion: rate(p.challenge_rounds, e.views),
    share_rate: rate(e.shares, p.rounds),
  };
}

const COLUMNS = ['as_of', 'mau', 'dau', 'mau_web', 'mau_slack', 'mau_discord', 'mau_room', 'mau_classroom', 'workspaces', 'guilds',
  'rooms', 'classrooms', 'rounds_per_player_day', 'd1_return', 'd7_return', 'challenge_conversion', 'share_rate', 'computed_at'];

// Computes and stores the KPIs for as_of (re-running a day overwrites its row).
export async function runKpi(db, asOf, now) {
  const row = { ...(await computeKpi(db, asOf)), computed_at: now.toISOString() };
  await db.prepare(`INSERT INTO kpi (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (as_of) DO UPDATE SET ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`)
    .bind(...COLUMNS.map((c) => row[c])).run();
  return row;
}

// GET /api/kpi shape; zeros (rates null) and as_of null before the first run.
export const publicKpi = (r) => ({
  as_of: r?.as_of ?? null,
  mau: r?.mau ?? 0,
  dau: r?.dau ?? 0,
  mau_by_surface: { web: r?.mau_web ?? 0, slack: r?.mau_slack ?? 0, discord: r?.mau_discord ?? 0, room: r?.mau_room ?? 0, classroom: r?.mau_classroom ?? 0 },
  communities: { workspaces: r?.workspaces ?? 0, guilds: r?.guilds ?? 0, rooms: r?.rooms ?? 0, classrooms: r?.classrooms ?? 0 },
  rounds_per_player_day: r?.rounds_per_player_day ?? null,
  d1_return: r?.d1_return ?? null,
  d7_return: r?.d7_return ?? null,
  challenge_conversion: r?.challenge_conversion ?? null,
  share_rate: r?.share_rate ?? null,
});

export const latestKpi = async (db) => publicKpi(await db.prepare('SELECT * FROM kpi ORDER BY as_of DESC LIMIT 1').first());

// The x-kpi-key header must match env.KPI_KEY. No key configured -> nobody is authorized (fail closed).
export const authorized = (request, env) => headerMatches(request, 'x-kpi-key', env.KPI_KEY);

// Product counts use one identity definition on every surface. Separate anonymous IDs cannot be linked to a person.
// A play is a completed round/assessment or a bot daily answer; opening a page or starting a round does not count.
const PLAYER_DAYS = `SELECT anon_id, day FROM round_plays
  UNION SELECT anon_id, substr(answered_at, 1, 10) FROM round_answers WHERE round_id LIKE 'dq-%'
  UNION SELECT anon_id, substr(created_at, 1, 10) FROM sessions WHERE anon_id IS NOT NULL`;
export const PLAYER_COUNTS_SQL = `WITH activity AS (${PLAYER_DAYS})
  SELECT COUNT(DISTINCT anon_id) AS total_players,
    COUNT(DISTINCT CASE WHEN day = ?1 THEN anon_id END) AS dau,
    COUNT(DISTINCT CASE WHEN day >= ?2 THEN anon_id END) AS mau,
    COUNT(DISTINCT CASE WHEN day >= ?3 THEN anon_id END) AS yau
  FROM activity WHERE day <= ?1`;

// ponytail: scans play history for the small current audience; materialize counts when query cost becomes material.
export async function playerCounts(db, asOf) {
  return { as_of: asOf, ...(await db.prepare(PLAYER_COUNTS_SQL).bind(asOf, addDays(asOf, -29), addDays(asOf, -364)).first()) };
}

export async function totalPlayers(db, asOf) {
  return (await db.prepare(`WITH activity AS (${PLAYER_DAYS})
    SELECT COUNT(DISTINCT anon_id) AS total_players FROM activity WHERE day <= ?`).bind(asOf).first()).total_players;
}
