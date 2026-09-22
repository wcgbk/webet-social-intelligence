'use strict';

/** Omega vNext — CLV-first multi-sport composer (replaces v11 megascript). */
const MODEL_VERSION = 'v12.3.4-omega-vnext-replay-asof';

const UNIT_DOLLARS = 150;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
/**
 * Unit structure (v12.0.9+):
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

/**
 * Major US retail books — priority order for open prints / best-price /
 * placeability. Sharp books are not in this list. Hard Rock counts here;
 * verify rechecks Hard Rock plus this set. Dead books (barstool / wynnbet /
 * superbook) stay out.
 */
const US_BOOK_PRIORITY = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'williamhill_us',
  'espnbet', 'hardrockbet', 'betrivers', 'fanatics',
];

/**
 * Generate-time placeability (US retail, not sharp-only).
 * A book "offers" the published price when its American price is within
 * juice ballpark: ≤ maxImpliedWorsePp implied points worse OR
 * ≤ maxAmericanCentsWorse American cents worse (either test passes).
 * A better price always counts. Distinct from MAJOR_LIQUIDITY_BOOKS,
 * which includes Pinnacle and ignores juice.
 */
const PLACEABILITY = {
  minMajorBooks: 2,
  maxImpliedWorsePp: 3,
  maxAmericanCentsWorse: 15,
  /** Verify live scan only: half a point is still the same bet. */
  maxPointDrift: 0.5,
};

const US_BOOKS = [
  ...US_BOOK_PRIORITY,
  'bovada',
];

const MAJOR_LIQUIDITY_BOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'williamhill_us', 'espnbet', 'pinnacle',
];

/**
 * Open→pick line-move / steam gates (US books + sharp refs).
 * Morning polls: 6:00, 7:30, 9:00, 9:15 ET.
 * 6:00/7:30 on capture-omega-lines; 9:00/9:15 on capture-omega-lines-late.
 * 9:30 capture removed so it does not race trigger-picks-omega.
 */
const LINE_MOVE = {
  /** Morning capture slots (ET HHMM). */
  captureSlotsET: ['0600', '0730', '0900', '0915'],
  /** UTC cron targets during EDT (UTC-4). 13:30 is not a capture slot. */
  captureSlotsUtcEDT: ['1000', '1130', '1300', '1315'],
  steamTowardEpsilon: 0.15,
  /** Generate: reject when odds shortened against pick by this many American cents. */
  rejectSteamAgainstCents: 18,
  rejectSteamAgainstPts: { Spread: 1.0, Total: 1.0 },
  /** Soft score adj when steam aligns / opposes. */
  scoreBoostSteamToward: 0.03,
  scorePenaltySteamAgainst: 0.04,
  boostSteamTowardCents: 8,
  boostSteamTowardPts: 0.5,
  /** Verify (10:30): harder adverse thresholds — drop + refill; empty OK. */
  verifyAdverseCents: 20,
  verifyAdversePts: { Spread: 1.5, Total: 1.5 },
};

/** Shrinkage toward no-vig sharp (higher K = more trust in market). v12.1: slightly stronger. */
const SHRINK_K = { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 };

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
  /** Reject when open→now steam strongly against (LINE_MOVE thresholds). */
  rejectAdverseSteam: true,
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
  /** Open→pick adverse steam (verify recheck). */
  adverseSteamCents: LINE_MOVE.verifyAdverseCents,
  adverseSteamPts: LINE_MOVE.verifyAdversePts,
};

/** Selection score weights — CLV first, then EV, then uncertainty penalty. */
/** Grade = pick quality (edge / expected CLV), NOT units and NOT coverProb. */
const QUALITY_GRADE = {
  // Exact band edges (5.0%, 3.5%, 2.0%) default to the HIGHER grade (>=).
  // Below 2.0% → B (no B+ tier; B stays off the public Edge legend).
  aplus: 0.050,  // ≥5.0% calibrated edge → A+
  a: 0.035,      // ≥3.5% and <5.0% → A
  aminus: 0.020, // ≥2.0% and <3.5% → A-
};

const SELECT_WEIGHTS = {
  w_ev: 0.35,
  w_clv: 0.45, // CLV-first
  w_uncertainty: 0.20,
  corr_penalty: 0.15,
  softSportMixBonus: 0.02,
};

const SPORT_SPREAD_STD = { NFL: 13.5, NCAAF: 16.0, NBA: 12.0, NHL: 2.5, MLB: 4.2 };
const SPORT_TOTAL_STD = { NFL: 10.5, NCAAF: 13.5, NBA: 14.0, NHL: 1.8, MLB: 3.5 };
/** HFA base; game_day.js applies soft rest/B2B deltas on top. */
const HFA = { MLB: 0.12, NFL: 2.1, NCAAF: 2.6, NBA: 2.5, NHL: 0.15 };

const CLV_KPI_FLOOR = '2026-09-22';

const MODEL_NOTES = [
  'v12.3.4 omega-vnext: historical replay pregame gate uses the snapshot asOf (historicalSnapshot) instead of Date.now(), so past slates are not rejected as in-progress-or-started. Live path unchanged when asOf is unset. 5-minute grace kept. No weight, Kelly, or engine changes.',
  'v12.3.3 omega-vnext: narrate-only ESPN copy. Straights 4-6 sentences, parlay legs 3-5, Daily Edge and insights 3-5. Locked-row context (edge band, steam hint, price compass) reaches Claude and is translated into plain English, not raw EV/CLV/Kelly. Fallback blurbs use the same desk voice. No gate, weight, Kelly, engine, or TSP changes.',
  'v12.3.2 omega-vnext: verify adverse steam drops set blockStraightRefill so TARGET_PICKS backfill cannot undo the steam gate (empty/short card OK). Verify replace/backfill grades use toPickObject / qualityToRating (edge), not units.',
  'v12.3.1 omega-vnext: 9:15 ET line snap + capture health gate; feed warm 9:00; shadow dry-run 9:05 (isolated omega-shadow/*); TSP live hold lifted (observer /live-ai only — zero Omega hard dep).',
  'v12.3.0 omega-vnext: game-day rest/B2B + soft QB status (ESPN injuries) + MLB weather total adj on top of EPA/SP/park seeds. Soft fallback if feeds fail; empty card OK; no lean force-fill. Market blend + calibrate shrink unchanged. No NBA/NHL.',
  'v12.2.2 omega-vnext: Kalshi/Polymarket OBSERVER sidecar. Read-only implied probs logged to omega-pm-observer/{date} (alias pm-sidecar-{date}) when a PM moneyline maps cleanly 1:1 to a game ML. NEVER mixes PM prices into selection, grades, unit caps, or gates. No order placement. Soft-fail if PM APIs are down.',
  'v12.2.1 omega-vnext: placeability soft-veto. Published price must be offered within juice ballpark (≤3pp implied worse OR ≤15 American cents worse) at ≥2 US retail books from US_BOOK_PRIORITY (PLACEABILITY.minMajorBooks; not sharp-only, not Pinnacle). Reject reason placeability-soft-veto, distinct from insufficient-liquidity. Verify drops a pick only when Hard Rock and majors coverage both fail; odds-API down warns and does not clear the card. Empty card OK, no lean refill.',
  'v12.2.0 omega-vnext: NFL/CFB EPA-style off/def priors (seed JSON; Sierra-like standings blend only when pf/pa and games are clean; both teams required) with lower uncertainty. MLB SP quality from StatsAPI FIP/xFIP/ERA once per generate (discounted team prior only when a probable is named) plus static park factors move margin and total. Soft fallback: failed EPA/SP/park load keeps standings/Pythag behavior and never blanks the slate. Market blend and calibrate shrink unchanged. No NBA/NHL.',
  'v12.1.3 omega-vnext: <2% calibrated edge → B (no B+); legend stays A+/A/A-. v12.1.2 omega-vnext: Edge legend mobile (no Today\'s Record); A- floor 2.0%; exact 5%/3.5%/2% → higher grade; parlay legs sorted by quality grade. v12.1.1 omega-vnext: grades = quality (calibrated edge + expected CLV), not units/hit-rate; sort quality then units; A+ stake ≥ A on same card unless hard cap. v12.1.0 omega-vnext: US open→pick line-move pipeline (capture-omega-lines 6:00/7:30/9:00 ET); steamToward/Against gates + verify recheck; openPrint on lockSnapshot for CLV; stronger shrink; NFL/CFB HFA +0.1.',
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
  'Calibration: shrink p_model toward no-vig sharp with market K; isotonic clip soft-caps extremes (no 15% fake edges).',
  'Edge badge (edgePct): calibrated model edge after shrink = coverProb - no-vig sharp fair (fallback: vs book implied). Not predictedClv cents, not raw coverProb, not dog-inflated EV%.',
  'Predicted CLV is a proxy; residual CLV uses open→now steam; realized no-vig CLV graded by track-clv-omega (Pinnacle/Circa/Bookmaker).',
  'Weekly CLV report is OBSERVER ONLY — no auto-steer. openPrint+lockSnapshot populate open→close path.',
  'QA hard-fails drop scratched SP (MLB), QB out/doubtful (NFL/NCAAF), stale odds, and adverse open→pick steam before publish.',
  'Empty card allowed when no candidate clears gates; no lean force-fill; no self-opt mutation.',
  'Day-scope: every straight + parlay leg commenceTime must fall on the card ET date (America/New_York).',
  'Unit structure: straights ≤3.5u + fixed 0.5u parlay = max 4.0u; may be under; never force-fill.',
  'Live card (get-picks-omega): newest store date with real picks ≤ tomorrowET; sticky prior-day when empty/missing; ?date= sticky unless forceEmpty.',
  'US books prioritized: DK/FD/BetMGM/Caesars/ESPN BET/Hard Rock/BetRivers/Fanatics; sharp refs Pinnacle/Circa/Bookmaker for CLV context.',
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
  US_BOOK_PRIORITY,
  US_BOOKS,
  PLACEABILITY,
  MAJOR_LIQUIDITY_BOOKS,
  LINE_MOVE,
  SHRINK_K,
  GATES,
  QA_HARDFAIL,
  QUALITY_GRADE,
  SELECT_WEIGHTS,
  SPORT_SPREAD_STD,
  SPORT_TOTAL_STD,
  HFA,
  CLV_KPI_FLOOR,
  MODEL_NOTES,
  SITE_ID,
  BLOB_STORE,
};
