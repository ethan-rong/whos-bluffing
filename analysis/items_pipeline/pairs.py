#!/usr/bin/env python3
"""Comparison pairs for Who's Bluffing rounds (items/pairs.json) and the daily ranked rounds and chat questions
(daily/rounds.json). Python 3.9+, standard library only. From the repo root:

    python3 analysis/items_pipeline/pairs.py

Pairs: two items of items/pool.json with the same category and unit; the larger value is at least 1.3 times the
smaller (melting points compared in kelvin), or, for years, at least 10 years apart ("Which came first?"). The AI pack's
categories (items/ai_curated.json: ai_timeline, ai_drama, ai_released, ai_company_founded, ai_money, ai_params, ai_tech)
need only 2 years, 3 months (timeline) or 2 months (drama) (MIN_GAPS, written to each template as `min_gap`; money and
tech use the 1.3 ratio), their year
difficulty scales to match (easy >= 10 years, medium >= 4), their tier 1-2 items count as
famous (`famous`), and they stay out of ranked rounds and the chat question (QUICK_ONLY). AI items carry a `tier` (1 famous
names and years, 2 events and money, 3 technical); a pair's tier is the higher of its two, and the AI pack draws by it
(web/public/packs.js). ai_money items are `volatile` (dated figures): paired for quick rounds, never ranked. The Politics
pack (items/politics_curated.json: pol_elected, pol_timeline, pol_drama, pol_money, pol_numbers) follows the same rules
(2 years, 3 or 2 months, money and counts 1.3), never takes a ranked slot, and pol_numbers pairs any unit (OPEN_UNIT).
Left out: city populations, volatile items, retired items (`retired_at` in the pool, or daily/runtime.json, an export of
items_runtime), the disputed items in DISPUTED, and countries under 20,000 monthly views (famous countries only). An item
marked `ranked_ok: false` (fact-checked, but its definition or figure is ambiguous) is paired for quick rounds and its
pairs carry `ranked_ok: false`: never in a ranked round or the chat question. Difficulty from the ratio:
>= 3 easy, 1.6-3 medium, 1.3-1.6 hard; for years from the gap: >= 50 easy, 20-49 medium, 10-19 hard. No item is in more
than 25 pairs. A pair's number (`p00042`) and a/b order never change once given: live answers, challenge links and ranked
days store them. The number is persisted per (a_id, b_id, category, unit): a new pair gets `next_number`, a pair that
drops out (retired, or no longer picked) keeps its number in `absent` and gets it back if it returns, and no number is
ever reused. A new pair's order is a coin flip seeded by its two ids, so the correct answer is A about half the time. `ref_quality` is the
weaker item's (a fact-checked item counts as referenced). `fame` = the lesser of the two items' English Wikipedia
monthly views (`views_month`, pageviews.py): ranked rounds, the chat question and "easy" rounds need fame >= 50,000,
"normal" rounds >= 20,000; "brutal" rounds take any referenced pair. Selection fills each item's 25 slots in that order:
famous and referenced, famous, known (>= 20,000), referenced, the rest.

daily/rounds.json, one line per UTC day, today to today + 120, append-only (existing days are never changed):
{"ranked": [10 pair ids], "question": pair id}. Ranked: only `referenced` pairs, at most 2 per category, 3 easy +
4 medium + 3 hard, both items with >= 50,000 monthly views. Question: one more such pair (medium when possible) for the
Slack and Discord daily question, never one of that day's ranked pairs; a day's 11 pairs are about 22 different entities
(no "Mercury" twice through its diameter and its distance). No pair on two days within 180 days, no item on two days
within 25 (the brief asked for 30; the eligible supply cannot meet it). Days are filled one after another until one
cannot be: famous, referenced supply sets how far ahead the file reaches.
"""
import argparse
import datetime
import hashlib
import json
import os
import random
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CAP = 25
MIN_RATIO = 1.3
MIN_GAP = 10
DAYS_AHEAD = 120
PAIR_NO_REUSE_DAYS = 180
ITEM_NO_REUSE_DAYS = 25  # see the module docstring: 30 cannot be met with the eligible pool
RANKED_MIX = {"easy": 3, "medium": 4, "hard": 3}
MAX_PER_CATEGORY = 2
RETRIES = 40  # random orders tried for a day the weighted order cannot fill
COUNTRY_CATEGORIES = ("country_area", "country_population")
# (item gap in days, ranked pairs per category, ranked pairs from both country categories together or None). A day is
# filled at the first rung that works: countries at most 2 together while possible, then 2 per category; shorter item
# gaps before larger caps. The rungs at 3 and 4 per category (the check.sh guard allows 4) are a last resort.
RULE_LADDER = ([(gap, 2, 2) for gap in (ITEM_NO_REUSE_DAYS, 14, 7, 5)] + [(gap, 2, None) for gap in (ITEM_NO_REUSE_DAYS, 14, 7, 5)]
               + [(7, 3, None), (5, 4, None)])
EXCLUDED_CATEGORIES = {"city_population"}
# Hand-curated categories (items/ai_curated.json, the AI pack; items/politics_curated.json, the Politics pack): quick
# rounds only, never a ranked round or the chat question (ai_timeline, the AI slot's category, apart).
QUICK_ONLY = {"ai_released", "ai_company_founded", "ai_params", "ai_money", "ai_tech", "ai_drama",
              "pol_elected", "pol_timeline", "pol_numbers", "pol_money", "pol_drama"}
# From AI_SLOT_FROM on, ranked slot 1 (index 0) of every day is one ai_timeline pair (with_ai_slot); the category takes no
# other ranked slot and is never the chat question. Its items need real pageviews >= FAME_RANKED there (ai_slot_ok).
AI_SLOT = "ai_timeline"
AI_SLOT_FROM = "2026-10-05"
FIRST_WEEK = ("OpenAI", "Anthropic", "ChatGPT", "Claude")  # the first week's AI pairs prefer these names
# AI pairs that must exist (people tend to get them wrong); picked before the 25-per-item cap can drop them.
MUST_PAIRS = {frozenset(p) for p in (("Anthropic (founded)", "ChatGPT (released)"), ("Stable Diffusion (released)", "ChatGPT (released)"),
                                      ("OpenAI (founded)", "the Transformer paper (posted)"), ("DeepMind (bought by Google)", "OpenAI (founded)"),
                                      ("Midjourney (open beta)", "DALL·E 2 (announced)"))}
FAME_RANKED = 50000  # both items' monthly views, for ranked rounds, the chat question and "easy" rounds
FAME_NORMAL = 20000  # both items, for the default ("normal") quick rounds
MIN_VIEWS = {"country_population": FAME_NORMAL}  # famous countries only
KELVIN = 273.15
# Values the 2026-10-03 fact-check (analysis/factcheck-2026-10-03.md) found disputed and that were only swapped out of
# the daily schedule, never corrected: a pair should not depend on them.
DISPUTED = {
    "w0052": "Serbia's area includes Kosovo; most references give 77,589 km² without it",
    "w1808": "Oxford has no clear foundation date (teaching by 1096, rapid growth from 1167)",
}

# (category, unit) -> prompt, and the phrases the roast line uses for the item that is more / less.
TEMPLATES = {
    ("country_area", "km²"): ("Which is larger by area?", "was larger", "was smaller"),
    ("mountain_elevation", "m"): ("Which is higher?", "was higher", "was lower"),
    ("river_length", "km"): ("Which is longer?", "was longer", "was shorter"),
    ("lake", "km²"): ("Which is larger by area?", "was larger", "was smaller"),
    ("lake", "m"): ("Which is deeper?", "was deeper", "was shallower"),
    ("building_height", "m"): ("Which is taller?", "was taller", "was shorter"),
    ("bridge_length", "m"): ("Which is longer?", "was longer", "was shorter"),
    ("solar_system_size", "km"): ("Which has the bigger diameter?", "was bigger", "was smaller"),
    ("solar_system_distance", "million km"): ("Which is farther from the Sun?", "was farther from the Sun", "was closer to the Sun"),
    ("solar_system_distance", "km"): ("Which orbits farther from its planet?", "orbited farther out", "orbited closer in"),
    ("element_melting_point", "°C"): ("Which melts at a higher temperature?", "melted hotter", "melted cooler"),
    ("first_flight", "year"): ("Which came first?", "came first", "came later"),
    ("university_founded", "year"): ("Which was founded first?", "was founded first", "was founded later"),
    ("first_ascent", "year"): ("Which was first climbed earlier?", "was climbed first", "was climbed later"),
    ("country_population", "people"): ("Which country has more people?", "had more people", "had fewer people"),
    ("company_founded", "year"): ("Which company was founded first?", "was founded first", "was founded later"),
    ("product_released", "year"): ("Which came out first?", "came out first", "came out later"),
    ("language_speakers", "people"): ("Which language has more native speakers?", "had more native speakers", "had fewer native speakers"),
    ("landmark_height", "m"): ("Which is taller?", "was taller", "was shorter"),
    ("landmark_built", "year"): ("Which is older?", "was older", "was newer"),
    ("ai_released", "year"): ("Which came first?", "came first", "came later"),
    ("ai_company_founded", "year"): ("Which came first?", "was founded first", "was founded later"),
    ("ai_params", "parameters"): ("Which model has more parameters?", "had more parameters", "had fewer parameters"),
    ("ai_timeline", "month"): ("Which came first?", "came first", "came later"),
    ("ai_drama", "month"): ("Which came first?", "came first", "came later"),
    ("ai_money", "USD"): ("Which is bigger?", "was bigger", "was smaller"),
    ("ai_tech", "tokens of context"): ("Which has the longer context window?", "had the longer context window", "had the shorter context window"),
    ("ai_tech", "training tokens"): ("Which was trained on more tokens?", "was trained on more tokens", "was trained on fewer tokens"),
    ("ai_tech", "petaFLOP-days"): ("Which took more compute to train?", "took more compute", "took less compute"),
    ("ai_tech", "transistors"): ("Which chip has more transistors?", "had more transistors", "had fewer transistors"),
    ("ai_tech", "images"): ("Which dataset has more images?", "had more images", "had fewer images"),
    ("ai_tech", "GB of memory"): ("Which has more memory?", "had more memory", "had less memory"),
    ("ai_tech", "authors"): ("Which paper has more authors?", "had more authors", "had fewer authors"),
    ("ai_tech", "experts"): ("Which model has more experts?", "had more experts", "had fewer experts"),
    ("pol_elected", "year"): ("Which came first?", "came first", "came later"),
    ("pol_timeline", "month"): ("Which came first?", "came first", "came later"),
    ("pol_drama", "month"): ("Which came first?", "came first", "came later"),
    ("pol_money", "USD"): ("Which is bigger?", "was bigger", "was smaller"),
}
# pol_numbers takes any unit (items/politics_curated.json): every unit gets this template, and units never mix.
OPEN_UNIT = {"pol_numbers": ("Which is bigger?", "was bigger", "was smaller")}
# Minimum gap per (category, unit) when it is not MIN_GAP years or MIN_RATIO: AI years are 2 apart (the field is young;
# instead of the usual 10, logged in CHANGELOG.md), and the Politics pack's follow the AI pack's. Year difficulty
# scales with it: easy >= 5x, medium >= 2x.
MIN_GAPS = {("ai_released", "year"): 2, ("ai_company_founded", "year"): 2, ("ai_params", "parameters"): MIN_RATIO,
            ("ai_timeline", "month"): 3, ("ai_drama", "month"): 2,  # months: answers are YYYYMM numbers (202211 = November 2022)
            ("pol_elected", "year"): 2, ("pol_timeline", "month"): 3, ("pol_drama", "month"): 2}
NOT_A_PLANET = {"Pluto"}  # "its planet": moons of a dwarf planet stay out of the orbit-distance pairs
REF_RANK = {"none": 0, "imported": 1, "referenced": 2}


def template(category, unit):
    """(prompt, more, less) for a pair of this category and unit, or None when such items are not paired."""
    return TEMPLATES.get((category, unit)) or OPEN_UNIT.get(category)


def is_year(unit):
    return unit == "year"


def is_time(unit):
    """Years and months (YYYYMM): the earlier one is the right answer and pairs are measured by the gap."""
    return unit in ("year", "month")


def month_index(answer):
    """202211 -> months since year 0, so gaps across a new year count right (2022-11 to 2023-02 is 3)."""
    return answer // 100 * 12 + answer % 100 - 1


def min_gap(category, unit):
    """The smallest gap (years, or months for unit month) or value ratio a pair of this category and unit needs."""
    return MIN_GAPS.get((category, unit), MIN_GAP if is_time(unit) else MIN_RATIO)


def difficulty(ratio=None, gap=None, least=MIN_GAP):
    """From the ratio (>= 3 easy, 1.6-3 medium, below hard) or the year gap (>= 5x the minimum gap easy, >= 2x medium:
    50 and 20 years at the usual 10)."""
    if gap is not None:
        return "easy" if gap >= 5 * least else "medium" if gap >= 2 * least else "hard"
    return "easy" if ratio >= 3 else "medium" if ratio >= 1.6 else "hard"


def item_ref(item):
    return "referenced" if item.get("fact_checked") else item.get("ref_quality", "none")


def views(item):
    """Monthly views; an item marked `famous` (the curated AI items) counts as famous whatever its article's views."""
    return max(item.get("views_month", 0), FAME_RANKED) if item.get("famous") else item.get("views_month", 0)


def band(fame):
    """2 = famous (>= 50,000 monthly views), 1 = known (>= 20,000), 0 = obscure."""
    return 2 if fame >= FAME_RANKED else 1 if fame >= FAME_NORMAL else 0


def usable(item, retired):
    """Items that may appear in a pair (see the module docstring)."""
    if (item["category"] in EXCLUDED_CATEGORIES or (item.get("volatile") and item["category"] not in QUICK_ONLY)
            or item.get("retired_at") or item["id"] in retired or item["id"] in DISPUTED):
        return False
    if views(item) < MIN_VIEWS.get(item["category"], 0):
        return False
    if not item.get("name") or template(item["category"], item["en"]["unit"]) is None:
        return False
    if item["en"]["unit"] == "km" and item["category"] == "solar_system_distance":
        parent = item["en"]["prompt"].rsplit(" from ", 1)[-1].rstrip("?")
        if parent in NOT_A_PLANET:
            return False
    return is_year(item["en"]["unit"]) or comparable(item) > 0


def comparable(item):
    """The value ratios are taken on: kelvin for melting points, else the answer."""
    return item["answer"] + KELVIN if item["category"] == "element_melting_point" else item["answer"]


def pair_key(a_id, b_id):
    return (a_id, b_id) if a_id < b_id else (b_id, a_id)


def number_key(a_id, b_id, category, unit):
    return pair_key(a_id, b_id) + (category, unit)


def numbering(doc):
    """{number key: (n, a_id, b_id)} for every pair number ever given (the document's pairs and its `absent` list) and
    the next free number. Live answers, challenge links and ranked days store pair ids, so a number is never reused: a
    pair that drops out keeps its number in `absent` and gets it back, a/b order included, if it returns."""
    rows = [(int(p["id"][1:]), p["a_id"], p["b_id"], p["category"], p["unit"]) for p in doc.get("pairs", ())]
    rows += [tuple(r) for r in doc.get("absent", ())]
    known = {number_key(a, b, c, u): (n, a, b) for n, a, b, c, u in rows}
    return known, max([doc.get("next_number", 1)] + [n + 1 for n, *_ in rows])


def measure(a, b):
    """(ratio, gap) of two items of one group; None when they are too close to pair."""
    least = min_gap(a["category"], a["en"]["unit"])
    if is_time(a["en"]["unit"]):
        at = month_index if a["en"]["unit"] == "month" else (lambda x: x)
        gap = abs(at(a["answer"]) - at(b["answer"]))
        return (None, gap) if gap >= least else None
    lo, hi = sorted((comparable(a), comparable(b)))
    ratio = hi / lo
    return (round(ratio, 3), None) if ratio >= least else None


def correct_index(a, b):
    """0 when a is the right answer: the larger value, or the earlier year or month."""
    if is_time(a["en"]["unit"]):
        return 0 if a["answer"] < b["answer"] else 1
    return 0 if comparable(a) > comparable(b) else 1


def coin(a_id, b_id):
    return int(hashlib.sha256(f"{a_id}|{b_id}".encode()).hexdigest(), 16) % 2


def tier(fame, both_referenced):
    """Selection order: 0 famous and referenced (ranked), 1 famous, 2 known, 3 referenced (brutal), 4 the rest."""
    return 0 if fame >= FAME_RANKED and both_referenced else 1 if fame >= FAME_RANKED else 2 if fame >= FAME_NORMAL else 3 if both_referenced else 4


def candidates(items):
    """Every valid pair within each (category, unit) group: [(key, ratio, gap, difficulty, tier)]."""
    groups = {}
    for it in items:
        groups.setdefault((it["category"], it["en"]["unit"]), []).append(it)
    out = []
    for group in groups.values():
        group.sort(key=lambda it: it["id"])
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if entity(a) == entity(b):
                    continue  # two facts about one entity (DeepMind founded / bought) are never compared
                m = measure(a, b)
                if m:
                    both = item_ref(a) == item_ref(b) == "referenced"
                    level = difficulty(*m, least=min_gap(a["category"], a["en"]["unit"]))
                    out.append((pair_key(a["id"], b["id"]), m[0], m[1], level, tier(min(views(a), views(b)), both)))
    return out


def interleave(cands, rng):
    """The candidates with the difficulty classes interleaved (hard, medium, easy, hard, ...), each class shuffled."""
    by_level = {"hard": [], "medium": [], "easy": []}
    for c in cands:
        by_level[c[3]].append(c)
    for xs in by_level.values():
        rng.shuffle(xs)
    order = []
    for k in range(max([len(xs) for xs in by_level.values()] + [0])):
        order.extend(xs[k] for xs in by_level.values() if k < len(xs))
    return order


def select(cands, preferred=frozenset(), cap=CAP, seed=20261003):
    """Greedy, maximal under the per-item cap: previously generated pairs first, then by tier (famous and referenced,
    famous, known, referenced, the rest: a famous item's slots go to famous partners first); the difficulty classes
    interleaved within each tier so each item's 25 slots get a mix."""
    rng = random.Random(seed)
    cands = sorted(cands)
    order = [c for c in cands if c[0] in preferred]
    for t in range(5):
        order += interleave([c for c in cands if c[0] not in preferred and c[4] == t], rng)
    degree, chosen = {}, []
    for c in order:
        a_id, b_id = c[0]
        if degree.get(a_id, 0) < cap and degree.get(b_id, 0) < cap:
            degree[a_id] = degree.get(a_id, 0) + 1
            degree[b_id] = degree.get(b_id, 0) + 1
            chosen.append(c)
    return chosen


def build_pairs(pool_items, previous=(), retired=(), scheduled=(), generated_at=None, numbers=None):
    """Returns (pairs document, report). previous: the last items/pairs.json pairs (picked again first); scheduled: pair
    ids used in daily/rounds.json, carried over even when they no longer qualify; numbers: the last items/pairs.json
    document, whose pairs and `absent` list fix the number and a/b order of every pair ever made (default: previous).
    New pairs get the next free number (`next_number`); numbers are never reused."""
    generated_at = generated_at or datetime.date.today().isoformat()
    by_id = {it["id"]: it for it in pool_items}
    retired = set(retired)
    items = [it for it in pool_items if usable(it, retired)]
    known, next_n = numbering(numbers if numbers is not None else {"pairs": list(previous)})
    cands = candidates(items)
    must = {c[0] for c in cands if frozenset((by_id[c[0][0]].get("name"), by_id[c[0][1]].get("name"))) in MUST_PAIRS}
    chosen = select(cands, preferred=frozenset(pair_key(p["a_id"], p["b_id"]) for p in previous) | must)
    pairs, seen = [], set()
    for key, ratio, gap, level, _ in chosen:
        first = by_id[key[0]]
        mine = known.get(number_key(*key, first["category"], first["en"]["unit"]))
        if mine:
            n, a_id, b_id = mine
        else:
            n, next_n = next_n, next_n + 1
            a_id, b_id = key if coin(*key) == 0 else key[::-1]
        pairs.append(make_pair(f"p{n:05d}", by_id[a_id], by_id[b_id], ratio, gap, level))
        seen.add(f"p{n:05d}")
    carried = [p for p in previous if p["id"] in set(scheduled) - seen and p["a_id"] in by_id and p["b_id"] in by_id]
    pairs = sorted(pairs + carried, key=lambda p: p["id"])
    present = {number_key(p["a_id"], p["b_id"], p["category"], p["unit"]) for p in pairs}
    absent = sorted([n, a, b, k[2], k[3]] for k, (n, a, b) in known.items() if k not in present)
    open_units = sorted({(p["category"], p["unit"]) for p in pairs if p["category"] in OPEN_UNIT})
    doc = {"version": 1, "generated_at": generated_at, "next_number": next_n,
           "templates": [{"category": c, "unit": u, "prompt": t[0], "more": t[1], "less": t[2], "min_gap": min_gap(c, u)}
                         for (c, u), t in list(TEMPLATES.items()) + [(k, template(*k)) for k in open_units]],
           "pairs": pairs, "absent": absent}
    return doc, report(pairs, items, carried)


def make_pair(pair_id, a, b, ratio, gap, level):
    prompt = template(a["category"], a["en"]["unit"])[0]
    weaker = min(item_ref(a), item_ref(b), key=REF_RANK.get)
    pair = {"id": pair_id, "a_id": a["id"], "b_id": b["id"], "truth": correct_index(a, b), "ratio": ratio}
    if gap is not None:
        pair["gap"] = gap
    pair.update({"prompt": prompt, "a": a["name"], "b": b["name"], "unit": a["en"]["unit"], "category": a["category"],
                 "difficulty_hint": level, "ref_quality": weaker, "fame": min(views(a), views(b))})
    if a.get("ranked_ok") is False or b.get("ranked_ok") is False:
        pair["ranked_ok"] = False
    if "tier" in a or "tier" in b:
        pair["tier"] = max(a.get("tier", 1), b.get("tier", 1))  # the curated packs draw by tier (web/public/packs.js)
    if a.get("volatile") or b.get("volatile"):
        pair["volatile"] = True  # dated figures (ai_money, pol_money): quick rounds only
    return pair


BANDS = ("famous", "known", "obscure")  # band 2, 1, 0


def report(pairs, items, carried):
    by = {}
    for p in pairs:
        row = by.setdefault(f"{p['category']} ({p['unit']})", {"pairs": 0, "famous": 0, "known": 0, "obscure": 0, "ranked_ok": 0,
                                                              "referenced": 0, "imported": 0, "none": 0, "easy": 0, "medium": 0, "hard": 0})
        row["pairs"] += 1
        row[BANDS[2 - band(p.get("fame", 0))]] += 1
        row["ranked_ok"] += ranked_ok(p)
        row[p["ref_quality"]] += 1
        row[p["difficulty_hint"]] += 1
    in_pairs = {i for p in pairs for i in (p["a_id"], p["b_id"])}
    item_bands = {name: sum(1 for it in items if BANDS[2 - band(views(it))] == name) for name in BANDS}
    return {"categories": dict(sorted(by.items())), "total": len(pairs), "usable_items": len(items),
            "items_in_pairs": len(in_pairs), "carried_scheduled": len(carried), "usable_items_by_band": item_bands,
            "pairs_by_band": {name: sum(r[name] for r in by.values()) for name in BANDS},
            "ranked_ok": sum(r["ranked_ok"] for r in by.values()),
            "truth_a_share": round(sum(p["truth"] == 0 for p in pairs) / max(1, len(pairs)), 4)}


def ranked_ok(pair):
    """May be used in a ranked round or as the chat question: both items referenced or fact-checked, famous,
    neither marked ranked_ok: false, and not from a quick-only category (QUICK_ONLY: the AI pack)."""
    return (pair["ref_quality"] == "referenced" and pair.get("fame", 0) >= FAME_RANKED and pair.get("ranked_ok", True)
            and pair["category"] not in QUICK_ONLY and pair["category"] != AI_SLOT and not pair.get("volatile"))


def ai_slot_ok(pair, items):
    """May fill the AI slot: an AI_SLOT pair of tier 1 or 2, not volatile, fact-checked, both items with >= FAME_RANKED
    monthly views of their own (real pageviews, not the `famous` mark: the ranked round keeps its familiarity bar)."""
    return (pair["category"] == AI_SLOT and pair["ref_quality"] == "referenced" and pair.get("ranked_ok", True)
            and pair.get("tier", 1) <= 2 and not pair.get("volatile")
            and all(items[i].get("views_month", 0) >= FAME_RANKED for i in (pair["a_id"], pair["b_id"])))


def with_ai_slot(pairs, rounds, items, start=AI_SLOT_FROM, entity_of=None, item_gap=5):
    """A new rounds dict in which every ranked day from start on has an AI_SLOT pair in slot 1 (index 0). A day without
    one gets the first free pair (not on another day within 180 days, its items not on another day within item_gap
    days, no entity the day already has; the must-pairs first, the first week's OpenAI/Anthropic/ChatGPT/Claude pairs
    next, then items rested longest and best known). It takes the place of a ranked pair of the same difficulty (the
    3/4/3 mix holds), from the day's most common category. Earlier days and days that have one are left alone."""
    ent = (lambda i: entity_of.get(i, i)) if entity_of else (lambda i: i)
    by_id = {p["id"]: p for p in pairs}
    out = {d: {"ranked": list(e["ranked"]), "question": e["question"]} for d, e in rounds.items()}
    cands = [p for p in pairs if ai_slot_ok(p, items)]
    pair_uses, item_uses = {}, {}

    def mark(date, pid, add):
        for key, table in [(pid, pair_uses)] + [(i, item_uses) for i in (by_id[pid]["a_id"], by_id[pid]["b_id"])]:
            (table.setdefault(key, set()).add if add else table.setdefault(key, set()).discard)(date)

    for d, e in out.items():
        for pid in day_pairs(e):
            mark(d, pid, True)
    for date in sorted(d for d in out if d >= start):
        day = out[date]
        if by_id[day["ranked"][0]]["category"] == AI_SLOT:
            continue
        rest_days = lambda p: min([days_between(d, date) for i in (p["a_id"], p["b_id"]) for d in item_uses.get(i, ()) if d != date] + [999])
        free = [p for p in cands if rest_days(p) >= item_gap
                and all(days_between(d, date) >= PAIR_NO_REUSE_DAYS for d in pair_uses.get(p["id"], ()) if d != date)]
        early = days_between(date, start) < 7
        free.sort(key=lambda p: (frozenset((p["a"], p["b"])) not in MUST_PAIRS, not (early and any(w in p["a"] + p["b"] for w in FIRST_WEEK)),
                                 -min(rest_days(p), 60), -p["fame"], p["id"]))
        for p in free:
            ranked = day["ranked"]
            count = {}
            for x in ranked:
                count[by_id[x]["category"]] = count.get(by_id[x]["category"], 0) + 1
            slots = sorted((k for k, x in enumerate(ranked) if by_id[x]["difficulty_hint"] == p["difficulty_hint"]),
                           key=lambda k: (-count[by_id[ranked[k]]["category"]], -k))
            k = next((k for k in slots if not {ent(p["a_id"]), ent(p["b_id"])} & {ent(i) for j, x in enumerate(ranked + [day["question"]])
                                                                                if j != k for i in (by_id[x]["a_id"], by_id[x]["b_id"])}), None)
            if k is None:
                continue
            mark(date, ranked[k], False)
            day["ranked"] = [p["id"]] + [x for j, x in enumerate(ranked) if j != k]
            mark(date, p["id"], True)
            break
    return out


# --- ranked rounds and chat questions --------------------------------------------------------------------------

def add_days(date, n):
    return (datetime.date.fromisoformat(date) + datetime.timedelta(days=n)).isoformat()


def days_between(a, b):
    return abs((datetime.date.fromisoformat(a) - datetime.date.fromisoformat(b)).days)


def day_pairs(entry):
    return list(entry["ranked"]) + [entry["question"]]


def entity(item):
    """The Wikidata entity an item is about (Q-id from its statement URL), else its own id."""
    m = re.search(r"/(Q\d+)#", item.get("replaces") or item.get("source", ""))
    return m.group(1) if m else item["id"]


def extend_rounds(pairs, rounds, today, days=DAYS_AHEAD, retired_pairs=(), popularity=None, entity_of=None, ladder=None, log=None):
    """Returns a new rounds dict: the existing days unchanged plus every missing day from today to today + days, in
    order, stopping at the first day the eligible pairs cannot fill at any rung of the ladder (the result then ends the
    day before). ladder: [(item gap, pairs per category[, pairs from both country categories together])], strictest
    first (default RULE_LADDER); log: a dict that gets {date: [item gap, pairs per category, joint cap or None]}.
    popularity: item id -> monthly views; each day tries pairs in a random order weighted towards well-known items (a
    pair counts as known as its lesser-known item), so they come back first once the 25 days are over.
    entity_of: item id -> entity (default: the item id), for the distinct-entities rule within a day."""
    known = (lambda p: min(popularity.get(p["a_id"], 0), popularity.get(p["b_id"], 0))) if popularity else (lambda p: 1)
    ent = (lambda i: entity_of.get(i, i)) if entity_of else (lambda i: i)
    out = dict(rounds)
    by_id = {p["id"]: p for p in pairs}
    blocked = set(retired_pairs)
    eligible = {level: [p for p in pairs if ranked_ok(p) and p["id"] not in blocked and p["difficulty_hint"] == level]
                for level in RANKED_MIX}
    pair_uses, item_uses = {}, {}

    def use(date, ids):
        for pid in ids:
            pair_uses.setdefault(pid, []).append(date)
            p = by_id.get(pid)
            for i in ((p["a_id"], p["b_id"]) if p else ()):
                item_uses.setdefault(i, []).append(date)

    for date, entry in out.items():
        use(date, day_pairs(entry))

    def freedom(gap):
        def free(p, date, taken_entities):
            if ent(p["a_id"]) in taken_entities or ent(p["b_id"]) in taken_entities:
                return False
            if any(days_between(d, date) < PAIR_NO_REUSE_DAYS for d in pair_uses.get(p["id"], ())):
                return False
            return all(days_between(d, date) >= gap for i in (p["a_id"], p["b_id"]) for d in item_uses.get(i, ()))
        return free

    for k in range(days + 1):
        date = add_days(today, k)
        if date in out:
            continue
        entry = None
        # The weighted order first; a greedy dead end (the category limit and the 3/4/3 mix fight over the few famous
        # categories) gets up to RETRIES plain random orders, seeded by the date.
        for rung in ladder or RULE_LADDER:
            gap, cap, joint = (tuple(rung) + (None,))[:3]
            for attempt in ["known first"] + [f"random {k}" for k in range(RETRIES)]:
                rng = random.Random(f"{date}/{attempt}" if attempt != "known first" else date)
                weight = known if attempt == "known first" else (lambda p: 1)
                order = {level: sorted(xs, key=lambda p: -weight(p) * rng.uniform(0.5, 1)) for level, xs in eligible.items()}
                entry = fill_day(date, order, pair_uses, freedom(gap), ent, cap, joint)
                if entry:
                    break
            if entry:
                if log is not None:
                    log[date] = [gap, cap, joint]
                break
        if entry is None:
            break  # supply exhausted: the file ends the day before
        out[date] = entry
        use(date, day_pairs(entry))
    return dict(sorted(out.items()))


def fill_day(date, order, pair_uses, free, ent, cap=MAX_PER_CATEGORY, joint=None):
    """One day from the given candidate order: {"ranked", "question"}, or None when a slot cannot be filled. joint: the
    two country categories count as one group with this cap (None: each has `cap`)."""
    picked, entities, per_cat = [], set(), {}
    group = (lambda c: "countries" if c in COUNTRY_CATEGORIES else c) if joint is not None else (lambda c: c)
    limit = lambda g: joint if g == "countries" else cap

    def pick(level, limit_category):
        ok = lambda p: (free(p, date, entities) and (not limit_category or per_cat.get(group(p["category"]), 0) < limit(group(p["category"]))))
        p = next((p for p in order[level] if p["id"] not in pair_uses and ok(p)), None)  # never used beats used long ago
        p = p or next((p for p in order[level] if ok(p)), None)
        if p is None:
            return None
        entities.update((ent(p["a_id"]), ent(p["b_id"])))
        per_cat[group(p["category"])] = per_cat.get(group(p["category"]), 0) + 1
        return p["id"]

    for level in ("hard", "easy", "medium"):  # scarcest first
        for _ in range(RANKED_MIX[level]):
            pid = pick(level, True)
            if pid is None:
                return None
            picked.append(pid)
    question = pick("medium", False) or pick("easy", False) or pick("hard", False)
    return {"ranked": picked, "question": question} if question else None


def format_rounds(rounds):
    """One line per day, so a swap during the nightly review is a one-line edit."""
    lines = [f'  "{d}": {{"ranked": [{", ".join(json.dumps(i) for i in e["ranked"])}], "question": {json.dumps(e["question"])}}}'
             for d, e in rounds.items()]
    return "{\n" + ",\n".join(lines) + "\n}\n"


def format_pairs(doc):
    """One pair per line, then one retired number per line (the file is long; this keeps diffs reviewable)."""
    head = {k: v for k, v in doc.items() if k not in ("pairs", "absent")}
    lines = lambda rows: ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows)
    return (json.dumps(head, ensure_ascii=False, indent=1)[:-2] + ',\n "pairs": [\n' + lines(doc["pairs"])
            + '\n ],\n "absent": [\n' + lines(doc.get("absent", [])) + "\n ]\n}\n")


def review_markdown(doc, rep, rounds, seed=20261003):
    lines = [f"# Comparison pairs — review ({doc['generated_at']})", "",
             "Generated by `analysis/items_pipeline/pairs.py` from `items/pool.json`. `referenced` = both items have a "
             "Wikidata reference other than a Wikipedia import, or were fact-checked by hand (only these go into ranked "
             "rounds); otherwise the weaker item's reference quality. Fame bands by the lesser item's English Wikipedia "
             "monthly views: famous >= 50,000, known 20,000-49,999, obscure below. Ranked-ready = famous and referenced.", "",
             "| Category (unit) | Pairs | famous | known | obscure | ranked-ready | referenced | imported | none | easy | medium | hard |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, r in rep["categories"].items():
        lines.append(f"| {name} | {r['pairs']} | {r['famous']} | {r['known']} | {r['obscure']} | {r['ranked_ok']} | {r['referenced']} | "
                     f"{r['imported']} | {r['none']} | {r['easy']} | {r['medium']} | {r['hard']} |")
    lines += ["", f"**Total: {rep['total']} pairs** over {rep['items_in_pairs']} items ({rep['usable_items']} usable; "
                  f"{rep['carried_scheduled']} scheduled pairs carried over). Correct answer is A in {rep['truth_a_share']:.1%} of pairs. "
                  f"Pairs by band: {', '.join(f'{k} {v}' for k, v in rep['pairs_by_band'].items())}; ranked-ready {rep['ranked_ok']}. "
                  f"Usable items by band: {', '.join(f'{k} {v}' for k, v in rep['usable_items_by_band'].items())}.",
              "", f"Ranked rounds and chat questions: {len(rounds)} days in `daily/rounds.json`"
                  + (f", {min(rounds)} to {max(rounds)}." if rounds else ".")
                  + (" New days by scheduling rule: " + "; ".join(f"{k}: {v}" for k, v in rep["ranked_days"]["new_days_by_rule"].items()) + "."
                     if rep.get("ranked_days") else ""), "", "## 20 random pairs", ""]
    rng = random.Random(seed)
    for p in sorted(rng.sample(doc["pairs"], min(20, len(doc["pairs"]))), key=lambda p: p["id"]):
        lines.append(f"- [ ] `{p['id']}` {p['prompt']} {p['a']} or {p['b']}? → **{'AB'[p['truth']]}** "
                     f"({p['difficulty_hint']}, {p['ref_quality']}, {p.get('fame', 0):,} views)")
    return "\n".join(lines) + "\n"


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def runtime_rows(data):
    """wrangler d1 execute --json prints [{results: [...]}]; a plain list of rows works too."""
    return data[0]["results"] if data and isinstance(data[0], dict) and "results" in data[0] else data


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool", default=os.path.join(ROOT, "items", "pool.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "items", "pairs.json"))
    ap.add_argument("--rounds", default=os.path.join(ROOT, "daily", "rounds.json"))
    ap.add_argument("--runtime", default=os.path.join(ROOT, "daily", "runtime.json"), help="items_runtime export (retired items)")
    ap.add_argument("--pair-runtime", default=os.path.join(ROOT, "daily", "pair_runtime.json"), help="pair_runtime export (retired pairs)")
    ap.add_argument("--today", default=datetime.datetime.utcnow().date().isoformat())
    ap.add_argument("--fresh", action="store_true",
                    help="ignore the existing days and pick pairs anew (pair numbers are kept either way: they never change)")
    args = ap.parse_args(argv)

    pool = read_json(args.pool, None)
    if pool is None:
        print(f"error: {args.pool} not found", file=sys.stderr)
        return 2
    retired = {r["item_id"] for r in runtime_rows(read_json(args.runtime, [])) if r.get("retired_at")}
    retired_pairs = {r["pair_id"] for r in runtime_rows(read_json(args.pair_runtime, [])) if r.get("retired_at")}
    rounds = {} if args.fresh else read_json(args.rounds, {})
    last = read_json(args.out, {"pairs": []})
    previous = [] if args.fresh else last["pairs"]
    scheduled = {i for e in rounds.values() for i in day_pairs(e)}
    doc, rep = build_pairs(pool["items"], previous, retired, scheduled, numbers=last)
    levels = {}
    entity_of = {it["id"]: entity(it) for it in pool["items"]}
    rounds = extend_rounds(doc["pairs"], rounds, args.today, retired_pairs=retired_pairs, popularity={it["id"]: views(it) for it in pool["items"]},
                           entity_of=entity_of, log=levels)
    rounds = with_ai_slot(doc["pairs"], rounds, {it["id"]: it for it in pool["items"]}, entity_of=entity_of)
    ahead = [d for d in rounds if d >= args.today]
    by_rung = {f"gap {g} days, {c} per category" + (f", countries {j} together" if j else ""): sum(1 for v in levels.values() if v == [g, c, j])
               for g, c, j in RULE_LADDER}
    rep["ranked_days"] = {"total": len(rounds), "from_today": len(ahead), "last": max(rounds) if rounds else None, "new_days_by_rule": by_rung}
    with open(args.out, "w") as f:
        f.write(format_pairs(doc))
    with open(args.rounds, "w") as f:
        f.write(format_rounds(rounds))
    with open(os.path.join(os.path.dirname(args.out), "pairs.REVIEW.md"), "w") as f:
        f.write(review_markdown(doc, rep, rounds))
    print(json.dumps(rep, indent=1, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
