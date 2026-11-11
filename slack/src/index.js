// Who's Bluffing for Slack: OAuth install, slash command, the daily question (A/B → private confidence picker → locked in),
// the reveal, the Monday recap and the hourly cron.
// Slack must get an answer within 3 s, so every handler acks first and does the work in ctx.waitUntil.

import { verifySlack } from './verify.js';
import * as api from './api.js';
import * as store from './store.js';
import * as game from './game.js';
import * as play from './play.js';
import * as playStore from './play-store.js';

const SCOPES = 'commands,chat:write,chat:write.public,channels:read,groups:read,users:read';
const MAX_BODY = 1 << 20;
const DAY_MS = 86_400_000;
const PERIOD_DAYS = 30;
const STREAK_MAX_DAYS = 365;
const REVEAL_WINDOW_DAYS = 7; // a reveal that keeps failing is retried hourly for up to a week
const MAX_MEMBERS = 1000;
const MONDAY = 1;
const DEAD_TOKEN = new Set(['token_revoked', 'account_inactive', 'invalid_auth']);
const SETUP_RE = /^setup(?:\s+<#([CG][A-Z0-9]+)(?:\|[^>]*)?>(?:\s+(\d{1,2})(\s+utc)?)?)?(?:\s+roast\s+(on|off))?(?:\s+reveal\s+(\d{1,2}))?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDate = (date, days) => isoDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
const textResponse = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const ack = () => new Response(null, { status: 200 });
// Logs a short reason only: never request bodies, tokens or env values.
const logError = (where, err) => console.error(`whosbluffing-slack ${where}: ${err?.message ?? err}`);

// Slack Web API. Form-encoded (accepted by every method); object params are JSON-encoded.
async function slack(token, method, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json();
  if (!data.ok) logError(method, { message: data.error });
  return data;
}

// Reply through a response_url: shows to the user (ephemeral by default) without needing channel membership.
const reply = async (url, msg) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, ...msg }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Slack reply returned ${res.status}`);
  return res;
};
const playTransport = { slack, reply };

// Runs `work(install)` after the ack. Any failure becomes the friendly "taking a break" reply.
function background(ctx, env, teamId, url, work) {
  const run = async () => {
    const install = await store.getInstall(env.DB, teamId);
    if (!install) return reply(url, { text: game.NOT_INSTALLED });
    return work(install);
  };
  ctx.waitUntil(run().catch(async (err) => {
    logError('task', err);
    if (url) await reply(url, { text: game.FAIL_TEXT }).catch((e) => logError('reply', e));
  }));
}

// One rule for the reveal time, used by the post, the locked-in reply and the cron: from the day's post if there is
// one, else as if posted now, with the workspace's reveal window.
const revealTime = (install, date, post, now) =>
  game.revealAt(date, install.post_hour_utc, post?.ts ? Number(post.ts) * 1000 : now, install.reveal_delay_h);

// Answers are taken until the day is revealed, for today's and yesterday's question only.
const isOpen = (post, date, now) => !post?.revealed && date >= isoDate(now - DAY_MS);

// With roast mode off, nobody is named next to zero or negative points.
const shown = (install, rows) => (install.roast ? rows : rows.filter((r) => r.points > 0));

// ---- OAuth v2 install --------------------------------------------------------------------------------------

const redirectUri = (request) => new URL('/slack/oauth/callback', request.url).href;

function oauthStart(request, env) {
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.search = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID, scope: SCOPES, redirect_uri: redirectUri(request), state });
  return new Response(null, {
    status: 302,
    headers: { location: url.href, 'set-cookie': `hs_state=${state}; Max-Age=600; Path=/slack/oauth; HttpOnly; Secure; SameSite=Lax` },
  });
}

async function oauthCallback(request, env) {
  const q = new URL(request.url).searchParams;
  const cookieState = /(?:^|;\s*)hs_state=([0-9a-f]{32})/.exec(request.headers.get('cookie') ?? '')?.[1];
  if (!q.get('code') || !cookieState || q.get('state') !== cookieState) {
    return textResponse('The install was cancelled or expired. Please use the Add to Slack link again.', 400);
  }
  const res = await slack(null, 'oauth.v2.access', {
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code: q.get('code'),
    redirect_uri: redirectUri(request),
  });
  if (!res.ok || !res.team?.id || !res.access_token) return textResponse('The install did not work. Please use the Add to Slack link again.', 400);
  await store.saveInstall(env.DB, res.team.id, res.access_token, new Date().toISOString());
  return textResponse("Who's Bluffing is installed. In Slack, type /bluff and choose Play solo or Play with friends. For an optional daily question, use /bluff question or /bluff setup #channel.");
}

// ---- Slash command ------------------------------------------------------------------------------------------

// `setup #channel [HH [utc]] [roast on|off] [reveal N]`, or `setup` with roast and/or reveal alone. Null fields stay
// as they are. `local`: an hour was typed without utc, so it is in the member's own time zone; no hour means
// DEFAULT_HOUR UTC. Null for anything else, including an hour over 23 or a reveal outside 2 to 23.
function parseSetup(args) {
  const m = SETUP_RE.exec(args);
  if (!m || !(m[1] || m[4] || m[5])) return null;
  const hour = m[1] ? Number(m[2] ?? store.DEFAULT_HOUR) : null;
  const reveal = m[5] ? Number(m[5]) : null;
  if (hour > 23 || (reveal !== null && (reveal < game.MIN_REVEAL_H || reveal > game.MAX_REVEAL_H))) return null;
  const roast = m[4] ? Number(m[4].toLowerCase() === 'on') : null;
  return { channel: m[1] ?? null, hour, local: Boolean(m[2] && !m[3]), roast, reveal };
}

function command(f, env, ctx) {
  const args = (f.text ?? '').trim();
  const later = (work) => {
    background(ctx, env, f.team_id, f.response_url, work);
    return ack();
  };
  const sub = args.toLowerCase();
  if (sub === 'play' || sub === 'party') return later((install) => play.start(env, install, f, sub === 'play' ? 'solo' : 'party', playTransport));
  if (sub === '') return later(() => play.launch(f.response_url, playTransport));
  if (sub === 'question') return later((install) => postQuestion(env, install, f.channel_id, f.response_url));
  if (sub === 'stats') return later((install) => showStats(env, install, f.channel_id, f.response_url));
  if (sub === 'reveal') return later((install) => revealNow(env, install, f.response_url));
  const change = parseSetup(args);
  if (change) return later((install) => setup(env, install, change, f.user_id, f.response_url));
  return usage(env, f.team_id);
}

// Anything else: the command list, answered at once, with the workspace's schedule when it has one (one D1 read).
async function usage(env, teamId) {
  const install = await store.getInstall(env.DB, teamId).catch((err) => {
    logError('usage', err);
    return null;
  });
  return Response.json({ response_type: 'ephemeral', text: game.usage(install, Date.now()) });
}

async function postQuestion(env, install, channel, url) {
  const now = Date.now();
  const date = isoDate(now);
  const post = await store.getPost(env.DB, install.team_id, date);
  if (post?.revealed) return reply(url, { text: game.ALREADY_OUT });
  if (post?.channel_id === channel) return reply(url, { text: game.ALREADY_UP });
  const q = await api.getQuestion(env, date);
  const msg = game.questionMessage(q, date, revealTime(install, date, post, now));
  const res = await slack(install.bot_token, 'chat.postMessage', { channel, ...msg });
  if (!res.ok) {
    const noAccess = res.error === 'not_in_channel' || res.error === 'channel_not_found';
    return reply(url, { text: noAccess ? game.CANT_POST : game.FAIL_TEXT });
  }
  // In the chosen channel (or with none chosen yet) it becomes the day's post: the cron skips the day and the reveal
  // edits this message. Elsewhere it is an extra copy whose answers count the same.
  if (!install.channel_id || channel === install.channel_id) await store.claimPost(env.DB, install.team_id, date, channel, q, res.ts);
}

// A typed hour is read in the member's own time zone (users.info's tz_offset) and stored as the UTC hour. With utc,
// or when Slack does not say the zone, it is UTC, and the reply says which.
async function setup(env, install, change, userId, url) {
  if (change.channel) {
    const info = await slack(install.bot_token, 'conversations.info', { channel: change.channel });
    if (!info.ok || info.channel?.is_archived) return reply(url, { text: game.CANT_POST });
  }
  const tzOffset = change.local ? await memberTzOffset(install, userId) : null;
  const hour = tzOffset === null ? change.hour : game.toUtcHour(change.hour, tzOffset);
  await store.setup(env.DB, install.team_id, { ...change, hour });
  const saved = await store.getInstall(env.DB, install.team_id);
  return reply(url, { text: game.setupDone(saved, { tzOffset, noZone: change.local && tzOffset === null, now: Date.now() }) });
}

// Seconds east of UTC from the member's Slack profile, or null when Slack does not say (an error, or no zone).
async function memberTzOffset(install, user) {
  const info = await slack(install.bot_token, 'users.info', { user }).catch((err) => {
    logError('users.info', err);
    return {};
  });
  return info.ok && Number.isFinite(info.user?.tz_offset) ? info.user.tz_offset : null;
}

async function showStats(env, install, channel, url) {
  const board = await store.periodBoard(env.DB, install.team_id, isoDate(Date.now() - (PERIOD_DAYS - 1) * DAY_MS));
  const rows = shown(install, board.top);
  const names = await displayNames(env, install, channel, rows.map((r) => r.anon_id));
  return reply(url, { response_type: 'in_channel', ...game.statsMessage(board, rows, names) });
}

async function revealNow(env, install, url) {
  const now = Date.now();
  const [post] = await store.openPosts(env.DB, isoDate(now - REVEAL_WINDOW_DAYS * DAY_MS), install.team_id);
  if (!post) {
    const today = await store.getPost(env.DB, install.team_id, isoDate(now));
    return reply(url, { text: today?.revealed ? game.ALREADY_OUT : game.NOTHING_TO_REVEAL });
  }
  if (!(await revealDay(env, post))) return reply(url, { text: game.ALREADY_OUT });
  return reply(url, { text: `Revealed in <#${post.channel_id}>.` });
}

// Names exist only at render time: hash the channel's members, match them to the stored ids, look up matches.
// ponytail: first 1000 channel members only; paginate conversations.members if bigger channels need names.
async function displayNames(env, install, channel, anonIds) {
  const names = new Map();
  if (!anonIds.length) return names;
  const wanted = new Set(anonIds);
  const res = await slack(install.bot_token, 'conversations.members', { channel, limit: MAX_MEMBERS });
  for (const user of res.members ?? []) {
    const anon = await api.anonId(env, install.team_id, user);
    if (!wanted.has(anon)) continue;
    const info = await slack(install.bot_token, 'users.info', { user });
    if (info.ok) names.set(anon, info.user.profile?.display_name || info.user.real_name || info.user.name);
    if (names.size === wanted.size) break;
  }
  return names;
}

// ---- A/B tap, confidence tap --------------------------------------------------------------------------------

function interaction(p, env, ctx) {
  const action = p.type === 'block_actions' ? p.actions?.[0] : null;
  const [kind, arg] = String(action?.action_id ?? '').split(':');
  if (kind === 'play') {
    if (arg !== 'settings') background(ctx, env, p.team?.id, p.response_url, (install) => play.action(env, install, p, playTransport));
    return ack();
  }
  if (kind !== game.PICK && kind !== game.CONF) return ack();
  const now = Date.now();
  background(ctx, env, p.team?.id, p.response_url, (install) =>
    (kind === game.PICK ? showPicker : lockIn)(env, install, p, action, Number(arg), now));
  return ack();
}

// Button values are ours, but check them anyway: {r: round id, i: item id, d: date, c?: choice, t?: A/B tap time}.
function readValue(action) {
  const v = JSON.parse(action.value ?? 'null');
  if (typeof v?.r !== 'string' || typeof v.i !== 'string' || !DATE_RE.test(v.d ?? '')) throw new Error('bad button value');
  return v;
}

// A or B: send the private confidence picker (or say the question is closed).
async function showPicker(env, install, p, action, choice, now) {
  const v = readValue(action);
  if (choice !== 0 && choice !== 1) throw new Error('bad choice');
  const post = await store.getPost(env.DB, install.team_id, v.d);
  if (!isOpen(post, v.d, now)) return reply(p.response_url, { text: game.CLOSED });
  const existing = await store.getAnswer(env.DB, install.team_id, await api.anonId(env, install.team_id, p.user.id), v.d);
  const pick = { r: v.r, i: v.i, d: v.d, c: choice, t: now };
  return reply(p.response_url, game.pickerMessage(pick, action.text?.text ?? game.LETTERS[choice], existing));
}

// A confidence: send the answer (a change of mind is a revision), keep the latest, and replace the picker with
// "Locked in". The API answers {locked, points_pending}: right or wrong and points only come with the reveal.
async function lockIn(env, install, p, action, conf, now) {
  const v = readValue(action);
  if (!game.CONFS.includes(conf) || (v.c !== 0 && v.c !== 1)) throw new Error('bad confidence tap');
  const done = (text) => reply(p.response_url, { text, replace_original: true });
  const post = await store.getPost(env.DB, install.team_id, v.d);
  if (!isOpen(post, v.d, now)) return done(game.CLOSED);
  const [anon, community] = await Promise.all([api.anonId(env, install.team_id, p.user.id), api.communityId(env, install.team_id)]);
  const existing = await store.getAnswer(env.DB, install.team_id, anon, v.d);
  const when = revealTime(install, v.d, post, now);
  try {
    await api.answer(env, {
      round_id: v.r, item_id: v.i, choice: v.c, conf, rt_ms: Math.max(0, now - (Number(v.t) || now)), anon_id: anon, community,
      // An earlier API write may have succeeded before local storage failed. Open daily answers are editable;
      // always mark the current choice as a revision so our local lock and the API cannot disagree on retry.
      revision: true,
    });
  } catch (err) {
    // 409 locked (the question's day is over) or 404 unknown round or item: the API refused the answer.
    if (err.status !== 409 && err.status !== 404) throw err;
    logError('answer', err);
    return done(existing ? game.alreadyLockedIn(existing, when) : game.CLOSED);
  }
  await store.saveAnswer(env.DB, install.team_id, anon, v.d, { choice: v.c, conf });
  return done(game.lockedIn(v.c, conf, when));
}

// ---- Reveal -------------------------------------------------------------------------------------------------

// The API's biggest bluff, if it is one: a wrong answer at BLUFF_CONF or more.
const bluffOf = (r) => {
  const b = r.biggest_bluff;
  return b?.conf >= game.BLUFF_CONF && b.choice !== r.correct ? b : null;
};

// Edits the day's post into the reveal, drawn from the question stored with the post (no daily-question call, so a
// late reveal works). Scores the day's answers from the revealed answer first. `row` = an openPosts row (post and
// install fields). Returns false when another run revealed it first; on any failure the day is left unrevealed so
// the next run (or /bluff reveal) retries.
async function revealDay(env, row) {
  if (!(await store.claimReveal(env.DB, row.team_id, row.date))) return false;
  try {
    const r = await api.getReveal(env, row.date, await api.communityId(env, row.team_id));
    if (r?.correct !== 0 && r?.correct !== 1) throw new Error('bad reveal response');
    await store.scoreDay(env.DB, row.team_id, row.date, r.correct);
    const rows = shown(row, await store.dayTop(env.DB, row.team_id, row.date));
    const bluff = bluffOf(r);
    const named = row.roast && bluff ? [bluff.anon_id] : []; // roast off: the bluffer's name is never looked up
    const names = await displayNames(env, row, row.channel_id, [...rows.map((x) => x.anon_id), ...named]);
    const msg = game.revealMessage(row, r, rows, names, bluff && { ...bluff, name: named.length ? names.get(bluff.anon_id) : null });
    const res = await slack(row.bot_token, 'chat.update', { channel: row.channel_id, ts: row.ts, ...msg });
    if (!res.ok) throw new Error(`chat.update ${res.error}`);
    return true;
  } catch (err) {
    await store.dropReveal(env.DB, row.team_id, row.date);
    throw err;
  }
}

// ---- Hourly cron --------------------------------------------------------------------------------------------

// ponytail: sequential Slack calls, fine for a few thousand workspaces per run; batch them if the run gets long.
async function revealDue(env, now) {
  for (const row of await store.openPosts(env.DB, isoDate(now - REVEAL_WINDOW_DAYS * DAY_MS))) {
    if (now < revealTime(row, row.date, row, now)) continue;
    await revealDay(env, row).catch((err) => logError('reveal', err));
  }
}

// Consecutive days with answers, counting back from `last` (dates newest first).
function streak(dates, last) {
  let n = 0;
  while (dates[n] === shiftDate(last, -n)) n += 1;
  return n;
}

// Mondays: last week's recap, once per install (claimed in installs.recap_week), skipped when nobody answered.
async function postRecaps(env, now) {
  const d = new Date(now);
  if (d.getUTCDay() !== MONDAY) return;
  const monday = isoDate(now);
  const from = shiftDate(monday, -7);
  const to = shiftDate(monday, -1);
  for (const install of await store.recapDue(env.DB, monday, d.getUTCHours())) {
    if (!(await store.claimRecap(env.DB, install.team_id, monday))) continue;
    try {
      const week = await store.weekStats(env.DB, install.team_id, from, to);
      if (!week.answers) continue;
      const dates = await store.playedDates(env.DB, install.team_id, shiftDate(to, -STREAK_MAX_DAYS), to);
      const names = await displayNames(env, install, install.channel_id, week.best ? [week.best.anon_id] : []);
      const msg = game.recapMessage({ ...week, from, to, streak: streak(dates, to) }, names);
      const res = await slack(install.bot_token, 'chat.postMessage', { channel: install.channel_id, ...msg });
      if (!res.ok) throw new Error(`recap ${res.error}`);
    } catch (err) {
      await store.dropRecap(env.DB, install.team_id, monday);
      logError('recap', err);
    }
  }
}

// Posts today's question to every install whose UTC hour has come, once per day (claim in `posts` first).
async function postDaily(env, now) {
  const date = isoDate(now);
  const due = await store.dueInstalls(env.DB, date, new Date(now).getUTCHours());
  if (!due.length) return;
  const q = await api.getQuestion(env, date);
  for (const install of due) {
    if (!(await store.claimPost(env.DB, install.team_id, date, install.channel_id, q))) continue;
    try {
      const msg = game.questionMessage(q, date, revealTime(install, date, null, now));
      const res = await slack(install.bot_token, 'chat.postMessage', { channel: install.channel_id, ...msg });
      if (res.ok && typeof res.ts === 'string' && res.ts) {
        await store.setPost(env.DB, install.team_id, date, res.ts);
        continue;
      }
      if (DEAD_TOKEN.has(res.error)) await store.deleteInstall(env.DB, install.team_id);
      throw new Error(`daily post ${res.error}`);
    } catch (err) {
      // Fetch/JSON errors must release the claim too, and must not skip other workspaces.
      await store.dropClaim(env.DB, install.team_id, date);
      logError('daily post', err);
    }
  }
}

// Reveals first (so Sunday's answer is out before Monday's recap), then the recap, then the new question.
async function hourly(env, now) {
  await playStore.purge(env.DB, now).catch((err) => logError('round cleanup', err));
  await revealDue(env, now).catch((err) => logError('reveal', err));
  await postRecaps(env, now).catch((err) => logError('recap', err));
  await postDaily(env, now).catch((err) => logError('cron', err));
}

// ---- Router -------------------------------------------------------------------------------------------------

async function events(request, env, ctx) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return textResponse('Too large', 413);
  const raw = await request.text();
  const h = request.headers;
  if (!(await verifySlack(env.SLACK_SIGNING_SECRET, h.get('x-slack-request-timestamp'), h.get('x-slack-signature'), raw))) {
    return textResponse('Invalid signature', 401);
  }
  const form = new URLSearchParams(raw);
  if (!form.has('payload')) return command(Object.fromEntries(form), env, ctx);
  let payload;
  try {
    payload = JSON.parse(form.get('payload'));
  } catch {
    return textResponse('Bad request', 400); // not logged: parse errors quote the input
  }
  return interaction(payload, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.REQUEST_LIMITER.limit({ key: ip })).success) {
        return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } });
      }
      const { pathname } = new URL(request.url);
      const route = `${request.method} ${pathname}`;
      if (route === 'GET /slack/oauth/start') return oauthStart(request, env);
      if (route === 'GET /slack/oauth/callback') return await oauthCallback(request, env);
      if (route === 'POST /slack/events') return await events(request, env, ctx);
      return textResponse('Not found', 404);
    } catch (err) {
      logError('request', err);
      return textResponse('Something went wrong.', 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(hourly(env, controller.scheduledTime));
  },
};
