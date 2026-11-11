# Who's Bluffing? for Slack

A Cloudflare Worker for ten-question trivia rounds in Slack. Members pick A or B, then say how sure they are. Solo rounds stay private; friends can join one shared round and compare finished scores. The optional daily question, delayed reveal and Monday recap remain available.

## Full rounds

`/bluff` opens a private menu with **Play solo** and **Play with friends**. `/bluff play` and `/bluff party` still go straight to their topic and difficulty pickers. They offer exactly the combinations available on the website, generated in `web/public/pack-availability.json`. Question one explains confidence; later questions keep it short. Each answer names the correct A/B option, points and clickable sources. Report question opens a private reason picker without removing the game. The result shows the website's short type label, accuracy and confidence.

- **Play again** gets ten new questions with the same topic and difficulty. An interrupted replay retries the same child round.
- **Challenge friends here** explicitly posts your display name, score and a link to those same ten questions. A friend can open the link on the website. The result also includes the link to copy yourself. Nothing is shared before you choose it.
- **`/bluff party`** opens the same picker, then posts a public lobby. Join explicitly shares your Slack display name and finished score in that channel. Each friend gets a private game; the lobby never shows their answers or question spoilers.
- **Results** refreshes the public list of finished scores. **Check friends** on your private result shows finished standings right there, with a Rematch button. A finished player can start one shared **Rematch** with new questions and the same settings. Friends still playing can finish the original privately. Old Join buttons lead to the current rematch.
- Native sessions expire one hour after creation. Each click supplies a fresh Slack response URL, so ten questions do not reuse one URL's five-response allowance. URLs are never stored. Pending errors are separate private notices, leaving the game buttons available for retry.

## Updating an existing install

Apply `0004_play.sql` before deploying this version. It adds only the two temporary game tables; it does not change existing installs or daily scores. No new Slack scopes are needed. Update the manifest's description/usage hint if desired; the existing `/bluff` command and interactive request URL handle the new subcommands.

## What members see

- **The daily post**, at the workspace's hour: "Who's Bluffing? · Which is longer: the Nile or the Danube?" with two buttons, **A · the Nile** and **B · the Danube**.
- **Tap A or B:** a private confidence picker appears, only for you: 50% (coin flip), 60%, 70%, 80%, 90%, 100% (stake it all).
- **Tap a confidence:** the picker turns into "Locked in: B at 80%. Reveal: today 10:00 PM." Nobody else sees your pick, and you get no hint whether you were right.
- **Times are in your own time zone.** The reveal time on the post and in "Locked in" is a Slack date, so every member reads it in the time zone of their Slack profile ("today 10:00 PM", "tomorrow 4:00 AM"). Slack clients that cannot show it fall back to UTC ("Oct 31 22:00 UTC").
- **Change your mind** before the reveal: tap A or B again and pick a new confidence. The picker shows your current answer; the last answer counts.
- **The reveal** edits the original post (the buttons go away):
  - the correct answer with both values and their sources;
  - "12 answered · 75% A · 25% B";
  - the top 5 by points, by display name;
  - the bluff line, when the day's biggest bluff is a wrong answer at 80% or more: "Someone was 90% sure it was B (the Danube). It wasn't."
- **The Monday recap** (posted at the workspace's hour, before that day's question): how often each confidence level was right last week, the most calibrated member by name, the bluff count, days played and the workspace's streak.

### Points

Each answer scores 100 − 400 × (confidence − outcome)², with confidence as a fraction and outcome 1 when right, 0 when wrong. 50% always scores 0; 100% scores +100 when right and −300 when wrong. Honest confidence earns the most points over time.

For the daily question, nothing is scored before the reveal: the web API confirms the answer without saying whether it is right. At the reveal the Worker scores every answer with this formula. Full rounds use the same API scoring immediately after each answer.

A **bluff** is a wrong answer at 80% or more. The reveal's bluff line and the recap's bluff count both use this rule.

### Roast mode

Off by default. With roast mode off:

- the bluff line says "Someone", never a name;
- the points list on the reveal and in `/bluff stats` shows only members with more than 0 points, so nobody is named next to a loss.

`/bluff setup roast on` names the biggest bluffer in the reveal and shows everyone's points, negative ones included. `/bluff setup roast off` turns it back off. Any member can change it.

### Reveal timing

The answer is revealed 8 hours after the post hour, at the top of the hour (post hour 14:00 UTC → reveal 22:00 UTC). `reveal N` in `/bluff setup` changes the 8 to anything from 2 to 23 hours, for example `reveal 20` so a community spread over many time zones has a full day to answer. If the day's post went up later than the post hour (for example, the channel was set up in the evening), the reveal is that many hours after the hour it went up, so everyone still gets the full time. The post and the "Locked in" reply both show the reveal time, in each member's own time zone. Anyone can reveal early with `/bluff reveal`.

A question can be answered until its reveal, and only on its day or the day after (a post at 20:00 UTC is revealed at 04:00 UTC the next day). 23 hours is the longest window, so every reveal stays inside that limit.

## Commands

| Command | What it does |
|---|---|
| `/bluff` | Opens a private Play solo / Play with friends menu. |
| `/bluff party` | Choose a topic and difficulty, then invite friends to the same ten questions. |
| `/bluff play` | Choose a topic and difficulty for a private ten-question round. |
| `/bluff question` | Posts today's question in this channel. In the chosen channel (or when none is chosen yet) it becomes the day's post, and the hourly post skips that day; if the day's post is already in this channel, it says so instead of posting twice. Elsewhere it posts a copy: answers count the same, and the reveal happens on the day's post. After today's reveal it posts nothing and says so. |
| `/bluff setup #channel [hour] [roast on\|off] [reveal N]` | Posts the question in #channel every day at that hour in your Slack time zone (0–23; add `utc` after the hour for UTC), and reveals the answer N hours later (2–23, default 8). Without an hour the hour is set to 14:00 UTC. |
| `/bluff setup roast on\|off` | Changes roast mode only; channel and hour stay. `/bluff setup reveal N` changes only the reveal window, and both can go together (`/bluff setup roast on reveal 20`). |
| `/bluff reveal` | Reveals the open question now, for everyone. |
| `/bluff stats` | Posts this workspace's 30-day leaderboard in the channel: top 10 by total points (ties: more answers first) and how many members answered. Only revealed days count. |

Anything else shows the command list privately.

## Set up (about 15 minutes)

You need a Cloudflare account (free plan is fine), a Slack workspace where you may install apps, and Node 22.13 or newer (the tests use Node's built-in SQLite).

1. **Install and log in**
   ```bash
   cd slack   # from the repository root
   npm install
   npx wrangler login
   ```
2. **Create the database**
   ```bash
   npx wrangler d1 create whosbluffing-slack
   ```
   Paste the printed `database_id` into `wrangler.toml` (replace the zeros), then apply the migrations:
   ```bash
   npx wrangler d1 migrations apply whosbluffing-slack --remote
   ```
3. **Point at the web API.** In `wrangler.toml` under `[vars]`, set `API_BASE` to the web deployment's origin. Default: `https://bots.whosbluffing.com`. No trailing slash, no `/api`. The Worker calls `/api/round`, `/api/round/answer`, `/api/round/complete`, `/api/flag`, `/api/round/daily-question` and `/api/round/reveal` (see `docs/api-rounds.md`).
4. **Deploy once to get the URL**
   ```bash
   npx wrangler deploy
   ```
   It prints `https://whosbluffing-slack.<your-subdomain>.workers.dev`. Its host (without `https://`) is `WORKER_HOST` below.
5. **Create the Slack app.** In `manifest.yaml`, replace `YOUR-WORKER-HOST` (3 places) with `WORKER_HOST`. Open https://api.slack.com/apps → **Create New App** → **From an app manifest** → pick your workspace → paste the YAML → **Next** → **Create**.
6. **Store the secrets.** On the Slack app page → **Basic Information** → **App Credentials**:
   ```bash
   npx wrangler secret put SLACK_CLIENT_ID        # paste the Client ID
   npx wrangler secret put SLACK_CLIENT_SECRET    # paste the Client Secret
   npx wrangler secret put SLACK_SIGNING_SECRET   # paste the Signing Secret
   openssl rand -hex 32                           # copy this value and keep a copy in your password manager
   npx wrangler secret put SALT                   # paste it
   npx wrangler secret put BOT_KEY                # paste the BOT_KEY set on the web project
   ```
   `BOT_KEY` is the shared key the web API expects in the `x-bluff-bot` header on every call (it needs it for same-day reveals, and the rate limit skips requests that carry it). Use the value set on the web project; if it has none yet, make one with `openssl rand -hex 32` and set it on both. Without it every call to the web API fails and members see "taking a break".
   Secrets take effect at once; no redeploy needed. **Never change SALT**: every member id is hashed with it, so a new SALT turns every member into a new player (MAU counted twice, boards and streaks reset).
7. **Let other workspaces install** (skip if only your own workspace will use it): Slack app page → **Manage Distribution** → finish the checklist → **Activate Public Distribution**.
8. **Install.** Open `https://WORKER_HOST/slack/oauth/start` and press **Allow**. That URL is the **Add to Slack** link: share it, or link Slack's official Add to Slack button image to it.
9. **In Slack:**
   ```
   /bluff
   ```
   Choose Play solo or Play with friends. For an optional daily question, use `/bluff question`; schedule it with `/bluff setup #general 9 reveal 20`. `9` is 09:00 in your own Slack time zone; the reply shows UTC too.

Already set up v0.1? Run step 2's `migrations apply` again (it adds `0002_daily_question.sql`), update the app from the new `manifest.yaml` (Slack app page → **App Manifest**), and deploy.

Updating a live install to the version with local times and `reveal N`: run step 2's `migrations apply` (it adds `0003_reveal_delay.sql`) **before** `npx wrangler deploy`. The new code reads `installs.reveal_delay_h` in every hourly run, so a deploy without the migration stops the reveals until it is applied. No new Slack scope is needed: reading a member's time zone uses `users:read`, which the app already has.

## Secrets and vars (exact names)

| Name | Kind | Value |
|---|---|---|
| `SLACK_CLIENT_ID` | secret | Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | secret | Basic Information → App Credentials |
| `SLACK_SIGNING_SECRET` | secret | Basic Information → App Credentials |
| `SALT` | secret | `openssl rand -hex 32`, set once, never change |
| `BOT_KEY` | secret | the same value as the web project's `BOT_KEY` |
| `API_BASE` | var in `wrangler.toml` | web origin, e.g. `https://bots.whosbluffing.com` |

## Picking the channel

`/bluff setup #channel [hour]`. Type `#` and pick the channel so Slack links it.

- **The hour (0–23) is in your own time zone**, the one in your Slack profile. It is stored as the matching UTC hour: in New York in summer, `/bluff setup #general 9` is stored as 13:00 UTC, and the reply says "every day at 09:00 your time (13:00 UTC)".
- **`utc` after the hour gives it in UTC:** `/bluff setup #general 9 utc`. Without an hour, the hour is 14:00 UTC.
- **Zones a half or quarter hour off UTC** round down to the full UTC hour, because the Worker runs on the hour. In India, `9` is stored as 03:00 UTC, and the reply says 08:30 your time.
- **If Slack does not return your time zone**, the hour is taken as UTC and the reply says so.
- **Daylight saving:** the stored hour is UTC, so when your clocks change the post moves an hour on your clock. Run setup again to move it back.

The Worker runs at the top of every hour. Each run removes expired native sessions, reveals questions that are due, posts Monday recaps, then posts today's question to each workspace as soon as its hour has come. Failures are isolated so cleanup and other workspaces still run. A failed daily send releases its claim for retry, including fetch/JSON failures. If you set up after the chosen hour, today's question posts at the next full hour.

Public channels work without inviting the app. For a private channel, run `/invite @whosbluffing` in it before setup.

## Deploy and update

```bash
npm test                                       # daily tests + native flows against the real local rounds API
npx wrangler d1 migrations apply whosbluffing-slack --remote
npx wrangler deploy --dry-run --outdir dist    # bundle check, uploads nothing
npx wrangler deploy
npx wrangler tail                              # live logs (short error codes only)
```

## Data and tokens

Stored in D1, and nothing else:

- per workspace: team id, bot token, channel id, post hour (UTC), reveal window, roast setting, the Monday of the last recap;
- per workspace per day: the day's post (channel id and message timestamp), whether it was revealed, and the day's question as the API served it (item id, prompt and both options: the app's own text, kept so a late reveal can still be drawn);
- per answer: `sha256(team_id:user_id:SALT)`, the date, A or B, the confidence, and, from the reveal on, whether it was right and its points.

Native rounds additionally keep the question IDs/text, topic/difficulty, salted channel scope and player IDs, progress, feedback, score, lobby timestamp and rematch link in temporary tables. A party Join opts into storing that player's display name and showing their finished score. Solo names are not stored; an explicit solo challenge fetches the name only while sharing. Sessions expire after one hour and their temporary data is deleted on the next successful hourly cleanup. No raw user IDs, response URLs or interaction tokens are stored in those tables. This cleanup does not delete anonymous answers/results retained by the shared research API or messages already posted in Slack.

No member messages or emails are collected. Daily display names are fetched only while a reveal, leaderboard or recap is drawn. The rounds API receives only the hashed member id and `slack:` + a hashed workspace id (`sha256(team_id:SALT)`), never raw Slack IDs or display names. Every call carries `x-bluff-bot` with `BOT_KEY`. The v0.1 `scores` table is no longer used.

**Bot tokens are stored in plain text** in the D1 table `installs`.

- Rotate one workspace's token: reinstall from the Add to Slack link. The callback overwrites the stored token and keeps the channel, hour and roast setting.
- Revoke every token (for example if the database leaked): Slack app page → **OAuth & Permissions** → **Revoke All OAuth Tokens**, then each workspace reinstalls.
- Rotate the app secrets: **Basic Information** → regenerate the Client Secret or Signing Secret, then `npx wrangler secret put` the new value.
- Rotate `BOT_KEY`: set the new value on the web project and here at the same time (`npx wrangler secret put BOT_KEY`).
- When a workspace uninstalls, Slack revokes its token; the next hourly post sees that and deletes the workspace's row.

## Limits

- Daily names: only members of the channel the message is in (up to 1000 members) can be named. Party names are fetched individually only when that player joins.
- Any member can run `/bluff setup` and `/bluff reveal`.
- Each button interaction receives its own response link. The Worker sends within that link's 30-minute lifetime; old links are not reused between questions.
- Delivery cannot be transactionally committed with Slack's servers. A network interruption after Slack accepts a public post but before its success reaches this Worker can result in a duplicate on retry. Answer and completion retries use API idempotency and do not double-count scores.
- Copies posted with `/bluff question` outside the chosen channel are not edited at the reveal; tapping them afterwards says the question is closed.
- Changing the hour or the reveal window also moves the reveal of a question already posted that day, since the reveal time comes from the current settings. Its post and earlier "Locked in" replies keep the time they showed.
- A member's time zone is read only from their Slack profile, once, at setup. It is not stored.
- If a reveal fails (web API down, Slack error), it is retried every hour for up to a week, drawn from the question stored with the post; `/bluff reveal` also retries.
- Workers free plan allows 10 ms CPU per request. Name lookups hash up to 1000 member ids, so big channels, or hundreds of workspaces in one hourly run, may need Workers Paid ($5/month).
- Workspace installs only; Enterprise Grid org-wide installs are not supported.
- Not in the Slack App Directory yet; installs go through the Add to Slack link.
- When the web API at `API_BASE` is down, members see "Who's Bluffing is taking a break, try again in a minute." and the hourly post retries the next hour.

## Cloudflare cost protection

The deployed Worker has a 1,000 ms CPU ceiling per invocation. Public HTTP requests use Cloudflare’s native rate limiter at 600 requests per minute per Cloudflare client IP, before body parsing, signature verification, database work or provider calls. Limit responses are HTTP 429 with `Retry-After: 60`; hourly jobs retain their schedule. Version preview URLs are disabled; the production workers.dev URL remains enabled.

Cloudflare rate counters are approximate and local to a Cloudflare location. These settings reduce abuse; they do not impose an account-wide dollar cap. Billing alerts also lag and exclude the fixed subscription fee.
