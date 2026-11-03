#!/usr/bin/env python3
"""
FEC committee registry -> us_pacs, joined to the outside spending we hold.

WHAT THIS IS AND WHAT IT IS NOT
--------------------------------
This is the complete registry of FEDERAL political committees — 20,991 of
them for the 2026 cycle. It is not "all PACs". State and local committees
register with fifty separate state authorities and are not in this data,
and a dashboard claiming otherwise would be wrong. Every response carries
that caveat.

REGISTRATION IS NOT ACTIVITY
-----------------------------
Most registered committees spend nothing. Of ~21k registered, only ~880
appear anywhere in our Schedule E data. A registry row says a committee
exists, never that it spent, and `spent_this_cycle` is a separate boolean
rather than something a reader has to infer from a missing total.

THE ABBREVIATION TRAP
----------------------
The reason to join the registry was supposed to be that it resolves the
initials filers use. It does not. The registry carries the same string:
C00571703 is literally named "SLF PAC" there, C00495028 is "HMP",
C00504530 is "CLF". CONNECTED_ORG_NM is no help and is frequently about
something else entirely — WinSenate's connected organisation is "SMP",
HMP's is "MINNESOTA SECOND DISTRICT VICT".

So readable names come from a curated file, scripts/data/pac_aliases.json,
and every record says which name it is showing via `name_source`. Only
committees whose expansion is well documented are listed; the rest keep
their filed initials, because inventing an expansion would attach a
political identity to a committee on no evidence.

INDEPENDENT EXPENDITURE IS UNCOORDINATED, BY LAW
-------------------------------------------------
Carried over from the spending ingest and just as load-bearing here. Money
a committee spent against a candidate is that committee's money, never the
opponent's. The field names are chosen so the misreading is hard to make,
and nothing in this file scores a committee on effectiveness or implies
spending bought a result.

SOURCE: BULK, NOT THE API
--------------------------
https://www.fec.gov/files/bulk-downloads/2026/cm26.zip — 878 KB, no key,
no rate limit, redirects to an S3 bucket. The committee endpoint on
api.open.fec.gov exists but DEMO_KEY rate-limits to uselessness, the same
finding the Schedule E ingest made.

Usage:
    python3 scripts/ingest_pacs.py --stage all
    python3 scripts/ingest_pacs.py --stage all --apply
    python3 scripts/ingest_pacs.py --stage rollup --apply

Dry run by default. Nothing is written without --apply.
"""

import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.request
import zipfile

UA = "OSElectionInt-research/1.0 (civic data; contact via repo)"

BULK = "https://www.fec.gov/files/bulk-downloads/{cycle}/cm{yy}.zip"

PACS = "us_pacs"
ROLL = "us_pac_rollup"
META = "us_pac_meta"
IE_ROWS = "us_independent_expenditures"

# Committee master layout. The bulk file ships with no header row, so the
# column order IS the contract; it comes from the FEC's published
# cm_header_file.csv and is asserted on load rather than assumed.
COLUMNS = [
    "CMTE_ID", "CMTE_NM", "TRES_NM", "CMTE_ST1", "CMTE_ST2", "CMTE_CITY",
    "CMTE_ST", "CMTE_ZIP", "CMTE_DSGN", "CMTE_TP", "CMTE_PTY_AFFILIATION",
    "CMTE_FILING_FREQ", "ORG_TP", "CONNECTED_ORG_NM", "CAND_ID",
]

SCOPE = (
    "Federal committees registered with the FEC. State and local PACs "
    "register with fifty separate state authorities and are NOT included. "
    "Registration does not mean a committee spent anything: most registered "
    "committees are inactive in any given cycle."
)

NOTE = (
    "Independent expenditures are made without coordination with any "
    "campaign. Money a committee spent against a candidate is that "
    "committee's money, not the opponent's, and spending is not a measure "
    "of influence or a prediction of the result."
)


def here(*p):
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), *p)


def load_json(name):
    with open(here("data", name)) as f:
        return json.load(f)


def connect():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pip install pymongo")
    url = os.environ.get("MONGODB_URL")
    if not url:
        for line in open(here("..", "server", ".env")):
            if line.startswith("MONGODB_URL="):
                url = line.split("=", 1)[1].strip()
                break
    if not url:
        sys.exit("MONGODB_URL not set")
    db = MongoClient(url).get_database()
    # Same guard the spending ingest uses: the connection string pins a
    # NodePort with directConnection, so after a failover a secondary
    # answers reads happily and only throws on the first write.
    try:
        if not db.client.admin.command({"hello": 1}).get("isWritablePrimary"):
            sys.exit(
                "connected to a SECONDARY — writes will fail.\n"
                "  Re-probe ports 31700/31701/31702 with {hello:1} and point "
                "MONGODB_URL at whichever reports isWritablePrimary.")
    except SystemExit:
        raise
    except Exception:
        pass
    return db


def download(cycle, dest):
    url = BULK.format(cycle=cycle, yy=str(cycle)[-2:])
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
            sys.exit(f"download failed: {url}: {e}")
    return 0


def clean(v):
    s = (v or "").strip()
    return s or None


# ── stage: registry ─────────────────────────────────────────────────────────

def stage_registry(db, cycle, apply_writes, limit, zip_path):
    print("── registry ──")
    if not zip_path:
        raw = os.environ.get("PAC_RAW_DIR") or here("..", ".pac_raw")
        os.makedirs(raw, exist_ok=True)
        zip_path = os.path.join(raw, f"cm{cycle}.zip")
        if os.path.exists(zip_path) and os.path.getsize(zip_path) > 100_000:
            print(f"  reusing {zip_path} "
                  f"({os.path.getsize(zip_path)/1e3:.0f} KB)")
        else:
            url = BULK.format(cycle=cycle, yy=str(cycle)[-2:])
            print(f"  downloading {url}")
            print(f"  {download(cycle, zip_path)/1e3:.0f} KB")

    with zipfile.ZipFile(zip_path) as z:
        name = next((n for n in z.namelist() if n.endswith(".txt")), None)
        if not name:
            sys.exit(f"no .txt inside {zip_path}: {z.namelist()}")
        text = z.read(name).decode("utf-8", errors="replace")

    rows = list(csv.reader(text.splitlines(), delimiter="|"))
    print(f"  {len(rows):,} committees in file")

    # The file has no header, so a column-count change is a silent
    # corruption risk — every downstream field would shift by one.
    bad = [i for i, r in enumerate(rows[:200]) if len(r) < len(COLUMNS)]
    if bad:
        sys.exit(f"layout changed: row {bad[0]} has {len(rows[bad[0]])} "
                 f"columns, expected {len(COLUMNS)}")

    codes = load_json("fec_committee_codes.json")
    aliases = load_json("pac_aliases.json")["aliases"]
    tp_map = codes["committee_type"]
    stamp = dt.datetime.now(dt.timezone.utc).isoformat()

    out = []
    for r in rows:
        if len(r) < len(COLUMNS):
            continue
        d = dict(zip(COLUMNS, r))
        cid = clean(d["CMTE_ID"])
        if not cid:
            continue
        tp = clean(d["CMTE_TP"])
        meta = tp_map.get(tp or "", {})
        filed = clean(d["CMTE_NM"])
        alias = aliases.get(cid)
        out.append({
            "_id": cid,
            "committee_id": cid,
            "cycle": int(cycle),
            # Both names are kept. `name` is what to show, `filed_name` is
            # what the FEC actually has, and name_source says which is which.
            "name": (alias or {}).get("name") or filed,
            "filed_name": filed,
            "name_source": "alias_file" if alias else "fec_registry",
            "affiliation": (alias or {}).get("affiliation"),
            "treasurer": clean(d["TRES_NM"]),
            "city": clean(d["CMTE_CITY"]),
            "state": clean(d["CMTE_ST"]),
            "zip": clean(d["CMTE_ZIP"]),
            "committee_type": tp,
            "committee_type_label": meta.get("label"),
            # Whether this is an outside group at all, as opposed to a
            # candidate's own committee or a party account.
            "is_outside_group": meta.get("outside"),
            "designation": clean(d["CMTE_DSGN"]),
            "designation_label": codes["designation"].get(
                clean(d["CMTE_DSGN"]) or ""),
            "party": clean(d["CMTE_PTY_AFFILIATION"]),
            "party_label": codes["party"].get(
                clean(d["CMTE_PTY_AFFILIATION"]) or ""),
            "filing_frequency": clean(d["CMTE_FILING_FREQ"]),
            "org_type": clean(d["ORG_TP"]),
            "org_type_label": codes["org_type"].get(clean(d["ORG_TP"]) or ""),
            "connected_org": clean(d["CONNECTED_ORG_NM"]),
            # Present only for a candidate's own committee. Its existence is
            # the cleanest signal that a row is NOT an outside group.
            "candidate_id": clean(d["CAND_ID"]),
            "source": "FEC committee master (bulk)",
            "source_url": BULK.format(cycle=cycle, yy=str(cycle)[-2:]),
            "loaded_at": stamp,
            "scope": SCOPE,
        })

    if limit:
        out = out[:limit]

    types = {}
    for d in out:
        k = d["committee_type_label"] or f"(code {d['committee_type']})"
        types[k] = types.get(k, 0) + 1
    print("  by committee type:")
    for k, v in sorted(types.items(), key=lambda x: -x[1])[:8]:
        print(f"    {v:>6,}  {k}")
    print(f"  named from alias file: "
          f"{sum(1 for d in out if d['name_source'] == 'alias_file')}")

    if apply_writes:
        _write(db, PACS, out)
        db[PACS].create_index([("name", 1)])
        db[PACS].create_index([("committee_type", 1)])
        db[PACS].create_index([("candidate_id", 1)])
        db[META].update_one({"_id": f"registry-{cycle}"}, {"$set": {
            "cycle": int(cycle), "committees": len(out),
            "source_url": BULK.format(cycle=cycle, yy=str(cycle)[-2:]),
            "scope": SCOPE, "loaded_at": stamp,
        }}, upsert=True)
    return out


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

def stage_rollup(db, cycle, apply_writes, registry=None):
    """What each committee actually spent, from the Schedule E rows."""
    print("\n── rollup ──")
    ie = list(db[IE_ROWS].find({"cycle": int(cycle)}))
    print(f"  {len(ie):,} expenditure rows")
    if not ie:
        print("  nothing to roll up — run ingest_independent_expenditures first")
        return []

    reg = {d["_id"]: d for d in (registry or db[PACS].find({}))}
    print(f"  {len(reg):,} committees in registry")

    agg = {}
    for r in ie:
        cid = r.get("spender_id") or r.get("spender_name")
        if not cid:
            continue
        a = agg.setdefault(cid, {
            "committee_id": r.get("spender_id"),
            "filed_name": r.get("spender_name"),
            "cycle": int(cycle),
            "support_total": 0.0, "oppose_total": 0.0,
            "support_count": 0, "oppose_count": 0,
            "by_medium": {}, "_cands": {}, "_races": set(),
            "first_date": None, "last_date": None,
        })
        amt = r.get("amount") or 0.0
        so = r.get("support_oppose")
        cand = r.get("candidate_id")
        if cand:
            c = a["_cands"].setdefault(cand, {
                "candidate_id": cand, "name": r.get("candidate_name"),
                "state": r.get("state"), "office": r.get("office"),
                "support": 0.0, "oppose": 0.0,
            })
            if so == "S":
                c["support"] += amt
            elif so == "O":
                c["oppose"] += amt
        if r.get("state") and r.get("office"):
            a["_races"].add(f"{r['state']}|{r['office']}")
        if so == "S":
            a["support_total"] += amt
            a["support_count"] += 1
        elif so == "O":
            a["oppose_total"] += amt
            a["oppose_count"] += 1
        m = r.get("medium") or "unclassified"
        a["by_medium"][m] = a["by_medium"].get(m, 0.0) + amt
        d = r.get("dissemination_date") or r.get("expenditure_date")
        if d:
            if not a["first_date"] or d < a["first_date"]:
                a["first_date"] = d
            if not a["last_date"] or d > a["last_date"]:
                a["last_date"] = d

    stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    out, unmatched = [], []
    for key, a in agg.items():
        cands = sorted(a.pop("_cands").values(),
                       key=lambda c: -(c["support"] + c["oppose"]))
        races = sorted(a.pop("_races"))
        cid = a["committee_id"]
        r = reg.get(cid) if cid else None
        if not r:
            unmatched.append(a)
        total = a["support_total"] + a["oppose_total"]
        out.append({
            "_id": f"{cycle}|{cid or key}",
            **a,
            "total": total,
            # Registry fields, or explicit nulls where the committee is not
            # in the registry at all. Absent is not the same as zero.
            "name": (r or {}).get("name") or a["filed_name"],
            "name_source": (r or {}).get("name_source"),
            "affiliation": (r or {}).get("affiliation"),
            "committee_type": (r or {}).get("committee_type"),
            "committee_type_label": (r or {}).get("committee_type_label"),
            "is_outside_group": (r or {}).get("is_outside_group"),
            "designation_label": (r or {}).get("designation_label"),
            "party_label": (r or {}).get("party_label"),
            "connected_org": (r or {}).get("connected_org"),
            "treasurer": (r or {}).get("treasurer"),
            "city": (r or {}).get("city"),
            "state": (r or {}).get("state"),
            "in_registry": bool(r),
            "candidates_count": len(cands),
            "races_count": len(races),
            "races": races[:40],
            "top_against": [c for c in cands if c["oppose"] > 0][:10],
            "top_for": sorted([c for c in cands if c["support"] > 0],
                              key=lambda c: -c["support"])[:10],
            "spent_this_cycle": True,
            "source": "FEC Schedule E + committee master",
            "note": NOTE, "scope": SCOPE, "updated_at": stamp,
        })

    out.sort(key=lambda d: -d["total"])
    print(f"  {len(out):,} committees with spending")
    print(f"  matched to registry: {len(out) - len(unmatched):,} / {len(out):,}")
    if unmatched:
        print(f"  NOT in registry ({len(unmatched)}), largest:")
        for a in sorted(unmatched,
                        key=lambda x: -(x["support_total"] + x["oppose_total"]))[:5]:
            t = a["support_total"] + a["oppose_total"]
            print(f"    {str(a['committee_id']):12} "
                  f"{str(a['filed_name'])[:34]:36} ${t:,.0f}")

    if apply_writes:
        _write(db, ROLL, out)
        db[ROLL].create_index([("total", -1)])
        db[ROLL].create_index([("committee_id", 1)])
        db[ROLL].create_index([("name", 1)])
        # Mark the registry rows that actually spent, so "registered" and
        # "active" never have to be inferred from a join at read time.
        ids = [d["committee_id"] for d in out if d["committee_id"]]
        if ids:
            db[PACS].update_many({"_id": {"$in": ids}},
                                 {"$set": {"spent_this_cycle": True}})
            db[PACS].update_many({"_id": {"$nin": ids}},
                                 {"$set": {"spent_this_cycle": False}})
        db[META].update_one({"_id": f"rollup-{cycle}"}, {"$set": {
            "cycle": int(cycle), "committees_with_spending": len(out),
            "unmatched_to_registry": len(unmatched),
            "note": NOTE, "scope": SCOPE, "updated_at": stamp,
        }}, upsert=True)
    return out


def report(out):
    if not out:
        return
    print("\n── top committees by outside spending ──")
    for d in out[:8]:
        nm = d["name"][:30]
        flag = "" if d["in_registry"] else "  [not in registry]"
        print(f"  {nm:32} ${d['total']/1e6:>7.1f}M  "
              f"for ${d['support_total']/1e6:>6.1f}M  "
              f"against ${d['oppose_total']/1e6:>6.1f}M  "
              f"{d['candidates_count']:>3} cands{flag}")
    types = {}
    for d in out:
        k = d["committee_type_label"] or "(not in registry)"
        types[k] = types.get(k, 0) + 1
    print("\n── committee type among ACTUAL spenders ──")
    for k, v in sorted(types.items(), key=lambda x: -x[1]):
        print(f"  {v:>5}  {k}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "registry", "rollup"])
    ap.add_argument("--cycle", default="2026")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--zip", default=None, help="use a local cm zip")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = connect()
    reg = None
    if args.stage in ("all", "registry"):
        reg = stage_registry(db, args.cycle, args.apply, args.limit, args.zip)
    if args.stage in ("all", "rollup"):
        out = stage_rollup(db, args.cycle, args.apply,
                           reg if args.stage == "all" else None)
        report(out)

    print("\ndry run — pass --apply to write" if not args.apply else "\nwritten")


if __name__ == "__main__":
    main()
