#!/usr/bin/env bash
# Repo-wide acceptance check. Exit non-zero on any failure.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"; fail=0
say(){ printf '\n== %s ==\n' "$*"; }

say "web: metrics vectors"
( cd "$root/web" && npm test --silent ) || fail=1

say "web: smoke (local wrangler + D1)"
if [ -f "$root/web/test/smoke.sh" ]; then ( cd "$root/web" && bash test/smoke.sh ) || fail=1; else echo "missing web/test/smoke.sh"; fail=1; fi

say "web: forbidden strings"
if grep -rniE "x-forwarded-for|user-agent|analytics|gtag|fonts\.googleapis|cdn\." "$root/web/public" "$root/web/functions" 2>/dev/null | grep -v "_items.json"; then echo "forbidden string found"; fail=1; else echo "clean"; fi


say "slack: tests"
( cd "$root/slack" && npm test --silent 2>&1 | grep -E "^# (tests|pass|fail)" ) || fail=1
( cd "$root/slack" && npm test --silent >/dev/null 2>&1 ) || { echo "slack tests failed"; fail=1; }

say "slack: dry-run deploy"
( cd "$root/slack" && npx wrangler deploy --dry-run --outdir dist >/dev/null 2>&1 && echo "dry-run ok" ) || { echo "dry-run failed"; fail=1; }

say "slack: no token/body logging"
if grep -rn "console.log(" "$root/slack/src" 2>/dev/null; then echo "console.log found"; fail=1; else echo "clean"; fi

say "discord: tests"
( cd "$root/discord" && npm test --silent 2>&1 | grep -E "^# (tests|pass|fail)" ) || fail=1
( cd "$root/discord" && npm test --silent >/dev/null 2>&1 ) || { echo "discord tests failed"; fail=1; }

say "discord: dry-run deploy"
( cd "$root/discord" && npx wrangler deploy --dry-run --outdir dist >/dev/null 2>&1 && echo "dry-run ok" ) || { echo "dry-run failed"; fail=1; }

say "discord: no token/body logging"
if grep -rn "console.log(" "$root/discord/src" 2>/dev/null; then echo "console.log found"; fail=1; else echo "clean"; fi

say "items: counts"
python3 - "$root/items/items.json" <<'PY' || fail=1
import json, sys, collections
p = sys.argv[1]
try:
    d = json.load(open(p))
except FileNotFoundError:
    print("items.json missing"); sys.exit(1)
items = d["items"]; by = collections.Counter(i["type"] for i in items)
print(dict(by)); print("domains", dict(collections.Counter(i["domain"] for i in items)))
print("difficulty", dict(collections.Counter(i.get("difficulty_hint") for i in items)))
missing_src = [i["id"] for i in items if not i.get("source")]
assert by["2afc"] == 40 and by["interval"] == 20 and by["attention"] == 2, by
assert not missing_src, missing_src
for i in items:
    assert i["en"]["prompt"] and i["zh"]["prompt"], i["id"]
print("items OK")
PY


say "daily schedule: live-file guard (5 ids/day, distinct categories, no reuse within 180 days)"
python3 - "$root" <<'PY' || fail=1
import json, sys, datetime as dt
root = sys.argv[1]
pool = json.load(open(f"{root}/items/pool.json")); items = pool["items"] if isinstance(pool, dict) else pool
cat = {i["id"]: i.get("category") for i in items}
sched = json.load(open(f"{root}/daily/schedule.json"))
last = {}; bad = []
for d in sorted(sched):
    ids = sched[d]
    if len(ids) != 5 or len(set(ids)) != 5: bad.append((d, "not 5 unique")); continue
    cats = [cat.get(i) for i in ids]
    if None in cats: bad.append((d, "unknown id")); continue
    if len(set(cats)) != 5: bad.append((d, "category repeated"))
    day = dt.date.fromisoformat(d)
    for i in ids:
        if i in last and (day - last[i]).days < 180: bad.append((d, f"{i} reused within 180d"))
        last[i] = day
print(len(sched), "days checked")
if bad: print("schedule problems:", bad[:10]); sys.exit(1)
print("schedule OK")
PY


say "daily rounds: live-file guard (10 ranked + 1 question, famous + referenced/fact-checked, 3/4/3 difficulty, ≤4 per category, 180d pair / 5d item reuse; no volatile item; from 2026-10-05 slot 1 = the day's one ai_timeline pair, tier 1-2, ≥ 3 months apart)"
python3 - "$root" <<'PY' || fail=1
import json, sys, datetime as dt, collections
root = sys.argv[1]
pool = json.load(open(f"{root}/items/pool.json")); items = pool["items"] if isinstance(pool, dict) else pool
item = {i["id"]: i for i in items}
pairs = json.load(open(f"{root}/items/pairs.json")); plist = pairs["pairs"] if isinstance(pairs, dict) else pairs
pair = {p["id"]: p for p in plist}
rounds = json.load(open(f"{root}/daily/rounds.json"))
FAME, CAT_MAX, ITEM_GAP, PAIR_GAP = 50000, 4, 5, 180
AI_SLOT, AI_FROM, AI_MONTHS = "ai_timeline", "2026-10-05", 3  # ranked slot 1 from AI_FROM; no other AI pair, ever
month = lambda i: item[i]["answer"] // 100 * 12 + item[i]["answer"] % 100 - 1
ok_item = lambda i: (item[i].get("ref_quality") == "referenced" or item[i].get("fact_checked")) and (item[i].get("views_month") or 0) >= FAME
entity = lambda i: item[i].get("replaces") or item[i].get("source")
last_pair, last_item, bad = {}, {}, []
for d in sorted(rounds):
    day = dt.date.fromisoformat(d); r = rounds[d]
    ranked, q = r.get("ranked", []), r.get("question")
    if len(ranked) != 10 or len(set(ranked)) != 10 or not q or q in ranked: bad.append((d, "shape")); continue
    ids = ranked + [q]
    if any(i not in pair for i in ids): bad.append((d, "unknown pair")); continue
    ents = []
    for pid in ids:
        a, b = pair[pid]["a_id"], pair[pid]["b_id"]
        if not (ok_item(a) and ok_item(b)): bad.append((d, f"{pid} not famous+referenced"))
        if item[a].get("volatile") or item[b].get("volatile"): bad.append((d, f"{pid} has a volatile item"))
        ents += [entity(a), entity(b)]
        for it in (a, b):
            if it in last_item and (day - last_item[it]).days < ITEM_GAP: bad.append((d, f"item {it} reused <{ITEM_GAP}d"))
            last_item[it] = day
        if pid in last_pair and (day - last_pair[pid]).days < PAIR_GAP: bad.append((d, f"pair {pid} reused <{PAIR_GAP}d"))
        last_pair[pid] = day
    if len(set(ents)) != 22: bad.append((d, "entities not distinct"))
    ai = [k for k, pid in enumerate(ids) if pair[pid]["category"].startswith("ai_")]
    if ai != ([0] if d >= AI_FROM else []) or (ai and pair[ranked[0]]["category"] != AI_SLOT): bad.append((d, f"AI pairs at {ai}"))
    if any(pair[pid]["category"].startswith("pol_") for pid in ids): bad.append((d, "politics pair"))  # never ranked, never the chat question
    elif ai and abs(month(pair[ranked[0]]["a_id"]) - month(pair[ranked[0]]["b_id"])) < AI_MONTHS: bad.append((d, "AI pair < 3 months apart"))
    elif ai and max(item[i].get("tier", 1) for i in (pair[ranked[0]]["a_id"], pair[ranked[0]]["b_id"])) > 2: bad.append((d, "AI pair above tier 2"))
    cats = collections.Counter(pair[pid]["category"] for pid in ranked)
    if max(cats.values()) > CAT_MAX: bad.append((d, f"category >{CAT_MAX}"))
    diff = collections.Counter(pair[pid]["difficulty_hint"] for pid in ranked)
    if (diff.get("easy"), diff.get("medium"), diff.get("hard")) != (3, 4, 3): bad.append((d, f"difficulty mix {dict(diff)}"))
print(len(rounds), "ranked days checked")
if bad: print("rounds problems:", bad[:8]); sys.exit(1)
print("rounds OK")
PY

say "dares: live-file guard (status in the enum, their_score only when played; every filled dare: 10 distinct pairs of its pack at its difficulty and mix, >= 5 naming a keyword, referenced or fact-checked, no volatile item or pair, no name twice, never p36637, a dated drama name or a ranked pair; unfilled dares are listed, not failed)"
packs=$(node --input-type=module -e "import('$root/web/public/packs.js').then((m) => process.stdout.write(JSON.stringify(m.PACKS)))") || fail=1
python3 - "$root" "$packs" <<'PY' || fail=1
import json, re, sys
root, packs = sys.argv[1], json.loads(sys.argv[2])
item = {i["id"]: i for i in json.load(open(f"{root}/items/pool.json"))["items"]}
pair = {p["id"]: p for p in json.load(open(f"{root}/items/pairs.json"))["pairs"]}
rounds = json.load(open(f"{root}/daily/rounds.json"))
dares = json.load(open(f"{root}/dares/dares.json"))
ranked = {pid for d in rounds.values() for pid in d["ranked"] + [d["question"]]}
MIX = {"easy": {"easy": 10}, "normal": {"easy": 3, "medium": 4, "hard": 3}, "brutal": {"medium": 4, "hard": 6}}
MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
DATED = re.compile(rf"\b(?:19|20)\d{{2}}\b|\b{MON}[a-z]*\.? \d|\b\d{{1,2}} {MON}")
band = lambda p: 2 if p.get("fame", 0) >= 50000 else 1 if p.get("fame", 0) >= 20000 else 0
ok_item = lambda i: (i.get("ref_quality") == "referenced" or i.get("fact_checked") is True) and not i.get("volatile") and not (i["category"].endswith("_drama") and DATED.search(i["name"]))
bad, unfilled = [], []
for d in dares:
    s = d.get("slug")
    if d.get("status") not in ("open", "played", "declined", "removed"): bad.append((s, "status")); continue
    if (d.get("their_score") is not None) != (d["status"] == "played"): bad.append((s, "their_score only and always when played"))
    if d["status"] == "removed": continue
    ids = d.get("items") or []
    if not ids: unfilled.append(s); continue
    if len(ids) != 10 or len(set(ids)) != 10 or any(i not in pair for i in ids): bad.append((s, "10 distinct known pairs")); continue
    pk, diff, kws = packs[d["pack"]], d["difficulty"], [k.lower() for k in d["keywords"]]
    names = [item[pair[i][k]]["name"].lower() for i in ids for k in ("a_id", "b_id")]
    if len(set(names)) != 20: bad.append((s, "an item twice"))
    if sum(any(k in n for n in names[2 * j:2 * j + 2] for k in kws) for j in range(10)) < 5: bad.append((s, "fewer than 5 keyword pairs"))
    levels = {}
    for i in ids:
        p = pair[i]; a, b = item[p["a_id"]], item[p["b_id"]]
        levels[p["difficulty_hint"]] = levels.get(p["difficulty_hint"], 0) + 1
        if pk["categories"] is not None and a["category"] not in pk["categories"]: bad.append((s, f"{i} outside the pack"))
        if pk.get("tiers") and p.get("tier", 0) not in pk["tiers"][diff]: bad.append((s, f"{i} tier"))
        if (diff == "easy" and band(p) < 2) or (diff == "normal" and band(p) < 1) or (diff == "brutal" and p.get("ref_quality") != "referenced"): bad.append((s, f"{i} not at {diff}"))
        if not (ok_item(a) and ok_item(b)) or p.get("volatile") or i == "p36637" or i in ranked: bad.append((s, f"{i} excluded"))
    if levels != MIX[diff]: bad.append((s, f"mix {levels}"))
    if diff == "normal" and sum(band(pair[i]) < 2 for i in ids) > 1: bad.append((s, "more than one pair under 50,000 views"))
print(len(dares), "dares checked;", len(dares) - len(unfilled), "filled or removed")
if unfilled: print("WARN not filled, left off the board (data gap):", ", ".join(unfilled))
if bad: print("dare problems:", bad[:8]); sys.exit(1)
print("dares OK")
PY

say "party balance (members of Congress: equal numbers per party in dares/dares.json and on the dare board)"
ROOT="$root" node --input-type=module -e '
const root = process.env.ROOT;
const { readFileSync } = await import("node:fs");
const dares = JSON.parse(readFileSync(`${root}/dares/dares.json`, "utf8"));
const board = new Set(JSON.parse(readFileSync(`${root}/web/functions/_dares.json`, "utf8")).map((d) => d.slug));
const side = (d) => d.caucus ?? d.party;
const members = dares.filter((d) => d.party && d.status !== "removed");
const count = (list) => ["democrat", "republican"].map((s) => list.filter((d) => side(d) === s).length);
const rows = [["dares/dares.json", count(members)], ["the dare board", count(members.filter((d) => board.has(d.slug)))]];
for (const [where, [dem, rep]] of rows) console.log(`${where}: ${dem} who caucus with the Democrats, ${rep} Republicans`);
const bad = rows.filter(([, [dem, rep]]) => dem !== rep).map(([where]) => where);
if (bad.length) { console.log(`party balance broken: ${bad.join(", ")}`); process.exit(1); }
console.log("party balance OK");
' || fail=1

say "result"; [ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
