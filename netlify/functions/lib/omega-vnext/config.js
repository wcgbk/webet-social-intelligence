'use strict';

/** Omega vNext — CLV-first multi-sport composer (replaces v11 megascript). */
const MODEL_VERSION = 'v12.0.9-omega-vnext-dayscope';

const UNIT_DOLLARS = 150;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
/**
 * Unit structure (v12.0.9):
 * - Straights combined ≤ STRAIGHT_UNIT_BUDGET (3.5u)
 * - Parlay fixed at PARLAY_FIXED_UNITS (0.5u) when published, else omit
 * - Card MAX = DAILY_UNIT_CAP (4.0u) = 3.5 + 0.5
 * Card may be under; never force-fill. Overage: cut lowest-confidence
 * straights only (parlay stays 0.5u).
 */
const STRAIGHT_UNIT_BUDGET = 3.5;
const PARLAY_FIXED_UNITS = 0.5;
const DAILY_UNIT_CAP = 4.0;
/** Per-straight Kelly display cap (before card-level 3.5u budget trim). */
const MAX_STRAIGHT_UNITS_PER_PICK = 1.25;
const LEAN_PAD = false; // empty card OK — never force-fill

/** Same ET calendar day only — no weekend football on Tue/Wed cards. */
const DAY_SCOPE_TZ = 'America/New_York';
const DAY_SCOPE_STRICT = true;

const SPORTS_ENABLED = {
  MLB: true,
  NFL: true,
  NCAAF: true,
  NBA: false, // hooks ready; no preseason
  NHL: false,
};

const ODDS_SPORT_KEYS = {
  MLB: 'baseball_mlb',
  NFL: 'americanfootball_nfl',
  NCAAF: 'americanfootball_ncaaf',
  NBA: 'basketball_nba',
  NHL: 'icehockey_nhl',
};

const ESPN_LEAGUES = {
  MLB: { sport: 'baseball', league: 'mlb', label: 'MLB' },
  NFL: { sport: 'football', league: 'nfl', label: 'NFL' },
  NCAAF: { sport: 'football', league: 'college-football', label: 'NCAAF' },
  NBA: { sport: 'basketball', league: 'nba', label: 'NBA' },
  NHL: { sport: 'hockey', league: 'nhl', label: 'NHL' },
};

const SHARP_BOOKS = ['pinnacle', 'circa', 'circasports', 'bookmaker', 'betonlineag', 'lowvig'];
const US_BOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'williamhill_us',
  'espnbet', 'betrivers', 'fanatics', 'hardrockbet', 'bovada',
];
const MAJOR_LIQUIDITY_BOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'williamhill_us', 'espnbet', 'pinnacle',
];

/** Shrinkage toward no-vig sharp (higher K = more trust in market). v12.0.6: stronger shrink. */
const SHRINK_K = { Total: 0.55, Spread: 0.65, Moneyline: 0.70, default: 0.60 };

/** Gate floors — conservative v1. Empty OK. */
const GATES = {
  minEV: { MLB: 0.03, NFL: 0.025, NCAAF: 0.03, NBA: 0.03, NHL: 0.03, default: 0.03 },
  minCoverProb: { MLB: 0.48, NFL: 0.48, NCAAF: 0.48, default: 0.48 },
  minPredictedClvCents: 0, // require non-negative predicted CLV family
  maxAmericanOdds: 300,
  minAmericanOdds: -300,
  requireMajorBook: true,
  pregameOnly: true,
  sameEtDayOnly: true,
};

/**
 * QA hard-fail thresholds (pre-publish / pre-verify-unlock).
 * Drop pick + try next diversified YES; else leave slot empty — NO lean force-fill.
 */
const QA_HARDFAIL = {
  staleOddsCents: 15, // |american odds move| vs lockSnapshot
  staleLinePts: { Spread: 1.0, Total: 1.0, Moneyline: null },
  qbOutStatuses: ['out', 'doubtful', 'ruled out', 'injured reserve', 'ir'],
  spScratchKeywords: ['scratched', 'changed', 'will not start', 'scrambled'],
  requireMajorBookStillOffered: true,
  /** When assumed SP unknown, still hard-fail ML/Spread if late scratch signal for either team. */
  mlbScratchWithoutAssumedSp: true,
};

/** Selection score weights — CLV first, then EV, then uncertainty penalty. */
const SELECT_WEIGHTS = {
  w_ev: 0.35,
  w_clv: 0.45, // CLV-first
  w_uncertainty: 0.20,
  corr_penalty: 0.15,
  softSportMixBonus: 0.02,
};

const SPORT_SPREAD_STD = { NFL: 13.5, NCAAF: 16.0, NBA: 12.0, NHL: 2.5, MLB: 4.2 };
const SPORT_TOTAL_STD = { NFL: 10.5, NCAAF: 13.5, NBA: 14.0, NHL: 1.8, MLB: 3.5 };
const HFA = { MLB: 0.12, NFL: 2.0, NCAAF: 2.5, NBA: 2.5, NHL: 0.15 }; // pts or runs

const CLV_KPI_FLOOR = '2026-09-22';

const MODEL_NOTES = [
  'v12.0.9 omega-vnext: SAME ET calendar day only (straights + parlay legs); parlay fixed 0.5u; straights ≤3.5u; card max 4.0u; remapped grades (fewer A+).',
  'v12.0.8 omega-vnext: DAILY_UNIT_CAP max 4.0u (not a fill target); parlay leg rating badges; Daily Lock titles + summary UX.',
  'v12.0.7 omega-vnext: fix isotonic soft-cap (was inflating ~hi); stronger shrink so Edge badge stays honest vs sharp fair.',
  'v12.0.6 omega-vnext: daily unit cap 5.0u incl. parlay; ML pick labels; Edge badge = model edge after shrink vs no-vig sharp; stronger shrink; Daily Lock Parlay UX.',
  'v12.0.5 omega-vnext: ensure whatLoses/dataVerified/clvExpectation after Claude narrate + verify.',
  'v12.0.4 omega-vnext: Claude sonnet-4-6 narrate (match verify) + whatLoses/dataVerified/clvExpectation + verify parlay-leg writeups.',
  'v12.0.3 omega-vnext: Claude narrate retries without web_search on tool failure.',
  'v12.0.2 omega-vnext: journalistic Claude narratives + full parlay-leg pick cards.',
  'v12.0.1 omega-vnext: CLV-first composer + realized close-grade loop + QA hard-fails.',
  'v1 projections: sport power/market-hybrid (MLB Pythag/Elo-lite; NFL/CFB normal-spread; NBA/NHL disabled).',
  'Calibration: shrink p_model toward no-vig sharp with market K; isotonic clip soft-caps extremes.',
  'Edge badge (edgePct): calibrated model edge after shrink = coverProb - no-vig sharp fair (fallback: vs book implied). Not predictedClv cents, not raw coverProb, not dog-inflated EV%.',
  'Predicted CLV is a proxy; realized no-vig CLV graded by track-clv-omega (Pinnacle/Circa/Bookmaker).',
  'Weekly CLV report is OBSERVER ONLY — no auto-steer.',
  'QA hard-fails drop scratched SP (MLB), QB out/doubtful (NFL/NCAAF), and stale odds before publish.',
  'Empty card allowed when no candidate clears gates; no lean force-fill; no self-opt mutation.',
  'Day-scope: every straight + parlay leg commenceTime must fall on the card ET date (America/New_York).',
  'Unit structure: straights ≤3.5u + fixed 0.5u parlay = max 4.0u; may be under; never force-fill.',
  'Live card (get-picks-omega): newest store date with real picks ≤ tomorrowET; sticky prior-day when empty/missing; ?date= sticky unless forceEmpty.',
].join(' ');

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const BLOB_STORE = 'edge-picks-omega';

module.exports = {
  MODEL_VERSION,
  UNIT_DOLLARS,
  KELLY_FRACTION,
  MAX_STRAIGHTS,
  STRAIGHT_UNIT_BUDGET,
  PARLAY_FIXED_UNITS,
  DAILY_UNIT_CAP,
  MAX_STRAIGHT_UNITS_PER_PICK,
  LEAN_PAD,
  DAY_SCOPE_TZ,
  DAY_SCOPE_STRICT,
  SPORTS_ENABLED,
  ODDS_SPORT_KEYS,
  ESPN_LEAGUES,
  SHARP_BOOKS,
  US_BOOKS,
  MAJOR_LIQUIDITY_BOOKS,
  SHRINK_K,
  GATES,
  QA_HARDFAIL,
  SELECT_WEIGHTS,
  SPORT_SPREAD_STD,
  SPORT_TOTAL_STD,
  HFA,
  CLV_KPI_FLOOR,
  MODEL_NOTES,
  SITE_ID,
  BLOB_STORE,
};
