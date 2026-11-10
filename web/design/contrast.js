// WCAG contrast check for the colour tokens in public/styles.css (no dependencies). Reads the light block (:root) and
// the dark block (:root[data-theme="dark"], which must match the prefers-color-scheme copy), then checks every
// text/background pair the stylesheet uses. Exit code 1 if any pair fails.   Usage: node web/design/contrast.js
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no "${selector} {" block in styles.css`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6}\b|\d+%)/g)].map((m) => [m[1], m[2].toUpperCase()]));
}

const light = tokens(':root');
const darkOnly = tokens(':root[data-theme="dark"]');
const darkMedia = tokens(':root:not([data-theme="light"])');
if (JSON.stringify(darkOnly) !== JSON.stringify(darkMedia)) throw new Error('the two dark blocks in styles.css differ');
const themes = { light, dark: { ...light, ...darkOnly } };

const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, where]. Body text needs 4.5:1.
const TEXT = [
  ['text', 'bg', 'body text'], ['text', 'surface', 'text in cards and inputs'], ['text', 'ground-alt', 'quotes, the roast'],
  ['muted', 'bg', 'secondary text'], ['muted', 'surface', 'secondary text in cards, placeholders'], ['muted', 'ground-alt', 'secondary text in quotes'],
  ['accent', 'bg', 'links, the headline\'s accent word'], ['accent', 'surface', 'links in cards'], ['accent', 'ground-alt', 'links in quotes'],
  ['accent-ink', 'accent', 'primary buttons; the Get started panel; the Modest type card'],
  ['accent', 'accent-ink', 'the paper button on the Get started panel'],
  ['text', 'accent-soft', 'notes, code, selected options'], ['accent', 'accent-soft', 'badges, pick letters, selected confidence'],
  ['hit-ink', 'bg', 'hit text'], ['hit-ink', 'surface', 'hit verdicts, sent messages'],
  ['miss-ink', 'bg', 'miss text, errors'], ['miss-ink', 'surface', 'miss verdicts, errors in cards'],
  ['gold-ink', 'surface', 'the Called it stamp on a card'],
  ['surface', 'hit-ink', 'the right answer\'s letter; the Spot on type card'],
  ['surface', 'miss-ink', 'the wrong pick\'s letter; the Bluffer type card'],
  ['surface', 'gold-ink', 'the Hot-headed type card'], ['surface', 'muted', 'the Hedger type card'],
];
// Display text of 24px bold or larger may use 3:1. None of the tokens needs this today.
const LARGE = [];
// Non-text (WCAG 1.4.11, 3:1): the focus ring is a 2px --accent outline (--accent-ink on the accent panel); inputs are outlined in --muted.
const NON_TEXT = [
  ['accent', 'bg', 'focus ring'], ['accent', 'surface', 'focus ring on cards'], ['accent', 'ground-alt', 'focus ring in quotes'],
  ['accent-ink', 'accent', 'focus ring on the Get started panel'],
  ['muted', 'surface', 'input borders'], ['muted', 'bg', 'input borders on the page'],
];

// color-mix(in srgb, a p, b) as a hex colour.
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, p, b) => `#${rgb(a).map((v, i) => Math.round(v * p + rgb(b)[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
// Tinted grounds (styles.css): the round's reveal and the example verdict are 9% hit or miss over --surface; the
// Discord mock's private reply is 6% accent over --surface. Pills: the secondary pill is 7% --text over the page (11% on
// hover), the nav's hover and current link 6%; on the Get started panel the same 7% and 11% over --accent.
for (const t of Object.values(themes)) {
  t['hit-tint'] = mix(t.hit, 0.09, t.surface);
  t['miss-tint'] = mix(t.miss, 0.09, t.surface);
  t.private = mix(t.accent, 0.06, t.surface);
  t.pill = mix(t.text, 0.11, t.bg);
  t['nav-pill'] = mix(t.text, 0.06, t.bg);
  t['panel-pill'] = mix(t.text, 0.07, t.accent);
  t['panel-pill-hover'] = mix(t.text, 0.11, t.accent);
}
TEXT.push(['hit-ink', 'hit-tint', 'a right answer\'s verdict'], ['text', 'hit-tint', 'the reaction under a right answer'],
  ['miss-ink', 'miss-tint', 'a wrong answer\'s verdict'], ['text', 'miss-tint', 'the reaction under a wrong answer'],
  ['muted', 'private', 'the Discord mock\'s private reply'], ['text', 'pill', 'secondary pills (hovered)'],
  ['text', 'nav-pill', 'the nav\'s current link'], ['accent-ink', 'panel-pill', 'secondary pills on the Get started panel'],
  ['accent-ink', 'panel-pill-hover', 'secondary pills on the Get started panel, hovered']);

let failures = 0;
function report(title, pairs, min) {
  console.log(`\n${title} (minimum ${min.toFixed(1)}:1)`);
  if (!pairs.length) { console.log('  none'); return; }
  for (const [name, t] of Object.entries(themes)) {
    for (const [fg, bg, where] of pairs) {
      const r = ratio(t[fg], t[bg]);
      const ok = r >= min;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(5)} ${`--${fg}`.padEnd(13)} ${t[fg]} on ${`--${bg}`.padEnd(13)} ${t[bg]}  ${r.toFixed(2).padStart(5)}:1  ${where}`);
    }
  }
}

report('Text', TEXT, 4.5);
report('Large display text', LARGE, 3);
report('Non-text', NON_TEXT, 3);
console.log(failures ? `\n${failures} pair(s) below the minimum` : '\nall pairs pass');
process.exit(failures ? 1 : 0);
