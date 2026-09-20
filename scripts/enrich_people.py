#!/usr/bin/env python3
"""
Enrich election people with portraits, encyclopaedia links and social handles.

Four stages, because the populations have completely different data
situations and conflating them is how wrong faces get attached to names:

  officeholders  539 sitting members. Joined by BIOGUIDE to the
                 unitedstates/congress-legislators project, which is
                 hand-curated and carries wikipedia/wikidata/ballotpedia/
                 opensecrets/votesmart ids plus verified social handles.
                 Zero ambiguity: the id either matches or it does not.

  sitting        Filers for 2026 who currently hold office. Enrichment is a
                 straight copy from the officeholder row, joined on bioguide
                 and on the officeholder's `fec_ids` array — again id joins.

  wikidata       Filers who have never held federal office. No id exists for
                 them anywhere, so the only route is a NAME, and a name is
                 where portraits go wrong. See the refusal rule below.

  links          Anyone already carrying a QID but missing a Wikipedia link
                 or handles — keyed by QID, so it cannot mis-identify.

The asymmetry is the point. The id stages are exact and safe. The name stage
is probabilistic and deliberately timid: it would rather leave a candidate
faceless than put a stranger's face on them.

THE REFUSAL RULE: a hit is accepted only when exactly ONE entity answers to
the name, is a US human, is a politician (by occupation or by having held a
position), and carries a portrait. Two plausible entities means we cannot
tell them apart, so nothing is written. Measured over the full run this
skipped 28 names, including three different William Lawrences and two Roy
Coopers — every one of which would otherwise have been a coin flip on a
named politician's face.

WHY NOT NAME-MATCH THE EASY STAGES: the FEC files Ted Cruz as "Rafael Edward
Ted Cruz" and John Cornyn as "John Sen Cornyn". Name joins across FEC data
have already broken this project once, rendering both men twice. Every join
here that CAN use an id, does.

ON TRANSPORT: --via wdqs (default) resolves ~120 names per SPARQL query.
--via rest walks the wbsearchentities/wbgetentities pair per name; it is
equally correct and about a hundred times slower — measured, it cleared 28
portraits in twelve minutes before the rate limiter throttled it, which
extrapolates to roughly five hours for the same work WDQS did in four.

Usage:
    python3 scripts/enrich_people.py --stage all --limit 4000 [--apply]
    python3 scripts/enrich_people.py --stage officeholders --apply
    python3 scripts/enrich_people.py --stage wikidata --limit 800 --apply
    python3 scripts/enrich_people.py --stage links --apply

Dry run by default. Nothing is written without --apply.
Stage order matters: `sitting` copies what `officeholders` writes.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.wikidata.org/w/api.php"
UA = "OSElectionInt-enrichment/1.0 (civic data; contact via repo)"

LEG_CURRENT = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
LEG_SOCIAL = "https://unitedstates.github.io/congress-legislators/legislators-social-media.json"

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

# Wikidata social properties. Stored under a `social` subdocument so the shape
# matches what congress-legislators gives us for sitting members.
SOCIAL_PROPS = {
    "P2002": "twitter",
    "P2013": "facebook",
    "P2003": "instagram",
    "P2397": "youtube_id",
    "P7085": "tiktok",
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def fetch_json(url, tries=4):
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return None


def get_json(params, tries=5):
    """Wikidata rate-limits an unauthenticated client hard. A 429 here is
    normal traffic management, not an error to abort on — back off and retry,
    because giving up mid-run leaves the backfill half-applied."""
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
            "props": "claims|descriptions|sitelinks", "languages": "en",
            "sitefilter": "enwiki", "format": "json",
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


def claim_strings(ent, prop):
    vals = []
    for c in ent.get("claims", {}).get(prop, []):
        try:
            v = c["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        if isinstance(v, str):
            vals.append(v)
    return vals


def image_url(ent):
    for fn in claim_strings(ent, "P18"):
        return ("https://commons.wikimedia.org/wiki/Special:FilePath/"
                + urllib.parse.quote(fn) + "?width=300")
    return None


def enwiki_title(ent):
    try:
        return ent["sitelinks"]["enwiki"]["title"]
    except (KeyError, TypeError):
        return None


def wikidata_social(ent):
    out = {}
    for prop, key in SOCIAL_PROPS.items():
        vals = claim_strings(ent, prop)
        if vals:
            out[key] = vals[0]
    return out


def looks_political(ent, desc):
    if US_HINTS.search(desc or ""):
        return True
    if set(claim_qids(ent, "P106")) & POLITICIAN_QIDS:
        return True
    # Held any position, or belongs to a party.
    return bool(claim_qids(ent, "P39")) or bool(claim_qids(ent, "P102"))


WDQS = "https://query.wikidata.org/sparql"

# Wikidata properties pulled per person in the bulk query.
WDQS_PROPS = [("img", "P18"), ("tw", "P2002"), ("fb", "P2013"),
              ("ig", "P2003"), ("yt", "P2397"), ("tt", "P7085")]


def wdqs_batch(names, tries=4):
    """Resolve a batch of names in ONE query against the Wikidata Query Service.

    The per-name REST path (search + wbgetentities) is correct but hopeless at
    this scale: measured, it cleared 28 portraits in ~12 minutes before the
    rate limiter throttled it to a crawl, which extrapolates to roughly five
    hours for the 3,500 candidates who need one. WDQS answers the same
    question for ~120 names in a single round trip.

    The shape of the result needs care. Every OPTIONAL multiplies the rows, so
    a person with two X handles and three images comes back six times — that
    is a cartesian product, not six people. Rows are therefore folded by QID,
    taking the first value seen for each property.

    The filter is deliberately narrow: a human, a US citizen, and either a
    politician by occupation or someone who has held a position. Without that
    last clause a name search will cheerfully return an athlete.
    """
    values = " ".join('"%s"@en' % n.replace('"', '').replace("\\", "")
                      for n in names)
    optionals = "\n".join(
        "  OPTIONAL { ?p wdt:%s ?%s }" % (prop, var) for var, prop in WDQS_PROPS)
    query = """
SELECT ?p ?name ?enwiki %s WHERE {
  VALUES ?name { %s }
  ?p rdfs:label ?name .
  ?p wdt:P31 wd:Q5 .
  ?p wdt:P27 wd:Q30 .
  { ?p wdt:P106 wd:Q82955 } UNION { ?p wdt:P39 ?anypos }
%s
  OPTIONAL { ?enwiki schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
}
""" % (" ".join("?" + v for v, _ in WDQS_PROPS), values, optionals)

    url = WDQS + "?" + urllib.parse.urlencode({"query": query})
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/sparql-results+json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            break
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    else:
        return {}

    # name -> qid -> fields. Folding by qid collapses the OPTIONAL fan-out;
    # keeping a dict per name is what lets us detect two DIFFERENT people
    # sharing a label, which must be skipped rather than guessed at.
    by_name = {}
    for b in d.get("results", {}).get("bindings", []):
        name = b["name"]["value"]
        qid = b["p"]["value"].rsplit("/", 1)[-1]
        slot = by_name.setdefault(name, {}).setdefault(qid, {})
        for var, _ in WDQS_PROPS:
            if var in b and var not in slot:
                slot[var] = b[var]["value"]
        if "enwiki" in b and "enwiki" not in slot:
            slot["enwiki"] = urllib.parse.unquote(
                b["enwiki"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
    return by_name


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


# ── stage 1: officeholders, by bioguide ──────────────────────────────────────

def stage_officeholders(db, apply_writes):
    """Exact id join against congress-legislators. No name matching, so there
    is no ambiguity to adjudicate — a bioguide either matches or it does not."""
    print("\n── officeholders (bioguide join) ──")
    current = fetch_json(LEG_CURRENT)
    social = fetch_json(LEG_SOCIAL)
    print(f"  fetched {len(current)} legislators, {len(social)} social records")

    by_bio = {p["id"]["bioguide"]: p for p in current if p.get("id", {}).get("bioguide")}
    soc_by_bio = {p["id"]["bioguide"]: p.get("social", {})
                  for p in social if p.get("id", {}).get("bioguide")}

    col = db.get_collection("us_officeholders")
    rows = list(col.find({}, {"bioguide": 1, "name": 1}))
    hit = miss = 0
    for r in rows:
        bio = r.get("bioguide")
        p = by_bio.get(bio)
        if not p:
            miss += 1
            continue
        ids = p.get("id", {})
        set_doc = {"enriched_at": now()}
        for src_key, dst_key in (("wikipedia", "wikipedia"),
                                 ("wikidata", "wikidata"),
                                 ("ballotpedia", "ballotpedia"),
                                 ("opensecrets", "opensecrets"),
                                 ("votesmart", "votesmart")):
            v = ids.get(src_key)
            if v not in (None, ""):
                set_doc[dst_key] = v
        soc = soc_by_bio.get(bio)
        if soc:
            set_doc["social"] = soc
            set_doc["social_source"] = "congress-legislators"
        if len(set_doc) > 1:
            hit += 1
            if apply_writes:
                col.update_one({"_id": r["_id"]}, {"$set": set_doc})
    print(f"  matched {hit}, no bioguide match {miss}")
    return hit


# ── stage 2: sitting members who are also 2026 filers ────────────────────────

def stage_sitting(db, apply_writes):
    """Copy officeholder enrichment onto their candidate row.

    Joined on bioguide, which us_candidates already carries for exactly the
    671 filers who currently hold office. Also backfills via the officeholder
    `fec_ids` array so a filer whose bioguide was never stamped still links."""
    print("\n── sitting filers (bioguide / fec_id join) ──")
    oh = db.get_collection("us_officeholders")
    cand = db.get_collection("us_candidates")

    holders = list(oh.find(
        {}, {"bioguide": 1, "fec_ids": 1, "name": 1, "photo": 1,
             "photo_source": 1, "wikipedia": 1, "wikidata": 1,
             "ballotpedia": 1, "opensecrets": 1, "social": 1}))
    by_bio = {h["bioguide"]: h for h in holders if h.get("bioguide")}
    by_fec = {}
    for h in holders:
        for f in (h.get("fec_ids") or []):
            by_fec[f] = h

    rows = list(cand.find({"cycle": 2026},
                          {"bioguide": 1, "fec_id": 1, "name": 1, "photo": 1}))
    hit = 0
    for r in rows:
        h = by_bio.get(r.get("bioguide")) or by_fec.get(r.get("fec_id"))
        if not h:
            continue
        set_doc = {"enriched_at": now()}
        for k in ("wikipedia", "wikidata", "ballotpedia", "opensecrets", "social"):
            v = h.get(k)
            if v not in (None, "", {}):
                set_doc[k] = v
        if h.get("social"):
            set_doc["social_source"] = "congress-legislators"
        # Stamp bioguide where it was missing, so the link is durable.
        if not r.get("bioguide") and h.get("bioguide"):
            set_doc["bioguide"] = h["bioguide"]
        if not r.get("photo") and h.get("photo"):
            set_doc["photo"] = h["photo"]
            set_doc["photo_source"] = h.get("photo_source") or "congress"
        if len(set_doc) > 1:
            hit += 1
            if apply_writes:
                cand.update_one({"_id": r["_id"]}, {"$set": set_doc})
    print(f"  enriched {hit} sitting filers")
    return hit


# ── stage 3: everyone else, via Wikidata name search ─────────────────────────

def wdqs_by_qid(qids, tries=4):
    """Fetch links/social for known QIDs. No name matching, so no ambiguity."""
    values = " ".join("wd:%s" % q for q in qids)
    optionals = "\n".join(
        "  OPTIONAL { ?p wdt:%s ?%s }" % (prop, var) for var, prop in WDQS_PROPS)
    query = """
SELECT ?p ?enwiki %s WHERE {
  VALUES ?p { %s }
%s
  OPTIONAL { ?enwiki schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
}
""" % (" ".join("?" + v for v, _ in WDQS_PROPS), values, optionals)
    url = WDQS + "?" + urllib.parse.urlencode({"query": query})
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/sparql-results+json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            break
        except Exception:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    else:
        return {}
    out = {}
    for b in d.get("results", {}).get("bindings", []):
        qid = b["p"]["value"].rsplit("/", 1)[-1]
        slot = out.setdefault(qid, {})
        for var, _ in WDQS_PROPS:
            if var in b and var not in slot:
                slot[var] = b[var]["value"]
        if "enwiki" in b and "enwiki" not in slot:
            slot["enwiki"] = urllib.parse.unquote(
                b["enwiki"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
    return out


def stage_links(db, apply_writes, cycle, batch=150):
    """Fill wikipedia/social for candidates that already carry a QID.

    These are skipped by the portrait stage, which only looks at people with
    NO photo — so anyone whose portrait arrived by another route (or was set
    by hand, as Talarico's was) keeps an empty Wikipedia link and no handles.
    Keyed by QID, so this stage cannot mis-identify anyone."""
    print("\n── link/social fill (by QID) ──")
    cand = db.get_collection("us_candidates")
    todo = list(cand.find(
        {"cycle": cycle, "wikidata": {"$exists": True, "$nin": [None, ""]},
         "$or": [{"wikipedia": {"$in": [None, ""]}},
                 {"social": {"$in": [None, {}]}}]},
        {"wikidata": 1, "name": 1, "wikipedia": 1, "social": 1}))
    print(f"  {len(todo)} carry a QID but lack a link or handles")
    qids = sorted({c["wikidata"] for c in todo})
    found = {}
    for i in range(0, len(qids), batch):
        try:
            found.update(wdqs_by_qid(qids[i:i + batch]))
        except Exception as e:
            print(f"  ! batch {i//batch + 1} failed: {e}")
        time.sleep(1.0)

    hit = 0
    for c in todo:
        f = found.get(c["wikidata"])
        if not f:
            continue
        set_doc = {}
        if f.get("enwiki") and not c.get("wikipedia"):
            set_doc["wikipedia"] = f["enwiki"]
        if not c.get("social"):
            soc = {}
            for var, key in (("tw", "twitter"), ("fb", "facebook"),
                             ("ig", "instagram"), ("yt", "youtube_id"),
                             ("tt", "tiktok")):
                if f.get(var):
                    soc[key] = f[var]
            if soc:
                set_doc["social"] = soc
                set_doc["social_source"] = "wikidata"
        if set_doc:
            set_doc["enriched_at"] = now()
            hit += 1
            if apply_writes:
                cand.update_one({"_id": c["_id"]}, {"$set": set_doc})
    print(f"  filled {hit}")
    return hit


def stage_wikidata_bulk(db, apply_writes, limit, cycle, min_receipts, batch=120):
    """Bulk portrait/link/social fill via WDQS. Same refusal rule as the slow
    path: exactly one candidate entity, or nothing is written."""
    print("\n── challengers (wikidata bulk / WDQS) ──")
    cand = db.get_collection("us_candidates")
    q = {"cycle": cycle, "photo": {"$in": [None, ""]}}
    if min_receipts:
        q["receipts"] = {"$gte": min_receipts}
    todo = list(cand.find(
        q, {"name": 1, "fec_id": 1, "receipts": 1, "state": 1, "office": 1},
    ).sort("receipts", -1).limit(limit))
    print(f"  {len(todo)} without a portrait (top {limit} by receipts)")

    # Several filers can share a normalised name; keep every row per name so
    # one lookup can fill all of them.
    by_norm = {}
    for c in todo:
        n = normalise(c.get("name", ""))
        if n:
            by_norm.setdefault(n, []).append(c)
    names = list(by_norm)
    print(f"  {len(names)} distinct names, {len(names)//batch + 1} queries")

    hits = ambiguous = nothing = no_img = errors = 0
    for i in range(0, len(names), batch):
        chunk = names[i:i + batch]
        try:
            found = wdqs_batch(chunk)
        except Exception as e:
            errors += 1
            print(f"  ! batch {i//batch + 1} failed: {e}")
            continue

        for name in chunk:
            ents = found.get(name) or {}
            if not ents:
                nothing += 1
                continue
            if len(ents) > 1:
                # Two distinct QIDs answered to the same label. We cannot tell
                # which is the candidate, and a stranger's face is worse than
                # a blank one.
                ambiguous += 1
                print(f"  ~ ambiguous, skipped: {name} -> {', '.join(ents)}")
                continue
            qid, f = next(iter(ents.items()))
            if not f.get("img"):
                no_img += 1
                continue

            img = f["img"].replace("http://commons.wikimedia.org",
                                   "https://commons.wikimedia.org")
            if "?" not in img:
                img += "?width=300"
            set_doc = {"photo": img, "photo_source": "wikidata",
                       "wikidata": qid, "enriched_at": now()}
            if f.get("enwiki"):
                set_doc["wikipedia"] = f["enwiki"]
            soc = {}
            for var, key in (("tw", "twitter"), ("fb", "facebook"),
                             ("ig", "instagram"), ("yt", "youtube_id"),
                             ("tt", "tiktok")):
                if f.get(var):
                    soc[key] = f[var]
            if soc:
                set_doc["social"] = soc
                set_doc["social_source"] = "wikidata"

            for c in by_norm[name]:
                hits += 1
                if apply_writes:
                    cand.update_one({"_id": c["_id"]}, {"$set": set_doc})
        print(f"  batch {i//batch + 1}: matched so far {hits}")
        time.sleep(1.0)

    print(f"\n  matched {hits} | ambiguous {ambiguous} | "
          f"no entity {nothing} | entity without portrait {no_img} | "
          f"batch errors {errors}")
    return hits


def stage_wikidata(db, apply_writes, limit, cycle, min_receipts):
    """Name search, verified. The only stage that can be wrong, so it is the
    only stage that refuses to guess.

    A hit is accepted only when exactly ONE candidate entity both looks like a
    US political figure and carries a portrait. Two plausible matches means we
    cannot tell them apart, and putting a stranger's face against a named
    politician is a worse failure than leaving the avatar blank."""
    print("\n── challengers (wikidata name search) ──")
    cand = db.get_collection("us_candidates")
    q = {"cycle": cycle, "photo": {"$in": [None, ""]}}
    if min_receipts:
        q["receipts"] = {"$gte": min_receipts}
    todo = list(cand.find(
        q, {"name": 1, "fec_id": 1, "receipts": 1, "state": 1, "office": 1},
    ).sort("receipts", -1).limit(limit))
    print(f"  {len(todo)} without a portrait (top {limit} by receipts)")

    hits = ambiguous = nothing = errors = 0
    for i, c in enumerate(todo, 1):
        name = normalise(c.get("name", ""))
        if not name:
            continue
        try:
            found = search(name)
        except Exception as e:
            errors += 1
            print(f"  ! search failed for {name}: {e}")
            time.sleep(1.0)
            continue
        if not found:
            nothing += 1
            continue

        try:
            ents = entities([q for q, _, _ in found])
        except Exception as e:
            errors += 1
            print(f"  ! entities failed for {name}: {e}")
            continue

        viable = []
        for qid, label, desc in found:
            e = ents.get(qid, {})
            img = image_url(e)
            if img and looks_political(e, desc):
                viable.append((qid, label, desc, img, e))

        if len(viable) != 1:
            if len(viable) > 1:
                ambiguous += 1
                print(f"  ~ ambiguous, skipped: {name} -> "
                      + ", ".join(f"{q} ({d[:36]})" for q, _, d, _, _ in viable))
            else:
                nothing += 1
            continue

        qid, label, desc, img, ent = viable[0]
        hits += 1
        set_doc = {
            "photo": img, "photo_source": "wikidata", "wikidata": qid,
            "enriched_at": now(),
        }
        wiki = enwiki_title(ent)
        if wiki:
            set_doc["wikipedia"] = wiki
        soc = wikidata_social(ent)
        if soc:
            set_doc["social"] = soc
            set_doc["social_source"] = "wikidata"
        print(f"  [{i}/{len(todo)}] {c['name']} -> {qid} {label} | {desc[:44]}")
        if apply_writes:
            cand.update_one({"_id": c["_id"]}, {"$set": set_doc})
        time.sleep(0.7)

    print(f"\n  matched {hits} | ambiguous {ambiguous} | "
          f"no usable entity {nothing} | errors {errors}")
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "officeholders", "sitting", "wikidata",
                             "links"])
    ap.add_argument("--cycle", type=int, default=2026)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--min-receipts", type=int, default=0)
    ap.add_argument("--via", default="wdqs", choices=["wdqs", "rest"],
                    help="wdqs: one query per ~120 names (default). "
                         "rest: per-name search; correct but ~100x slower and "
                         "rate-limited into the ground at this scale.")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    if args.stage in ("all", "officeholders"):
        stage_officeholders(db, args.apply)
    if args.stage in ("all", "sitting"):
        stage_sitting(db, args.apply)
    if args.stage in ("all", "wikidata"):
        if args.via == "wdqs":
            stage_wikidata_bulk(db, args.apply, args.limit, args.cycle,
                                args.min_receipts)
        else:
            stage_wikidata(db, args.apply, args.limit, args.cycle,
                           args.min_receipts)
    if args.stage in ("all", "links"):
        stage_links(db, args.apply, args.cycle)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
