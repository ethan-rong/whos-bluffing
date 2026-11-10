import { json, fail, safe } from '../../_util.js';
import { authorized, runKpi, playerCounts } from '../../_kpi.js';
import { isDate, todayUTC } from '../../_daily.js';
import { settleQuestions } from '../../_rounds.js';
import { ROUNDS } from '../../_rounds_data.js';

// POST /api/kpi/run[?as_of=YYYY-MM-DD], header x-kpi-key. as_of defaults to today (UTC); the cron Worker in
// web/kpi-worker/ sends yesterday so each stored row covers a whole day. First settles the points of daily-question
// answers that no longer take changes (communities that never asked for a reveal).
export const onRequestPost = safe(async ({ request, env }) => {
  if (!(await authorized(request, env))) return fail(401, 'unauthorized');
  const asOf = new URL(request.url).searchParams.get('as_of') || todayUTC();
  if (!isDate(asOf) || asOf > todayUTC()) return fail(400, 'as_of must be a UTC date no later than today');
  const now = new Date();
  await settleQuestions(env.DB, ROUNDS, now);
  await runKpi(env.DB, asOf, now); // retain the research snapshots privately
  return json(await playerCounts(env.DB, asOf), 200, { 'cache-control': 'no-store' });
});
