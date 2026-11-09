# Who's Bluffing? for Discord

A Cloudflare Worker that brings Who's Bluffing to Discord. Add it to your own apps, then use `/bluff party` in a
server channel, DM or group DM: choose a topic and difficulty, then friends join the same ten questions, answer privately,
compare scores and rematch. Memes/Normal is preselected for parties; All/Normal for solo play.
Server installation also adds the daily question (on from the start) and the server leaderboard.

## Party flow

1. **`/bluff party`** opens a private topic/difficulty picker. **Start party** posts a public lobby with
   **Join / Resume**, **Results** and **Rematch**. Only currently supported combinations appear. Personal installs use
   interaction replies only: no bot channel access, member list or privileged intent is needed. A channel that blocks
   public external-app replies gets a private explanation instead of an invisible lobby.
2. **Join / Resume** explicitly agrees to share the clicker's Discord display name and final score in that chat.
   It opens a private round, using the same saved ten questions for everyone. Rejoining resumes progress; it does not
   reset answers or duplicate completed plays. The installer and the person pressing Join can be different people.
3. **Results** refreshes the public lobby, showing only finished participants (top ten when more than ten finish).
   Questions, choices, confidence and per-question feedback remain private. Every message disables pings.
4. A finished participant can press **Rematch** to replace the lobby with a new shared round at the same topic/difficulty, excluding the
   previous ten questions. Simultaneous rematches converge on one child round. Unfinished friends can finish the old
   round privately and use **View results** there.

Parties expire one hour after creation. Buttons check the chat, message, participant, step and expiry. Short operation
leases prevent overlapping answers/completions/rematches; expired leases can retry after an interrupted request.
No interaction tokens are stored. Lobby creation and joining never submit an answer or complete a round.

`/bluff play` opens the same picker for a solo round. **Play again** keeps its topic and difficulty and excludes the
previous ten questions. Answer screens show both options' values and sources, an authored **Why this answer** when
available, and **Report question** with a Back button. Results use the web's short type labels. Private controls check
the owner, chat and message; saved answers, results and rematches can resume after a failed Discord edit.

## What members see

- **The daily post:** "Who's Bluffing? · Which is longer: the Nile or the Danube?" with buttons **A · the Nile** and **B · the Danube**.
- **Tapping A or B** opens a private confidence picker: 50% (coin flip), 60, 70, 80, 90, 100% (stake it all). Then a
  private "Locked in: B at 80%. Reveal at 10:00 AM (in 20 hours)." Changing your mind before the reveal is allowed; the
  last answer counts.
- **Every time is in your own time zone.** The post, "Locked in", the reply to `/bluff question`, the setup reply and
  `/bluff help` write times as Discord timestamps, which each member's app shows in their own zone.
- **The reveal** edits the post. It shows both true values with their sources, "12 answered · 75% A · 25% B", the top 5
  by points, and the bluff line. With roast mode off: "Someone was 90% sure the Danube is longer. It isn't." With
  roast mode on, the bluffer is named.
- **Points** follow the quadratic rule: 50% scores 0; 100% scores +100 if right and −300 if wrong.
- **Mondays:** a recap of last week. It shows how often the server was right at each confidence level, the most
  calibrated member (named), the bluff count (80%+ sure and wrong), and the streak of days with an answer.
- **When a server adds it:** one welcome message, in the server's system channel or else the text channel nearest the
  top of the list that Who's Bluffing may post in. **Play solo** and **Play with friends** open the corresponding
  private picker; a party becomes public only after **Start party**. Challenge at the end of a solo round shares the
  result only when pressed. The channel that takes the welcome becomes the daily channel (default 14:00 UTC), with
  no setup; an admin moves it or changes the hour with `/bluff setup`, whose hello has the same two play buttons.
  Servers added before this got the same pick once from the hourly run, five a run, with the setup hello. A server
  where no channel takes the welcome gets no daily question until `/bluff setup`. The install welcome needs the
  Webhook Events URL (step 7).

## Commands

| Command | Who | What |
|---|---|---|
| `/bluff party` | anyone | Choose topic/difficulty privately, then Start party: friends Join the same ten, answer privately, compare Results and Rematch. |
| `/bluff play` | anyone | Choose topic/difficulty, then a private 10-question round: A/B, confidence, sources and points. Ends with score/type, **Play again** with the same settings, and **Challenge** to share the saved result. |
| `/bluff question` | member, server install | Post today's question in this channel now. If today's is already up, it links to it. |
| `/bluff stats` | member, server install | This server's 30-day leaderboard (top 10 by points) and participation, posted in the channel. |
| `/bluff setup` | Manage Server | `channel`, `hour` (UTC, 0–23, default 14), `reveal` (hours from the post to the reveal, 2–23; new servers start at 20, servers added before this option keep 8), `roast` (on/off, default off). Every option is optional; a missing one keeps its value. The reply shows the hour in your time and in UTC. |
| `/bluff reveal` | Manage Server | Reveal today's answer now instead of waiting. |
| `/bluff help` | anyone | How it works and the command list. |
| `/bluff invite` | anyone | Personal and server install links. |

Discord cannot run a command that has subcommands without one, so "post today's question now" is
`/bluff question`, not a bare `/bluff`.

**Reveal timing.** The Worker runs at the top of every hour. It posts to each server once a day, as soon as the
server's hour has come. It reveals each post at the hourly run at or after post time plus the server's `reveal` hours
(posted 14:00 UTC with 20 → revealed 10:00 UTC the next day; with 8 → 22:00 UTC). Answers close at the reveal. The
`hour` option is in UTC; members see every time in their own zone. A changed `reveal` applies from the next post: each
post keeps the reveal time it showed. 23 hours is the most, because the API takes answers to a daily question only on its
day and the next.

## Set up (about 20 minutes)

You need a Cloudflare account (the free plan is fine), a Discord server where you have Manage Server, and Node 22.13
or newer (the tests use Node's built-in SQLite).

**1. Create the Discord app (3 min).** Go to https://discord.com/developers/applications → **New Application** →
name it `Who's Bluffing?` → **Create**. On **General Information**:

- Copy the **Application ID** and the **Public Key**.
- Upload an icon (`brand/png/icon-512.png`), and paste the App description from `posts/discord-app-directory.md`.

**2. Set up the bot user (2 min).** Open the **Bot** page:

- **Reset Token** → copy the token. It is shown once; keep it in your password manager.
- Leave **Public Bot** on, so other servers can add it.
- Under **Privileged Gateway Intents**, turn on **Server Members Intent**. Without it, leaderboards show "a member"
  instead of names. Everything else works.
- **Save Changes**.

**3. Install settings (1 min).** Open the **Installation** page:

- Under **Installation Contexts**, enable **Guild Install** and **User Install**.
- Set **Install Link** to **Discord Provided Link**.
- Under **Default Install Settings** → User Install, choose only `applications.commands` (no bot permissions).
- Under **Default Install Settings** → Guild Install, set scopes `applications.commands` and `bot`, and permissions
  **Send Messages**, **Embed Links** and **Read Message History**. That is the same as the Worker's `/install` link
  (permissions integer `83968`).

The Worker keeps `/install` as the existing server link; `/install?type=user` produces the personal link with
`integration_type=1` and `scope=applications.commands`. Register commands again after enabling User Install:
the global command uses `integration_types: [0, 1]` and `contexts: [0, 1, 2]`.

**4. Database and Worker (5 min).**

```bash
cd discord   # from the repository root
npm install
npx wrangler login
npx wrangler d1 create whosbluffing-discord
```

Then:

1. Paste the printed `database_id` into `wrangler.toml` (replace the zeros).
2. In `wrangler.toml`, set `DISCORD_APP_ID` to the Application ID.
3. Set `API_BASE` to the web deployment's origin. The default is `https://bots.whosbluffing.com`; use the custom domain
   once it exists. No trailing slash, no `/api`.

Then:

```bash
npx wrangler d1 migrations apply whosbluffing-discord --remote
npx wrangler deploy
```

The deploy prints `https://whosbluffing-discord.<your-subdomain>.workers.dev`. That is `WORKER_URL` below.

**5. Secrets (2 min).**

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY    # paste the Public Key (General Information)
npx wrangler secret put DISCORD_BOT_TOKEN     # paste the bot token (Bot page)
openssl rand -hex 32                          # copy this value and keep a copy in your password manager
npx wrangler secret put SALT                  # paste it
npx wrangler secret put BOT_KEY               # paste the web project's BOT_KEY (the same value the Slack worker uses)
```

Secrets take effect at once; no redeploy is needed. **Never change SALT.** Every member id is hashed with it, so a new
SALT turns every member into a new player: MAU is counted twice and the boards reset.

**BOT_KEY** goes out as the `x-bluff-bot` header on every call to the web API. The API needs it to reveal today's
question, and the rate limit on `/api/*` exempts it. Without it every API call is refused at once and members see
"taking a break". To rotate it, change it on the web project and on every bot together.

**6. Interactions Endpoint URL (1 min).** On **General Information**, set **Interactions Endpoint URL** to
`WORKER_URL/interactions` and press **Save Changes**. Discord checks the URL there and then: it sends one signed
request and one deliberately bad one, and saves only if the Worker answers both correctly. If saving fails, check
DISCORD_PUBLIC_KEY.

**7. Webhook Events URL (1 min).** This tells the Worker when a server adds Who's Bluffing, so the server is
registered and gets one welcome message before anyone there runs a command. Open the **Webhooks** page (left sidebar
of your app in the Developer Portal):

1. Set **Endpoint URL** (under **Endpoint**) to `WORKER_URL/events`.
2. Turn on the **Events** toggle.
3. Select the `APPLICATION_AUTHORIZED` event, and `APPLICATION_DEAUTHORIZED` too (optional, see below).
4. Press **Save Changes**.

Discord sends a PING to the URL on save, so, as in step 6, the Worker must already be deployed with
`DISCORD_PUBLIC_KEY` set. Skipping this step loses only the welcome: a server is then registered at its earliest
command. Discord documents `APPLICATION_DEAUTHORIZED` with the member who removed the app and no server, so it
usually changes nothing; a removed server is noticed when its next daily post fails, which stops the posts there.

**8. Register the command (1 min).**

```bash
DISCORD_APP_ID=<application id> DISCORD_BOT_TOKEN=<bot token> npm run register    # prints: Registered: /bluff
```

Run it again whenever `COMMANDS` in `src/commands.js` changes. It replaces the whole list, so repeats are harmless.
**Updating to the version with the `reveal` option: run it once more**, or Discord keeps offering `/bluff setup` without
`reveal`. Everything else works before you do.

**9. Add it to your server (1 min).** Open `WORKER_URL/install` → pick your server → **Authorize**. That URL is the
invite link. Share it, or use the Add App button that Discord shows on the app's profile. With step 7 done, the welcome
message follows shortly (Discord does not promise webhook events in real time).

**10. In Discord (2 min):**

```
/bluff setup channel:#general hour:14 reveal:20
/bluff question
```

Then:

1. Tap A or B, pick a confidence, and see "Locked in".
2. Run `/bluff reveal` to see a reveal right away.
3. Run `/bluff play` to try a full round.

## List it on top.gg and in the App Directory

Copy is in `posts/topgg-listing.md` (also `posts/discordbotlist.md`) and `posts/discord-app-directory.md`. Run one full
cycle in your own server (question, answers, `/bluff reveal`) before submitting.

**top.gg.** Sign in at https://top.gg with Discord.

1. Choose **Add** (add a bot) and enter the Application ID.
2. Fill in the short and long description, the tags and the note to reviewers from `posts/topgg-listing.md`.
3. Set the prefix to `/` (slash commands only), the invite link to `WORKER_URL/install`, and the website to the Who's Bluffing site.
4. Submit for review. Reviewers add the bot to a test server and try the commands.

Who's Bluffing answers over HTTP and never connects to Discord's gateway, so it shows as offline in member lists while
working normally. Say this in the note to reviewers.

**Discord App Directory.** Listing needs a verified app. Verification opens once the app is in 75 servers and is
required at 100.

1. In the Developer Portal, open **App Verification**. The owner verifies their identity.
2. Request the **Server Members Intent** with this reason: "Shows members' display names on the server's own
   leaderboard. Names are looked up only while drawing it and never stored; answers are kept under salted hashes."
3. Fill in **Terms of Service URL** (`<site>/terms`) and **Privacy Policy URL** (`<site>/privacy`) on General
   Information.
4. Open the **App Directory** page: add the descriptions, tags and screenshots, then enable the listing.

Requirements change over time; check https://discord.com/developers/docs before submitting. PRIVACY.md covers
Discord in its "Slack and Discord" paragraph.

## Secrets and vars (exact names)

| Name | Kind | Value |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | secret | General Information → Public Key |
| `DISCORD_BOT_TOKEN` | secret | Bot → Reset Token |
| `SALT` | secret | `openssl rand -hex 32`, set once, never change |
| `BOT_KEY` | secret | the web project's BOT_KEY, sent as `x-bluff-bot` on every API call |
| `DISCORD_APP_ID` | var in `wrangler.toml` | General Information → Application ID (public) |
| `API_BASE` | var in `wrangler.toml` | web origin, e.g. `https://bots.whosbluffing.com` |

## Deploy and update

```bash
npm test                                       # local DBs; mocked Discord, plus real rounds API integration tests
npx wrangler deploy --dry-run --outdir dist    # bundle check, uploads nothing
npx wrangler d1 migrations apply whosbluffing-discord --remote   # new files in migrations/ only; repeats are harmless
npx wrangler deploy
npx wrangler tail                              # live logs (short error codes only)
```

Apply migrations before deploying code that needs them. `0002_install_events.sql` adds the column the install events
use; without it every install event fails, Discord retries it, and in the end Discord turns the Webhook Events URL off.
The `reveal` option needs no migration: the column was there from the start, and the code writes 20 for new servers.
`0003_parties.sql` adds transient party sessions and participants. `0004_round_options.sql` adds transient pickers,
selected settings, and retry-safe solo state; apply both before this worker version. The picker uses components under
the existing `/bluff play` and `/bluff party` commands, so this update needs no command re-registration.
`0005_auto_channel.sql` records each server's one automatic daily-channel pick; apply it before the version that
starts the daily question without setup.
Unit/integration tests use local data only and do not inflate live metrics.

## Data

Stored in D1:

- The server id, the chosen channel, the post hour, the reveal delay and the roast flag.
- When the server was added, the timestamp of the install event that got the welcome message, and when the server
  had its one automatic daily-channel pick. The install event
  also names the member who added the app; Who's Bluffing ignores that part and keeps nothing about them.
- For each daily post: its message id and the day's question as the API served it.
- For each answer: choice and confidence under `sha256(guild_id:user_id:SALT)`, plus points and right/wrong once the
  reveal settles them. The API keeps daily points back until the reveal, so nobody can peek.
- For a private picker: salted player/chat identifiers, its message id, mode, selected topic/difficulty and one-hour expiry.
- For a `/bluff play` round: its questions, selected settings, salted chat scope, private message id, running score,
  latest answer feedback and completed result/challenge link. Inactive state expires after one hour.
- For a party: salted chat scope, the app's lobby message id, selected settings, saved round/questions, expiry and rematch link.
- For a participant who presses Join: salted player id, their display name (up to 32 characters), private message id,
  progress/latest answer feedback and final score. Names never go to the rounds API. Party state expires after one hour
  and is deleted by the next successful hourly cleanup, which also removes inactive solo state and expired pickers.

No member messages, raw Discord user ids or interaction tokens are stored. Daily leaderboard names are fetched only
while drawing that leaderboard. Party names come from the person pressing Join, with consent shown on the lobby.
The rounds API receives only the hashed member id and a hashed server id (`discord:` + `sha256(guild_id:SALT)`), never
raw Discord ids. Private chats use `sha256(dm:channel_id:user_id:SALT)` and omit the community so they do not inflate
server counts. Personal installations never insert a server installation row.

The bot token can post as Who's Bluffing in every server that added it. To rotate it: **Bot** → **Reset Token**, then
`npx wrangler secret put DISCORD_BOT_TOKEN`.

## Limits

- **Daily leaderboard names** come from the first 1000 members of a server and need the Server Members Intent. Anyone else shows as
  "a member", and the roast line says "Someone".
- **Party Results refresh on button press**, using that fresh interaction token. Old public messages in Discord remain
  visible after transient worker data expires; the bot does not retain tokens to delete or update those messages later.
- **The daily top 5 lists positive scores only,** so with roast mode off the bluffer cannot be spotted in it.
- **If Who's Bluffing loses access** to the daily channel (deleted, or permissions removed), it stops posting there until
  someone runs `/bluff setup` again.
- **A failed recap** (Discord down at that moment) is not retried that week.
- **Workers free plan:** 10 ms CPU per run. Name lookups hash up to 1000 member ids, so big servers, or many servers
  revealing in the same hour, may need Workers Paid ($5/month).
- **When the web API at `API_BASE` is down,** members see "Who's Bluffing is taking a break, try again in a minute." Posts
  and reveals retry the next hour.
