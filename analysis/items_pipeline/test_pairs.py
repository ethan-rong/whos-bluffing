"""Offline tests for pairs.py: the pair rules, stable ids and a/b order, the per-item cap, the truth balance, and the
ranked-round / chat-question builder. Synthetic pools only; never touches the repo's files.

    python3 -m unittest discover -s analysis/items_pipeline        (also run by `npm test` in web/)
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pairs as P  # noqa: E402

UNITS = {"river_length": "km", "mountain_elevation": "m", "building_height": "m", "bridge_length": "m", "country_area": "km²",
         "element_melting_point": "°C", "first_flight": "year", "first_ascent": "year", "city_population": "people",
         "university_founded": "year", "solar_system_size": "km", "country_population": "people", "company_founded": "year",
         "product_released": "year", "language_speakers": "people", "landmark_height": "m", "landmark_built": "year"}
FAMOUS = 100000  # monthly views of a fixture item unless a test says otherwise


def item(n, category, answer, ref="referenced", unit=None, views=FAMOUS, **extra):
    unit = unit or UNITS[category]
    it = {"id": f"w{n:04d}", "category": category, "en": {"prompt": f"Question {n}?", "unit": unit}, "answer": answer,
          "name": f"thing {n}", "ref_quality": ref, "fact_checked": False, "volatile": False, "views_month": views}
    it.update(extra)
    return it


def spread_pool(categories, per_category, start=1, ref="referenced", views=FAMOUS):
    """Values 1.06^k apart within each category: every difficulty class has plenty of pairs."""
    items, n = [], start
    for c in categories:
        for k in range(per_category):
            unit = UNITS[c]
            answer = 1800 + k if unit == "year" else round(100 * 1.06 ** k, 2)
            items.append(item(n, c, answer, ref, views=views))
            n += 1
    return items


def pairs_of(items, **kw):
    return P.build_pairs(items, generated_at="2026-10-03", **kw)[0]["pairs"]


class Rules(unittest.TestCase):
    def test_ratio_of_at_least_1_3_within_one_category_and_unit(self):
        items = [item(1, "river_length", 100), item(2, "river_length", 129), item(3, "river_length", 130),
                 item(4, "bridge_length", 300), item(5, "mountain_elevation", 400)]
        got = {tuple(sorted((p["a_id"], p["b_id"]))) for p in pairs_of(items)}
        self.assertEqual(got, {("w0001", "w0003"), ("w0002", "w0004")} - {("w0002", "w0004")})  # 129/100 < 1.3; other categories never mix
        lake = [item(1, "river_length", 10, unit="km"), item(2, "river_length", 100, unit="m")]
        lake[0]["category"] = lake[1]["category"] = "lake"
        self.assertEqual(pairs_of(lake), [])  # same category, different unit (area vs depth)

    def test_difficulty_from_ratio_and_from_year_gap(self):
        self.assertEqual([P.difficulty(ratio=r) for r in (3, 2.99, 1.6, 1.59, 1.3)], ["easy", "medium", "medium", "hard", "hard"])
        self.assertEqual([P.difficulty(gap=g) for g in (50, 49, 20, 19, 10)], ["easy", "medium", "medium", "hard", "hard"])

    def test_melting_points_compare_in_kelvin(self):
        items = [item(1, "element_melting_point", -38.8), item(2, "element_melting_point", 0), item(3, "element_melting_point", 100)]
        got = {(p["a_id"], p["b_id"]) if p["a_id"] < p["b_id"] else (p["b_id"], p["a_id"]): p for p in pairs_of(items)}
        # 373.15 K / 234.35 K = 1.59 and 373.15 / 273.15 = 1.37 pair; 0 °C vs -38.8 °C is only 1.17 (in Celsius: undefined)
        self.assertEqual(set(got), {("w0001", "w0003"), ("w0002", "w0003")})
        p = got[("w0001", "w0003")]
        self.assertEqual((p["ratio"], p["difficulty_hint"], p["prompt"]), (1.592, "hard", "Which melts at a higher temperature?"))
        self.assertEqual([p["a_id"], p["b_id"]][p["truth"]], "w0003")  # 100 °C melts hotter
        self.assertEqual(got[("w0002", "w0003")]["ratio"], 1.366)

    def test_years_need_a_ten_year_gap_and_the_earlier_one_is_right(self):
        items = [item(1, "first_flight", 1969), item(2, "first_flight", 1960), item(3, "first_flight", 1959)]
        ps = pairs_of(items)
        self.assertEqual(len(ps), 1)  # 1969-1960 = 9 years: too close; 1969-1959 = 10
        p = ps[0]
        self.assertEqual((p["ratio"], p["gap"], p["difficulty_hint"], p["prompt"], p["unit"]), (None, 10, "hard", "Which came first?", "year"))
        self.assertEqual([p["a_id"], p["b_id"]][p["truth"]], "w0003")
        uni = pairs_of([item(1, "university_founded", 1636), item(2, "university_founded", 1088)])[0]
        self.assertEqual((uni["prompt"], [uni["a_id"], uni["b_id"]][uni["truth"]], uni["difficulty_hint"]), ("Which was founded first?", "w0002", "easy"))
        self.assertEqual(pairs_of([item(1, "first_ascent", 1953), item(2, "first_ascent", 1865)])[0]["prompt"], "Which was first climbed earlier?")

    def test_exclusions(self):
        base = [item(1, "river_length", 100), item(2, "river_length", 1000)]
        cases = {
            "city populations": [item(1, "city_population", 1e6), item(2, "city_population", 5e6)],
            "volatile": [base[0], dict(base[1], volatile=True)],
            "disputed": [item(52, "country_area", 88499), item(1, "country_area", 1000)],
            "no name": [base[0], dict(base[1], name="")],
            "not positive": [item(1, "mountain_elevation", 0), item(2, "mountain_elevation", 4000)],
            "a moon of a dwarf planet": [item(1, "solar_system_size", 1000), item(2, "solar_system_size", 5000)],
        }
        cases["a moon of a dwarf planet"] = [
            dict(item(1, "solar_system_size", 19591, unit="km"), category="solar_system_distance", en={"prompt": "On average, how far is Charon from Pluto?", "unit": "km"}),
            dict(item(2, "solar_system_size", 384400, unit="km"), category="solar_system_distance", en={"prompt": "On average, how far is the Moon from Earth?", "unit": "km"}),
        ]
        for name, items in cases.items():
            self.assertEqual(pairs_of(items), [], name)
        self.assertEqual(pairs_of(base, retired={"w0002"}), [])
        self.assertEqual(len(pairs_of(base)), 1)
        self.assertIn("w0052", P.DISPUTED)

    def test_no_item_in_more_than_25_pairs_and_the_cap_is_nearly_filled(self):
        ps = pairs_of(spread_pool(["river_length", "country_area"], 120))
        degree = {}
        for p in ps:
            for i in (p["a_id"], p["b_id"]):
                degree[i] = degree.get(i, 0) + 1
        self.assertEqual(max(degree.values()), 25)
        self.assertGreater(len(ps), 0.95 * 240 * 25 / 2)  # greedy, but close to the ceiling of 3,000
        levels = {lv: sum(p["difficulty_hint"] == lv for p in ps) for lv in ("easy", "medium", "hard")}
        self.assertTrue(all(n > 0.15 * len(ps) for n in levels.values()), levels)  # interleaving keeps every class

    def test_truth_is_a_about_half_the_time_and_always_the_larger_value(self):
        items = spread_pool(["river_length", "building_height", "first_flight"], 80)
        ps = pairs_of(items)
        share = sum(p["truth"] == 0 for p in ps) / len(ps)
        self.assertLess(abs(share - 0.5), 0.03, share)
        value = {it["id"]: it["answer"] for it in items}
        for p in ps:
            a, b = value[p["a_id"]], value[p["b_id"]]
            right = (a < b) if p["unit"] == "year" else (a > b)
            self.assertEqual(p["truth"], 0 if right else 1, p)

    def test_pair_records_and_reference_quality(self):
        items = [item(1, "river_length", 6650, name="the Nile"), item(2, "river_length", 2850, "imported", name="the Danube"),
                 item(3, "river_length", 1233, "none", name="the Rhine", fact_checked=True)]
        ps = {frozenset((p["a_id"], p["b_id"])): p for p in pairs_of(items)}
        p = ps[frozenset(("w0001", "w0002"))]
        self.assertEqual(set(p), {"id", "a_id", "b_id", "truth", "ratio", "prompt", "a", "b", "unit", "category", "difficulty_hint", "ref_quality", "fame"})
        self.assertEqual({p["a"], p["b"]}, {"the Nile", "the Danube"})
        self.assertEqual((p["prompt"], p["unit"], p["category"], p["ratio"], p["difficulty_hint"]), ("Which is longer?", "km", "river_length", 2.333, "medium"))
        self.assertEqual(p["ref_quality"], "imported")  # the weaker item
        self.assertEqual(ps[frozenset(("w0001", "w0003"))]["ref_quality"], "referenced")  # fact-checked counts as referenced
        self.assertRegex(p["id"], r"^p\d{5}$")

    def test_fame_is_the_lesser_items_views_and_bands_split_at_50000_and_20000(self):
        ps = pairs_of([item(1, "river_length", 6650, views=75236), item(2, "river_length", 2850, views=30516)])
        self.assertEqual(ps[0]["fame"], 30516)
        self.assertEqual([P.band(v) for v in (50000, 49999, 20000, 19999, 0)], [2, 1, 1, 0, 0])
        self.assertFalse(P.ranked_ok(ps[0]))  # referenced, but only "known"
        self.assertTrue(P.ranked_ok(dict(ps[0], fame=50000)))
        self.assertFalse(P.ranked_ok(dict(ps[0], fame=90000, ref_quality="imported")))  # famous, not referenced

    def test_ranked_ok_false_items_stay_out_of_ranked_days_and_retired_items_out_of_everything(self):
        nile, danube = item(1, "river_length", 6650), item(2, "river_length", 2850, ranked_ok=False, fact_checked=False)
        p = pairs_of([nile, danube])[0]
        self.assertEqual(p["ranked_ok"], False)
        self.assertFalse(P.ranked_ok(p))  # referenced and famous, but marked
        self.assertNotIn("ranked_ok", pairs_of([nile, item(2, "river_length", 2850)])[0])  # only written when false
        self.assertEqual(pairs_of([nile, item(2, "river_length", 2850, retired_at="2026-10-04")]), [])
        marked = spread_pool(Rounds.CATS, 120)
        for it in marked[::2]:
            it["ranked_ok"] = False
        ps = pairs_of(marked)
        days = P.extend_rounds(ps, {}, "2026-10-03", days=3)
        by = {q["id"]: q for q in ps}
        flagged = {it["id"] for it in marked[::2]}
        for e in days.values():
            for pid in P.day_pairs(e):
                self.assertFalse({by[pid]["a_id"], by[pid]["b_id"]} & flagged)

    def test_famous_items_spend_their_slots_on_famous_partners_first(self):
        famous = [item(n, "river_length", 100 * 2 ** n) for n in range(1, 5)]
        obscure = [item(n, "river_length", 100 * 2 ** n + 7, views=900) for n in range(5, 12)]
        cands = P.candidates(famous + obscure)
        chosen = P.select(cands, cap=3)
        famous_ids = {it["id"] for it in famous}
        for f in famous_ids:
            partners = [b if a == f else a for (a, b), *_ in chosen if f in (a, b)]
            self.assertEqual(len(partners), 3)
            self.assertTrue(all(x in famous_ids for x in partners), (f, partners))  # 3 famous partners exist for each
        self.assertEqual([P.tier(f, r) for f, r in ((60000, True), (60000, False), (30000, True), (900, True), (900, False))], [0, 1, 2, 3, 4])

    def test_countries_need_20000_views_to_be_compared(self):
        countries = [item(1, "country_population", 5e6, views=19999), item(2, "country_population", 9e6), item(3, "country_population", 4e7)]
        ids = {i for p in pairs_of(countries) for i in (p["a_id"], p["b_id"])}
        self.assertEqual(ids, {"w0002", "w0003"})

    def test_new_categories_have_their_questions_and_the_right_answer(self):
        prompts = {k: v[0] for k, v in P.TEMPLATES.items()}
        self.assertEqual(prompts[("company_founded", "year")], "Which company was founded first?")
        self.assertEqual(prompts[("product_released", "year")], "Which came out first?")
        self.assertEqual(prompts[("country_population", "people")], "Which country has more people?")
        self.assertEqual(prompts[("language_speakers", "people")], "Which language has more native speakers?")
        self.assertEqual(prompts[("landmark_height", "m")], "Which is taller?")
        self.assertEqual(prompts[("landmark_built", "year")], "Which is older?")
        walkman, iphone = item(1, "product_released", 1979, name="the Walkman"), item(2, "product_released", 2007, name="the iPhone")
        p = pairs_of([walkman, iphone])[0]
        self.assertEqual(([p["a"], p["b"]][p["truth"]], p["difficulty_hint"]), ("the Walkman", "medium"))  # earlier wins; 28 years
        self.assertEqual(pairs_of([item(3, "language_speakers", 379e6), item(4, "language_speakers", 485e6)]), [])  # 1.28: too close
        langs = pairs_of([item(3, "language_speakers", 485e6, name="Spanish"), item(4, "language_speakers", 64.8e6, name="Italian")])
        self.assertEqual([langs[0]["a"], langs[0]["b"]][langs[0]["truth"]], "Spanish")
        built = pairs_of([item(5, "landmark_built", -2560, name="the Great Pyramid"), item(6, "landmark_built", 1889, name="the Eiffel Tower")])
        self.assertEqual([built[0]["a"], built[0]["b"]][built[0]["truth"]], "the Great Pyramid")  # BCE years compare as numbers


class AiPack(unittest.TestCase):
    def ai(self, n, category, answer, views=100):
        unit = "parameters" if category == "ai_params" else "year"
        return item(n, category, answer, ref="none", unit=unit, views=views, fact_checked=True, famous=True)

    def test_ai_years_need_two_years_their_difficulty_scales_and_parameters_need_1_3(self):
        years = [self.ai(n, "ai_released", y) for n, y in enumerate((2012, 2013, 2014, 2016, 2022), start=1)]
        got = {abs(p["gap"]): p["difficulty_hint"] for p in pairs_of(years)}
        self.assertEqual(got, {2: "hard", 4: "medium", 6: "medium", 8: "medium", 3: "hard", 9: "medium", 10: "easy"})
        self.assertNotIn(1, got)  # 2012 / 2013: too close
        founded = pairs_of([self.ai(1, "ai_company_founded", 2015), self.ai(2, "ai_company_founded", 2021)])
        self.assertEqual(([founded[0]["a"], founded[0]["b"]][founded[0]["truth"]], founded[0]["prompt"]), ("thing 1", "Which came first?"))
        params = [self.ai(1, "ai_params", 1.0e9), self.ai(2, "ai_params", 1.29e9), self.ai(3, "ai_params", 1.3e9)]
        self.assertEqual({tuple(sorted((p["a_id"], p["b_id"]))) for p in pairs_of(params)}, {("w0001", "w0003")})
        self.assertEqual(pairs_of(params)[0]["prompt"], "Which model has more parameters?")
        self.assertEqual([P.difficulty(gap=g) for g in (50, 49, 20, 19, 10)], ["easy", "medium", "medium", "hard", "hard"])  # unchanged
        doc = P.build_pairs(years, generated_at="2026-10-04")[0]
        gaps = {(t["category"], t["unit"]): t["min_gap"] for t in doc["templates"]}
        self.assertEqual((gaps[("ai_released", "year")], gaps[("ai_company_founded", "year")], gaps[("ai_params", "parameters")],
                          gaps[("first_flight", "year")], gaps[("country_area", "km²")]), (2, 2, 1.3, 10, 1.3))

    def month(self, n, name, yyyymm, views=100, qid=None):
        it = self.ai(n, "ai_timeline", yyyymm, views=views)
        it.update(en={"prompt": "When?", "unit": "month"}, name=name)
        if qid:
            it["replaces"] = f"https://www.wikidata.org/wiki/{qid}#P585"
        return it

    def test_months_need_three_months_across_new_year_and_the_earlier_one_is_right(self):
        its = [self.month(1, "Stable Diffusion (released)", 202208), self.month(2, "ChatGPT (released)", 202211),
               self.month(3, "Claude (released)", 202303), self.month(4, "Anthropic (founded)", 202101),
               self.month(5, "GPT-4 (released)", 202303)]
        got = {frozenset((p["a"], p["b"])): (p["gap"], p["difficulty_hint"], [p["a"], p["b"]][p["truth"]]) for p in pairs_of(its)}
        self.assertEqual(got[frozenset(("Stable Diffusion (released)", "ChatGPT (released)"))], (3, "hard", "Stable Diffusion (released)"))
        self.assertEqual(got[frozenset(("ChatGPT (released)", "Claude (released)"))], (4, "hard", "ChatGPT (released)"))  # Nov to Mar
        self.assertEqual(got[frozenset(("Anthropic (founded)", "ChatGPT (released)"))], (22, "easy", "Anthropic (founded)"))
        self.assertEqual(got[frozenset(("Anthropic (founded)", "Stable Diffusion (released)"))][1], "easy")  # 19 months
        self.assertNotIn(frozenset(("Claude (released)", "GPT-4 (released)")), got)  # the same month
        self.assertEqual(P.month_index(202302) - P.month_index(202211), 3)

    def test_one_entity_is_never_compared_with_itself_and_must_pairs_survive_the_cap(self):
        dm = [self.month(1, "DeepMind (founded)", 201009, qid="Q15733006"), self.month(2, "DeepMind (bought by Google)", 201401, qid="Q15733006")]
        self.assertEqual(pairs_of(dm), [])
        crowd = [self.month(10 + k, f"event {k}", 199001 + 100 * k) for k in range(30)]  # each could take 25 slots
        must = [self.month(2, "ChatGPT (released)", 202211), self.month(3, "Anthropic (founded)", 202101)]
        names = {frozenset((p["a"], p["b"])) for p in pairs_of(crowd + must)}
        self.assertIn(frozenset(("Anthropic (founded)", "ChatGPT (released)")), names)

    def test_ranked_days_from_the_start_get_one_ai_timeline_pair_in_slot_one(self):
        base = spread_pool(Rounds.CATS, 120)
        ai = [self.month(900 + k, f"OpenAI event {k}" if k < 3 else f"event {k}", 201001 + 50 * k, views=80000, qid=f"Q9{k}") for k in range(16)]
        ai.append(self.month(950, "quiet event", 202605, views=1000, qid="Q950"))  # famous by mark only: never ranked
        items = {it["id"]: it for it in base + ai}
        pairs = pairs_of(base + ai)
        days = P.extend_rounds(pairs, {}, "2026-10-01", days=30)
        out = P.with_ai_slot(pairs, days, items, start="2026-10-05")
        by_id = {p["id"]: p for p in pairs}
        for d, e in out.items():
            cats = [by_id[x]["category"] for x in e["ranked"]]
            self.assertEqual(cats.count("ai_timeline"), int(d >= "2026-10-05"), d)
            if d >= "2026-10-05":
                self.assertEqual(cats[0], "ai_timeline")
                self.assertNotIn("w0950", (by_id[e["ranked"][0]]["a_id"], by_id[e["ranked"][0]]["b_id"]))
            else:
                self.assertEqual(e, days[d])
            levels = [by_id[x]["difficulty_hint"] for x in e["ranked"]]
            self.assertEqual((levels.count("easy"), levels.count("medium"), levels.count("hard"), len(levels)), (3, 4, 3, 10))
            ents = [i for x in e["ranked"] + [e["question"]] for i in (by_id[x]["a_id"], by_id[x]["b_id"])]
            self.assertEqual(len(set(ents)), 22)
        early = [by_id[out[d]["ranked"][0]] for d in sorted(out) if "2026-10-05" <= d < "2026-10-12"]
        self.assertTrue(all("OpenAI" in p["a"] + p["b"] for p in early[:2]))  # the first week prefers OpenAI pairs
        self.assertEqual(P.with_ai_slot(pairs, out, items, start="2026-10-05"), out)  # idempotent

    def test_money_and_tech_pairs_carry_the_higher_tier_volatile_money_is_paired_but_never_ranked(self):
        money = [dict(self.ai(1, "ai_money", 6.6e9), en={"prompt": "?", "unit": "USD"}, volatile=True, tier=2),
                 dict(self.ai(2, "ai_money", 157e9), en={"prompt": "?", "unit": "USD"}, volatile=True, tier=2)]
        p = pairs_of(money)[0]
        self.assertEqual((p["prompt"], p["tier"], p["volatile"], P.ranked_ok(p)), ("Which is bigger?", 2, True, False))
        tech = [dict(self.ai(3, "ai_tech", 8000), en={"prompt": "?", "unit": "tokens of context"}, tier=3, famous=False),
                dict(self.ai(4, "ai_tech", 200000), en={"prompt": "?", "unit": "tokens of context"}, tier=3, famous=False),
                dict(self.ai(5, "ai_tech", 80e9), en={"prompt": "?", "unit": "transistors"}, tier=3, famous=False)]
        got = pairs_of(tech)
        self.assertEqual([(q["prompt"], q["tier"], q["fame"]) for q in got], [("Which has the longer context window?", 3, 100)])  # units never mix
        generated = pairs_of([item(1, "river_length", 100, volatile=True), item(2, "river_length", 1000)])
        self.assertEqual(generated, [])  # outside the AI pack a volatile item is still left out
        t1 = self.month(10, "ChatGPT (released)", 202211, views=90000, qid="Q1")
        t2 = dict(self.month(11, "Amazon invests in Anthropic", 202309, views=90000, qid="Q2"), tier=2)
        t3 = dict(self.month(12, "a technical milestone", 202101, views=90000, qid="Q3"), tier=3)
        tiers = {frozenset((q["a"], q["b"])): q["tier"] for q in pairs_of([t1, t2, t3])}
        self.assertEqual(tiers[frozenset(("ChatGPT (released)", "Amazon invests in Anthropic"))], 2)
        items = {i["id"]: i for i in (t1, t2, t3)}
        ok = {frozenset((q["a"], q["b"])): P.ai_slot_ok(q, items) for q in pairs_of([t1, t2, t3])}
        self.assertTrue(ok[frozenset(("ChatGPT (released)", "Amazon invests in Anthropic"))])
        self.assertFalse(ok[frozenset(("ChatGPT (released)", "a technical milestone"))])  # tier 3 never fills the ranked slot

    def test_drama_needs_two_months_one_subject_never_meets_itself_and_unfamous_events_keep_their_views(self):
        def drama(n, name, yyyymm, qid, famous=True, views=100):
            it = self.month(n, name, yyyymm, views=views, qid=qid)
            it.update(category="ai_drama", tier=2, famous=famous)
            return it
        removed = drama(1, "OpenAI's board removes Sam Altman (Nov 2023)", 202311, "Q7407093")
        back = drama(2, "Sam Altman returns as OpenAI CEO (Nov 2023)", 202311, "Q7407093")
        nyt = drama(3, "The New York Times sues OpenAI and Microsoft (Dec 2023)", 202312, "Q9684")
        musk = drama(4, "Elon Musk sues OpenAI (Feb 2024)", 202402, "Q317521")
        recall = drama(5, "Microsoft delays its Recall feature (Jun 2024)", 202406, "Q131353867", famous=False, views=2738)
        got = {frozenset((p["a"], p["b"])): p for p in pairs_of([removed, back, nyt, musk, recall])}
        self.assertNotIn(frozenset((removed["name"], back["name"])), got)  # one subject, and the same month
        self.assertNotIn(frozenset((removed["name"], nyt["name"])), got)  # one month apart
        p = got[frozenset((nyt["name"], musk["name"]))]
        self.assertEqual((p["prompt"], p["gap"], p["tier"], p["difficulty_hint"]), ("Which came first?", 2, 2, "hard"))
        self.assertEqual(got[frozenset((removed["name"], musk["name"]))]["fame"], P.FAME_RANKED)  # famous subjects
        self.assertEqual(got[frozenset((musk["name"], recall["name"]))]["fame"], 2738)  # an unfamous event keeps its own views
        self.assertFalse(any(P.ranked_ok(q) for q in got.values()))

    def test_ai_items_count_as_famous_and_never_enter_ranked_days_or_the_question(self):
        ai = [self.ai(900 + k, "ai_released", 1960 + 3 * k) for k in range(20)]
        pairs = pairs_of(spread_pool(Rounds.CATS, 120) + ai)
        mine = [p for p in pairs if p["category"] == "ai_released"]
        self.assertTrue(mine and all(p["fame"] >= P.FAME_RANKED and p["ref_quality"] == "referenced" for p in mine))
        self.assertFalse(any(P.ranked_ok(p) for p in mine))
        days = P.extend_rounds(pairs, {}, "2026-10-03", days=20)
        used = {pid for e in days.values() for pid in P.day_pairs(e)}
        self.assertTrue(days and not used & {p["id"] for p in mine})


class PoliticsPack(unittest.TestCase):
    def pol(self, n, category, answer, unit, **extra):
        return item(n, category, answer, ref="none", unit=unit, views=100, fact_checked=True, famous=True, tier=1, **extra)

    def test_gaps_follow_the_ai_pack_counts_take_any_unit_and_nothing_is_ranked_or_takes_the_ai_slot(self):
        years = [self.pol(n, "pol_elected", y, "year") for n, y in enumerate((2008, 2009, 2010, 2020), start=1)]
        self.assertEqual(sorted(p["gap"] for p in pairs_of(years)), [2, 10, 11, 12])  # 2008/2009 and 2009/2010 too close
        months = [self.pol(10 + k, c, m, "month") for k, (c, m) in enumerate((("pol_timeline", 202001), ("pol_timeline", 202003),
                                                                              ("pol_timeline", 202004), ("pol_drama", 202001), ("pol_drama", 202003)))]
        self.assertEqual(sorted((p["category"], p["gap"]) for p in pairs_of(months)), [("pol_drama", 2), ("pol_timeline", 3)])
        counts = [self.pol(20, "pol_numbers", 100, "seats"), self.pol(21, "pol_numbers", 435, "seats"), self.pol(22, "pol_numbers", 300, "days")]
        got = pairs_of(counts)
        self.assertEqual([(p["unit"], p["prompt"], [p["a"], p["b"]][p["truth"]]) for p in got], [("seats", "Which is bigger?", "thing 21")])
        self.assertIsNone(P.template("pol_unknown", "seats"))
        everything = years + months + counts
        ranked = pairs_of(spread_pool(Rounds.CATS, 120) + everything)
        days = P.extend_rounds(ranked, {}, "2026-10-03", days=10)
        mine = {p["id"] for p in ranked if p["category"].startswith("pol_")}
        self.assertTrue(mine and days and not mine & {pid for e in days.values() for pid in P.day_pairs(e)})
        items = {it["id"]: it for it in everything}
        self.assertFalse(any(P.ai_slot_ok(p, items) for p in ranked if p["id"] in mine))


class Stability(unittest.TestCase):
    def test_ids_and_a_b_order_survive_a_rebuild_and_new_pairs_get_new_ids(self):
        items = spread_pool(["river_length"], 40)
        first = pairs_of(items)
        flipped = [dict(p, a_id=p["b_id"], b_id=p["a_id"], a=p["b"], b=p["a"], truth=1 - p["truth"]) for p in first[:5]]
        previous = flipped + first[5:]  # whatever order was stored is kept
        second = pairs_of(items + spread_pool(["bridge_length"], 30, start=500), previous=previous)
        old = {p["id"]: p for p in previous}
        for p in second:
            if p["id"] in old:
                self.assertEqual((p["a_id"], p["b_id"], p["truth"]), (old[p["id"]]["a_id"], old[p["id"]]["b_id"], old[p["id"]]["truth"]))
        self.assertTrue(set(old) <= {p["id"] for p in second})
        new = [p for p in second if p["id"] not in old]
        self.assertTrue(new and min(int(p["id"][1:]) for p in new) == max(int(i[1:]) for i in old) + 1)

    def test_pair_numbers_persist_the_same_inputs_plus_one_new_item_leave_every_old_number_unchanged(self):
        items = spread_pool(["river_length"], 12)  # well under the 25-pair cap: nothing is crowded out
        first = json.loads(P.format_pairs(P.build_pairs(items, generated_at="2026-10-03")[0]))  # through the file format
        key = lambda p: (p["a_id"], p["b_id"], p["category"], p["unit"])
        before = {key(p): p["id"] for p in first["pairs"]}
        doc = P.build_pairs(items + [item(100, "river_length", 1000)], first["pairs"], numbers=first, generated_at="2026-10-04")[0]
        after = {key(p): p["id"] for p in doc["pairs"]}
        self.assertEqual({k: after.get(k) for k in before}, before)  # same pair, same number, same a/b order
        new = sorted(int(i[1:]) for k, i in after.items() if k not in before)
        self.assertEqual(new, list(range(first["next_number"], first["next_number"] + 12)))  # the new item's 12 pairs
        self.assertEqual((doc["next_number"], doc["absent"]), (first["next_number"] + 12, []))

    def test_a_dropped_pair_keeps_its_number_it_is_never_reused_and_comes_back_with_it(self):
        base = spread_pool(["river_length"], 12)
        items = base + [item(100, "river_length", 1000)]
        build = lambda its, last, **kw: json.loads(P.format_pairs(P.build_pairs(its, last["pairs"], numbers=last, generated_at="2026-10-04", **kw)[0]))
        start = build(base, {"pairs": []})
        first = build(items, start)
        top = {p["id"]: p for p in first["pairs"] if "w0100" in (p["a_id"], p["b_id"])}
        self.assertEqual(sorted(top), [f"p{n:05d}" for n in range(start["next_number"], first["next_number"])])  # the 12 highest
        dropped = build(items, first, retired={"w0100"})
        self.assertEqual(sorted(f"p{r[0]:05d}" for r in dropped["absent"]), sorted(top))
        grown = build(items + [item(101, "river_length", 9000)], dropped, retired={"w0100"})
        new = [p for p in grown["pairs"] if "w0101" in (p["a_id"], p["b_id"])]
        self.assertTrue(new and min(int(p["id"][1:]) for p in new) == first["next_number"])  # not reused
        back = build(items + [item(101, "river_length", 9000)], grown)
        again = {p["id"]: p for p in back["pairs"] if "w0100" in (p["a_id"], p["b_id"]) and "w0101" not in (p["a_id"], p["b_id"])}
        self.assertEqual({i: (p["a_id"], p["b_id"], p["truth"]) for i, p in again.items()},
                         {i: (p["a_id"], p["b_id"], p["truth"]) for i, p in top.items()})
        self.assertEqual(back["absent"], [])
        fresh = P.build_pairs(items, [], numbers=first, generated_at="2026-10-05")[0]  # --fresh picks anew, keeps numbers
        self.assertEqual({p["id"]: (p["a_id"], p["b_id"]) for p in fresh["pairs"]}, {p["id"]: (p["a_id"], p["b_id"]) for p in first["pairs"]})

    def test_scheduled_pairs_are_carried_when_they_no_longer_qualify(self):
        items = [item(1, "river_length", 100), item(2, "river_length", 1000)]
        first = pairs_of(items)
        retired_now = pairs_of(items, previous=first, retired={"w0002"}, scheduled={first[0]["id"]})
        self.assertEqual([p["id"] for p in retired_now], [first[0]["id"]])
        self.assertEqual(pairs_of(items, previous=first, retired={"w0002"}), [])


class Rounds(unittest.TestCase):
    CATS = ["river_length", "mountain_elevation", "building_height", "bridge_length", "country_area", "first_flight"]

    @classmethod
    def setUpClass(cls):
        cls.items = spread_pool(cls.CATS, 120)
        cls.pairs = pairs_of(cls.items)
        cls.by_id = {p["id"]: p for p in cls.pairs}
        cls.rounds = P.extend_rounds(cls.pairs, {}, "2026-10-03", days=60)

    def test_ten_ranked_and_a_question_every_day_with_the_mix_and_category_limit(self):
        self.assertEqual(len(self.rounds), 61)
        self.assertEqual((min(self.rounds), max(self.rounds)), ("2026-10-03", "2026-12-02"))
        for date, e in self.rounds.items():
            ranked = [self.by_id[i] for i in e["ranked"]]
            self.assertEqual(len(ranked), 10, date)
            self.assertEqual(sorted(p["difficulty_hint"] for p in ranked), ["easy"] * 3 + ["hard"] * 3 + ["medium"] * 4, date)
            cats = [p["category"] for p in ranked]
            self.assertLessEqual(max(cats.count(c) for c in cats), 2, date)
            q = self.by_id[e["question"]]
            self.assertNotIn(q["id"], e["ranked"])
            self.assertEqual(q["difficulty_hint"], "medium")
            day_items = [i for p in ranked + [q] for i in (p["a_id"], p["b_id"])]
            self.assertEqual(len(set(day_items)), 22, date)

    def test_only_referenced_pairs_and_no_reuse_within_180_days_for_pairs_or_25_for_items(self):
        pair_dates, item_dates = {}, {}
        for date, e in self.rounds.items():
            for pid in P.day_pairs(e):
                p = self.by_id[pid]
                self.assertEqual(p["ref_quality"], "referenced")
                pair_dates.setdefault(pid, []).append(date)
                for i in (p["a_id"], p["b_id"]):
                    item_dates.setdefault(i, []).append(date)
        for dates in pair_dates.values():
            self.assertEqual(len(dates), 1)  # 61 days < 180
        for i, dates in item_dates.items():
            dates.sort()
            for a, b in zip(dates, dates[1:]):
                self.assertGreaterEqual(P.days_between(a, b), P.ITEM_NO_REUSE_DAYS, i)
        self.assertEqual(P.ITEM_NO_REUSE_DAYS, 25)

    def test_unreferenced_or_obscure_pairs_never_enter_and_short_supply_fills_fewer_days(self):
        self.assertEqual(P.extend_rounds(pairs_of(spread_pool(self.CATS, 120, ref="imported")), {}, "2026-10-03", days=5), {})
        self.assertEqual(P.extend_rounds(pairs_of(spread_pool(self.CATS, 120, views=49999)), {}, "2026-10-03", days=5), {})  # "known" only
        tiny = P.extend_rounds(pairs_of(spread_pool(self.CATS[:5], 30)), {}, "2026-10-03", days=60, ladder=[(25, 2)])
        self.assertTrue(0 < len(tiny) < 61, len(tiny))
        self.assertEqual(sorted(tiny), [P.add_days("2026-10-03", k) for k in range(len(tiny))])  # consecutive from today

    def test_a_day_the_strict_rules_cannot_fill_steps_down_the_ladder(self):
        small = pairs_of(spread_pool(self.CATS[:5], 30))
        strict = P.extend_rounds(small, {}, "2026-10-03", days=40, ladder=[(25, 2)])
        log = {}
        laddered = P.extend_rounds(small, {}, "2026-10-03", days=40, ladder=[(25, 2), (5, 4)], log=log)
        self.assertGreater(len(laddered), len(strict))
        first_relaxed = min(d for d, rung in log.items() if rung == [5, 4, None])
        self.assertTrue(all(log[d] == [25, 2, None] for d in log if d < first_relaxed))  # strict while it works
        self.assertEqual(first_relaxed, P.add_days("2026-10-03", len(strict)))
        self.assertEqual((P.RULE_LADDER[0], P.RULE_LADDER[4], P.RULE_LADDER[-1]), ((25, 2, 2), (25, 2, None), (5, 4, None)))

    def test_joint_country_cap_counts_both_country_categories_together(self):
        cats = ["country_area", "country_population", "river_length", "mountain_elevation", "building_height", "first_flight", "bridge_length"]
        ps = pairs_of(spread_pool(cats, 60))
        by = {p["id"]: p for p in ps}
        log = {}
        days = P.extend_rounds(ps, {}, "2026-10-03", days=6, ladder=[(5, 2, 2), (5, 2)], log=log)
        self.assertEqual(len(days), 7)
        for date, e in days.items():
            n = sum(by[i]["category"] in P.COUNTRY_CATEGORIES for i in e["ranked"])
            self.assertLessEqual(n, 2 if log[date][2] == 2 else 4, date)
        self.assertTrue(all(v == [5, 2, 2] for v in log.values()))  # enough other categories: the joint cap always holds

    def test_append_only_existing_days_are_kept_and_count_for_reuse(self):
        existing = {d: e for d, e in self.rounds.items() if d <= "2026-10-05"}
        again = P.extend_rounds(self.pairs, existing, "2026-10-04", days=10)
        for d, e in existing.items():
            self.assertEqual(again[d], e)
        self.assertEqual((min(again), max(again)), ("2026-10-03", "2026-10-14"))
        used = {i for d, e in existing.items() for i in P.day_pairs(e)}
        later = {i for d, e in again.items() if d > "2026-10-05" for i in P.day_pairs(e)}
        self.assertFalse(used & later)
        self.assertEqual(P.extend_rounds(self.pairs, {}, "2026-10-03", days=60), self.rounds)  # seeded by date

    def test_one_entity_at_most_once_a_day_and_well_known_items_first(self):
        twin = {it["id"]: f"Q{n // 2}" for n, it in enumerate(self.items)}  # every two items are about one entity
        redo = P.extend_rounds(self.pairs, {}, "2026-10-03", days=10, entity_of=twin)
        for date, e in redo.items():
            ents = [twin.get(i, i) for pid in P.day_pairs(e) for i in (self.by_id[pid]["a_id"], self.by_id[pid]["b_id"])]
            self.assertEqual(len(ents), len(set(ents)), date)
        self.assertEqual(P.entity({"id": "w1", "source": "https://www.wikidata.org/wiki/Q3392#P2043"}), "Q3392")
        self.assertEqual(P.entity({"id": "w2", "source": "https://x.org/a", "replaces": "https://www.wikidata.org/wiki/Q9#P1"}), "Q9")
        self.assertEqual(P.entity({"id": "w3", "source": "https://x.org/a"}), "w3")
        known = {it["id"]: (1000 if it["category"] == "river_length" else 10) for it in self.items}
        day = P.extend_rounds(self.pairs, {}, "2026-10-03", days=0, popularity=known)["2026-10-03"]
        cats = [self.by_id[pid]["category"] for pid in day["ranked"]]
        self.assertEqual(cats.count("river_length"), 2)  # the well-known category fills its 2 slots

    def test_retired_pairs_are_not_scheduled(self):
        some = set(self.rounds["2026-10-03"]["ranked"][:3])
        redo = P.extend_rounds(self.pairs, {}, "2026-10-03", days=5, retired_pairs=some)
        self.assertFalse(some & {i for e in redo.values() for i in P.day_pairs(e)})


class Files(unittest.TestCase):
    def test_formats_round_trip_and_main_writes_pairs_rounds_and_review(self):
        rounds = {"2026-10-03": {"ranked": [f"p{i:05d}" for i in range(1, 11)], "question": "p00011"}}
        text = P.format_rounds(rounds)
        self.assertEqual(json.loads(text), rounds)
        self.assertEqual(text.count("\n"), 3)  # one line per day
        with tempfile.TemporaryDirectory() as tmp:
            pool = os.path.join(tmp, "pool.json")
            with open(pool, "w") as f:  # 121 days x 22 items with a 25-day gap need more than 550 items
                json.dump({"version": 1, "items": spread_pool(Rounds.CATS + ["first_ascent", "university_founded"], 120)}, f)
            out, rnd = os.path.join(tmp, "pairs.json"), os.path.join(tmp, "rounds.json")
            args = ["--pool", pool, "--out", out, "--rounds", rnd, "--runtime", os.path.join(tmp, "none.json"),
                    "--pair-runtime", os.path.join(tmp, "none2.json"), "--today", "2026-10-03"]
            from contextlib import redirect_stderr
            import io
            with redirect_stderr(io.StringIO()):
                self.assertEqual(P.main(args), 0)
            with open(out) as f:
                doc = json.load(f)
            self.assertEqual({(t["category"], t["unit"]) for t in doc["templates"]}, set(P.TEMPLATES))
            self.assertGreater(len(doc["pairs"]), 5000)
            with open(rnd) as f:
                self.assertEqual(len(json.load(f)), 121)
            with open(os.path.join(tmp, "pairs.REVIEW.md")) as f:
                self.assertIn(f"**Total: {len(doc['pairs'])} pairs**", f.read())
            with redirect_stderr(io.StringIO()):
                self.assertEqual(P.main(args), 0)  # a re-run keeps every id and every day
            with open(out) as f:
                again = json.load(f)
            self.assertEqual(again["pairs"], doc["pairs"])
            self.assertEqual((again["next_number"], again["absent"]), (max(int(p["id"][1:]) for p in doc["pairs"]) + 1, []))


if __name__ == "__main__":
    unittest.main()
