-- Supabase daily mirror v2 (2026-11-14). Mirror-only tables in schema clv (already exposed to PostgREST).
-- Written by netlify/functions/lib/supa-mirror.js (flag SUPABASE_MIRROR_V2, =off rolls back). Upserts on PK.
-- RLS on, no policies: service_role only (same as other clv tables).

create table if not exists clv.board_candidates (
  date date not null, row_key text not null,
  sport text, matchup text, home_team text, away_team text, commence_time timestamptz,
  market text, side text, line numeric, odds numeric, book text,
  p_model numeric, p_mkt numeric, p_mkt_power numeric, p_cal numeric, ev numeric, edge_pct numeric, uncertainty numeric,
  sharp_prices jsonb, is_pick boolean not null default false, is_parlay_leg boolean not null default false,
  model_version text, saved_at timestamptz, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (date, row_key));

create table if not exists clv.board_rejections (
  date date not null, row_key text not null,
  sport text, matchup text, market text, side text, odds numeric, book text, reason text, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (date, row_key));

create table if not exists clv.cards (
  date date primary key, model_version text, engine text, generated_at timestamptz,
  total_picks int, total_units numeric, parlay_legs int, no_plays boolean,
  verification jsonb, payload jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists clv.card_picks (
  date date not null, kind text not null, pick_key text not null, rank int,
  sport text, matchup text, home_team text, away_team text, commence_time timestamptz,
  pick text, bet_type text, market text, line numeric, odds numeric, book text,
  units numeric, stake_usd numeric, grade text, filler boolean,
  p_model numeric, p_mkt numeric, p_cal numeric, edge_novig numeric, ev numeric,
  result text, profit numeric, final_score text, settled_at timestamptz, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (date, kind, pick_key));

create table if not exists clv.parlays (
  date date primary key, legs int, combined_odds numeric, units numeric, stake_usd numeric,
  result text, profit numeric, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists clv.daily_results (
  date date primary key, record text, wins int, losses int, pushes int, pending int,
  wagered numeric, profit numeric, roi numeric, parlay_result text, parlay_profit numeric,
  no_plays boolean, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists clv.scores (
  sport text not null, event_id text not null, date date, commence_time timestamptz,
  home_team text, away_team text, home_score int, away_score int, status text, completed boolean,
  neutral_site boolean, source text default 'espn',
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (sport, event_id));
create index if not exists scores_date_idx on clv.scores (date);

create table if not exists clv.kpi_snapshots (
  date date not null, kind text not null, payload jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (date, kind));

create table if not exists clv.pick_clv (
  date date not null, pick_key text not null,
  sport text, matchup text, pick text, market text, segment text, units text,
  pick_time_odds numeric, bet_line numeric, closing_odds numeric, closing_line numeric, anchor text,
  pick_time_novig numeric, closing_novig numeric, clv numeric, clv_cents numeric, beat_closing boolean,
  close_snapshot_at timestamptz, commence_time timestamptz, result text, profit numeric, raw jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  primary key (date, pick_key));

create table if not exists clv.mirror_runs (
  date date not null, job text not null, ran_at timestamptz default now(), ok boolean, summary jsonb,
  primary key (date, job));

do $$ declare t text; begin
  foreach t in array array['board_candidates','board_rejections','cards','card_picks','parlays','daily_results','scores','kpi_snapshots','pick_clv','mirror_runs'] loop
    execute format('alter table clv.%I enable row level security', t);
    execute format('revoke all on clv.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on clv.%I to service_role', t);
  end loop; end $$;

create index if not exists odds_snapshots_ts_idx on clv.odds_snapshots (snapshot_ts);

-- Verification: rows per mirror table per ET day.
create or replace view clv.v_mirror_daily_counts as
  select 'odds_snapshots'::text tbl, (snapshot_ts at time zone 'America/New_York')::date d, count(*) n from clv.odds_snapshots group by 1,2
  union all select 'odds_hardrock', (snapshot_ts at time zone 'America/New_York')::date, count(*) from clv.odds_snapshots where book like 'hardrockbet%' group by 1,2
  union all select 'odds_books', (snapshot_ts at time zone 'America/New_York')::date, count(distinct book) from clv.odds_snapshots group by 1,2
  union all select 'board_candidates', date, count(*) from clv.board_candidates group by 1,2
  union all select 'board_rejections', date, count(*) from clv.board_rejections group by 1,2
  union all select 'cards', date, count(*) from clv.cards group by 1,2
  union all select 'card_picks', date, count(*) from clv.card_picks group by 1,2
  union all select 'parlays', date, count(*) from clv.parlays group by 1,2
  union all select 'daily_results', date, count(*) from clv.daily_results group by 1,2
  union all select 'scores', date, count(*) from clv.scores group by 1,2
  union all select 'kpi_snapshots', date, count(*) from clv.kpi_snapshots group by 1,2
  union all select 'pick_clv', date, count(*) from clv.pick_clv group by 1,2;
revoke all on clv.v_mirror_daily_counts from anon, authenticated;
grant select on clv.v_mirror_daily_counts to service_role;
