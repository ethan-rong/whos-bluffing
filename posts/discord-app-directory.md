# Discord App Directory listing

The **App description** goes in during soft setup on Sun Oct 4 (Developer Portal → General Information; block A in
`docs/GROWTH_PLAYBOOK.md`). The rest waits for the gate: the App Directory needs a verified app; verification opens
at about 75 servers and is required at 100 (`discord/README.md`). The Developer Portal shows the current checklist
under App Verification and Discovery → Discovery Status; it can take up to 24 hours to appear after you enable
Discovery. Claims that must stay true: "source published" (repo public from Mon Oct 5); the data "will be released",
never "is published", until it is out.

## App description (General Information, 301 characters)

One question a day for your server: which is longer, the Nile or the Danube? Pick A or B, then say how sure you are, from 50% to 100%. At reveal time the answer appears with its source, how the server split, the top 5 and the bluff of the day. Being sure only pays when you are right. Free, no ads.

## Detailed description (Discovery Settings, Markdown)

**One question a day that gets your server talking.**

Who's Bluffing posts one question in a channel you choose, like "Which is longer: the Nile or the Danube?" Members tap
A or B and say how sure they are, from 50% to 100%. Nobody sees anyone's answer until the reveal.

**BLUFFING COSTS POINTS**
Saying 50% scores 0. Saying 100% scores +100 if you are right and −300 if you are wrong. Being sure only pays when you
are right, so the leaderboard rewards people who know what they know.

**THE REVEAL**
At reveal time (the server picks the window) the post turns into the answer: both numbers with their sources, how the server split,
today's top 5, and the bluff of the day ("Someone was 90% sure the Danube is longer. It isn't."). Roast mode, off by
default, names the bluffer.

**HOW TO START**
1. Add the app with the Add button.
2. Type `/bluff setup channel:#general` (needs Manage Server).
3. Type `/bluff question` to post today's question now. From tomorrow it posts by itself.

**COMMANDS**
- `/bluff question` post today's question now
- `/bluff play` a private 10-question round, then challenge a friend
- `/bluff stats` the server's leaderboard for the last 30 days
- `/bluff setup` channel, hour (UTC) and roast mode
- `/bluff reveal` show today's answer early
- `/bluff help` · `/bluff invite`

**EVERY MONDAY**
A short recap: how often the server was right when it felt sure, the member whose confidence matched their results
best, and how many bluffs there were.

**PRIVACY**
No messages, usernames or user ids are stored with answers. Each member is a salted hash. The anonymous answers feed a
public study of overconfidence; the pooled data will be released. Free, independent, no ads, no accounts. Source
published for transparency.

Help and feedback: our community server (link below).

## Other fields

- Primary category: Games. Secondary (whatever the portal offers): Entertainment, Social, Education.
- Tags (up to 5): `trivia`, `quiz`, `daily question`, `leaderboard`, `game`
- Supported languages: English
- App icon: `brand/png/icon-512.png`
- Images (check the portal's current size limits; crop if asked): `web/public/press/screen-discord.png` (1280×800),
  `web/public/press/screen-home.png` (1280×800), `web/public/press/screen-question.png` (375×812),
  `web/public/press/screen-result.png` (1280×1725). Better: three real screenshots from your own server (question,
  picker, reveal), taken on Tue Oct 6.
- Support server: the community server invite (block B in `docs/GROWTH_PLAYBOOK.md`)
- Links: Website `https://whosbluffing.com/discord` · Terms `https://whosbluffing.com/terms` ·
  Privacy `https://whosbluffing.com/privacy` · GitHub `https://github.com/ethan-rong/whos-bluffing` (`ethan-rong` if you
  skipped the username change in `USER_TODO.md` B1)

## Server Members Intent: reason to paste at verification

Shows members' display names on the server's own leaderboard. Names are looked up only while drawing it and never
stored; answers are kept under salted hashes.
