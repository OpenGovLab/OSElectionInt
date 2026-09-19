-- Storage reporting.
--
-- Operational, not part of the app's read path: PostgREST exposes no way to
-- read the catalogue, so without this the only way to answer "how much of the
-- free tier has this corpus eaten" is a direct connection with the database
-- password. That is exactly the credential a linked cloud project does not
-- hand you, so sizing a partial load — and deciding whether the full one
-- fits — would otherwise be guesswork.
create or replace function election_storage()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'database_pretty', pg_size_pretty(pg_database_size(current_database())),
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'table', c.relname,
               'rows', s.n_live_tup,
               'bytes', pg_total_relation_size(c.oid),
               'pretty', pg_size_pretty(pg_total_relation_size(c.oid))
             ) order by pg_total_relation_size(c.oid) desc), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
    )
  );
$$;

grant execute on function election_storage() to anon, authenticated;
