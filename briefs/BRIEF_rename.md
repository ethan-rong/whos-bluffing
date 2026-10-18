# Builder brief — rename HowSure → Who's Bluffing? (whole repository)

You are the executor. Repo /Users/ethan/howsure (the folder keeps its name for now; the owner renames the GitHub repo to `whos-bluffing`). Rules: no git commands; no deploy/login; keep every test and smoke green in web/, slack/, discord/, anki/ and `bash scripts/check.sh` green at the end; do not change behaviour, data rules, scoring or the API shapes beyond the renames below.

## The new identity
- Product name (prose, titles, wordmark): **Who's Bluffing?** (with the question mark in headings, wordmark and titles; "Who's Bluffing" without it where punctuation would be awkward, e.g. mid-sentence or in alt text).
- Tagline: "Find out who's bluffing."  Hero h1: "Who's bluffing?"  Sub: "Ten questions. Stake how sure you are. The scoring rule knows when you're bluffing."
- Identifiers: `whosbluffing` (package names, worker names `whosbluffing-slack` / `whosbluffing-discord` / `whosbluffing-kpi`, D1 database name `whosbluffing`, Pages project `whosbluffing`, Anki add-on package folder and module `whosbluffing`, manifest name "Who's Bluffing? for Anki", localStorage keys, CSS prefixes if any, the `_items`/`_pool` names stay).
- Slash commands: `/howsure …` → `/bluff …` on Slack and Discord (`/bluff`, `/bluff question`, `/bluff setup`, `/bluff stats`, `/bluff reveal`, `/bluff help`, `/bluff invite`, `/bluff play`); Slack manifest and Discord command definitions, READMEs, listing copy, tests.
- API header `x-howsure-bot` → `x-bluff-bot` everywhere (web functions, both bots, docs/api-rounds.md, USER_TODO WAF expression, runbook).
- Domain: `howsure.me` → `whosbluffing.com` (sitemap, robots, canonical/OG URLs, share text, QR, email `hello@whosbluffing.com`, kpi-worker RUN_URL default, Slack/Discord `API_BASE` defaults, listings). `howsure.pages.dev` → `whosbluffing.pages.dev`.
- GitHub links: `github.com/ethan-rong/howsure` → `github.com/ethan-rong/whos-bluffing` (GitHub will redirect the old name once the owner renames).
- Licence file title: "Who's Bluffing? Source Licence"; README, TERMS, PRIVACY, PREREG, DATA_CARD, docs/*, posts/*, briefs/* (yes, update the briefs too), scripts/check.sh messages, analysis pipeline comments, test names and fixtures, og.png and favicon templates (regenerate og.png with the new wordmark; the five-square mark stays the logo), `web/design/screens` (regenerate the home/slack/research/rounds screenshots at least at 375 light so the design folder matches).
- Anki: rename the add-on package folder `anki/src/howsure` → `anki/src/whosbluffing`, module imports, manifest `package`/`name`, config keys, build script output `whosbluffing.ankiaddon`, deck names "Who's Bluffing? Calibration Deck"; then refresh the installed copy: remove `~/Library/Application Support/Anki2/addons21/howsure` and unpack the new build to `~/Library/Application Support/Anki2/addons21/whosbluffing`.
- CHANGELOG: one line "Renamed from HowSure to Who's Bluffing? (howsure.me belongs to an unrelated product)". README may say "formerly HowSure" once.

## Acceptance
- `grep -rniE "howsure|how sure are you\?" --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.wrangler --exclude-dir=dist --exclude-dir=.git .` returns only: the CHANGELOG rename line, the README "formerly" note, historical design docs under docs/design-*.md (leave them), analysis/factcheck-2026-10-03.md (leave it), and third-party vendor notices. Everything else is renamed. "how sure are you" as ordinary English inside a sentence (the question we ask players) may stay lowercase where it reads naturally.
- All tests and smoke green; `scripts/check.sh` ALL CHECKS PASSED; wrangler dry-runs for slack and discord succeed; anki build produces `dist/whosbluffing.ankiaddon`; installed add-on folder refreshed.
- Report (≤ 15 lines): files touched by area, verbatim test summaries, grep residue list, anything you could not rename and why.
