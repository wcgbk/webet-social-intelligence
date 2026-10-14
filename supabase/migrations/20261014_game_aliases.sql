-- Canonical ids for duplicate clv.games rows.
-- No deletes. No price updates. A close stored on one twin is visible on the other.
-- Own close (pref 0) wins over a family close (pref 1).

create table if not exists clv.game_aliases (
  alias_game_id text primary key,
  canonical_game_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint game_aliases_not_self check (alias_game_id <> canonical_game_id)
);

create index if not exists game_aliases_canonical on clv.game_aliases (canonical_game_id);

alter table clv.game_aliases enable row level security;
revoke all on clv.game_aliases from anon, authenticated;
grant select, insert, update on clv.game_aliases to service_role;

create or replace function clv.canonical_game_id(gid text)
returns text
language sql
stable
parallel safe
as $$
  select coalesce(
    (select a.canonical_game_id from clv.game_aliases a where a.alias_game_id = gid),
    gid
  );
$$;

create or replace function clv.game_family(gid text)
returns setof text
language sql
stable
parallel safe
as $$
  select clv.canonical_game_id(gid)
  union
  select a.alias_game_id
  from clv.game_aliases a
  where a.canonical_game_id = clv.canonical_game_id(gid);
$$;

-- Fill only null game fields. Never touches odds_snapshots. Never overwrites a non-null.
create or replace function clv.fill_game_nulls(rows jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then
    return 0;
  end if;
  if jsonb_array_length(rows) > 500 then
    raise exception 'fill_game_nulls batch exceeds 500';
  end if;
  with incoming as (
    select *
    from jsonb_to_recordset(rows) as x(
      game_id text,
      season text,
      commence_time timestamptz,
      home_team text,
      away_team text
    )
  ),
  upd as (
    update clv.games g
    set
      commence_time = coalesce(g.commence_time, i.commence_time),
      home_team = coalesce(g.home_team, i.home_team),
      away_team = coalesce(g.away_team, i.away_team),
      season = coalesce(g.season, i.season)
    from incoming i
    where g.game_id = i.game_id
      and (
        (g.commence_time is null and i.commence_time is not null)
        or (g.home_team is null and i.home_team is not null)
        or (g.away_team is null and i.away_team is not null)
        or (g.season is null and i.season is not null)
      )
    returning 1
  )
  select count(*)::integer into n from upd;
  return coalesce(n, 0);
end;
$$;

revoke all on function clv.canonical_game_id(text) from public, anon, authenticated;
revoke all on function clv.game_family(text) from public, anon, authenticated;
revoke all on function clv.fill_game_nulls(jsonb) from public, anon, authenticated;
grant execute on function clv.canonical_game_id(text) to service_role;
grant execute on function clv.game_family(text) to service_role;
grant execute on function clv.fill_game_nulls(jsonb) to service_role;

create or replace view clv.v_coverage as
with fam as (
  select game_id, clv.canonical_game_id(game_id) as canon
  from clv.games
),
opens as (
  select distinct clv.canonical_game_id(game_id) as canon
  from clv.odds_snapshots
  where line_type = 'opening'
),
closes as (
  select distinct clv.canonical_game_id(game_id) as canon
  from clv.odds_snapshots
  where line_type = 'closing'
)
select g.sport,
  (g.commence_time at time zone 'America/New_York')::date as game_date,
  count(distinct g.game_id) as games,
  count(distinct g.game_id) filter (where o.canon is not null) as with_open,
  count(distinct g.game_id) filter (where c.canon is not null) as with_close
from clv.games g
join fam f on f.game_id = g.game_id
left join opens o on o.canon = f.canon
left join closes c on c.canon = f.canon
where g.commence_time is not null
group by g.sport, (g.commence_time at time zone 'America/New_York')::date;

create or replace view clv.v_open_entry_close as
with s as (
  select o.game_id, o.book, o.market, o.side, o.point, o.price, o.line_type, o.snapshot_ts,
         g.commence_time
  from clv.odds_snapshots o
  join clv.games g on g.game_id = o.game_id
),
op as (
  select distinct on (s.game_id, s.book, s.market, s.side)
    s.game_id, s.book, s.market, s.side, s.point, s.price, s.snapshot_ts
  from s
  where s.line_type = 'opening'
  order by s.game_id, s.book, s.market, s.side, s.snapshot_ts
),
en as (
  select distinct on (s.game_id, s.book, s.market, s.side)
    s.game_id, s.book, s.market, s.side, s.point, s.price, s.snapshot_ts
  from s
  where s.line_type = 'snapshot'
    and (s.snapshot_ts at time zone 'America/New_York')::date = (s.commence_time at time zone 'America/New_York')::date
    and (s.snapshot_ts at time zone 'America/New_York')::time <= '10:30:00'::time
    and s.snapshot_ts < s.commence_time
  order by s.game_id, s.book, s.market, s.side, s.snapshot_ts desc
),
cl as (
  select distinct on (s.game_id, s.book, s.market, s.side)
    s.game_id, s.book, s.market, s.side, s.point, s.price, s.snapshot_ts
  from s
  where s.line_type = 'closing'
  order by s.game_id, s.book, s.market, s.side, s.snapshot_ts desc
),
k as (
  select game_id, book, market, side from op
  union
  select game_id, book, market, side from en
  union
  select game_id, book, market, side from cl
),
fam_src as (
  select clv.canonical_game_id(s.game_id) as canon, s.book, s.market, s.side, s.point, s.price, s.snapshot_ts
  from s
  where s.line_type = 'closing'
),
fam_close as (
  select distinct on (canon, book, market, side)
    canon, book, market, side, point, price, snapshot_ts
  from fam_src
  order by canon, book, market, side, snapshot_ts desc
),
extra as (
  select g.game_id, fc.book, fc.market, fc.side
  from clv.games g
  join fam_close fc on fc.canon = clv.canonical_game_id(g.game_id)
  where not exists (
    select 1 from cl c
    where c.game_id = g.game_id and c.book = fc.book and c.market = fc.market and c.side = fc.side
  )
),
keys as (
  select game_id, book, market, side from k
  union
  select game_id, book, market, side from extra
)
select g.sport,
  g.season,
  g.commence_time,
  g.home_team,
  g.away_team,
  keys.game_id,
  keys.book,
  keys.market,
  keys.side,
  op.point as open_point,
  op.price as open_price,
  op.snapshot_ts as open_ts,
  en.point as entry_point,
  en.price as entry_price,
  en.snapshot_ts as entry_ts,
  case when cl.game_id is not null then cl.point else fc.point end as close_point,
  case when cl.game_id is not null then cl.price else fc.price end as close_price,
  case when cl.game_id is not null then cl.snapshot_ts else fc.snapshot_ts end as close_ts,
  (
    case
      when (case when cl.game_id is not null then cl.price else fc.price end) < 0::numeric
        then (- (case when cl.game_id is not null then cl.price else fc.price end))
             / ((- (case when cl.game_id is not null then cl.price else fc.price end)) + 100.0)
      when (case when cl.game_id is not null then cl.price else fc.price end) > 0::numeric
        then 100.0 / ((case when cl.game_id is not null then cl.price else fc.price end) + 100.0)
      else null::numeric
    end
    -
    case
      when en.price < 0::numeric then (- en.price) / ((- en.price) + 100.0)
      when en.price > 0::numeric then 100.0 / (en.price + 100.0)
      else null::numeric
    end
  ) as entry_clv_prob
from keys
join clv.games g on g.game_id = keys.game_id
left join op on op.game_id = keys.game_id and op.book = keys.book and op.market = keys.market and op.side = keys.side
left join en on en.game_id = keys.game_id and en.book = keys.book and en.market = keys.market and en.side = keys.side
left join cl on cl.game_id = keys.game_id and cl.book = keys.book and cl.market = keys.market and cl.side = keys.side
left join fam_close fc on fc.canon = clv.canonical_game_id(keys.game_id)
  and fc.book = keys.book and fc.market = keys.market and fc.side = keys.side;

create or replace view clv.v_pinnacle_close_attach as
select g.game_id as lookup_game_id,
  s.game_id as close_game_id,
  clv.canonical_game_id(g.game_id) as canonical_game_id,
  s.book,
  s.market,
  s.side,
  s.point,
  s.price,
  s.snapshot_ts,
  case when s.game_id = g.game_id then 0 else 1 end as pref
from clv.games g
join clv.odds_snapshots s
  on clv.canonical_game_id(s.game_id) = clv.canonical_game_id(g.game_id)
where s.line_type = 'closing'
  and lower(s.book) = 'pinnacle';

create or replace view clv.v_pinnacle_close_coverage as
with closes as (
  select distinct clv.canonical_game_id(game_id) as canon
  from clv.odds_snapshots
  where line_type = 'closing' and lower(book) = 'pinnacle'
)
select g.sport,
  count(*)::integer as games,
  count(*) filter (where c.canon is not null)::integer as with_close,
  count(*) filter (where g.commence_time is not null and g.commence_time < now())::integer as played,
  count(*) filter (where g.commence_time is not null and g.commence_time < now() and c.canon is not null)::integer as played_with_close
from clv.games g
left join closes c on c.canon = clv.canonical_game_id(g.game_id)
group by g.sport;

alter view clv.v_coverage set (security_invoker = on);
alter view clv.v_open_entry_close set (security_invoker = on);
alter view clv.v_pinnacle_close_attach set (security_invoker = on);
alter view clv.v_pinnacle_close_coverage set (security_invoker = on);

revoke all on clv.v_coverage from anon, authenticated;
revoke all on clv.v_open_entry_close from anon, authenticated;
revoke all on clv.v_pinnacle_close_attach from anon, authenticated;
revoke all on clv.v_pinnacle_close_coverage from anon, authenticated;
grant select on clv.v_coverage to service_role;
grant select on clv.v_open_entry_close to service_role;
grant select on clv.v_pinnacle_close_attach to service_role;
grant select on clv.v_pinnacle_close_coverage to service_role;

notify pgrst, 'reload schema';
