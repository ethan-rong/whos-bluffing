// Slash command definitions (exported for scripts/register-commands.mjs), every interaction handler, the
// post / reveal / recap actions the hourly tick shares with the commands, and the install hello.
// Discord needs an answer within 3 s: whatever needs no I/O answers at once (type 4); whatever needs I/O defers
// (type 5 for commands; type 6 for button presses, which keeps a flow in one message) and then edits @original
// through the interaction webhook.

import * as api from './api.js';
import * as store from './store.js';
import * as game from './game.js';
import * as party from './party.js';
import { LIFETIME } from './party-store.js';

const DISCORD_API = 'https://discord.com/api/v10';
const COMMAND = 2;
const COMPONENT = 3;
const EPHEMERAL = 64;
const MANAGE = (1n << 5n) | (1n << 3n); // Manage Server or Administrator
const PERMISSIONS = String((1n << 11n) | (1n << 14n) | (1n << 16n)); // Send Messages, Embed Links, Read Message History
const GONE = new Set([403, 404]); // no access, or the channel or message no longer exists
const PERIOD_DAYS = 30;
const STREAK_LOOKBACK_DAYS = 366;
const HOUR_MS = 3_600_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

const [SUB, STRING, INTEGER, CHANNEL] = [1, 3, 4, 7];
const TEXT_CHANNEL = 0;
const GUILD_TEXT_CHANNELS = [TEXT_CHANNEL, 5]; // text and announcement channels
const WELCOME_TRIES = 3; // channels the install hello tries before giving up

// One global command for server and personal installs, including DMs and group DMs.
export const COMMANDS = [{
  name: 'bluff',
  description: 'Play ten questions with friends: pick A or B and say how sure you are',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    { type: SUB, name: 'party', description: 'Start a Memes party: same ten questions, private answers, shared results' },
    { type: SUB, name: 'play', description: 'Play a private 10-question round' },
    { type: SUB, name: 'question', description: "Post today's question in this channel now" },
    { type: SUB, name: 'stats', description: "This server's leaderboard for the last 30 days" },
    {
      type: SUB,
      name: 'setup',
      description: 'Daily channel, hour, reveal delay and roast mode (Manage Server)',
      options: [
        { type: CHANNEL, name: 'channel', description: 'Where the daily question goes', channel_types: GUILD_TEXT_CHANNELS },
        { type: INTEGER, name: 'hour', description: 'Posting hour in UTC, 0 to 23 (default 14)', min_value: 0, max_value: 23 },
        { type: INTEGER, name: 'reveal', description: 'Hours from the post to the reveal, 2 to 23', min_value: 2, max_value: 23 },
        {
          type: STRING,
          name: 'roast',
          description: 'Name the biggest bluffer in the reveal (default off)',
          choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }],
        },
      ],
    },
    { type: SUB, name: 'reveal', description: "Reveal today's answer now (Manage Server)" },
    { type: SUB, name: 'help', description: "How Who's Bluffing works" },
    { type: SUB, name: 'invite', description: "Add Who's Bluffing to your apps or a server" },
  ],
}];

// Logs a short reason only: never request bodies, tokens or env values.
export const logError = (where, err) => console.error(`whosbluffing-discord ${where}: ${err?.message ?? err}`);

export const installUrl = (env) =>
  `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: env.DISCORD_APP_ID,
    scope: 'bot applications.commands',
    permissions: PERMISSIONS,
    integration_type: '0',
  })}`;

export const personalInstallUrl = (env) => `https://discord.com/oauth2/authorize?${new URLSearchParams({
  client_id: env.DISCORD_APP_ID, scope: 'applications.commands', integration_type: '1',
})}`;

// ---- Discord REST -------------------------------------------------------------------------------------------

const headers = (env) => ({ 'content-type': 'application/json', 'user-agent': `DiscordBot (${env.API_BASE}, 0.1)` });

// Bot-token call. Callers check res.ok / res.status.
const discord = (env, method, path, body) =>
  fetch(`${DISCORD_API}${path}`, {
    method,
    headers: { ...headers(env), authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: body && JSON.stringify(body),
  });

// Interaction webhook: edit the original response, or send a private follow-up. Needs no bot token.
async function webhook(env, token, method, path, msg) {
  const res = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}${path}`, {
    method,
    headers: headers(env),
    body: JSON.stringify({ allowed_mentions: game.NO_PINGS, ...msg }),
  });
  if (!res.ok) throw new Error(`webhook ${method} returned ${res.status}`);
  return res.status === 204 ? null : res.json();
}
const editOriginal = (env, token, msg) => webhook(env, token, 'PATCH', '/messages/@original', msg);
const followUp = (env, token, msg) => webhook(env, token, 'POST', '', { flags: EPHEMERAL, ...msg });

// A guild member's display name: server nickname, else global name, else username. Read at render time only.
const displayName = (m) => m?.nick || m?.user?.global_name || m?.user?.username || 'A friend';

// Names exist only at render time: list the server's members, hash each, keep display names of the matches.
// Listing members needs the Server Members Intent; without it (403) everyone shows as "a member".
// ponytail: first 1000 members (one page); page with ?after= for bigger servers (one sha256 per member).
async function memberNames(env, guildId, anonIds) {
  const names = new Map();
  const wanted = new Set(anonIds);
  if (!wanted.size) return names;
  const res = await discord(env, 'GET', `/guilds/${guildId}/members?limit=1000`).catch(() => null);
  if (!res?.ok) return names;
  for (const m of await res.json()) {
    const anon = await api.anonId(env, guildId, m.user.id);
    if (wanted.has(anon)) names.set(anon, displayName(m));
    if (names.size === wanted.size) break;
  }
  return names;
}

// ---- Interaction plumbing -----------------------------------------------------------------------------------

const respond = (type, data) => Response.json(data === undefined ? { type } : { type, data });
const say = (data, { ephemeral = true } = {}) =>
  respond(4, { allowed_mentions: game.NO_PINGS, ...data, ...(ephemeral && { flags: EPHEMERAL }) });

// Defers now and finishes in the background. On failure a command's deferred reply becomes the "taking a break"
// notice; a pressed button keeps its message (so it can be pressed again) and the notice comes as a private follow-up.
function defer(ctx, env, i, work, { ephemeral = true, update = i.type === COMPONENT } = {}) {
  const run = async () => {
    const msg = await work();
    if (msg) {
      const sent = await editOriginal(env, i.token, msg.message ?? msg);
      if (msg.afterEdit) await msg.afterEdit(sent);
    } // null: nothing to change (a repeated tap)
  };
  const fail = (err) => {
    logError('task', err);
    const notice = { content: err.publicMessage ?? game.FAIL_TEXT, ...(!update && { components: [] }) };
    const send = update ? followUp(env, i.token, notice) : editOriginal(env, i.token, notice);
    return send.catch((e) => logError('notice', e));
  };
  ctx.waitUntil(run().catch(fail));
  return update ? respond(6) : respond(5, ephemeral ? { flags: EPHEMERAL } : {});
}

const canManage = (i) => (BigInt(i.member?.permissions ?? '0') & MANAGE) !== 0n;
const channelOf = (i) => i.channel?.id ?? i.channel_id;
const snowflakeMs = (id) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
const userOf = (i) => i.member?.user ?? i.user;
// Older signed Discord payloads omitted owners. An explicit user-only install never gets bot-token features.
const serverInstalled = (i) => Boolean(i.guild_id && (!i.authorizing_integration_owners || i.authorizing_integration_owners['0'] === i.guild_id));
const SERVER_FEATURE = 'Daily questions and server leaderboards need a server install. Use /bluff party or /bluff play here, or /bluff invite for the server link.';
const PUBLIC_DENIED = 'Discord only allows private app replies here. Try /bluff play, or start /bluff party in a DM, group DM or channel that allows public app replies.';

function canReplyPublic(i) {
  if (!i.guild_id) return true;
  const perms = BigInt(i.app_permissions ?? '0');
  const member = BigInt(i.member?.permissions ?? '0');
  const send = [10, 11, 12].includes(i.channel?.type) ? 1n << 38n : 1n << 11n;
  if (serverInstalled(i)) return i.app_permissions == null || Boolean(perms & (send | 8n));
  return Boolean(member & 8n) || Boolean((member & send) && (member & (1n << 50n)));
}

async function who(env, i) {
  const context = i.guild_id ?? `dm:${channelOf(i)}`;
  const [anonId, community] = await Promise.all([api.anonId(env, context, userOf(i).id), i.guild_id ? api.communityId(env, i.guild_id) : null]);
  return { anon_id: anonId, community };
}

async function partyContext(env, i) {
  return { me: await who(env, i), scope: await api.anonId(env, 'channel', channelOf(i)), name: displayName(i.member ?? { user: i.user }) };
}

export function handleInteraction(i, env, ctx) {
  if (!userOf(i)?.id || !channelOf(i)) return say({ content: 'Open this command in a Discord chat.' });
  if (i.type === COMMAND) return command(i, env, ctx);
  if (i.type === COMPONENT) return component(i, env, ctx);
  return new Response('Unsupported interaction', { status: 400 });
}

async function command(i, env, ctx) {
  const sub = i.data?.options?.[0];
  const opts = Object.fromEntries((sub?.options ?? []).map((o) => [o.name, o.value]));
  const later = (work, options) => defer(ctx, env, i, work, options);
  if (['question', 'stats', 'setup', 'reveal'].includes(sub?.name) && !serverInstalled(i)) return say({ content: SERVER_FEATURE });
  switch (sub?.name) {
    case 'question': return later(() => postToday(env, i));
    case 'play': return later(() => openSetup(env, i, 'play'));
    case 'party': return canReplyPublic(i)
      ? later(() => openSetup(env, i, 'party'))
      : say({ content: PUBLIC_DENIED });
    case 'stats': return later(() => stats(env, i), { ephemeral: false });
    case 'setup': return canManage(i) ? later(() => setup(env, i, opts)) : say({ content: game.NEED_MANAGE });
    case 'reveal': return canManage(i) ? later(() => revealNow(env, i)) : say({ content: game.NEED_MANAGE });
    case 'invite': return say({ content: `${game.invite(installUrl(env))}\nAdd to my apps (no server permission needed): ${personalInstallUrl(env)}` });
    // One D1 read, no Discord call: still answered at once.
    default: return say({ content: game.help(serverInstalled(i) ? await store.getInstall(env.DB, i.guild_id) : null, Date.now(), serverInstalled(i)), components: game.playButtons() });
  }
}

function component(i, env, ctx) {
  const [kind, ...args] = (i.data?.custom_id ?? '').split(':');
  const later = (work) => defer(ctx, env, i, work);
  if (['sp', 'sd', 'ss'].includes(kind)) {
    const publicStart = kind === 'ss' && args[2] === 'party';
    if (publicStart && !canReplyPublic(i)) return say({ content: PUBLIC_DENIED });
    return defer(ctx, env, i, () => setupAction(env, i, kind, args), { update: !publicStart, ephemeral: !publicStart });
  }
  if (['tj', 'tr', 'tm'].includes(kind)) {
    if (kind !== 'tj' && !canReplyPublic(i)) return say({ content: PUBLIC_DENIED });
    return defer(ctx, env, i, async () => party.publicAction(env, i, kind, args[0], await partyContext(env, i)), { update: kind !== 'tj' });
  }
  if (['ta', 'tb', 'tc', 'tn', 'tv', 'tf', 'tg'].includes(kind)) return later(async () => party.privateAction(env, i, kind, args, await partyContext(env, i)));
  if (['q', 'c'].includes(kind) && !serverInstalled(i)) return say({ content: SERVER_FEATURE });
  switch (kind) {
    // Public welcome buttons open a private round; never replace the server's welcome message.
    case 'start': return defer(ctx, env, i, () => openSetup(env, i, 'play'), { update: false });
    case 'startparty': return canReplyPublic(i)
      ? defer(ctx, env, i, () => openSetup(env, i, 'party'), { update: false })
      : say({ content: PUBLIC_DENIED });
    case 'q': return say(game.confidencePicker(args[0], args[1], args[2], Number(args[3])));
    case 'c': return later(() => lockIn(env, i, args));
    case 'pa': return later(() => playChoose(env, i, args));
    case 'pb': return later(() => playBack(env, i, args));
    case 'pc': return later(() => playAnswer(env, i, args));
    case 'pn': return later(() => playNext(env, i, args));
    case 'pp': return later(() => playAgain(env, i, args));
    case 'pf': case 'pg': return later(() => playFeedback(env, i, kind, args));
    case 'px': {
      if (!canReplyPublic(i)) return say({ content: PUBLIC_DENIED });
      return defer(ctx, env, i, () => playChallenge(env, i, args), { update: false, ephemeral: false });
    }
    default: return say({ content: game.PLAY_ENDED });
  }
}

// ---- Daily question ------------------------------------------------------------------------------------------

// The hourly tick at or after now + delay: a post at 14:37 with an 8-hour delay reveals at 23:00.
const revealTime = (now, delayH) => new Date(Math.ceil((now.getTime() + delayH * HOUR_MS) / HOUR_MS) * HOUR_MS).toISOString();

// Posts the day's question with the bot token (a plain message the reveal can still edit hours later) and records
// it. Returns null when the day already has a post, else {status, revealAt} of the post call.
export async function postQuestion(env, install, channelId, date, q, now) {
  const revealAt = revealTime(now, install.reveal_delay_h);
  if (!(await store.claimPost(env.DB, install.guild_id, date, channelId, revealAt, q))) return null;
  let res;
  try {
    res = await discord(env, 'POST', `/channels/${channelId}/messages`, game.questionPost(q, date, revealAt));
    if (!res.ok) await store.dropClaim(env.DB, install.guild_id, date);
    else {
      const message = await res.json();
      if (!message?.id) throw new Error('daily message missing');
      await store.setPostMessage(env.DB, install.guild_id, date, message.id);
    }
  } catch (err) {
    await store.dropClaim(env.DB, install.guild_id, date);
    throw err;
  }
  return { status: res.status, revealAt };
}

async function postToday(env, i) {
  const now = new Date();
  const date = game.isoDate(now);
  const install = await store.ensureInstall(env.DB, i.guild_id, now.toISOString());
  const existing = await store.getPost(env.DB, i.guild_id, date);
  if (existing) return { content: game.alreadyPosted(i.guild_id, existing) };
  const result = await postQuestion(env, install, channelOf(i), date, await api.dailyQuestion(env, date), now);
  if (!result) return { content: game.alreadyPosted(i.guild_id, await store.getPost(env.DB, i.guild_id, date)) };
  if (result.status < 300) return { content: game.posted(result.revealAt) };
  return { content: GONE.has(result.status) ? game.CANT_POST : game.FAIL_TEXT };
}

// Confidence tap on the private picker. rt_ms = picker shown -> confidence tap, both Discord timestamps.
// The API does not know this server's reveal hour, so the bot refuses answers once its own reveal has happened.
async function lockIn(env, i, [date, roundId, itemId, choiceText, confText]) {
  const post = await store.getPost(env.DB, i.guild_id, date);
  if (!post || post.revealed) return { content: game.TOO_LATE, components: [] };
  const choice = Number(choiceText);
  const conf = Number(confText);
  const me = await who(env, i);
  const before = await store.getAnswer(env.DB, i.guild_id, date, me.anon_id);
  try {
    // Daily questions come back {locked: true, points_pending: true}: no truth and no points until the reveal.
    const answer = await api.answer(env, {
      round_id: roundId,
      item_id: itemId,
      choice,
      conf,
      rt_ms: Math.max(0, snowflakeMs(i.id) - snowflakeMs(i.message.id)),
      ...me,
      revision: true, // also repairs an earlier API save whose response never reached the local store
    });
    if (!answer?.locked || !answer.points_pending) throw new Error('daily answer response incomplete');
  } catch (err) {
    if (err.status !== 409) throw err;
    // 409: the API locked that day (older than yesterday). Show the answer that stands, if there is one.
    return before ? game.lockedIn(before.choice, before.conf, post.reveal_at, true) : { content: game.TOO_LATE, components: [] };
  }
  await store.saveAnswer(env.DB, { guild_id: i.guild_id, anon_id: me.anon_id, date, choice, conf });
  return game.lockedIn(choice, conf, post.reveal_at);
}

// Edits the question post into the answer, drawn from the question stored with the post (daily-question only serves
// today and yesterday) and the reveal endpoint, whose `correct` also settles this server's points. Returns false when
// someone else revealed it first. A post that is gone (message or channel deleted, access lost) stays revealed; any
// other failure releases it for the next hourly run.
export async function revealPost(env, post) {
  if (!(await store.claimReveal(env.DB, post.guild_id, post.date))) return false;
  try {
    const community = await api.communityId(env, post.guild_id);
    const r = await api.reveal(env, post.date, community);
    if (r.correct !== 0 && r.correct !== 1) throw new Error('reveal came without the right answer');
    await store.settleAnswers(env.DB, post.guild_id, post.date, r.correct);
    const top = await store.dayTop(env.DB, post.guild_id, post.date);
    const bluff = r.biggest_bluff?.conf >= game.BLUFF_CONF ? r.biggest_bluff : null;
    const named = [...top.map((t) => t.anon_id), ...(bluff && post.roast ? [bluff.anon_id] : [])];
    const names = await memberNames(env, post.guild_id, named);
    const msg = game.revealMessage({ q: post, r, top, names, bluff, roast: Boolean(post.roast), installUrl: installUrl(env) });
    const res = await discord(env, 'PATCH', `/channels/${post.channel_id}/messages/${post.message_id}`, msg);
    if (!res.ok && !GONE.has(res.status)) throw new Error(`reveal edit returned ${res.status}`);
    return true;
  } catch (err) {
    await store.releaseReveal(env.DB, post.guild_id, post.date);
    throw err;
  }
}

async function revealNow(env, i) {
  const post = await store.openPost(env.DB, i.guild_id);
  const done = post && (await revealPost(env, post));
  return { content: done ? game.REVEALED : game.NOTHING_TO_REVEAL };
}

// ---- Install hello, setup, stats, recap ----------------------------------------------------------------------

// The install hello (or `message`), posted once per install event: the server's system channel, else its text
// channels in position order. Stops at the post that lands and gives up quietly after WELCOME_TRIES posts (a server
// where Who's Bluffing may not write anywhere is fine). Returns the channel id, or null.
export async function welcomeGuild(env, guildId, message = game.WELCOME) {
  const read = async (path) => {
    const res = await discord(env, 'GET', path);
    return res.ok ? res.json() : null;
  };
  let tries = 0;
  const post = async (channelId) => {
    tries += 1;
    return (await discord(env, 'POST', `/channels/${channelId}/messages`, message)).ok;
  };
  const system = (await read(`/guilds/${guildId}`))?.system_channel_id;
  if (system && (await post(system))) return system;
  const channels = await read(`/guilds/${guildId}/channels`);
  const text = (Array.isArray(channels) ? channels : [])
    .filter((c) => c.type === TEXT_CHANNEL && c.id !== system)
    .sort((a, b) => a.position - b.position);
  for (const { id } of text) {
    if (tries >= WELCOME_TRIES) break;
    if (await post(id)) return id;
  }
  return null;
}

// Every option is optional: a missing one keeps its current value. A server without a channel gets this channel.
// Discord enforces each option's range (hour 0-23, reveal 2-23) from the registered command definition.
async function setup(env, i, opts) {
  const now = Date.now();
  const install = await store.ensureInstall(env.DB, i.guild_id, new Date(now).toISOString());
  const next = {
    channel_id: opts.channel ?? install.channel_id ?? channelOf(i),
    post_hour_utc: opts.hour ?? install.post_hour_utc,
    reveal_delay_h: opts.reveal ?? install.reveal_delay_h,
    roast: opts.roast === undefined ? install.roast : Number(opts.roast === 'on'),
  };
  // A new channel gets a short hello, which is also the check that Who's Bluffing may post there.
  if (next.channel_id !== install.channel_id) {
    const res = await discord(env, 'POST', `/channels/${next.channel_id}/messages`, game.channelHello(next.post_hour_utc, now));
    if (!res.ok) return { content: GONE.has(res.status) ? game.CANT_POST : game.FAIL_TEXT };
  }
  await store.saveSetup(env.DB, i.guild_id, next);
  return { content: game.setupDone({ ...install, ...next }, now) };
}

async function stats(env, i) {
  const since = game.addDays(game.isoDate(new Date()), -(PERIOD_DAYS - 1));
  const board = await store.periodBoard(env.DB, i.guild_id, since);
  return game.statsMessage(board, await memberNames(env, i.guild_id, board.top.map((r) => r.anon_id)));
}

// Monday's recap of the 7 days before `date`. Skipped when nobody answered.
export async function postRecap(env, install, date) {
  const to = game.addDays(date, -1);
  const week = await store.weekStats(env.DB, install.guild_id, game.addDays(date, -7), to, game.BLUFF_CONF);
  if (!week.answers) return false;
  const days = await store.answerDays(env.DB, install.guild_id, game.addDays(date, -STREAK_LOOKBACK_DAYS), to);
  const best = game.mostCalibrated(week.members);
  const names = await memberNames(env, install.guild_id, best ? [best.anon_id] : []);
  const msg = game.recapMessage({ ...week, streak: game.streak(days, to) }, best, names);
  const res = await discord(env, 'POST', `/channels/${install.channel_id}/messages`, msg);
  if (!res.ok) throw new Error(`recap post returned ${res.status}`);
  return true;
}

// ---- /bluff play ------------------------------------------------------------------------------------------

const deny = (text) => { throw Object.assign(new Error(text), { publicMessage: text }); };
const BUSY = 'That action is still finishing. Try the button again in a moment.';
const nonce = () => crypto.randomUUID().replaceAll('-', '');
const scopeOf = (env, i) => api.anonId(env, 'channel', channelOf(i));

async function openSetup(env, i, mode) {
  const s = { id: nonce(), ...(await who(env, i)), scope: await scopeOf(env, i), mode,
    pack: mode === 'party' ? 'memes' : 'all', difficulty: 'normal', revision: 0, expires_at: Date.now() + LIFETIME };
  await store.createSetup(env.DB, s);
  return { message: game.roundSetup(s), afterEdit: async (msg) => {
    if (!msg?.id) throw new Error('picker message missing');
    await store.bindSetup(env.DB, s.id, msg.id);
  } };
}

async function setupAction(env, i, kind, [id, revision, mode]) {
  const me = await who(env, i);
  const s = await store.getSetup(env.DB, id);
  if (!s || s.anon_id !== me.anon_id || s.scope !== await scopeOf(env, i) || s.message_id !== i.message?.id ||
      !(i.message.flags & EPHEMERAL) || s.expires_at <= Date.now()) deny('This picker has expired. Open /bluff play or /bluff party again.');
  if (kind !== 'ss') {
    if (s.started) deny('This game has already started. Open a new command to choose another game.');
    if (String(s.revision) !== revision) return game.roundSetup(s);
    const value = i.data.values?.[0];
    const pack = kind === 'sp' ? value : s.pack;
    const supported = game.difficulties(pack);
    const difficulty = kind === 'sd' ? value : (supported.includes(s.difficulty) ? s.difficulty : supported[0]);
    if (!game.available(pack, difficulty)) deny('Choose one of the available topics and difficulties.');
    await store.selectSetup(env.DB, s, pack, difficulty);
    return game.roundSetup(await store.getSetup(env.DB, id));
  }
  if (mode !== s.mode || String(s.revision) !== revision) deny('Use Start on the latest version of this picker.');
  if (!game.available(s.pack, s.difficulty)) deny('That topic is unavailable at this difficulty. Open a new picker.');
  if (s.mode === 'party' && !canReplyPublic(i)) deny(PUBLIC_DENIED);
  if (s.started === 2) {
    if (s.mode === 'play') {
      const state = await store.getPlay(env.DB, me.anon_id);
      if (state?.round_id === s.round_id && state.message_id === s.message_id) return playView(env, state);
      deny(game.PLAY_ENDED);
    }
    const p = await env.DB.prepare('SELECT message_id FROM parties WHERE id = ?').bind(s.id).first();
    if (p?.message_id) deny('Your party lobby is already in this chat. Use Join / Resume there.');
    return party.start(env, { ...i, id: s.id }, s.scope, s);
  }
  if (!(await store.claimSetup(env.DB, s, Date.now()))) deny(BUSY);
  try {
    if (s.mode === 'party') {
      const result = await party.start(env, { ...i, id: s.id }, s.scope, s);
      await store.finishSetup(env.DB, s.id, s.id);
      return result;
    }
    const r = await api.quickRound(env, { pack: s.pack, difficulty: s.difficulty });
    const items = api.roundItems(r);
    if (!(await store.startPlay(env.DB, me.anon_id, r.round_id, items, Date.now(), { ...s, setup_id: s.id }))) deny(game.PLAY_ENDED);
    await store.finishSetup(env.DB, s.id, r.round_id);
    return game.playQuestion({ ...s, round_id: r.round_id, items, total: 0 }, 0);
  } catch (err) {
    await store.releaseSetup(env.DB, s.id);
    throw err;
  }
}

async function playFor(env, i, roundId) {
  const me = await who(env, i);
  const state = await store.getPlay(env.DB, me.anon_id);
  if (!state || state.updated_at <= Date.now() - LIFETIME || state.scope !== await scopeOf(env, i) ||
      state.message_id !== i.message?.id || !(i.message.flags & EPHEMERAL)) deny(game.PLAY_ENDED);
  // A delayed button from the same message cannot erase its newer round.
  return { me, state: state.round_id === roundId ? state : null, current: state };
}

function playView(env, state) {
  if (state.done) return game.playEnd(state.done, state.done.challenge_url ? `px:${state.round_id}` : null, installUrl(env), state);
  if (state.last_result) return state.last_result;
  return state.step < state.items.length ? game.playQuestion(state, state.step) : null;
}

async function playChoose(env, i, [roundId, stepText, choiceText]) {
  const { state } = await playFor(env, i, roundId);
  if (!state) return null;
  if (!['0', '1'].includes(choiceText)) deny('Use an answer button.');
  if (state.done || state.last_result || state.step !== Number(stepText) || state.step >= state.items.length) return playView(env, state);
  return game.playConfidence(state, state.step, Number(choiceText));
}

async function playBack(env, i, [roundId, stepText]) {
  const { state } = await playFor(env, i, roundId);
  if (!state) return null;
  if (state.done || state.last_result || !/^\d+$/.test(stepText ?? '') || state.step !== Number(stepText)) return playView(env, state);
  if (state.lease_until > Date.now()) deny(BUSY);
  return playView(env, state);
}

async function playAnswer(env, i, [roundId, stepText, choiceText, confText]) {
  const { me, state } = await playFor(env, i, roundId);
  if (!state) return null;
  if (state.done || state.last_result || state.step !== Number(stepText) || state.step >= state.items.length) return playView(env, state);
  if (!['0', '1'].includes(choiceText) || !['50', '60', '70', '80', '90', '100'].includes(confText)) deny('Use the answer and confidence buttons.');
  const lease = nonce();
  if (!(await store.claimPlay(env.DB, me.anon_id, roundId, state.step, lease, Date.now()))) deny(BUSY);
  try {
    const choice = Number(choiceText), conf = Number(confText);
    const res = await api.answer(env, { round_id: roundId, item_id: state.items[state.step].id, choice, conf,
      rt_ms: Math.max(0, Date.now() - state.updated_at), ...me });
    if (!Number.isFinite(res.points) || typeof res.correct !== 'boolean' || !res.truth) throw new Error('answer response incomplete');
    const total = Math.round(res.total ?? state.total + res.points);
    const result = game.playResult({ ...state, total }, state.step, res.choice ?? choice, res.conf ?? conf, res);
    if (!(await store.savePlayAnswer(env.DB, me.anon_id, roundId, lease, total, result))) return null;
    return result;
  } catch (err) {
    await store.releasePlay(env.DB, me.anon_id, roundId, lease);
    throw err;
  }
}

async function playNext(env, i, [roundId, stepText]) {
  const { me, state } = await playFor(env, i, roundId);
  if (!state) return null;
  if (state.done || state.step !== Number(stepText)) return playView(env, state);
  if (state.step < state.items.length) {
    await store.nextPlayQuestion(env.DB, me.anon_id, roundId, state.step, Date.now());
    return playView(env, await store.getPlay(env.DB, me.anon_id));
  }
  const lease = nonce();
  if (!(await store.claimPlay(env.DB, me.anon_id, roundId, state.step, lease, Date.now()))) deny(BUSY);
  try {
    const done = await api.complete(env, { round_id: roundId, ...me });
    if (!Number.isFinite(done.score) || !Number.isFinite(done.accuracy) || !Number.isFinite(done.mean_conf)) throw new Error('score response incomplete');
    if (!(await store.finishPlay(env.DB, me.anon_id, roundId, lease, done, Date.now()))) return null;
    return playView(env, { ...state, done });
  } catch (err) {
    await store.releasePlay(env.DB, me.anon_id, roundId, lease);
    throw err;
  }
}

async function playAgain(env, i, [roundId]) {
  const { me, state, current } = await playFor(env, i, roundId);
  if (!state) return playView(env, current); // the prior rematch edit may have been lost
  if (!state.done) deny('Finish this round before playing again.');
  const lease = nonce();
  if (!(await store.claimPlay(env.DB, me.anon_id, roundId, state.step, lease, Date.now()))) deny(BUSY);
  try {
    const r = await api.quickRound(env, { rematch: roundId });
    const items = api.roundItems(r);
    if (r.round_id === roundId || items.some((q) => state.items.some((old) => old.id === q.id))) throw new Error('rematch repeated a question');
    if ((r.pack && r.pack !== state.pack) || (r.difficulty && r.difficulty !== state.difficulty)) throw new Error('rematch changed settings');
    const next = { ...r, pack: state.pack, difficulty: state.difficulty };
    if (!(await store.replacePlay(env.DB, me.anon_id, roundId, lease, next, items, Date.now()))) return null;
    return game.playQuestion({ ...next, items, total: 0 }, 0);
  } catch (err) {
    await store.releasePlay(env.DB, me.anon_id, roundId, lease);
    throw err;
  }
}

async function playChallenge(env, i, [roundId]) {
  const { state } = await playFor(env, i, roundId);
  if (!state?.done?.challenge_url) deny(game.PLAY_ENDED);
  const url = new URL(state.done.challenge_url, env.API_BASE);
  const publicBase = new URL(env.API_BASE);
  publicBase.hostname = publicBase.hostname.replace(/^bots\./, '');
  if (url.origin !== publicBase.origin || !url.pathname.startsWith(`/c/${roundId}/`) || !/^\/c\/[\w-]+\/[\w-]+\/?$/.test(url.pathname)) throw new Error('invalid challenge link');
  return game.challengePost(displayName(i.member ?? { user: i.user }), Math.round(state.done.score), url.href);
}

async function playFeedback(env, i, kind, [roundId, stepText, reason]) {
  const { me, state } = await playFor(env, i, roundId);
  if (!state) return null;
  const step = Number(stepText);
  if (!Number.isInteger(step) || step !== state.step - 1 || !state.last_result) deny('Report a question from its answer screen.');
  if (kind === 'pf') return game.feedback(roundId, step);
  if (reason === 'cancel') return state.last_result;
  if (!['wrong', 'ambiguous', 'unit'].includes(reason)) deny('Choose one of the feedback buttons.');
  await api.flag(env, { anon_id: me.anon_id, round_id: roundId, item_id: state.items[step].id, reason });
  return { ...state.last_result, content: state.last_result.content + '\nThanks — reported for review.' };
}
