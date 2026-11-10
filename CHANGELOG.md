# Changelog

Changes are logged here with a date and a reason.

## 2026-11-09 (site redesign; party board removed)
- New type, layout and colours across the site; the brand mark, palette, scoring, questions and game flow are unchanged.
- Removed the `/parties` page and the "Which side are you on?" claim after Politics rounds (`GET /api/parties`, `POST /api/round/party`). Earlier claims stay stored. The Politics pack and the AI lab board are unchanged.

## 2026-10-09 (native chat rounds)
- Slack gains full ten-question solo and shared rounds. Both chat apps offer the web's supported topics and difficulties, source-linked feedback, friend challenges and fresh rematches. Question selection and confidence scoring use the existing game API; no scoring thresholds changed.
- Completed native rounds are recorded with their Slack or Discord surface. Shared party sessions are not web friend-challenge conversions. Temporary party display names are stored only after a member explicitly joins and agrees to share their name and final score; names are not sent to the research API.
- AI rematches can exhaust the small authored bank at Easy and Brutal. When the varied authored selection cannot fill a fresh rematch, AI uses the existing sourced comparison sampler with the same difficulty, tier and entity rules, excluding the previous ten questions. This fallback has less format variety; the authored-only History, Languages and Memes rules remain unchanged.
- Reason: the chat apps lacked the web game's topic choices and repeat-play flow. No retention improvement is claimed before measurement.

## 2026-10-06 (question variety and private activity counts)
- Release code revision: `294dbc5`. Result type cards now show only the type name.
- Added 80 authored History and 80 Languages questions with sources and short explanations. New rounds in these packs use only the authored bank, at all three difficulties. Rounds cap formats and subtopics, avoid repeating a subject within a round, and prefer unseen subjects across rounds. History also caps each era and region at four of ten questions. Reason: user feedback found company/aircraft dates and speaker counts repetitive.
- Difficulty labels remain editorial estimates, not empirically calibrated. New question IDs are q00101–q00260; earlier IDs, scheduled chat questions, fixed dares, and full-assessment items are preserved. Analysis must distinguish the content and exposure periods.
- Removed daily ranked from the picker and results. Requests to start it return HTTP 410; stored records and old challenge links remain readable for continuity.
- Public status now shows Total Players only. Owner access exposes four counts: Total Players, DAU (UTC day), MAU (30 UTC dates including today), and annual active users (365 UTC dates including today). A qualifying activity is a completed round/assessment or daily chat answer. IDs are deduplicated across surfaces; separate IDs belonging to the same person cannot be linked. Chat activity uses its answer timestamp. Historical research KPI snapshots retain their frozen definitions privately; these product definitions are a dated deviation, not a retroactive rewrite.
- Existing activity/statistics endpoints require the owner key and responses are not publicly cacheable. No measured retention or conversion improvement is claimed.

## 2026-10-05 (authored quick questions; pending deployment)
- Added 60 short, sourced questions with explanatory reveals, including 24 AI questions. Reason: launch feedback described the generated comparisons as dull and similar. New All and AI quick rounds prefer this bank, cap topic and format repetition, and prefer unseen questions. Other specialist packs retain their comparison banks.
- Deviation from the frozen comparison-only design: authored questions include misconceptions, origins, scenarios and probability. Their easy/medium/hard labels are editorial estimates, not pageview/ratio-derived or empirically calibrated. The existing difficulty mixes and confidence scoring stay the same. Question IDs beginning with `q` identify this content in stored answers; deployment time and revision must be recorded when published. Analysis must distinguish this bank and exposure period from earlier quick rounds.
- Ranked schedules, daily chat questions, fixed dares and the full assessment are unchanged. Existing question IDs and answers are preserved. Authored IDs are immutable after deployment; retire errors and assign replacement IDs. No engagement or retention improvement has yet been measured.

## 2026-10-03
- Repo created. Design docs, privacy policy, item schema, shared metric test vectors.

## 2026-10-03 (later)
- Scope change before launch: English only (Chinese UI, items and channels removed); the bilingual foreign-language hypothesis is replaced by a within-person practice-effect hypothesis (H3). Daily game and Slack app added as the primary surfaces; MAU and community definitions added. Reason: distribution redesign for scale.

## 2026-10-03 (evening)
- Game loop redesigned before launch: the viral game becomes 10-question comparison rounds with staked confidence (quadratic scoring), ranked daily round + unlimited quick rounds, challenge links, and a one-question-a-day Slack post with an anonymous reveal (optional roast mode). Intervals stay in the full assessment only. Play and MAU definitions updated; engagement metrics added. Reason: the interval-typing loop had no social or repeat-play hook (docs/api-rounds.md).
- Discord added as a surface (user lifted the earlier restriction); communities now counted per platform.

## 2026-10-04
- Renamed from HowSure to Who's Bluffing? (howsure.me belongs to an unrelated product)

## 2026-10-04
- The MAU definition now names Discord alongside web and Slack. Plays before this change, ahead of the 2026-10-05 public launch, are test plays and are excluded.
- New brand mark: two fanned cards with a square turned 45° cut out of the front card as the diamond pip (`brand/`). The five-squares-in-a-row mark and an interim question-mark mark are retired.
- Slack and Discord Workers provisioned on Cloudflare (D1 databases, BOT_KEY and SALT secrets); the Slack manifest carries the real Worker host.

## 2026-10-04 (night)
- AI pack added (`items/ai_curated.json`, 118 hand-curated items): `ai_timeline` (44 events at month precision, "Which came first?"), `ai_released` (33), `ai_company_founded` (22) and `ai_params` (19, published parameter counts only, "Which model has more parameters?"). Each value was checked against Wikipedia or the company's own announcement page. The items are fact-checked and count as famous in quick rounds whatever their pageviews; the AI pack is second in the pack list.
- Year pairs normally need at least 10 years between the two items. The AI year categories use at least 2 years and `ai_timeline` at least 3 months, because the field is young (`min_gap` in each template of `items/pairs.json`). Difficulty scales with the minimum gap (easy at 5 times it, medium at 2 times: 10 and 4 years, 15 and 6 months); `ai_params` keeps the 1.3 ratio.
- Deviation: from 2026-10-05, slot 1 of every ranked round is one `ai_timeline` pair (owner request: AI questions first in the game). It counts toward the 3/4/3 mix (on the existing days it replaced a pair of the same difficulty), both of its items have at least 50,000 monthly views of their own, and it is the day's only AI pair. The other AI categories stay out of ranked rounds and the chat question. Days 2026-10-05 to 2027-02-01 were edited once for this (an exception to append-only); 2026-10-04 and earlier are unchanged.
- Type names shown to players are now plain words (Too sure, Spot on, Too modest, Playing it safe; Bluffer unchanged); the API and stored data keep the original labels and thresholds. Cosmetic only.
- AI pack v2: every AI item has a `tier` (1 famous names and years, 2 events and money, 3 technical; a pair takes the higher of its two). Two new quick-round categories: `ai_money` (48 dated public dollar figures, `volatile` with `as_of`, never ranked) and `ai_tech` (50 published technical numbers: context windows, training tokens, training compute, transistors, dataset sizes, memory, paper authors, experts). The AI pack's difficulties draw by tier (Easy 1, Normal 1-2, Brutal 2-3; `tiers` in `web/public/packs.js`). Ranked rounds are unchanged; the AI slot is tier 1 or 2 only, and no volatile item may enter a ranked day.
- AI pack v3: `ai_drama`, 46 public, dated events (firings, exits, lawsuits, deals, flops; tier 2, month precision, at least 2 months apart, one subject never compared with itself), each with a sourced exact day in its note and a `fun` reveal line. An event counts as famous only when its subject's Wikipedia article has 50,000+ monthly views (25 of 46); the rest appear only at Brutal. `ai_money` gains CEO pay from proxy reporting (Nadella, Huang, Pichai) and Alphabet's loss after the Bard demo. Ranked rounds are unchanged.
