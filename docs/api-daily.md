# Daily API contract (web implements; Slack consumes)

Access amendment (2026-10-06): `/api/daily/stats` and `/api/kpi` are owner-only (`x-kpi-key`, 401 without it, private/no-store). `/api/kpi` now returns `{as_of,total_players,dau,mau,yau}`. Only `/api/players` exposes a public product count, `{total_players}`. The retired daily range game's plays are not part of the current product counts.


Base: the web deployment (`https://<host>/api`). All JSON. Dates are UTC `YYYY-MM-DD`. `surface` ∈ {web, slack, classroom}.

- `GET /api/daily?date=YYYY-MM-DD` (date optional, default today UTC) → `{date, number, items:[{id, prompt, unit, accept:[lo,hi]}]}` — never includes answers.
- `POST /api/daily/answer` body `{date, item_id, low, high, anon_id, surface, rt_ms, community?}` → `{hit, truth, source, log_ratio_error}`; idempotent per (anon_id, date, item_id): a second answer returns the first result. `date` may be today or yesterday (UTC) so a form opened before midnight can still be submitted; any other date → 400. `community` (optional string: Slack team hash or class code) is stored on the player record.
- `POST /api/daily/complete` body `{date, anon_id, surface, community?}` → `{hits, n, streak, share_text, today:{players, avg_hits, hist:[n0..n5]}}`. Marks the play complete (this is what MAU counts). Same date rule as answer.
- `GET /api/daily/stats?date=` → `{players, avg_hits, hist:[n0..n5]}` (passed plays only, cache 60 s).
- `POST /api/flag` body `{item_id, anon_id, reason}` → `{ok}`; 3 distinct flags retire an item pending review.
- `GET /api/kpi` → `{as_of, mau, dau, mau_by_surface:{web, slack, classroom}, communities:{workspaces, classrooms}}` from the daily KPI job.

Anonymous ids: web = random id in localStorage; Slack = hex sha256(team_id + ":" + user_id + ":" + SALT) computed in the Slack worker (SALT is a Worker secret that must never change); never the raw Slack ids. Server stores `players(anon_id, surface, first_seen, last_seen, plays)` and `plays(anon_id, date, surface, hits, completed_at)`.

Surface notes: for `surface=slack`, `rt_ms` is the modal open-to-submit time divided by 5 (Slack gives no per-question timing) and is approximate; response-time exclusions apply to the web surface only.
