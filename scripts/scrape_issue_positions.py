#!/usr/bin/env python3
"""
Issue positions from OnTheIssues.org.

Three stages:

  index      Harvest the name -> page-URL map from OnTheIssues' own index
             pages. URLs are NOT constructed: the site uses at least four
             schemes (/Senate/Name.htm, /House/Name.htm, /NY/Name.htm and
             bare /Name.htm for governors) with no rule connecting a person
             to theirs, so guessing produces 404s and, worse, silent misses.

  positions  Fetch each matched person's page and parse topic, quote count
             and the dated position excerpts, into `us_issue_positions`.

  roster     Parse the curated 2026 race roster that candidate pages carry,
             into `us_race_roster`. These are OnTheIssues' EDITORIAL claims,
             not certified filings, and are kept in their own collection so
             they can never be mistaken for FEC data.

WHY QUOTE COUNTS ARE A FIRST-CLASS FIELD
----------------------------------------
Coverage is severely incumbency-biased. Measured on three Texas Senate
figures before writing any of this:

    Ted Cruz        (incumbent, 13 years)   24 topics   415 quotes
    John Cornyn     (incumbent, 23 years)   24 topics   147 quotes
    James Talarico  (challenger)             4 topics     8 quotes

Talarico is not a man without convictions; he is a man without a long federal
paper trail. A UI that renders "positions per candidate" without showing how
much was found will make every challenger look evasive, which is the exact
opposite of what this dataset is for. So `quote_count` is stored per topic,
`total_quotes` per person, and a `coverage` note is stamped on every record
stating that a missing topic means NOTHING WAS RECORDED, never "no position".

Nothing here derives a lean, score, summary or label from these quotes.

Usage:
    python3 scripts/scrape_issue_positions.py --stage index [--apply]
    python3 scripts/scrape_issue_positions.py --stage positions --min-receipts 100000 [--apply]
    python3 scripts/scrape_issue_positions.py --stage roster [--apply]
    python3 scripts/scrape_issue_positions.py --stage all --apply

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
import urllib.request

UA = "OSElectionInt-research/1.0 (civic data; contact via repo)"
BASE = "https://www.ontheissues.org/"

# There is no robots.txt (404). That is not permission, so this client is
# deliberately slow, serial and identified. Do not parallelise it.
DELAY = 1.6

# Index pages that between them list every person the site covers. Verified
# 200 and non-trivial; /House/House.htm is a 404 and the House index lives at
# the root instead, which is exactly why these are hardcoded and not derived.
INDEX_PAGES = [
    "House_119.htm",        # 119th Congress, the sitting House
    "Senate/Senate.htm",
    "Governor/Governor.htm",
    "House.htm",
]

# Index/section pages that match the Name_Name.htm shape but are not people.
NOT_A_PERSON = re.compile(
    r"^(Legis|Issue|Candidate|House|Senate|Forum|Background|VoteMatch|"
    r"Senate_Match|House_Vote|Archive|Quiz)_", re.I)

PERSON_HREF = re.compile(
    r"((?:[A-Za-z]{2,10}/)?[A-Z][A-Za-z\.\'\-]+_[A-Z][A-Za-z0-9\.\'\-_]*\.htm)")

# A topic section opens with <a id='Topic'></a>; the count sits in the
# "N full quotes on Topic" link and the positions follow as <li> items.
TOPIC_ANCHOR = re.compile(r"<a\s+id=['\"]([A-Za-z0-9_&\-\+ ]+)['\"]\s*>\s*</a>", re.I)
QUOTE_COUNT = re.compile(r">\s*(\d+)\s+full quotes? on ([^<]+?)\s*</a>", re.I)
LI_ITEM = re.compile(r"<li>(.*?)(?=<li>|</ul>|</td>)", re.S | re.I)
DATED = re.compile(r"\(([A-Z][a-z]{2}\s+\d{4})\)\s*$")

# "AK : Dan Sullivan (R,incumbent) vs. Andy Barr (R) vs. Mary Peltola (D)"
ROSTER_LINE = re.compile(
    r"\b([A-Z]{2})\s*:\s*((?:[^:]|:(?!\s))*?)(?=\s+[A-Z]{2}\s*:|$)")
ROSTER_PERSON = re.compile(
    r"([A-Z][A-Za-z\.\'\-]+(?:\s+[A-Z][A-Za-z\.\'\-]+)+)\s*\(([^)]*)\)")

SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv)\.?$", re.I)
HONORIFIC = re.compile(r"\b(sen|rep|gov|dr|mr|mrs|ms|the honorable)\b\.?", re.I)

COVERAGE_NOTE = (
    "Positions are compiled by OnTheIssues.org and coverage is heavily "
    "incumbency-biased: a long-serving member accumulates hundreds of recorded "
    "quotes while a first-time challenger may have a handful or none. A topic "
    "that does not appear here means NOTHING WAS RECORDED for it, never that "
    "the person has no position. quote_count and total_quotes are provided so "
    "documentation density can be shown alongside the positions themselves. "
    "No lean, score or summary label is derived from this material."
)

ROSTER_NOTE = (
    "Race rosters are OnTheIssues.org's editorial compilation, including their "
    "status annotations (incumbent / retiring / nominee / withdrew / lost "
    "primary / appointee). They are NOT certified filings and are deliberately "
    "kept apart from FEC-derived candidate records, which use different names "
    "and include everyone who filed."
)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


_last_fetch = [0.0]


def fetch(url, tries=4):
    """Serial, rate-limited GET. Returns '' on a 404 rather than raising —
    a missing person page is an ordinary outcome here, not an error."""
    gap = time.time() - _last_fetch[0]
    if gap < DELAY:
        time.sleep(DELAY - gap)
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                _last_fetch[0] = time.time()
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            _last_fetch[0] = time.time()
            if e.code == 404:
                return ""
            if e.code in (429, 503) and attempt < tries - 1:
                time.sleep(min(float(e.headers.get("Retry-After") or delay), 30))
                delay *= 2
                continue
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return ""
        except Exception:
            _last_fetch[0] = time.time()
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return ""
    return ""


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


def taxonomy():
    p = os.path.join(os.path.dirname(__file__), "data", "issue_taxonomy.json")
    with open(p) as f:
        return json.load(f)


# ── name handling ───────────────────────────────────────────────────────────

def normalise(name):
    """FEC writes 'John Sen Cornyn' and 'Rafael Edward Ted Cruz'."""
    n = html.unescape(name or "")
    n = re.sub(r"\s+", " ", n).strip()
    n = HONORIFIC.sub("", n)
    n = SUFFIX.sub("", n).strip()
    return re.sub(r"\s+", " ", n)


def name_key(name):
    """first+last, lowercased. Middle names and initials are dropped because
    the two corpora disagree about them constantly."""
    n = normalise(name).lower()
    n = re.sub(r"[^a-z\s\-']", " ", n)
    parts = [p for p in n.split() if len(p) > 1]
    if len(parts) < 2:
        return " ".join(parts)
    return f"{parts[0]} {parts[-1]}"


def url_to_name(u):
    """'Senate/James_Talarico.htm' -> 'James Talarico'"""
    leaf = u.rsplit("/", 1)[-1][:-4]
    return leaf.replace("_", " ")


# ── stage 1: index ──────────────────────────────────────────────────────────

def stage_index(db, apply_writes):
    """Harvest every person page OnTheIssues links from its own indexes."""
    print("\n── index harvest ──")
    found = {}
    for page in INDEX_PAGES:
        t = fetch(BASE + page)
        if not t:
            print(f"  {page:26s} FAILED")
            continue
        hits = set()
        for m in PERSON_HREF.findall(t):
            leaf = m.rsplit("/", 1)[-1]
            if NOT_A_PERSON.match(leaf):
                continue
            hits.add(m)
        for h in hits:
            found.setdefault(name_key(url_to_name(h)), h)
        print(f"  {page:26s} {len(hits):5d} person links")

    print(f"  {len(found)} unique people after de-duplication")
    if apply_writes:
        col = db.get_collection("us_oti_index")
        col.delete_many({})
        col.insert_many([
            {"_id": k, "url": v, "name": url_to_name(v),
             "source": "ontheissues.org", "retrieved_at": now()}
            for k, v in found.items()])
        col.create_index("url")
    return found


def load_index(db):
    rows = list(db.get_collection("us_oti_index").find({}, {"url": 1}))
    return {r["_id"]: r["url"] for r in rows}


# ── stage 2: positions ──────────────────────────────────────────────────────

def parse_person(htm):
    """Topic -> {quote_count, positions[]} from one person page.

    Segmentation uses the <a id='Topic'></a> anchors rather than the flattened
    text, because the text runs one topic's excerpts straight into the next
    topic's heading with nothing to split on.
    """
    anchors = list(TOPIC_ANCHOR.finditer(htm))
    out = {}
    for i, a in enumerate(anchors):
        start = a.end()
        end = anchors[i + 1].start() if i + 1 < len(anchors) else len(htm)
        block = htm[start:end]

        cm = QUOTE_COUNT.search(block)
        if not cm:
            continue
        count = int(cm.group(1))
        topic = html.unescape(cm.group(2)).strip()

        positions = []
        for li in LI_ITEM.findall(block):
            txt = re.sub(r"<[^>]+>", " ", li)
            txt = re.sub(r"\s+", " ", html.unescape(txt)).strip()
            if len(txt) < 8:
                continue
            d = DATED.search(txt)
            positions.append({
                "text": DATED.sub("", txt).strip() if d else txt,
                "dated": d.group(1) if d else None,
            })
        out[topic] = {"quote_count": count, "positions": positions}
    return out


STATE_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida",
    "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky",
    "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
    "GU": "Guam", "VI": "Virgin Islands", "AS": "American Samoa",
    "MP": "Northern Mariana Islands",
}


def page_text(htm, chars=4000):
    """Strip scripts and tags FIRST, then window.

    Windowing raw HTML is a trap on this site: the first 6000 bytes are almost
    entirely <script> and ad boilerplate, so a naive page_html[:6000] yields
    about 500 characters of real content and the person's own state never
    appears in it. Stripping first puts the identifying line — e.g. "Texas
    Senator Ted Cruz (Republican Jr Senator)" — within the first few hundred
    characters, where it belongs.
    """
    t = re.sub(r"<script.*?</script>", " ", htm, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", html.unescape(t))[:chars]


def match_confidence(our_name, our_state, page_name, page_html):
    """How much we trust that this page is this person.

    Name alone is not enough — Mike Collins and Susan Collins both sit in
    Congress, and this corpus has several Chris Joneses. The page names the
    person's state in its own header, so that corroborates. Both the postal
    abbreviation and the full state name are checked, because OnTheIssues
    writes "Texas Senator ..." in prose and "TX Senators:" in navigation.
    """
    if name_key(our_name) != name_key(page_name):
        return 0.0, "key-mismatch"
    if not our_state:
        return 0.6, "name-only"
    head = page_text(page_html)
    abbr = str(our_state).upper()
    full = STATE_NAME.get(abbr)
    pats = [re.escape(abbr)] + ([re.escape(full)] if full else [])
    if re.search(r"\b(?:" + "|".join(pats) + r")\b", head):
        return 0.95, "name+state"
    return 0.6, "name-only"


def people_to_scrape(db, min_receipts, limit):
    """Officeholders first, then 2026 filers above a money floor.

    The floor exists because 4,294 people filed and most raised nothing; at
    1.6s per request the tail would cost hours to confirm that OnTheIssues has
    never heard of them either.
    """
    seen, out = set(), []
    for o in db.get_collection("us_officeholders").find(
            {}, {"name": 1, "state": 1, "party": 1, "office": 1, "bioguide": 1}):
        k = name_key(o.get("name", ""))
        if not k or k in seen:
            continue
        seen.add(k)
        out.append({"key": k, "name": o["name"], "state": o.get("state"),
                    "party": o.get("party"), "office": o.get("office"),
                    "bioguide": o.get("bioguide"), "role": "officeholder",
                    "ref": {"collection": "us_officeholders", "id": o["_id"]}})

    q = {"cycle": 2026, "receipts": {"$gte": min_receipts}}
    for c in db.get_collection("us_candidates").find(
            q, {"name": 1, "state": 1, "party": 1, "office": 1,
                "fec_id": 1, "receipts": 1, "status": 1}).sort("receipts", -1):
        k = name_key(c.get("name", ""))
        if not k or k in seen:
            continue
        seen.add(k)
        out.append({"key": k, "name": c["name"], "state": c.get("state"),
                    "party": c.get("party"), "office": c.get("office"),
                    "fec_id": c.get("fec_id"), "receipts": c.get("receipts"),
                    "role": c.get("status") or "candidate",
                    "ref": {"collection": "us_candidates", "id": c["_id"]}})
    return out[:limit] if limit else out


def stage_positions(db, apply_writes, min_receipts, limit):
    print("\n── positions ──")
    idx = load_index(db)
    if not idx:
        print("  no index in Mongo — run --stage index --apply first")
        return
    print(f"  index holds {len(idx)} people")

    tax = taxonomy()
    topic_map = tax["map"]
    targets = people_to_scrape(db, min_receipts, limit)
    print(f"  {len(targets)} people to try "
          f"(officeholders + 2026 filers >= ${min_receipts:,})")

    col = db.get_collection("us_issue_positions")
    attempted = matched = withpos = rejected = 0
    stats = {"officeholder": [], "challenger": [], "other": []}

    for i, p in enumerate(targets, 1):
        attempted += 1
        url_path = idx.get(p["key"])
        if not url_path:
            continue
        htm = fetch(BASE + url_path)
        if not htm:
            continue
        conf, why = match_confidence(
            p["name"], p.get("state"), url_to_name(url_path), htm)
        if conf < 0.9:
            # Never attach a position to a person on a name alone. A wrong
            # position on a named politician is worse than a missing one.
            rejected += 1
            continue
        matched += 1

        topics = parse_person(htm)
        total = sum(t["quote_count"] for t in topics.values())
        if total:
            withpos += 1

        bucket = ("officeholder" if p["role"] == "officeholder"
                  else "challenger" if "challeng" in str(p["role"]).lower()
                  else "other")
        stats[bucket].append(total)

        # Roll the source topics up into product categories. A category sums
        # several topics, so its count is not comparable with a single-topic
        # category — recorded in the taxonomy notes.
        cats = {}
        for topic, body in topics.items():
            for cat in topic_map.get(topic, []):
                c = cats.setdefault(cat, {"quote_count": 0, "topics": []})
                c["quote_count"] += body["quote_count"]
                c["topics"].append(topic)

        doc = {
            "_id": p["key"],
            "name": p["name"],
            "state": p.get("state"),
            "party": p.get("party"),
            "office": p.get("office"),
            "role": p["role"],
            "bioguide": p.get("bioguide"),
            "fec_id": p.get("fec_id"),
            "ref": p["ref"],
            "topics": topics,
            "categories": cats,
            "total_quotes": total,
            "topics_found": len(topics),
            "match_confidence": conf,
            "matched_by": why,
            "source": "ontheissues.org",
            "source_url": BASE + url_path,
            "retrieved_at": now(),
            "coverage": COVERAGE_NOTE,
        }
        if apply_writes:
            col.replace_one({"_id": doc["_id"]}, doc, upsert=True)

        if i % 25 == 0:
            print(f"    {i}/{len(targets)}  matched={matched} "
                  f"withpos={withpos} rejected={rejected}")

    if apply_writes and matched:
        col.create_index("name")
        col.create_index("bioguide")
        col.create_index("fec_id")
        col.create_index("total_quotes")
        db.get_collection("us_issue_meta").update_one(
            {"_id": "positions"},
            {"$set": {"coverage": COVERAGE_NOTE, "taxonomy": tax,
                      "source": "ontheissues.org", "retrieved_at": now(),
                      "attempted": attempted, "matched": matched,
                      "with_positions": withpos, "rejected": rejected}},
            upsert=True)

    def med(xs):
        xs = sorted(xs)
        return xs[len(xs) // 2] if xs else 0

    print(f"\n  attempted {attempted}, matched {matched}, "
          f"with positions {withpos}, rejected low-confidence {rejected}")
    for k, v in stats.items():
        if v:
            print(f"    {k:14s} n={len(v):4d}  median quotes={med(v):4d}  "
                  f"max={max(v)}")
    return stats


# ── stage 3: race roster ────────────────────────────────────────────────────

def stage_roster(db, apply_writes):
    """OnTheIssues' curated 2026 Senate field, with status annotations.

    Worth having because our own candidate table is raw FEC filings: everyone
    who registered, under the name they registered with, including people who
    have since withdrawn. This is a human-maintained view of who is actually
    running. It is stored separately and never merged, because it is an
    editorial claim rather than a filing.
    """
    print("\n── 2026 race roster ──")
    htm = fetch(BASE + "Senate/James_Talarico.htm")
    if not htm:
        print("  source page unavailable")
        return 0
    txt = re.sub(r"<script.*?</script>", " ", htm, flags=re.S | re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = re.sub(r"\s+", " ", html.unescape(txt))

    m = re.search(r"2026 Senate Races(.*?)(?:Other Senate races|$)", txt, re.S)
    if not m:
        print("  roster block not found")
        return 0
    block = m.group(1)

    races, n = [], 0
    for st, body in ROSTER_LINE.findall(block):
        people = []
        for nm, note in ROSTER_PERSON.findall(body):
            note = note.strip()
            party = note.split(",")[0].strip() if note else None
            flags = [f.strip().lower()
                     for f in re.split(r"[,]", note)[1:] if f.strip()]
            # "(D nominee)" packs party and status into one token
            if party and " " in party:
                bits = party.split()
                party = bits[0]
                flags = [" ".join(bits[1:]).lower()] + flags
            people.append({"name": nm.strip(), "party": party,
                           "status_flags": flags})
        if people:
            races.append({"_id": f"2026-senate-{st}", "state": st,
                          "cycle": 2026, "office": "us_senate",
                          "candidates": people,
                          "source": "ontheissues.org",
                          "source_url": BASE + "Senate/James_Talarico.htm",
                          "retrieved_at": now(),
                          "caveat": ROSTER_NOTE})
            n += len(people)

    print(f"  {len(races)} states, {n} listed candidates")
    if races:
        ex = races[0]
        print(f"  sample {ex['state']}: " + "; ".join(
            f"{c['name']} ({c['party']}{'/' + ','.join(c['status_flags']) if c['status_flags'] else ''})"
            for c in ex["candidates"][:4]))
    if apply_writes and races:
        col = db.get_collection("us_race_roster")
        for r in races:
            col.replace_one({"_id": r["_id"]}, r, upsert=True)
        col.create_index("state")
        db.get_collection("us_issue_meta").update_one(
            {"_id": "roster"},
            {"$set": {"caveat": ROSTER_NOTE, "states": len(races),
                      "candidates": n, "retrieved_at": now()}}, upsert=True)
    return len(races)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "index", "positions", "roster"])
    ap.add_argument("--min-receipts", type=int, default=100_000)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "index"):
        stage_index(db, args.apply)
    if args.stage in ("all", "roster"):
        stage_roster(db, args.apply)
    if args.stage in ("all", "positions"):
        stage_positions(db, args.apply, args.min_receipts, args.limit)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
