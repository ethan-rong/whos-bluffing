#!/usr/bin/env python3
"""The familiarity signal: English Wikipedia pageviews for every item of items/pool.json. Each item gets `enwiki` (the
article title from its Wikidata sitelink, or null) and `views_month` (average monthly pageviews by users, over the last 3
full calendar months; 0 without an article or without data). Pairs are gated on these numbers (pairs.py).

    python3 analysis/items_pipeline/pageviews.py                    # live: Wikidata sitelinks + Wikimedia pageviews API
    python3 analysis/items_pipeline/pageviews.py --cache DIR        # also keep the raw answers in DIR (reused; only new
                                                                    # items are fetched)
    python3 analysis/items_pipeline/pageviews.py --today 2026-10-04 # which 3 months: the full months before this date

Python 3.9+, standard library only. Polite: a descriptive User-Agent, at most WORKERS requests in flight (Wikimedia's
REST limit is 100 per second), retries with back-off on 429 and 5xx. If either service is unreachable the pool is left
alone. The item's Wikidata entity is its `replaces` URL (hand-corrected items) or its source; others get 0.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
USER_AGENT = "WhosBluffingItemPipeline/1.0 (https://github.com/ethan-rong/whos-bluffing; familiarity of quiz items by pageviews)"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
PAGEVIEWS = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{title}/monthly/{start}/{end}"
MONTHS = 3
BATCH = 50  # ids per wbgetentities call
WORKERS = 8
QID = re.compile(r"/(Q\d+)#")


def qid_of(item):
    """The Wikidata id an item is about, or None (a hand-corrected item names it in `replaces`)."""
    m = QID.search(item.get("replaces") or item.get("source", ""))
    return m.group(1) if m else None


def last_full_months(today, n=MONTHS):
    """(start, end) timestamps of the n full calendar months before `today` (a date), as the API wants them."""
    first = today.replace(day=1)
    end = first - datetime.timedelta(days=1)  # last day of the previous month
    start = end.replace(day=1)
    for _ in range(n - 1):
        start = (start - datetime.timedelta(days=1)).replace(day=1)
    return start.strftime("%Y%m%d00"), end.strftime("%Y%m%d00")


def average_views(response, n=MONTHS):
    """Average monthly views from a per-article monthly response (months without a row count as 0)."""
    views = [row.get("views", 0) for row in (response or {}).get("items", [])]
    return int(round(sum(views) / n))


def titles_from(response):
    """{qid: enwiki title or None} from a wbgetentities response (props=sitelinks, sitefilter=enwiki). A redirected
    (merged) id is reported under the id that was asked for."""
    out = {}
    for key, entity in response.get("entities", {}).items():
        asked = entity.get("redirects", {}).get("from", key)
        out[asked] = entity.get("sitelinks", {}).get("enwiki", {}).get("title") if "missing" not in entity else None
    return out


def get_json(url, retries=4):
    """GET a JSON document; None on 404 (no such article or no data)."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 0) or 2 * (attempt + 1))
        except urllib.error.URLError:
            if attempt == retries:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_titles(qids, get=get_json):
    out = {}
    qids = sorted(set(qids))
    for i in range(0, len(qids), BATCH):
        query = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(qids[i:i + BATCH]), "props": "sitelinks",
                                        "sitefilter": "enwiki", "format": "json"})
        out.update(titles_from(get(f"{WIKIDATA_API}?{query}")))
    return out


def views_url(title, start, end):
    return PAGEVIEWS.format(title=urllib.parse.quote(title.replace(" ", "_"), safe=""), start=start, end=end)


def fetch_views(titles, start, end, get=get_json):
    """{title: average monthly views}, WORKERS at a time."""
    def one(title):
        return title, average_views(get(views_url(title, start, end)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return dict(pool.map(one, sorted(set(titles))))


def annotate(items, titles, views):
    """New items with `enwiki` and `views_month` set from {qid: title} and {title: views}."""
    out = []
    for it in items:
        title = titles.get(qid_of(it)) if qid_of(it) else None
        out.append(dict(it, enwiki=title, views_month=views.get(title, 0) if title else 0))
    return out


def cached(path, keys, fetch):
    """{key: value} for keys: from the JSON file at path when there is one (and a path is given); the keys it lacks
    (new items) are fetched with fetch(missing) and the file is updated, so a rerun asks only for what is new."""
    have = {}
    if path and os.path.exists(path):
        with open(path) as f:
            have = json.load(f)
    missing = sorted(set(keys) - set(have))
    if missing:
        have.update(fetch(missing))
        if path:
            with open(path, "w") as f:
                json.dump(have, f, ensure_ascii=False)
    return have


def bands(items):
    count = lambda lo, hi: sum(lo <= it.get("views_month", 0) < hi for it in items)
    return {">= 50,000": count(50000, float("inf")), "20,000-49,999": count(20000, 50000), "< 20,000": count(0, 20000),
            "no article": sum(1 for it in items if not it.get("enwiki"))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool", default=os.path.join(ROOT, "items", "pool.json"))
    ap.add_argument("--cache", help="directory for the raw answers (titles.json, views-<start>-<end>.json), reused when present")
    ap.add_argument("--today", default=datetime.datetime.utcnow().date().isoformat())
    args = ap.parse_args(argv)
    with open(args.pool) as f:
        pool = json.load(f)
    start, end = last_full_months(datetime.date.fromisoformat(args.today))
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)
    path = lambda name: args.cache and os.path.join(args.cache, name)
    qids = [q for q in map(qid_of, pool["items"]) if q]
    try:
        titles = cached(path("titles.json"), qids, fetch_titles)
        views = cached(path(f"views-{start}-{end}.json"), [titles[q] for q in qids if titles.get(q)],
                       lambda missing: fetch_views(missing, start, end))
    except (urllib.error.URLError, OSError) as e:
        print(f"error: Wikidata or the pageviews API is unreachable ({e}). The pool was not changed.", file=sys.stderr)
        return 2
    pool = dict(pool, views_window=f"{start[:8]}-{end[:8]}", items=annotate(pool["items"], titles, views))
    with open(args.pool, "w") as f:
        json.dump(pool, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(json.dumps({"items": len(pool["items"]), "window": pool["views_window"], "bands": bands(pool["items"])}, indent=1), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
