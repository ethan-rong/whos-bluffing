import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WELCOME, channelHello } from '../src/game.js';
import {
  APP_ID, CHANNEL, GUILD, USER, addPost, channelOfPost, channelPosts, install, makeCtx, makeEnv, mockFetch, runCron, send, signedRequest,
  worker,
} from './helpers.js';

const G2 = '770000000000000032';
const C2 = '660000000000000032';
const SYSTEM = '660000000000000031';
const [T1, T2, T3, T4, T5, T6] = Array.from({ length: 6 }, (_, k) => `66000000000000004${k + 1}`);
const [VIEW, SEND] = [1 << 10, 1 << 11]; // VIEW_CHANNEL, SEND_MESSAGES
const TS = '2026-10-06T14:42:53.064834'; // the event timestamp, in the format of Discord's examples

const toEvents = (payload, opts) => signedRequest(payload, { ...opts, path: '/events' });
const event = (type, data, timestamp = TS) => ({ version: 1, application_id: APP_ID, type: 1, event: { type, timestamp, data } });
// Shaped like Discord's documented APPLICATION_AUTHORIZED; `guild` comes with server installs (integration_type 0).
const authorized = ({ integration = 0, guild = integration === 0, timestamp } = {}) => event('APPLICATION_AUTHORIZED', {
  integration_type: integration,
  scopes: ['applications.commands', 'bot'],
  user: { id: USER, username: 'admin' },
  ...(guild && { guild: { id: GUILD, name: 'Test server' } }),
}, timestamp);

// Discord as one server: its system channel, its channel list, and the channels where posting fails (403).
const server = ({ system = SYSTEM, channels = [], refuse = [] } = {}) => (c) => {
  if (c.method === 'GET' && c.path === `/api/v10/guilds/${GUILD}`) return { body: { id: GUILD, system_channel_id: system } };
  if (c.method === 'GET' && c.path === `/api/v10/guilds/${GUILD}/channels`) return { body: channels };
  if (c.method === 'POST' && refuse.includes(channelOfPost(c))) return { status: 403, body: { code: 50013 } };
  return undefined;
};
// `deny` maps a role id to the permission bits its overwrite denies on this channel.
const text = (id, position, deny) => ({
  id, type: 0, position,
  ...(deny && { permission_overwrites: Object.entries(deny).map(([role, bits]) => ({ id: role, type: 0, allow: '0', deny: String(bits) })) }),
});
const posted = (calls) => channelPosts(calls).map(channelOfPost);

test('events: a forged or stale signature gets 401 and changes nothing', async () => {
  const env = makeEnv();
  const calls = mockFetch();
  const forged = await send(env, toEvents(authorized(), { sig: 'ab'.repeat(64) }));
  const stale = await send(env, toEvents(authorized(), { ts: Math.floor(Date.now() / 1000) - 600 }));
  assert.equal(forged.status, 401);
  assert.equal(stale.status, 401);
  assert.equal(calls.length, 0);
  assert.deepEqual(env.DB.rows('SELECT * FROM installs'), []);
});

test('events: PING gets 204 with an empty body', async () => {
  const calls = mockFetch();
  const res = await send(makeEnv(), toEvents({ version: 1, application_id: APP_ID, type: 0 }));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.ok(res.headers.get('content-type')); // Discord asks for a valid Content-Type even on an empty 204
  assert.equal(calls.length, 0);
});

test('server install: registers the server, posts one hello in its system channel and makes it the daily channel', async () => {
  const env = makeEnv();
  const calls = mockFetch({ discord: server({ channels: [text(T1, 0)] }) });
  const res = await send(env, toEvents(authorized()));
  assert.equal(res.status, 204);
  const [{ installed_at: installedAt, auto_channel: autoChannel, ...row }] = env.DB.rows('SELECT * FROM installs');
  // A new server reveals 20 hours after the post.
  assert.deepEqual(row, { guild_id: GUILD, channel_id: SYSTEM, post_hour_utc: 14, reveal_delay_h: 20, roast: 0, last_recap: null, welcomed: TS });
  assert.match(installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(autoChannel, installedAt);
  // The system channel takes the post, so the channel list is never fetched.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /api/v10/guilds/${GUILD}`, `POST /api/v10/channels/${SYSTEM}/messages`]);
  assert.ok(calls.every((c) => c.headers.authorization === 'Bot bot-token'));
  const [hello] = channelPosts(calls);
  assert.match(hello.body.content, /Play with friends/);
  assert.deepEqual(hello.body.components[0].components, [{ type: 2, style: 1, custom_id: 'start', label: 'Play solo' }, { type: 2, style: 1, custom_id: 'startparty', label: 'Play with friends' }]);
  assert.deepEqual(hello.body, WELCOME);
  assert.deepEqual(hello.body.allowed_mentions, { parse: [] });
  assert.match(hello.body.content, /Daily question:.*`\/bluff setup`/s);

  await runCron(env, '2026-10-06T14:00:00Z'); // the daily question starts with no /bluff setup
  assert.deepEqual(posted(calls), [SYSTEM, SYSTEM]);
});

test('server install: the system channel refuses, so text channels follow in position order until a post lands', async () => {
  const env = makeEnv();
  const channels = [
    text(T3, 3),
    text(SYSTEM, 0), // already tried as the system channel
    { id: '660000000000000051', type: 2, position: 0 }, // voice
    { id: '660000000000000052', type: 4, position: 0 }, // category
    { id: '660000000000000053', type: 5, position: 0 }, // announcement
    text(T2, 2),
    text(T1, 1),
  ];
  const calls = mockFetch({ discord: server({ channels, refuse: [SYSTEM] }) });
  await send(env, toEvents(authorized()));
  assert.deepEqual(posted(calls), [SYSTEM, T1]);
});

test('server install: channels closed to @everyone are skipped without a call; another role\'s deny is not', async () => {
  const env = makeEnv();
  const ROLE = '550000000000000001';
  const channels = [
    text(T1, 1, { [GUILD]: VIEW }), // rules: hidden from @everyone
    text(T2, 2, { [GUILD]: SEND | (1 << 6) }), // announcements: read-only for @everyone
    text(T5, 3, { [GUILD]: VIEW | SEND }),
    text(T6, 4, { [ROLE]: VIEW, [GUILD]: SEND }),
    text(T3, 5, { [ROLE]: SEND }), // muted role only: still open to @everyone, and reached because skips cost no try
    text(T4, 6),
  ];
  const calls = mockFetch({ discord: server({ channels, refuse: [SYSTEM] }) });
  await send(env, toEvents(authorized()));
  assert.deepEqual(posted(calls), [SYSTEM, T3]);
  assert.equal(env.DB.rows('SELECT channel_id FROM installs')[0].channel_id, T3);
});

test('server install: no writable channel gives up quietly after 5 posts and keeps the server', async () => {
  const env = makeEnv();
  const channels = [text(T6, 6), text(T5, 5), text(T4, 4), text(T3, 3), text(T2, 2), text(T1, 1)];
  const calls = mockFetch({ discord: server({ system: null, channels, refuse: [T1, T2, T3, T4, T5, T6] }) });
  const logged = [];
  const consoleError = console.error;
  console.error = (line) => logged.push(line);
  try {
    const res = await send(env, toEvents(authorized()));
    assert.equal(res.status, 204);
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(posted(calls), [T1, T2, T3, T4, T5]);
  assert.deepEqual(logged, []);
  assert.deepEqual(env.DB.rows('SELECT guild_id, channel_id FROM installs'), [{ guild_id: GUILD, channel_id: null }]);
  await runCron(env, '2026-10-06T10:00:00Z'); // the install's one pick is spent: the hourly run tries nothing more
  assert.deepEqual(posted(calls), [T1, T2, T3, T4, T5]);
});

test('user install (integration_type 1) is acknowledged and ignored', async () => {
  const env = makeEnv();
  const calls = mockFetch({ discord: server() });
  for (const payload of [authorized({ integration: 1 }), authorized({ integration: 1, guild: true })]) {
    assert.equal((await send(env, toEvents(payload))).status, 204);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(env.DB.rows('SELECT * FROM installs'), []);
});

test('uninstall naming a server clears its channel so the hourly run skips it; the documented shape changes nothing', async () => {
  const env = makeEnv();
  await install(env, GUILD, { channel: CHANNEL, hour: 14 });
  await install(env, G2, { channel: C2, hour: 14 });
  const calls = mockFetch();
  const channelOf = (guild) => env.DB.rows('SELECT channel_id FROM installs WHERE guild_id = ?', guild)[0].channel_id;

  // As Discord documents it: the member who removed the app, and no server.
  const documented = await send(env, toEvents(event('APPLICATION_DEAUTHORIZED', { user: { id: USER } })));
  assert.equal(documented.status, 204);
  assert.equal(channelOf(GUILD), CHANNEL);

  const named = await send(env, toEvents(event('APPLICATION_DEAUTHORIZED', { user: { id: USER }, guild: { id: GUILD } })));
  assert.equal(named.status, 204);
  assert.equal(channelOf(GUILD), null);
  assert.equal(channelOf(G2), C2);

  await runCron(env, '2026-10-06T14:00:00Z');
  assert.deepEqual(posted(calls), [C2]);
});

test('a retried install event posts nothing more; a later install says hello again and keeps the settings', async () => {
  const env = makeEnv();
  const calls = mockFetch({ discord: server() });
  await send(env, toEvents(authorized()));
  await send(env, toEvents(authorized())); // Discord's retry: the same event, the same timestamp
  await Promise.all([send(env, toEvents(authorized())), send(env, toEvents(authorized()))]);
  assert.deepEqual(posted(calls), [SYSTEM]);

  await env.DB.prepare('UPDATE installs SET channel_id = ?, post_hour_utc = 9, roast = 1 WHERE guild_id = ?').bind(CHANNEL, GUILD).run();
  await send(env, toEvents(authorized({ timestamp: '2026-10-09T08:00:00.000000' }))); // removed, then added again
  assert.deepEqual(posted(calls), [SYSTEM, SYSTEM]);
  assert.deepEqual(env.DB.rows('SELECT channel_id, post_hour_utc, roast, welcomed FROM installs'), [
    { channel_id: CHANNEL, post_hour_utc: 9, roast: 1, welcomed: '2026-10-09T08:00:00.000000' },
  ]);
});

test('an install event for a server stored before the 20-hour default keeps its 8-hour reveal and settings', async () => {
  const env = makeEnv();
  await install(env, GUILD, { channel: CHANNEL, hour: 9 });
  const calls = mockFetch({ discord: server() });
  await send(env, toEvents(authorized()));
  assert.deepEqual(posted(calls), [SYSTEM]);
  assert.deepEqual(env.DB.rows('SELECT channel_id, post_hour_utc, reveal_delay_h, welcomed FROM installs'), [
    { channel_id: CHANNEL, post_hour_utc: 9, reveal_delay_h: 8, welcomed: TS },
  ]);
});

// A handler that awaited Discord would never answer while the gate is shut: node:test cancels the test once the event
// loop drains (the run exits 1), and the timeout is the backstop.
test('server install answers 204 without waiting for Discord; the server is registered before it', { timeout: 2000 }, async () => {
  const env = makeEnv();
  const calls = mockFetch({ discord: server() });
  const mocked = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (...args) => {
    await gate;
    return mocked(...args);
  };
  const ctx = makeCtx();
  const res = await worker.fetch(toEvents(authorized()), env, ctx);
  assert.equal(res.status, 204);
  assert.equal(calls.length, 0); // Discord not reached yet
  assert.equal(env.DB.rows('SELECT * FROM installs').length, 1);
  release();
  await ctx.settle();
  assert.deepEqual(posted(calls), [SYSTEM]);
});

// Servers added before installs picked the daily channel: the hourly run makes the same pick once per server.

test('a server added before auto channels gets one hello from the hourly run, then the daily question there', async () => {
  const env = makeEnv();
  await install(env, GUILD);
  const calls = mockFetch({ discord: server({ channels: [text(T1, 0)] }) });
  await runCron(env, '2026-10-06T10:00:00Z');
  assert.deepEqual(posted(calls), [SYSTEM]);
  assert.deepEqual(channelPosts(calls)[0].body, channelHello(14, Date.parse('2026-10-06T10:00:00Z')));
  assert.equal(env.DB.rows('SELECT channel_id FROM installs')[0].channel_id, SYSTEM);
  await runCron(env, '2026-10-06T14:00:00Z');
  await runCron(env, '2026-10-06T15:00:00Z');
  assert.deepEqual(posted(calls), [SYSTEM, SYSTEM]); // hello, then the 14:00 question; no second hello
});

test('the hourly pick leaves servers that have a channel or ever posted, and tries an unwritable server once', async () => {
  const env = makeEnv();
  await install(env, GUILD);
  await addPost(env, { guild: GUILD }); // played /bluff question once, never set up: left alone
  await install(env, G2, { channel: C2 });
  const calls = mockFetch({ discord: (c) => (c.method === 'GET' ? { body: { system_channel_id: SYSTEM } } : undefined) });
  await runCron(env, '2026-10-06T10:00:00Z');
  assert.deepEqual(posted(calls), []);
  assert.deepEqual(env.DB.rows('SELECT guild_id, channel_id FROM installs ORDER BY guild_id'), [
    { guild_id: GUILD, channel_id: null }, { guild_id: G2, channel_id: C2 },
  ]);

  const env2 = makeEnv();
  await install(env2, GUILD);
  const calls2 = mockFetch({ discord: server({ system: null, channels: [text(T1, 1)], refuse: [T1] }) });
  await runCron(env2, '2026-10-06T10:00:00Z');
  await runCron(env2, '2026-10-06T11:00:00Z');
  assert.deepEqual(posted(calls2), [T1]);
  assert.equal(env2.DB.rows('SELECT channel_id FROM installs')[0].channel_id, null);
});

test('the hourly pick handles three servers a run', async () => {
  const env = makeEnv();
  const guilds = Array.from({ length: 7 }, (_, k) => `7700000000000001${String(k).padStart(2, '0')}`);
  for (const g of guilds) await install(env, g);
  const calls = mockFetch({ discord: (c) => (c.method === 'GET' ? { body: { system_channel_id: SYSTEM } } : undefined) });
  await runCron(env, '2026-10-06T10:00:00Z');
  assert.equal(posted(calls).length, 3);
  await runCron(env, '2026-10-06T11:00:00Z');
  assert.equal(posted(calls).length, 6);
  await runCron(env, '2026-10-06T12:00:00Z');
  assert.equal(posted(calls).length, 7);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM installs WHERE channel_id = ?', SYSTEM)[0].n, 7);
});

test('migration 0006 gives a server whose one pick found no channel one more hourly pick; a server that posted stays', async () => {
  const env = makeEnv();
  const SPENT = '2026-10-01T00:00:00.000Z';
  await install(env, GUILD);
  await install(env, G2);
  await addPost(env, { guild: G2 });
  await env.DB.prepare('UPDATE installs SET auto_channel = ?').bind(SPENT).run(); // both picks spent, no channel found
  const calls = mockFetch({ discord: server({ channels: [text(T1, 0)] }) });
  await runCron(env, '2026-10-06T10:00:00Z');
  assert.deepEqual(posted(calls), []);

  await env.DB.prepare(readFileSync(new URL('../migrations/0006_retry_pick.sql', import.meta.url), 'utf8')).run();
  await runCron(env, '2026-10-06T11:00:00Z');
  assert.deepEqual(posted(calls), [SYSTEM]);
  assert.deepEqual(env.DB.rows('SELECT guild_id, channel_id, auto_channel FROM installs ORDER BY guild_id'), [
    { guild_id: GUILD, channel_id: SYSTEM, auto_channel: '2026-10-06T11:00:00.000Z' },
    { guild_id: G2, channel_id: null, auto_channel: SPENT },
  ]);
});
