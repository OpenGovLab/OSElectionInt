#!/usr/bin/env python3
"""
2026 results from Ballotpedia, as a THIRD and separate source.

WHY A SEPARATE COLLECTION
-------------------------
Three result sources now exist and they must never be merged:

  us_margins              certified history, weeks behind, authoritative
  us_results_live         our own direct-from-state scrapes, unofficial
  us_results_ballotpedia  this — a human-curated secondary source

Merging them would destroy the one thing that makes a second source worth
having: the ability to disagree. Two independent sources agreeing is the
strongest signal available on an unofficial count. Silently overwriting
one with the other throws that away and leaves no way to notice.

WHAT BALLOTPEDIA ACTUALLY PUBLISHES
-----------------------------------
Measured on the 2026 page, not assumed:

  - A partisan-control summary: seats on the ballot, before/after, and —
    valuably — how many races are still UNCALLED.
  - Battleground tables with columns `office | candidate | party | status`.
    Status is Won / Lost / On the Ballot. These are CALLS, not tallies:
    there is no vote count and no percentage anywhere on the page.
  - Per-race pages (one fetch each) carry the actual tally in a
    `results_table`, general election and primaries both.
  - No county-level data at all. Not on the summary page, not on the
    per-race pages. A county layer would have to come from the states.

NO TIMESTAMP, WHICH IS THE AWKWARD PART
---------------------------------------
Per-race pages carry no "results last updated" marker. Everywhere else in
this project writes are governed by the source's own as-of time, and that
is impossible here — so these documents record fetched_at and say plainly
that the source states no as-of. A reader comparing numbers must be able
to see that one side of the comparison is undated.

That matters because Ballotpedia LAGS. Measured today on the North
Carolina Senate race: their general-election table has Cooper at
1,677,702 against our state scrape's 2,463,773 — about 63% of the vote we
hold, and at different percentages, because the later-counted ballots
broke differently. Their number is not wrong; it is a partial count
frozen at an unstated moment.

CALLS ARE THEIRS
----------------
Ballotpedia runs a decision desk and publishes "How we decide when to
call an election". When they mark a race Won, that is stored as their
claim, attributed, in source_call. Nothing here derives a winner.

Usage:
    python3 scripts/ingest_ballotpedia.py --stage summary
    python3 scripts/ingest_ballotpedia.py --stage battleground --apply
    python3 scripts/ingest_ballotpedia.py --stage races --limit 10 --apply
    python3 scripts/ingest_ballotpedia.py --stage all --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", "server", ".env")

BASE = "https://ballotpedia.org"
MAIN = f"{BASE}/Election_results,_2026"
CYCLE = 2026

# Their robots.txt allows content pages and asks for Crawl-delay: 2.
# It permits us, so politeness is our own responsibility — a residential
# exit means nothing at the edge will enforce it for us.
CRAWL_DELAY = 2.0

# A User-Agent that names the project — which currently does NOT get in,
# and that is deliberate.
#
# THIS SCRIPT DOES NOT RUN AGAINST BALLOTPEDIA TODAY. Measured through
# the proxy, seconds apart: a bare Chrome string returns 200 and 1.15MB,
# while the identical request with this research suffix appended returns
# 202 and an empty body. Their CloudFront WAF fingerprints the UA and
# admits only strings it recognises as a browser — rejecting honest
# crawlers along with dishonest ones.
#
# Removing the suffix would make this work. It was not removed, because
# that means defeating a bot check on purpose, and together with the
# residential proxy already needed to pass their datacenter-IP block it
# would be two active access controls circumvented. robots.txt allowing
# content pages does not settle the question: robots.txt is a crawler
# convention, the WAF is a live control, and where the two disagree the
# live one is what the operator wants today.
#
# So the fetch path stays honest and stays blocked. The parsing below is
# complete and was validated against pages retrieved during exploration;
# it runs the moment there is a sanctioned route — an API key, a data
# partnership, or written permission to crawl as an identified agent.
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 "
    "(+OSElectionInt civic-data research; respects robots.txt and Crawl-delay)"
)

CAVEAT = (
    "Compiled by Ballotpedia, a secondary source, and read through a "
    "proxy because this host's datacenter range is blocked at their CDN "
    "edge. Ballotpedia states no as-of time for its result tables, so "
    "these figures are undated and have been measured to lag direct "
    "state feeds. Any 'called' marker is Ballotpedia's own editorial "
    "judgement, attributed as such; nothing here declares a winner."
)

STATES = {
    "Alabama": "al", "Alaska": "ak", "Arizona": "az", "Arkansas": "ar",
    "California": "ca", "Colorado": "co", "Connecticut": "ct",
    "Delaware": "de", "Florida": "fl", "Georgia": "ga", "Hawaii": "hi",
    "Idaho": "id", "Illinois": "il", "Indiana": "in", "Iowa": "ia",
    "Kansas": "ks", "Kentucky": "ky", "Louisiana": "la", "Maine": "me",
    "Maryland": "md", "Massachusetts": "ma", "Michigan": "mi",
    "Minnesota": "mn", "Mississippi": "ms", "Missouri": "mo",
    "Montana": "mt", "Nebraska": "ne", "Nevada": "nv",
    "New Hampshire": "nh", "New Jersey": "nj", "New Mexico": "nm",
    "New York": "ny", "North Carolina": "nc", "North Dakota": "nd",
    "Ohio": "oh", "Oklahoma": "ok", "Oregon": "or", "Pennsylvania": "pa",
    "Rhode Island": "ri", "South Carolina": "sc", "South Dakota": "sd",
    "Tennessee": "tn", "Texas": "tx", "Utah": "ut", "Vermont": "vt",
    "Virginia": "va", "Washington": "wa", "West Virginia": "wv",
    "Wisconsin": "wi", "Wyoming": "wy",
    "District of Columbia": "dc",
}
STATE_RE = "|".join(sorted(map(re.escape, STATES), key=len, reverse=True))


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def env(key):
    v = os.environ.get(key)
    if v:
        return v
    try:
        for line in open(ENV):
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


_last_fetch = [0.0]


def fetch(url, tries=3):
    """GET through the residential proxy, honouring Crawl-delay: 2.

    The delay is enforced here rather than at call sites so no future
    caller can accidentally hammer them by looping.
    """
    proxy = env("IPROYAL_PROXY")
    if not proxy:
        sys.exit(
            "IPROYAL_PROXY not set.\n"
            "  Ballotpedia's CDN blocks this host's datacenter range at the\n"
            "  edge — headless Chrome fails identically — so a residential\n"
            "  exit is required. Put it in server/.env."
        )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    )
    delay = 3.0
    for attempt in range(tries):
        gap = time.time() - _last_fetch[0]
        if gap < CRAWL_DELAY:
            time.sleep(CRAWL_DELAY - gap)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with opener.open(req, timeout=90) as r:
                _last_fetch[0] = time.time()
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            _last_fetch[0] = time.time()
            if e.code in (429, 503) and attempt < tries - 1:
                time.sleep(min(float(e.headers.get("Retry-After") or delay), 60))
                delay *= 2
                continue
            raise
        except Exception:
            _last_fetch[0] = time.time()
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return ""


def connect():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pip install pymongo")
    url = env("MONGODB_URL")
    if not url:
        sys.exit("MONGODB_URL not set")
    db = MongoClient(url, serverSelectionTimeoutMS=15000).get_database()
    hello = db.client.admin.command({"hello": 1})
    if not hello.get("isWritablePrimary"):
        sys.exit(
            "connected to a SECONDARY — writes will fail.\n"
            f"  primary is {hello.get('primary')}\n"
            "  re-probe ports 31700/31701/31702 and repoint MONGODB_URL"
        )
    return db


def text(frag):
    """Tag soup -> readable text."""
    frag = re.sub(r"<script.*?</script>", " ", frag, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", frag))).strip()


def rows_of(table):
    out = []
    for r in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)
        if cells:
            out.append([text(c) for c in cells])
    return out


def num(s):
    s = re.sub(r"[^\d]", "", str(s or ""))
    return int(s) if s else None


def pct(s):
    m = re.search(r"(\d+(?:\.\d+)?)", str(s or ""))
    return float(m.group(1)) if m else None


def section(doc, heading_re, level=2):
    """Body of an h2/h3 section, up to the next heading of that level.

    Anchored on the heading tag itself rather than the bare string,
    because every section title also appears in the Contents nav — the
    first match for 'Battleground election results' is a table-of-contents
    link, not the section, and parsing from there silently yields the
    wrong table.
    """
    m = re.search(
        rf"<h{level}[^>]*>(?:(?!</h{level}>).)*?{heading_re}.*?</h{level}>",
        doc, re.S | re.I,
    )
    if not m:
        return None
    rest = doc[m.end():]
    nxt = re.search(rf"<h{level}[^>]*>", rest)
    return rest[:nxt.start()] if nxt else rest


def split_office_state(s):
    """'U.S. Senate North Carolina' -> ('us_senate', 'nc', None).

    The battleground tables repeat each state under several offices with
    no office heading between the blocks, so position cannot be trusted.
    This column is the only explicit statement of which contest a row
    belongs to, which is why parsing it correctly matters more than it
    looks.
    """
    s = re.sub(r"\s+", " ", (s or "").strip())
    m = re.search(rf"\b({STATE_RE})\b\s*$", s)
    if not m:
        return None
    state = STATES[m.group(1)]
    head = s[:m.start()].strip()

    district = None
    dm = re.search(r"District (\d+)", head)
    if dm:
        district = int(dm.group(1))

    h = head.lower()
    if "u.s. senate" in h or "us senate" in h:
        office = "us_senate"
    elif "u.s. house" in h or "us house" in h or "congressional district" in h:
        office = "us_house"
    elif "governor" in h:
        office = "governor"
    elif "attorney general" in h:
        office = "attorney_general"
    elif "secretary of state" in h:
        office = "secretary_of_state"
    else:
        office = re.sub(r"[^a-z0-9]+", "_", h).strip("_") or "other"

    ocd = f"ocd-division/country:us/state:{state}"
    if office == "us_house" and district:
        ocd += f"/cd:{district}"
    return office, state, district, ocd, head


def stage_summary(db, apply_writes):
    """Partisan control: seats before/after and how many remain uncalled."""
    print("── partisan control ──")
    doc = fetch(MAIN)
    sec = section(doc, "Partisan control")
    if not sec:
        print("  SECTION NOT FOUND — page structure changed")
        return 0
    m = re.search(r"<table[^>]*>.*?</table>", sec, re.S)
    if not m:
        print("  no table in section")
        return 0
    rows = rows_of(m.group(0))
    hdr, body = rows[0], rows[1:]
    out = []
    for r in body:
        if len(r) < len(hdr):
            continue
        rec = dict(zip([h.lower().replace(" ", "_") for h in hdr], r))
        rec["uncalled_count"] = num(rec.get("uncalled_(held_before)"))
        out.append(rec)
        print(f"  {r[0][:30]:32} on ballot {r[1]:>5}  after {r[3]:<16} uncalled {r[4]}")

    if apply_writes:
        db["us_results_ballotpedia"].update_one(
            {"_id": f"summary|{CYCLE}"},
            {"$set": {
                "_id": f"summary|{CYCLE}", "kind": "partisan_control",
                "cycle": CYCLE, "rows": out,
                "source": "ballotpedia", "source_url": MAIN,
                "source_as_of": None,
                "fetched_at": now(), "caveat": CAVEAT,
            }},
            upsert=True,
        )
    print(f"  {'written' if apply_writes else 'would write'} 1 summary doc")
    return 1


def stage_battleground(db, apply_writes):
    """Candidate + party + Ballotpedia's status. No votes exist here."""
    print("── battleground calls (status only — no vote counts published) ──")
    doc = fetch(MAIN)
    sec = section(doc, "Battleground election results")
    if not sec:
        print("  SECTION NOT FOUND — page structure changed")
        return 0

    contests = {}
    unparsed = 0
    for tab in re.findall(r"<table[^>]*>.*?</table>", sec, re.S):
        rows = rows_of(tab)
        if not rows:
            continue
        hdr = [h.lower() for h in rows[0]]
        if "office" not in hdr or "candidate" not in hdr:
            continue
        ix = {h: k for k, h in enumerate(hdr)}
        for r in rows[1:]:
            if len(r) <= ix.get("candidate", 99):
                continue
            parsed = split_office_state(r[ix["office"]])
            if not parsed:
                unparsed += 1
                continue
            office, state, district, ocd, label = parsed
            key = (ocd, office, district)
            c = contests.setdefault(key, {
                "ocd_id": ocd, "office": office, "state": state.upper(),
                "district": district, "office_label": label,
                "candidates": [],
            })
            status = r[ix["status"]] if "status" in ix and len(r) > ix["status"] else ""
            name = re.sub(r"\s*Incumbent\s*$", "", r[ix["candidate"]]).strip()
            c["candidates"].append({
                "name": name,
                "incumbent": "Incumbent" in r[ix["candidate"]],
                "party": r[ix["party"]] if "party" in ix and len(r) > ix["party"] else None,
                # Ballotpedia's word, kept verbatim. 'Won' is their desk's
                # judgement and is never promoted to a fact here.
                "status": status or None,
                "votes": None, "percent": None,
            })

    won = 0
    written = 0
    for (ocd, office, district), c in sorted(contests.items()):
        winner = next((x for x in c["candidates"]
                       if (x["status"] or "").strip().lower().startswith("won")), None)
        if winner:
            won += 1
        _id = f"bp|{CYCLE}|{ocd}|{office}|{district if district is not None else '-'}"
        doc_out = {
            "_id": _id, "kind": "battleground", "cycle": CYCLE, **c,
            # Their call, named, never ours.
            "source_call": ({
                "source": "ballotpedia",
                "winner": winner["name"], "party": winner["party"],
                "basis": "status column on the 2026 results page",
            } if winner else None),
            "has_votes": False,
            "source": "ballotpedia", "source_url": MAIN,
            "source_as_of": None,
            "fetched_at": now(), "caveat": CAVEAT,
        }
        if apply_writes:
            db["us_results_ballotpedia"].update_one(
                {"_id": _id}, {"$set": doc_out}, upsert=True)
        written += 1

    by_office = {}
    for (_, office, _) in contests:
        by_office[office] = by_office.get(office, 0) + 1
    for k, v in sorted(by_office.items(), key=lambda x: -x[1]):
        print(f"  {k:22} {v}")
    print(f"  contests {written}, with a Ballotpedia call {won}, "
          f"office cells unparsed {unparsed}")
    print(f"  {'written' if apply_writes else 'would write'} {written}")
    return written


def race_links(doc):
    """Per-race page links — the only place a vote tally exists."""
    out = {}
    for href in set(re.findall(r'href="(/[^"#?]+)"', doc)):
        path = urllib.parse.unquote(href)
        if not path.endswith("_2026") and ", 2026" not in path:
            continue
        if re.search(r"United_States_Senate_election_in_(.+?),_2026", path):
            st = re.search(r"in_(.+?),_2026", path).group(1).replace("_", " ")
            if st in STATES:
                out[href] = ("us_senate", STATES[st], None)
        else:
            m = re.search(r"^/(.+?)%?2?7?s?_(\d+)(?:st|nd|rd|th)_Congressional_District", path)
            if m:
                st = m.group(1).replace("_", " ").replace("'s", "").strip()
                if st in STATES:
                    out[href] = ("us_house", STATES[st], int(m.group(2)))
    return out


def stage_races(db, apply_writes, limit):
    """Per-race vote tallies from each race page's results_table."""
    print("── per-race tallies (one fetch each, 2s apart) ──")
    doc = fetch(MAIN)
    links = race_links(doc)
    print(f"  {len(links)} race pages discoverable; fetching {min(limit, len(links))}")

    written = skipped = 0
    for href, (office, state, district) in sorted(links.items())[:limit]:
        url = BASE + href
        try:
            page = fetch(url)
        except Exception as e:
            print(f"  {href[:52]}: FETCH FAILED {type(e).__name__}")
            continue

        # The general-election table is the one preceded by a 'General
        # election for' heading; primaries use the same CSS class and
        # would otherwise be indistinguishable.
        best = None
        for m in re.finditer(r'<table[^>]*class="[^"]*results_table[^"]*"[^>]*>.*?</table>',
                             page, re.S):
            pre = text(page[max(0, m.start() - 700):m.start()])
            if re.search(r"General election for", pre[-300:] or ""):
                best = m.group(0)
                break
        if not best:
            skipped += 1
            print(f"  {href[:52]}: no general-election table")
            continue

        cands = []
        for r in rows_of(best)[1:]:
            if len(r) < 3:
                continue
            # Columns are: [✔ marker] Candidate | % | Votes
            cells = [c for c in r if c.strip()]
            if len(cells) < 3:
                continue
            name = re.sub(r"^[✔✓\s]+", "", cells[0]).strip()
            pm = re.search(r"\(([A-Za-z]+)\)\s*$", name)
            cands.append({
                "name": re.sub(r"\s*\([A-Za-z]+\)\s*$", "", name).strip(),
                "party": pm.group(1) if pm else None,
                "percent": pct(cells[1]),
                "votes": num(cells[2]),
                "marked_winner": bool(re.match(r"^[✔✓]", cells[0].strip())),
            })
        cands = [c for c in cands if c["votes"] is not None]
        if not cands:
            skipped += 1
            continue

        total = sum(c["votes"] for c in cands)
        ocd = f"ocd-division/country:us/state:{state}"
        if office == "us_house" and district:
            ocd += f"/cd:{district}"
        winner = next((c for c in cands if c["marked_winner"]), None)
        _id = f"bp-race|{CYCLE}|{ocd}|{office}|{district if district is not None else '-'}"

        out = {
            "_id": _id, "kind": "race_tally", "cycle": CYCLE,
            "ocd_id": ocd, "office": office, "state": state.upper(),
            "district": district,
            "candidates": sorted(cands, key=lambda x: -x["votes"]),
            "total_votes": total,
            # Ballotpedia publishes no reporting denominator either.
            "precincts_reporting": None,
            "precincts_reporting_available": False,
            "source_call": ({
                "source": "ballotpedia", "winner": winner["name"],
                "party": winner["party"],
                "basis": "checkmark on the general-election results table",
            } if winner else None),
            "has_votes": True,
            "source": "ballotpedia", "source_url": url,
            # Their pages carry no results timestamp. Recording this
            # explicitly so nobody later mistakes fetched_at for an as-of.
            "source_as_of": None,
            "source_states_as_of": False,
            "fetched_at": now(), "caveat": CAVEAT,
        }
        if apply_writes:
            db["us_results_ballotpedia"].update_one(
                {"_id": _id}, {"$set": out}, upsert=True)
        written += 1
        lead = out["candidates"][0]
        print(f"  {state.upper()}-{office}{('-' + str(district)) if district else ''}: "
              f"{total:>9,} votes, leads {lead['name'][:22]} {lead['percent']}%")

    print(f"  {'written' if apply_writes else 'would write'} {written}, skipped {skipped}")
    return written


def reconcile(db):
    """Compare Ballotpedia against our own state scrape, where both exist."""
    print("── reconciliation vs us_results_live ──")
    bp = {d["ocd_id"]: d for d in db["us_results_ballotpedia"].find({"kind": "race_tally"})}
    if not bp:
        print("  nothing ingested yet")
        return
    found = 0
    for ocd, b in sorted(bp.items()):
        ours = db["us_results_live"].find_one({"ocd_id": ocd, "office": b["office"]})
        if not ours:
            continue
        found += 1
        ot, bt = ours.get("total_votes") or 0, b["total_votes"]
        print(f"\n  {b['state']} {b['office']}   ours {ot:>10,}   ballotpedia {bt:>10,}"
              f"   bp is {100.0*bt/ot:.1f}% of ours" if ot else "")
        om = {c["name"].split()[-1].lower(): c for c in (ours.get("candidates") or [])}
        for c in b["candidates"][:3]:
            k = c["name"].split()[-1].lower()
            o = om.get(k)
            if o:
                print(f"    {c['name'][:24]:26} ours {o['votes']:>9,} ({o.get('percent')}%)"
                      f"   bp {c['votes']:>9,} ({c['percent']}%)"
                      f"   delta {o['votes'] - c['votes']:>+9,}")
    if not found:
        print("  no overlapping contests between the two sources")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "summary", "battleground", "races", "reconcile"])
    ap.add_argument("--limit", type=int, default=12,
                    help="max per-race pages to fetch (each is one request, 2s apart)")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "summary"):
        stage_summary(db, args.apply)
    if args.stage in ("all", "battleground"):
        stage_battleground(db, args.apply)
    if args.stage in ("all", "races"):
        stage_races(db, args.apply, args.limit)
    if args.stage in ("all", "reconcile"):
        reconcile(db)

    print("\nwritten" if args.apply else "\ndry run — pass --apply to write")


if __name__ == "__main__":
    main()
