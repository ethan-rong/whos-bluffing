// Rounds at /play and on challenge pages (/c/<round>/<token>): ten comparison pairs per round. Pick A or B, say how sure
// you are, see both values and sources at once, with a line from the game (reactions.js), a sound (sound.js) and a
// little motion (motion.js); at the end your score, the result grid, type, calibration chart and challenge link.
// Scoring is server-side (docs/api-rounds.md). Local state: whosbluffing_anon (ui.js), whosbluffing_seen_pairs (the newest 300 pair ids
// played; the server keeps the last 300 it is sent), whosbluffing_round (the round in progress, so a reload resumes),
// whosbluffing_nick (optional name for challenge links), whosbluffing_dares ({round_id: score} of finished dares);
// pack and difficulty in picker.js, the lab after AI rounds (whosbluffing_lab) in
// round-end.js, sound in site.js.
import { html, api, store, anonId, calibrationChart, chartLabels, signed } from './ui.js';
import { bins } from './metrics.js';
import { renderRoundShare } from './share.js';
import { initPicker, rememberChoice, quickLabel, shareWith } from './picker.js';
import { pickReaction, bestLine } from './reactions.js';
import { createSound } from './sound.js';
import { countTo, raceTo, confetti, dealCards, reducedMotion } from './motion.js';
import { resultGrid, wireGrid, fmtValue, fmtPoints, boardOf, sideBlock, wireSide, savedSide, withSideLine, dareRankLabel, dareDone } from './round-end.js';
import { typeName } from './types.js';
import { recentGames, recentGame, rememberGame } from './recent-games.js';

export { fmtValue, fmtPoints };

const SEEN_KEY = 'whosbluffing_seen_pairs';
const ROUND_KEY = 'whosbluffing_round';
const NICK_KEY = 'whosbluffing_nick';
const DARES_KEY = 'whosbluffing_dares';
const MAX_SEEN = 300;
const CONFS = [50, 60, 70, 80, 90, 100];
const CONF_KEYS = { 5: 50, 6: 60, 7: 70, 8: 80, 9: 90, 0: 100 }; // keyboard: the tens digit, 0 = 100%
const CONFIDENT_MISS = 70; // a wrong answer at this confidence or more flashes red
const MIN_BINS = 9; // leaderboard bars shown at least
const TYPES = { Bluffer: 'bluffer', 'Hot-headed': 'hot_headed', Calibrated: 'calibrated', Modest: 'modest', Hedger: 'hedger' };
const SPEAKER = html`<svg class="i i-snd-on" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg><svg class="i i-snd-off" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>`;
const homeLink = (t) => html`<a class="icon-btn" href="/" aria-label="${t('rounds.home')}" title="${t('rounds.home')}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9"/></svg></a>`;

const todayUTC = () => new Date().toISOString().slice(0, 10);
const fmtTotal = (n) => (n < 0 ? `−${-n}` : String(n));
export const typeKey = (type) => `rounds.type_${TYPES[type] ?? 'calibrated'}`;
const site = () => globalThis.window?.whosbluffing; // site.js: class mode and the sound setting
const sound = createSound({ isOn: () => site()?.soundOn() ?? true });
let picker = null;

// The newest MAX_SEEN ids, oldest first (the order the server trims from).
export function addSeen(seen, ids) {
  const fresh = seen.filter((id) => !ids.includes(id));
  return [...fresh, ...ids].slice(-MAX_SEEN);
}

// Bars for 100-point bins (from /api/round/stats), trimmed to where anyone scored; `mine` = your score or null.
// The bars grow up from the baseline (anim-grow).
export function scoreChart(stats, mine, title) {
  const counts = stats.score_hist;
  const binOf = (s) => Math.min(counts.length - 1, Math.floor((s - stats.bin_from) / stats.bin_width));
  const used = counts.map((c, k) => (c > 0 || (mine != null && k === binOf(mine)) ? k : null)).filter((k) => k !== null);
  if (!used.length) return '';
  let lo = Math.max(0, used[0] - 1);
  let hi = Math.min(counts.length - 1, used.at(-1) + 1);
  while (hi - lo + 1 < MIN_BINS && (lo > 0 || hi < counts.length - 1)) { // a few players should not draw one huge bar
    if (lo > 0) lo -= 1;
    if (hi - lo + 1 < MIN_BINS && hi < counts.length - 1) hi += 1;
  }
  const shown = counts.slice(lo, hi + 1);
  const W = 320, H = 160, L = 6, R = 6, T = 18, B = 26;
  const bw = (W - L - R) / shown.length;
  const max = Math.max(1, ...shown);
  const r1 = (x) => Math.round(x * 10) / 10;
  const every = Math.ceil(shown.length / 6); // at most ~6 axis labels
  const bars = shown.map((c, j) => {
    const k = lo + j;
    const h = r1(((H - T - B) * c) / max);
    const from = stats.bin_from + k * stats.bin_width;
    const isMine = mine != null && k === binOf(mine);
    return html`<rect class="bar anim anim-grow${isMine ? ' mine' : ''}" x="${r1(L + j * bw + 1)}" y="${r1(H - B - h)}" width="${r1(Math.max(1, bw - 2))}" height="${h}"><title>${from} to ${from + stats.bin_width - 1}: ${c}</title></rect>
${j % every === 0 ? html`<text class="axis" x="${r1(L + j * bw + bw / 2)}" y="${H - 8}" text-anchor="middle">${from}</text>` : ''}`;
  });
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><title>${title}</title>${bars}</svg>`;
}

// "Today's ranked round", "Challenge", or "Quick round · Geography · Brutal".
export function roundLabel(t, st) {
  if (st.mode === 'ranked') return t('rounds.ranked');
  if (st.challenge) return t('rounds.challenge_round');
  return `${t('rounds.quick')} · ${quickLabel(st.pack, st.difficulty)}`;
}

const loadRound = () => store.get(ROUND_KEY, null);
const saveRound = (st) => store.set(ROUND_KEY, st);
const clearRound = () => store.set(ROUND_KEY, null);

function retryScreen(ctx, message, again) {
  keys = null;
  ctx.app.innerHTML = html`<p class="msg" role="alert">${message}</p><button class="primary block" type="button">${ctx.t('rounds.retry')}</button>`;
  ctx.app.querySelector('button').onclick = again;
}

// --- keyboard: A/B pick, 5-9 and 0 say how sure, N or Enter goes on (commands.json, "Web shortcuts") ---------------

let keys = null; // the current screen's handler, or null
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!keys || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    keys(e.key.toLowerCase(), e);
  });
}

// --- one item ---------------------------------------------------------------------------------------------------

function head(t, st, k) {
  return html`<div class="round-head">
  <span class="badge">${roundLabel(t, st)}</span>
  <span class="round-tools"><span class="round-total" aria-label="${t('rounds.total_label')}"><b class="anim" data-total>${fmtTotal(st.total)}</b> ${t('rounds.pts')}</span>
  <button class="icon-btn" type="button" data-sound-toggle aria-pressed="${String(site()?.soundOn() ?? true)}" aria-label="${t('rounds.sound')}">${SPEAKER}</button></span>
</div>
<div class="progress"><progress value="${k}" max="${st.items.length}" aria-hidden="true"></progress><span>${t('rounds.progress', { i: k + 1, n: st.items.length })}</span></div>`;
}

function showItem(ctx, st, k) {
  const { app, t } = ctx;
  const item = st.items[k];
  const t0 = performance.now();
  app.innerHTML = html`${head(t, st, k)}
<h2 class="q" tabindex="-1">${item.prompt}</h2>
<div class="picks">${[item.a, item.b].map((name, c) => html`<button type="button" class="pick" data-c="${c}" aria-pressed="false"><span class="letter" aria-hidden="true">${'AB'[c]}</span><span class="name">${name}</span></button>`)}</div>
<div id="conf" hidden>
  <p class="sub">${t(k === 0 ? 'rounds.confidence_hint' : 'rounds.how_sure')}</p>
  <div class="conf" role="group" aria-label="${t('rounds.how_sure')}">${CONFS.map((c) => html`<button type="button" class="anim" data-conf="${c}" aria-pressed="false">${c}%</button>`)}</div>
  <p class="ends"><span>${t('rounds.coin_flip')}</span><span>${t('rounds.stake')}</span></p>
</div>`;
  app.querySelector('.q').focus();
  let choice = null;
  const picks = [...app.querySelectorAll('.pick')];
  for (const b of picks) {
    b.onclick = () => {
      choice = Number(b.dataset.c);
      for (const o of picks) o.setAttribute('aria-pressed', String(o === b));
      app.querySelector('#conf').hidden = false;
    };
  }
  const confButtons = [...app.querySelectorAll('[data-conf]')];
  for (const b of confButtons) {
    b.onclick = () => {
      if (choice === null) return;
      sound.tick(); // inside the tap, so the audio context may start
      b.setAttribute('aria-pressed', 'true'); // the chosen one stays raised while the answer is sent
      for (const x of app.querySelectorAll('button:not([data-sound-toggle])')) x.disabled = true;
      keys = null;
      sendAnswer(ctx, st, k, choice, Number(b.dataset.conf), Math.round(performance.now() - t0));
    };
  }
  keys = (key) => {
    if (key === 'a' || key === 'b') picks['ab'.indexOf(key)].click();
    else if (key in CONF_KEYS && choice !== null) confButtons.find((b) => Number(b.dataset.conf) === CONF_KEYS[key]).click();
  };
}

async function sendAnswer(ctx, st, k, choice, conf, rtMs) {
  const item = st.items[k];
  const r = await api('/api/round/answer', {
    method: 'POST', body: { round_id: st.round_id, item_id: item.id, choice, conf, rt_ms: rtMs, anon_id: anonId(), surface: 'web' },
  });
  if (!r.ok) return retryScreen(ctx, r.status === 400 ? r.data?.error ?? ctx.t('rounds.offline') : ctx.t('rounds.offline'), () => showItem(ctx, st, k));
  // The server keeps the first answer; show what it scored (a resend after a lost reply returns that one).
  const a = { choice: r.data.choice, conf: r.data.conf, correct: r.data.correct, points: r.data.points, truth: r.data.truth };
  const sofar = st.items.slice(0, k).map((i) => st.answers[i.id]).filter(Boolean);
  const used = new Set(Object.values(st.answers).map((x) => x.template).filter(Boolean));
  const said = pickReaction([...sofar, a], sofar.length, st.items.length, used, { mild: Boolean(site()?.classMode) });
  const before = st.total;
  const next = { ...st, total: r.data.total, answers: { ...st.answers, [item.id]: { ...a, line: said.text, template: said.template } } };
  saveRound(next);
  return showReveal(ctx, next, k, before);
}

// The reveal of answer k: both values with sources, the verdict and the points counting to their value (then the
// pair's "Did you know" fact, when it has one), the game's line, and the motion that goes with it (a green sweep and confetti when right, a shake, a red flash and a BLUFF stamp
// when wrong, a gold "Called it" at 100% right). Sounds: a ding or a womp.
function showReveal(ctx, st, k, before) {
  const { app, t } = ctx;
  const item = st.items[k];
  const a = st.answers[item.id];
  const truthIndex = a.correct ? a.choice : 1 - a.choice;
  const values = [a.truth.a_value, a.truth.b_value];
  const sources = [a.truth.a_source, a.truth.b_source];
  const last = k + 1 === st.items.length;
  const motion = (c) => {
    if (c === truthIndex) return ' anim anim-sweep';
    if (c === a.choice) return ` anim anim-shake${a.conf >= CONFIDENT_MISS ? ' anim-flash' : ''}`;
    return '';
  };
  const stamp = (c) => {
    if (!a.correct && c === a.choice) return html`<span class="stamp stamp-bluff anim anim-stamp" data-stake="${a.conf}" aria-hidden="true">${t('rounds.stamp_bluff')}</span>`;
    if (a.correct && a.conf === 100 && c === truthIndex) return html`<span class="stamp stamp-called anim anim-stamp" aria-hidden="true">${t('rounds.stamp_called')}</span>`;
    return '';
  };
  app.innerHTML = html`${head(t, { ...st, total: before }, k)}
<h2 class="q">${item.prompt}</h2>
<div class="picks revealed">${[item.a, item.b].map((name, c) => html`<div class="pick${c === truthIndex ? ' is-true' : ''}${c === a.choice ? ' is-chosen' : ''}${motion(c)}">
  <span class="letter" aria-hidden="true">${c === truthIndex ? '✓' : 'AB'[c]}</span>
  <span class="name">${name}<span class="value">${fmtValue(values[c], a.truth.unit)}</span><a class="src" href="${sources[c]}" target="_blank" rel="noopener noreferrer">${t('rounds.source')}</a></span>${stamp(c)}
</div>`)}</div>
<section class="reveal anim ${a.correct ? 'is-hit anim-hit' : 'is-miss anim-miss'}" aria-live="polite">
  <p class="verdict">${a.correct ? `✓ ${t('rounds.right')}` : `✗ ${t('rounds.wrong')}`} <span class="muted">${t('rounds.at_conf', { conf: a.conf })}</span></p>
  <p class="pts anim ${a.correct ? 'anim-pop' : 'anim-shake'} ${a.points > 0 ? 'up' : a.points < 0 ? 'down' : ''}" data-points>${fmtPoints(a.points)}</p>
  ${a.line ? html`<p class="reaction">${a.line}</p>` : ''}
</section>
${a.truth.fun ? html`<p class="fun"><span class="fun-label">${t('rounds.fun_label')}</span> ${a.truth.fun}</p>` : ''}
<button id="next" class="primary block" type="button">${last ? t('rounds.see_score') : t('rounds.next')}</button>
<div id="flag"></div>`;
  if (a.correct) sound.ding(a.conf); else sound.womp(a.conf);
  if (a.correct) confetti(app.querySelector('.reveal'), { big: a.conf === 100 });
  countTo(app.querySelector('[data-points]'), 0, a.points, { format: fmtPoints });
  const total = app.querySelector('[data-total]');
  countTo(total, before, st.total, { ms: 450, format: fmtTotal }).then(() => { if (before !== st.total) total.classList.add('anim-tick'); });
  const nextBtn = app.querySelector('#next');
  nextBtn.onclick = () => (last ? finish(ctx, st) : step(ctx, st));
  nextBtn.focus({ preventScroll: true });
  keys = (key, e) => { if (key === 'n' || (key === 'enter' && !e.target.closest?.('button, a, summary'))) nextBtn.click(); };
  flagForm(ctx, app.querySelector('#flag'), item.id, st.round_id);
}

function flagForm(ctx, el, itemId, roundId) {
  const { t } = ctx;
  el.innerHTML = html`<details class="flag"><summary>${t('rounds.flag')}</summary>
<form class="row" novalidate><input name="reason" maxlength="280" autocomplete="off" placeholder="${t('rounds.flag_reason')}" aria-label="${t('rounds.flag_reason')}"><button type="submit">${t('rounds.flag_send')}</button></form>
<p class="msg ok" role="status"></p></details>`;
  const form = el.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('/api/flag', { method: 'POST', body: { item_id: itemId, round_id: roundId, anon_id: anonId(), reason: form.reason.value.trim() } });
    el.querySelector('.msg').textContent = r.ok ? t('rounds.flag_thanks') : t('rounds.flag_failed');
    if (r.ok) form.hidden = true;
  };
}

// Next unanswered pair, or the end of the round.
function step(ctx, st) {
  const k = st.items.findIndex((it) => !st.answers[it.id]);
  if (k === -1) return finish(ctx, st);
  ctx.chrome(false);
  window.scrollTo(0, 0);
  return showItem(ctx, st, k);
}

// --- starting rounds ----------------------------------------------------------------------------------------------

async function begin(ctx, round, extra = {}) {
  if (!round.items.length) return retryScreen(ctx, ctx.t('rounds.failed'), () => location.reload());
  const st = { round_id: round.round_id, mode: round.mode, date: round.date, items: round.items, answers: {}, total: 0,
    ...(round.mode === 'quick' && { pack: round.pack ?? 'all', difficulty: round.difficulty ?? 'normal' }), ...extra };
  if (st.mode === 'quick') rememberChoice(st);
  saveRound(st);
  sound.unlock();
  keys = null;
  ctx.chrome(false);
  window.scrollTo(0, 0);
  if (!reducedMotion()) {
    ctx.app.innerHTML = html`<section class="round-deal">
  <h2 tabindex="-1">${ctx.t('rounds.deal_title', { n: st.items.length })}</h2>
  <p class="muted" role="status">${ctx.t('rounds.deal_status')}</p>
  <div class="deal-deck" aria-hidden="true">${st.items.map((_, i) => html`<span class="deal-card anim"><b>${String(i + 1).padStart(2, '0')}</b><span>◆</span></span>`)}</div>
  <button type="button" data-skip-deal>${ctx.t('rounds.deal_skip')}</button>
</section>`;
    const intro = ctx.app.querySelector('.round-deal');
    intro.querySelector('h2').focus();
    await dealCards(intro.querySelector('.deal-deck'), intro.querySelector('[data-skip-deal]'), () => sound.tick());
    if (!intro.isConnected) return;
  }
  return step(ctx, st);
}

// A new quick round in the chosen pack and difficulty, fetched on the tap (creating one writes a row, so it is never
// prefetched). A choice the server refuses (a pack that no longer fills that difficulty) falls back to All, Normal.
async function playQuick(ctx, rematch = null) {
  bindKeys();
  sound.unlock();
  ctx.chrome(false);
  window.scrollTo(0, 0);
  ctx.app.innerHTML = html`<p class="muted" role="status">${ctx.t('rounds.loading')}</p>`;
  const seen = encodeURIComponent(store.get(SEEN_KEY, []).join(','));
  const { pack, difficulty } = (picker ??= initPicker()).current();
  let r = await api(`/api/round?mode=quick&pack=${encodeURIComponent(pack)}&difficulty=${encodeURIComponent(difficulty)}&seen=${seen}${rematch ? `&rematch=${encodeURIComponent(rematch)}` : ''}`);
  if (r.status === 400 && !rematch) r = await api(`/api/round?mode=quick&seen=${seen}`);
  if (!r.ok) {
    ctx.chrome(true);
    return retryScreen(ctx, ctx.t('rounds.failed'), () => playQuick(ctx, rematch));
  }
  if (location.pathname !== '/play') history.pushState({}, '', '/play');
  return begin(ctx, r.data);
}

// --- the end of a round -----------------------------------------------------------------------------------------

async function finish(ctx, st) {
  const { app, t } = ctx;
  keys = null;
  app.innerHTML = html`<p class="muted" role="status">${t('rounds.sending')}</p>`;
  const nick = store.get(NICK_KEY, null);
  const body = { round_id: st.round_id, anon_id: anonId(), surface: 'web' };
  if (nick) body.nickname = nick;
  if (st.challenge) body.challenge = st.challenge;
  const r = await api('/api/round/complete', { method: 'POST', body });
  if (!r.ok) return retryScreen(ctx, t('rounds.offline'), () => finish(ctx, st));
  // A dare is played once and stays out of the quick rounds' seen pairs; its link is its page, not a challenge token.
  if (r.data.dare) store.set(DARES_KEY, { ...store.get(DARES_KEY, {}), [st.round_id]: r.data.score });
  else store.set(SEEN_KEY, addSeen(store.get(SEEN_KEY, []), st.items.map((i) => i.id)));
  const saveFailed = !rememberGame(st, r.data);
  clearRound();
  // Keep this tab's result even when browser storage is unavailable.
  history.pushState({ round: st, result: r.data, saveFailed }, '', '/results');
  return showEnd(ctx, st, r.data, { saveFailed });
}

// The end screen's three tiles; the numbers count up from 0 (data-to).
function counters(t, res) {
  const tile = (to, prefix, suffix, label) => html`<div><b class="anim" data-to="${to}" data-prefix="${prefix}" data-suffix="${suffix}">${prefix}${to}${suffix}</b><span>${label}</span></div>`;
  return html`<div class="counters">
  ${tile(res.streak, '', '', t('rounds.streak'))}
  ${res.dare ? tile(res.rank, '#', '', dareRankLabel(res.players, res.dare.address))
      : tile(Math.round(res.mean_conf), '', '%', t('rounds.confidence_label'))}
  ${tile(Math.round(res.accuracy), '', '%', t('rounds.right_label'))}
</div>`;
}

function showEnd(ctx, st, res, { archived = false, saveFailed = false } = {}) {
  const { app, t } = ctx;
  ctx.chrome(false);
  document.title = `${t('rounds.results_title')} | Who's Bluffing?`;
  ctx.setPlay(t('rounds.play_again'), () => playAgain(ctx, st));
  const answers = st.items.map((i) => st.answers[i.id]).filter(Boolean);
  const calib = bins(answers.map((a) => a.conf / 100), answers.map((a) => (a.correct ? 1 : 0)));
  app.innerHTML = html`<nav class="row" aria-label="${t('rounds.results_title')}">
  ${homeLink(t)}
  <button class="primary" type="button" data-again>${t('rounds.play_again')}</button>
  <a href="/play">${t('rounds.change_topic')}</a>
  ${recentGames().length ? html`<a href="/play#recent-games">${t('rounds.recent_title')}</a>` : ''}
</nav>
${saveFailed ? html`<p role="status">${t('rounds.recent_save_failed')}</p>` : ''}
<h2 class="result-title">${t('rounds.score_title', { score: fmtTotal(res.score) })}</h2>
<p class="round-kind">${roundLabel(t, st)}</p>
${resultGrid(st, t)}
<section class="type-card type-${TYPES[res.type]} anim anim-flip" aria-label="${t('rounds.type_label')}">
  <p class="type-name">${typeName(res.type)}</p>
  <p class="type-line">${t(typeKey(res.type))}</p>
</section>
${!archived && boardOf(st) ? sideBlock(st.pack, t, savedSide(st.pack)) : ''}
${res.roast ? html`<p class="roast">${res.roast}</p>` : ''}
${counters(t, res)}
<figure class="mini">${calibrationChart([{ name: t('rounds.you'), bins: calib, cls: 's0' }], chartLabels(t))}<figcaption>${t('rounds.chart_note')}</figcaption></figure>
<div class="end-actions">
  <button class="primary" type="button" data-act="again">${t('rounds.play_again')}</button>
  <button type="button" data-act="challenge">${t('rounds.challenge')}</button>
  <button type="button" data-act="share" aria-expanded="false" aria-controls="share-panel">${t('rounds.share')}</button>
</div>
<a class="button block" href="/discord">${t('rounds.discord_friends')}</a>
<p class="small muted">${t('rounds.discord_friends_note')}</p>
<div id="challenge-panel" class="card" hidden></div>
<div id="vs-panel" class="card" hidden></div>
<section id="share-panel" class="card" hidden></section>`;
  app.scrollIntoView(); // the result sits below the hero, which is back now
  wireGrid(app, st, t);
  // Reviewing a saved result must not claim an old round for the player's current team.
  const side = !archived && boardOf(st) ? wireSide(st.pack, app, st.round_id, t) : null;
  for (const b of app.querySelectorAll('.counters [data-to]')) {
    countTo(b, 0, Number(b.dataset.to), { ms: 700, format: (n) => `${b.dataset.prefix}${n}${b.dataset.suffix}` });
  }
  if (res.score > 0) sound.fanfare();
  const panel = (id) => app.querySelector(`#${id}`);
  const toggle = (btn, el, fill) => {
    const open = el.hidden;
    el.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && !el.dataset.filled) { el.dataset.filled = '1'; fill(el); }
  };
  const acts = Object.fromEntries([...app.querySelectorAll('[data-act]')].map((b) => [b.dataset.act, b]));
  acts.again.onclick = () => playAgain(ctx, st);
  app.querySelector('[data-again]').onclick = () => playAgain(ctx, st);
  acts.challenge.onclick = () => challengeFriend(ctx, panel('challenge-panel'), res, st);
  const copy = res.dare ? res.share_text // the dare's sentence as the server wrote it
    : shareWith(res.share_text, { pack: st.mode === 'quick' ? st.pack : null, line: bestLine(st.items, st.answers), url: res.challenge_url, type: res.type });
  acts.share.onclick = () => toggle(acts.share, panel('share-panel'), (el) => renderRoundShare(ctx, el, {
    lines: { kicker: st.mode === 'ranked' ? t('rounds.ranked') : t('rounds.card_kicker'), type: typeName(res.type), score: t('rounds.card_score', { score: fmtTotal(res.score) }),
      line: t('rounds.score_sub', { accuracy: Math.round(res.accuracy), mean_conf: Math.round(res.mean_conf) }), cta: t('rounds.card_cta') },
    copy: withSideLine(copy, side?.shareLine(), res.challenge_url), url: res.challenge_url, onShare: () => event('share', st.round_id),
  }));
  if (!res.dare) showVs(ctx, panel('vs-panel'), st.round_id, st.challenge ?? res.challenge_url.split('/').at(-1));
}

const event = (type, roundId) => api('/api/event', { method: 'POST', keepalive: true, body: { type, round_id: roundId } });

function playAgain(ctx, st) {
  event('play_again');
  if (st?.mode === 'quick') return playQuick(ctx, st.round_id);
  location.assign('/play');
}

// Copy inside the original tap. Adding a name is optional and never blocks sharing.
export function challengeFriend(ctx, el, res, st) {
  const { t } = ctx;
  const done = (ok) => {
    if (ok) event('share', st.round_id);
    el.hidden = false;
    el.innerHTML = html`<p class="msg ${ok ? 'ok' : ''}" role="status">${ok ? t('rounds.copied') : t('rounds.copy_failed')}</p>
<p class="url small"><a href="${res.challenge_url}">${res.challenge_url}</a></p>
<details><summary>${t('rounds.nick_label')}</summary><form class="nick">
  <label><span class="sr-only">${t('rounds.nick_label')}</span><input name="nick" maxlength="24" autocomplete="nickname" value="${store.get(NICK_KEY, '') ?? ''}" placeholder="${t('rounds.nick_placeholder')}"></label>
  <p class="muted small">${t('rounds.nick_note')}</p>
  <button type="submit">${t('rounds.save_name')}</button><p role="status" data-name-status></p>
</form></details>`;
    const form = el.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nick = form.nick.value.trim().replace(/\s+/g, ' ');
      const status = form.querySelector('[data-name-status]');
      if (!/^[\p{L}\p{N} .'_-]{1,24}$/u.test(nick)) { status.textContent = t('rounds.name_invalid'); return; }
      const button = form.querySelector('button');
      button.disabled = true;
      const r = await api('/api/round/complete', { method: 'POST', body: { round_id: st.round_id, anon_id: anonId(), surface: 'web', nickname: nick } });
      button.disabled = false;
      if (r.ok) store.set(NICK_KEY, nick);
      status.textContent = t(r.ok ? 'rounds.name_saved' : 'rounds.offline');
    };
  };
  try { navigator.clipboard.writeText(res.challenge_url).then(() => done(true), () => done(false)); } catch { done(false); }
}

// You against the challenger: rows slide in, and the two scores race up to their values.
async function showVs(ctx, el, roundId, token, data = null) {
  const { t } = ctx;
  if (!data) {
    const r = await api(`/api/round/${encodeURIComponent(roundId)}/compare?me=${encodeURIComponent(anonId())}&them=${encodeURIComponent(token)}`);
    if (!r.ok) {
      el.hidden = false;
      el.innerHTML = html`<p role="status">${t('rounds.friends_failed')}</p><button type="button">${t('rounds.retry')}</button>`;
      el.querySelector('button').onclick = () => showVs(ctx, el, roundId, token);
      return;
    }
    data = r.data;
  }
  if (!data.me || !el.isConnected) return;
  const { me, them, own, replies, record } = data;
  if (own) {
    el.hidden = false;
    el.innerHTML = html`<h3>${t('rounds.friend_results')}</h3>
<p>${replies.length ? t('rounds.friends_ready') : t('rounds.friends_waiting')}</p>
${replies.map((p, k) => html`<p><a href="/c/${roundId}/${p.public_token}">${t('rounds.compare_friend', { name: p.nickname || t('rounds.friend_number', { n: k + 1 }) })}</a></p>`)}
<p class="row"><a class="button" href="/c/${roundId}/${token}">${t('rounds.check_friends')}</a><button type="button" data-refresh>${t('rounds.refresh')}</button></p>`;
    el.querySelector('[data-refresh]').onclick = () => showVs(ctx, el, roundId, token);
    return;
  }
  const name = them.nickname || t('rounds.vs_someone');
  const d = me.score - them.score;
  const row = (label, f) => html`<tr class="anim anim-slide"><th scope="row">${label}</th><td>${f(me)}</td><td>${f(them)}</td></tr>`;
  el.hidden = false;
  el.innerHTML = html`<h3>${t('rounds.vs_title', { name })}</h3>
<p class="headline">${d > 0 ? t('rounds.vs_win', { d }) : d < 0 ? t('rounds.vs_lose', { name, d: -d }) : t('rounds.vs_tie')}</p>
<table class="vs"><thead><tr><td></td><th scope="col">${t('rounds.you')}</th><th scope="col">${name}</th></tr></thead><tbody>
<tr class="anim anim-slide vs-score"><th scope="row">${t('rounds.vs_score')}</th><td><b class="anim" data-race="${me.score}">${me.score}</b></td><td><b class="anim" data-race="${them.score}">${them.score}</b></td></tr>
${row(t('rounds.vs_type'), (p) => typeName(p.type))}
${row(t('rounds.vs_right'), (p) => `${Math.round(p.accuracy)}%`)}
${row(t('rounds.vs_sure'), (p) => `${Math.round(p.mean_conf)}%`)}
</tbody></table>
${record?.played ? html`<p class="small">${t('rounds.friend_record', { wins: record.wins, losses: record.losses, ties: record.ties })}</p>` : ''}
<div class="row"><button class="primary" type="button" data-rematch>${t('rounds.rematch')}</button>
<button type="button" data-send-result>${t('rounds.send_result')}</button><a href="/play">${t('rounds.change_topic')}</a></div>
<p class="muted small">${t('rounds.rematch_note')}</p><div data-result-link hidden></div>`;
  raceTo([...el.querySelectorAll('[data-race]')].map((b) => ({ el: b, to: Number(b.dataset.race), format: String })));
  el.querySelector('[data-rematch]').onclick = () => playAgain(ctx, { mode: /^[A-Z2-9]{12}$/.test(roundId) ? 'quick' : 'ranked', round_id: roundId });
  el.querySelector('[data-send-result]').onclick = () => challengeFriend(ctx, el.querySelector('[data-result-link]'),
    { challenge_url: `${location.origin}/c/${roundId}/${data.my_token}` }, { round_id: roundId });
}

// --- entry points -----------------------------------------------------------------------------------------------

// Home keeps its existing layout. Every Play button opens the picker, carrying its selected pack and difficulty.
export function renderRoundHome(ctx) {
  const homePicker = initPicker();
  const saved = loadRound();
  const done = saved?.items.filter((i) => saved.answers[i.id]).length;
  const label = saved?.date === todayUTC()
    ? done === saved.items.length ? ctx.t('rounds.see_score') : ctx.t('rounds.continue', { done, n: saved.items.length })
    : ctx.t('rounds.play');
  ctx.setPlay(label, () => location.assign(`/play?${new URLSearchParams(homePicker.current())}`));
}

// /play always offers a choice. A saved round has a separate Continue button.
export function renderRounds(ctx) {
  const { app, t } = ctx;
  app.replaceChildren();
  bindKeys();
  picker = initPicker();
  ctx.setPlay(t('rounds.start'), () => playQuick(ctx));
  const today = todayUTC();
  const saved = loadRound();
  if (saved && saved.date === today) {
    const done = saved.items.filter((i) => saved.answers[i.id]).length;
    const resume = document.getElementById('resume-round');
    resume.hidden = false;
    resume.querySelector('p').textContent = roundLabel(t, saved);
    const button = resume.querySelector('button');
    button.textContent = done === saved.items.length ? t('rounds.see_score') : t('rounds.continue', { done, n: saved.items.length });
    button.onclick = () => step(ctx, saved);
  } else if (saved) clearRound();
  renderRecentGames(ctx);
}

function renderRecentGames(ctx) {
  const games = recentGames();
  if (!games.length) return;
  const { app, t } = ctx;
  app.insertAdjacentHTML('beforeend', html`<details class="card" id="recent-games">
<summary>${t('rounds.recent_title')} (${games.length})</summary>
<p class="muted small">${t('rounds.recent_note')}</p>
<ol>${games.map(({ round, result, completedAt }) => {
    const label = result.dare ? result.dare.name : round.mode === 'quick' ? quickLabel(round.pack, round.difficulty) : roundLabel(t, round);
    const date = new Date(completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return html`<li><p><strong>${label}</strong><br><time datetime="${completedAt}">${date}</time> · ${fmtTotal(result.score)} ${t('rounds.pts')} · ${typeName(result.type)}</p>
<div class="row">
  <a class="button" href="/results?round=${round.round_id}" aria-label="${t('rounds.recent_view')} — ${label} — ${date}">${t('rounds.recent_view')}</a>
  ${!result.dare ? html`<a class="button" href="${result.challenge_url}" aria-label="${t('rounds.recent_friends')} — ${label} — ${date}">${t('rounds.recent_friends')}</a>` : ''}
  <button type="button" data-recent-again="${round.round_id}" aria-label="${t('rounds.play_again')} — ${label} — ${date}">${t('rounds.play_again')}</button>
</div></li>`;
  })}</ol></details>`);
  for (const button of app.querySelectorAll('[data-recent-again]')) {
    button.onclick = () => {
      const saved = recentGame(button.dataset.recentAgain);
      if (saved) playAgain(ctx, saved.round);
      else location.assign('/play');
    };
  }
  if (location.hash === '#recent-games') {
    const list = app.querySelector('#recent-games');
    list.open = true;
    list.scrollIntoView();
  }
}

// Saved links take precedence over this tab's history; restoring never completes a round or clears an unfinished one.
export function renderRoundResults(ctx) {
  const id = new URLSearchParams(location.search).get('round');
  if (id !== null) {
    const saved = recentGame(id);
    if (saved) return showEnd(ctx, saved.round, { ...saved.result,
      challenge_url: new URL(saved.result.challenge_url, location.origin).href }, { archived: true });
  } else {
    const { round, result, saveFailed } = history.state ?? {};
    if (round?.items?.length && result?.score != null) return showEnd(ctx, round, result, { archived: true, saveFailed });
  }
  ctx.app.innerHTML = html`${homeLink(ctx.t)}
<h1>${ctx.t('rounds.results_title')}</h1><p>${ctx.t(id === null ? 'rounds.no_result' : 'rounds.recent_missing')}</p>
<a class="button primary" href="/play">${ctx.t('rounds.start')}</a>`;
  renderRecentGames(ctx);
}

// `/c/<round>/<token>`: plays the challenger's round, then shows the side-by-side. A finished round shows it at once.
export async function renderChallenge(ctx, roundId, token) {
  const { app, t } = ctx;
  app.replaceChildren();
  bindKeys();
  const saved = loadRound();
  if (saved?.round_id === roundId && saved.challenge === token && saved.items.some((i) => !saved.answers[i.id])) {
    const done = saved.items.filter((i) => saved.answers[i.id]).length;
    ctx.setPlay(t('rounds.continue', { done, n: saved.items.length }), () => step(ctx, saved));
    return;
  }
  const vs = await api(`/api/round/${encodeURIComponent(roundId)}/compare?me=${encodeURIComponent(anonId())}&them=${encodeURIComponent(token)}`);
  if (vs.ok && vs.data.me) {
    app.innerHTML = html`<div id="vs-panel" class="card"></div>`;
    showVs(ctx, app.querySelector('#vs-panel'), roundId, token, vs.data);
    ctx.setPlay(t('rounds.rematch'), () => playAgain(ctx, { mode: /^[A-Z2-9]{12}$/.test(roundId) ? 'quick' : 'ranked', round_id: roundId }));
    return;
  }
  const r = await api(`/api/round?round_id=${encodeURIComponent(roundId)}`);
  if (!r.ok) {
    app.innerHTML = html`<p class="msg">${t('rounds.challenge_gone')}</p>`;
    ctx.setPlay(t('rounds.play'), () => location.assign('/play'));
    return;
  }
  ctx.setPlay(t('rounds.play'), () => begin(ctx, r.data, { challenge: token }));
}

// `/dare/<slug>` (HTML from functions/dare/[slug].js): plays the dare's fixed round dr-<slug>; an unfinished one
// resumes. A browser that has finished it gets a quick round instead (the server keeps the first answers).
export async function renderDare(ctx, slug) {
  const { app, t } = ctx;
  const roundId = `dr-${slug}`;
  app.replaceChildren();
  bindKeys();
  const saved = loadRound();
  if (saved?.round_id === roundId && saved.items.some((i) => !saved.answers[i.id])) {
    const done = saved.items.filter((i) => saved.answers[i.id]).length;
    ctx.setPlay(t('rounds.continue', { done, n: saved.items.length }), () => step(ctx, saved));
    return;
  }
  const score = store.get(DARES_KEY, {})[roundId];
  if (score != null) {
    app.innerHTML = html`<p class="note">${dareDone(score)}</p>`;
    ctx.setPlay(t('rounds.play'), () => location.assign('/play'));
    return;
  }
  const r = await api(`/api/round?round_id=${encodeURIComponent(roundId)}`);
  if (!r.ok) {
    app.innerHTML = html`<p class="msg">${t('rounds.failed')}</p>`;
    ctx.setPlay(t('rounds.play'), () => location.assign('/play'));
    return;
  }
  ctx.setPlay(t('rounds.play'), () => begin(ctx, r.data, { pack: r.data.pack, difficulty: r.data.difficulty }));
}
