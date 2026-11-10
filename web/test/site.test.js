// Static site checks: the Markdown converter behind /privacy, /terms and /docs/api; every page's head, shared header
// and footer, sitemap entry and CSP-safe markup; the MAU definition on /research; the home page's copy, sections and
// "played today" threshold; the live panel on /stats and the FAQ on /support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { markdown, inline, renderPage, DOCS } from '../scripts/sync-docs.js';
import { playedLine, MIN_PLAYERS } from '../public/home.js';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (u) => readFileSync(u, 'utf8');
const pages = readdirSync(PUBLIC, { recursive: true }).filter((f) => f.endsWith('.html')).sort();
const pathOf = (file) => `/${file.replace(/\.html$/, '').replace(/^index$/, '')}`;
const block = (htmlText, re) => htmlText.match(re)?.[0];
const HEADER = /<header class="nav">[\s\S]*?<\/header>/;
const FOOTER = /<footer class="site-foot">[\s\S]*?<\/footer>/;

test('markdown: headings with ids, paragraphs, lists, bold, safe links; code and text are escaped', () => {
  const md = '# Daily API\n\nBase: `https://<host>/api` & **bold** text\nwrapped line.\n\n- one [docs](/docs/api)\n- two [x](javascript:void)\n\n1. first\n2. second';
  assert.equal(markdown(md), [
    '<h1 id="daily-api">Daily API</h1>',
    '<p>Base: <code>https://&lt;host&gt;/api</code> &amp; <strong>bold</strong> text wrapped line.</p>',
    '<ul>\n<li>one <a href="/docs/api">docs</a></li>\n<li>two x</li>\n</ul>',
    '<ol>\n<li>first</li>\n<li>second</li>\n</ol>',
  ].join('\n'));
  assert.equal(inline('`**not bold**` and <b>'), '<code>**not bold**</code> and &lt;b&gt;');
  const page = renderPage(DOCS[0], '# Privacy', '<title>{{title}}</title><link href="https://whosbluffing.com{{path}}">{{main}} $& {{path}}');
  assert.match(page, /^<title>Privacy \| Who's Bluffing\?<\/title><link href="https:\/\/whosbluffing.com\/privacy"><article/);
  assert.match(page, /<\/article> \$& \/privacy$/); // "$&" in the template is not a replacement pattern
});

test('every page: title, description, canonical, Open Graph, icons, theme colours, shared header and footer', () => {
  const template = read(new URL('../scripts/page.html', import.meta.url));
  assert.ok(pages.length >= 15, `only ${pages.length} pages`);
  for (const file of pages) {
    const h = read(new URL(file, PUBLIC));
    const want = (re, what) => assert.match(h, re, `${file}: ${what}`);
    want(/<title>[^<{]{10,}<\/title>/, 'title');
    want(/<meta name="description" content="[^"{]{20,}">/, 'description');
    if (file === '404.html') want(/<meta name="robots" content="noindex">/, 'noindex');
    else want(new RegExp(`<link rel="canonical" href="https://whosbluffing.com${pathOf(file)}">`), 'canonical');
    want(/<meta property="og:image" content="https:\/\/whosbluffing.com\/og.png">/, 'og:image');
    want(/<meta name="twitter:card" content="summary_large_image">/, 'twitter card');
    want(/<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml">/, 'favicon');
    want(/<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/, 'touch icon');
    want(/<meta name="theme-color" content="#FBFAF7" media="\(prefers-color-scheme: light\)">/, 'theme-color');
    want(/<script src="\/site.js"><\/script>\n(<script type="module" src="\/app.js"><\/script>\n)?<\/head>/, 'site.js in head');
    assert.equal(block(h, HEADER), block(template, HEADER), `${file}: header differs from scripts/page.html`);
    assert.equal(block(h, FOOTER), block(template, FOOTER), `${file}: footer differs from scripts/page.html`);
  }
});

test('markup is CSP-safe and the sitemap lists only indexable pages', () => {
  for (const file of pages) {
    const h = read(new URL(file, PUBLIC));
    const executable = h.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (_, data) => {
      JSON.parse(data); // Structured data is an inert JSON block, not executable JavaScript.
      return '';
    });
    assert.doesNotMatch(executable, /<script(?![^>]*\bsrc=)[^>]*>/, `${file}: inline script`);
    assert.doesNotMatch(h, /\sstyle=|<style|\son[a-z]+=/i, `${file}: inline style or event handler`);
  }
  const listed = [...read(new URL('sitemap.xml', PUBLIC)).matchAll(/<loc>https:\/\/whosbluffing\.com(\/[^<]*)<\/loc>/g)].map((m) => m[1]).sort();
  const expected = pages.filter((f) => !/<meta name="robots" content="[^"]*noindex/.test(read(new URL(f, PUBLIC)))).map(pathOf).sort();
  assert.deepEqual(listed, expected);
});

test('search metadata describes the real apps; session pages stay out of search', () => {
  for (const file of ['index.html', 'discord.html', 'slack.html']) {
    const h = read(new URL(file, PUBLIC));
    const data = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data['@context'], 'https://schema.org');
    assert.equal(data.url, `https://whosbluffing.com${pathOf(file)}`);
    assert.equal(data.isAccessibleForFree, true);
    assert.equal(data.applicationCategory, 'GameApplication');
    assert.ok(!data.aggregateRating && !data.review, 'no invented ratings');
    assert.match(h.match(/<title>(.*?)<\/title>/)[1], /Trivia/);
    assert.match(data.description, /trivia/);
  }
  for (const file of ['results.html', 'class.html', 'stats.html']) {
    assert.match(read(new URL(file, PUBLIC)), /<meta name="robots" content="noindex, follow">/);
  }
  assert.doesNotMatch(read(new URL('robots.txt', PUBLIC)), /Disallow:\s*\/\s*$/m, 'public pages remain crawlable');
  const discord = read(new URL('discord.html', PUBLIC));
  assert.match(discord, /href="https:\/\/discord.com\/discovery\/applications\/1556371051439587461"/);
  assert.doesNotMatch(discord, /<p>Not yet\. Add it with/);
});

test('Discord install buttons keep personal commands separate from server permissions, with working no-script links', () => {
  const page = read(new URL('discord.html', PUBLIC));
  const script = read(new URL('site.js', PUBLIC));
  const boot = (source) => {
    const personal = { hidden: false }, server = { hidden: false };
    let ready;
    const storage = { getItem: () => null, setItem: () => {} };
    runInNewContext(source, {
      document: {
        documentElement: { dataset: {}, classList: { add: () => {} } },
        addEventListener: (event, fn) => { if (event === 'DOMContentLoaded') ready = fn; },
        querySelectorAll: (selector) => selector === '[data-discord-user-install]' ? [personal] : selector === '[data-discord-install]' ? [server] : [],
        querySelector: () => null, getElementById: () => null,
      },
      window: {}, localStorage: storage, sessionStorage: storage, URLSearchParams,
      location: { search: '', pathname: '/discord', hash: '' }, matchMedia: () => ({ matches: false }),
    });
    ready();
    return { personal, server };
  };
  const { personal, server } = boot(script);
  for (const [link, attr, type, scope] of [
    [personal, 'data-discord-user-install', '1', 'applications.commands'],
    [server, 'data-discord-install', '0', 'bot applications.commands'],
  ]) {
    const url = new URL(link.href);
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), '1556371051439587461');
    assert.equal(url.searchParams.get('integration_type'), type);
    assert.equal(url.searchParams.get('scope'), scope);
    const fallback = page.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*\\b${attr}(?:\\s|>)`))?.[1];
    assert.equal(fallback?.replaceAll('&amp;', '&'), link.href, `${attr}: HTML and JavaScript agree`);
    assert.equal(link.hidden, false);
  }
  assert.equal(new URL(personal.href).searchParams.has('permissions'), false, 'personal install grants no bot permissions');
  assert.equal(new URL(server.href).searchParams.get('permissions'), '83968', 'server permissions are unchanged');
  assert.match(page, /class="button primary"[^>]*data-discord-user-install/);
  const schema = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema.installUrl, personal.href);
  const disabled = boot(script.replace(/const DISCORD_(?:USER_)?INSTALL_URL = '[^']*'/g, (line) => line.replace(/'[^']*'/, "''")));
  assert.equal(disabled.personal.hidden, true);
  assert.equal(disabled.server.hidden, true);
});

test('homepage total: show from 100 players', () => {
  assert.equal(MIN_PLAYERS, 100);
  assert.equal(playedLine(null), null); // the stats request failed
  assert.equal(playedLine({ total_players: MIN_PLAYERS - 1 }), null);
  assert.equal(playedLine({ total_players: 100 }), '100 total players');
  assert.equal(playedLine({ total_players: 4040 }), '4,040 total players');
  assert.match(read(new URL('index.html', PUBLIC)), /<p class="played" data-played hidden><\/p>/);
});

// Visible text of a page: no head, scripts, comments or tags.
const visible = (h) => h.replace(/<head>[\s\S]*?<\/head>|<!--[\s\S]*?-->|<svg[\s\S]*?<\/svg>|<!doctype html>/gi, ' ').replace(/<[^>]+>/g, ' ');
const words = (text) => text.trim().split(/\s+/).length;

test('home page: one headline and short copy per section, in the house register; the old sections are gone', () => {
  const home = read(new URL('index.html', PUBLIC));
  assert.match(home, /<h1 id="hero-title">Who's <span class="h1-accent">bluffing<\/span>\?<\/h1>/);
  assert.match(home, /<p class="hero-sub">[^<]+<\/p>\n {6}<p class="hero-note">Every answer comes with a source, so you learn as you play\.<\/p>/);
  assert.equal([...home.match(/<div class="home-copy">[\s\S]*?<div class="actions">/)[0].matchAll(/<p /g)].length, 2, 'the hero copy: the sentence and the note');
  assert.match(home, /<button class="primary" id="play" type="button" data-play>/);
  const budgets = [ // [paragraph, at most this many words]
    [/<p class="hero-sub">([^<]+)<\/p>/, 16], [/id="reveal-title">[^<]+<\/h2>\s*<p>([^<]+)<\/p>/, 30],
    [/id="packs-title">[^<]+<\/h2>\s*<p>([^<]+)<\/p>/, 25], [/questions, each with a source<\/h2>\s*<p>([^<]+)<\/p>/, 20],
    [/id="start-title">[^<]+<\/h2>\s*<p>([^<]+)<\/p>/, 20],
  ];
  for (const [re, most] of budgets) {
    const text = home.match(re)?.[1];
    assert.ok(text && words(text) <= most, `"${text}" is over ${most} words`);
  }
  assert.equal([...home.matchAll(/<h2 id="[a-z]+-title">/g)].length, 4);
  const text = visible(home.replace(/<!-- prompts -->[\s\S]*<!-- \/prompts -->/, '')); // the prompts are the game's data, not copy
  assert.doesNotMatch(text, /calibrat|open source|—|!|\b(first|largest|best)\b/i);
  for (const gone of ['class="live"', 'id="faq"', 'id="how"', 'id="ways"', 'id="open"', 'id="proof"', 'premium']) assert.ok(!home.includes(gone), gone);
});

test('the FAQ lives on /support under "Answers that may help", and nothing links to /#faq any more', () => {
  const support = read(new URL('support.html', PUBLIC));
  assert.match(support, /<h2 id="faq">Answers that may help<\/h2>\n {2}<div class="faq">(\n {4}<details><summary>[^<]+<\/summary><p>[\s\S]+?<\/p><\/details>){8}\n {2}<\/div>/);
  for (const file of pages) assert.ok(!read(new URL(file, PUBLIC)).includes('href="/#faq"'), file);
});

test('status and stats show only the public total; the picker has no daily ranked action', () => {
  for (const file of ['status.html', 'stats.html']) {
    const page = read(new URL(file, PUBLIC));
    assert.match(page, /<h1[^>]*>Total Players<\/h1>/);
    assert.match(page, /class="player-count" data-player-count/);
    assert.doesNotMatch(page, /data-live|data-kpi|DAU|MAU|data-ranked/);
    assert.match(page, /src="\/status.js"/);
  }
  assert.doesNotMatch(read(new URL('play.html', PUBLIC)), /data-ranked|Daily ranked/);
  assert.doesNotMatch(read(new URL('status.js', PUBLIC)), /api\/kpi|api\/round\/stats/);
});
