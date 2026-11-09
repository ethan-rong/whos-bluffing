// Entry point for the app pages: loads strings and items, routes by path. / = home, /play = picker and rounds,
// /results = this tab's completed round, /c/<round>/<token> =
// a challenge (HTML from the Pages Function functions/c/[round_id]/[player].js), /test = full assessment, /stats, /labs,
// /class and /class/d/<secret> (their own HTML shells; _redirects maps the dashboard to class.html).
import { html, api } from './ui.js';
import { startTest } from './test.js';
import { renderRoundHome, renderRounds, renderRoundResults, renderChallenge, renderDare } from './rounds.js';
import { renderBoard } from './labs.js';
import { renderClassCreate, renderDashboard } from './class.js';
import { renderPlayed, wireSurfaces, wirePause } from './home.js';

const app = document.getElementById('app');
wireSurfaces(document.querySelector('[data-surfaces]')); // the home page's switch and list work before the game loads
wirePause(document.querySelector('[data-prompts]'));

let strings = {};
let items = [];

function t(key, vars = {}) {
  const s = key.split('.').reduce((o, k) => o?.[k], strings);
  return typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : key;
}

// While questions are on screen, the hero, the sections below the game and the footer are hidden (styles.css).
function chrome(visible) {
  document.body.classList.toggle('playing', !visible);
}

// The home buttons open /play; the play page starts the chosen round. Challenge pages start their fixed round.
// A tap before the game has loaded runs as soon as it has.
let playAction = null;
let playPending = false;
for (const b of document.querySelectorAll('[data-play]')) {
  b.addEventListener('click', () => { if (playAction) playAction(); else playPending = true; });
}
function setPlay(label, action) {
  const text = document.querySelector('#play span');
  if (text && label) text.textContent = label;
  playAction = action;
  if (playPending) { playPending = false; action(); }
}

const ctx = {
  app,
  t,
  get strings() { return strings; },
  get items() { return items; },
  chrome,
  setPlay,
};

// /test: the 5-minute full assessment (?c=CODE pre-fills a class code).
function renderTestLanding() {
  const code = (new URLSearchParams(location.search).get('c') || '').toUpperCase().slice(0, 6);
  app.innerHTML = html`
<section>
  <h1>${t('landing.h1')}</h1>
  <p class="lead">${t('landing.lead')}</p>
  <p class="consent">${t('landing.consent')}</p>
  <button id="start" class="primary block" type="button">${t('landing.start')}</button>
</section>
<section class="card">
  <h2>${t('landing.join_title')}</h2>
  <form id="join" class="row" novalidate>
    <input id="code" name="code" value="${code}" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${t('landing.code_placeholder')}" aria-label="${t('landing.code_placeholder')}">
    <button class="${code ? 'primary' : ''}" type="submit">${t('landing.join')}</button>
  </form>
  <p id="join-msg" class="msg" role="status"></p>
</section>
<p><a href="/class">${t('landing.teach')}</a></p>`;
  app.querySelector('#start').onclick = () => startTest(ctx, {});
  app.querySelector('#join').onsubmit = async (e) => {
    e.preventDefault();
    const value = app.querySelector('#code').value.trim().toUpperCase();
    const msg = app.querySelector('#join-msg');
    const r = await api(`/api/class/${encodeURIComponent(value || '-')}`);
    if (!r.ok) { msg.textContent = t('landing.code_offline'); return; }
    if (!r.data.exists) { msg.textContent = t('landing.code_unknown'); return; }
    startTest(ctx, { classCode: value, classLabel: r.data.label || value });
  };
}

function route() {
  const p = location.pathname;
  const dash = p.match(/^\/class\/d\/([A-Za-z0-9_-]{24})\/?$/);
  const challenge = p.match(/^\/c\/((?:rk-\d{4}-\d{2}-\d{2})|[A-Z2-9]{12})\/([A-Za-z0-9_-]{10})\/?$/);
  if (p === '/') return Promise.all([renderRoundHome(ctx), renderPlayed(document.querySelector('[data-played]'))]);
  if (/^\/play\/?$/.test(p)) return renderRounds(ctx);
  if (/^\/results\/?$/.test(p)) return renderRoundResults(ctx);
  if (challenge) return renderChallenge(ctx, challenge[1], challenge[2]);
  const dare = p.match(/^\/dare\/([a-z][a-z0-9-]{1,30})\/?$/); // functions/dare/[slug].js
  if (dare) return renderDare(ctx, dare[1]);
  if (/^\/test\/?$/.test(p)) return renderTestLanding();
  if (/^\/labs\/?$/.test(p)) return renderBoard(ctx, 'ai');
  if (/^\/class\/?$/.test(p)) return renderClassCreate(ctx);
  if (dash) return renderDashboard(ctx, dash[1]);
  app.innerHTML = html`<p>${t('dash.not_found')}</p><p><a href="/">${t('nav.daily')}</a></p>`;
  return null;
}

async function boot() {
  const load = (path) => fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(path))));
  const ready = () => document.documentElement.classList.add('ready'); // styles.css shows what is below the game
  try {
    const [en, bank] = await Promise.all([load('/i18n/en.json'), load('/items.json')]);
    strings = en;
    items = bank.items;
  } catch {
    app.innerHTML = html`<p class="msg">Couldn't load Who's Bluffing. Check your connection and reload.</p>`;
    ready();
    return;
  }
  try { await route(); } finally { ready(); }
}

// Finishing a round changes the URL without discarding its result. Back/Forward loads the matching page shell.
window.addEventListener('popstate', () => location.reload());
boot();
