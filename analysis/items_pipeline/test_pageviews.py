"""Offline tests for pageviews.py: the 3-month window, averaging, sitelink titles (redirects, missing articles), item
annotation and the cached CLI run, on a saved fixture (fixtures/pageviews_fixture.json: real answers of 2026-10-04,
trimmed). Never touches the network.

    python3 -m unittest discover -s analysis/items_pipeline        (also run by `npm test` in web/)
"""
import datetime
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pageviews as pv  # noqa: E402

with open(os.path.join(HERE, "fixtures", "pageviews_fixture.json")) as f:
    FIX = json.load(f)
WINDOW = ("2026070100", "2026093000")


class Pageviews(unittest.TestCase):
    def test_window_is_the_last_three_full_months(self):
        self.assertEqual(pv.last_full_months(datetime.date(2026, 10, 4)), WINDOW)
        self.assertEqual(pv.last_full_months(datetime.date(2026, 10, 1)), WINDOW)
        self.assertEqual(pv.last_full_months(datetime.date(2026, 1, 31)), ("2025100100", "2025123100"))
        self.assertEqual(tuple(FIX["window"]), WINDOW)

    def test_average_over_three_months_and_missing_months_count_as_zero(self):
        self.assertEqual(pv.average_views(FIX["pageviews"]["Nile"]), 75236)
        self.assertEqual(pv.average_views(FIX["pageviews"]["Io (moon)"]), 30516)
        self.assertEqual(pv.average_views({"items": [{"views": 300}]}), 100)
        self.assertEqual(pv.average_views(None), 0)  # 404: no such article or no data

    def test_titles_from_sitelinks_with_redirects_and_missing_articles(self):
        titles = pv.titles_from(FIX["wbgetentities"])
        self.assertEqual((titles["Q3392"], titles["Q3123"]), ("Nile", "Io (moon)"))
        synthetic = {"entities": {"Q9": {"id": "Q9", "sitelinks": {}}, "Q8": {"id": "Q8", "missing": ""},
                                  "Q70": {"id": "Q70", "redirects": {"from": "Q7", "to": "Q70"}, "sitelinks": {"enwiki": {"title": "Seven"}}}}}
        self.assertEqual(pv.titles_from(synthetic), {"Q9": None, "Q8": None, "Q7": "Seven"})

    def test_annotate_gives_zero_without_an_article_and_returns_new_items(self):
        items = [{"id": "w1", "source": "https://www.wikidata.org/wiki/Q3392#P2043"},
                 {"id": "w2", "source": "https://ilec.example/a", "replaces": "https://www.wikidata.org/wiki/Q3123#P2233"},
                 {"id": "w3", "source": "https://ilec.example/b"},
                 {"id": "w4", "source": "https://www.wikidata.org/wiki/Q9#P1"}]
        out = pv.annotate(items, {"Q3392": "Nile", "Q3123": "Io (moon)", "Q9": None}, {"Nile": 75236, "Io (moon)": 30516})
        self.assertEqual([(i["enwiki"], i["views_month"]) for i in out], [("Nile", 75236), ("Io (moon)", 30516), (None, 0), (None, 0)])
        self.assertNotIn("views_month", items[0])
        self.assertEqual(pv.views_url("AC/DC", *WINDOW).split("/user/")[1], "AC%2FDC/monthly/2026070100/2026093000")

    def test_fetchers_batch_ids_and_treat_404_as_zero(self):
        calls = []

        def get(url):
            calls.append(url)
            if "wbgetentities" in url:
                return FIX["wbgetentities"]
            return FIX["pageviews"]["Nile"] if "/Nile/" in url else None

        self.assertEqual(pv.fetch_titles(["Q3392", "Q3123", "Q3392"], get=get)["Q3123"], "Io (moon)")
        self.assertEqual(sum("wbgetentities" in c for c in calls), 1)  # one call for up to 50 ids
        self.assertEqual(pv.fetch_views(["Nile", "Nowhere"], *WINDOW, get=get), {"Nile": 75236, "Nowhere": 0})
        self.assertIn("ethan-rong/whos-bluffing", pv.USER_AGENT)

    def test_a_cache_fetches_only_what_it_lacks_and_keeps_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "titles.json")
            with open(path, "w") as f:
                json.dump({"Q1": "One"}, f)
            asked = []
            got = pv.cached(path, ["Q1", "Q2"], lambda missing: asked.append(missing) or {q: q.lower() for q in missing})
            self.assertEqual((got, asked), ({"Q1": "One", "Q2": "q2"}, [["Q2"]]))
            with open(path) as f:
                self.assertEqual(json.load(f), {"Q1": "One", "Q2": "q2"})
            self.assertEqual(pv.cached(path, ["Q1", "Q2"], lambda missing: 1 / 0), {"Q1": "One", "Q2": "q2"})  # nothing new

    def test_cached_run_writes_views_and_the_window_into_the_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            pool = os.path.join(tmp, "pool.json")
            with open(pool, "w") as f:
                json.dump({"version": 1, "items": [{"id": "w1", "source": "https://www.wikidata.org/wiki/Q3392#P2043"}]}, f)
            with open(os.path.join(tmp, "titles.json"), "w") as f:
                json.dump({"Q3392": "Nile"}, f)
            with open(os.path.join(tmp, f"views-{WINDOW[0]}-{WINDOW[1]}.json"), "w") as f:
                json.dump({"Nile": 75236}, f)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(pv.main(["--pool", pool, "--cache", tmp, "--today", "2026-10-04"]), 0)
            with open(pool) as f:
                doc = json.load(f)
            self.assertEqual(doc["views_window"], "20260701-20260930")
            self.assertEqual((doc["items"][0]["enwiki"], doc["items"][0]["views_month"]), ("Nile", 75236))
            self.assertEqual(pv.bands(doc["items"]), {">= 50,000": 1, "20,000-49,999": 0, "< 20,000": 0, "no article": 0})


if __name__ == "__main__":
    unittest.main()
