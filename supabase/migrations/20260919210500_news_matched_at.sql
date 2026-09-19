-- `matched_at` becomes a real timestamp.
--
-- newsArticles() orders by it, and it was loaded as text. ISO-8601 text does
-- happen to sort correctly while every row carries the same offset format,
-- which is exactly the kind of accident that holds until one row arrives with
-- a "Z" instead of "+00:00" and the newest story quietly stops being first.
-- `published_at` stays text on purpose: it is the relative string the source
-- rendered ("2 hours ago"), which is for display and cannot be sorted at all.
alter table us_election_news
  alter column matched_at type timestamptz
  using nullif(matched_at, '')::timestamptz;

create index if not exists us_election_news_matched_idx
  on us_election_news (matched_at desc nulls last);
