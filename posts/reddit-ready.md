# Reddit and Show HN posts, ready to paste (written Sun 2026-10-04, 22:55 New York time)

Facts come from README.md, web/public/index.html, PRIVACY.md, LICENSE, prereg/PREREG.md, CHANGELOG.md and the live
site. Read the five checks below before anything goes out.

## Before you post: five checks

1. **The AI links are not safe yet.** On the live API (sampled at 22:50 ET, five rounds each), the AI drama questions
   ("Which came first?") print the month and year in both options, so the answer is on screen. Counts: 18 of 50
   questions at `?pack=ai&difficulty=brutal`, 6 of 50 at AI Normal (what `?pack=ai` opens for a new visitor), 0 of 50
   at AI Easy, 1 of 50 in All at Normal. Example: "Andrej Karpathy leaves OpenAI again (Feb 2024)" against "Scarlett
   Johansson objects to ChatGPT's 'Sky' voice (May 2024)". Cause: the `ai_drama` names in `items/ai_curated.json` end
   in "(Mon YYYY)", and `web/public/rounds.js` prints names as they are. Until it is fixed, delete the AI sentence named
   under each post and skip r/OpenAI. Gate: play one round at the Brutal link; no "Which came first?" option may show a month and year (dates on
   "Which is bigger?" money questions are context, not the answer).
2. **The home page answers today's first ranked question.** The hero example (Anthropic founded, marked correct,
   against ChatGPT released) is slot 1 of the 2026-10-05 ranked round. No post below uses that example.
3. **Database write cap.** `web/README.md` says the free D1 tier covers roughly 2,000 rounds a day and to upgrade to
   Workers Paid before a launch post that could exceed that. Do it before 09:00 if you can.
4. **The rules come from archives.** Reddit blocked every automated read from this machine (curl got 403 "blocked by
   network security", old.reddit redirected to login, WebFetch and both browser tools refuse reddit.com). Every rule
   below is from the newest Wayback Machine snapshot, dated per subreddit. Open each sidebar for 30 seconds before
   posting.
5. **Make the words yours.** Change wording freely and keep the facts. On Hacker News this is a rule (see Show HN).

## Verdicts

| Subreddit | Verdict | Deciding rule (snapshot date) |
|---|---|---|
| r/SideProject | Post | sharing projects for feedback is its purpose; no rules list set (2026-08-28) |
| r/WebGames | Post | browser games only; title starts with the game's name; 7 days and 10 comment karma (2026-08-01) |
| r/IMadeThis | Post | no rules list set; "a place for them to show off a little" (2026-08-11) |
| r/samplesize | Post | surveys welcome; strict title format (2026-07-05) |
| r/OpenAI | Conditional, default skip | self-promotion capped at 10% of your activity there; text posts only (2026-07-28) |
| r/InternetIsBeautiful | Drop | "No Webgames": "This includes quizzes" (2026-08-28) |
| r/Discord_Bots | Drop | "Promoting a bot is forbidden without mod consent." (2026-07-22) |
| r/slack | Drop | rule 1, "No Advertisements" (2025-07-14) |
| r/ClaudeAI | Drop | showcases must say how Claude built it; game posts sent to r/ClaudeGameDev (2026-08-23) |
| r/artificial | Drop | "Your first post or comment cannot have promo" (2026-08-28) |
| r/trivia | Drop | "No Self Promotion" and "No External Links" (2025-08-01) |
| r/Professors | Drop | students may read, but "posts and comments are not allowed" (2025-12-30) |
| r/singularity | Drop | "Self-Promotion/Advertisement posts will not be tolerated." (2026-08-28) |

No showcase day was found in any of the 13.

## Posting order (New York time)

| When | Where | Slot |
|---|---|---|
| Sun 23:00 to 23:30, otherwise Mon 13:00 | r/IMadeThis | assumed; low stakes, and it shows whether Reddit's filters accept the domain before Monday |
| Mon 09:00 | Show HN | stay on the thread for the first two hours |
| Mon 10:00 | r/SideProject | verified window, see its section |
| Mon 11:00 | r/WebGames | assumed |
| Mon 12:00 | r/samplesize | assumed |
| Mon 20:00 | r/OpenAI | only if both of its gates pass; assumed |

At most one Reddit post per hour (PLACES.md). The X thread (posts/x-launch-thread.md, not covered here) fits at
11:30. Reply to every comment for the first six hours.

---

## r/IMadeThis

**Rules** (Wayback: rules page 2026-08-23, sidebar 2026-08-11). Self-promotion: the point of the sub, "Go on Reddit,
brag a little." The rules list is empty: no flair, no karma or account-age minimum, no showcase day, no rule that OP
must comment. Link and text posts are both allowed.
**Activity:** low (25 posts in about 19 hours, top score 5, in the 2026-08-11 snapshot).
**Slot:** Sun 23:00 to 23:30 (assumed). **Type:** text post.

**Titles**
1. I made a one-minute trivia game that scores how sure you are, not just whether you are right
2. I made Who's Bluffing?, a trivia game where 100% sure and wrong costs you 300 points

**Body**
```text
I made Who's Bluffing?, a free web game: ten either-or questions in about a minute, with the source shown under every answer.

The twist is that you stake your confidence on each answer, from 50% to 100%. A sure hit earns 100 points, a sure miss loses 300, and a coin flip at 50% scores nothing. You finish with a type: Bluffer, Too sure, Spot on, Too modest or Playing it safe.

I also built it for a pre-registered study of overconfidence, and the anonymous answers will be released as open data. No ads and no accounts.

https://whosbluffing.com

If you play, I would like to know which type you got and whether the scoring made sense straight away.
```

## r/SideProject

**Rules** (Wayback: rules page and sidebar 2026-08-28). Self-promotion: allowed, it is "a subreddit for sharing and
receiving constructive feedback on side projects." No rules list, no flair, no published karma or account-age minimum
(AutoModerator settings are not visible), no showcase day, no OP-comment rule. Link titles use the sidebar format
"[Project name] - [Short description]". Text, link and video posts are all allowed.
**Activity (verified):** of the top 25 posts of August 2026 (snapshot 2026-08-28), 13 were posted between 06:00 and
12:00 ET and 18 between 03:00 and 12:00; 23 of the 25 were videos.
**Slot:** Mon 10:00. **Type:** video post with `web/public/press/demo.mp4`, then the body as your first comment.
Fallback: a text post with the same body.

**Titles**
1. Who's Bluffing? - a one-minute trivia game that scores how sure you are
2. Who's Bluffing? - I made a daily trivia game where being sure only pays when you are right

**Body (first comment)**
```text
I'm a first-year university student, and I made Who's Bluffing?: ten either-or questions in about a minute, like "Which is longer: the Nile or the Danube?" Every answer shows its source. Packs run from geography to a new AI pack about OpenAI, Anthropic, xAI and Google.

The twist: after each pick you stake how sure you are, from 50% to 100%. Right at 100% is +100, wrong at 100% is −300, and 50% is 0. You end with a type, from Bluffer to Playing it safe.

Why: anonymous answers feed a pre-registered study of overconfidence. No ads, no accounts, no third-party scripts; source published on GitHub. A Discord bot and a Slack app post one question a day, with an optional roast mode that names the bluffer.

https://whosbluffing.com

What would make you play a second round?
```
If check 1 still fails, delete the sentence that starts "Packs run from".

## r/WebGames

**Rules** (Wayback: rules page with sidebar 2026-08-01). Self-promotion: allowed for games; posts must link to "a
webgame playable in a web browser", with no download and no sign-up (P5). Title: "The title of a post must start with
the game's name" (P3). Flair: tags are "preferred" as post flair after submitting (seen in use: [HTML5], [PZL],
[STRAT], [MULTI]; [HTML5] fits). Account minimum (sidebar): "at least 7 days old" and "a minimum of 10 comment karma".
No showcase day, no OP-comment rule. Link posts, "as directly to the game as possible" (P4). No repost of the same game
within three months (P2): search the sub for whosbluffing.com first.
**Activity:** the 2026-08-02 snapshot had 23 posts between Saturday 21:00 and Sunday 11:00 ET, all scoring 0 to 3, so
posts sink within hours. Slot assumed.
**Slot:** Mon 11:00 (assumed). **Type:** link post to `https://whosbluffing.com`, then the first comment.

**Titles**
1. Who's Bluffing? Ten either-or questions, and you stake how sure you are on each
2. Who's Bluffing? A one-minute trivia game where being sure only pays when you are right

**First comment**
```text
I made this. Each round is ten either-or questions, such as which river is longer or which mountain is higher. It takes about a minute, there is no sign-up, and every answer shows its source.

The twist is the stake. After you pick, you say how sure you are, from 50% to 100%. Right at 100% is +100, wrong at 100% is −300, and 50% always scores 0, so being sure only pays when you are right. You finish with a type, from Bluffer to Playing it safe.

Behind it is a pre-registered study of overconfidence; the anonymous answers will be released as open data.

There is also a new AI pack (OpenAI, Anthropic, xAI and Google), hardest at Brutal: https://whosbluffing.com/?pack=ai&difficulty=brutal

If you play, post your type. Feedback on the scoring is welcome.
```
If check 1 still fails, delete the paragraph that starts "There is also a new AI pack".

## r/samplesize

**Rules** (Wayback: sidebar 2026-07-05; the rules page was not archived). Self-promotion: surveys are the point, "a
community dedicated to scientific, fun, and creative surveys". Title format: "[Tag] Topic (Demographic)"; the
demographic is "required even if your survey is open to everybody". Tags: [Casual], [Academic], [Marketing]; use
[Casual], because the study is independent with no IRB review (PREREG.md) and [Academic] would overstate it. Flair:
the matching "Casual" flair exists. No karma or account-age minimum published, no showcase day, no OP-comment rule.
"Post your survey using a survey tool instead of merely asking a question in a text-only post": a text post with the
link is the norm (19 of 23 front-page posts). Reposts only after 24 hours and off the front page, with [Repost].
**Link:** `/test`, the 5-minute version with optional demographics (PLACES.md: link /test here).
**Slot:** Mon 12:00 (assumed; in the one archived Sunday, the top post was submitted at 10:21 ET). **Type:** text post.

**Titles**
1. [Casual] How sure is your "sure"? A 5-minute confidence test with your results at the end (Everyone)
2. [Casual] Does your confidence match your accuracy? Twelve either-or questions and six number ranges (Everyone)

**Body**
```text
I made this 5-minute test for a pre-registered study of overconfidence. It has twelve either-or questions where you also say how sure you are, six questions where you give a range you are 90% sure contains the answer, and optional demographic questions at the end.

The twist: it does not just count right answers. Your results show how sure you were against how often you were right, so you can see whether your 70% really means 70%.

Why it exists: the hypotheses were frozen before launch, and the anonymous answers will be released as open data. Nothing is saved unless you submit at the end, and no account, email or IP address is stored.

Test: https://whosbluffing.com/test
Pre-registration: https://github.com/ethan-rong/whos-bluffing/blob/main/prereg/PREREG.md

I plan to share the results here when there is enough data. Comments on unclear questions are welcome.
```

## r/OpenAI (conditional; default is to skip)

**Rules** (Wayback: rules page 2026-07-28, front page 2026-08-30). Self-promotion: rule 3, "should not be more than
10% of your content here"; "Self-promotional direct link posts to projects are not allowed", so it must be a text
post with context. The full rule it links (r/artificial's wiki, snapshot 2025-05-14) counts only your posts and
comments in that subreddit and ends in permanent bans. Rule 1: content relevant to OpenAI or AI. Rule 6: titles that
are "misleading or editorialized will be removed". Flair: none required; seen in use: Discussion, Question, News,
Article, Tutorial, Research. No karma minimum or showcase day published; no OP-comment rule.
**Gates:** (a) at least 9 of every 10 of your own posts and comments in r/OpenAI are not about your projects; (b) check
1 passes. If either fails, skip it.
**Slot:** Mon 20:00 (assumed; in the 2026-08-30 snapshot the four top-scoring posts were submitted at 21:44, 06:29,
01:05 and 00:05 ET). **Type:** text post.

**Titles**
1. I made an AI history quiz (OpenAI, Anthropic, xAI, Google) where you also stake how sure you are
2. AI history quiz: which came earlier, which deal was bigger, and how sure are you?

**Body**
```text
I made a free web game, Who's Bluffing?, and it now has an AI pack: two-choice questions about OpenAI, Anthropic, xAI and Google, covering dates, money and events. One example: which came earlier, Microsoft's first $1 billion in OpenAI or the release of BERT? Every answer shows its source.

The twist: after you pick, you say how sure you are, from 50% to 100%. Right at 100% is +100, wrong at 100% is −300, and 50% is 0, so being sure only pays when you are right.

Why it exists: anonymous answers feed a pre-registered study of overconfidence. The plan is frozen in the repo; source published on GitHub. No ads and no accounts.

AI pack: https://whosbluffing.com/?pack=ai
Brutal: https://whosbluffing.com/?pack=ai&difficulty=brutal

If a question looks wrong or unfair, tell me which one; every answer has a flag button.
```
The example is a live pair (BERT, October 2018; Microsoft's $1 billion, July 2019; both sourced in
`items/ai_curated.json`). Do not swap in the Anthropic and ChatGPT example (check 2).

---

## Dropped: rules recorded, no post

| Subreddit (snapshot) | Self-promotion | Other fields | Why it is a bad idea |
|---|---|---|---|
| r/InternetIsBeautiful (rules page 2026-08-28) | only under "the 90/10 rule for self-promotion" | rule 10 bars sites where "AI is used to drive functionality"; no flair, karma or showcase rule | rule 3: "webgames are not allowed. This includes quizzes, puzzles, etc." |
| r/Discord_Bots (sidebar 2026-07-22) | "NO ADVERTISING/SELF ADVERTISING" | text posts only; flairs such as "Bot Request [Existing ONLY]" | "Promoting a bot is forbidden without mod consent." Allowed path: ask the mods by modmail first, or name the bot when answering a matching request ("Advertising your own bots in response to a question ... is okay"). The fallback in posts/reddit-discordbots.md, r/discordbots: rules unreadable (empty sidebar, 2026-08-09), front page mostly help requests scoring 0 to 3; not drafted. |
| r/slack (new-Reddit sidebar 2025-07-14) | rule 1, "No Advertisements" | rule 2 bars core Slack feature requests | self-promotion banned |
| r/ClaudeAI (rules page 2026-08-23, front page 2026-08-21) | allowed only if "built with Claude/Claude Code ... BY YOU", saying how Claude helped | "Posts on the feed now require OP karma> 50"; flair required (rule 9) | the post would have to say how it was built, which USER_TODO.md section G rules out ("不提 AI"); a mod sticky sends game posts to r/ClaudeGameDev (rules not checked) |
| r/artificial (rules page 2026-08-28) | 10% cap, "Your first post or comment cannot have promo" | modmail first if unsure | with no history there, any post is 100% promotion |
| r/trivia (rules page 2025-08-01) | "Don't promote your external events, sites or apps." | rule 7, "No offsite links." | both rules bar it |
| r/Professors (sidebar 2025-12-30) | not applicable | faculty-only weekly threads | students and non-academics may lurk; "posts and comments are not allowed". This removes the Tuesday post in the runbook; the instructor emails are unaffected. |
| r/singularity (rules page 2026-08-28) | "Self-Promotion/Advertisement posts will not be tolerated." | none relevant | banned |

---

## Show HN

### Guidelines check (showhn.html, newsguidelines.html and dang's tips, item 22336638, read live 2026-10-04)

- Something people can try without signups: yes ("ideally without barriers such as signups or emails").
- Non-trivial and personal, "Explain how and why": the old text had no backstory. Added below.
- Factual, no marketing: the title is plain and has no dare.
- **Hand-written only.** dang's tips (edited 2026-03-28) say "Write your text by hand", with no LLM even to edit it; the
  comment guidelines say "Don't post generated text or AI-edited text." The title and text below are a reference: type
  your own version from them. The same applies to every reply.
- No asking friends to upvote or comment; no booster comments. Your HN username should be you, not the project.
- Risk: the guidelines now say "Don't post quickly-generated one-offs." The repo history starts 2026-10-03
  (CHANGELOG.md); expect that question.

### Changes from posts/show-hn.md (that file is unchanged)

1. Cut "answers people call 90% sure come out right about 70% of the time": the repo has no source for it
   (posts/reply-templates.md says so).
2. "Questions are built from Wikidata facts" is not true of the AI pack, which is hand-curated
   (`items/ai_curated.json`). Now "most questions".
3. Added the backstory (it began as the 5-minute test; CHANGELOG.md 2026-10-03, evening) and the student line.
4. Named the rule: the Brier score rescaled, strictly proper (web/public/research.html).
5. Added "no third-party scripts": the CSP allows scripts from the site only, and the live home page loads only
   /site.js and /app.js.
6. Title: the en dash is gone; same facts.

### Title

- Recommended: `Show HN: Who's Bluffing? A one-minute trivia game that scores your confidence`
- Alternative: `Show HN: Who's Bluffing? Trivia scored with a proper scoring rule`
- URL: `https://whosbluffing.com`

### Text (reference; write your own from it)

> I'm a first-year university student. Who's Bluffing? gives you ten comparison questions ("Which is longer, the Nile
> or the Danube?"). You pick one, then state your confidence from 50% to 100%. Each answer scores 100 − 400(c − y)²,
> the Brier score rescaled to points: 50% scores 0 either way, and 100% is +100 if right and −300 if wrong. The rule
> is strictly proper, so stating your real confidence maximizes expected points.
>
> It started as a five-minute test with 90% ranges (still at /test). That format gave nobody a reason to come back,
> so I rebuilt it as a one-minute game: a daily ranked round, quick rounds by pack, challenge links, and Discord and
> Slack apps that post one question a day to a channel.
>
> Most questions are generated from Wikidata, with the source under both answers; the AI pack is hand-curated, each
> value checked against Wikipedia or the company's own page. Players can flag errors.
>
> It is also a pre-registered study of whether daily feedback improves calibration (prereg/PREREG.md, frozen before
> launch). No accounts, no ads, no third-party scripts. Source published, all rights reserved. Cloudflare Pages,
> Workers and D1, vanilla JS.

If check 1 still fails at 09:00, drop the AI-pack clause from the third paragraph, and expect "the answer is in
the question" comments anyway, because the AI chip is second on the home page. The real fix is the data, before 09:00.

Optional opening comment: a link to the 12-second loop, https://whosbluffing.com/press/demo.gif (live).

### Reply plan: the first six hours

- 09:00 to 11:00: stay on the thread and answer every top-level comment within about 15 minutes. 11:00 to 15:00: check
  every 30 minutes.
- Thank people, answer the question asked, concede what is true. Never argue about votes.
- A disputed fact: open the source. If they are right, retire the pair in the item bank and say so.
- A bug: confirm it, fix it, reply when it is deployed.
- Watch /stats, the Worker logs, 429s and D1 writes (docs/LAUNCH_RUNBOOK.md).

The eight likely questions. These are notes to answer from, in your own words; the file after each one is the source.

1. **Why no accounts?** A one-minute round does not need one. A random id in your browser's local storage keeps your
   streak; no email, no IP address, no tracking cookies are stored. The cost: clearing site data resets your streak,
   and a past session cannot be deleted because nothing links it to you. *Sources: web/public/index.html (FAQ "Do I
   need an account?"), PRIVACY.md ("What is never stored", "Opting out").*
2. **How is the data used?** For your results page, the aggregate numbers on /stats, and an anonymous public dataset
   (CC BY-NC 4.0) for the pre-registered study, to be released on OSF, Hugging Face and Kaggle with a data card. Each
   answer is saved as soon as you pick a confidence. The chat apps key answers by a salted hash of the member id and
   never store message text. Retention is indefinite. *Sources: PRIVACY.md ("Rounds", "What it is used for", "Slack
   and Discord", "Retention"), prereg/PREREG.md ("Data release"), README.md ("Why").*
3. **How are questions sourced?** Most pairs come from Wikidata numbers of the same kind, compared only when one is at
   least 1.3 times the other (years at least 10 apart), with a source under both answers; ranked rounds use only
   referenced or independently checked facts. The AI pack is hand-curated, each value checked against Wikipedia or the
   company's page, with smaller gaps (2 years; 3 months for timeline events), logged as a deviation. The third
   distinct flag retires a pair and every pair sharing its values. *Sources: index.html (FAQ "Where do the questions
   come from?"), prereg/PREREG.md ("Items"), items/ai_curated.json ("about"), CHANGELOG.md (2026-10-04, night),
   docs/api-rounds.md (flags).*
4. **Is the scoring rule proper?** Yes. 100 − 400(c − y)² is the Brier quadratic score rescaled, which is strictly
   proper (Brier 1950; Gneiting and Raftery 2007). With true belief p, expected points are
   100 − 400[(c − p)² + p(1 − p)], highest at c = p; on the six levels (50 to 100 in steps of 10) the nearest level
   wins. The 50% floor costs nothing because you choose the side first, and the −300 is simply what the rule gives at
   100% and wrong. *Sources: index.html (FAQ "How are points worked out?"), web/public/research.html (#scoring),
   prereg/PREREG.md ("Design"). The expectation line is algebra on that formula.*
5. **Why Discord?** The first version, the 5-minute test, had no social or repeat-play hook. A daily question in a
   channel gives a group one shared moment and a reveal everyone sees; Slack works the same way. The growth research
   found Truth or Dare Bot grew through Discord's own surfaces, not launch posts. Three permissions (Send Messages,
   Embed Links, Read Message History); roast mode is off by default. *Sources: CHANGELOG.md (2026-10-03, evening),
   docs/GROWTH_PLAYBOOK.md (TL;DR item 2; block A step 7), PRIVACY.md ("Slack and Discord").*
6. **Can I use it in class?** Yes, free. Create a class code at /class; students take the 5-minute test at /test on
   their phones; the dashboard shows the class chart once 5 students have finished, totals only, no accounts.
   Students' answers join the research data without the class code. *Sources: web/public/teachers.html, PRIVACY.md
   ("Classroom mode"), README.md ("Play").*
7. **Is it open source?** No. The source is published so anyone can read it and run it locally to check the research;
   any other use needs written permission. The anonymous data releases are CC BY-NC 4.0. Use the words "source
   published". *Source: LICENSE.*
8. **What about cheating?** Nothing stops a search, and there are no prizes; the leaderboard is for fun. The
   pre-registered analysis drops rounds with any answer under 700 ms, incomplete rounds, honeypot hits and repeat
   ranked rounds from the same anonymous id. In Discord and Slack, answers return no truth and no points until the
   reveal. The API allows 20 requests per 10 seconds per IP. Honest limit: clearing site data creates a new id, so a
   replayed ranked round cannot be linked to the first one. *Sources: prereg/PREREG.md ("Exclusions"),
   docs/api-rounds.md ("No early peeking"), docs/LAUNCH_RUNBOOK.md (rate limit).*

Also likely: "Did you use AI to build it?" Answer truthfully, in your own words.

---

## Conflicts with other files (owner decides)

- docs/GROWTH_PLAYBOOK.md, docs/LAUNCH_RUNBOOK.md, USER_TODO.md (G) and posts/PLACES.md schedule r/InternetIsBeautiful
  (Monday, right after Show HN), r/Discord_Bots (Monday) and r/Professors (Tuesday). All three are dropped here on
  their own rules.
- USER_TODO.md section G says "不提 AI" (written before the AI pack existed). These posts mention the AI pack as
  content, as the 2026-10-04 brief asks, and never say how the game was built. That is also why r/ClaudeAI is skipped.
- posts/show-hn.md still has the unsourced 90%/70% line; the reference text above drops it.
- posts/x-launch-thread.md places the X thread after "the opening two subreddits"; with the new order that is
  r/SideProject and r/WebGames, so about 11:30.
