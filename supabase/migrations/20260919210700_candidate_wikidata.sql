-- `wikidata` was missing from us_candidates.
--
-- The portrait backfill (scripts/backfill_portraits.py) writes three fields
-- when it resolves a face: photo, photo_source and wikidata. The schema
-- carried the first two, so the Supabase backend returned a candidate whose
-- portrait was present but whose provenance had been silently dropped —
-- the one field that says WHICH entity the face was taken from, and so the
-- only way to audit a wrong portrait later.
alter table us_candidates add column if not exists wikidata text;
