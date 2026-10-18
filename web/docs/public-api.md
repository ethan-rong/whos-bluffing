# API

Who's Bluffing runs on a small JSON API that the web game, the Slack and Discord apps and the classroom dashboard all use. This page starts with what anyone may read, then gives the full contracts: rounds (the game today) and the retired daily game.

## Public API

The public player count is `GET /api/players`, returning `{total_players}`. It is cached for 60 seconds and carries `Access-Control-Allow-Origin: *`, so another site can read it with a simple GET. No key or account is needed.

Total Players counts distinct anonymous IDs with a completed round or full assessment, or an in-channel daily chat answer. Page views and unfinished rounds do not count. The same ID is deduplicated across sources; a person using several IDs can count several times.

Activity windows are private. `/api/kpi` requires the owner header `x-kpi-key` and returns the total, DAU, MAU (rolling 30 days), and annual active users (rolling 365 days), plus a UTC date. Legacy statistics endpoints require the same header. Missing or wrong keys return 401; private responses are not publicly cacheable and have no CORS header.

The other endpoints (starting a round, answers, flags, the chat apps' calls) exist for the Who's Bluffing apps. Building on them is welcome, but expect them to change without notice, keep traffic low, and never send personal data.

### Rate limits

Requests to `/api/*` are rate-limited per IP address (about 120 a minute); beyond that the API answers `429` for a minute. Cache the public count rather than polling more than once a minute.

### Attribution

If you show these numbers, please credit **Who's Bluffing** with a link to [whosbluffing.com](https://whosbluffing.com). Keep the note that anonymous IDs are not a precise count of individual people. Historical research definitions are preserved on the [research page](/research#numbers).

## Open data

The public player-count endpoint contains no answers or player IDs. The release plan is fixed in the pre-registration: anonymous row-level data for both studies, with every exclusion flag kept, will be published on OSF, Hugging Face and Kaggle under CC BY-NC 4.0, each release with a data card that describes how it was collected, its sample bias and what it should not be used for. Classroom sessions are pooled without class codes. Details: [Open data on the research page](/research#data) and the [pre-registration](https://github.com/ethan-rong/whos-bluffing/blob/main/prereg/PREREG.md).
