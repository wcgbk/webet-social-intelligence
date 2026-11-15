-- Every book from the 3 AM / 10 AM odds-master pulls, compact: one row per game x book x snapshot.
-- markets = {"h2h":{"home":{"price":-110},"away":{...}},"spreads":{"home":{"price":-110,"line":-3.5},...},"totals":{"over":{...},"under":{...}}}
-- Pinnacle, DraftKings and Hard Rock are ALSO written normalized to clv.odds_snapshots.
create table if not exists clv.book_prices (
  game_id text not null, book text not null, snapshot_ts timestamptz not null,
  sport text, slot text, date date, home_team text, away_team text, commence_time timestamptz,
  markets jsonb not null, source text default 'netlify:odds-master',
  created_at timestamptz default now(),
  primary key (game_id, book, snapshot_ts));
create index if not exists book_prices_date_idx on clv.book_prices (date, book);
alter table clv.book_prices enable row level security;
revoke all on clv.book_prices from anon, authenticated;
grant select, insert, update, delete on clv.book_prices to service_role;

create or replace view clv.v_book_prices_flat as
  select bp.game_id, bp.sport, bp.date, bp.slot, bp.book, bp.snapshot_ts, bp.home_team, bp.away_team, bp.commence_time,
         m.key as market, s.key as side_key,
         case s.key when 'home' then bp.home_team when 'away' then bp.away_team when 'over' then 'Over' when 'under' then 'Under' end as side,
         (s.value->>'line')::numeric as point, (s.value->>'price')::numeric as price
  from clv.book_prices bp, jsonb_each(bp.markets) m, jsonb_each(m.value) s;
revoke all on clv.v_book_prices_flat from anon, authenticated;
grant select on clv.v_book_prices_flat to service_role;

create or replace view clv.v_mirror_daily_counts as
  select 'odds_snapshots'::text tbl, (snapshot_ts at time zone 'America/New_York')::date d, count(*) n from clv.odds_snapshots group by 1,2
  union all select 'odds_hardrock', (snapshot_ts at time zone 'America/New_York')::date, count(*) from clv.odds_snapshots where book like 'hardrockbet%' group by 1,2
  union all select 'book_prices', date, count(*) from clv.book_prices group by 1,2
  union all select 'book_prices_books', date, count(distinct book) from clv.book_prices group by 1,2
  union all select 'book_prices_hardrock', date, count(*) from clv.book_prices where book = 'hardrockbet' group by 1,2
  union all select 'board_candidates', date, count(*) from clv.board_candidates group by 1,2
  union all select 'board_rejections', date, count(*) from clv.board_rejections group by 1,2
  union all select 'cards', date, count(*) from clv.cards group by 1,2
  union all select 'card_picks', date, count(*) from clv.card_picks group by 1,2
  union all select 'parlays', date, count(*) from clv.parlays group by 1,2
  union all select 'daily_results', date, count(*) from clv.daily_results group by 1,2
  union all select 'scores', date, count(*) from clv.scores group by 1,2
  union all select 'kpi_snapshots', date, count(*) from clv.kpi_snapshots group by 1,2
  union all select 'pick_clv', date, count(*) from clv.pick_clv group by 1,2
  union all select 'mirror_runs', date, count(*) from clv.mirror_runs group by 1,2;
revoke all on clv.v_mirror_daily_counts from anon, authenticated;
grant select on clv.v_mirror_daily_counts to service_role;
