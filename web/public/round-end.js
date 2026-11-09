// Pieces of a finished round's end screen: the result grid (one square per question, green right, red wrong) and the
// detail card a square opens, and after an AI or Politics round the side block (the one piece that calls the API).
// Pure HTML builders plus wiring functions, so node tests can render them. st = the round state of rounds.js: {items:
// [{id, prompt, a, b}], answers: {id: {choice, conf, correct, points, truth, line}}}.
import { html, fmtValue, api, store, anonId } from './ui.js';
import { BOARDS } from './packs.js';

export { fmtValue }; // the shared formatter: years, months, dollars, big counts (ui.js)
export const fmtPoints = (p) => (p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '0');

// Dare rounds (/dare/<slug>): the rank tile's label ("#212" over "of 3,400 on Mr. Altman’s round"), and the line a
// browser that has finished the dare sees instead of playing it again.
export const dareRankLabel = (players, address) => `of ${players.toLocaleString('en-US')} on ${address}’s round`;
export const dareDone = (score) => `You have taken this round: ${score < 0 ? `−${-score}` : score} points.`;

// The squares pop in one after another (styles.css staggers them); misses shake once after their pop.
export function resultGrid(st, t) {
  return html`<div class="result-grid" role="group" aria-label="${t('rounds.grid_label')}">${st.items.map((it, k) => {
    const a = st.answers[it.id];
    if (!a) return '';
    const label = t('rounds.sq_label', { i: k + 1, verdict: a.correct ? t('rounds.right') : t('rounds.wrong'), conf: a.conf, points: fmtPoints(a.points) });
    return html`<button type="button" class="sq anim anim-pop${a.correct ? '' : ' miss anim-shake'}" data-k="${k}" aria-expanded="false" aria-controls="sq-detail" aria-label="${label}"></button>`;
  })}</div>
<div class="sq-detail card" id="sq-detail" aria-live="polite" hidden></div>`;
}

// The question behind square k: the prompt, your pick and confidence, both true values with sources (and the reveal
// fact, when the pair has one), the points and the line the game said.
export function detailCard(st, k, t) {
  const it = st.items[k];
  const a = st.answers[it.id];
  const truth = a.correct ? a.choice : 1 - a.choice;
  const names = [it.a, it.b];
  const values = [a.truth.a_value, a.truth.b_value];
  const sources = [a.truth.a_source, a.truth.b_source];
  return html`<p class="sq-n">${t('rounds.detail_n', { i: k + 1, n: st.items.length })}</p>
<h3 class="sq-q">${it.prompt}</h3>
<p class="sq-pick">${t('rounds.detail_pick', { letter: 'AB'[a.choice], name: names[a.choice], conf: a.conf })}</p>
<ul class="sq-truth">${[0, 1].map((c) => html`<li class="${c === truth ? 'is-true' : ''}"><span class="name">${c === truth ? '✓ ' : ''}${names[c]}</span>: ${fmtValue(values[c], a.truth.unit)} <a href="${sources[c]}" target="_blank" rel="noopener noreferrer">${t('rounds.source')}</a></li>`)}</ul>
${a.truth.fun ? html`<p class="fun"><span class="fun-label">${t('rounds.fun_label')}</span> ${a.truth.fun}</p>` : ''}
<p class="sq-pts ${a.correct ? 'hit' : 'miss'}">${a.correct ? t('rounds.right') : t('rounds.wrong')} · ${fmtPoints(a.points)} ${t('rounds.pts')}</p>
${a.line ? html`<p class="reaction">${a.line}</p>` : ''}`;
}

// A square opens its question's card below the grid; the same square (or Escape inside the card) closes it.
export function wireGrid(root, st, t) {
  const card = root.querySelector('#sq-detail');
  const squares = [...root.querySelectorAll('.sq')];
  let open = -1;
  const show = (k) => {
    open = k;
    for (const s of squares) {
      const on = Number(s.dataset.k) === k;
      s.setAttribute('aria-expanded', String(on));
      s.classList.toggle('is-open', on);
    }
    card.hidden = k < 0;
    card.innerHTML = k < 0 ? '' : detailCard(st, k, t);
  };
  for (const s of squares) s.addEventListener('click', () => show(Number(s.dataset.k) === open ? -1 : Number(s.dataset.k)));
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || open < 0) return;
    const back = squares.find((s) => Number(s.dataset.k) === open);
    show(-1);
    back?.focus();
  });
}

// --- after an AI or Politics round: "Which lab are you with?" / "Which side are you on?" ----------------------------
// One chip per side of the pack's board (packs.js BOARDS: labs for AI); a tap claims the round for
// that side (POST /api/round/<key>), presses the chip and shows the mini board. The side is kept in this browser
// (whosbluffing_lab) and later rounds of that pack claim it at once, showing "You're with {lab}" or
// "Your side: {side}" and "change". Quick rounds only: a challenge round loads as pack All, and a dare round is not a
// quick round (the API refuses it). board = the body of GET /api/<list>: {min_players, <list>: [{<key>, name, players,
// mean_score, mean_overconfidence}]}. Both boards use the lab-* class names (styles.css).
export const boardOf = (st) => (st.mode === 'quick' && Object.hasOwn(BOARDS, st.pack ?? '') ? st.pack : null);
const storeKey = (pack) => `whosbluffing_${BOARDS[pack].key}`;
export const savedSide = (pack) => {
  const side = store.get(storeKey(pack), null);
  return typeof side === 'string' && Object.hasOwn(BOARDS[pack].sides, side) ? side : null;
};
const fmtScore = (n) => (n < 0 ? `−${-n}` : String(n));

// Overconfidence in words: "12 points more sure than right", "as sure as right", "1 point less sure than right".
export function overWords(x, t) {
  const n = Math.round(x);
  if (n > 1) return t('labs.over_more', { x: n });
  if (n === 1) return t('labs.over_more_one');
  if (n === -1) return t('labs.over_less_one');
  if (n < -1) return t('labs.over_less', { x: -n });
  return t('labs.over_even');
}

// The board as a table in the API's order: players, then the average score (full: and the overconfidence in words), or
// how many more players the side needs. `mine` (the player's side) is highlighted.
export function sideTable(pack, board, mine, t, { full = false } = {}) {
  const { key, list } = BOARDS[pack];
  const row = (l) => {
    const need = board.min_players - l.players;
    const means = l.mean_score === null
      ? html`<td class="lab-need" colspan="${full ? 2 : 1}">${need === 1 ? t(`${list}.need_one`) : t(`${list}.need`, { k: need })}</td>`
      : html`<td>${fmtScore(Math.round(l.mean_score))}</td>${full ? html`<td>${overWords(l.mean_overconfidence, t)}</td>` : ''}`;
    return html`<tr class="${l[key] === mine ? 'is-mine' : ''}"><th scope="row">${l.name}${l[key] === mine ? html` <span class="lab-you">${t(`${list}.yours`)}</span>` : ''}</th><td>${l.players.toLocaleString('en-US')}</td>${means}</tr>`;
  };
  return html`<table class="vs lab-table"><thead><tr><th scope="col">${t(`${list}.col_side`)}</th><th scope="col">${t(`${list}.col_players`)}</th><th scope="col">${t(`${list}.col_score`)}</th>${full ? html`<th scope="col">${t(`${list}.col_over`)}</th>` : ''}</tr></thead>
<tbody>${board[list].map(row)}</tbody></table>`;
}

// The share text's side line, once the player's side has an average (min_players claims), else null. Only boards with
// `share` (the labs) have one; the Politics share text stays as it is.
export function sideShareLine(pack, board, side, t) {
  const { key, list, share } = BOARDS[pack];
  const l = share ? board?.[list].find((x) => x[key] === side) : null;
  return l && l.mean_score !== null ? t(`${list}.share_line`, { side: l.name, score: fmtScore(Math.round(l.mean_score)) }) : null;
}

// The share text with the side line before the link, so the link stays last; unchanged without a line.
export function withSideLine(text, line, url) {
  if (!line) return text;
  const tail = [`\n${url}`, ` · ${url}`].find((x) => text.endsWith(x));
  return tail ? `${text.slice(0, -tail.length)}\n${line}\n${url}` : `${text}\n${line}`;
}

// side: the saved side (the chips wait behind "change"), or null (the question and the chips).
export function sideBlock(pack, t, side) {
  const { list, sides } = BOARDS[pack];
  return html`<section class="card lab-claim" aria-labelledby="lab-q">
  <h3 id="lab-q"${side ? ' hidden' : ''}>${t(`${list}.question`)}</h3>
  <p class="lab-with"${side ? '' : ' hidden'}><span data-lab-with>${side ? t(`${list}.with`, { side: sides[side] }) : ''}</span> · <button type="button" class="link" data-lab-change>${t(`${list}.change`)}</button></p>
  <div class="chips lab-chips" role="group" aria-labelledby="lab-q"${side ? ' hidden' : ''}>${Object.entries(sides).map(([k, name]) => html`<button type="button" class="chip" data-lab="${k}" aria-pressed="${String(k === side)}">${name}</button>`)}</div>
  <p class="msg" role="status"></p>
  <div data-lab-board></div>
  <p class="small"><a href="/${list}">${t(`${list}.full_board`)}</a></p>
</section>`;
}

// Wires the block under `root` for the round; a saved side claims at once. Returns {shareLine()}.
export function wireSide(pack, root, roundId, t) {
  const { key, list, sides } = BOARDS[pack];
  const el = root.querySelector('.lab-claim');
  const chips = [...el.querySelectorAll('[data-lab]')];
  let side = savedSide(pack);
  let board = null;
  let busy = false;
  const claim = async (pick) => {
    if (busy) return;
    busy = true;
    const r = await api(`/api/round/${key}`, { method: 'POST', body: { round_id: roundId, anon_id: anonId(), [key]: pick } });
    busy = false;
    el.querySelector('.msg').textContent = r.ok ? '' : t(`${list}.save_failed`);
    if (!r.ok) return;
    side = r.data[key];
    board = r.data.board;
    store.set(storeKey(pack), side);
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.lab === side));
    el.querySelector('[data-lab-with]').textContent = t(`${list}.with`, { side: sides[side] });
    el.querySelector('[data-lab-board]').innerHTML = sideTable(pack, board, side, t);
  };
  for (const c of chips) c.addEventListener('click', () => claim(c.dataset.lab));
  el.querySelector('[data-lab-change]').addEventListener('click', () => {
    el.querySelector('.lab-with').hidden = true;
    el.querySelector('#lab-q').hidden = false;
    el.querySelector('.lab-chips').hidden = false;
    (chips.find((c) => c.dataset.lab === side) ?? chips[0]).focus();
  });
  if (side) claim(side);
  return { shareLine: () => sideShareLine(pack, board, side, t) };
}
