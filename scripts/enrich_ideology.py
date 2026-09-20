#!/usr/bin/env python3
"""
Ideology scores and caucus membership for sitting members.

Two stages, and the honest caveats attached to each matter more than the
numbers themselves — both of these are easy to render in a way that says
something untrue about a named living person.

  nominate   DW-NOMINATE dim1/dim2 and the Nokken-Poole variants, from
             Voteview's HS119_members.csv, joined on ICPSR. dim1 was already
             present; this adds the rest.

  caucuses   Congressional caucus membership from Wikidata P463. Documented,
             self-selected fact — which is what lets intra-party position be
             shown without anyone here assigning a label to a person.

WHAT DIM2 IS NOT
----------------
It is tempting to plot dim1 as "economic" and dim2 as "social" and call the
result a political compass. Measured against the 119th Congress, that is
wrong, and the numbers are stored alongside the scores so a UI cannot quietly
claim otherwise:

    dim1   Cohen's d 6.49 between the parties, classifies party 99.8%
    dim2   Cohen's d 0.34 between the parties, classifies party 59.7%
           (a coin flip is 50%)
    corr(dim1, dim2) = 0.131

Voteview's own description is historical and conditional: the second dimension
"picks up differences within the major political parties over slavery,
currency, nativism, civil rights, and lifestyle issues DURING PERIODS of
American history". In the current Congress it is close to residual variation.
A two-axis scatter plotted from these columns would invite readers to see a
social-liberty axis that the data does not support.

WHAT THE CAUCUS COVERAGE IS NOT
-------------------------------
Wikidata P463 covers 129 of 538 sitting members (24%), and the gaps are not
random. Measured:

    Progressive Caucus        77 found / ~95 actual      ~81%
    Congressional Black       31 / ~60                   ~52%
    Problem Solvers           23 / ~50                   ~46%
    Freedom Caucus            13 / ~35-45                ~33%
    Republican Study Cmte      4 / ~170                   ~2%
    New Democrat Coalition     2 / ~110                   ~2%
    Blue Dog Coalition         1 / ~10                   ~10%
    Hispanic Caucus            3 / ~43                    ~7%

The two largest Republican-side and centre-left caucuses are effectively
absent. Rendered naively this would show Democrats organised into visible
factions and Republicans as unaffiliated — a picture produced entirely by
Wikipedia editing patterns, not by how Congress is actually organised.

Worse, it cannot be fixed symmetrically from public sources. Measured: the
Progressive, New Democrat and Blue Dog caucuses all publish member lists
(HTTP 200); the Republican Study Committee blocks automated access (403) and
the Freedom Caucus does not publish a membership list at all — famously and
deliberately. So scraping would IMPROVE the Democratic side and leave the
Republican side where it is, widening the asymmetry rather than closing it.

Therefore every caucus row carries its own `coverage` block, and absence is
recorded as unknown, never as "not a member".

Usage:
    python3 scripts/enrich_ideology.py --stage all [--apply]
    python3 scripts/enrich_ideology.py --stage nominate --apply
    python3 scripts/enrich_ideology.py --stage caucuses --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "OSElectionInt-enrichment/1.0 (civic data; contact via repo)"

VOTEVIEW = "https://voteview.com/static/data/out/members/HS119_members.csv"
WDQS = "https://query.wikidata.org/sparql"

# Caucuses whose membership maps onto intra-party position. Name and QID only;
# no ordering, no left-right value is assigned to any of them here.
CAUCUSES = {
    "Q1125994": "Congressional Progressive Caucus",
    "Q19881038": "House Freedom Caucus",
    "Q146953": "Blue Dog Coalition",
    "Q1603376": "New Democrat Coalition",
    "Q7314710": "Republican Study Committee",
    "Q39086866": "Problem Solvers Caucus",
    "Q2015366": "Congressional Black Caucus",
    "Q5160937": "Congressional Hispanic Caucus",
}

# Approximate current membership from public reporting, used ONLY to compute
# and disclose a coverage fraction. Never shown as a score, never used to
# infer that a specific person is a member.
CAUCUS_APPROX_SIZE = {
    "Q1125994": 95, "Q19881038": 40, "Q146953": 10, "Q1603376": 110,
    "Q7314710": 170, "Q39086866": 50, "Q2015366": 60, "Q5160937": 43,
}

# Whether the caucus publishes a member list we could in principle scrape.
# Measured 2026-09-20. This is what makes the asymmetry irreducible.
CAUCUS_PUBLISHES = {
    "Q1125994": "yes", "Q1603376": "yes", "Q146953": "yes",
    "Q39086866": "unknown", "Q2015366": "unknown", "Q5160937": "unknown",
    "Q7314710": "blocked",        # 403 to automated access
    "Q19881038": "no",            # does not publish membership
}

# Measured on HS119 (see module docstring). Stored with the scores so the
# interpretation travels with the data rather than living in a comment.
DIM_STATS = {
    "dim1": {"cohens_d_between_parties": 6.49, "party_classification": 0.998},
    "dim2": {"cohens_d_between_parties": 0.34, "party_classification": 0.597},
    "correlation_dim1_dim2": 0.131,
    "n": 554,
}

INTERPRETATION = (
    "dim1 is the primary economic/redistributive axis and separates the "
    "parties almost completely in this Congress (classifies party 99.8%). "
    "dim2 does NOT measure social liberalism: it separates the parties barely "
    "better than chance (59.7%, Cohen's d 0.34) and is close to residual "
    "variation in the modern era. Voteview describes it as capturing "
    "within-party differences over slavery, currency, nativism, civil rights "
    "and lifestyle issues 'during periods of American history' — a historical, "
    "conditional claim. Do not plot dim1 x dim2 as an economic/social compass."
)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def fetch_text(url, tries=4):
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return ""


def sparql(query, tries=5):
    """WDQS returns 502 on oversized queries and 429 under load. Both are
    normal traffic management; back off rather than abandoning a partial run."""
    url = WDQS + "?" + urllib.parse.urlencode({"query": query})
    delay = 3.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/sparql-results+json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < tries - 1:
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


def num(v):
    """Voteview writes empty strings and 'NA' for missing estimates."""
    if v in (None, "", "NA"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


# ── stage 1: DW-NOMINATE dim2 + Nokken-Poole ────────────────────────────────

def stage_nominate(db, apply_writes):
    """Join Voteview on ICPSR, falling back to bioguide.

    ICPSR is the right key: it is Voteview's own identifier and is already
    stored on every one of our 539 rows (nested at ideology.icpsr). Bioguide
    is the fallback because Voteview leaves it blank for the President row
    and occasionally for very recent arrivals.
    """
    print("\n── DW-NOMINATE dim2 (Voteview HS119, ICPSR join) ──")
    text = fetch_text(VOTEVIEW)
    rows = list(csv.DictReader(io.StringIO(text)))
    print(f"  fetched {len(rows)} Voteview rows")

    by_icpsr, by_bio = {}, {}
    for r in rows:
        if r.get("icpsr"):
            by_icpsr[str(r["icpsr"]).strip()] = r
        if r.get("bioguide_id"):
            by_bio[r["bioguide_id"].strip()] = r

    col = db.get_collection("us_officeholders")
    ours = list(col.find({}, {"name": 1, "bioguide": 1, "ideology": 1}))
    hit = miss = 0
    matched_by = {"icpsr": 0, "bioguide": 0}

    for o in ours:
        icpsr = str((o.get("ideology") or {}).get("icpsr") or "").strip()
        v = by_icpsr.get(icpsr)
        how = "icpsr"
        if not v and o.get("bioguide"):
            v = by_bio.get(o["bioguide"])
            how = "bioguide"
        if not v:
            miss += 1
            continue
        matched_by[how] += 1

        ideo = dict(o.get("ideology") or {})
        ideo.update({
            "nominate_dim1": num(v["nominate_dim1"]),
            "nominate_dim2": num(v["nominate_dim2"]),
            "nokken_poole_dim1": num(v.get("nokken_poole_dim1")),
            "nokken_poole_dim2": num(v.get("nokken_poole_dim2")),
            "votes_analysed": int(num(v.get("nominate_number_of_votes")) or
                                  ideo.get("votes_analysed") or 0),
            "errors": int(num(v.get("nominate_number_of_errors")) or 0),
            "geo_mean_probability": num(v.get("nominate_geo_mean_probability")),
            "congress": 119,
            "icpsr": icpsr or ideo.get("icpsr"),
            "party_code": v.get("party_code"),
            # Provenance and interpretation travel WITH the numbers. A score
            # without a source and a vintage cannot be audited later, and a
            # second dimension without this note gets plotted as a social axis.
            "source": "voteview.com DW-NOMINATE",
            "source_url": VOTEVIEW,
            "matched_by": how,
            "retrieved_at": now(),
            "interpretation": INTERPRETATION,
            "dimension_stats": DIM_STATS,
        })
        hit += 1
        if apply_writes:
            col.update_one({"_id": o["_id"]}, {"$set": {"ideology": ideo}})

    print(f"  matched {hit} (icpsr {matched_by['icpsr']}, "
          f"bioguide {matched_by['bioguide']}), unmatched {miss}")
    return hit


# ── stage 2: caucus membership ──────────────────────────────────────────────

def fetch_caucus_members():
    """Every human recorded as P463 'member of' one of the tracked caucuses.

    One query for all eight. Asking per-caucus with our 538 QIDs inlined
    returns 502 — the VALUES cross-product is too large — and the whole
    membership of these bodies is only a few hundred rows anyway, so it is
    cheaper to pull them all and intersect locally.
    """
    q = """SELECT ?p ?c WHERE {
  VALUES ?c { %s }
  ?p wdt:P463 ?c .
  ?p wdt:P31 wd:Q5 .
}""" % " ".join("wd:" + k for k in CAUCUSES)
    d = sparql(q)
    out = {}
    for b in d.get("results", {}).get("bindings", []):
        person = b["p"]["value"].rsplit("/", 1)[-1]
        caucus = b["c"]["value"].rsplit("/", 1)[-1]
        out.setdefault(caucus, set()).add(person)
    return out


def stage_caucuses(db, apply_writes):
    """Attach caucus membership, and attach the coverage caveat to every row.

    The caveat is per-person, not just per-caucus, because the failure mode is
    someone reading a member with no tags as unaffiliated. `caucus_coverage`
    says plainly that absence means unknown.
    """
    print("\n── caucus membership (Wikidata P463) ──")
    members = fetch_caucus_members()
    total_found = sum(len(v) for v in members.values())
    print(f"  Wikidata knows {total_found} memberships across "
          f"{len(members)} caucuses")

    col = db.get_collection("us_officeholders")
    ours = list(col.find({"wikidata": {"$nin": [None, ""]}},
                         {"name": 1, "wikidata": 1, "party": 1}))
    by_qid = {o["wikidata"]: o for o in ours}

    # Per-caucus coverage, measured against our own population.
    coverage = {}
    for qid, name in CAUCUSES.items():
        found = members.get(qid, set()) & set(by_qid)
        approx = CAUCUS_APPROX_SIZE[qid]
        coverage[qid] = {
            "caucus": name,
            "found_in_our_members": len(found),
            "approx_actual_size": approx,
            "coverage_fraction": round(len(found) / approx, 3) if approx else None,
            "publishes_member_list": CAUCUS_PUBLISHES[qid],
        }

    assigned = 0
    for qid, o in by_qid.items():
        tags = []
        for cq, cname in CAUCUSES.items():
            if qid in members.get(cq, set()):
                tags.append({
                    "caucus": cname,
                    "wikidata": cq,
                    "source": "wikidata P463",
                    "coverage_fraction": coverage[cq]["coverage_fraction"],
                })
        if not tags:
            continue
        assigned += 1
        if apply_writes:
            col.update_one({"_id": o["_id"]}, {"$set": {
                "caucuses": tags,
                "caucus_source": "wikidata P463",
                "caucus_retrieved_at": now(),
            }})

    # Absence must never read as "not a member". Stamped on EVERY row, so the
    # caveat is present whether or not the person got a tag.
    caveat = (
        "Caucus membership is from Wikidata P463 and is incomplete and "
        "unevenly distributed: it covers roughly %d%% of sitting members, with "
        "the Republican Study Committee (~2%%) and New Democrat Coalition "
        "(~2%%) almost entirely absent while the Progressive Caucus is ~81%% "
        "covered. Absence of a caucus tag means UNKNOWN, never 'not a member'. "
        "The gap cannot be closed symmetrically: the Freedom Caucus does not "
        "publish a membership list and the Republican Study Committee blocks "
        "automated access, while the Democratic-side caucuses do publish."
        % round(100 * assigned / max(len(by_qid), 1))
    )
    if apply_writes:
        col.update_many({}, {"$set": {"caucus_coverage": caveat}})
        db.get_collection("us_ideology_meta").update_one(
            {"_id": "caucus_coverage"},
            {"$set": {"per_caucus": coverage, "caveat": caveat,
                      "members_with_any_caucus": assigned,
                      "members_considered": len(by_qid),
                      "retrieved_at": now()}},
            upsert=True)
        db.get_collection("us_ideology_meta").update_one(
            {"_id": "nominate"},
            {"$set": {"interpretation": INTERPRETATION,
                      "dimension_stats": DIM_STATS,
                      "source_url": VOTEVIEW, "congress": 119,
                      "retrieved_at": now()}},
            upsert=True)

    print(f"  tagged {assigned} of {len(by_qid)} members "
          f"({100 * assigned / max(len(by_qid), 1):.1f}%)")
    print("\n  %-34s %6s %8s %9s %s"
          % ("caucus", "found", "approx", "coverage", "publishes"))
    for qid, c in sorted(coverage.items(),
                         key=lambda kv: -kv[1]["found_in_our_members"]):
        print("  %-34s %6d %8d %8.0f%% %s"
              % (c["caucus"], c["found_in_our_members"],
                 c["approx_actual_size"], 100 * (c["coverage_fraction"] or 0),
                 c["publishes_member_list"]))
    return assigned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "nominate", "caucuses"])
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "nominate"):
        stage_nominate(db, args.apply)
    if args.stage in ("all", "caucuses"):
        stage_caucuses(db, args.apply)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
