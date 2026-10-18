// Site chrome for every page. A classic script loaded in <head> (not a module), so the stored theme applies before the
// first paint. Then: theme toggle, mobile menu, current-page link, install and social links from the constants below,
// tabs, list filters and the logo mark's fan. No dependencies.

// Addresses that exist only once the owner has set them up. An empty string hides whatever depends on it.
const SLACK_INSTALL_URL = 'https://whosbluffing-slack.rongaijun41.workers.dev/slack/oauth/start'; // the Slack Worker's install URL (slack/README.md, step 8)
const DISCORD_INSTALL_URL = 'https://discord.com/oauth2/authorize?client_id=1556371051439587461&scope=bot%20applications.commands&permissions=83968&integration_type=0'; // server install; matches the Discord Worker's /install
const DISCORD_USER_INSTALL_URL = 'https://discord.com/oauth2/authorize?client_id=1556371051439587461&scope=applications.commands&integration_type=1'; // personal commands only; no server permissions
const CONTACT_EMAIL = 'hello@whosbluffing.com'; // e.g. hello@whosbluffing.com once email routing works (hidden until set)
const GITHUB_URL = 'https://github.com/ethan-rong/whos-bluffing';
const X_URL = 'https://x.com/whos_bluffing'; // e.g. https://x.com/<handle>
const BLUESKY_URL = ''; // e.g. https://bsky.app/profile/<handle>
const ACTIONS_URL = 'https://github.com/ethan-rong/whos-bluffing/actions'; // the repository's GitHub Actions page, once the repository is public (/status links to it)

(() => {
  const root = document.documentElement;
  const THEME_KEY = 'whosbluffing_theme';
  const APP_REVEAL_MS = 4000; // app pages show their footer by then even if app.js never finishes its first render
  const prefersDark = matchMedia('(prefers-color-scheme: dark)');
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch { /* storage blocked: follow the system theme */ }
  root.classList.add('js'); // styles.css hides below-the-game content until the page is .ready
  // Before the first paint: what the constants switch on is shown by styles.css at once, so nothing moves at load.
  if (CONTACT_EMAIL) root.classList.add('has-contact');
  if (ACTIONS_URL) root.classList.add('has-actions');
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : prefersDark.matches);
  const all = (sel) => document.querySelectorAll(sel);

  // Class mode: a page opened with ?c=CODE (a class code) marks this tab, so the game's lines stay mild and sound starts
  // off. Sound: on by default, kept in localStorage; in class mode off by default and kept for the tab only.
  const SOUND_KEY = 'whosbluffing_sound';
  let classMode = false;
  try {
    if (new URLSearchParams(location.search).has('c')) sessionStorage.setItem('whosbluffing_class', '1');
    classMode = sessionStorage.getItem('whosbluffing_class') === '1';
  } catch { /* storage blocked: not in class mode */ }
  let soundChoice = null; // this page's choice, when storage is blocked
  const soundStore = () => (classMode ? sessionStorage : localStorage);
  const soundOn = () => {
    if (soundChoice !== null) return soundChoice;
    try { const v = soundStore().getItem(SOUND_KEY); if (v) return v === 'on'; } catch { /* default */ }
    return !classMode;
  };
  const syncSound = () => { for (const b of all('[data-sound-toggle]')) b.setAttribute('aria-pressed', String(soundOn())); };
  const setSound = (on) => {
    soundChoice = on;
    try { soundStore().setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* kept for this page only */ }
    syncSound();
  };
  window.whosbluffing = Object.freeze({ classMode, soundOn, setSound, syncSound });
  // Speaker buttons ([data-sound-toggle]) in the nav and on the game screen, including ones drawn later.
  document.addEventListener('click', (e) => { if (e.target.closest?.('[data-sound-toggle]')) setSound(!soundOn()); });

  // Links that point at a constant: set the address, or keep them hidden while it is empty.
  function wireLinks() {
    for (const a of all('[data-slack-install]')) a.href = SLACK_INSTALL_URL;
    for (const a of all('[data-discord-install]')) { if (DISCORD_INSTALL_URL) a.href = DISCORD_INSTALL_URL; else a.hidden = true; }
    for (const a of all('[data-discord-user-install]')) { if (DISCORD_USER_INSTALL_URL) a.href = DISCORD_USER_INSTALL_URL; else a.hidden = true; }
    const social = { github: GITHUB_URL, x: X_URL, bluesky: BLUESKY_URL };
    for (const a of all('[data-social]')) {
      const url = social[a.dataset.social];
      if (url) { a.href = url; a.hidden = false; }
    }
    for (const el of all('[data-contact]')) el.hidden = !CONTACT_EMAIL;
    for (const a of all('[data-contact-link]')) if (CONTACT_EMAIL) { a.href = `mailto:${CONTACT_EMAIL}`; a.textContent = CONTACT_EMAIL; }
    for (const a of all('[data-actions]')) if (ACTIONS_URL) { a.href = ACTIONS_URL; a.hidden = false; }
    for (const el of all('[data-actions-soon]')) el.hidden = Boolean(ACTIONS_URL);
  }

  // role="tablist": click or arrow keys select a tab and show its panel; the address hash picks the first one
  // (a panel's id, or the id of anything inside a panel). Without JavaScript every panel shows.
  function wireTabs() {
    for (const list of all('[role="tablist"]')) {
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));
      const select = (tab, { focus = false, remember = false } = {}) => {
        for (const t of tabs) {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          panelOf(t).hidden = !on;
        }
        if (focus) tab.focus();
        if (remember) history.replaceState(null, '', `#${tab.getAttribute('aria-controls')}`);
      };
      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => select(tab, { remember: true }));
        tab.addEventListener('keydown', (e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
          if (step === undefined) return;
          e.preventDefault();
          select(tabs[(i + step + tabs.length) % tabs.length], { focus: true, remember: true });
        });
      });
      const target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      const fromHash = target && tabs.find((t) => panelOf(t).contains(target));
      select(fromHash ?? tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
      if (fromHash && target !== panelOf(fromHash)) target.scrollIntoView();
    }
  }

  // <input data-filter="ID [ID …]">: hides the [data-item] elements inside #ID that don't contain the typed text;
  // #ID-none shows when none of them match.
  function wireFilters() {
    for (const input of all('[data-filter]')) {
      const groups = input.dataset.filter.split(/\s+/).map((id) => ({
        items: [...document.querySelectorAll(`#${id} [data-item]`)], none: document.getElementById(`${id}-none`),
      }));
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        for (const g of groups) {
          for (const item of g.items) item.hidden = !item.textContent.toLowerCase().includes(q);
          if (g.none) g.none.hidden = g.items.some((item) => !item.hidden);
        }
      });
    }
  }

  // The mark's two cards fan apart and spring back, and its pip flips, on hover or tap; styles.css holds the motion and
  // its reduced-motion fallback. Links still navigate.
  function wireMarks() {
    for (const mark of all('[data-mark]')) {
      const host = mark.closest('a, button') ?? mark;
      const pop = () => {
        mark.classList.remove('pop');
        void mark.getBoundingClientRect(); // restart the animation
        mark.classList.add('pop');
      };
      host.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') pop(); });
      host.addEventListener('pointerdown', pop);
      mark.addEventListener('animationend', (e) => { if (e.animationName === 'pip-flip') mark.classList.remove('pop'); }); // ready to pop again
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireLinks(); // before .ready, so the footer's icons are settled when it first shows
    if (document.getElementById('app')) setTimeout(() => root.classList.add('ready'), APP_REVEAL_MS);
    else root.classList.add('ready');

    const toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      const sync = () => toggle.setAttribute('aria-pressed', String(isDark()));
      sync();
      prefersDark.addEventListener('change', sync);
      toggle.addEventListener('click', () => {
        root.dataset.theme = isDark() ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* not stored: lasts until the next page */ }
        sync();
      });
    }

    const menu = document.querySelector('.nav-menu');
    const links = document.getElementById('nav-links');
    if (menu && links) {
      const setOpen = (open) => {
        links.classList.toggle('open', open);
        menu.setAttribute('aria-expanded', String(open));
      };
      menu.addEventListener('click', () => {
        const open = !links.classList.contains('open');
        setOpen(open);
        if (open) links.querySelector('a').focus({ preventScroll: true });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && links.classList.contains('open')) { setOpen(false); menu.focus(); }
      });
    }

    syncSound();
    const here = location.pathname.replace(/\/$/, '') || '/';
    for (const a of all('.nav-links a')) if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
    wireTabs();
    wireFilters();
    wireMarks();
  });
})();
