#!/usr/bin/env python3
"""
Election-night ingest: early vote, live results, and a change log.

WHAT THIS DOES NOT DO
---------------------
It never calls a race. Not once, not with 99% reporting, not ever. A
"winner" is a judgement that wire services staff a decision desk to make,
with modelling of outstanding ballots that we do not have and could not
check. This records votes and how much of the count is in. Where a source
states its own call, it is stored as that source's claim with attribution
and never promoted to a fact.

That is not caution for its own sake. On election night the cost of being
wrong is asymmetric to the point of absurdity: a dashboard that is six
minutes slow is mildly annoying, and one that calls a race wrongly is a
disinformation incident.

LIVE RESULTS ARE NOT CERTIFIED RESULTS
--------------------------------------
Everything here lands in us_results_live and us_early_vote_2026. Nothing
touches us_margins, which holds certified history. Certified canvasses
arrive weeks later and WILL disagree with election-night numbers —
provisional ballots get cured, late mail arrives, counties correct
transposition errors. Merging the two would quietly corrupt the archive
that the rest of this project is built on.

TIMESTAMPS ARE THE SOURCE'S, AND THEY GOVERN WRITES
---------------------------------------------------
Election-night feeds arrive out of order. A retry that completes late, a
CDN serving a stale object, two workers racing — any of these can deliver
an older report after a newer one. A stale write clobbering a fresh one is
THE characteristic failure of this kind of pipeline, and it is invisible
afterwards because the data still looks plausible.

So every write compares the source's own as-of time, never arrival order,
and refuses to go backwards. For North Carolina that time is the S3
Last-Modified header; for early vote it is the per-state last_update
column that UF publishes.

WHY "PRECINCTS REPORTING" IS OFTEN NULL
----------------------------------------
A vote total without a denominator is not information. A lead with 4% of
precincts in is noise, and rendering it the same way as a lead with 98% in
is how people end up believing a race flipped overnight when it simply
finished counting.

North Carolina — the one state whose feed parses today — does not publish
an explicit precincts-reporting count. It would be easy to count precincts
with at least one vote and call that "reporting", and it would be wrong: a
precinct can legitimately report zero for a given contest. So this records
precincts_with_votes and precincts_total as the observable facts, sets
precincts_reporting to null, and flags it. An honest null beats a
confident approximation.

Usage:
    python3 scripts/ingest_live_results.py --stage earlyvote
    python3 scripts/ingest_live_results.py --stage earlyvote --apply
    python3 scripts/ingest_live_results.py --stage results --apply
    python3 scripts/ingest_live_results.py --stage all --apply
    python3 scripts/ingest_live_results.py --stage results --state NC --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

UA = "OSElectionInt-research/1.0 (civic data; contact via repo)"

# These are government servers on the heaviest night of their decade.
# Serial, identified, unhurried, and quick to give up rather than retry
# tightly into a struggling host.
DELAY = 2.0

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = os.path.join(HERE, "data", "results_sources.json")

CYCLE = 2026

EARLY_CAVEAT = (
    "Early-vote counts compiled by the University of Florida Election Lab "
    "from state reports. Each state's figure carries its own as-of date "
    "because states report on different schedules. Ballots cast are not "
    "votes counted, and party registration is not how someone voted."
)

RESULTS_CAVEAT = (
    "Unofficial election-night returns read directly from the state's own "
    "feed. These are not certified results: canvassing takes weeks and the "
    "certified totals will differ. No winner is declared here — this "
    "records votes and how much of the count is in."
)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def http_get(url, tries=4, binary=False):
    """Returns (body, headers). Backs off hard on 429/503 — a struggling
    election-night server must not be hammered by our retries."""
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
                return (raw if binary else raw.decode("utf-8", "replace")), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < tries - 1:
                wait = min(float(e.headers.get("Retry-After") or delay), 60)
                time.sleep(wait)
                delay *= 2
                continue
            raise
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return (b"" if binary else ""), {}


def connect():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pip install pymongo")
    url = os.environ.get("MONGODB_URL")
    if not url:
        env = os.path.join(HERE, "..", "server", ".env")
        for line in open(env):
            if line.startswith("MONGODB_URL="):
                url = line.split("=", 1)[1].strip()
                break
    if not url:
        sys.exit("MONGODB_URL not set")
    db = MongoClient(url, serverSelectionTimeoutMS=15000).get_database()
    # A failover leaves reads working against a secondary while writes
    # throw, which looks like success until the first update. Fail loudly
    # and early instead of half-way through a run.
    hello = db.client.admin.command({"hello": 1})
    if not hello.get("isWritablePrimary"):
        sys.exit(
            "connected to a SECONDARY — writes will fail.\n"
            f"  primary is {hello.get('primary')}\n"
            "  re-probe ports 31700/31701/31702 and point MONGODB_URL at the primary"
        )
    return db


def sources():
    with open(SOURCES) as f:
        return json.load(f)


def parse_http_date(s):
    """RFC 7231 date -> ISO 8601, or None. This is the source's as-of."""
    if not s:
        return None
    try:
        return dt.datetime.strptime(
            s, "%a, %d %b %Y %H:%M:%S %Z"
        ).replace(tzinfo=dt.timezone.utc).isoformat()
    except Exception:
        return None


def parse_us_date(s):
    """UF writes 11/2/2026. Returns ISO date, or None."""
    s = (s or "").strip()
    if not s or s.upper() == "NA":
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def newer(a, b):
    """True when a is strictly newer than b. Missing sorts oldest, so a
    first write always lands and an undated report never displaces a
    dated one."""
    if a is None:
        return False
    if b is None:
        return True
    return str(a) > str(b)


def i(v):
    """Int or None. UF and NC both use '' and 'NA' for absence."""
    s = str(v or "").strip().replace(",", "")
    if not s or s.upper() == "NA":
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


# ── stage 1: early vote ──────────────────────────────────────────────────────

# UF column groups. 'voted' is the headline (ballots actually cast);
# 'request' and 'accept' describe the mail pipeline.
EV_GROUPS = ("request", "accept", "inperson", "voted")
EV_PARTIES = ("dem", "rep", "none")


def ev_breakdown(row, group):
    """One mode's numbers, with UF's zero-for-unreported corrected to null.

    UF writes 0, not blank, where a state does not publish a breakdown.
    Alaska reports 99,424 ballots cast and 0 Democrats and 0 Republicans —
    because Alaska does not report party registration at all, not because
    no Democrat voted. Reading those zeros literally would put a flat
    '0 DEM' next to a six-figure total and invite exactly the wrong
    conclusion. So: if every part is zero while the total is positive, the
    breakdown is absent, and absent is null.
    """
    total = i(row.get(f"{group}_all"))
    parts = {p: i(row.get(f"{group}_{p}")) for p in EV_PARTIES}
    reported = any(v for v in parts.values())
    if total and not reported:
        return {"total": total, "by_party": None, "party_reported": False}
    return {
        "total": total,
        "by_party": parts if reported else None,
        "party_reported": bool(reported),
    }


def stage_earlyvote(db, apply_writes):
    src = sources()["early_vote"]
    print("── early vote (UF Election Lab) ──")
    body, _ = http_get(src["csv"])
    rows = list(csv.DictReader(io.StringIO(body)))
    print(f"  {len(rows)} state rows")

    col = db["us_early_vote_2026"]
    written = skipped_stale = 0
    as_of_dates = {}
    no_party = []

    for row in rows:
        abbv = (row.get("state_abbv") or "").strip().upper()
        if not abbv:
            continue
        as_of = parse_us_date(row.get("last_update"))
        as_of_dates[abbv] = as_of

        modes = {g: ev_breakdown(row, g) for g in EV_GROUPS}
        if modes["voted"]["total"] and not modes["voted"]["party_reported"]:
            no_party.append(abbv)

        doc = {
            "_id": abbv,
            "state": (row.get("state") or "").strip(),
            "state_abbv": abbv,
            "cycle": CYCLE,
            # The SOURCE's as-of, not our fetch time. UF aggregates states
            # reporting on different days; one national timestamp would be
            # a fiction.
            "as_of": as_of,
            "modes": modes,
            "turnout_2022": i(row.get("turn_2022")),
            "updated_today": bool(i(row.get("updates_today"))),
            "state_source": (row.get("data_source") or "").strip() or None,
            "state_notes": (row.get("notes") or "").strip() or None,
            "source": src["source"],
            "source_url": src["csv"],
            "fetched_at": now(),
            "caveat": EARLY_CAVEAT,
        }

        if not apply_writes:
            written += 1
            continue

        prev = col.find_one({"_id": abbv}, {"as_of": 1})
        if prev and not newer(as_of, prev.get("as_of")):
            skipped_stale += 1
            continue
        col.replace_one({"_id": abbv}, doc, upsert=True)
        written += 1

    dated = [d for d in as_of_dates.values() if d]
    print(f"  as-of range: {min(dated) if dated else '—'} .. {max(dated) if dated else '—'}")
    print(f"  states not reporting party: {len(no_party)}"
          + (f" ({', '.join(sorted(no_party)[:12])}…)" if no_party else ""))
    print(f"  {'written' if apply_writes else 'would write'} {written}"
          + (f", skipped {skipped_stale} as stale" if skipped_stale else ""))
    return written


# ── stage 2: live results ────────────────────────────────────────────────────

def ocd_for_nc(contest_name):
    """NC contest name -> (ocd_id, office, district). None for contests the
    dashboard does not cover — county commissioners and the like."""
    n = re.sub(r"\s+", " ", (contest_name or "").strip().upper())
    base = "ocd-division/country:us/state:nc"
    if n == "US SENATE":
        return base, "us_senate", None
    m = re.match(r"^US HOUSE OF REPRESENTATIVES DISTRICT (\d+)$", n)
    if m:
        d = int(m.group(1))
        return f"{base}/cd:{d}", "us_house", d
    if n == "GOVERNOR":
        return base, "governor", None
    return None


def adapter_nc(entry):
    """North Carolina: zipped tab-delimited precinct file.

    Returns (contests, as_of). Aggregates precinct rows to contest level,
    keeping the per-mode split NC uniquely provides.
    """
    raw, headers = http_get(entry["url"], binary=True)
    as_of = parse_http_date(headers.get("Last-Modified"))

    zf = zipfile.ZipFile(io.BytesIO(raw))
    member = zf.namelist()[0]
    text = zf.read(member).decode("utf-8", "replace").splitlines()
    if not text:
        return {}, as_of

    hdr = text[0].split("\t")
    ix = {h: k for k, h in enumerate(hdr)}

    def cell(f, name):
        k = ix.get(name)
        return f[k] if k is not None and k < len(f) else ""

    contests = {}
    for line in text[1:]:
        f = line.split("\t")
        if len(f) < len(hdr):
            continue
        mapped = ocd_for_nc(cell(f, "Contest Name"))
        if not mapped:
            continue
        ocd_id, office, district = mapped
        key = (ocd_id, office, district)
        c = contests.setdefault(key, {
            "candidates": {},
            "precincts": set(),
            "precincts_with_votes": set(),
        })

        precinct = (cell(f, "County"), cell(f, "Precinct"))
        if (cell(f, "Real Precinct") or "").strip().upper() == "Y":
            c["precincts"].add(precinct)

        total = i(cell(f, "Total Votes")) or 0
        if total:
            c["precincts_with_votes"].add(precinct)

        name = (cell(f, "Choice") or "").strip()
        if not name:
            continue
        cand = c["candidates"].setdefault(name, {
            "name": name,
            "party": (cell(f, "Choice Party") or "").strip() or None,
            "votes": 0,
            "by_mode": {"election_day": 0, "early": 0, "mail": 0, "provisional": 0},
        })
        cand["votes"] += total
        cand["by_mode"]["election_day"] += i(cell(f, "Election Day")) or 0
        cand["by_mode"]["early"] += i(cell(f, "Early Voting")) or 0
        cand["by_mode"]["mail"] += i(cell(f, "Absentee by Mail")) or 0
        cand["by_mode"]["provisional"] += i(cell(f, "Provisional")) or 0

    out = {}
    for (ocd_id, office, district), c in contests.items():
        cands = sorted(c["candidates"].values(), key=lambda x: -x["votes"])
        total_votes = sum(x["votes"] for x in cands)
        for x in cands:
            x["percent"] = round(100.0 * x["votes"] / total_votes, 2) if total_votes else None
        out[(ocd_id, office, district)] = {
            "candidates": cands,
            "total_votes": total_votes,
            # NC publishes no reporting count. See the module docstring:
            # counting precincts with votes would overstate completeness,
            # because a precinct may legitimately report zero for a contest.
            "precincts_reporting": None,
            "precincts_reporting_available": False,
            "precincts_total": len(c["precincts"]) or None,
            "precincts_with_votes": len(c["precincts_with_votes"]),
        }
    return out, as_of


ADAPTERS = {"NC": adapter_nc}


def stage_results(db, apply_writes, only_state=None):
    cfg = sources()
    print("── live results ──")

    live = db["us_results_live"]
    changes = db["us_results_changes"]
    # Per-candidate snapshots, one per contest per distinct source timestamp.
    #
    # us_results_changes is a SUMMARY log — it carries total_votes and who led,
    # and nothing per candidate. That is enough to say the count grew, and not
    # enough to replay the count. Reconstructing a candidate's votes at 21:40
    # from a later state is not possible and must not be guessed, so the
    # snapshot is written at observation time or the history simply does not
    # exist. Keyed on contest + reported_at, so re-running against an
    # unchanged source is a no-op rather than a duplicate frame.
    snaps = db["us_results_snapshots"]
    run_at = now()
    wrote = stale = 0
    change_docs = []

    for abbv, entry in sorted(cfg["adapters"].items()):
        if only_state and abbv != only_state.upper():
            continue
        status = entry.get("status")
        if status != "working" or abbv not in ADAPTERS:
            print(f"  {abbv}: {status} — {entry.get('url','')[:58]}")
            continue

        try:
            contests, as_of = ADAPTERS[abbv](entry)
        except Exception as e:
            print(f"  {abbv}: FETCH FAILED {type(e).__name__}: {e}")
            continue

        counted = sum(c["total_votes"] for c in contests.values())
        print(f"  {abbv}: {len(contests)} contests, {counted:,} votes, "
              f"source as-of {as_of or 'unknown'}")
        if contests and counted == 0:
            print("       (zero is the correct answer before polls close — "
                  "this is the pre-published ballot template)")

        for (ocd_id, office, district), c in contests.items():
            _id = f"{CYCLE}|{ocd_id}|{office}|{district if district is not None else '-'}"
            doc = {
                "_id": _id,
                "cycle": CYCLE,
                "ocd_id": ocd_id,
                "state": abbv,
                "office": office,
                "district": district,
                "candidates": c["candidates"],
                "total_votes": c["total_votes"],
                "precincts_reporting": c["precincts_reporting"],
                "precincts_reporting_available": c["precincts_reporting_available"],
                "precincts_total": c["precincts_total"],
                "precincts_with_votes": c["precincts_with_votes"],
                "is_estimate": False,
                # Nobody has called anything. If a source ever states its own
                # call it goes here, named, and stays that source's claim.
                "source_call": None,
                "reported_at": as_of,
                "source": entry["state"],
                "source_url": entry["url"],
                "fetched_at": run_at,
                "caveat": RESULTS_CAVEAT,
            }

            prev = live.find_one({"_id": _id})
            if prev and not newer(as_of, prev.get("reported_at")):
                stale += 1
                continue

            # Written before the live upsert, so a crash between the two
            # leaves a recoverable frame rather than a gap in the replay.
            if as_of:
                snaps.update_one(
                    {"_id": f"{_id}|{as_of}"},
                    {"$setOnInsert": {
                        "contest_id": _id, "cycle": CYCLE, "ocd_id": ocd_id,
                        "state": abbv, "office": office, "district": district,
                        "candidates": c["candidates"],
                        "total_votes": c["total_votes"],
                        "precincts_reporting": c["precincts_reporting"],
                        "precincts_reporting_available":
                            c["precincts_reporting_available"],
                        "precincts_total": c["precincts_total"],
                        "precincts_with_votes": c["precincts_with_votes"],
                        "source_call": None,
                        "reported_at": as_of,
                        "source_url": entry["url"],
                        "fetched_at": run_at,
                    }},
                    upsert=True,
                )

            delta = diff(prev, doc)
            if delta:
                change_docs.append({
                    "contest_id": _id,
                    "cycle": CYCLE,
                    "ocd_id": ocd_id,
                    "office": office,
                    "district": district,
                    "state": abbv,
                    "run_at": run_at,
                    "from_reported_at": (prev or {}).get("reported_at"),
                    "to_reported_at": as_of,
                    **delta,
                })

            if apply_writes:
                live.replace_one({"_id": _id}, doc, upsert=True)
            wrote += 1

    if apply_writes and change_docs:
        changes.insert_many(change_docs)
    print(f"  {'wrote' if apply_writes else 'would write'} {wrote} contests"
          + (f", skipped {stale} as stale" if stale else "")
          + f", {len(change_docs)} changes logged")
    return wrote


def diff(prev, doc):
    """What changed, for the append-only log an alerting agent reads.

    Lead changes are reported as an observation about vote order — who is
    ahead in the count right now — and emphatically not as a race turning.
    With no precincts-reporting denominator, an early lead change is
    usually just a different batch landing.
    """
    if not prev:
        return {
            "kind": "first_report",
            "total_votes": doc["total_votes"],
            "leader": doc["candidates"][0]["name"] if doc["candidates"] else None,
        }
    out = {}
    dv = doc["total_votes"] - (prev.get("total_votes") or 0)
    if dv:
        out["votes_delta"] = dv
        out["total_votes"] = doc["total_votes"]
    dp = (doc.get("precincts_with_votes") or 0) - (prev.get("precincts_with_votes") or 0)
    if dp:
        out["precincts_with_votes_delta"] = dp

    old_lead = (prev.get("candidates") or [{}])[0].get("name")
    new_lead = (doc.get("candidates") or [{}])[0].get("name")
    if old_lead and new_lead and old_lead != new_lead:
        out["lead_change"] = {"from": old_lead, "to": new_lead}
        out["lead_change_note"] = (
            "Order of the count changed. This is not a race call and, "
            "without a precincts-reporting denominator, is not evidence "
            "that the outcome changed."
        )
    return {"kind": "update", **out} if out else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "earlyvote", "results"])
    ap.add_argument("--state", default=None, help="limit results to one state")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "earlyvote"):
        stage_earlyvote(db, args.apply)
    if args.stage in ("all", "results"):
        stage_results(db, args.apply, args.state)

    print("\nwritten" if args.apply else "\ndry run — pass --apply to write")


if __name__ == "__main__":
    main()
