-- Rows per mirror table per ET day for the last 30 days, from clv.v_mirror_daily_counts.
-- Run with the service role. A second result set lists day/table gaps (no rows).

with days as (
  select generate_series(
    (timezone('America/New_York', now()))::date - 29,
    (timezone('America/New_York', now()))::date,
    interval '1 day'
  )::date as d
),
counts as (
  select tbl, d, n
  from clv.v_mirror_daily_counts
  where d >= (timezone('America/New_York', now()))::date - 29
)
select days.d,
  coalesce(max(counts.n) filter (where counts.tbl = 'odds_snapshots'), 0) as odds_snapshots,
  coalesce(max(counts.n) filter (where counts.tbl = 'odds_hardrock'), 0) as odds_hardrock,
  coalesce(max(counts.n) filter (where counts.tbl = 'book_prices'), 0) as book_prices,
  coalesce(max(counts.n) filter (where counts.tbl = 'book_prices_books'), 0) as book_prices_books,
  coalesce(max(counts.n) filter (where counts.tbl = 'book_prices_hardrock'), 0) as book_prices_hardrock,
  coalesce(max(counts.n) filter (where counts.tbl = 'board_candidates'), 0) as board_candidates,
  coalesce(max(counts.n) filter (where counts.tbl = 'board_rejections'), 0) as board_rejections,
  coalesce(max(counts.n) filter (where counts.tbl = 'cards'), 0) as cards,
  coalesce(max(counts.n) filter (where counts.tbl = 'card_picks'), 0) as card_picks,
  coalesce(max(counts.n) filter (where counts.tbl = 'parlays'), 0) as parlays,
  coalesce(max(counts.n) filter (where counts.tbl = 'daily_results'), 0) as daily_results,
  coalesce(max(counts.n) filter (where counts.tbl = 'scores'), 0) as scores,
  coalesce(max(counts.n) filter (where counts.tbl = 'kpi_snapshots'), 0) as kpi_snapshots,
  coalesce(max(counts.n) filter (where counts.tbl = 'pick_clv'), 0) as pick_clv,
  coalesce(max(counts.n) filter (where counts.tbl = 'mirror_runs'), 0) as mirror_runs
from days
left join counts on counts.d = days.d
group by days.d
order by days.d;

with days as (
  select generate_series(
    (timezone('America/New_York', now()))::date - 29,
    (timezone('America/New_York', now()))::date,
    interval '1 day'
  )::date as d
),
core(tbl) as (
  values
    ('odds_snapshots'),
    ('book_prices'),
    ('book_prices_hardrock'),
    ('board_candidates'),
    ('cards'),
    ('card_picks'),
    ('daily_results'),
    ('scores'),
    ('kpi_snapshots'),
    ('pick_clv'),
    ('mirror_runs')
)
select days.d, core.tbl
from days
cross join core
left join clv.v_mirror_daily_counts c on c.d = days.d and c.tbl = core.tbl
where coalesce(c.n, 0) = 0
order by days.d, core.tbl;
