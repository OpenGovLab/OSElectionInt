-- OSElectionInt — read views
--
-- centroid is geography(Point,4326). PostgREST serialises PostGIS columns as
-- hex EWKB, not as GeoJSON, so selecting `centroid` over the Data API hands
-- the client "0101000020E6100000..." and every map layer silently renders
-- nothing. The polling-place RPC already sidesteps this by returning st_x/
-- st_y; this view does the same for the division centroids that the label,
-- race, home-town and news layers all hang their features on.
--
-- A view rather than four more RPCs: those four endpoints each aggregate a
-- DIFFERENT table and only need the centroid to place the result, so what
-- they share is exactly this projection and nothing else.

create or replace view us_divisions_geo as
  select
    d.ocd_id,
    d.level,
    d.name,
    d.state,
    st_x(d.centroid::geometry) as lng,
    st_y(d.centroid::geometry) as lat
  from us_divisions d
  where d.centroid is not null;

-- security_invoker keeps the underlying table's RLS in force. Without it a
-- view is evaluated as its owner and becomes a hole straight through the
-- read policies beneath it.
alter view us_divisions_geo set (security_invoker = on);

grant select on us_divisions_geo to anon, authenticated;
