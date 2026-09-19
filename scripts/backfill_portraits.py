#!/usr/bin/env python3
"""
Backfill candidate portraits from Wikidata.

Only 671 of 4,294 filers for 2026 carry a photo, because the only free
portrait source wired up is the Congressional bioguide — which by definition
covers people who already hold federal office. Every challenger who has never
served is therefore faceless, which is precisely backwards for a dashboard
whose point is the people trying to take a seat.

Wikidata fills that gap, but carelessly: a name search alone will happily
return a cricketer, and a wrong face on a politician is materially worse than
no face at all. So a hit is only accepted when the entity independently looks
like a US politician — by occupation, by having held a position, or by party
membership — and ambiguous names with several plausible matches are skipped
rather than guessed.

Usage:
    python3 scripts/backfill_portraits.py --cycle 2026 --limit 400 [--apply]

Dry run by default. Nothing is written without --apply.
"""

import argparse
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://www.wikidata.org/w/api.php"
UA = "OSElectionInt-portrait-backfill/1.0 (civic data; contact via repo)"

# Occupation (P106) / position (P39) / party (P102) values that mark a hit as
# a plausible US political figure.
POLITICIAN_QIDS = {
    "Q82955",    # politician
    "Q193391",   # diplomat
    "Q1930187",  # journalist — common second career, kept as weak signal
}
US_HINTS = re.compile(
    r"\b(american|united states|u\.s\.|senator|representative|governor|"
    r"congress|state house|state senate|mayor|attorney general)\b",
    re.I,
)
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv)\.?$", re.I)


def get_json(params, tries=5):
    """Wikidata rate-limits an unauthenticated client hard. A 429 here is
    normal traffic management, not an error to abort on — back off and retry,
    because giving up mid-run leaves the backfill half-applied."""
    import json
    qs = urllib.parse.urlencode(params)
    delay = 1.0
    for attempt in range(tries):
        req = urllib.request.Request(f"{API}?{qs}", headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < tries - 1:
                wait = float(e.headers.get("Retry-After") or delay)
                time.sleep(min(wait, 30))
                delay *= 2
                continue
            raise
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return {}


def normalise(name):
    """FEC writes 'John Sen Cornyn' and 'Rafael Edward Ted Cruz'. Strip the
    noise so the search has a fighting chance."""
    n = re.sub(r"\s+", " ", name or "").strip()
    n = re.sub(r"\b(sen|rep|gov|dr|mr|mrs|ms)\b\.?", "", n, flags=re.I)
    n = SUFFIX.sub("", n).strip()
    return re.sub(r"\s+", " ", n)


def search(name, limit=5):
    d = get_json({
        "action": "wbsearchentities", "search": name, "language": "en",
        "format": "json", "limit": limit, "type": "item",
    })
    return [(x["id"], x.get("label", ""), x.get("description", ""))
            for x in d.get("search", [])]


def entities(qids):
    """wbgetentities takes up to 50 ids per call."""
    out = {}
    for i in range(0, len(qids), 50):
        chunk = qids[i:i + 50]
        d = get_json({
            "action": "wbgetentities", "ids": "|".join(chunk),
            "props": "claims|descriptions", "languages": "en", "format": "json",
        })
        out.update(d.get("entities", {}))
        time.sleep(0.6)
    return out


def claim_qids(ent, prop):
    vals = []
    for c in ent.get("claims", {}).get(prop, []):
        try:
            vals.append(c["mainsnak"]["datavalue"]["value"]["id"])
        except (KeyError, TypeError):
            pass
    return vals


def image_url(ent):
    for c in ent.get("claims", {}).get("P18", []):
        try:
            fn = c["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        return ("https://commons.wikimedia.org/wiki/Special:FilePath/"
                + urllib.parse.quote(fn) + "?width=300")
    return None


def looks_political(ent, desc):
    if US_HINTS.search(desc or ""):
        return True
    if set(claim_qids(ent, "P106")) & POLITICIAN_QIDS:
        return True
    # Held any position, or belongs to a party.
    return bool(claim_qids(ent, "P39")) or bool(claim_qids(ent, "P102"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycle", type=int, default=2026)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

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

    col = MongoClient(url).get_database().get_collection("us_candidates")
    todo = list(col.find(
        {"cycle": args.cycle, "photo": {"$in": [None, ""]}},
        {"name": 1, "fec_id": 1, "receipts": 1, "state": 1, "office": 1},
    ).sort("receipts", -1).limit(args.limit))

    print(f"{len(todo)} candidates without a portrait (top {args.limit} by receipts)")

    hits = skipped = 0
    for i, c in enumerate(todo, 1):
        name = normalise(c.get("name", ""))
        if not name:
            continue
        try:
            found = search(name)
        except Exception as e:
            print(f"  ! search failed for {name}: {e}")
            time.sleep(1.0)
            continue
        if not found:
            skipped += 1
            continue

        ents = entities([q for q, _, _ in found])
        # Keep only entities that both look political AND have an image.
        viable = []
        for qid, label, desc in found:
            e = ents.get(qid, {})
            img = image_url(e)
            if img and looks_political(e, desc):
                viable.append((qid, label, desc, img))

        if len(viable) != 1:
            # Zero = nothing usable. More than one = genuinely ambiguous, and
            # guessing puts a stranger's face on a candidate.
            skipped += 1
            if len(viable) > 1:
                print(f"  ~ ambiguous, skipped: {name} -> "
                      + ", ".join(f"{q} ({d[:40]})" for q, _, d, _ in viable))
            continue

        qid, label, desc, img = viable[0]
        hits += 1
        print(f"  [{i}/{len(todo)}] {c['name']} -> {qid} {label} | {desc[:50]}")
        if args.apply:
            col.update_one({"_id": c["_id"]}, {"$set": {
                "photo": img, "photo_source": "wikidata", "wikidata": qid,
            }})
        time.sleep(0.7)

    print(f"\nmatched {hits}, skipped {skipped}")
    print("dry run — pass --apply to write" if not args.apply else "written")


if __name__ == "__main__":
    main()
