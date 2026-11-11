// Test doubles: D1 on node:sqlite (runs the real migrations), a fetch mock for Slack and the rounds API
// (docs/api-rounds.md, chat-platform part), and Slack-signed request builders.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import worker from '../src/index.js';

export const SECRET = 'test-signing-secret';
export const SALT = 'test-salt';
export const BOT_KEY = 'test-bot-key';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const anon = (team, user) => sha256(`${team}:${user}:${SALT}`);

// Same call shapes as D1: prepare().bind().first() | .all() -> {results} | .run() -> {meta}; batch([...]).
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => {
      const row = db.prepare(sql).get(...args);
      return row ? { ...row } : null;
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: (list) => Promise.all(list.map((s) => s.all())),
    rows: (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r })),
  };
}

export const makeEnv = (db = fakeD1()) => ({
  DB: db,
  REQUEST_LIMITER: { limit: async () => ({ success: true }) },
  API_BASE: 'https://api.test',
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_CLIENT_ID: 'client-id',
  SLACK_CLIENT_SECRET: 'client-secret',
  SALT,
  BOT_KEY,
});

export const DATE = '2026-10-31'; // a Saturday; 2026-11-02 is a Monday
export const QUESTION = { round_id: `dq-${DATE}`, item_id: 'p00042', prompt: 'Which is longer?', a: 'the Nile', b: 'the Danube' };
export const QUESTION_TEXT = 'Which is longer: the Nile or the Danube?';

// The contract's scoring rule. In the mock, A (the Nile) is the right answer.
export const points = (conf, correct) => Math.round(100 - 400 * (conf / 100 - (correct ? 1 : 0)) ** 2);
export const SOURCES = { a_source: 'https://www.wikidata.org/wiki/Q3392', b_source: 'https://www.wikidata.org/wiki/Q1653' };
export const REVEAL = { n: 2, pct_a: 50, pct_b: 50, correct: 0, a_value: 6650, b_value: 2850, unit: 'km', ...SOURCES, biggest_bluff: null };

// Installs a fetch mock. `slack[method](call)` and `api[path](call)` override the defaults; an api override may
// return a Response (for error statuses).
export function mockFetch({ slack = {}, api = {}, apiDown = false } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const raw = init.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(raw) : undefined;
    const call = { url, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method ?? 'GET', body, headers: init.headers ?? {} };
    calls.push(call);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (call.host === 'slack.com') {
      const method = call.path.replace('/api/', '');
      return json({ ok: true, ts: '1700000000.000100', ...(slack[method]?.(call) ?? {}) });
    }
    if (call.host === 'hooks.slack.com') return json({ ok: true });
    if (apiDown) return json({ error: 'down' }, 503);
    if (api[call.path]) {
      const out = api[call.path](call);
      return out instanceof Response ? out : json(out);
    }
    if (call.path === '/api/round/daily-question') return json({ ...QUESTION, round_id: `dq-${call.query.date}` });
    if (call.path === '/api/round/answer') return json({ locked: true, points_pending: true }); // dq- rounds: no truth, no points
    if (call.path === '/api/round/reveal') return json(REVEAL);
    throw new Error(`unexpected fetch ${url.href}`);
  };
  return calls;
}

export const slackCalls = (calls, method) => calls.filter((c) => c.host === 'slack.com' && c.path === `/api/${method}`);
export const apiCalls = (calls, path) => calls.filter((c) => c.host === 'api.test' && c.path === path);
export const replies = (calls) => calls.filter((c) => c.host === 'hooks.slack.com');

export function signedRequest(body, { ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return new Request('https://worker.test/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig },
    body,
  });
}

export const slashBody = (fields = {}) =>
  new URLSearchParams({
    command: '/bluff', text: '', team_id: 'T1', user_id: 'U1', channel_id: 'C1',
    response_url: 'https://hooks.slack.com/commands/T1/1/abc', trigger_id: 'trigger-1', ...fields,
  }).toString();

export const payloadBody = (payload) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

// Freezes Date at `iso` for one test (node:test mock timers; t.mock.timers.tick(ms) moves it on).
export const at = (t, iso) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });

// A Slack message ts (epoch seconds plus a suffix) for a moment.
export const tsAt = (iso) => `${Date.parse(iso) / 1000}.000100`;

// Collects ctx.waitUntil work so a test can wait for it.
export function makeCtx() {
  const tasks = [];
  return { waitUntil: (p) => tasks.push(p), settle: () => Promise.all(tasks) };
}

// Sends a request through the worker and waits for the background work.
export async function send(env, request) {
  const ctx = makeCtx();
  const res = await worker.fetch(request, env, ctx);
  await ctx.settle();
  return res;
}

// `reveal` null = never set (8 hours).
export async function install(env, team = 'T1', { channel = null, hour = 14, roast = 0, reveal = null } = {}) {
  await env.DB.prepare('INSERT INTO installs (team_id, bot_token, channel_id, post_hour_utc, roast, reveal_delay_h, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(team, `xoxb-${team}`, channel, hour, roast, reveal, '2026-10-01T00:00:00Z').run();
}

// Slack date tokens as the bot writes them: `{time}` with an "HH:MM UTC" fallback, and the reveal's
// `{date_short_pretty} {time}` with a "Mon D HH:MM UTC" fallback.
export const clockToken = (iso) => `<!date^${Date.parse(iso) / 1000}^{time}|${iso.slice(11, 16)} UTC>`;
export const revealToken = (iso, day) => `<!date^${Date.parse(iso) / 1000}^{date_short_pretty} {time}|${day} ${iso.slice(11, 16)} UTC>`;

export { worker };
