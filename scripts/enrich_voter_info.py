#!/usr/bin/env python3
"""
What a person actually needs in order to vote, per state.

`us_voter_info` held a name and a link to a state election office. That
answers nothing a voter asks. This fills in the ID rules, the registration
and mail deadlines, the early-voting window and the state's own lookup
tools, each carrying the source it came from and the date it was checked.

THE ACCURACY RULE, AND WHY THIS SCRIPT STORES PROSE
---------------------------------------------------
Every other dataset in this project can be wrong in a way that embarrasses
us. This one can be wrong in a way that costs somebody their vote. So the
default is to store the source's own words VERBATIM rather than parse them
into a tidy boolean.

That is deliberate, not laziness. Real rules are conditional:

    "In Person: 15 days before Election Day. By Mail: Postmarked 15 days
     before Election Day."

    "Varies by location, but 15 days before Election Day in most areas."

Reducing either to a single date produces a confident answer that is wrong
for some readers. A derived flag is written ONLY where the source is itself
categorical — vote.org's Election Day Registration column is literally
"N/A" or a description, so same_day is safe; and an early-voting cell
saying "<State> does not have early voting" is an explicit negative.

WHAT IS DELIBERATELY MISSING
----------------------------
The voter-ID STRICTNESS taxonomy (strict-photo / photo-requested /
non-photo / no-ID) is NCSL's, and NCSL returns 403 to automated clients on
all four of its comparison tables (verified 2026-09-21). Classifying a
state from vote.org's prose would be inventing NCSL's judgement, and
"strict photo ID" is exactly the claim that sends someone to a polling
place with the wrong document. It is therefore absent, and recorded as
absent in scripts/data/voter_info_sources.json.

Google Civic contributes nothing yet: for electionId 12000 the state block
carries a name and a VIP source stub, with no electionAdministrationBody
and no URLs.

Every row gets a blunt `caveat` and keeps the official state election
office URL, because the state's own site is the authority and our summary
is not.

Usage:
    python3 scripts/enrich_voter_info.py --stage requirements [--apply]
    python3 scripts/enrich_voter_info.py --stage polling2026 [--apply]
    python3 scripts/enrich_voter_info.py --stage all --apply

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

UA = "OSElectionInt-research/1.0 (civic data; contact via repo)"

# vote.org has no robots.txt directive against this, but it is someone
# else's server. Serial, identified, unhurried.
DELAY = 1.5

VOTE_ORG = "https://www.vote.org"
PAGES = {
    "id": "/voter-id-laws/",
    "registration": "/voter-registration-deadlines/",
    "early": "/early-voting-calendar/",
    "mail_deadlines": "/absentee-ballot-deadlines/",
    "mail_rules": "/absentee-voting-rules/",
}

CIVIC = "https://www.googleapis.com/civicinfo/v2/voterinfo"
ELECTION_ID = "12000"          # 2026 General Midterm, verified live

CAVEAT = (
    "Summary compiled from the cited sources on the date shown. Election "
    "rules change and can be conditional or litigated; the state's own "
    "election office is the authority and governs. Always confirm with the "
    "official links before relying on this."
)

STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT",
    "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL",
    "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY",
    "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
    "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH",
    "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
    "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
    "Wisconsin": "WI", "Wyoming": "WY",
}

# One address per state, used ONLY to probe Civic. See stage_polling2026 for
# why this is a sample and not a survey.
CAPITOLS = {
    "AL": "600 Dexter Ave, Montgomery, AL 36104",
    "AK": "120 4th St, Juneau, AK 99801",
    "AZ": "1700 W Washington St, Phoenix, AZ 85007",
    "AR": "500 Woodlane St, Little Rock, AR 72201",
    "CA": "1315 10th St, Sacramento, CA 95814",
    "CO": "200 E Colfax Ave, Denver, CO 80203",
    "CT": "210 Capitol Ave, Hartford, CT 06106",
    "DE": "411 Legislative Ave, Dover, DE 19901",
    "DC": "1350 Pennsylvania Ave NW, Washington, DC 20004",
    "FL": "400 S Monroe St, Tallahassee, FL 32399",
    "GA": "206 Washington St SW, Atlanta, GA 30334",
    "HI": "415 S Beretania St, Honolulu, HI 96813",
    "ID": "700 W Jefferson St, Boise, ID 83702",
    "IL": "401 S 2nd St, Springfield, IL 62706",
    "IN": "200 W Washington St, Indianapolis, IN 46204",
    "IA": "1007 E Grand Ave, Des Moines, IA 50319",
    "KS": "300 SW 10th Ave, Topeka, KS 66612",
    "KY": "700 Capital Ave, Frankfort, KY 40601",
    "LA": "900 N 3rd St, Baton Rouge, LA 70802",
    "ME": "210 State St, Augusta, ME 04330",
    "MD": "100 State Cir, Annapolis, MD 21401",
    "MA": "24 Beacon St, Boston, MA 02133",
    "MI": "100 N Capitol Ave, Lansing, MI 48933",
    "MN": "75 Rev Dr Martin Luther King Jr Blvd, Saint Paul, MN 55155",
    "MS": "400 High St, Jackson, MS 39201",
    "MO": "201 W Capitol Ave, Jefferson City, MO 65101",
    "MT": "1301 E 6th Ave, Helena, MT 59601",
    "NE": "1445 K St, Lincoln, NE 68508",
    "NV": "101 N Carson St, Carson City, NV 89701",
    "NH": "107 N Main St, Concord, NH 03301",
    "NJ": "125 W State St, Trenton, NJ 08608",
    "NM": "490 Old Santa Fe Trail, Santa Fe, NM 87501",
    "NY": "State St and Washington Ave, Albany, NY 12224",
    "NC": "1 E Edenton St, Raleigh, NC 27601",
    "ND": "600 E Boulevard Ave, Bismarck, ND 58505",
    "OH": "1 Capitol Sq, Columbus, OH 43215",
    "OK": "2300 N Lincoln Blvd, Oklahoma City, OK 73105",
    "OR": "900 Court St NE, Salem, OR 97301",
    "PA": "501 N 3rd St, Harrisburg, PA 17120",
    "RI": "82 Smith St, Providence, RI 02903",
    "SC": "1100 Gervais St, Columbia, SC 29201",
    "SD": "500 E Capitol Ave, Pierre, SD 57501",
    "TN": "600 Dr M.L.K. Jr Blvd, Nashville, TN 37243",
    "TX": "1100 Congress Ave, Austin, TX 78701",
    "UT": "350 State St, Salt Lake City, UT 84103",
    "VT": "115 State St, Montpelier, VT 05633",
    "VA": "1000 Bank St, Richmond, VA 23219",
    "WA": "416 Sid Snyder Ave SW, Olympia, WA 98504",
    "WV": "1900 Kanawha Blvd E, Charleston, WV 25305",
    "WI": "2 E Main St, Madison, WI 53703",
    "WY": "200 W 24th St, Cheyenne, WY 82001",
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def fetch(url, tries=4):
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < tries - 1:
                time.sleep(min(float(e.headers.get("Retry-After") or delay), 30))
                delay *= 2
                continue
            raise
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return ""


def fetch_json(url, tries=3):
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # Civic answers 404 for "no information for this address", which
            # is data, not a transport failure.
            try:
                return json.load(e)
            except Exception:
                if attempt < tries - 1:
                    time.sleep(delay)
                    delay *= 2
                    continue
                return {"error": {"message": f"HTTP {e.code}"}}
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return {"error": {"message": "unreachable"}}
    return {}


def detag(s):
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def first_table_rows(page_html):
    """Rows of the first <table>, each a list of cell strings."""
    tabs = re.findall(r"<table.*?</table>", page_html, re.S | re.I)
    if not tabs:
        return []
    out = []
    for tr in re.findall(r"<tr.*?</tr>", tabs[0], re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if cells:
            out.append([detag(c) for c in cells])
    return out


def table_links(page_html):
    """href of the first <a> in each cell, positionally aligned with
    first_table_rows — the ballot-tracker column is a link whose TEXT is
    generic ('Track your Texas ballot'); the URL is the useful part."""
    tabs = re.findall(r"<table.*?</table>", page_html, re.S | re.I)
    if not tabs:
        return []
    out = []
    for tr in re.findall(r"<tr.*?</tr>", tabs[0], re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if not cells:
            continue
        row = []
        for c in cells:
            m = re.search(r'href="([^"]+)"', c)
            row.append(m.group(1) if m else None)
        out.append(row)
    return out


def blank(v):
    """vote.org writes 'N/A' for 'this does not exist here'. Treat it, and
    the empty string, as absence — but never as a negative fact on its own."""
    if v is None:
        return True
    s = str(v).strip().lower()
    return s in ("", "n/a", "na", "none", "-", "—")


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


def civic_key():
    k = os.environ.get("GOOGLE_CIVIC_API_KEY")
    if k:
        return k
    env = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
    for line in open(env):
        if line.startswith("GOOGLE_CIVIC_API_KEY="):
            return line.split("=", 1)[1].strip()
    return None


# ── stage 1: requirements ────────────────────────────────────────────────────

def parse_state_table(page_html, want_cols):
    """{postal: {col_name: verbatim text}} from a State-keyed table."""
    rows = first_table_rows(page_html)
    links = table_links(page_html)
    out = {}
    for i, cells in enumerate(rows):
        if not cells:
            continue
        code = STATES.get(cells[0].strip())
        if not code:
            continue                       # header row, or a footnote row
        rec = {}
        for idx, key in want_cols.items():
            if idx < len(cells):
                rec[key] = cells[idx]
        href = None
        if i < len(links):
            for h in links[i][1:]:
                if h:
                    href = h
                    break
        rec["_link"] = href
        out[code] = rec
    return out


def parse_mail_rules(page_html):
    """The absentee-rules page is prose under '<State> absentee ballot rules'
    headings rather than a table, so sections are split on those headings."""
    text = re.sub(r"<script.*?</script>", " ", page_html, flags=re.S | re.I)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
    flat = detag(text)
    out = {}
    names = sorted(STATES, key=len, reverse=True)
    marks = []
    for nm in names:
        for m in re.finditer(re.escape(nm) + r"\s+absentee ballot rules", flat, re.I):
            marks.append((m.start(), m.end(), nm))
    marks.sort()
    # Drop marks swallowed by a longer state name at the same heading.
    # "Arkansas absentee ballot rules" contains "Kansas absentee ballot
    # rules", and "West Virginia" contains "Virginia" — the shorter match
    # starts a few characters later and would otherwise terminate the longer
    # state's section at zero length. Measured: this cost Arkansas and West
    # Virginia their entire mail-voting rules.
    kept = []
    for s_, e_, nm in marks:
        if kept and s_ < kept[-1][1]:
            if (e_ - s_) <= (kept[-1][1] - kept[-1][0]):
                continue                      # contained in a longer match
            kept.pop()                        # this one is longer; replace
        kept.append((s_, e_, nm))
    marks = kept
    for i, (s, e, nm) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(flat)
        body = flat[e:end].strip()
        code = STATES[nm]
        # Keep the longest section found for a state; headings repeat in navs.
        if body and len(body) > len(out.get(code, "")):
            out[code] = body[:1500]
    return out


def stage_requirements(db, apply_writes):
    print("\n── voter requirements (vote.org) ──")
    pages = {}
    for key, path in PAGES.items():
        url = VOTE_ORG + path
        try:
            pages[key] = fetch(url)
            print(f"  fetched {path} ({len(pages[key])} bytes)")
        except Exception as e:
            print(f"  ! FAILED {path}: {e}")
            pages[key] = ""
        time.sleep(DELAY)

    vid = parse_state_table(pages["id"], {1: "in_person", 2: "absentee"})
    reg = parse_state_table(pages["registration"],
                            {1: "deadlines", 2: "election_day_registration"})
    early = parse_state_table(pages["early"],
                              {1: "begins", 2: "ends", 3: "more_info"})
    mail = parse_state_table(pages["mail_deadlines"],
                             {1: "application_deadline", 2: "ballot_due",
                              3: "tracker_label"})
    rules = parse_mail_rules(pages["mail_rules"])

    print(f"  parsed: id={len(vid)} registration={len(reg)} "
          f"early={len(early)} mail={len(mail)} mail_rules={len(rules)}")

    coll = db.get_collection("us_voter_info")
    stamp = now()
    written = 0
    conditional_notes = []

    for code in sorted(set(vid) | set(reg) | set(early) | set(mail)):
        existing = coll.find_one({"_id": code}) or {}
        doc = {"caveat": CAVEAT, "enriched_at": stamp}

        if code in vid:
            v = vid[code]
            doc["voter_id"] = {
                "in_person": v.get("in_person") or None,
                "absentee": v.get("absentee") or None,
                # NCSL's strictness taxonomy is unobtainable (403). Recording
                # the absence beats inventing the classification.
                "strictness": None,
                "strictness_note": (
                    "Not classified. The strict-photo / photo-requested / "
                    "non-photo taxonomy is NCSL's, and NCSL blocks automated "
                    "access; deriving it from prose would be guessing at the "
                    "one field where a wrong answer turns a voter away."),
                "source": "vote.org",
                "source_url": VOTE_ORG + PAGES["id"],
                "checked_at": stamp,
            }

        if code in reg:
            r = reg[code]
            edr = r.get("election_day_registration")
            # The only safe derivation on this page: the column is either the
            # literal "N/A" or a description of how EDR works.
            same_day = None if edr is None else (not blank(edr))
            doc["registration"] = {
                "deadlines": r.get("deadlines") or None,
                "election_day_registration": None if blank(edr) else edr,
                "same_day": same_day,
                "source": "vote.org",
                "source_url": VOTE_ORG + PAGES["registration"],
                "checked_at": stamp,
            }
            if r.get("deadlines") and re.search(r"varies|county|local",
                                               r["deadlines"], re.I):
                conditional_notes.append(f"{code}: registration deadline varies locally")

        if code in early:
            e = early[code]
            begins = e.get("begins") or ""
            # An explicit sentence is a real negative; an empty cell is not.
            offered = None
            if re.search(r"does not have early voting|no early voting",
                         begins, re.I):
                offered = False
            elif begins and not blank(begins):
                offered = True
            doc["early_voting"] = {
                "offered": offered,
                "begins": None if blank(begins) else begins,
                "ends": None if blank(e.get("ends")) else e.get("ends"),
                "more_info": None if blank(e.get("more_info")) else e.get("more_info"),
                "source": "vote.org",
                "source_url": VOTE_ORG + PAGES["early"],
                "checked_at": stamp,
            }
            if begins and re.search(r"varies", begins, re.I):
                conditional_notes.append(f"{code}: early voting window varies locally")

        tracker = None
        if code in mail:
            m = mail[code]
            tracker = m.get("_link")
            doc["mail_voting"] = {
                "application_deadline": None if blank(m.get("application_deadline"))
                else m.get("application_deadline"),
                "ballot_due": None if blank(m.get("ballot_due")) else m.get("ballot_due"),
                "rules": rules.get(code),
                # Whether a state is no-excuse is an NCSL table (403). The
                # prose in `rules` usually says, but parsing a yes/no out of
                # it would be the same flattening the ID field refuses.
                "no_excuse": None,
                "source": "vote.org",
                "source_url": VOTE_ORG + PAGES["mail_deadlines"],
                "rules_source_url": VOTE_ORG + PAGES["mail_rules"],
                "checked_at": stamp,
            }

        doc["official_links"] = {
            "election_office": existing.get("election_office_url"),
            "ballot_tracker": tracker,
            "note": "The state election office is the authority for all of the above.",
        }

        if apply_writes:
            coll.update_one({"_id": code}, {"$set": doc}, upsert=True)
        written += 1

    print(f"  {'wrote' if apply_writes else 'would write'} {written} states")
    if conditional_notes:
        print(f"  conditional rules kept verbatim ({len(conditional_notes)}):")
        for n in conditional_notes[:8]:
            print(f"    {n}")

    if apply_writes:
        db.get_collection("us_voter_info_meta").update_one(
            {"_id": "sources"},
            {"$set": {
                "checked_at": stamp,
                "caveat": CAVEAT,
                "manifest": json.load(open(os.path.join(
                    os.path.dirname(__file__), "data",
                    "voter_info_sources.json"))),
            }}, upsert=True)
    return written


# ── stage 2: the 2026 polling poller ─────────────────────────────────────────

def stage_polling2026(db, apply_writes, limit):
    """Current polling locations, written to their own collection.

    Verified before writing this: Civic returns the 2026 election but ZERO
    pollingLocations — VIP feeds populate close to election day. Finding
    nothing today is the correct result, not a failure, so this is built to
    be run daily until the data appears.

    ON SAMPLING, HONESTLY: Civic is address-keyed with no bulk endpoint, so
    complete coverage would mean one query per household. This probes ONE
    address per state — the state capitol. That is enough to detect the
    moment a state's feed goes live; it is NOT a survey of that state's
    polling places, and nothing downstream may present it as one. Every
    document carries sampled_from and a coverage caveat saying so.
    """
    print("\n── 2026 polling locations (Google Civic) ──")
    key = civic_key()
    if not key:
        print("  ! GOOGLE_CIVIC_API_KEY not set — skipping")
        return 0

    coll = db.get_collection("us_polling_2026")
    stamp = now()
    found = total_states = 0
    errors = {}

    for code, addr in list(CAPITOLS.items())[:limit]:
        url = (f"{CIVIC}?key={urllib.parse.quote(key)}"
               f"&address={urllib.parse.quote(addr)}"
               f"&electionId={ELECTION_ID}")
        d = fetch_json(url)
        total_states += 1
        if "error" in d:
            errors[code] = str(d["error"].get("message"))[:40]
            time.sleep(0.4)
            continue

        for kind in ("pollingLocations", "earlyVoteSites", "dropOffLocations"):
            for loc in d.get(kind) or []:
                a = loc.get("address") or {}
                line = " ".join(filter(None, [
                    a.get("line1"), a.get("line2"), a.get("city"),
                    a.get("state"), a.get("zip")]))
                lat, lng = loc.get("latitude"), loc.get("longitude")
                doc = {
                    "_id": f"{code}:{kind}:{hash(line) & 0xffffffff:08x}",
                    "state": code,
                    "kind": kind,
                    "name": a.get("locationName"),
                    "address": line,
                    "hours": loc.get("pollingHours"),
                    "notes": loc.get("notes"),
                    "start_date": loc.get("startDate"),
                    "end_date": loc.get("endDate"),
                    "election_id": ELECTION_ID,
                    "source": "Google Civic / Voting Information Project",
                    "sampled_from": addr,
                    "coverage": (
                        "Found by probing one representative address per "
                        "state. This is a sample that proves the feed is "
                        "live, NOT a complete list of this state's "
                        "locations. Use the official state lookup."),
                    "fetched_at": stamp,
                }
                if lat and lng:
                    doc["geometry"] = {"type": "Point",
                                       "coordinates": [float(lng), float(lat)]}
                if apply_writes:
                    coll.update_one({"_id": doc["_id"]}, {"$set": doc},
                                    upsert=True)
                found += 1
        time.sleep(0.4)

    if apply_writes and found:
        try:
            coll.create_index([("geometry", "2dsphere")])
            coll.create_index([("state", 1), ("kind", 1)])
        except Exception as e:
            print(f"  ! index: {e}")

    print(f"  probed {total_states} states, found {found} locations")
    if errors:
        print(f"  no data / error for {len(errors)} states "
              f"(expected this far out): "
              + ", ".join(f"{k}={v}" for k, v in list(errors.items())[:6]))
    if found == 0:
        print("  0 is the CORRECT result today — VIP feeds populate close to "
              "election day. Re-run daily; this fills itself.")
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "requirements", "polling2026"])
    ap.add_argument("--limit", type=int, default=60,
                    help="max states to probe in polling2026")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "requirements"):
        stage_requirements(db, args.apply)
    if args.stage in ("all", "polling2026"):
        stage_polling2026(db, args.apply, args.limit)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
