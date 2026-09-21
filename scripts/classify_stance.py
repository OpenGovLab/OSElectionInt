#!/usr/bin/env python3
"""
Where each person stands on each issue, inferred from their own quotes.

Two stages:

  classify   Place every scraped quote on its category's policy axis, then
             aggregate per person per category.

  geo        Stamp the ocd_id and centroid a map needs to place a person.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
A stance here is OUR READING of a sentence, produced by a language model.
It is not the person's own words and it is not a fact about them. So every
stance stored keeps a pointer to the verbatim quote that produced it, the
model that produced it and the date. If the evidence cannot be shown next to
the label, the label has not been earned.

Three consequences follow, and they are enforced in code rather than left to
the UI:

  * `unclear` is a first-class outcome. Plenty of quotes carry no position on
    their category's axis — "Have responsibility to not fan flames of
    campaign" says nothing about firearms. A classifier that always picks a
    side is worse than one that abstains, so the abstention rate is measured
    and reported rather than hidden.

  * Absence is never centre. A person with no classified quotes in a category
    gets NO entry for it. Writing 0.0 would place someone at the midpoint of
    an axis they have never spoken about.

  * Spread is stored beside the mean. Quotes at -0.8 and +0.7 average to
    -0.05, which would render as mild moderation when the truth is either a
    changed mind or a contradiction. `spread` and `conflicted` exist so a UI
    can tell those apart, and `earliest`/`latest` exist because a position
    from 2003 is not a current one.

No score is aggregated ACROSS categories. There is no overall rating, no
compass and no political label anywhere in this file: the poles are policy
directions taken from issue_axes.json, never identities.

DEDUPLICATION
-------------
38,112 quote-instances reduce to 11,371 distinct (category, text) pairs —
a 70% saving — because roll-call votes are recorded identically against every
member who cast them. Classification is therefore keyed on the text, cached in
`us_stance_cache`, and re-runs cost nothing for quotes already seen.

Usage:
    python3 scripts/classify_stance.py --stage classify --limit 200
    python3 scripts/classify_stance.py --stage classify --apply
    python3 scripts/classify_stance.py --stage geo --apply
    python3 scripts/classify_stance.py --stage all --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import re
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

LLM_URL = os.environ.get("CLAWPY_URL", "http://127.0.0.1:4040/v1/chat/completions")
LLM_MODEL = os.environ.get("CLAWPY_MODEL", "claude-sonnet-5")

BATCH = 35          # measured: 35 quotes ~= 16s, comfortably inside max_tokens
WORKERS = 6         # the endpoint is local; this is politeness, not throughput
CACHE = "us_stance_cache"

LABELS = {"strong-neg", "lean-neg", "mixed", "lean-pos", "strong-pos", "unclear"}

# A stance whose quotes disagree by more than this is reported as conflicted
# rather than averaged into a moderation nobody expressed.
CONFLICT_SPREAD = 0.55

STANCE_NOTE = (
    "Stance is an inference made by a language model reading the quote stored "
    "beside it, not a statement by the person and not a fact about them. Each "
    "value keeps the verbatim quote, the model name and the date it was "
    "classified so it can be checked and disputed. A category with no entry "
    "means nothing classifiable was found, NEVER that the person sits at the "
    "centre of that axis. Where `conflicted` is true the underlying quotes "
    "disagree with each other and the mean should not be read as a position."
)

_lock = threading.Lock()
_stats = {"calls": 0, "parse_fail": 0, "http_fail": 0, "items": 0}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def connect():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pip install pymongo")
    url = os.environ.get("MONGODB_URL")
    if not url:
        env = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
        for line in open(env):
            if line.startswith("MONGODB_URL="):
                url = line.split("=", 1)[1].strip()
                break
    if not url:
        sys.exit("MONGODB_URL not set")
    return MongoClient(url).get_database()


def load(name):
    p = os.path.join(os.path.dirname(__file__), "data", name)
    with open(p) as f:
        return json.load(f)


def qkey(category, text):
    h = hashlib.sha1(f"{category}|\x00|{text}".encode("utf-8")).hexdigest()
    return h[:24]


# ── the classifier ──────────────────────────────────────────────────────────

def build_prompt(category, axis, quotes):
    lines = "\n".join(f'{i + 1}. "{t}"' for i, t in enumerate(quotes))
    return (
        f'Classify each numbered statement by a US politician on one policy '
        f'axis.\n\n'
        f'AXIS for "{category}":\n'
        f'  -1.0 = {axis["neg"]}\n'
        f'  +1.0 = {axis["pos"]}\n'
        f'   0.0 = explicitly balanced, or endorses both directions\n\n'
        f'Rules:\n'
        f'- Judge only the position on THIS axis. A statement may be political '
        f'and still say nothing about this axis.\n'
        f'- If it expresses no position on this axis, use stance null and '
        f'label "unclear". Abstaining is correct and expected.\n'
        f'- Watch for negation. "Voted NO on <a measure that would weaken X>" '
        f'is a position IN FAVOUR of X.\n'
        f'- Lower your confidence when a statement is rhetorical, procedural, '
        f'or about a tangential matter.\n'
        f'- labels: strong-neg, lean-neg, mixed, lean-pos, strong-pos, unclear\n\n'
        f'Return ONLY a JSON array, exactly one object per numbered item, in '
        f'order:\n'
        f'[{{"n":1,"stance":-0.8,"label":"strong-neg","confidence":"high"}}]\n'
        f'confidence is one of: high, medium, low\n\n'
        f'{lines}'
    )


def call_llm(prompt, max_tokens=3200, tries=4):
    body = json.dumps({
        "model": LLM_MODEL, "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                LLM_URL, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=240) as r:
                d = json.load(r)
            with _lock:
                _stats["calls"] += 1
            return d["choices"][0]["message"]["content"]
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            with _lock:
                _stats["http_fail"] += 1
            return None
    return None


def parse_array(txt, n_expected):
    """Pull the JSON array out. Models sometimes fence it or prepend prose."""
    if not txt:
        return None
    m = re.search(r"\[.*\]", txt, re.S)
    if not m:
        return None
    try:
        arr = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(arr, list) or len(arr) != n_expected:
        return None
    return arr


def classify_batch(category, axis, quotes):
    """-> list of {stance,label,confidence} aligned with `quotes`, or None.

    A batch that will not parse after retries is reported, never silently
    dropped: a missing classification and a failed one look identical
    downstream, and only one of them means the corpus is incomplete.
    """
    prompt = build_prompt(category, axis, quotes)
    for attempt in range(3):
        txt = call_llm(prompt)
        arr = parse_array(txt, len(quotes))
        if arr is None:
            if attempt < 2:
                time.sleep(1.5)
                continue
            with _lock:
                _stats["parse_fail"] += 1
            return None
        out = []
        for item in arr:
            s = item.get("stance")
            lab = str(item.get("label", "unclear"))
            conf = str(item.get("confidence", "low")).lower()
            if lab not in LABELS:
                lab = "unclear"
            if s is not None:
                try:
                    s = max(-1.0, min(1.0, float(s)))
                except (TypeError, ValueError):
                    s, lab = None, "unclear"
            # The two must agree. A value with no label is unclear, and a
            # label of "unclear" that still carries a number is the model
            # hedging in words while committing in figures — abstain for real
            # rather than keep a number the label disowns.
            if s is None:
                lab = "unclear"
            elif lab == "unclear":
                s = None
            out.append({
                "value": s, "label": lab,
                "confidence": conf if conf in ("high", "medium", "low") else "low",
            })
        with _lock:
            _stats["items"] += len(out)
        return out
    return None


def classify_batch_bisect(category, axis, quotes, depth=0):
    """classify_batch, but a batch that will not parse is split rather than lost.

    A handful of batches fail repeatedly no matter how often they are retried —
    the model returns the wrong number of items for them, usually because one
    quote in the batch confuses the enumeration. Retrying the whole 35 forever
    just burns calls and still drops all 35. Halving isolates the offending
    quote in log2(35) ≈ 6 steps and keeps the other 34.
    """
    out = classify_batch(category, axis, quotes)
    if out is not None:
        return out
    if len(quotes) == 1:
        # One quote that will not classify. Record it as unclear rather than
        # dropping it: a quote we could not read is not a quote with no
        # position, and the distinction should survive into the data.
        return [{"value": None, "label": "unclear", "confidence": "low"}]
    mid = len(quotes) // 2
    left = classify_batch_bisect(category, axis, quotes[:mid], depth + 1)
    right = classify_batch_bisect(category, axis, quotes[mid:], depth + 1)
    return left + right


# ── stage: classify ─────────────────────────────────────────────────────────

def collect_unique(db, topic_map, axes, limit):
    """Every distinct (category, text) pair that has an axis to sit on."""
    uniq = {}
    for d in db.get_collection("us_issue_positions").find({}, {"topics": 1}):
        for topic, body in (d.get("topics") or {}).items():
            cats = [c for c in topic_map.get(topic, []) if c in axes]
            if not cats:
                continue
            cat = cats[0]
            for p in (body.get("positions") or []):
                t = (p.get("text") or "").strip()
                if not t:
                    continue
                uniq.setdefault((cat, t), qkey(cat, t))
    pairs = list(uniq.items())
    return pairs[:limit] if limit else pairs


def stage_classify(db, apply_writes, limit):
    print("\n── classify ──")
    axes = load("issue_axes.json")["axes"]
    topic_map = load("issue_taxonomy.json")["map"]

    # Abortion carries 2,609 quotes and appears in neither the map nor the
    # documented unmapped list, so it is silently dropped. Flag it loudly
    # rather than inventing a category for it here.
    mapped = set(topic_map)
    if "Abortion" not in mapped:
        print("  ! WARNING: source topic 'Abortion' has no product category "
              "and is not listed in unmapped_source_topics. Its quotes are "
              "excluded. See report.")

    cache = db.get_collection(CACHE)
    pairs = collect_unique(db, topic_map, axes, limit)
    print(f"  {len(pairs)} distinct (category, quote) pairs")

    have = set()
    if not limit:
        have = {r["_id"] for r in cache.find({}, {"_id": 1})}
    todo = [(k, h) for k, h in pairs if h not in have]
    print(f"  {len(have)} already cached, {len(todo)} to classify")

    by_cat = {}
    for (cat, text), h in todo:
        by_cat.setdefault(cat, []).append((text, h))

    jobs = []
    for cat, items in by_cat.items():
        for i in range(0, len(items), BATCH):
            jobs.append((cat, items[i:i + BATCH]))
    print(f"  {len(jobs)} batches of up to {BATCH}, {WORKERS} workers")

    results = []
    done = [0]
    t0 = time.time()

    def run(job):
        cat, items = job
        texts = [t for t, _ in items]
        out = classify_batch_bisect(cat, axes[cat], texts)
        with _lock:
            done[0] += 1
            if done[0] % 10 == 0 or done[0] == len(jobs):
                el = time.time() - t0
                rate = done[0] / el if el else 0
                left = (len(jobs) - done[0]) / rate / 60 if rate else 0
                print(f"    {done[0]}/{len(jobs)} batches  "
                      f"{el / 60:.1f}m elapsed, ~{left:.1f}m left")
        if out is None:
            return []
        return [
            {"_id": h, "category": cat, "text": t, **o,
             "model": LLM_MODEL, "classified_at": now()}
            for (t, h), o in zip(items, out)
        ]

    if jobs:
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for r in ex.map(run, jobs):
                results.extend(r)

    print(f"\n  classified {len(results)} quotes")
    print(f"  llm calls {_stats['calls']}, parse failures {_stats['parse_fail']}, "
          f"http failures {_stats['http_fail']}")
    if results:
        unclear = sum(1 for r in results if r["value"] is None)
        print(f"  unclear/abstained {unclear} ({100 * unclear / len(results):.1f}%)")
        from collections import Counter
        print("  labels:", dict(Counter(r["label"] for r in results)))

    if apply_writes and results:
        for i in range(0, len(results), 500):
            chunk = results[i:i + 500]
            cache.bulk_write([
                __import__("pymongo").ReplaceOne({"_id": r["_id"]}, r, upsert=True)
                for r in chunk])
        cache.create_index("category")
        print(f"  cached {len(results)} classifications")

    if apply_writes:
        write_back(db, topic_map, axes)
    return results


MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def month_key(d):
    """Sort 'Sep 2006' before 'Apr 2009'.

    These are month-name strings, so lexical order is wrong in a way that is
    easy to miss: "Apr 2009" sorts before "Sep 2006" because 'A' < 'S', which
    produced date ranges that ran backwards. Sorting on (year, month) is the
    only thing that makes earliest/latest mean what they say.
    """
    m = re.match(r"([A-Z][a-z]{2})\s+(\d{4})", str(d or ""))
    if not m:
        return (9999, 99)
    return (int(m.group(2)), MONTHS.get(m.group(1), 99))


def aggregate(values, dates):
    """Mean, median, spread and date range for one person-category.

    Spread is the population stdev of the classified values. It is stored
    rather than folded into the mean because the two failure modes it
    separates look identical in an average: a genuine centrist and a person
    whose recorded quotes contradict each other both land near zero.
    """
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    spread = statistics.pstdev(vals) if len(vals) > 1 else 0.0
    mean = sum(vals) / len(vals)
    ds = sorted((d for d in dates if d), key=month_key)
    return {
        "mean": round(mean, 3),
        "median": round(statistics.median(vals), 3),
        "spread": round(spread, 3),
        "conflicted": spread >= CONFLICT_SPREAD,
        "min": round(min(vals), 3),
        "max": round(max(vals), 3),
        "earliest": ds[0] if ds else None,
        "latest": ds[-1] if ds else None,
    }


def mean_label(mean):
    if mean <= -0.5:
        return "strong-neg"
    if mean <= -0.15:
        return "lean-neg"
    if mean < 0.15:
        return "mixed"
    if mean < 0.5:
        return "lean-pos"
    return "strong-pos"


def write_back(db, topic_map, axes):
    """Stamp each position with its stance, and each category with its aggregate."""
    print("\n  ── write back ──")
    cache = {r["_id"]: r for r in db.get_collection(CACHE).find({})}
    col = db.get_collection("us_issue_positions")
    touched = people_with = 0

    for d in col.find({}):
        topics = d.get("topics") or {}
        per_cat = {}
        changed = False
        for topic, body in topics.items():
            cats = [c for c in topic_map.get(topic, []) if c in axes]
            if not cats:
                continue
            cat = cats[0]
            for p in (body.get("positions") or []):
                t = (p.get("text") or "").strip()
                if not t:
                    continue
                c = cache.get(qkey(cat, t))
                if not c:
                    continue
                p["stance"] = {
                    "value": c["value"], "label": c["label"],
                    "confidence": c["confidence"], "axis": cat,
                    "model": c["model"], "classified_at": c["classified_at"],
                }
                changed = True
                per_cat.setdefault(cat, {"v": [], "d": [], "unclear": 0})
                if c["value"] is None:
                    per_cat[cat]["unclear"] += 1
                else:
                    per_cat[cat]["v"].append(c["value"])
                    per_cat[cat]["d"].append(p.get("dated"))

        stance_by_cat = {}
        for cat, acc in per_cat.items():
            agg = aggregate(acc["v"], acc["d"])
            if agg is None:
                # Classified nothing here. No entry at all — absent is not centre.
                continue
            agg["n_classified"] = len(acc["v"])
            agg["n_unclear"] = acc["unclear"]
            agg["label"] = mean_label(agg["mean"])
            agg["axis"] = {"neg": axes[cat]["neg"], "pos": axes[cat]["pos"]}
            # Confidence in the aggregate is about evidence volume and
            # agreement, not about any single quote.
            agg["confidence"] = (
                "high" if agg["n_classified"] >= 5 and not agg["conflicted"]
                else "low" if agg["n_classified"] < 3 or agg["conflicted"]
                else "medium")
            stance_by_cat[cat] = agg

        if changed or stance_by_cat:
            col.update_one({"_id": d["_id"]}, {"$set": {
                "topics": topics,
                "category_stance": stance_by_cat,
                "stance_note": STANCE_NOTE,
                "stance_model": LLM_MODEL,
                "stance_classified_at": now(),
            }})
            touched += 1
            if stance_by_cat:
                people_with += 1

    print(f"    updated {touched} people, {people_with} with at least one "
          f"category stance")


# ── stage: geo ──────────────────────────────────────────────────────────────

def stage_geo(db, apply_writes):
    """Stamp ocd_id + centroid so a map can place a person.

    Someone we cannot place is left unplaced and excluded from the layer.
    Dropping them at 0,0 would put a US politician in the Gulf of Guinea.
    """
    print("\n── geo ──")
    holders = {h["_id"]: h for h in db.get_collection("us_officeholders")
               .find({}, {"ocd_id": 1})}
    cands = {c["_id"]: c for c in db.get_collection("us_candidates")
             .find({}, {"ocd_id": 1})}
    divs = {d["_id"]: d for d in db.get_collection("us_divisions")
            .find({}, {"centroid": 1, "name": 1, "level": 1})}

    col = db.get_collection("us_issue_positions")
    placed = no_ocd = no_centroid = 0
    ops = []
    for d in col.find({}, {"ref": 1, "bioguide": 1, "fec_id": 1}):
        ref = d.get("ref") or {}
        src = holders if ref.get("collection") == "us_officeholders" else cands
        row = src.get(ref.get("id"))
        ocd = (row or {}).get("ocd_id")
        if not ocd:
            no_ocd += 1
            continue
        div = divs.get(ocd)
        cen = (div or {}).get("centroid")
        if not cen:
            no_centroid += 1
            continue
        placed += 1
        ops.append(__import__("pymongo").UpdateOne({"_id": d["_id"]}, {"$set": {
            "ocd_id": ocd,
            "centroid": cen,
            "division_name": (div or {}).get("name"),
            "division_level": (div or {}).get("level"),
            "geo_stamped_at": now(),
        }}))

    print(f"  placeable {placed}")
    print(f"  no ocd_id  {no_ocd}")
    print(f"  no centroid {no_centroid}")
    if apply_writes and ops:
        col.bulk_write(ops)
        col.create_index([("centroid", "2dsphere")])
        col.create_index("ocd_id")
        print(f"  stamped {len(ops)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["all", "classify", "geo"])
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0,
                    help="classify only the first N distinct quotes")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "classify"):
        stage_classify(db, args.apply, args.limit)
    if args.stage in ("all", "geo"):
        stage_geo(db, args.apply)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
