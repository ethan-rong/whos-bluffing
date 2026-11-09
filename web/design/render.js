// Renders the committed images and the review screenshots in headless Chrome over the DevTools protocol, and runs
// the layout checks. No dependencies (Node 22's fetch and WebSocket). CHROME=/path/to/chrome picks another Chromium.
//   node design/render.js assets           public/og.png, favicon-32.png, apple-touch-icon.png (from favicon.svg =
//                                          brand/icon.svg), press/logo.png and press/logo-dark.png from design/*.html
//   node design/render.js screens [BASE] [PAGE]
//                                          design/screens/<page>-<width>-<theme>.png for /, /slack, /research (375, 768,
//                                          1280) and /discord, /commands (375, 1280); BASE is a running `npm run dev`
//                                          (default http://127.0.0.1:8788). PAGE shoots one page only; a suffixed name
//                                          (home-v2) shoots that page under the new name and keeps the earlier set
//   node design/render.js pages [BASE] [DIR]
//                                          every page in PAGES at 375 and 1280 px, light and dark, whole, into DIR (a
//                                          new temp folder by default), for review
//   node design/render.js checks [BASE]    overflow at 375 px and layout shift on every page, keyboard walk on /, /slack,
//                                          /discord and /commands, theme toggle label and persistence
//   node design/render.js flow [BASE]      local-only: home -> picker -> resume -> results, reload/back/forward, replay
//   node design/render.js rounds [BASE]    design/screens/rounds-{item,reveal-right,reveal-wrong,end,challenge}-<width>-
//                                          <theme>.png at 375 and 1280 px, motion on: plays a saved topic round in the
//                                          page (the first answer right at 100%, the second wrong at 100%) after four API
//                                          players for the leaderboard, and opens a challenge link from a fifth
//   node design/render.js results [BASE]   design/screens/results-<width>-<theme>.png at 375, 768 and 1280 px: the full
//                                          assessment (/test) played through to its results page, whole page
//   node design/render.js demo [BASE] [vertical|square] [--music FILE] [--edition ai]
//                                          public/press/demo-vertical.mp4 (1080x1920) and demo.mp4 (1080x1080), one
//                                          20 s edit with sound; demo.gif, demo-poster.png, demo-vertical-poster.png and
//                                          design/screens/demo-vertical-frames.png: a saved topic round played in the
//                                          page on a stand-in clock, composed by design/demo.html, sound from
//                                          design/soundtrack.js (FILE: the music instead of the synthesised bed; see
//                                          design/MEDIA_NOTES.md), cut by ffmpeg (FFMPEG=/path/to/ffmpeg picks another)
//                                          --edition ai: the AI pack's demo-ai* files (D1_STATE: the dev server's D1)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { SR, bed, effects, mix, wav, fromPcm } from './soundtrack.js';
import { PACKS } from '../public/packs.js';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9339;
const READY_TIMEOUT_MS = 6000;
const PAGES = ['/', '/play', '/results', '/discord', '/slack', '/commands', '/teachers', '/research', '/support', '/status', '/press',
  '/changelog', '/docs/api', '/privacy', '/terms', '/test', '/stats', '/class', '/tests/overconfidence-test',
  '/tests/estimation-test', '/tests/calibration-test', '/no-such-page'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERO_SHOTS = ['home', 'discord']; // also captured as one 1280x800 screen for /press

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'whosbluffing-render-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  chrome.on('exit', () => rmSync(profile, { recursive: true, force: true }));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    up = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(100);
  }
  if (!up) throw new Error(`Chrome did not start: ${CHROME}`);
  const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); if (msg.error) w.reject(new Error(`${msg.error.message} (${w.method})`)); else w.resolve(msg.result); return; }
    for (const f of listeners) f(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1;
    waiting.set(seq, { resolve, reject, method });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
  const next = (method) => new Promise((resolve) => {
    const f = (m) => { if (m.method === method) { listeners.delete(f); resolve(m.params); } };
    listeners.add(f);
  });
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, next, close: () => { ws.close(); chrome.kill(); } };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} in: ${expression.slice(0, 80)}`);
  return r.result.value;
}

// Opens url at the given size and theme; waits for the app's first render (html.ready) unless waitReady is false.
async function open(cdp, url, { width, height = 900, scale = 1, dark = false, mobile = width < 768, motion = 'reduce', waitReady = true }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: motion }] });
  const loaded = cdp.next('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  if (waitReady) {
    await evaluate(cdp, `new Promise((done) => { const t0 = Date.now(); (function wait() {
      if (document.documentElement.classList.contains('ready') || Date.now() - t0 > ${READY_TIMEOUT_MS}) done(); else setTimeout(wait, 50); })(); })`);
  }
  await sleep(400);
}

async function capture(cdp, file, width, height, y = 0) {
  const h = height ?? await evaluate(cdp, 'Math.ceil(document.documentElement.scrollHeight)');
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width, height: h, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`wrote ${file.replace(WEB, 'web/')} (${width}x${h})`);
}

async function assets(cdp) {
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }); // transparent icon corners
  const jobs = [['design/og.html', 'public/og.png', 1200, 630], ['design/icon.html', 'public/favicon-32.png', 32, 32],
    ['design/icon.html', 'public/apple-touch-icon.png', 180, 180, 'solid'],
    ['design/logo.html', 'public/press/logo.png', 1280, 320], ['design/logo.html', 'public/press/logo-dark.png', 1280, 320, 'dark']];
  for (const [src, out, w, h, bodyClass] of jobs) {
    await open(cdp, `file://${WEB}${src}`, { width: w, height: h, mobile: false, waitReady: false });
    if (bodyClass) await evaluate(cdp, `document.body.classList.add('${bodyClass}')`);
    await capture(cdp, join(WEB, out), w, h);
  }
}

const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`); return r.json(); });

async function screens(cdp, base, only) {
  const all = [[375, 812], [768, 1024], [1280, 800]];
  const shots = [['home', '/', all], ['slack', '/slack', all], ['research', '/research', all],
    ['discord', '/discord', [all[0], all[2]]], ['commands', '/commands', [all[0], all[2]]]];
  const picked = only ? shots.filter(([name]) => only === name || only.startsWith(`${name}-`)).map(([, path, sizes]) => [only, path, sizes]) : shots;
  for (const [name, path, sizes] of picked) {
    for (const dark of [false, true]) {
      for (const [w, h] of sizes) {
        await open(cdp, `${base}${path}`, { width: w, height: h, dark });
        // as with overlay scrollbars: --hide-scrollbars still reserves the gutter (styles.css), an empty strip at the right
        await evaluate(cdp, "document.documentElement.style.scrollbarGutter = 'auto'");
        await capture(cdp, join(WEB, `design/screens/${name}-${w}-${dark ? 'dark' : 'light'}.png`), w);
        if (HERO_SHOTS.includes(name) && w === 1280 && !dark) await capture(cdp, join(WEB, `design/screens/${name}-hero-1280-light.png`), w, h); // the press kit's view
      }
    }
  }
}

// Every page in PAGES at 375 and 1280 px, light and dark, whole, into dir (a review set; not committed).
async function pageScreens(cdp, base, dir) {
  mkdirSync(dir, { recursive: true });
  for (const path of PAGES) {
    const name = path === '/' ? 'home' : path.slice(1).replaceAll('/', '-');
    for (const dark of [false, true]) {
      for (const [w, h] of [[375, 812], [1280, 800]]) {
        await open(cdp, `${base}${path}`, { width: w, height: h, dark });
        await evaluate(cdp, "document.documentElement.style.scrollbarGutter = 'auto'");
        await capture(cdp, join(dir, `${name}-${w}-${dark ? 'dark' : 'light'}.png`), w);
      }
    }
  }
}

// Plays a round through the API: pattern of 1 (right) / 0 per pair, confidences cycled; returns complete's body.
async function playRoundApi(base, round, anon, pattern, confs, extra = {}) {
  const truth = truthOf(); // pairs and the curated quick items (quick rounds serve q-ids)
  for (const [k, item] of round.items.entries()) {
    const right = pattern[k % pattern.length] === '1';
    await post(base, '/api/round/answer', { round_id: round.round_id, item_id: item.id, choice: right ? truth.get(item.id) : 1 - truth.get(item.id),
      conf: confs[k % confs.length], rt_ms: 4000, anon_id: anon, surface: 'web' });
  }
  return post(base, '/api/round/complete', { round_id: round.round_id, anon_id: anon, surface: 'web', ...extra });
}

// An expression that waits (in the page) for an enabled element matching sel.
const waitFor = (sel) => `await new Promise((done, fail) => { const t0 = Date.now(); (function poll() {
  const el = document.querySelector(${JSON.stringify(sel)}); if (el && !el.disabled) done(el);
  else if (Date.now() - t0 > 8000) fail(new Error('timeout: ' + ${JSON.stringify(sel)})); else setTimeout(poll, 40); })(); })`;

async function flowCheck(cdp, base) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'flow checks create test plays: use a local server');
  const js = (expression) => evaluate(cdp, expression);
  const check = async (expression, message) => assert.equal(await js(expression), true, message);
  const navigate = async (expression) => {
    const loaded = cdp.next('Page.loadEventFired');
    await js(`${expression}; true`);
    await loaded;
    await js(`(async () => { ${waitFor('html.ready')}; return true; })()`);
  };
  await open(cdp, `${base}/`, { width: 375 });
  await js("localStorage.clear(); localStorage.setItem('whosbluffing_sound', 'off'); true");
  await open(cdp, `${base}/`, { width: 375 });
  await js(`document.querySelector('[data-pack="ai"]').click(); document.querySelector('[data-difficulty="easy"]').click(); true`);
  await navigate("document.getElementById('play').click()");
  await check("location.pathname === '/play' && !document.querySelector('button.pick')", 'home opens the picker, not a question');
  await check(`document.querySelector('[data-pack="ai"]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-difficulty="easy"]').getAttribute('aria-pressed') === 'true'`, 'home choices carry into the picker');
  await js(`window.dealsStarted = 0; const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { if (this.matches('.deal-card')) window.dealsStarted++; return animate.apply(this, args); }; true`);
  await js(`(async () => { document.getElementById('play').click(); ${waitFor('button.pick')}; return true; })()`);
  await check('window.dealsStarted === 0', 'reduced motion goes straight to the first question');
  await check(`(() => { const r = JSON.parse(localStorage.getItem('whosbluffing_round')); return r.pack === 'ai' && r.difficulty === 'easy' && r.mode === 'quick'; })()`, 'the chosen topic and difficulty reach the API');
  const answer = `(async () => { document.querySelector('button.pick').click(); document.querySelector('[data-conf="70"]').click(); ${waitFor('#next')}; return true; })()`;
  await js(answer);
  const roundId = await js("JSON.parse(localStorage.getItem('whosbluffing_round')).round_id");
  await check("!document.querySelector('#app a[href=\"/\"]')", 'active rounds have no Home shortcut');
  await navigate("document.querySelector('header .brand').click()");
  await navigate("document.getElementById('play').click()");
  await check("!document.getElementById('resume-round').hidden", 'unfinished round has an explicit Continue action');
  await js(`(async () => { document.querySelector('#resume-round button').click(); ${waitFor('button.pick')}; return true; })()`);
  await check(`JSON.parse(localStorage.getItem('whosbluffing_round')).round_id === ${JSON.stringify(roundId)}`, 'Continue resumes the same round');
  for (let i = 1; i < 10; i += 1) {
    await js(answer);
    if (i === 9) await js(`(() => { const original = window.fetch; window.fetch = (...args) => {
      if (args[0] === '/api/round/complete') { window.fetch = original; return Promise.resolve(new Response('{}', { status: 503 })); }
      return original(...args);
    }; return true; })()`);
    await js(`(async () => { document.getElementById('next').click(); ${waitFor(i === 9 ? '#app .msg' : 'button.pick')}; return true; })()`);
  }
  await navigate('location.reload()');
  await check("!document.getElementById('resume-round').hidden && document.querySelector('#resume-round button').textContent === 'See your score'", 'all answers survive a failed completion and refresh');
  await js(`(async () => { document.querySelector('#resume-round button').click(); ${waitFor('.result-title')}; return true; })()`);
  await check("location.pathname === '/results' && document.body.classList.contains('playing') && !document.querySelector('#round-setup').getBoundingClientRect().height", 'completion stays on a dedicated result view');
  const score = await js("document.querySelector('.result-title').textContent");
  await navigate('location.reload()');
  await check(`document.querySelector('.result-title')?.textContent === ${JSON.stringify(score)}`, 'refresh retains the score');
  await navigate('history.back()');
  await check("location.pathname === '/play' && document.getElementById('round-setup').getBoundingClientRect().height > 0", 'Back returns to the picker');
  await navigate('history.forward()');
  await check(`location.pathname === '/results' && document.querySelector('.result-title')?.textContent === ${JSON.stringify(score)}`, 'Forward restores the result');
  await navigate("document.querySelector('[data-again]').click()");
  await check("location.pathname === '/play' && !document.querySelector('button.pick')", 'Play Again offers choices before creating another round');
  await check('document.documentElement.scrollWidth <= innerWidth', 'picker has no mobile horizontal overflow');
  await open(cdp, `${base}/results`, { width: 375 });
  await check("!document.querySelector('.result-title') && !!document.querySelector('#app a[href=\"/play\"]')", 'a direct result link has a useful empty state');
  await open(cdp, `${base}/play`, { width: 375 });
  await check("!document.getElementById('play-ranked')", 'daily ranked is absent from the picker');
  for (const width of [375, 1280]) {
    await open(cdp, `${base}/play`, { width, motion: 'no-preference', dark: width === 375 });
    await js(`(async () => { document.getElementById('play').click(); ${waitFor('.deal-card')};
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = 180; } return true; })()`);
    await check("(() => { const n = [...document.querySelectorAll('.deal-card')].filter(c => Number(getComputedStyle(c).opacity) > .1).length; return n > 0 && n < 10; })()", 'cards enter one at a time');
    await js('for (const a of document.getAnimations()) a.currentTime = .45 * a.effect.getTiming().duration; true');
    await check("document.querySelectorAll('.deal-card').length === 10 && !document.querySelector('button.pick')", 'ten card backs before the first question');
    await check("[...document.querySelectorAll('.deal-card')].every(c => Number(getComputedStyle(c).opacity) > .99)", 'all ten cards are dealt before shuffling');
    await check('document.documentElement.scrollWidth <= innerWidth', `deck has no overflow at ${width}px`);
    mkdirSync(join(WEB, '.cache'), { recursive: true });
    await capture(cdp, join(WEB, `.cache/shuffle-${width}.png`), width, 900);
    await js(`(async () => { ${width === 375 ? "document.querySelector('[data-skip-deal]').click()" : 'for (const a of document.getAnimations()) a.play()'};
      ${waitFor('button.pick')}; return true; })()`);
    await check("document.activeElement.matches('.q') && !document.querySelector('.round-deal')", 'skip and natural completion focus question one');
    await check("Object.keys(JSON.parse(localStorage.getItem('whosbluffing_round')).answers).length === 0", 'animation never answers or reorders the saved round');
  }
  await open(cdp, `${base}/play`, { width: 375, motion: 'no-preference' });
  await js(`window.fetch = () => Promise.resolve(new Response('{}', { status: 503 })); true`);
  await js(`(async () => { document.getElementById('play').click(); ${waitFor('#app .msg')}; return true; })()`);
  await check("!document.querySelector('.round-deal') && !!document.querySelector('#app button')", 'failed loading offers retry without leaving an animation running');
  console.log('PASS home, choices, resume, result, refresh, Back/Forward, replay, no daily ranked, ten-card deal, skip, reduced motion, failed loading, mobile overflow');
}

// The truth (0 = A, 1 = B) of every pair, from the synced compact pairs.
const truthOf = () => new Map([...JSON.parse(readFileSync(join(WEB, 'functions/_pairs.json'), 'utf8')).pairs.map(([n, , , t]) => [`p${String(n).padStart(5, '0')}`, t]), ...JSON.parse(readFileSync(join(WEB, '../items/quick_curated.json'), 'utf8')).items.map((q) => [q.id, q.answer])]);

// In the page: answers the question on screen (right or wrong, at conf), using the saved round to know which pair it is.
const answerInPage = (truth, right, conf) => `(async () => { ${waitFor('button.pick')};
  const st = JSON.parse(localStorage.getItem('whosbluffing_round')); const k = st.items.findIndex((i) => !st.answers[i.id]);
  const t = ${JSON.stringify(Object.fromEntries(truth))}[st.items[k].id]; const pick = ${right} ? t : 1 - t;
  document.querySelectorAll('button.pick')[pick].click(); (${waitFor(`#conf:not([hidden]) [data-conf="${conf}"]`)}).click();
  ${waitFor('.reveal')}; return true; })()`;

async function roundScreens(cdp, base) {
  const get = (path) => fetch(`${base}${path}`).then((r) => r.json());
  const sample = { ...(await get('/api/round?mode=quick')), answers: {}, total: 0 };
  const all = truthOf();
  const truth = new Map(sample.items.map((i) => [i.id, all.get(i.id)])); // a fixed preview round
  const host = await playRoundApi(base, await get('/api/round?mode=quick'), 'shotHostSam'.padEnd(22, 'x'), '1110111011', [90, 80, 70], { nickname: 'Sam' });
  const challenge = new URL(host.challenge_url).pathname;
  for (const dark of [false, true]) {
    for (const [w, h] of [[375, 812], [1280, 800]]) {
      const theme = dark ? 'dark' : 'light';
      const file = (name) => join(WEB, `design/screens/rounds-${name}-${w}-${theme}.png`);
      await open(cdp, `${base}/support`, { width: w, height: h, dark }); // a fresh player in this browser
      await evaluate(cdp, `localStorage.clear(); localStorage.setItem('whosbluffing_anon', ${JSON.stringify(JSON.stringify(`shot${theme}${w}`.padEnd(22, 'y')))}); localStorage.setItem('whosbluffing_sound', 'off'); localStorage.setItem('whosbluffing_round', ${JSON.stringify(JSON.stringify(sample))}); true`);
      await open(cdp, `${base}/play`, { width: w, height: h, dark, motion: 'no-preference' });
      await evaluate(cdp, `(async () => { document.querySelector('#resume-round button').click(); (${waitFor('button.pick')}).click(); ${waitFor('#conf:not([hidden]) [data-conf="80"]')}; return true; })()`);
      await sleep(300);
      await capture(cdp, file('item'), w, h);
      await evaluate(cdp, answerInPage(truth, true, 100)); // right at 100%: confetti, the gold stamp
      await sleep(1300);
      await capture(cdp, file('reveal-right'), w, h);
      await evaluate(cdp, `(async () => { (${waitFor('#next')}).click(); return true; })()`);
      await evaluate(cdp, answerInPage(truth, false, 100)); // wrong at 100%: shake, red flash, the biggest BLUFF stamp
      await sleep(1300);
      await capture(cdp, file('reveal-wrong'), w, h);
      await evaluate(cdp, `(async () => { for (let k = 2; k < 10; k += 1) { (${waitFor('#next')}).click(); ${waitFor('button.pick')};
        document.querySelectorAll('button.pick')[k % 2].click(); (${waitFor('[data-conf="70"]')}).click(); ${waitFor('.reveal')}; }
        (${waitFor('#next')}).click(); ${waitFor('.result-title')}; return true; })()`);
      await sleep(2200); // squares, the type card's flip, the counters and the results
      const box = await evaluate(cdp, `(() => { window.scrollTo(0, 0); const r = document.getElementById('app').getBoundingClientRect();
        return { y: Math.max(0, Math.round(r.top - 72)), h: Math.round(r.height + 96) }; })()`);
      await capture(cdp, file('end'), w, box.h, box.y); // the result, from the nav's height above it
      await open(cdp, `${base}${challenge}`, { width: w, height: h, dark });
      await capture(cdp, file('challenge'), w, h);
    }
  }
}

// The full assessment at /test, answered through the page (two-choice: the first option at 80%; ranges: 10 to 1000,
// sent again after a warning; no demographics), then its results page, whole.
async function resultScreens(cdp, base) {
  const play = `(async () => { document.getElementById('start').click();
    for (let n = 0; n < 60; n += 1) {
      await new Promise((r) => setTimeout(r, 60));
      if (document.querySelector('#app h1') && document.querySelector('.headline')) return true;
      const opt = document.querySelector('.opt');
      if (opt) { opt.click(); (${waitFor('#conf:not([hidden]) [data-c="80"]')}).click(); continue; }
      const range = document.querySelector('form.range');
      if (range) { range.low.value = '10'; range.high.value = '1000'; range.requestSubmit(); await new Promise((r) => setTimeout(r, 60));
        if (document.querySelector('form.range') === range && range.querySelector('.msg').textContent) range.requestSubmit(); continue; }
      const skip = document.querySelector('form.demo .skip');
      if (skip) skip.click();
    }
    throw new Error('the assessment did not reach its results'); })()`;
  for (const dark of [false, true]) {
    for (const [w, h] of [[375, 812], [768, 1024], [1280, 800]]) {
      await open(cdp, `${base}/support`, { width: w, height: h, dark });
      await evaluate(cdp, 'localStorage.clear(); true');
      await open(cdp, `${base}/test`, { width: w, height: h, dark });
      await evaluate(cdp, play);
      await sleep(600);
      await evaluate(cdp, 'window.scrollTo(0, 0)');
      await capture(cdp, join(WEB, `design/screens/results-${w}-${dark ? 'dark' : 'light'}.png`), w);
    }
  }
}

const PRESS_TAB = [{ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }];

// Tabs through the page; returns {controls, reached, missing, noRing}. Controls = visible, enabled, tabbable elements.
async function keyboardWalk(cdp) {
  const controls = await evaluate(cdp, `(() => {
    const els = [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
        && !el.closest('[aria-hidden="true"], details:not([open]) > :not(summary)'));
    els.forEach((el, i) => { el.dataset.walk = i; });
    return els.length; })()`);
  const reached = new Set();
  const noRing = [];
  for (let i = 0; i < controls + 10; i += 1) {
    for (const e of PRESS_TAB) await cdp.send('Input.dispatchKeyEvent', e);
    const f = await evaluate(cdp, `(() => { const el = document.activeElement; if (!el || el === document.body) return null;
      const s = getComputedStyle(el); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none';
      return { id: el.dataset.walk ?? null, ring, label: (el.getAttribute('aria-label') || el.textContent).trim().replace(/\\s+/g, ' ').slice(0, 40) }; })()`);
    if (!f || f.id === null) continue;
    if (reached.has(f.id)) break; // wrapped around
    reached.add(f.id);
    if (!f.ring) noRing.push(f.label);
  }
  const missing = await evaluate(cdp, `[...document.querySelectorAll('[data-walk]')].filter((el) => !${JSON.stringify([...reached])}.includes(el.dataset.walk))
    .map((el) => (el.getAttribute('aria-label') || el.textContent).trim().replace(/\\s+/g, ' ').slice(0, 40))`);
  return { controls, reached: reached.size, missing, noRing };
}

async function checks(cdp, base) {
  let problems = 0;
  const flag = (ok, line) => { if (!ok) problems += 1; console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`); };
  for (const path of PAGES) {
    for (const width of [375, 1280]) {
      await open(cdp, `${base}${path}`, { width, motion: 'no-preference' });
      await sleep(800);
      const r = await evaluate(cdp, `new Promise((done) => { let cls = 0;
        new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => done({ cls: Math.round(cls * 10000) / 10000, overflow: document.documentElement.scrollWidth - innerWidth }), 300); })`);
      flag(r.cls === 0 && r.overflow <= 0, `${path} at ${width}px: layout shift ${r.cls}, horizontal overflow ${r.overflow}px`);
    }
  }
  for (const path of ['/', '/slack', '/discord', '/commands']) {
    for (const width of [1280, 375]) {
      await open(cdp, `${base}${path}`, { width });
      const w = await keyboardWalk(cdp);
      flag(w.reached === w.controls && !w.noRing.length,
        `keyboard ${path} at ${width}px: ${w.reached}/${w.controls} controls reached with Tab, ${w.noRing.length} without a visible ring`
        + (w.missing.length ? `; not reached: ${w.missing.join(' | ')}` : '') + (w.noRing.length ? `; no ring: ${w.noRing.join(' | ')}` : ''));
    }
  }
  await open(cdp, `${base}/slack`, { width: 1280 });
  const before = await evaluate(cdp, `(() => { const b = document.querySelector('[data-theme-toggle]'); b.click();
    return { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') }; })()`);
  await open(cdp, `${base}/research`, { width: 1280 });
  const after = await evaluate(cdp, `({ theme: document.documentElement.dataset.theme, pressed: document.querySelector('[data-theme-toggle]').getAttribute('aria-pressed'),
    bg: getComputedStyle(document.body).backgroundColor })`);
  flag(before.label && after.theme === 'dark' && after.pressed === 'true',
    `theme toggle: aria-label "${before.label}", after a click and a new page: data-theme=${after.theme}, aria-pressed=${after.pressed}, body ${after.bg}`);
  console.log(problems ? `\n${problems} check(s) failed` : '\nall checks pass');
  return problems;
}

// --- the press demo (mode demo) -------------------------------------------------------------------------------------

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const PRESS = join(WEB, 'public/press');
const FPS = 30;
const DISSOLVE = 9; // frames: every cut is a 0.3 s dissolve, the outgoing shot pushing in 4% (design/demo.html)
const STAMP_S = 0.26; // the BLUFF stamp lands this long after the reveal (styles.css: a 0.15 s delay, then the overshoot)
const stampAt = (reveal) => reveal + Math.round(STAMP_S * FPS);
// The editions: one 20 s edit each, shared by its two cuts, in frames: the hook until hookEnd; the game from a (the
// wrong option tapped at tapA, 100% tapped at tap100, the reveal at reveal); the end screen from b; the end card from
// end. words: the frames the hook's words pop on, a tick each; sheet: the review frames, in seconds.
const EDITIONS = {
  // "You're not as smart as you think. Prove it." (design/demo.html's own hook), on a saved topic round.
  v3: { name: 'demo', cut: { hookEnd: 36, a: 36, tapA: 117, tap100: 177, reveal: 185, b: 296, end: 516, total: 600 },
    words: [2, 5, 8, 11, 14, 17, 20, 25, 28],
    captions: [{ html: 'Pick one.', from: 46, to: 177 }, { html: '100% sure. <b>100% wrong.</b>', from: stampAt(185), to: 296 },
      { html: 'And yes, <b>it roasts you.</b>', from: 311, to: 600 }],
    sheet: [1.1, 2.5, 3.97, 6.7, 11, 18.6] },
  // The AI pack: its pair as the hook, then that pair leading a quick round of the pack, its "Did you know" fact held.
  ai: { name: 'demo-ai', pair: 'p36637', pack: 'ai', cut: { hookEnd: 45, a: 45, tapA: 126, tap100: 180, reveal: 188, b: 336, end: 516, total: 600 },
    words: [2, 5, 8, 11, 14, 17, 24, 27, 30, 33],
    hook: { lines: [['Which', 'came'], ['first,', 'ChatGPT'], ['or', 'Anthropic?']], prove: [['How', 'sure'], ['are', 'you?']], scale: 0.9 },
    url: 'whosbluffing.com · the AI pack',
    captions: [{ html: 'Pick one.', from: 55, to: 180 }, { html: '100% sure. <b>100% wrong.</b>', from: stampAt(188), to: 250 },
      { html: '<b>Anthropic</b> came first.', from: 250, to: 600 }],
    sheet: [1.3, 3, 7, 9.5, 13, 18.6] },
};
// Ten answers, [right, conf]: the leading 100% miss on camera, the rest off camera, ending Too sure ("Hot-headed" in the API; 7 of 10 right at
// 81% sure) with the roast line from that miss.
const PLAN = [[0, 100], [1, 80], [0, 70], [1, 80], [1, 80], [0, 80], [1, 80], [1, 80], [1, 80], [1, 80]];
const GAME_SCALE = 2.16; // the tall cut shows the 375x667 game at this scale, so the take is shot at it
// Chrome's shots are full-range BT.601 (JPEG) or RGB (PNG); the videos are limited-range BT.709, tagged so.
const TO_709 = 'scale=out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p';
const TAGS_709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const pad5 = (k) => String(k).padStart(5, '0');

function ffmpeg(...args) {
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args.map(String)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg exited with ${r.status}: ${args.join(' ')}`);
}

const shoot = async (cdp, file, format = 'jpeg') => {
  const { data } = await cdp.send('Page.captureScreenshot', format === 'png' ? { format } : { format, quality: 92, optimizeForSpeed: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
};

// Installed before the page's scripts: performance.now, requestAnimationFrame and setTimeout only move on __tick(ms),
// and so does every CSS and scripted animation (paused, then set to the time since it began). A frame shot after each
// tick is exact however long the screenshot takes.
const VIRTUAL_CLOCK = `(() => {
  let now = 0, ids = 0;
  const frames = new Map(), timers = new Map(), born = new WeakMap();
  performance.now = () => now;
  window.requestAnimationFrame = (f) => { frames.set(++ids, f); return ids; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  window.setTimeout = (f, ms, ...args) => { timers.set(++ids, [now + (Number(ms) || 0), f, args]); return ids; };
  window.clearTimeout = (id) => { timers.delete(id); };
  const sync = () => { for (const a of document.getAnimations()) { if (!born.has(a)) { born.set(a, now); a.pause(); } a.currentTime = now - born.get(a); } };
  window.__tick = (ms) => {
    sync();
    const end = now + ms;
    for (let next; (next = [...timers].filter(([, t]) => t[0] <= end).sort((x, y) => x[1][0] - y[1][0])[0]);) {
      timers.delete(next[0]); now = Math.max(now, next[1][0]); next[1][1](...next[1][2]); sync();
    }
    now = end;
    const due = [...frames.values()]; frames.clear(); for (const f of due) f(now);
    sync();
    return now;
  };
})();`;

// A fresh player in this browser (sound off).
async function freshPlayer(cdp, base, view) {
  await open(cdp, `${base}/support`, view);
  await evaluate(cdp, `localStorage.clear(); localStorage.setItem('whosbluffing_anon', ${JSON.stringify(JSON.stringify(`demo${Date.now().toString(36)}`.padEnd(22, 'p')))});
    localStorage.setItem('whosbluffing_sound', 'off'); true`);
}

// In the page: the right (or wrong) option of the question on screen; a tap on an element, returning its centre (the
// confidence button is only pressed: render.js sends it on the reveal's frame).
const optionExpr = (truth, right) => `document.querySelectorAll('button.pick')[(() => { const st = JSON.parse(localStorage.getItem('whosbluffing_round'));
  const k = st.items.findIndex((i) => !st.answers[i.id]); const t = ${JSON.stringify(Object.fromEntries(truth))}[st.items[k].id]; return ${right ? 't' : '1 - t'}; })()]`;
const confButton = (conf) => `document.querySelector('#conf:not([hidden]) [data-conf="${conf}"]')`;
const tapExpr = (el, press = false) => `(() => { const el = ${el}; const r = el.getBoundingClientRect();
  ${press ? "el.setAttribute('aria-pressed', 'true')" : 'el.click()'}; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
// The end screen's type card and roast line slide in (in place of the card's flip), for the cut to land on them.
const SLIDE_IN = `(() => { for (const [sel, delay] of [['.type-card', 150], ['.roast', 450]]) { const el = document.querySelector(sel); if (!el) continue;
  for (const a of el.getAnimations()) a.cancel();
  el.animate([{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)', fill: 'both' }); }
  return true; })()`;

// The AI edition's round: its pair and nine more of its pack (the most viewed, no item twice), written straight into the
// local D1 as the smoke test does (the pair's ranked day may be ahead), read back as the game would load it. D1_STATE:
// the dev server's --persist-to (npm run dev: web/.wrangler/state).
async function quickRound(base, ed) {
  const { pairs } = JSON.parse(readFileSync(join(WEB, '../items/pairs.json'), 'utf8'));
  const lead = pairs.find((p) => p.id === ed.pair);
  const used = new Set([lead.a_id, lead.b_id]);
  const ids = [lead.id];
  for (const p of pairs.filter((x) => PACKS[ed.pack].categories.includes(x.category)).sort((x, y) => y.fame - x.fame)) {
    if (ids.length === 10) break;
    if (used.has(p.a_id) || used.has(p.b_id)) continue;
    ids.push(p.id); used.add(p.a_id); used.add(p.b_id);
  }
  const id = `DEMOAI${Date.now().toString(36).toUpperCase().replace(/[^A-Z2-9]/g, 'X').slice(-6)}`; // 12 of A-Z, 2-9
  const today = new Date().toISOString().slice(0, 10);
  const sql = `INSERT INTO rounds (round_id, mode, date, items, created_at, difficulty) VALUES ('${id}', 'quick', '${today}', '${JSON.stringify(ids)}', '${today}T00:00:00Z', 'normal')`;
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'whosbluffing', '--local', '--persist-to', process.env.D1_STATE ?? join(WEB, '.wrangler/state'),
    '--command', sql], { cwd: WEB, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not write the quick round: ${r.stderr || r.stdout}`);
  const round = await fetch(`${base}/api/round?round_id=${id}`).then((x) => x.json());
  if (round.items?.[0]?.id !== ed.pair) throw new Error(`the quick round did not load: ${JSON.stringify(round)}`);
  return { round_id: id, mode: 'quick', date: round.date, items: round.items, answers: {}, total: 0, pack: ed.pack, difficulty: 'normal' };
}

// The game take on the page's virtual clock (a fresh player, motion on, no nav), one exact frame per 1/FPS: today's
// ranked round, or `round` (saved as the round in progress, which Play resumes). Segment a: the question, the two taps,
// the reveal; segment b: the end screen. Returns { a, b, taps }.
async function gameTake(cdp, base, dir, truth, { cut: CUT }, round) {
  const view = { width: 375, height: 667, scale: GAME_SCALE };
  await freshPlayer(cdp, base, view);
  await evaluate(cdp, `localStorage.setItem('whosbluffing_round', ${JSON.stringify(JSON.stringify(round))}), true`);
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VIRTUAL_CLOCK });
  await open(cdp, `${base}/play`, { ...view, motion: 'no-preference', waitReady: false });
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  const js = (expr) => evaluate(cdp, expr);
  const until = async (expr) => {
    for (let i = 0; i < 500; i += 1) { if (await js(expr)) return; await sleep(20); }
    throw new Error(`timeout: ${expr}`);
  };
  await js(`document.querySelector('.nav').style.display = 'none', document.getElementById('app').style.scrollMarginTop = '0', __tick(1500), true`);
  await until(`document.documentElement.classList.contains('ready')`);
  await js("document.querySelector('#resume-round button').click(), true");
  await until(`!!document.querySelector('button.pick')`);
  await js('__tick(600)');
  const film = async (seg) => {
    mkdirSync(seg.dir, { recursive: true });
    for (let k = 0; k < seg.frames; k += 1) {
      await seg.before?.(seg.start + k);
      await js(`__tick(${1000 / FPS})`);
      await shoot(cdp, join(seg.dir, `f${pad5(k)}.jpg`));
    }
  };
  const taps = [];
  const a = { dir: join(dir, 'a'), start: CUT.a, frames: CUT.b + DISSOLVE - CUT.a };
  await film({ ...a, async before(f) {
    if (f === CUT.tapA) taps.push({ frame: f, ...(await js(tapExpr(optionExpr(truth, PLAN[0][0])))) });
    if (f === CUT.tap100) taps.push({ frame: f, ...(await js(tapExpr(confButton(PLAN[0][1]), true))) });
    if (f === CUT.reveal) { await js(`${confButton(PLAN[0][1])}.click(), true`); await until(`!!document.querySelector('.reveal')`); }
  } });
  for (const [right, conf] of PLAN.slice(1)) { // off camera
    await js(`document.getElementById('next').click(), true`);
    await until(`!!document.querySelector('button.pick')`);
    await js(tapExpr(optionExpr(truth, right)));
    await js('__tick(1500)'); // a believable answer time (rt_ms) and settled motion
    await js(`${confButton(conf)}.click(), true`);
    await until(`!!document.querySelector('.reveal')`);
  }
  await js(`document.getElementById('next').click(), true`);
  await until(`!!document.querySelector('.result-title')`);
  await js(`document.getElementById('app').scrollIntoView({ behavior: 'instant' }), true`);
  await js(SLIDE_IN);
  const b = { dir: join(dir, 'b'), start: CUT.b, frames: CUT.end + DISSOLVE - CUT.b };
  await film(b);
  return { a, b, taps };
}

// The picture: design/demo.html at w x h, one PNG per frame, with the game take in its phone.
async function stageFrames(cdp, dir, w, h, timeline, total) {
  mkdirSync(dir, { recursive: true });
  await open(cdp, `file://${WEB}design/demo.html?w=${w}&h=${h}`, { width: w, height: h, mobile: false, motion: 'no-preference', waitReady: false });
  await evaluate(cdp, `setup(${JSON.stringify(timeline)})`);
  for (let i = 0; i < total; i += 1) {
    for (let attempt = 1; ; attempt += 1) { // a screenshot that never returns is retried, not waited on
      try {
        await within(20000, (async () => { await evaluate(cdp, `show(${i})`); await shoot(cdp, join(dir, `s${pad5(i)}.png`), 'png'); })());
        break;
      } catch (e) {
        if (attempt === 3) throw new Error(`frame ${i} of ${dir}: ${e.message}`);
        console.log(`  frame ${i}: ${e.message}, again`);
      }
    }
  }
}
const within = (ms, promise) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(`no answer in ${ms} ms`)), ms))]);

// The sound (design/soundtrack.js): the bed (synthesised, or the --music file) brought to -20 LUFS, the effects on the
// edit's frames, the bed ducked 4 dB under them; returns the mix and the second loudnorm pass that puts it at -16 LUFS.
function soundtrack(dir, music, { cut: CUT, words: WORDS }) {
  const s = (frame) => frame / FPS;
  const total = s(CUT.total);
  const bedWav = join(dir, 'bed.wav');
  if (!music) writeFileSync(bedWav, wav(bed({ total, hookEnd: s(CUT.hookEnd), tapA: s(CUT.tapA), tap100: s(CUT.tap100), reveal: s(CUT.reveal), b: s(CUT.b), end: s(CUT.end) })));
  const raw = spawnSync(FFMPEG, ['-loglevel', 'error', '-i', music ?? bedWav, '-t', String(total), '-af',
    `loudnorm=I=-20:TP=-3,afade=t=out:st=${total - 1.2}:d=1.2`, '-ar', String(SR), '-ac', '2', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (raw.status !== 0) throw new Error(`could not read the music: ${raw.stderr}`);
  const sfx = effects({ total, words: WORDS.map(s), taps: [s(CUT.tapA), s(CUT.tap100)], reveal: s(CUT.reveal), stamp: s(CUT.reveal) + STAMP_S, endCard: s(CUT.end) + 0.1 });
  const mixWav = join(dir, 'mix.wav');
  writeFileSync(mixWav, wav(mix(fromPcm(raw.stdout, total), sfx, -4)));
  const m = spawnSync(FFMPEG, ['-hide_banner', '-i', mixWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const j = JSON.parse(m.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
  return { mixWav, af: `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true` };
}

function encode(out, frames, sound) {
  ffmpeg('-framerate', FPS, '-i', join(frames, 's%05d.png'), '-i', sound.mixWav, '-filter_complex', `[0:v]${TO_709}[v];[1:a]${sound.af},aresample=${SR}[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'slow', '-crf', 20, '-pix_fmt', 'yuv420p', ...TAGS_709,
    '-c:a', 'aac', '-b:a', '192k', '-ar', SR, '-ac', 2, '-movflags', '+faststart', out);
}

// A poster: the edition's hook, its closing frame, at w x h.
async function hookPoster(cdp, file, w, h, ed) {
  await open(cdp, `file://${WEB}design/demo.html?w=${w}&h=${h}`, { width: w, height: h, mobile: false, motion: 'no-preference', waitReady: false });
  await evaluate(cdp, `setup(${JSON.stringify({ hookEnd: ed.cut.total, endStart: ed.cut.total, words: ed.words, hook: ed.hook, url: ed.url })})`);
  await evaluate(cdp, `show(${ed.cut.hookEnd})`);
  await capture(cdp, file, w, h);
}

// <name>-vertical.mp4 (1080x1920) and <name>.mp4 (1080x1080): the edition's 20 s edit and sound, the game in a phone
// over navy (design/demo.html). <name>.gif: the square cut's opening 12 s, 640 px, silent. The posters: the hook's
// closing frame at 1200x675, 1080x1920 and 1080x1350. design/screens/<name>-vertical-frames.png: six frames of the tall
// cut, for review. part: vertical | square (one cut).
async function demo(cdp, base, part, music, edition = 'v3') {
  const ed = EDITIONS[edition];
  if (!ed) throw new Error(`unknown edition ${edition} (${Object.keys(EDITIONS).join(' | ')})`);
  const { cut, name } = ed;
  const round = ed.pair ? await quickRound(base, ed)
    : { ...(await fetch(`${base}/api/round?mode=quick`).then((r) => r.json())), answers: {}, total: 0 };
  const ids = round.items.map((i) => i.id);
  const all = truthOf();
  const truth = new Map(ids.map((id) => [id, all.get(id)]));
  const dir = mkdtempSync(join(tmpdir(), 'whosbluffing-demo-'));
  console.log(`${name}: game take`);
  const take = await gameTake(cdp, base, join(dir, 'game'), truth, ed, round);
  const timeline = { hookEnd: cut.hookEnd, endStart: cut.end, words: ed.words, a: take.a, b: take.b, tapA: cut.tapA, taps: take.taps,
    captions: ed.captions, hook: ed.hook, url: ed.url };
  console.log(`${name}: sound`);
  const sound = soundtrack(dir, music, ed);
  for (const [file, w, h] of [[`${name}-vertical`, 1080, 1920], [name, 1080, 1080]]) {
    if (part && part !== (h > w ? 'vertical' : 'square')) continue;
    console.log(file);
    await stageFrames(cdp, join(dir, file), w, h, timeline, cut.total);
    encode(join(dir, `${file}.mp4`), join(dir, file), sound);
  }
  if (existsSync(join(dir, `${name}.mp4`))) {
    ffmpeg('-t', 12, '-i', join(dir, `${name}.mp4`), '-vf',
      'fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', 0, join(dir, `${name}.gif`));
  }
  if (existsSync(join(dir, `${name}-vertical.mp4`))) {
    const sheet = ed.sheet.map((t, i) => {
      const f = join(dir, `sheet${i}.png`);
      ffmpeg('-ss', t, '-i', join(dir, `${name}-vertical.mp4`), '-frames:v', 1, '-vf', 'scale=360:-1:flags=lanczos', f);
      return f;
    });
    ffmpeg(...sheet.flatMap((f) => ['-i', f]), '-filter_complex', `hstack=inputs=${sheet.length}`, join(WEB, `design/screens/${name}-vertical-frames.png`));
  }
  await hookPoster(cdp, join(dir, `${name}-poster.png`), 1200, 675, ed);
  await hookPoster(cdp, join(dir, `${name}-vertical-poster.png`), 1080, 1920, ed);
  await hookPoster(cdp, join(dir, `${name}-poster-1080x1350.png`), 1080, 1350, ed);
  // Copied in at the end: a write under public/ makes `wrangler pages dev` reload, which would break a take.
  for (const f of [`${name}.mp4`, `${name}.gif`, `${name}-poster.png`, `${name}-poster-1080x1350.png`, `${name}-vertical.mp4`, `${name}-vertical-poster.png`]) {
    if (existsSync(join(dir, f))) { copyFileSync(join(dir, f), join(PRESS, f)); console.log(`wrote web/public/press/${f}`); }
  }
  rmSync(dir, { recursive: true, force: true });
}

const args = process.argv.slice(2);
const option = (flag) => (args.includes(flag) ? args.splice(args.indexOf(flag), 2)[1] : undefined);
const music = option('--music');
const edition = option('--edition');
const [mode = 'assets', base = 'http://127.0.0.1:8788', part] = args;
const cdp = await launch();
let failed = 0;
try {
  if (mode === 'assets') await assets(cdp);
  else if (mode === 'screens') await screens(cdp, base, part);
  else if (mode === 'pages') await pageScreens(cdp, base, part ?? mkdtempSync(join(tmpdir(), 'whosbluffing-pages-')));
  else if (mode === 'checks') failed = await checks(cdp, base);
  else if (mode === 'flow') await flowCheck(cdp, base);
  else if (mode === 'rounds') await roundScreens(cdp, base);
  else if (mode === 'results') await resultScreens(cdp, base);
  else if (mode === 'demo') await demo(cdp, base, part, music, edition);
  else throw new Error(`unknown mode ${mode} (assets | screens | pages | checks | flow | rounds | results | demo)`);
} finally {
  cdp.close();
}
process.exit(failed ? 1 : 0);
