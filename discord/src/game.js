// Message and component builders (Discord) and all user-facing copy. Pure: no I/O.
import { PACKS, DIFFICULTY_LABELS } from '../../web/public/packs.js';
import { TYPE_NAMES } from '../../web/public/types.js';
import AVAILABILITY from '../../web/public/pack-availability.json' with { type: 'json' };

export const FAIL_TEXT = "Who's Bluffing is taking a break, try again in a minute.";
export const NEED_MANAGE = 'Only members with the Manage Server permission can do that.';
export const CANT_POST =
  "I can't post in that channel. Give Who's Bluffing the View Channel and Send Messages permissions there, or pick another channel.";
export const TOO_LATE = 'Too late: answers for this question are closed.';
export const NOTHING_TO_REVEAL = "There is no question waiting for its answer. Type /bluff question to post today's.";
export const REVEALED = 'Revealed. The answer is on the question post.';
export const PLAY_ENDED = 'This round has ended. Type /bluff play for a new one.';

export const BLUFF_CONF = 80; // a wrong answer at this confidence or more counts as a bluff
export const NO_PINGS = { parse: [] }; // sent with every message: names render, nobody is pinged
// Hours from the post to the reveal for servers added from now on. Rows stored earlier keep the 8 they were given.
export const NEW_REVEAL_DELAY_H = 20;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const isoDate = (d) => d.toISOString().slice(0, 10);
export const addDays = (date, n) => isoDate(new Date(Date.parse(date) + n * DAY_MS));

const LETTERS = ['A', 'B'];
const CONF_ROWS = [[50, 60, 70], [80, 90, 100]];
const CONF_WORDS = { 50: 'coin flip', 100: 'stake it all' };
const NEGATIONS = { is: "It isn't.", was: "It wasn't.", came: "It didn't." };
// The API and stored plays keep the original type keys; result messages use the web's short labels.
const ROUND = "**Who's Bluffing? quick round**";
const MIN_CALIBRATED_ANSWERS = 3;
const MAX_LABEL = 80; // Discord's button label limit

// Discord markdown: escape what formats text or starts a mention, masked link, emoji or timestamp.
export const esc = (s) => String(s ?? '').replace(/[\\*_~`|<>[\]@]/g, '\\$&');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const pct = (k, n) => Math.round((100 * k) / n);
const label = (s) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
const hourText = (h) => `${String(h).padStart(2, '0')}:00 UTC`;
// Discord timestamps render in each reader's own time zone: style t is the clock time, R is "in 3 hours".
const stamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const clock = (ms) => stamp(ms, 't');
const revealText = (iso) => `${stamp(Date.parse(iso), 't')} (${stamp(Date.parse(iso), 'R')})`;
// Today's `hour` o'clock UTC: a real date, so each reader's clock shows the zone's current offset (DST included).
const todayAt = (hour, now) => Math.floor(now / DAY_MS) * DAY_MS + hour * HOUR_MS;
const nameOf = (names, anonId) => esc(names.get(anonId) ?? 'a member');
const button = (customId, text, style = 2) => ({ type: 2, style, custom_id: customId, label: label(text) });
const row = (...components) => ({ type: 1, components });
// A link button (style 5): opens a URL, no interaction comes back. Every reveal and play end carries the install link,
// the mechanism that carried Truth or Dare from 0 to 1.6M servers (docs/TOD_TRACTION.md).
const linkButton = (url, text) => ({ type: 2, style: 5, url, label: label(text) });
export const ADD_LABEL = 'Add to your server';
const option = (q, choice) => `${LETTERS[choice]} · ${esc(choice ? q.b : q.a)}`;
const abButtons = (q, id) => [row(button(id(0), `A · ${q.a}`, 1), button(id(1), `B · ${q.b}`, 1))];
const needsFullOptions = (q) => [q.a, q.b].some((text) => text.length + 4 > MAX_LABEL);
const confLabel = (c) => (CONF_WORDS[c] ? `${c}% · ${CONF_WORDS[c]}` : `${c}%`);
const confButtons = (id) => CONF_ROWS.map((levels) => row(...levels.map((c) => button(id(c), confLabel(c)))));
// <url> inside the link keeps Discord from adding a preview card per source.
const source = (url) => (/^https?:\/\//.test(url ?? '') ? ` ([source](<${url.replace(/[<>\s]/g, '')}>))` : '');

function value(v, unit) {
  if (/year/i.test(unit ?? '')) return String(v); // 1903, not 1,903
  const n = typeof v === 'number' ? v.toLocaleString('en-US') : esc(v);
  return unit ? `${n} ${esc(unit)}` : n;
}

// One option with its true value and source, marked when it is the right answer.
// `truth` = {a_value, b_value, unit, a_source, b_source, correct: 0|1}.
function side(q, truth, i) {
  const opt = i === truth.correct ? `✅ **${option(q, i)}**` : option(q, i);
  return `${opt}: ${value(i ? truth.b_value : truth.a_value, truth.unit)}${source(i ? truth.b_source : truth.a_source)}`;
}

// ---- Daily question ------------------------------------------------------------------------------------------

// The day's question in the channel. Button ids carry what an answer needs: date, round, item, choice.
export function questionPost(q, date, revealAt) {
  return {
    content: `**Who's Bluffing?** · ${esc(q.prompt)}\n-# Tap A or B, then say how sure you are. Answer at ${revealText(revealAt)}.`,
    components: abButtons(q, (choice) => `q:${date}:${q.round_id}:${q.item_id}:${choice}`),
    allowed_mentions: NO_PINGS,
  };
}

export const confidencePicker = (date, roundId, itemId, choice) => ({
  content: `You picked **${LETTERS[choice]}**. Say how sure you are.`,
  components: confButtons((conf) => `c:${date}:${roundId}:${itemId}:${choice}:${conf}`),
});

// `already`: the API no longer takes changes for that day (409), so the earlier answer stands.
export const lockedIn = (choice, conf, revealAt, already = false) => ({
  content: `${already ? 'Already locked in' : 'Locked in'}: ${LETTERS[choice]} at ${conf}%. Reveal at ${revealText(revealAt)}.`,
  components: [],
});

// "Which is longer: the Nile or the Danube?" + a wrong pick of the Danube at 90%:
// "Someone was 90% sure the Danube is longer. It isn't."
export function bluffLine(q, bluff, name) {
  const pick = esc(bluff.choice ? q.b : q.a);
  const m = /^Which (is|was|came) ([^:?]+)/i.exec(q.prompt);
  const verb = m?.[1].toLowerCase();
  const claim = m ? `${pick} ${verb} ${esc(m[2].trim())}. ${NEGATIONS[verb]}` : `it was ${pick}. It wasn't.`;
  return `${name ? esc(name) : 'Someone'} was ${bluff.conf}% sure ${claim}`;
}

// The question post after the reveal: both values with sources, this server's split, top 5 and the bluff line.
export function revealMessage({ q, r, top, names, bluff, roast, installUrl }) {
  const lines = [`**Who's Bluffing?** · ${esc(q.prompt)}`, side(q, r, 0), side(q, r, 1)];
  if (!r.n) {
    lines.push('Nobody here answered this one.');
  } else {
    lines.push(`${r.n} answered · ${Math.round(r.pct_a)}% A · ${Math.round(r.pct_b)}% B`);
    if (top.length) {
      lines.push(`**Top ${top.length}:** ${top.map((t, i) => `${i + 1}. ${nameOf(names, t.anon_id)} ${signed(t.points)}`).join(' · ')}`);
    }
    if (bluff) lines.push(bluffLine(q, bluff, roast ? names.get(bluff.anon_id) : null));
  }
  return { content: lines.join('\n'), components: installUrl ? [row(linkButton(installUrl, ADD_LABEL))] : [], allowed_mentions: NO_PINGS };
}

export const posted = (revealAt) => `Posted. The answer comes out at ${revealText(revealAt)}.`;

export const alreadyPosted = (guildId, post) =>
  post.message_id
    ? `Today's question is already up: https://discord.com/channels/${guildId}/${post.channel_id}/${post.message_id}`
    : "Today's question is being posted right now.";

// ---- Setup, stats, recap -------------------------------------------------------------------------------------

// Posted once when a server adds Who's Bluffing (the install webhook event), before anyone has run a command.
export const playButtons = () => [row(button('start', 'Play solo', 1), button('startparty', 'Play with friends', 1))];
export const WELCOME = {
  content: "Who's Bluffing? is in. Think you know more than your friends?\n\n" +
    '**Play solo:** ten private questions. **Play with friends:** the same ten questions, private answers, shared scores.\n' +
    'Pick a topic and difficulty, then Start. You can also type `/bluff play` or `/bluff party`.\n\n' +
    '**Daily question:** one a day, here. An admin can move it or change the hour with `/bluff setup`.',
  components: playButtons(),
  allowed_mentions: NO_PINGS,
};

export const channelHello = (hour, now) => ({
  content: `Who's Bluffing will post a question here every day at ${clock(todayAt(hour, now))}. Tap A or B, then say how sure you are.\nTry a private ten-question round now, then challenge a friend.`,
  components: playButtons(),
  allowed_mentions: NO_PINGS,
});

// The admin set the hour in UTC, so the UTC hour follows the local one.
export const setupDone = (s, now) =>
  `Done. Who's Bluffing posts a question in <#${s.channel_id}> every day at ${clock(todayAt(s.post_hour_utc, now))} ` +
  `(${hourText(s.post_hour_utc)}) and reveals the answer ${plural(s.reveal_delay_h, 'hour')} later. ` +
  `Roast mode is ${s.roast ? 'on: the reveal names the biggest bluffer' : 'off: the bluffer stays anonymous'}.`;

// `install` = this server's row, or null before it used any command: its reveal delay and, once it has a channel,
// where and when the question goes up.
export function help(install, now, server = true) {
  const intro = '**Play solo:** `/bluff play` for ten private questions.\n' +
    '**Play with friends:** `/bluff party` for the same ten questions. Start the lobby, Join privately, compare scores, then Rematch.\n' +
    'Choose a topic and difficulty, then Start. Tap A or B and say how sure you are.\n' +
    'Points reward honest confidence: 50% scores 0; 100% scores +100 if right and -300 if wrong.';
  if (!server) return `${intro}\n\`/bluff invite\` gives personal and server install links.`;
  const where = install?.channel_id ? `, here in <#${install.channel_id}> at ${clock(todayAt(install.post_hour_utc, now))}` : '';
  const delay = install?.reveal_delay_h ?? NEW_REVEAL_DELAY_H;
  return [
    intro,
    '',
    `**Optional daily question:** one question a day${where}. ` +
      `The answer and this server's top 5 come out ${plural(delay, 'hour')} later. Every Monday brings last week's recap.`,
    '',
    "`/bluff question` post today's question in this channel now",
    "`/bluff stats` this server's leaderboard for the last 30 days",
    "`/bluff invite` get a link to add Who's Bluffing to another server",
    '`/bluff setup` set the daily channel, hour (UTC), reveal (hours until the answer) and roast mode (Manage Server)',
    "`/bluff reveal` reveal today's answer now (Manage Server)",
  ].join('\n');
}

export const invite = (url) => `Add Who's Bluffing to a server: ${url}`;

// The 30-day leaderboard and participation.
export function statsMessage(board, names) {
  if (!board.answers) return { content: "No answers in the last 30 days yet. Type /bluff question to post today's question." };
  const head = `**Who's Bluffing, last 30 days:** ${plural(board.players, 'member')} answered ${plural(board.answers, 'time')} on ${plural(board.days, 'day')}.`;
  const lines = board.top.map((r, i) => `${i + 1}. ${nameOf(names, r.anon_id)} — ${plural(r.points, 'point')} from ${plural(r.answers, 'answer')}`);
  return { content: [head, ...lines].join('\n'), allowed_mentions: NO_PINGS };
}

// Smallest gap between average confidence and hit rate, among members with 3+ answers. Ties: more answers, more points.
export function mostCalibrated(members) {
  const gap = (m) => Math.abs(m.mean_conf - (100 * m.hits) / m.n);
  const ranked = members
    .filter((m) => m.n >= MIN_CALIBRATED_ANSWERS)
    .sort((a, b) => gap(a) - gap(b) || b.n - a.n || b.points - a.points || a.anon_id.localeCompare(b.anon_id));
  return ranked[0] ?? null;
}

// Consecutive days with an answer, ending on `lastDay`. `days` is newest first.
export function streak(days, lastDay) {
  let n = 0;
  while (days[n] === addDays(lastDay, -n)) n += 1;
  return n;
}

// Monday's recap of the previous 7 days.
export function recapMessage(week, best, names) {
  const streakText = week.streak ? ` Streak: ${plural(week.streak, 'day')} in a row.` : '';
  const lines = [
    "**Who's Bluffing? · last week in this server**",
    `${plural(week.answers, 'answer')} from ${plural(week.players, 'member')}.${streakText}`,
    ...week.levels.map((l) => `${l.conf}% sure: right ${pct(l.hits, l.n)}% of the time (${plural(l.n, 'answer')})`),
  ];
  if (best) {
    lines.push(`Most calibrated: ${nameOf(names, best.anon_id)}, ${pct(best.hits, best.n)}% right at ${Math.round(best.mean_conf)}% sure.`);
  }
  lines.push(`Bluffs (${BLUFF_CONF}%+ sure and wrong): ${week.bluffs}`);
  return { content: lines.join('\n'), allowed_mentions: NO_PINGS };
}

// ---- /bluff play (private, one message edited in place) ----------------------------------------------------

export const settingsLabel = ({ pack = 'all', difficulty = 'normal' }) => `${PACKS[pack]?.label ?? pack} · ${DIFFICULTY_LABELS[difficulty] ?? difficulty}`;
const heading = (state) => `${ROUND}${(state.pack && state.pack !== 'all') || (state.difficulty && state.difficulty !== 'normal') ? ` · ${settingsLabel(state)}` : ''}`;
const progress = (state, step) => `${heading(state)} · Question ${step + 1} of ${state.items.length} · ${plural(state.total, 'point')}`;

export const available = (pack, difficulty) => Object.hasOwn(AVAILABILITY, difficulty) && AVAILABILITY[difficulty].includes(pack);
export const difficulties = (pack) => Object.keys(AVAILABILITY).filter((d) => available(pack, d));
export function roundSetup(s) {
  const select = (field, choices, selected) => row({ type: 3, custom_id: `s${field}:${s.id}:${s.revision}`, min_values: 1, max_values: 1,
    options: choices.map(([value, label]) => ({ label, value, default: value === selected })) });
  return {
    content: `**${s.mode === 'party' ? 'Play with friends' : 'Play ten questions'}**\nChoose a topic and difficulty. ${s.mode === 'party' ? 'Start posts a lobby in this chat. Friends join and answer the same ten questions privately.' : 'Your answers and score stay private until you share.'}\n**${settingsLabel(s)}**`,
    components: [
      select('p', Object.entries(PACKS).filter(([p]) => difficulties(p).length).map(([p, v]) => [p, v.label]), s.pack),
      select('d', difficulties(s.pack).map((d) => [d, DIFFICULTY_LABELS[d]]), s.difficulty),
      row(button(`ss:${s.id}:${s.revision}:${s.mode}`, s.mode === 'party' ? 'Start party' : 'Start', 1)),
    ],
  };
}

export function playQuestion(state, step, prefix = 'p') {
  const it = state.items[step];
  return {
    content: `${progress(state, step)}\n${esc(it.prompt)}` + (needsFullOptions(it) ? `\n${option(it, 0)}\n${option(it, 1)}` : ''),
    components: abButtons(it, (choice) => `${prefix}a:${state.round_id}:${step}:${choice}`),
  };
}

export function playConfidence(state, step, choice, prefix = 'p') {
  const it = state.items[step];
  return {
    content: `${progress(state, step)}\n${esc(it.prompt)}\nYou picked **${option(it, choice)}**. ` +
      (step === 0 ? '50% = guessing. 100% = certain. Being confidently wrong costs more. Tap a percentage to lock in.' : 'Say how sure you are.'),
    components: [...confButtons((conf) => `${prefix}c:${state.round_id}:${step}:${choice}:${conf}`),
      row(button(`${prefix}b:${state.round_id}:${step}`, 'Change answer'))],
  };
}

// After a confidence tap: right or wrong, points, both values with sources. `state.total` includes this answer.
export function playResult(state, step, choice, conf, res, prefix = 'p') {
  const it = state.items[step];
  const truth = { ...res.truth, correct: res.correct ? choice : 1 - choice };
  const last = step + 1 === state.items.length;
  return {
    content: [
      `${heading(state)} · Question ${step + 1} of ${state.items.length}`,
      esc(it.prompt),
      `${res.correct ? 'Right' : 'Wrong'} at ${conf}%: **${signed(Math.round(res.points))}** · total ${plural(state.total, 'point')}`,
      side(it, truth, 0),
      side(it, truth, 1),
      ...(truth.fun ? [`**Why this answer**\n${esc(truth.fun)}`] : []),
    ].join('\n'),
    components: [row(button(`${prefix}n:${state.round_id}:${step + 1}`, last ? 'See your score' : 'Next', 1), button(`${prefix}f:${state.round_id}:${step}`, 'Report question'))],
  };
}

export function playEnd(done, challengeId, installUrl, state = {}) {
  const name = esc(Object.hasOwn(TYPE_NAMES, done.type) ? TYPE_NAMES[done.type] : done.type);
  const lines = [
    `${heading(state)} · **${plural(Math.round(done.score), 'point')}**`,
    `${name}\n${Math.round(done.accuracy)}% right at ${Math.round(done.mean_conf)}% sure.`,
  ];
  if (done.roast) lines.push(esc(done.roast));
  if (done.streak > 1) lines.push(`Streak: ${done.streak} days.`);
  const buttons = [button(`pp:${state.round_id}`, 'Play again', 1)];
  if (challengeId) buttons.push(button(challengeId, 'Challenge'));
  if (installUrl) buttons.push(linkButton(installUrl, ADD_LABEL));
  return { content: lines.join('\n'), components: [row(...buttons)] };
}

// Public, because the player pressed Challenge. Their display name comes from that button press and is not stored.
export const challengePost = (name, score, url) => ({
  content: `${esc(name)} scored ${plural(score, 'point')} in a Who's Bluffing round. Can you beat that? ${url}`,
  allowed_mentions: NO_PINGS,
});

// Party messages never put questions, choices or answer feedback in the public lobby.
export function partyLobby(party, board) {
  const scores = board.top.map((p, n) => `${n + 1}. ${esc(p.name)} · ${plural(p.score, 'point')}`);
  return {
    content: [
      `**Who's Bluffing? · ${settingsLabel({ pack: 'memes', ...party })} party**`,
      'Same ten questions. Pick A or B, then say how sure you are. Your answers stay private.',
      '**Join shares your Discord display name and final score here.** No pings.',
      `${board.joined} joined · ${board.finished} finished · Ends ${stamp(party.expires_at, 'R')}.`,
      ...(scores.length ? ['', '**Results** (tap Results to refresh)', ...scores,
        ...(board.finished > 10 ? [`Top 10 of ${board.finished} finished players.`] : [])] : ['Nobody has finished yet.']),
      'Finish a round to unlock Rematch. Friends still playing can finish their original round privately.',
    ].join('\n'),
    components: [row(button(`tj:${party.id}`, 'Join / Resume', 1), button(`tr:${party.id}`, 'Results'), button(`tm:${party.id}`, 'Rematch'))],
    allowed_mentions: NO_PINGS,
  };
}

export const partyDone = (party, player) => ({
  content: `**${esc(player.name)} · ${plural(Math.round(player.done.score), 'point')}**\n` +
    `${esc(Object.hasOwn(TYPE_NAMES, player.done.type) ? TYPE_NAMES[player.done.type] : player.done.type)}\n${Math.round(player.done.accuracy)}% right at ${Math.round(player.done.mean_conf)}% sure.\n` +
    'Compare scores below, or return to the party for a rematch.',
  components: [row(button(`tv:${party.id}`, 'View results'), ...(party.lobby_url ? [linkButton(party.lobby_url, 'Back to party')] : []))],
});

export function feedback(round, step, prefix = 'p') {
  return { content: 'What should we check?', components: [row(...[
    ['wrong', 'Wrong answer'], ['ambiguous', 'Unclear question'], ['unit', 'Values / units'], ['cancel', 'Back'],
  ].map(([reason, label]) => button(`${prefix}g:${round}:${step}:${reason}`, label)))] };
}

export const partyResults = (party, board) => ({
  content: [
    `**${settingsLabel(party)} · Results**`,
    `${board.joined} joined · ${board.finished} finished`,
    ...board.top.map((p, n) => `${n + 1}. ${esc(p.name)} · ${plural(p.score, 'point')}`),
    ...(board.finished > 10 ? [`Top 10 of ${board.finished} finished players.`] : []),
    'Rematch is in the party lobby.',
  ].join('\n'),
  components: [row(button(`tv:${party.id}`, 'Refresh results'), ...(party.lobby_url ? [linkButton(party.lobby_url, 'Back to party')] : []))],
  allowed_mentions: NO_PINGS,
});
