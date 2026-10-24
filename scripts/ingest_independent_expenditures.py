#!/usr/bin/env python3
"""
FEC independent expenditures (Schedule E) -> who is spending FOR and AGAINST
each candidate.

WHAT AN INDEPENDENT EXPENDITURE IS, AND WHY THE NAMING IS FUSSY
---------------------------------------------------------------
An independent expenditure is money spent by an outside group expressly
advocating for or against a candidate, WITHOUT coordination with any
campaign. That is a legal definition with teeth: coordination makes it a
contribution instead.

So $207m spent against James Talarico is NOT Ken Paxton's money and must
never be rendered as "Paxton's spending". It is super PACs, party
committees and other outside groups. Every field in the rollup is named to
make that misreading hard: `outside_against`, not `opponent_spend`.

Spend is also not popularity and not a forecast. A candidate attracting
heavy opposition spending is being treated as a threat by someone, which
is interesting and is not the same as losing.

SOURCE: BULK FILE, NOT THE API
-------------------------------
api.open.fec.gov/v1/schedules/schedule_e works, but DEMO_KEY is rate
limited to the point of uselessness here — it returned 429 after five
pages of 100, and a full pull is ~390 pages. The bulk CSV is the same data
with no key at all, in one 10MB request:

    https://www.fec.gov/files/bulk-downloads/2026/independent_expenditure_2026.csv

It also carries two columns the API's default view does not surface,
`amndt_ind` and `prev_file_num`, which turn out to matter a great deal.

THREE TRAPS, ALL MEASURED ON THE REAL FILE
-------------------------------------------
1. AMENDMENTS DOUBLE-COUNT. An amended report does not patch individual
   lines; it replaces the whole filing. The bulk file ships the original
   AND the amendment. 600 file numbers are superseded, covering 3,113 rows
   worth $186,155,050. Left in, Talarico's opposition reads $209.1m
   instead of $207.2m and Paxton's $90.3m instead of $88.0m. Rows whose
   `file_num` appears as some other row's `prev_file_num` are dropped.

2. JUNK FILINGS. One self-filer (Shawn Bettis, H6FL11274) submitted
   round-number billions — $9bn, $8bn, $1bn — naming payees like
   "TANKING", "Warren Buffet" and "APPLE INC. DJIA/ SP/DOW US". The break
   is three orders of magnitude clean: the largest legitimate single line
   item in the file is $28,257,947, and the junk starts at $1,000,000,000.
   The threshold is therefore $100m for ONE line item — roughly 3.5x
   headroom over the real maximum and 10x below the junk floor. Quarantined
   to us_ie_quarantine with a reason, never silently dropped.

3. NAME FRAGMENTATION. This project has been bitten by FEC name spellings
   three times (Cruz, Cornyn, and now Paxton, who appears as "PAXTON,
   WARREN KENNETH JR.", "PAXTON, KENNETH WARREN JR.", "PAXTON, WARREN
   KENNETH JR" and "PAXTON, WARREN JR."). Every aggregate keys on
   `cand_id`, which is the same identifier as us_candidates.fec_id, so
   this joins straight onto the existing spine.

Usage:
    python3 scripts/ingest_independent_expenditures.py --stage all
    python3 scripts/ingest_independent_expenditures.py --stage all --apply
    python3 scripts/ingest_independent_expenditures.py --stage rollup --apply
    python3 scripts/ingest_independent_expenditures.py --limit 2000

Dry run by default. Nothing is written without --apply.
"""

import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

UA = "OSElectionInt-research/1.0 (civic data; contact via repo)"

BULK = ("https://www.fec.gov/files/bulk-downloads/{cycle}"
        "/independent_expenditure_{cycle}.csv")

ROWS = "us_independent_expenditures"
QUAR = "us_ie_quarantine"
ROLL = "us_ie_rollup"
META = "us_ie_meta"

# One line item above this is treated as a filer error. See trap 2 above:
# the largest real row in the 2026 file is $28.3m and the junk starts at
# $1bn, so anywhere in that gap works; $100m is picked for headroom and
# because it is a number a reader can sanity-check for themselves.
JUNK_OVER = 100_000_000

# Schedule E election types. Kept so a caller can scope to the general
# without us deciding for them that primaries are uninteresting.
ELE_TYPE = {
    "G": "general", "P": "primary", "S": "special", "R": "runoff",
    "C": "convention", "O": "other",
}

OFFICE = {"P": "president", "S": "us_senate", "H": "us_house"}

NOTE = (
    "Independent expenditures are made by outside groups without "
    "coordination with any campaign. Money spent against a candidate is "
    "NOT their opponent's spending, and spending is not a prediction of "
    "the result."
)


def here(*p):
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), *p)


def load_media_map():
    with open(here("data", "ie_media_map.json")) as f:
        m = json.load(f)
    # Declaration order is load-bearing — "digital advertising" must reach
    # digital before the broader "advertising" under media_unspecified.
    return [(k, v["is_ad"], [s.lower() for s in v["match"]])
            for k, v in m["buckets"].items()], m["unclassified_bucket"]


def classify(purpose, buckets, fallback):
    p = (purpose or "").lower()
    if not p.strip():
        return fallback
    for name, _is_ad, needles in buckets:
        for n in needles:
            if n in p:
                return name
    return fallback


def connect():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pip install pymongo")
    url = os.environ.get("MONGODB_URL")
    if not url:
        env = here("..", "server", ".env")
        for line in open(env):
            if line.startswith("MONGODB_URL="):
                url = line.split("=", 1)[1].strip()
                break
    if not url:
        sys.exit("MONGODB_URL not set")
    db = MongoClient(url).get_database()
    # The replica set fails over and the connection string pins a NodePort
    # with directConnection, so a secondary answers reads happily and only
    # throws on the first write. Fail loudly here instead of halfway in.
    try:
        hello = db.client.admin.command({"hello": 1})
        if not hello.get("isWritablePrimary"):
            sys.exit(
                "connected to a SECONDARY — writes will fail.\n"
                "  The replica set has failed over. Re-probe ports "
                "31700/31701/31702 with {hello:1} and point MONGODB_URL at "
                "whichever reports isWritablePrimary.")
    except SystemExit:
        raise
    except Exception:
        pass
    return db


def download(cycle, dest):
    url = BULK.format(cycle=cycle)
    delay = 2.0
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r, \
                    open(dest, "wb") as out:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            return os.path.getsize(dest)
        except Exception as e:
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            sys.exit(f"download failed: {e}")
    return 0


def to_float(v):
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def to_date(v):
    """FEC bulk dates are DD-MON-YY. Return ISO, or None."""
    s = (v or "").strip()
    if not s:
        return None
    for fmt in ("%d-%b-%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


# ── stage: load ─────────────────────────────────────────────────────────────

def stage_load(db, cycle, apply_writes, limit, csv_path):
    print("── load ──")
    if not csv_path:
        raw_dir = os.environ.get("IE_RAW_DIR") or here("..", ".ie_raw")
        os.makedirs(raw_dir, exist_ok=True)
        csv_path = os.path.join(raw_dir, f"ie{cycle}.csv")
        if os.path.exists(csv_path) and os.path.getsize(csv_path) > 1_000_000:
            print(f"  reusing {csv_path} "
                  f"({os.path.getsize(csv_path)/1e6:.1f} MB)")
        else:
            print(f"  downloading {BULK.format(cycle=cycle)}")
            n = download(cycle, csv_path)
            print(f"  {n/1e6:.1f} MB")

    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        rows = list(csv.DictReader(f))
    print(f"  {len(rows):,} rows in file")

    # Amendments replace whole reports. Any file_num that some other row
    # names as its prev_file_num has been superseded.
    superseded = {(r.get("prev_file_num") or "").strip()
                  for r in rows if (r.get("prev_file_num") or "").strip()}
    superseded.discard("")

    buckets, fallback = load_media_map()
    is_ad = {name: ad for name, ad, _ in buckets}
    is_ad[fallback] = False

    stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    keep, junk = [], []
    n_superseded = 0
    amt_superseded = 0.0

    for r in rows:
        amt = to_float(r.get("exp_amo"))
        fn = (r.get("file_num") or "").strip()
        if fn and fn in superseded:
            n_superseded += 1
            amt_superseded += amt
            continue

        cand_id = (r.get("cand_id") or "").strip() or None
        so = (r.get("sup_opp") or "").strip().upper()
        tran = (r.get("tran_id") or "").strip()
        medium = classify(r.get("pur"), buckets, fallback)

        doc = {
            # file_num + tran_id is the FEC's own row identity, so a re-run
            # updates rather than duplicates.
            "_id": f"{cycle}|{fn}|{tran}",
            "cycle": int(cycle),
            "candidate_id": cand_id,
            "candidate_name": (r.get("cand_name") or "").strip() or None,
            "office": OFFICE.get((r.get("can_office") or "").strip().upper()),
            "state": (r.get("can_office_state") or "").strip() or None,
            "district": (r.get("can_office_dis") or "").strip() or None,
            "party": (r.get("cand_pty_aff") or "").strip() or None,
            "spender_id": (r.get("spe_id") or "").strip() or None,
            "spender_name": (r.get("spe_nam") or "").strip() or None,
            "payee": (r.get("pay") or "").strip() or None,
            "support_oppose": so if so in ("S", "O") else None,
            "amount": amt,
            "purpose": (r.get("pur") or "").strip() or None,
            "medium": medium,
            "is_ad": bool(is_ad.get(medium)),
            "election_type": ELE_TYPE.get(
                (r.get("ele_type") or "").strip().upper()),
            "expenditure_date": to_date(r.get("exp_date")),
            # When the ad actually ran. More meaningful than the filing
            # date, and often different.
            "dissemination_date": to_date(r.get("dissem_dt")),
            "file_num": fn or None,
            "amendment": (r.get("amndt_ind") or "").strip() or None,
            "source": "FEC bulk independent_expenditure",
            "source_url": BULK.format(cycle=cycle),
            "fetched_at": stamp,
        }

        if amt >= JUNK_OVER:
            doc["quarantine_reason"] = (
                f"single line item of ${amt:,.0f} exceeds the ${JUNK_OVER:,} "
                f"plausibility ceiling; the largest legitimate row in this "
                f"file is about $28m")
            junk.append(doc)
        else:
            keep.append(doc)

    if limit:
        keep = keep[:limit]

    print(f"  superseded by amendment : {n_superseded:,} rows "
          f"(${amt_superseded:,.0f}) dropped")
    print(f"  quarantined as implausible: {len(junk):,} rows "
          f"(${sum(d['amount'] for d in junk):,.0f})")
    if junk:
        who = {}
        for d in junk:
            who[d["candidate_name"]] = who.get(d["candidate_name"], 0) + 1
        print("    " + ", ".join(f"{k} x{v}" for k, v in
                                 sorted(who.items(), key=lambda x: -x[1])[:3]))
    print(f"  kept                     : {len(keep):,} rows "
          f"(${sum(d['amount'] for d in keep):,.0f})")

    nocand = sum(1 for d in keep if not d["candidate_id"])
    print(f"  kept rows with no candidate_id: {nocand:,} "
          f"(cannot be attributed; excluded from the rollup)")

    if apply_writes:
        _write(db, ROWS, keep)
        _write(db, QUAR, junk)
        db[ROWS].create_index([("candidate_id", 1), ("support_oppose", 1)])
        db[ROWS].create_index([("cycle", 1), ("state", 1), ("office", 1)])
        db[ROWS].create_index([("spender_id", 1)])
        db[META].update_one(
            {"_id": f"load-{cycle}"},
            {"$set": {
                "cycle": int(cycle), "rows_in_file": len(rows),
                "kept": len(keep), "quarantined": len(junk),
                "superseded_rows": n_superseded,
                "superseded_amount": amt_superseded,
                "junk_threshold": JUNK_OVER,
                "source_url": BULK.format(cycle=cycle),
                "note": NOTE, "loaded_at": stamp,
            }}, upsert=True)
    return keep


def _write(db, coll, docs, chunk=1000):
    from pymongo import UpdateOne
    if not docs:
        return
    c = db[coll]
    for i in range(0, len(docs), chunk):
        batch = docs[i:i + chunk]
        c.bulk_write([UpdateOne({"_id": d["_id"]}, {"$set": d}, upsert=True)
                      for d in batch], ordered=False)


# ── stage: rollup ───────────────────────────────────────────────────────────

def stage_rollup(db, cycle, apply_writes, rows=None):
    print("\n── rollup ──")
    if rows is None:
        rows = list(db[ROWS].find({"cycle": int(cycle)}))
        print(f"  {len(rows):,} rows from {ROWS}")

    buckets, fallback = load_media_map()
    is_ad = {name: ad for name, ad, _ in buckets}
    is_ad[fallback] = False

    agg = {}
    for r in rows:
        cid = r.get("candidate_id")
        if not cid:
            continue
        a = agg.setdefault(cid, {
            "candidate_id": cid, "name": r.get("candidate_name"),
            "office": r.get("office"), "state": r.get("state"),
            "district": r.get("district"), "party": r.get("party"),
            "cycle": int(cycle),
            "support_total": 0.0, "oppose_total": 0.0,
            "support_count": 0, "oppose_count": 0,
            "ad_total": 0.0, "non_ad_total": 0.0,
            "by_medium": {}, "by_election_type": {},
            "_for": {}, "_against": {},
            "first_date": None, "last_date": None,
            "names_seen": set(),
        })
        if r.get("candidate_name"):
            a["names_seen"].add(r["candidate_name"])
        amt = r.get("amount") or 0.0
        so = r.get("support_oppose")
        if so == "S":
            a["support_total"] += amt
            a["support_count"] += 1
            key = r.get("spender_id") or r.get("spender_name") or "?"
            s = a["_for"].setdefault(key, {"committee_id": r.get("spender_id"),
                                           "name": r.get("spender_name"),
                                           "total": 0.0})
            s["total"] += amt
        elif so == "O":
            a["oppose_total"] += amt
            a["oppose_count"] += 1
            key = r.get("spender_id") or r.get("spender_name") or "?"
            s = a["_against"].setdefault(key, {"committee_id": r.get("spender_id"),
                                               "name": r.get("spender_name"),
                                               "total": 0.0})
            s["total"] += amt

        m = r.get("medium") or fallback
        a["by_medium"][m] = a["by_medium"].get(m, 0.0) + amt
        if is_ad.get(m):
            a["ad_total"] += amt
        else:
            a["non_ad_total"] += amt
        et = r.get("election_type") or "unknown"
        a["by_election_type"][et] = a["by_election_type"].get(et, 0.0) + amt

        # Prefer when the ad ran over when the paperwork landed.
        d = r.get("dissemination_date") or r.get("expenditure_date")
        if d:
            if not a["first_date"] or d < a["first_date"]:
                a["first_date"] = d
            if not a["last_date"] or d > a["last_date"]:
                a["last_date"] = d

    stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    out = []
    for cid, a in agg.items():
        top_a = sorted(a.pop("_against").values(),
                       key=lambda x: -x["total"])[:5]
        top_f = sorted(a.pop("_for").values(), key=lambda x: -x["total"])[:5]
        names = sorted(a.pop("names_seen"))
        a["_id"] = f"{cycle}|{cid}"
        a["top_spenders_against"] = top_a
        a["top_spenders_for"] = top_f
        # How many ways the FEC spelled this person. >1 is exactly why this
        # aggregates on candidate_id.
        a["name_variants"] = names
        a["name_variant_count"] = len(names)
        a["ratio_against_for"] = (
            round(a["oppose_total"] / a["support_total"], 2)
            if a["support_total"] > 0 else None)
        a["total"] = a["support_total"] + a["oppose_total"]
        a["source"] = "FEC bulk independent_expenditure"
        a["note"] = NOTE
        a["updated_at"] = stamp
        out.append(a)

    out.sort(key=lambda x: -x["oppose_total"])
    print(f"  {len(out):,} candidates with attributable spending")

    if apply_writes:
        _write(db, ROLL, out)
        db[ROLL].create_index([("cycle", 1), ("oppose_total", -1)])
        db[ROLL].create_index([("state", 1), ("office", 1)])
        db[META].update_one(
            {"_id": f"rollup-{cycle}"},
            {"$set": {"cycle": int(cycle), "candidates": len(out),
                      "note": NOTE, "updated_at": stamp}}, upsert=True)
    return out


def report(db, out, cycle):
    print("\n── top 10 by outside money spent AGAINST ──")
    print(f"  {'candidate':26} {'st':3} {'AGAINST':>14} {'FOR':>14}  ratio")
    for a in out[:10]:
        r = a["ratio_against_for"]
        print(f"  {str(a['name'])[:24]:26} {str(a['state'] or ''):3} "
              f"${a['oppose_total']:>13,.0f} ${a['support_total']:>13,.0f}  "
              f"{(f'{r:.1f}x' if r else '—'):>6}")

    med = {}
    for a in out:
        for k, v in a["by_medium"].items():
            med[k] = med.get(k, 0.0) + v
    tot = sum(med.values()) or 1
    buckets, fallback = load_media_map()
    ad_names = {n for n, ad, _ in buckets if ad}
    print("\n── spending by medium ──")
    for k, v in sorted(med.items(), key=lambda x: -x[1]):
        tag = "ad" if k in ad_names else "  "
        print(f"  {tag} {k:22} ${v:>14,.0f}  {100*v/tot:5.1f}%")
    uncl = med.get(fallback, 0.0)
    print(f"  unclassified rate: {100*uncl/tot:.1f}% of dollars")

    # Does the Paxton fragmentation actually resolve?
    frag = [a for a in out if a["name_variant_count"] > 1]
    print(f"\n── name fragmentation ──")
    print(f"  {len(frag)} candidates appear under more than one spelling")
    for a in sorted(frag, key=lambda x: -x["name_variant_count"])[:4]:
        print(f"  {a['candidate_id']}  {a['name_variant_count']} spellings: "
              + "; ".join(a["name_variants"][:4]))


def join_check(db, out):
    try:
        cand = db["us_candidates"]
        ids = {a["candidate_id"] for a in out}
        have = {d["fec_id"] for d in cand.find(
            {"fec_id": {"$in": list(ids)}}, {"fec_id": 1, "_id": 0})}
    except Exception as e:
        print(f"\n  ! join check skipped: {e}")
        return
    miss = ids - have
    print(f"\n── join to us_candidates.fec_id ──")
    print(f"  {len(have):,} of {len(ids):,} candidate_ids join "
          f"({100*len(have)/max(len(ids),1):.0f}%)")
    print(f"  {len(miss):,} do not — these are people with outside money "
          f"spent on them that our candidate table does not carry")
    if miss:
        top = [a for a in out if a["candidate_id"] in miss][:5]
        for a in top:
            print(f"    {a['candidate_id']}  {str(a['name'])[:28]:30} "
                  f"${a['total']:,.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "load", "rollup"])
    ap.add_argument("--cycle", default="2026")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap kept rows, for a smoke test")
    ap.add_argument("--csv", default=None,
                    help="use a local CSV instead of downloading")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    rows = None
    if args.stage in ("all", "load"):
        rows = stage_load(db, args.cycle, args.apply, args.limit, args.csv)
    if args.stage in ("all", "rollup"):
        out = stage_rollup(db, args.cycle, args.apply,
                           rows if args.stage == "all" else None)
        report(db, out, args.cycle)
        join_check(db, out)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
