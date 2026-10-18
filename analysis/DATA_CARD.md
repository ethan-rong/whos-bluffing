# Who's Bluffing? data card (template — filled at first release)

**Dataset.** Anonymous row-level sessions from the Who's Bluffing web test (and, from add-on v0.2, opt-in rows from Who's Bluffing for Anki). Released on OSF, Hugging Face and Kaggle under CC BY-NC 4.0.

**Collection.** Self-selected visitors to a free web page, recruited through social posts (English: Hacker News, Reddit; Chinese: 小红书, 知乎, 微博, B站) and instructors' classroom codes. Dates: [start]–[end]. Languages: en, zh. Consent line shown before the test; no account; no IP stored; country at ISO-country level from the hosting provider.

**Fields.** session_id, created_at, lang, country, class_code (removed in the public release), first_session_id, demographics (age band, education, native language, region; optional), answers (item id, choice/confidence or low/high, response time), scores (accuracy, mean confidence, overconfidence, Brier, AUROC, interval hit rate), passed_attention, exclusion flags per `prereg/PREREG.md`.

**Known sample bias.** Online, young, educated, interested in psychology or tech; Chinese-language sample skews toward students on 小红书/知乎; classroom samples are whole classes. Not a population estimate of anything.

**Item bank.** 40 two-alternative, 20 interval, 2 attention items per language, parallel translations, sources in `items/items.json`; DIF-flagged items listed in the analysis report.

**Identifiers.** Before release, every anonymous id (web anon_id, Slack member hash, Anki install id) is replaced by a fresh random key, so released ids cannot be used against the live API.

**Not suitable for.** Ranking countries or cultures; clinical or educational assessment of individuals; any re-identification attempt (none is possible by design, and none is permitted by the licence terms of use).

**Maintainer.** Jerry (GitHub: ethan-rong). Issues via the repository.
