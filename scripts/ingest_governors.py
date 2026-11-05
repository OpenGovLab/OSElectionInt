#!/usr/bin/env python3
"""
Sitting governors into us_officeholders, so the office stops rendering empty.

The governor selector was offering an office the database knew nothing about:
zero holders, zero candidates, zero races. Selecting it produced a blank
screen that reads as a broken app rather than as a gap in coverage.

Two stages, because the two facts come from completely different places and
only one of them is on Wikidata:

  fetch   Who holds each governorship now. Wikidata models this as P6
          (head of government) on the state item, and it answers for all
          50 states with a party for every one.

  cycle   WHEN each governorship is next contested. Wikidata cannot answer
          this — see the long note on next_election below — so it is derived
          from our own certified election history in us_margins.

WHY NOT TERM DATES FROM WIKIDATA: the obvious route is the P6 statement's
P580/P582 qualifiers, and it does not work. P582 (end time) is unset on
every one of the 50, which is correct — they are the current holder, so
their term has no recorded end. And P580 is the start of the STATEMENT, not
of the current term: Greg Abbott reads 2015-01-20 because that is when he
first took office, through two re-elections since. Deriving "next election"
from that would put Texas four years and eight years wrong.

WHY THE HISTORY IS BETTER: a state's own past gubernatorial elections encode
its cycle exactly. Alabama ran 2014, 2018, 2022 — a four-year rhythm landing
on 2026. New Hampshire ran 2014 through 2024 at every even year — a two-year
rhythm, also landing on 2026. The term length is read from the gaps rather
than hardcoded, so nothing assumes four years and then quietly mis-files the
two-year states. Measured across all 50, this yields 36 governorships up in
2026, which is the figure the cycle is known for.

WHAT THIS CANNOT GET: 2026 gubernatorial CANDIDATES. The FEC registers
federal candidates only, so a governor's race appears nowhere in the filings
we already hold, and state-office filings live with fifty separate state
authorities. That gap is left open rather than papered over.

Usage:
    python3 scripts/ingest_governors.py                 # dry run
    python3 scripts/ingest_governors.py --apply
    python3 scripts/ingest_governors.py --stage fetch --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import datetime as dt
import json
import os

import sys
import urllib.error
import urllib.parse
import urllib.request

WDQS = "https://query.wikidata.org/sparql"
UA = "OSElectionInt-governors/1.0 (civic data; contact via repo)"

SOURCE = "Wikidata (P6 head of government)"
SOURCE_URL = "https://query.wikidata.org/"
CYCLE_SOURCE = "derived from us_margins certified gubernatorial history"

# Wikidata party item -> the three-letter code the rest of the corpus uses.
# Deliberately a closed list: an unrecognised party is stored raw with a null
# code rather than guessed into DEM or REP.
PARTY_CODES = {
    "Democratic Party": "DEM",
    "Republican Party": "REP",
    "Independent": "IND",
    "independent politician": "IND",
}


def party_code(raw):
    """Map Wikidata's party label to our three-letter code.

    Exact match first, then state affiliates: Wikidata gives Oregon's governor
    'Democratic Party of Oregon' rather than 'Democratic Party', and there are
    fifty such affiliate names. The prefix rule reads those without having to
    enumerate them, and anything it does not recognise returns None so the
    raw string is kept and no party is asserted — the alternative is guessing
    an affiliation onto a named person.
    """
    if not raw:
        return None
    if raw in PARTY_CODES:
        return PARTY_CODES[raw]
    low = raw.lower()
    if low.startswith("democratic party of ") or low.startswith("democratic-"):
        return "DEM"
    if low.startswith("republican party of "):
        return "REP"
    return None

GOV_QUERY = """
SELECT ?state ?stateLabel ?gov ?govLabel ?partyLabel ?img ?site ?enwiki WHERE {
  ?state wdt:P31 wd:Q35657 ; wdt:P6 ?gov .
  OPTIONAL { ?gov wdt:P102 ?party }
  OPTIONAL { ?gov wdt:P18 ?img }
  OPTIONAL { ?gov wdt:P856 ?site }
  OPTIONAL { ?enwiki schema:about ?gov ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""

# Postal codes, needed because Wikidata gives us full state names.
POSTAL = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT",
    "Delaware": "DE", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
    "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
    "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
    "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
    "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
    "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
    "Wisconsin": "WI", "Wyoming": "WY",
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def election_day(year):
    """First Tuesday after the first Monday in November."""
    d = dt.date(year, 11, 1)
    while d.weekday() != 0:            # 0 = Monday
        d += dt.timedelta(days=1)
    return (d + dt.timedelta(days=1)).isoformat()


def sparql(query, tries=4):
    url = WDQS + "?" + urllib.parse.urlencode({"query": query})
    delay = 2.0
    import time
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/sparql-results+json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                return json.load(r)
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


# ── stage: who holds each governorship ───────────────────────────────────────

def fetch_governors():
    """All 50 via P6. Rows fan out across the OPTIONALs, so fold by state."""
    d = sparql(GOV_QUERY)
    by_state = {}
    for b in d.get("results", {}).get("bindings", []):
        name_full = b["stateLabel"]["value"]
        slot = by_state.setdefault(name_full, {})
        slot.setdefault("qid", b["gov"]["value"].rsplit("/", 1)[-1])
        slot.setdefault("label", b.get("govLabel", {}).get("value"))
        for key, var in (("party_raw", "partyLabel"), ("img", "img"),
                         ("site", "site")):
            if var in b and key not in slot:
                slot[key] = b[var]["value"]
        if "enwiki" in b and "enwiki" not in slot:
            slot["enwiki"] = urllib.parse.unquote(
                b["enwiki"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
    return by_state


def resolve_name(slot):
    """Label first, Wikipedia title second, then give up.

    Arkansas's governor (Q27986907) is a real human item described as
    'Governor of Arkansas since 2023' and carries NO English label, so the
    label service hands back the bare QID. A QID is not a name; writing it
    would put 'Q27986907' on screen as a person. The Wikipedia title is the
    same entity under a human-readable heading, so it is the right fallback —
    and if neither exists the row is skipped rather than invented.
    """
    label = slot.get("label")
    if label and not (label.startswith("Q") and label[1:].isdigit()):
        return label, "wikidata_label"
    if slot.get("enwiki"):
        return slot["enwiki"], "enwiki_title"
    return None, None


# ── stage: when is each governorship next contested ──────────────────────────

def cycles_from_history(db):
    """Which governorships are contested in 2026, read off our own archive.

    The rule is deliberately narrow: a state is up in 2026 if it held a
    gubernatorial general in 2022. Every four-year state that voted in 2022
    votes again in 2026, and the two-year states voted in 2022 as well, so
    one year of evidence settles both without needing to know a term length.

    I tried deriving term length from the gaps between a state's elections
    first, and it broke on bad data rather than on bad logic. Massachusetts
    carries rows for 2000, 2004, 2008 and 2020 in us_margins when its
    gubernatorial elections are 2002/2006/2010/2014/2018/2022 — the 2020 row
    reports a margin of exactly -100 on 5.3M votes, which is presidential
    turnout and a 100-point margin, so it is some other contest mis-filed as
    governor. Those phantom years made the modal gap read as two, which would
    have put Massachusetts on a two-year cycle. Reading a single year avoids
    inferring a rhythm from a history we cannot fully trust.

    The nine states that voted in 2024 but not 2022 — DE, IN, MO, MT, NC, ND,
    UT, WA, WV — are the four-year states on the presidential cycle, next up
    in 2028, and are correctly excluded.
    """
    gov = {"office": "governor", "level": "state", "election_type": "general"}
    held_2022 = {o.rsplit(":", 1)[-1].upper()
                 for o in db["us_margins"].distinct("ocd_id", {**gov, "year": 2022})}
    held_2024 = {o.rsplit(":", 1)[-1].upper()
                 for o in db["us_margins"].distinct("ocd_id", {**gov, "year": 2024})}

    rows = db["us_margins"].aggregate([
        {"$match": gov},
        {"$group": {"_id": "$ocd_id", "years": {"$addToSet": "$year"}}},
    ])
    out = {}
    for r in rows:
        abbv = r["_id"].rsplit(":", 1)[-1].upper()
        years = sorted(set(r.get("years") or []))
        yearset = set(years)

        # Two-year needs three consecutive even years, not two. Michigan
        # appears in both 2022 and 2024, but its 2024 row is 5.73M votes at a
        # 6.36-point margin — presidential turnout mis-filed as governor, the
        # same contamination as Massachusetts. Requiring 2020 as well sorts
        # the genuine two-year states (NH, VT, which have unbroken even-year
        # runs) from states carrying one stray row.
        two_year = {2020, 2022, 2024} <= yearset

        next_year = 2026 if abbv in held_2022 else None
        basis = "held_2022" if next_year else None

        # Idaho's 2022 race is absent from our archive, so the rule above
        # drops a state that is genuinely up. Where a state's recorded history
        # is a PERFECTLY regular four-year run, project it forward instead.
        # Regularity is the safeguard: the odd-year states have equally clean
        # runs and project to 2025 or 2027, so they stay excluded on their own
        # evidence rather than by being special-cased.
        if next_year is None and len(years) >= 3:
            gaps = {b - a for a, b in zip(years, years[1:])}
            if gaps == {4}:
                y = max(years)
                while y < 2026:
                    y += 4
                if y == 2026:
                    next_year, basis = 2026, "projected_from_regular_4yr_run"

        out[abbv] = {
            "years": years,
            "term_len": 2 if two_year else (4 if next_year else None),
            "next_year": next_year,
            "cycle_basis": basis,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["all", "fetch", "cycle"])
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()

    print("── cycle (from our certified history) ──")
    cycles = cycles_from_history(db)
    up_2026 = [a for a, c in cycles.items() if c["next_year"] == 2026]
    two_year = [a for a, c in cycles.items() if c["term_len"] == 2]
    no_cycle = [a for a, c in cycles.items() if not c["next_year"]]
    print(f"  states with history: {len(cycles)}")
    print(f"  two-year terms detected: {sorted(two_year)}")
    print(f"  next election 2026: {len(up_2026)}")
    if no_cycle:
        print(f"  no cycle derivable: {sorted(no_cycle)}")
    if args.stage == "cycle":
        return

    print("\n── fetch (Wikidata P6) ──")
    govs = fetch_governors()
    print(f"  states returned: {len(govs)}")

    docs, skipped, no_next = [], [], []
    for state_name, slot in sorted(govs.items()):
        abbv = POSTAL.get(state_name)
        if not abbv:
            skipped.append((state_name, "not a state we map"))
            continue
        name, name_source = resolve_name(slot)
        if not name:
            skipped.append((state_name, "no resolvable name"))
            continue

        party_raw = slot.get("party_raw")
        party = party_code(party_raw)
        cyc = cycles.get(abbv, {})
        next_year = cyc.get("next_year")
        if not next_year:
            no_next.append(abbv)

        ocd = f"ocd-division/country:us/state:{abbv.lower()}"
        docs.append({
            "_id": f"{ocd}|governor|{abbv}",
            "ocd_id": ocd,
            "office": "governor",
            "level": "state",
            "state": abbv,
            "district": None,
            "senate_class": None,
            "bioguide": None,
            "fec_ids": [],
            "name": name,
            "name_source": name_source,
            "party": party,
            "party_raw": party_raw,
            "next_election": election_day(next_year) if next_year else None,
            "up_next_cycle": next_year == 2026,
            "term_length_years": cyc.get("term_len"),
            "cycle_basis": cyc.get("cycle_basis"),
            "election_years_seen": cyc.get("years"),
            "photo": slot.get("img"),
            "photo_source": "wikidata" if slot.get("img") else None,
            "wikidata": slot.get("qid"),
            "wikipedia": slot.get("enwiki"),
            "url": slot.get("site"),
            "source": SOURCE,
            "source_url": SOURCE_URL,
            "cycle_source": CYCLE_SOURCE,
            "updated_at": now(),
        })

    have_party = sum(1 for d in docs if d["party"])
    have_photo = sum(1 for d in docs if d["photo"])
    have_next = sum(1 for d in docs if d["next_election"])
    seat_up = sum(1 for d in docs if d["up_next_cycle"])
    print(f"  resolved {len(docs)} governors "
          f"({have_party} with party, {have_photo} with photo)")
    print(f"  next_election set on {have_next}; seat_up 2026 = {seat_up}")
    if skipped:
        print(f"  skipped: {skipped}")
    if no_next:
        print(f"  no next_election: {sorted(no_next)}")

    for d in docs[:5]:
        print(f"    {d['state']}  {d['name'][:26]:28} {str(d['party']):4} "
              f"next {d['next_election']}  term {d['term_length_years']}y")

    if args.apply:
        col = db["us_officeholders"]
        for d in docs:
            col.replace_one({"_id": d["_id"]}, d, upsert=True)
        print(f"\n  wrote {len(docs)} governor rows")
        print("\nwritten")
    else:
        print("\ndry run — pass --apply to write")


if __name__ == "__main__":
    main()
