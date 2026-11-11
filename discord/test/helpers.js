// Test doubles: D1 on node:sqlite (runs the real migrations), a fetch mock for Discord and the rounds API,
// Discord-signed request builders (a real Ed25519 key pair), and the hourly trigger.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import worker from '../src/index.js';

const keys = generateKeyPairSync('ed25519');
export const PUBLIC_KEY = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
export const signWith = (privateKey, ts, body) => sign(null, Buffer.from(ts + body), privateKey).toString('hex');
export const signBody = (ts, body) => signWith(keys.privateKey, ts, body);

export const SALT = 'test-salt';
export const BOT_KEY = 'test-bot-key';
export const APP_ID = '424242';
// Snowflake-shaped ids long enough never to appear by chance inside a sha256 hex string.
export const GUILD = '770000000000000001';
export const CHANNEL = '660000000000000001';
export const USER = '880000000000000001';
export const MANAGER = String(1 << 5); // Manage Server
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const anon = (guild, user) => sha256(`${guild}:${user}:${SALT}`);
export const community = (guild) => `discord:${sha256(`${guild}:${SALT}`)}`;
export const snowflake = (ms) => String(BigInt(ms - 1_420_070_400_000) << 22n);
export const today = () => new Date().toISOString().slice(0, 10);
export const points = (conf, correct) => Math.round(100 - 400 * (conf / 100 - (correct ? 1 : 0)) ** 2);

const MIGRATIONS = new URL('../migrations/', import.meta.url);

// Same call shapes as D1: prepare().bind().first() | .all() -> {results} | .run() -> {meta}; batch([...]).
// `readDelay` (ms) delivers first() late, so two overlapping requests both read before either writes, as two
// isolates can. Runs every migration in order, as `wrangler d1 migrations apply` does.
export function fakeD1({ readDelay = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => {
      const row = db.prepare(sql).get(...args); // snapshot now, deliver after the delay
      if (readDelay) await new Promise((resolve) => setTimeout(resolve, readDelay));
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
  PRESENCE_LIMITER: { limit: async () => ({ success: true }) },
  API_BASE: 'https://api.test',
  DISCORD_APP_ID: APP_ID,
  DISCORD_PUBLIC_KEY: PUBLIC_KEY,
  DISCORD_BOT_TOKEN: 'bot-token',
  SALT,
  BOT_KEY,
});

export const DATE = '2026-10-06'; // a Tuesday
export const QUESTION = {
  round_id: `dq-${DATE}`, item_id: 'p00042', prompt: 'Which is longer: the Nile or the Danube?', a: 'the Nile', b: 'the Danube',
};
export const TRUTH = {
  a_value: 6650, b_value: 2850, unit: 'km', a_source: 'https://www.wikidata.org/wiki/Q3392', b_source: 'https://www.wikidata.org/wiki/Q1653',
};
// Ten quick-round questions. A is always right, in rounds and in the daily question.
export const roundItems = () => Array.from({ length: 10 }, (_, k) => ({ id: `i${k}`, prompt: `Question ${k + 1}?`, a: `Alpha ${k}`, b: `Beta ${k}` }));
export const REVEAL = { n: 0, pct_a: 0, pct_b: 0, correct: 0, ...TRUTH, biggest_bluff: null };
export const COMPLETE = {
  score: 260, accuracy: 50, mean_conf: 75, overconfidence: 25, brier: 0.2, type: 'Bluffer', streak: 3,
  challenge_url: '/c/r1/tok1234567', share_text: "Who's Bluffing? · Bluffer · 260 pts", roast: 'The Nile would like a word.',
};

// Installs a fetch mock. `discord(call)` may return {status, body} to override Discord; `api[path](call)` overrides the
// API with data, or with a Response to set the status; `slow` delays every API answer (to make taps overlap).
// Like the real API: every call needs x-bluff-bot (403 otherwise), daily `dq-` answers come back locked with points
// pending, and quick-round answers are idempotent per (anon_id, round_id, item_id).
export function mockFetch({ discord = () => undefined, api = {}, apiDown = false, slow = 0 } = {}) {
  const calls = [];
  const answered = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url, host: url.hostname, path: url.pathname, method: init.method ?? 'GET', body, headers: init.headers ?? {} };
    calls.push(call);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (call.host === 'discord.com') {
      const custom = discord(call);
      if (custom instanceof Response) return custom;
      if (custom) return json(custom.body ?? {}, custom.status ?? 200);
      if (call.method === 'POST' && /^\/api\/v10\/channels\/\d+\/messages$/.test(call.path)) return json({ id: '9001' });
      if (call.method === 'GET' && call.path.endsWith('/members')) return json([]);
      if (call.method === 'PATCH' && call.path.endsWith('/messages/@original')) return json({ id: '990000000000000001' });
      return json({});
    }
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    if (call.headers['x-bluff-bot'] !== BOT_KEY) return json({ error: 'bot key' }, 403);
    if (apiDown) return json({ error: 'down' }, 503);
    if (api[call.path]) {
      const out = api[call.path](call);
      return out instanceof Response ? out : json(out);
    }
    if (call.path === '/api/round/daily-question') return json(QUESTION);
    if (call.path === '/api/round') return json({ round_id: 'r1', mode: 'quick', date: DATE, items: roundItems() });
    if (call.path === '/api/round/complete') return json(COMPLETE);
    if (call.path === '/api/round/reveal') return json(REVEAL);
    if (call.path === '/api/flag') return json({ ok: true });
    if (call.path === '/api/round/answer' && call.body.round_id.startsWith('dq-')) return json({ locked: true, points_pending: true });
    if (call.path === '/api/round/answer') {
      const b = call.body;
      const key = `${b.anon_id}:${b.round_id}:${b.item_id}`;
      if (!answered.has(key) || b.revision) {
        answered.set(key, { correct: b.choice === 0, truth: TRUTH, points: points(b.conf, b.choice === 0), choice: b.choice, conf: b.conf });
      }
      const total = [...answered].filter(([k]) => k.startsWith(`${b.anon_id}:${b.round_id}:`)).reduce((s, [, r]) => s + r.points, 0);
      return json({ ...answered.get(key), total });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };
  return calls;
}

const discordCalls = (calls, method, re) => calls.filter((c) => c.host === 'discord.com' && c.method === method && re.test(c.path));
export const apiCalls = (calls, path) => calls.filter((c) => c.host === 'api.test' && c.path === path);
export const originalEdits = (calls) => discordCalls(calls, 'PATCH', /^\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/@original$/);
export const followUps = (calls) => discordCalls(calls, 'POST', /^\/api\/v10\/webhooks\/\d+\/[^/]+$/);
export const channelPosts = (calls) => discordCalls(calls, 'POST', /^\/api\/v10\/channels\/\d+\/messages$/);
export const messageEdits = (calls) => discordCalls(calls, 'PATCH', /^\/api\/v10\/channels\/\d+\/messages\/\d+$/);
export const memberLists = (calls) => discordCalls(calls, 'GET', /^\/api\/v10\/guilds\/\d+\/members$/);
export const channelOfPost = (call) => call.path.split('/')[4];

export function signedRequest(payload, { ts = Math.floor(Date.now() / 1000), sig, path = '/interactions' } = {}) {
  const body = JSON.stringify(payload);
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-timestamp': String(ts), 'x-signature-ed25519': sig ?? signBody(String(ts), body) },
    body,
  });
}

let seq = 0;
const base = ({ guild = GUILD, user = USER, channel = CHANNEL, permissions = '0', at = Date.now() } = {}) => ({
  id: snowflake(at),
  application_id: APP_ID,
  token: `token-${(seq += 1)}`,
  guild_id: guild,
  channel_id: channel,
  channel: { id: channel },
  member: { user: { id: user, username: `user${user}` }, permissions },
});

export const commandPayload = (sub, options = [], who = {}) =>
  ({ ...base(who), type: 2, data: { name: 'bluff', type: 1, options: [{ type: 1, name: sub, options }] } });

// `messageId` is the message the button sits on; its snowflake time is when that message was shown.
export const buttonPayload = (customId, { messageId = snowflake(Date.now() - 1000), ...who } = {}) =>
  ({ ...base(who), type: 3, message: { id: messageId }, data: { custom_id: customId, component_type: 2 } });

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

export async function runCron(env, iso) {
  const ctx = makeCtx();
  await worker.scheduled({ scheduledTime: Date.parse(iso), cron: '0 * * * *' }, env, ctx);
  await ctx.settle();
}

// A server as stored before new servers started at a 20-hour reveal: 8 unless `reveal` says otherwise.
export async function install(env, guild = GUILD, { channel = null, hour = 14, roast = 0, reveal = 8 } = {}) {
  await env.DB.prepare('INSERT INTO installs (guild_id, channel_id, post_hour_utc, reveal_delay_h, roast, installed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(guild, channel, hour, reveal, roast, '2026-10-01T00:00:00Z').run();
}

// Discord timestamp tokens for an ISO time: the clock time, and the clock time with "in N hours".
export const stampAt = (iso, style = 't') => `<t:${Date.parse(iso) / 1000}:${style}>`;
export const revealAt = (iso) => `${stampAt(iso)} (${stampAt(iso, 'R')})`;

// Freezes Date at `iso` for one test (node:test mock timers).
export const freeze = (t, iso) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });

export async function addPost(env, { guild = GUILD, date = DATE, channel = CHANNEL, message = '9001', revealAt = `${DATE}T22:00:00.000Z`, revealed = 0 } = {}) {
  await env.DB.prepare('INSERT INTO posts (guild_id, date, channel_id, message_id, reveal_at, revealed, prompt, a, b) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(guild, date, channel, message, revealAt, revealed, QUESTION.prompt, QUESTION.a, QUESTION.b).run();
}

// A revealed answer (A was right), or with `pending` one still waiting for its reveal (points and right/wrong NULL).
export async function addAnswer(env, { guild = GUILD, user, date = DATE, choice, conf, pending = false }) {
  const correct = choice === 0;
  await env.DB.prepare('INSERT INTO answers (guild_id, anon_id, date, choice, conf, points, correct) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(guild, anon(guild, user), date, choice, conf, pending ? null : points(conf, correct), pending ? null : Number(correct)).run();
}

export { worker };
