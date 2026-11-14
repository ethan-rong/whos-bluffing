// Who's Bluffing for Discord: the interactions endpoint, the webhook events endpoint (server installs), the install
// redirect, and the hourly tick (reveal what is due, Monday recaps, the daily question for servers whose hour has
// come, then the one automatic channel pick for servers added before installs made it).

import { verifyDiscord } from './verify.js';
import * as api from './api.js';
import * as store from './store.js';
import { channelHello, isoDate } from './game.js';
import { handleInteraction, installUrl, personalInstallUrl, logError, postQuestion, postRecap, revealPost, welcomeGuild } from './commands.js';
import { purge as purgeParties, LIFETIME } from './party-store.js';

export { Presence } from './presence.js';

// The one gateway session that shows the bot as online (presence.js); poking it starts or repairs the connection.
const presence = (env) => env.PRESENCE?.get(env.PRESENCE.idFromName('main')).fetch('https://presence/');

const MAX_BODY = 1 << 20;
const MONDAY = 1;
const CHANNEL_GONE = new Set([403, 404]);
const WEBHOOK_EVENT = 1; // webhook events: 0 = PING, 1 = an event
const USER_INSTALL = 1; // integration_type: 0 = server, 1 = a member's own account
const PICKS_PER_TICK = 3; // 3 servers × (2 reads + up to 5 posts) = at most 21 Discord calls per hourly run

const textResponse = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// Both Discord endpoints: the parsed body of a correctly signed request, or the Response to send instead.
async function signedJson(request, env) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return textResponse('Too large', 413);
  const raw = await request.text();
  const h = request.headers;
  // Discord checks each endpoint with deliberately bad signatures and expects 401.
  if (!(await verifyDiscord(env.DISCORD_PUBLIC_KEY, h.get('x-signature-timestamp'), h.get('x-signature-ed25519'), raw))) {
    return textResponse('Invalid request signature', 401);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return textResponse('Bad request', 400); // not logged: parse errors quote the input
  }
}

async function interactions(request, env, ctx) {
  const interaction = await signedJson(request, env);
  if (interaction instanceof Response) return interaction;
  if (interaction.type === 1) return Response.json({ type: 1 }); // PING -> PONG
  return handleInteraction(interaction, env, ctx);
}

// Webhook events: the PING on save, and APPLICATION_AUTHORIZED for a server install, which registers the server and
// says hello once; the channel that takes the hello becomes the daily channel. Anything else is acknowledged and ignored (an error makes Discord retry and, in the end, drop the
// URL). The D1 write happens before the 204, so if it fails Discord retries; the Discord calls run after it.
async function events(request, env, ctx) {
  const body = await signedJson(request, env);
  if (body instanceof Response) return body;
  const event = (body.type === WEBHOOK_EVENT && body.event) || {};
  const guildId = event.data?.guild?.id;
  if (guildId && event.type === 'APPLICATION_AUTHORIZED' && event.data.integration_type !== USER_INSTALL) {
    // A retry carries the same event timestamp: it finds the hello claimed and posts nothing.
    if (await store.claimWelcome(env.DB, guildId, new Date().toISOString(), event.timestamp ?? '')) {
      const welcome = async () => {
        const channel = await welcomeGuild(env, guildId);
        if (channel) await store.adoptChannel(env.DB, guildId, channel);
      };
      ctx.waitUntil(welcome().catch((err) => logError('welcome', err)));
    }
  }
  // Discord documents this event with `user` only, so it acts only if a server is named. Without it, the next daily
  // post's 403/404 notices the uninstall and clears the channel, as before.
  if (guildId && event.type === 'APPLICATION_DEAUTHORIZED') await store.clearChannel(env.DB, guildId);
  return textResponse(null, 204);
}

// ---- Hourly tick --------------------------------------------------------------------------------------------

async function revealDue(env, now) {
  for (const post of await store.duePosts(env.DB, now.toISOString())) {
    await revealPost(env, post).catch((err) => logError('reveal', err));
  }
}

// ponytail: best effort, a failed recap is not retried that week.
async function recapDue(env, now) {
  if (now.getUTCDay() !== MONDAY) return;
  const date = isoDate(now);
  for (const install of await store.recapInstalls(env.DB, date, now.getUTCHours())) {
    if (!(await store.claimRecap(env.DB, install.guild_id, date))) continue;
    await postRecap(env, install, date).catch((err) => logError('recap', err));
  }
}

// ponytail: sequential posts, fine for a few thousand servers per run; batch them if the run gets long.
async function postDue(env, now) {
  const date = isoDate(now);
  const due = await store.dueInstalls(env.DB, date, now.getUTCHours());
  if (!due.length) return;
  const q = await api.dailyQuestion(env, date);
  for (const install of due) {
    const result = await postQuestion(env, install, install.channel_id, date, q, now).catch((err) => logError('post', err));
    // The channel is gone or Who's Bluffing lost access: stop posting until someone runs /bluff setup again.
    if (CHANNEL_GONE.has(result?.status)) await store.clearChannel(env.DB, install.guild_id);
  }
}

// Servers added before installs picked the daily channel get the same pick once, with the setup hello instead.
// ponytail: one-off backfill; drop this step once no install row has auto_channel NULL without a channel or post.
async function pickDue(env, now) {
  for (const install of await store.unpickedInstalls(env.DB, PICKS_PER_TICK)) {
    if (!(await store.claimPick(env.DB, install.guild_id, now.toISOString()))) continue;
    const channel = await welcomeGuild(env, install.guild_id, channelHello(install.post_hour_utc, now.getTime()))
      .catch((err) => logError('pick', err));
    if (channel) await store.adoptChannel(env.DB, install.guild_id, channel);
  }
}

async function tick(env, now) {
  const cleanup = async () => {
    await purgeParties(env.DB, now.getTime());
    await env.DB.prepare('DELETE FROM play_state WHERE updated_at <= ?').bind(now.getTime() - LIFETIME).run();
    await env.DB.prepare('DELETE FROM round_setups WHERE expires_at <= ?').bind(now.getTime()).run();
  };
  for (const [name, step] of [['cleanup', cleanup], ['reveal', revealDue], ['recap', recapDue], ['post', postDue], ['pick', pickDue]]) {
    await step(env, now).catch((err) => logError(name, err));
  }
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
      if (route === 'POST /interactions') return await interactions(request, env, ctx);
      if (route === 'POST /events') return await events(request, env, ctx);
      if (route === 'GET /install') return Response.redirect(new URL(request.url).searchParams.get('type') === 'user' ? personalInstallUrl(env) : installUrl(env), 302);
      if (route === 'GET /presence') {
        if (!(await env.PRESENCE_LIMITER.limit({ key: 'presence' })).success) {
          return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } });
        }
        return (await presence(env)) ?? textResponse('No presence binding', 503);
      }
      return textResponse('Not found', 404);
    } catch (err) {
      logError('request', err);
      return textResponse('Something went wrong.', 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env, new Date(controller.scheduledTime)));
    ctx.waitUntil(Promise.resolve(presence(env)).catch((err) => logError('presence', err)));
  },
};
