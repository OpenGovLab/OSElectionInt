#!/usr/bin/env python3
"""
Quality checks on the stance classification. Read-only.

The party separation test is the one that matters. On Gun Policy the two
parties are known to differ sharply in the real world, so if the classifier
and the axis are working they must separate here too. If they do not, the
output is not measuring what it claims to and should not ship.

Usage: python3 scripts/verify_stance.py
"""

import json
import os
import statistics
import sys
from collections import Counter


def connect():
    from pymongo import MongoClient
    url = os.environ.get("MONGODB_URL")
    if not url:
        env = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
        for line in open(env):
            if line.startswith("MONGODB_URL="):
                url = line.split("=", 1)[1].strip()
                break
    return MongoClient(url).get_database()


def main():
    db = connect()
    cache = list(db.get_collection("us_stance_cache").find({}))
    print(f"cached classifications: {len(cache)}")
    if not cache:
        sys.exit("nothing cached yet")

    unclear = sum(1 for c in cache if c["value"] is None)
    print(f"  abstained (unclear): {unclear}  ({100 * unclear / len(cache):.1f}%)")
    print(f"  labels: {dict(Counter(c['label'] for c in cache))}")
    print(f"  confidence: {dict(Counter(c['confidence'] for c in cache))}")

    print("\n── per-category distribution ──")
    print(f"{'category':42s} {'n':>5} {'uncl':>5} {'mean':>7} {'|neg|':>6} "
          f"{'|pos|':>6} {'bimodal':>8}")
    by_cat = {}
    for c in cache:
        by_cat.setdefault(c["category"], []).append(c)
    for cat, rows in sorted(by_cat.items()):
        vals = [r["value"] for r in rows if r["value"] is not None]
        if not vals:
            continue
        unc = sum(1 for r in rows if r["value"] is None)
        neg = sum(1 for v in vals if v <= -0.25)
        pos = sum(1 for v in vals if v >= 0.25)
        mid = sum(1 for v in vals if -0.25 < v < 0.25)
        # Crude bimodality: are the poles fuller than the middle?
        bim = "yes" if (neg + pos) > 2 * max(mid, 1) else "no"
        print(f"{cat:42s} {len(vals):5d} {unc:5d} {statistics.mean(vals):7.3f} "
              f"{neg:6d} {pos:6d} {bim:>8}")

    print("\n── party separation (the sanity test) ──")
    col = db.get_collection("us_issue_positions")
    for cat in ["Gun Policy", "Climate Change and Environment",
                "Healthcare and Public Health", "Immigration"]:
        party = {}
        for d in col.find({f"category_stance.{cat}": {"$exists": True}},
                          {"party": 1, f"category_stance.{cat}": 1}):
            p = d.get("party")
            if p not in ("DEM", "REP"):
                continue
            party.setdefault(p, []).append(d["category_stance"][cat]["mean"])
        if len(party) < 2:
            print(f"  {cat}: insufficient data")
            continue
        dm, rm = statistics.mean(party["DEM"]), statistics.mean(party["REP"])
        pooled = statistics.pstdev(party["DEM"] + party["REP"]) or 1e-9
        d_stat = abs(dm - rm) / pooled
        ok = "SEPARATES" if abs(dm - rm) > 0.25 else "*** NO SEPARATION ***"
        print(f"  {cat:40s} DEM {dm:+.3f} (n={len(party['DEM'])})  "
              f"REP {rm:+.3f} (n={len(party['REP'])})  gap {abs(dm - rm):.3f}  "
              f"d={d_stat:.2f}  {ok}")

    print("\n── people with stance, and geo ──")
    print(f"  with any category_stance: "
          f"{col.count_documents({'category_stance': {'$exists': True, '$ne': {}}})}")
    print(f"  geo placeable:            {col.count_documents({'centroid': {'$exists': True}})}")
    conflicted = col.count_documents({"category_stance": {"$elemMatch": {}}})
    n_conf = 0
    for d in col.find({"category_stance": {"$exists": True}}, {"category_stance": 1}):
        n_conf += sum(1 for v in (d.get("category_stance") or {}).values()
                      if v.get("conflicted"))
    print(f"  conflicted person-categories: {n_conf}")


if __name__ == "__main__":
    main()
