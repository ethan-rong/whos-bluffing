<a href="https://whosbluffing.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/press/logo-dark.png">
    <img src="web/public/press/logo.png" alt="Who's Bluffing?" width="440">
  </picture>
</a>

# Ten questions. How sure are you?

A one-minute trivia game that finds out who's bluffing. Pick an answer, stake your confidence, then challenge a friend to the same ten questions.

<p>
  <a href="https://whosbluffing.com"><b>Play now</b></a>&nbsp;&nbsp;&nbsp;
  <a href="https://whosbluffing.com/discord">Add to Discord</a>&nbsp;&nbsp;&nbsp;
  <a href="https://whosbluffing.com/slack">Add to Slack</a>
</p>

No accounts, no tracking, no ads.

## Confidence has a price

“Which is longer: the Nile or the Danube?” Pick one, then say how sure you are, from **50% to 100%**. The scoring rule pays for honesty.

| Your confidence | If you're right | If you're wrong |
|:---|---:|---:|
| 50% | 0 | 0 |
| 100% | +100 | −300 |

At the end you get your type: **Bluffer**, **Too sure**, **Spot on**, **Too modest**, or **Playing it safe**. There is a roast if you earned one, and a link to challenge a friend on the same ten.

Every answer shows a source. Questions combine sourced authored trivia with Wikidata comparisons, and anyone can flag a question.

## Pick where to play

| Where | What you can do |
|:---|:---|
| [**Web**](https://whosbluffing.com) | Unlimited ten-question rounds by topic and difficulty. |
| [**Discord**](https://whosbluffing.com/discord) | Choose a topic and difficulty. Play privately with `/bluff play`, or together with `/bluff party`. |
| [**Slack**](https://whosbluffing.com/slack) | Private or shared ten-question rounds, plus optional daily channel questions. Use `/bluff play` or `/bluff party`. |
| [**Classroom**](https://whosbluffing.com/class) | A live calibration curve for a class. |
| [**Full assessment**](https://whosbluffing.com/test) | A five-minute assessment. |

## Run it locally

```bash
cd web
npm install
npm run migrate:local
npm run dev
```

Open **http://127.0.0.1:8788**. Requires Node 22 and Python 3.9+.

`bash scripts/check.sh` runs every test, the smoke suite, and the data guards.

[Development and deployment guide](web/README.md) / [CI checks](https://github.com/ethan-rong/whos-bluffing/actions/workflows/ci.yml)

## The research question

Most people are surer than they are right. The game shows you by how much, every day, in a minute. It is also an open study: **does daily feedback make people better calibrated?**

Anonymous answers are released under CC BY-NC 4.0 with a data card.

## Inside the repository

| Folder | What lives here |
|:---|:---|
| [`web/`](web/) | The site and API: Cloudflare Pages Functions, D1, vanilla JS. |
| [`discord/`](discord/), [`slack/`](slack/) | The Discord and Slack apps: Cloudflare Workers, no dependencies. |
| [`items/`](items/), [`daily/`](daily/) | Authored questions, Wikidata comparisons, and historical round schedules. |
| [`analysis/`](analysis/) | Pipeline, metric definitions shared by JS and Python, fact checks. |
| [`brand/`](brand/) | Logo kit. |

## Licence

Source published, all rights reserved ([LICENSE](LICENSE)): read it, run it locally to check the published research, nothing else without written permission. Data releases are CC BY-NC 4.0. Prior art, gratefully acknowledged: [AnkiCalibrateAddon](https://github.com/JulHeg/AnkiCalibrateAddon) and Clearer Thinking's *Calibrate Your Judgment*.
