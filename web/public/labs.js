// /labs: the AI pack's self-reported board (GET /api/labs, cached 60 s): players per side, and
// from 10 players the average score and the overconfidence in words, all time or the last 30 days. The table is the end
// screen's (round-end.js).
import { html, api } from './ui.js';
import { sideTable, savedSide } from './round-end.js';
import { BOARDS } from './packs.js';

export async function renderBoard(ctx, pack) {
  const { app, t } = ctx;
  const { list, play } = BOARDS[pack];
  app.innerHTML = html`<h1>${t(`${list}.title`)}</h1>
<p class="lead">${t(`${list}.lead`)}</p>
<div class="seg" role="group" aria-label="${t(`${list}.range_label`)}"><button type="button" data-range="all" aria-pressed="true">${t(`${list}.all_time`)}</button><button type="button" data-range="30d" aria-pressed="false">${t(`${list}.last_30`)}</button></div>
<div class="lab-board" aria-live="polite"><p class="muted">…</p></div>
<p class="muted small">${t(`${list}.note`)}</p>
<p><a class="button primary" href="/?pack=${pack}&amp;difficulty=${play}">${t(`${list}.play`)}</a></p>`;
  const board = app.querySelector('.lab-board');
  const toggles = [...app.querySelectorAll('[data-range]')];
  let current = 'all';
  const show = async (range) => {
    current = range;
    for (const b of toggles) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    const r = await api(`/api/${list}?range=${range}`);
    if (range !== current) return; // a later tap won
    board.innerHTML = r.ok ? sideTable(pack, r.data, savedSide(pack), t, { full: true }) : html`<p class="msg">${t(`${list}.failed`)}</p>`;
  };
  for (const b of toggles) b.addEventListener('click', () => show(b.dataset.range));
  await show('all');
}
