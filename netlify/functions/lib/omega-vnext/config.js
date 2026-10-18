'use strict';

/** Omega vNext — CLV-first multi-sport composer (replaces v11 megascript). */
const MODEL_VERSION = 'v12.4.0-webetai-pure';

const UNIT_DOLLARS = 150;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
/**
 * The straight card keeps one side per game. The next-best EV on a
 * different game fills an open slot. Default true. Set false only to
 * publish two sides of one game when both are in the top N.
 */
const ONE_STRAIGHT_PER_GAME = true;
/**
 * Same-game straight top-up. Default false: a short card does not take a
 * second side of a game already on the card. Same-game fill is a decision
 * for WeBet. When true, a same-game reserve row is used only after every
 * distinct-game reserve row is exhausted, and the row is flagged
 * sameGameFill. capSameGameExposure at GAME_EXPOSURE_CAP (2.0u) still applies.
 */
const ALLOW_SAME_GAME_TOPUP = false;
/**
 * Same-game stake cap. Straight units plus the parlay stake on that game
 * stay at or under GAME_EXPOSURE_CAP (2.0u). The parlay is not cut. Leans are not trimmed.
 * OMEGA_GAME_EXPOSURE=0 turns the trim off.
 */
const PER_GAME_EXPOSURE_CAP_ENABLED = true;
/**
 * Unit structure:
 * - Straights: quarter Kelly on the final p, times BANKROLL_UNITS, nearest 0.25u.
 *   EV <= 0 is 0u. Cap 1.5u. The 0.5u floor is only a labelled lean.
 *   A graded Kelly stake that rounds under 0.5u is that lean at 0.5u.
 *   The letter grade is a label from edge. It does not set the stake.
 * - Straights combined ≤ STRAIGHT_UNIT_BUDGET (4.5u)
 * - Full card (any straight graded A- or better): parlay PARLAY_FIXED_UNITS (0.5u)
 * - Lean-only card (no straight graded A- or better): parlay LEAN_PARLAY_UNITS (0.25u)
 * - Card MAX = DAILY_UNIT_CAP (5.0u)
 * A short floor fills from positive EV, then any EV. Overage cuts lowest-confidence straights only.
 */
/** ASSUMED. Quarter Kelly is a fraction of this many units. */
const BANKROLL_UNITS = 100;
const STRAIGHT_UNIT_BUDGET = 4.5;
const PARLAY_FIXED_UNITS = 0.5;
/**
 * Same-direction total parlays (every leg Over, or every leg Under) share
 * a scoring day. Multiply combinedProb by this factor before EV and
 * ranking. Each value is at most 1, so no ticket's hit probability rises.
 * A mixed ticket, or any ticket that is not all totals, stays at 1.
 * OMEGA_PARLAY_CORR defaults off. Its ρ prior only raised this joint.
 * Turning it on must not replace the haircut or lift EV.
 */
const PARLAY_TOTAL_HAIRCUT = {
  2: 0.95,
  3: 0.92,
};
const DAILY_UNIT_CAP = 5.0;
/** Per-straight ceiling. A+ flat stake is 1.5u. Kelly does not set the stake. */
const MAX_STRAIGHT_UNITS_PER_PICK = 1.5;
/**
 * Grade B stake. qualityToRating 'b' is calibrated edge under QUALITY_GRADE.aminus (2%).
 * The flat table already prices B at 0.5u. This cap still lowers a larger stake
 * and never raises one. A- / A / A+ are not capped. Leans are 0.5u on their own path.
 */
const B_GRADE_UNIT_CAP = 0.5;
/**
 * Flat published stake by letter. Leans are 0.5u at every letter.
 * Dollars are UNIT_DOLLARS times units, rounded up to a whole dollar.
 */
const GRADE_STAKE_UNITS = {
  aplus: 1.5,
  a: 1,
  aminus: 0.75,
  b: 0.5,
  lean: 0.5,
};
const LEAN_PAD = false; // PERMANENT (2026-10-18): no leans. Was: short-card lean fill.

/** Same ET calendar day only — no weekend football on Tue/Wed cards. */
const DAY_SCOPE_TZ = 'America/New_York';
const DAY_SCOPE_STRICT = true;

const SPORTS_ENABLED = {
  MLB: true,
  NFL: true,
  NCAAF: true,
  NBA: false, // shadow engine only; daily card stays off
  NHL: true, // WeBet voice order 2026-09-30 — v12.3.13 NHL engine live
};

/**
 * Daily-card NBA switch. Stays false until WeBet approves a live flip.
 * Season dates are in season_calendar.js. Nothing here turns NBA on by date.
 * Server env OMEGA_NBA_LIVE=1 is the other explicit on-switch. Either one
 * is enough; both default off. SPORTS_ENABLED.NBA stays false.
 */
const NBA_CARD_LIVE = false;

/**
 * Daily-card NBA module. Default off.
 * OMEGA_NBA=1 is the on-switch. Unset, or any other value, produces zero
 * NBA candidates and leaves every other sport unchanged.
 * OMEGA_NBA_LIVE and NBA_CARD_LIVE stay the season-calendar switches.
 * SPORTS_ENABLED.NBA stays false.
 */
function nbaModuleEnabled(env) {
  const e = env == null ? process.env : env;
  return e.OMEGA_NBA === '1';
}

/**
 * NBA shadow log + grade. Independent of SPORTS_ENABLED.NBA, which stays
 * false so the daily card never selects NBA. Scheduled project (21:30 UTC)
 * and grade (12:00 UTC, previous ET date) read this constant.
 * Server env OMEGA_NBA_SHADOW=0 is the kill-switch: no odds fetch, no blob write.
 */
const NBA_SHADOW = {
  enabled: true,
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

const SHARP_BOOKS = ['pinnacle', 'bookmaker', 'betonlineag', 'lowvig'];

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
 * The live schedule is the 3:00 and 10:00 ET snapshots. The 6:00, 7:30,
 * 9:00, and 9:15 ET morning polls are retired and are not a fallback.
 * There is no 10:30 Odds API pull. 10:30 is a draft and placeability check
 * on the saved 10:00 prices. 11:00 is the only finalization.
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
  /**
   * Retired 10:30 recheck thresholds. Kept so older readers still see 20 cents
   * and 1.5 points. adverseSteamReason({ verify: true }) does not apply them.
   * There is no 10:30 pull.
   */
  verifyAdverseCents: 20,
  verifyAdversePts: { Spread: 1.5, Total: 1.5 },
  verifyRecheck: false,
};

/**
 * Minutes recorded on every steam row. Scheduled 3:00 / 10:00 checks are
 * farther apart than this. A later denser series steams only when the gap
 * also fits in this window.
 */
const STEAM_WINDOW_MIN = 15;

/**
 * Pinnacle no-vig line log. The 10:00 check versus the 3:00 baseline feeds
 * the steam gate. Movement trust is a blend-weight shift in line_move_prob.
 * It does not rewrite the 10:00 fair, a floor, Kelly, or a cap.
 * Opens are the first price in the 3:00 ET pull (Pinnacle only). Checks at
 * 3:00 and 10:00 ET are one live call per sport:
 * bookmakers=pinnacle,draftkings,hardrockbet. That is 3 credits, not 6.
 * The 3:00 check also pulls yesterday's pregame closes (historical, Pinnacle
 * only, 10× live = historicalCreditsPerPull). The 10:00 check reuses a
 * same-sport snapshot younger than earlyReuseMs. 9:00, 10:30, the hourly
 * opener, and kickoff closes are not pulled.
 * creditFloor stops backfill and extra pulls only. It does not stop the
 * 3:00 or 10:00 checks, yesterday's closes, or the card.
 */
const PINNACLE_LINE_MOVE = {
  creditFloor: 49000,
  regions: 'eu',
  /** Opens and historical closes. Pinnacle only. */
  bookmakers: 'pinnacle',
  /**
   * One 3:00 / 10:00 check call. Hard Rock is on this request, not a second pull.
   * secondaryBookmakers is the deprecated two-call DraftKings string. The check
   * does not request it.
   */
  checkBookmakers: 'pinnacle,draftkings,hardrockbet',
  secondaryBookmakers: 'draftkings,hardrockbet',
  markets: 'h2h,spreads,totals',
  /** Consecutive-check no-vig move, in probability points, both books. */
  steamProbPts: 3,
  /** Consecutive-check spread or total point move, both books, same sign. */
  steamLinePoints: 0.5,
  windowMinutes: STEAM_WINDOW_MIN,
  /** 10 × 1 eu region × h2h,spreads,totals. One historical kickoff pull. */
  historicalCreditsPerPull: 30,
  /** 10:00 ET reuses a same-sport odds_snapshot_cache row younger than this. */
  earlyReuseMs: 5 * 60 * 1000,
};

/**
 * DraftKings lags the one-book no-vig (Pinnacle).
 * minPinMovePp is the Pinnacle no-vig move toward the side, in percentage
 * points, from the 3:00 baseline or the stored opener to the candidate price.
 * maxDkFollowRatio: DraftKings implied must move less than this fraction
 * of pinMove. OMEGA_DK_LAG=0 disables the rank and coverProb use.
 */
const DK_LAG = {
  minPinMovePp: 1.0,
  maxDkFollowRatio: 0.5,
};

/**
 * Pinnacle-led movement shifts shrink weight K before edge, stake EV, and
 * the letter grade. It does not add Δp on top of the 10:00 no-vig.
 *
 * info = clamp((|Δp| − noise) / (scale − noise), 0, 1)
 * extra = weight(sport, market) × info
 *   × hardRockOppositionDamp when Hard Rock's 3:00→10:00 sign opposes Pinnacle
 *   + dkLagWeight(sport) when Pinnacle moved toward the side and DraftKings
 *     followed less than half of that move
 * K_eff = min(maxK, K + (1 − K) × extra) when K < maxK, else K
 * adj = clamp((K_eff − K) × (p_sharp − p_model), ±maxAbsProbAdj)
 * p_adj = clamp(coverProb + adj, probClamp)
 *
 * Δp is the side's no-vig probability change from 3:00 to 10:00. Spreads and
 * totals convert the point move with the key-number cover of the fixed bet
 * line, then add the juice skew. Open→3:00 adds openWeight to the magnitude
 * only when it agrees in sign with 3:00→10:00. An optional second sharp
 * book in extraSharpBooks is averaged at extraSharpWeight when both ends
 * are already stored. The list is empty, so a stored Circa quote is not a
 * leader and does not move K. circaWeight remains as the deprecated alias
 * of that weight. A missing 3:00 or 10:00 adjusts 0. A Pinnacle
 * 3:00→10:00 move of adverseDropProb or worse drops the side.
 * OMEGA_LINE_MOVE_PROB=0 skips the adjustment.
 */
const LINE_MOVE_PROB = {
  noise: 0.005,
  scale: 0.030,
  maxK: 0.90,
  maxAbsProbAdj: 0.015,
  openWeight: 0.25,
  adverseDropProb: 0.020,
  /** Empty: stored Circa (or any other book) is not blended. Opt in by name. */
  extraSharpBooks: [],
  extraSharpWeight: 0.5,
  /** Deprecated alias of extraSharpWeight. Not a Circa request. */
  circaWeight: 0.5,
  hardRockOppositionDamp: 0.5,
  probClamp: [0.02, 0.98],
  weights: {
    NFL: { Moneyline: 0.35, Spread: 0.45, Total: 0.40 },
    NCAAF: { Moneyline: 0.20, Spread: 0.25, Total: 0.20 },
    NHL: { Moneyline: 0.15, Spread: 0.25, Total: 0.20 },
    MLB: { Moneyline: 0.15, Spread: 0.20, Total: 0.20 },
    NBA: { Moneyline: 0.15, Spread: 0.20, Total: 0.20 },
    default: { Moneyline: 0.20, Spread: 0.25, Total: 0.20 },
  },
  dkLagWeight: {
    NFL: 0.15,
    NCAAF: 0.10,
    NHL: 0.08,
    MLB: 0.08,
    NBA: 0.08,
    default: 0.10,
  },
};

/** Shrinkage toward no-vig sharp (higher K = more trust in market). v12.1: slightly stronger.
 *  NFL / NCAAF / NHL / NBA. MLB uses MLB_CALIBRATION.shrinkK.
 *  These values are hand-set. Default OMEGA_CAL_MODE=A applies this table
 *  and does not apply the unfitted band. OMEGA_CAL_MODE=B may replace the
 *  applied K with a log-loss fit inside [0.3, 1.0]. The 0.3 floor is a
 *  product constraint, not a fit. See calibrate.js. */
const SHRINK_K = { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 };

/**
 * MLB-only second shrink (v12.3.9). Global SHRINK_K stays the hand-set table.
 * The second step on the legacy path is an unfitted band, not a fitted
 * isotonic: outside 0.42–0.58, keep 0.25 of the excess, every sport.
 * OMEGA_CAL_MODE=legacy is that path and the exact rollback. The historical
 * function name was isotonicClip. Default mode A drops the band and keeps
 * this hand-set K. Mode C replaces the band with a map fit on the shrunk
 * probability.
 * MLB already blends toward the market. The global second shrink (0.58–0.73)
 * then pushed a ~1-run starter miss and a real total/park miss under
 * GATES.minEV (0.03), so a normal Wednesday published an empty card.
 * These K values are the least ease that still clears that slate: a ~1-run
 * moneyline priced around -120, a two-ace total, and a park total. Spread K
 * stays next to the global 0.68 so a pick'em +1.5 does not become the card.
 * A pick'em moneyline, a 0.25-run moneyline, and a starter the market has
 * already priced to -190 stay under the EV gate. Not a lean pad.
 */
const MLB_CALIBRATION = {
  shrinkK: { Total: 0.46, Spread: 0.62, Moneyline: 0.30, default: 0.46 },
};

/**
 * Publish gates. Floor tier: stake EV >= 2% at the best DraftKings or
 * Hard Rock price, for every sport. The odds-scaled edge curve is not an
 * inclusion gate. Edge stays a displayed field and the rank tiebreak.
 * EV above EV_CAP_ALL (10%, ASSUMED) is ev-stale: logged, not a floor and not a lean.
 * GATES.maxEV (12%) stays for older readers. The gate uses EV_CAP_ALL.
 * minCoverProb stays 0. A missing cover or EV rejects. A miss of the 2%
 * floor, including a non-positive EV, can fill as a lean. Odds band is
 * about −250..+250. Major-book liquidity, pregame, same ET day, and
 * adverse steam stay. Generate-time placeability is logged and does not
 * reject.
 */
const GATES = {
  minEV: { MLB: 0.02, NFL: 0.02, NCAAF: 0.02, NBA: 0.02, NHL: 0.02, default: 0.02 },
  maxEV: 0.12, // legacy constant. The effective reject is EV_CAP_ALL.
  minCoverProb: { MLB: 0, NFL: 0, NCAAF: 0, NBA: 0, default: 0 },
  minPredictedClvCents: null, // not a publish floor
  maxAmericanOdds: 250,
  minAmericanOdds: -250,
  requireMajorBook: true,
  pregameOnly: true,
  sameEtDayOnly: true,
  /** Reject when open→now steam strongly against (LINE_MOVE thresholds). */
  rejectAdverseSteam: true,
};
/**
 * OMEGA_MARKET_ANCHOR is ignored. This switch stays off: it does not blend,
 * does not cut max EV to 6%, and does not disable lean fill.
 * The live price is one market anchor on modelPureP (prob_anchor.js):
 * p_final = w(sport, market) * modelPureP + (1 - w) * fair.
 * Fair is the Pinnacle power no-vig, else the DraftKings two-way no-vig.
 * Weights are MARKET_ANCHOR_MODEL_WEIGHT, per sport and market.
 * NFL totals w = 0 is FITTED as the bootstrap median, not a CI exclusion.
 * bt_w.py on afterC-rows, 114 NFL total sides, 44 games: log-loss 0.6901
 * at w=0, 0.6953 at 0.25, 0.7624 at w=1. Median best w is 0.00. The
 * argmin 95% CI is [0.00, 1.00], and LL(0.25)-LL(0) CI includes 0. The
 * pure model is worse, so the median is 0: the totals model adds no
 * information beyond the market. NFL moneyline and spread stay 0.25
 * (ASSUMED). NCAAF is 0.25/0.25/0.10, NHL and MLB are 0.25, all ASSUMED.
 * NBA is absent and is not anchored. w = 0 is the market, not a missing
 * weight and not a fallback to 0.25.
 */
function marketAnchorOn() {
  return false;
}
/** ASSUMED. EV above this is a model-error flag for every sport, market, and price. */
const EV_CAP_ALL = 0.10;
/**
 * ASSUMED 2026-10-18. Default 0. Not fitted.
 * p_final is already the posterior mean (anchor weight w), so k * rating SE
 * on top of that double-counted uncertainty. /workspace/sim-1018/SIM-REPORT.md:
 * k = 1.5 removed every pick. The flat 2% minimum stays in edgeFloorSe.
 * OMEGA_EDGE_FLOOR_K overrides at call time. ratingSe stays for display.
 */
const EDGE_FLOOR_K = 0;
/**
 * ASSUMED same-model-bias haircut. Parlay joint = product(final p) * this^(nLegs-1).
 * It is not a fitted correlation. The book's decimal product is the payout.
 */
const CORR_HAIRCUT_PER_LEG = 0.95;
const LEGACY_MIN_EV = GATES.minEV;
const LEGACY_MAX_EV = GATES.maxEV;
const ANCHOR_MIN_EV = { MLB: 0.015, NFL: 0.015, NCAAF: 0.015, NBA: 0.015, NHL: 0.015, default: 0.015 };
const ANCHOR_MAX_EV = 0.06;
Object.defineProperty(GATES, 'minEV', { enumerable: true, get() { return marketAnchorOn() ? ANCHOR_MIN_EV : LEGACY_MIN_EV; } });
Object.defineProperty(GATES, 'maxEV', { enumerable: true, get() { return marketAnchorOn() ? ANCHOR_MAX_EV : LEGACY_MAX_EV; } });


/**
 * Lean fill under the 2% main floor. A positive-EV fill needs stake EV > 0
 * at DraftKings or Hard Rock and a pregame board. Edge is not required.
 * LEAN_MIN_EDGE stays exported for older diagnostics. LEAN_MIN_EV remains
 * the legacy parlay-pool bar. Stake is flat LEAN_MAX_UNITS. Every published
 * parlay on a lean-only card is LEAN_PARLAY_UNITS. A full card (any straight
 * graded A- or better) publishes PARLAY_FIXED_UNITS. The last-resort fill
 * may use a non-positive EV that already cleared the structural gates.
 */
const LEAN_MIN_EV = 0.015;
const LEAN_MIN_EDGE = 0.015;
const LEAN_MAX_UNITS = 0.5;
const LEAN_PARLAY_UNITS = 0.25;
/** Parlay legs only. Straights have no coverProb floor. */
const PARLAY_MIN_COVER = 0.45;

/**
 * QA hard-fail thresholds (pre-publish / pre-verify-unlock).
 * Drop a hard-fail and refill from the floor tier. When that refill is
 * still short of 3 and LEAN_PAD is on, leans fill the open slots.
 */
const QA_HARDFAIL = {
  staleOddsCents: 15, // juice-ladder cents vs lockSnapshot (not raw American subtraction)
  staleLinePts: { Spread: 1.0, Total: 1.0, Moneyline: null },
  // Used by the soft QB adjusters in sports/game_day.js only. Not a hard-fail since 2026-09-28.
  qbOutStatuses: ['out', 'doubtful', 'ruled out', 'injured reserve', 'ir'],
  spScratchKeywords: ['scratched', 'changed', 'will not start', 'scrambled'],
  requireMajorBookStillOffered: true,
  /** When assumed SP unknown, still hard-fail ML/Spread if late scratch signal for either team. */
  mlbScratchWithoutAssumedSp: true,
  /** Open→pick adverse steam (verify recheck). */
  adverseSteamCents: LINE_MOVE.verifyAdverseCents,
  adverseSteamPts: LINE_MOVE.verifyAdversePts,
};

/**
 * Known QB injury = price it, never cancel (founder order 2026-09-28).
 * Sharp practice: a QB listed out/doubtful before kickoff is public and already
 * in the market number. Keep the game and move the projection by the QB's
 * value (spread AND total), then let the normal edge gates decide. Doubtful
 * scales by doubtfulWeight. Used by sports/game_day.js qbSoftAdjust only.
 */
const QB_MARGIN_SCALE = 0; // 2026-10-18: unfitted QB points OFF (textbook path). Was 1.
const QB_INJURY = {
  NFL: { outMarginPts: 3.0, outTotalPts: -1.5, doubtfulWeight: 0.75, maxAbsMarginAdj: 5.0, maxAbsTotalAdj: 3.0 },
  NCAAF: { outMarginPts: 3.5, outTotalPts: -2.0, doubtfulWeight: 0.75, maxAbsMarginAdj: 6.0, maxAbsTotalAdj: 4.0 },
};

/**
 * Prediction-market soft score (v12.3.6). Moneyline only, clean 1:1 map.
 * Venue combine is the arithmetic mean of venues with a finite implied
 * (Polymarket and/or Kalshi). One mapped venue is used alone.
 *
 * pmVsBookGap = pmImplied − bookImplied.
 *   bookImplied prefers fair_sharp_p (no-vig sharp for our side), else
 *   American-implied from the candidate price.
 * pmMove = average of per-venue (now − open) for venues mapped in BOTH the
 *   morning open snap and the generate fetch. Missing open snap, or a venue
 *   present on only one side, leaves pmMove unused (not a fake move).
 *
 * _pmScoreAdj = clamp(
 *   scoreWeightVsBook * pmVsBookGap + scoreWeightMove * (pmMove or 0),
 *   ±maxAbsScoreAdj
 * )
 *
 * maxAbsScoreAdj is a HARD CAP. Steam toward/against is +0.03/−0.04; this
 * cap keeps a large Kalshi/Polymarket disagreement from outranking the US
 * sportsbook CLV spine. Score only: coverProb, edgePct, EV, gates, Kelly,
 * grades, shrink, and unit caps are not touched.
 * Soft-fail: API down or no clean map → _pmScoreAdj = 0. Generate never throws.
 * Keep the v12.3.6 MODEL_NOTES weights/cap in sync with these numbers.
 */
const PM_SOFT = {
  scoreWeightVsBook: 0.20,
  scoreWeightMove: 0.08,
  maxAbsScoreAdj: 0.03,
  venueCombine: 'average',
};


/**
 * Deeper sport-engine soft adjustments (v12.3.7, hardened v12.3.8).
 * Applied INSIDE sport projectors to modelMargin / modelTotal BEFORE
 * blendWithMarket + calibrate. Hard caps prevent a bad feed from dominating
 * the US sportsbook CLV spine. NFL/NCAAF maxAbsMarginAdj caps the STACKED
 * new-engine margin (success or talent + QB continuity), not each piece alone.
 * Soft-fail: missing inputs → adj 0 (prior path).
 * Does NOT change SHRINK_K, SELECT_WEIGHTS, GATES, Kelly, grades, unit caps,
 * or PM_SOFT. Does NOT weaken v12.3.6 PM soft features or v12.3.0 game-day.
 */
const ENGINE_SOFT = {
  MLB: {
    /** Max |runs| bullpen residual margin contribution beyond existing SP/park. */
    maxAbsMarginAdj: 0.35,
    /** Max |runs| total contribution from bullpen residual. */
    maxAbsTotalAdj: 0.40,
    /** Weight on (teamPitchQuality − namedSpQuality) as bullpen residual. */
    bullpenWeight: 0.35,
    /** When both SPs known with player-quality, shrink effective spread std. */
    spKnownStdTighten: 0.08,
    maxStdTighten: 0.10,
  },
  NFL: {
    maxAbsMarginAdj: 1.50, // points
    maxAbsTotalAdj: 1.00,
    /** Success-rate mismatch → soft margin (points per success-rate unit). */
    successMarginPerRate: 8.0,
    /** Healthy QB continuity bonus when no injury flag (home − away), points. */
    qbContinuityPts: 0.55,
  },
  NCAAF: {
    maxAbsMarginAdj: 2.00,
    maxAbsTotalAdj: 1.50,
    /** Blend weight of talent/spPlus differential into margin when BOTH teams have talent. */
    talentWeight: 0.22,
    /** Points per talent unit after normalizing to roughly −3..+3. */
    talentPtsPerUnit: 1.0,
    qbContinuityPts: 0.55,
  },
  /**
   * NHL goal-scale residuals (v12.3.13). Enabled 2026-09-30 (WeBet).
   * Stacked cap covers unclean winPct + shot efficiency + goalie save%.
   * Each goalie piece is tighter still. Missing inputs → 0.
   * Rest/B2B is game_day HFA_ADJ.NHL, not this cap.
   *
   * Goal-rate shrink is sports/nhl.js, not this residual cap.
   * Default OMEGA_NHL_SHRINK_MODE is 'all' (WeBet order 10/09): every club
   * shrinks to the league mean with K=34, clamped into [1.5, 5.2].
   * 'oob' and 'off' stay selectable. 'oob' gives that shrunk rate only to a
   * club whose raw rate is outside the band (the club the old path drops
   * on the flat 6.2 for a band reason). 'off' is the exact pre-shrink path.
   * Replay gate on frozen inputs 2026-09-22..2026-10-08: mode 'all' (K 34,
   * also K 10 and K 20) changed 8 picks and lost $72 versus the unshrunk
   * base. Mode 'oob' changed 0 picks and $0. WeBet ordered 'all' anyway.
   */
  NHL: {
    maxAbsMarginAdj: 0.30,
    maxAbsTotalAdj: 0.35,
    /** Goals of margin per 1.0 winPct gap. Used only when GF/GA is unclean. */
    winPctGoalsPerPoint: 1.2,
    goalieMaxAbsMarginAdj: 0.12,
    goalieMaxAbsTotalAdj: 0.10,
    /** 0.010 savePct → 0.08 goals of margin before the goalie cap. */
    goalieMarginPerSave: 8,
    goalieTotalPerSave: 6,
  },
};


/** Grade = pick quality (edge / expected CLV), NOT units and NOT coverProb. */
const QUALITY_GRADE = {
  // Exact band edges (5.0%, 3.5%, 2.0%) default to the HIGHER grade (>=).
  // Below 2.0% → B (no B+ tier; B stays off the public Edge legend).
  aplus: 0.050,  // ≥5.0% calibrated edge → A+
  a: 0.035,      // ≥3.5% and <5.0% → A
  aminus: 0.020, // ≥2.0% and <3.5% → A-
};

/**
 * Straight rank is qualityScore (calibrated edge vs no-vig). The old
 * w_ev / w_clv / w_uncertainty / corr_penalty mix was not read. Those
 * constants are gone. softSportMixBonus is the steamToward nudge inside
 * the initial sort only. scoreCandidate caps it, with _steamScoreAdj and
 * _pmScoreAdj, at ±0.002. It does not re-rank the three already chosen.
 */
const SELECT_WEIGHTS = {
  softSportMixBonus: 0.02,
};

/**
 * Margin residual SD (points, goals, or runs).
 * NFL 13.2 is FITTED: walk-forward Elo, K=16 (= NFL_PRIOR_K), margin RMSE
 * 13.22 on 855 games, 2023-2025 finals in nfl-hist (elo_indep.py, rerun
 * 2026-10-18). One decimal, same precision as the old 13.5.
 * NCAAF 16, NBA 12, NHL 2.5, MLB 4.2 stay. A closing residual does not
 * identify their rating-error base, and NHL/MLB spreads are fixed ±1.5.
 */
const SPORT_SPREAD_STD = { NFL: 13.2, NCAAF: 16.0, NBA: 12.0, NHL: 2.5, MLB: 4.2 };
/**
 * Total residual SD. NBA is 18: spread SD (12) is the home-margin residual.
 * Total = H+A and pace shocks move both scores the same way, so SD(total)
 * is wider than SD(margin). A pace-aware model still leaves about 16–19
 * (legacy omega used 18.5). 18 pulls total probabilities toward 0.5.
 * It does not change a gate. NBA stays off the daily card.
 *
 * NFL 10.5 stays ASSUMED. Fit check 2026-10-18, not a change: actual total
 * minus the Pinnacle closing total. backtest-1014 closes joined to ESPN
 * finals (nfl-hist has scores but no closing totals in that window).
 * n=44 games, 2026-09-25..2026-10-13. Sample SD 11.44. Game bootstrap
 * B=4000 seed 1, 95% CI [9.91, 12.70], which includes 10.5.
 */
const SPORT_TOTAL_STD = { NFL: 10.5, NCAAF: 13.5, NBA: 18.0, NHL: 1.8, MLB: 3.5 };

/**
 * Rating-error SD on the margin/total → cover conversion.
 * n is the average games played of the two teams. Unknown or non-positive
 * n uses RATING_ERROR_N0 (6).
 * Effective SD = sqrt(game_SD^2 + SD_rating^2). Game SD is
 * SPORT_SPREAD_STD / SPORT_TOTAL_STD (margin uses the spread SD).
 *
 * A number base uses SD_rating = base * sqrt(N0 / max(n, N0)). At n <= 6
 * that is the full base. NCAAF 8/6, NHL 1.25/0.9, MLB 2.1/1.75, NFL total
 * 6, and NBA 0 are ASSUMED. NHL and MLB are half that sport's game SD.
 * NCAAF bases are stated points, not a fitted residual. NBA 0 has no
 * rating-error term. Not refit: no stored series identifies a base whose
 * bootstrap CI excludes the current number. A game residual is not this term.
 *
 * An object {base, k} uses SD_rating = base * sqrt(k / (k + n)). That is
 * the SD of a prior whose weight is priorW = k/(k+n): variance scales with
 * the weight. NFL margin uses this law. FITTED k = 16 = NFL_PRIOR_K
 * (walk-forward Elo margin MSE, 95% CI 6..inf). ASSUMED base 4, the n=0
 * margin rating-error SD. Regressed-Elo prior margin SD on 2023-25 games
 * is 3.56 / 3.70 / 4.55, so 4 is the round scale in that band, not an
 * outcome RMSE. At n=6, NFL margin effective SD is
 * sqrt(13.2^2 + (4*sqrt(16/22))^2) ≈ 13.63.
 */
const RATING_ERROR_N0 = 6;
const RATING_ERROR_SD = {
  NCAAF: { margin: 8, total: 6 },
  NHL: { margin: 1.25, total: 0.9 },
  MLB: { margin: 2.1, total: 1.75 },
  NFL: {
    margin: { base: 4, k: 16 }, // k equals NFL_PRIOR_K. ASSUMED base, FITTED k.
    total: 6, // ASSUMED. Number base keeps sqrt(N0/max(n,N0)). Not refit.
  },
  NBA: { margin: 0, total: 0 },
};

function ratingKind(kind) {
  return /total/i.test(String(kind || '')) ? 'total' : 'margin';
}

/** Average games played. Either side unknown → undefined (caller treats that as n = 6). */
function ratingGamesN(gpHome, gpAway) {
  const a = Number(gpHome);
  const b = Number(gpAway);
  if (!(a > 0) || !(b > 0)) return undefined;
  return (a + b) / 2;
}

function ratingErrorSd(sport, kind, n) {
  const table = RATING_ERROR_SD[String(sport || '').toUpperCase()];
  const entry = table ? table[ratingKind(kind)] : 0;
  const games = Number(n);
  const used = Number.isFinite(games) && games > 0 ? games : RATING_ERROR_N0;
  // {base, k}: SD = base * sqrt(k / (k + n)). A number keeps the N0 law.
  if (entry != null && typeof entry === 'object') {
    const base = Number(entry.base);
    const k = Number(entry.k);
    if (!(base > 0) || !(k > 0) || !Number.isFinite(k)) return 0;
    return base * Math.sqrt(k / (k + used));
  }
  const base = Number(entry);
  if (!(base > 0)) return 0;
  return base * Math.sqrt(RATING_ERROR_N0 / Math.max(used, RATING_ERROR_N0));
}

function gameSdFor(sport, kind) {
  const key = String(sport || '').toUpperCase();
  if (ratingKind(kind) === 'total') return SPORT_TOTAL_STD[key] || 10;
  return SPORT_SPREAD_STD[key] || 13.5;
}

/** Pure. Rating base 0 returns the game SD unchanged (no sqrt). */
function effectiveSd(sport, kind, n) {
  const game = gameSdFor(sport, kind);
  const rating = ratingErrorSd(sport, kind, n);
  if (!(rating > 0) || !(game > 0)) return game;
  return Math.sqrt(game * game + rating * rating);
}

/**
 * Probability anchor. p = w * modelPureP + (1 - w) * p_fair.
 * w = 1 is the model. w = 0 is the market, a real weight, not a hole.
 * Absent sport (NBA) is not anchored. Per sport and market.
 * NFL totals 0 is FITTED (bootstrap median 0; see marketAnchorOn).
 * NFL spread and ml 0.25, and every other entry, stay ASSUMED.
 * This is not the marketAnchorOn() K-table. That switch stays off.
 */
const MARKET_ANCHOR_MODEL_WEIGHT = {
  // FITTED 2026-10-18 from walkforward-cal4 (expanding-window log-loss fit,
  // 2026-09-22..10-08, n=4160 rows / 341 games; B-mode fitted shrink K where
  // p = (1-K)*model + K*sharp, so model weight w = 1-K):
  //  NFL: kMle=1.0 all markets (n=468, 33 g) -> fitted w=0; floored to 0.10
  //    because the fit predates the Oct 17-18 NFL model refits and the NFL
  //    cell is thin. NCAAF: kMle=1.0 (n=1855, 137 g) -> w=0.10 floored.
  //  NHL: kMle=1.0 (n=649, 64 g) -> w=0.10 floored.
  //  MLB spread/ML: kMle=0 (pure model), applied K at 0.30 bound -> w=0.70
  //    FITTED (n=634, 107 g). MLB total: kMle=1.0 -> w=0.10 floored.
  // Market stays the majority everywhere except MLB spread/ML, where the
  // fit strongly favored the model. Re-fit when the dataset refreshes.
  NCAAF: { spread: 0.10, ml: 0.10, total: 0.10 },
  NFL: { spread: 0.10, ml: 0.10, total: 0 },
  NHL: { spread: 0.10, ml: 0.10, total: 0.10 },
  MLB: { spread: 0.70, ml: 0.70, total: 0.10 },
};
/** HFA base; game_day.js applies soft rest/B2B deltas on top. */
const HFA = { MLB: 0.12, NFL: 2.0, NCAAF: 2.6, NBA: 2.5, NHL: 0.15 };

/**
 * Football rest, points on the home margin. Totals stay put (totalCap 0).
 * Home margin = (homePoints − awayPoints) + roadShort when the away team
 * is short. Hard cap ±cap. OMEGA_REST_ADJ=0 skips this and keeps the
 * played-yesterday HFA proxy in game_day.js (byte-identical to 8c2d498).
 *
 * Days are America/New_York calendar days between kickoffs.
 * NFL: short ≤4 (Thursday after Sunday), normal 5–9 except Monday→Sunday
 * at exactly 6 days (mnf), mini-bye 10–12, bye ≥13.
 * NCAAF prices only a Tue/Wed/Thu game on ≤5 days, and a bye ≥13, at half
 * the NFL size. Public college rest estimates are thin.
 *
 * Either side with no prior regular-season game (week 1, preseason, or a
 * failed scoreboard) is unknown and the game's adj is 0. A NCAAF team that
 * is not FBS is unknown for the same reason. Neutral site drops roadShort
 * and keeps the rest differential.
 *
 * Sources, kept inside the modest bands rather than the pre-2011 extremes:
 * - FiveThirtyEight, "How Our NFL Predictions Work" (Elo, through 2022):
 *   +25 Elo on a bye. Home field there is ~48 Elo and about 2 points, so
 *   25 Elo is about +1.0 point. We use +0.70.
 * - BTB Analytics, "Is Extra Rest Really an Edge in the NFL?" (2025):
 *   after the 2011 CBA the bye edge fell to about +0.3 and was not
 *   significant; markets still priced about +0.4 to +1.0. A mini-bye
 *   (10 days after Thursday) was not significant. Monday night into
 *   Sunday was about −0.18 on the margin and −0.37 in the market.
 * - ELWAY forecasts: bye vs non-bye about +1.0; an extra day when the
 *   opponent played Monday night about +0.3.
 * - Zakarian, NFL Analytics, "Does Rest Matter?" (nflverse, 1999–2025,
 *   7,276 games): only a 4+ day rest gap moves home margin. Smaller gaps
 *   sit on the baseline, so a normal week is 0.
 * - BettorEdge bye-week review (2002–2025): 560 of 561 team-games with
 *   ≤4 days of rest faced an opponent also on ≤4 days, so Thursday has
 *   no rest differential. The leftover is the road trip (roadShort).
 *   Thursday totals are not lower (NFL Analytics: Thursday 45.0 vs Sunday
 *   44.1), so this block does not move the total.
 */
const REST_ADJ = {
  NFL: {
    short: -0.55,
    miniBye: 0.35,
    bye: 0.70,
    mnf: -0.35,
    roadShort: 0.35,
    cap: 1.0,
    totalCap: 0,
  },
  NCAAF: {
    short: -0.275,
    bye: 0.35,
    roadShort: 0.175,
    cap: 1.0,
    totalCap: 0,
  },
};

/**
 * NFL total-only weather from the free ESPN scoreboard already fetched
 * for the slate (competitions[0].weather: temperature, windSpeed,
 * displayValue). No new paid call. Dome (venue.indoor) or no weather
 * object adjusts by 0. Wind and cold only subtract from the total.
 * Margin is not an input. MLB stays on applyWeatherTotalAdj.
 *
 * Wind applies at windOnMph and above: windPtsPerMph for each mph above
 * windBaseMph, capped at windCap. Cold is a flat coldAdj at or below
 * coldAtOrBelowF. The two together cannot pass totalCap.
 */
const WEATHER_NFL = {
  windOnMph: 15,
  windBaseMph: 12,
  windPtsPerMph: 0.25,
  windCap: 3.0,
  coldAtOrBelowF: 25,
  coldAdj: 1.0,
  totalCap: 3.5,
};

/**
 * Open-air NFL/NCAAF total nudge from api.weather.gov hourly wind, precip
 * probability, and temperature. Spreads are not an input. Dome and
 * retractable roofs (retractable assumed closed) adjust by 0.
 * OMEGA_FB_WEATHER=0 skips the fetch and the adjustment.
 *
 * Wind is -k per mph above windBaseMph, then capped at windCap.
 * k is the midpoint of the published ~0.3 to ~0.5 points per mph band.
 * Precip and extreme cold are flat. The three together cannot pass totalCap.
 */
const FB_WEATHER = {
  windBaseMph: 10,
  k: { NFL: 0.35, NCAAF: 0.35 },
  windCap: 4.0,
  precipProbAt: 70,
  precipAdj: 0.5,
  coldBelowF: 20,
  coldAdj: 0.5,
  totalCap: 4.5,
  horizonDays: 7,
  budgetMs: 8000,
  callTimeoutMs: 2500,
  concurrency: 6,
};

/**
 * Empirical NFL final-margin mass at 3 and 7. Edge-path spreads use this
 * only for NFL. Half-points next to the number (±2.5/±3.5, ±6.5/±7.5)
 * move by the local excess of this mass over a normal bin, split across
 * the two sides. Integer 3 and 7 carry that adjusted bin as push mass.
 * coverProb is P(win) / (1 − P(push)), which is the probability edge.js
 * multiplies by the decimal. NCAAF is not adjusted.
 */
const NFL_KEY_NUMBERS = {
  3: 0.09,
  7: 0.06,
};

/**
 * Point-space shrink of NFL/NCAAF totals and margins toward the market
 * line BEFORE the normal CDF. projected = line + λ·(model − line), with
 * the line the sharp total or the home spread. Blend, shrinkTowardSharp,
 * and isotonicClip then run unchanged on that number. λ is clamped to
 * [0, 1] at use, so the projection cannot move farther from the line.
 * λ = 1 leaves the model. MLB and NHL are not in this table.
 *
 * Shipped λ is 1 on totals and margins. A pull below 1 stacks on the
 * market blend, shrinkTowardSharp, and isotonicClip and shrinks every
 * football edge, not only a wild one. The targeted control is
 * MODEL_LINE_GAP. A raw gap at or above NFL 8 / NCAAF 10 (54 vs 38.5
 * is the example) is a private review flag. It does not move the
 * projection and it does not reject the candidate.
 */
const POINT_SHRINK = {
  NFL: { total: 1, margin: 1 },
  NCAAF: { total: 1, margin: 1 },
};

/**
 * NCAAF game with either side not FBS (isFbsTeamId false).
 * Spread, total, and moneyline std are multiplied by stdMult.
 * Point-space pull is pointLambda: projected = line + λ·(model − line).
 * OMEGA_NCAAF_FCS=0 disables the flag, the std multiply, and this lambda.
 */
const NCAAF_FCS = { stdMult: 1.25, pointLambda: 0.5 };

/**
 * Weight on the NCAAF preseason/seed prior inside the opponent-adjusted blend.
 * Low returning production regresses that prior-year rating toward the mean.
 * Multiplier = clamp(base + slope * (overallRet - center), min, max)
 * = clamp(0.6 + 0.8 * (overallRet - 0.5), 0.4, 1.0).
 * It scales the seed term only. The games-played weight g/(g+K) stays put,
 * so in-season results take over as games are played.
 * OMEGA_NCAAF_RETPROD=0 disables (multiplier 1). A missing rate is 1.
 */
const NCAAF_RET_PROD = Object.freeze({
  base: 0.6,
  slope: 0.8,
  center: 0.5,
  min: 0.4,
  max: 1.0,
});

function ncaafRetProdMultiplier(overallRet) {
  if (!flagEnabled('OMEGA_NCAAF_RETPROD')) return 1;
  const r = Number(overallRet);
  if (!Number.isFinite(r)) return 1;
  const raw = NCAAF_RET_PROD.base + NCAAF_RET_PROD.slope * (r - NCAAF_RET_PROD.center);
  if (raw < NCAAF_RET_PROD.min) return NCAAF_RET_PROD.min;
  if (raw > NCAAF_RET_PROD.max) return NCAAF_RET_PROD.max;
  return raw;
}

/**
 * Raw |model − line| at or above this many points is a private review
 * flag. Totals compare the model total to the market total. Spreads
 * compare the model margin to −homeSpread (the market-implied home margin).
 * Same threshold for both markets. NFL 8 is past a normal field-goal to
 * touchdown disagreement (~0.76 total-SD) and is the size that still
 * cleared the EV floor when shrink happened only in probability. NCAAF 10
 * matches the wider total SD (13.5 vs 10.5).
 *
 * mode 'flag' keeps the candidate in the pool with the same coverProb,
 * edge, and EV. The card stores picksData.gapReview. Published picks and
 * parlay legs keep the private audit fields. publicPicksPayload strips
 * the list and those fields.
 *
 * mode 'block' failed the 2026-10-06 replay gate. Any blocking variant
 * changed the two-week card. Do not ship 'block'.
 */
const MODEL_LINE_GAP = {
  NFL: 8,
  NCAAF: 10,
  mode: 'flag', // 'block' failed the 2026-10-06 replay gate
};

/**
 * Football model-vs-market reject. Separate from MODEL_LINE_GAP, which only
 * flags. A candidate is dropped before selection when the raw model is
 * farther from the sharp line than these caps. The 2026-10-08 NCAAF card
 * priced Missouri State off a season-sum margin (~64 points vs a 1-point
 * market). Caps sit above a normal touchdown disagreement and above the
 * flag thresholds (NFL 8 / NCAAF 10) so a flagged game can still be priced.
 * NFL is tighter because its margin SD is 13.5 and its total SD is 10.5.
 * NCAAF margin 14 / total 17 leaves room for a noisy October rating without
 * letting a 20-point phantom edge through. Read at call time via the
 * OMEGA_FB_GAP_* env vars so a replay can retune without a new commit.
 * OMEGA_FB_GAP_GUARD=0 or off disables the reject. "0" on a numeric override
 * is a real cap of 0, not the disable switch.
 */
const FB_MARKET_GAP = {
  NCAAF: { margin: 14, total: 17 },
  NFL: { margin: 10, total: 13 },
};

/**
 * Env toggles for the NCAAF ratings fix. Each is read at call time.
 * Unset means the fix is on. "0" / "off" / "false" / "no" disables.
 * A numeric override uses envNumber; a blank value keeps the default.
 */
function flagEnabled(name) {
  const v = process.env[name];
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '') return true;
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

function envNumber(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * NFL-CHANGE: point-pull weight is 1 (raw model point). modelPureP used to
 * blend the market at 0.5 (spread/ml) and 0.10 (total). The probability
 * anchor is now the only market pull. ASSUMED companion to that anchor, not a new fit.
 */
const NFL_MODEL_WEIGHT = { ml: 1, spread: 1, total: 1 }; // NFL-CHANGE
/** NFL-CHANGE: was 0.10. Weight 1 keeps the raw model total. */
const NFL_TOTAL_MODEL_WEIGHT = NFL_MODEL_WEIGHT.total;

/**
 * 2026-10-17: Pinnacle is CLV-only, no pull toward the market line on NCAAF
 * pick probabilities. Weight 1 keeps the raw model point
 * (forecast = line + 1*(model − line) = model). The retired 0.10 blend
 * was the 9/22-10/10 replay (NCAAF LL vs close 0.6193->0.6008).
 */
const NCAAF_MODEL_WEIGHT = { ml: 1, spread: 1, total: 1 };

/**
 * Weight of the NFL Elo margin inside the projected home margin.
 * modelMargin = (1 - w) * existing + w * eloMargin.
 * Read at call time so a replay can set OMEGA_NFL_ELO_WEIGHT.
 * 0 leaves the existing margin unchanged. Clamped to [0, 1].
 * Default 0.8. Replay sweep 2026-09-26..10-10, NFL all candidates
 * vs Pinnacle close: w0.5 LL 0.6965 KL 0.0089; w0.65 0.6898/0.0086;
 * w0.8 0.6843/0.0085; w1.0 0.6709/0.0090. 0.8 chosen for lowest KL.
 */
const NFL_ELO_WEIGHT = 0.8;
/**
 * INTERIM (2026-10-18, Ben-ordered rerun): measured NFL margin bias.
 * Source: live get-omega-health 2026-10-18, biasFor() in health.js —
 * mean (modelProjection + line) for the home spread side = model margin
 * minus market margin = +1.484 pts, n=11 games, alert bias_margin.
 * The correction subtracts that measured residual from the home model
 * margin before the probability conversion. It is NOT a refit; the
 * value must be re-measured from health.js biasFor() on each card date
 * and retired once the ratings refit brings the residual to ~0.
 * OMEGA_NFL_MARGIN_BIAS_PTS overrides; 0 disables.
 */
const NFL_MARGIN_BIAS_CORRECTION_PTS = 1.484;
/** Window for the interim correction: slates 2026-10-18..2026-11-01 only.
 *  After 2026-10-25 the correction stops applying until health.js biasFor()
 *  is re-measured on a fresh slate and this window is deliberately extended.
 *  NHL/MLB have NO equivalent correction (their bias is unmeasured). */
const NFL_MARGIN_BIAS_WINDOW = { from: '2026-10-18', to: '2026-11-01' }; // extended 2026-10-18: residual re-measure on the 12:47 generate (n=11, mean -0.036 after correction, implying +1.448 raw) confirms 1.484 within noise; dataset for a full refit is not on this box. Expiry alert fires after 2026-11-01.
function nflMarginBiasCorrectionPts() {
  const w = envNumber('OMEGA_NFL_MARGIN_BIAS_PTS', NFL_MARGIN_BIAS_CORRECTION_PTS);
  return Number.isFinite(w) ? w : NFL_MARGIN_BIAS_CORRECTION_PTS;
}

function nflEloWeight() {
  const w = envNumber('OMEGA_NFL_ELO_WEIGHT', NFL_ELO_WEIGHT);
  if (w < 0) return 0;
  if (w > 1) return 1;
  return w;
}

/**
 * Games-played weight on a preseason or last-season prior.
 * priorW(gp) = K / (K + gp). Current-season weight is gp / (K + gp).
 * gp <= 0 keeps the prior (weight 1). K <= 0 drops it (weight 0).
 */
function priorW(gp, k) {
  const g = Number(gp);
  const kk = Number(k);
  if (!Number.isFinite(g) || g <= 0) return 1;
  if (!Number.isFinite(kk) || kk <= 0) return 0;
  return kk / (kk + g);
}

/**
 * A set OMEGA_<SPORT>_PRIOR_K. Null when unset or not a finite K >= 0.
 * "0" and "off" are a real K of 0 (no prior weight), read at call time.
 */
function readPriorEnv(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === '0' || s === 'off') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Preseason-prior strength, in games. priorW(gp) = K/(K+gp).
 *
 * NFL shrinks only the preseason Elo deviation from 1505. The in-season
 * Elo shift stays whole. The old form was K = infinity (deviation weight 1).
 * Replay 2026-09-26..10-10 chose 1. The live value is 16, fitted on final
 * scores (walk-forward Elo margin MSE, 95% CI 6..inf; file
 * /workspace/fix-1017/allsports/fit_k_multi.json). OMEGA_NFL_PRIOR_K overrides.
 *
 * NCAAF uses one K for opponent-adjusted strength and pace. The old split
 * was strength 2 and a pace variance near 14. Replay chose 0.5.
 * NCAAF_PACE_FOLLOWS_PRIOR keeps that one-K default. An explicit
 * pacePriorGames argument still wins.
 *
 * NHL is the league-mean GF/GA shrink. The a-priori Poisson K was 34.
 * The live value is 6, set 2026-10-10 on a replay that still blended the
 * market. Open for review. OMEGA_NHL_SHRINK_K still overrides when
 * OMEGA_NHL_PRIOR_K is unset.
 *
 * MLB has no games-played prior (season rates pass through; the total
 * offset is not a function of gp). No Pinnacle closes in the replay
 * window, so MLB_PRIOR_K is not set.
 */
const NFL_PRIOR_K = 16;
const NCAAF_PRIOR_K = 0.5;
const NHL_PRIOR_K = 6;
const NCAAF_PACE_FOLLOWS_PRIOR = true;

function sportPriorK(sport) {
  const key = String(sport || '').toUpperCase();
  const fromEnv = readPriorEnv(`OMEGA_${key}_PRIOR_K`);
  if (fromEnv != null) return fromEnv;
  if (key === 'NHL') {
    const shrink = readPriorEnv('OMEGA_NHL_SHRINK_K');
    if (shrink != null) return shrink;
    return NHL_PRIOR_K;
  }
  if (key === 'NFL') return NFL_PRIOR_K;
  if (key === 'NCAAF') return NCAAF_PRIOR_K;
  return null;
}

function ncaafPriorK() {
  const k = sportPriorK('NCAAF');
  return k > 0 ? k : 0;
}

function nhlPriorK() {
  const k = sportPriorK('NHL');
  return k > 0 ? k : 0;
}

/** True when the NCAAF pace prior uses the same K as strength. */
function ncaafPaceFollowsPrior() {
  if (NCAAF_PACE_FOLLOWS_PRIOR) return true;
  return readPriorEnv('OMEGA_NCAAF_PRIOR_K') != null;
}

function ncaafGpFixEnabled() {
  return flagEnabled('OMEGA_NCAAF_GP_FIX');
}

/** Default 0: pure per-game point diff. K>0 multiplies power by gp/(gp+K). Not SHRINK_K. */
function ncaafShrinkK() {
  const k = envNumber('OMEGA_NCAAF_SHRINK_K', 0);
  return k > 0 ? k : 0;
}

function teamExactOnly() {
  return flagEnabled('OMEGA_TEAM_EXACT_ONLY');
}

function centerDefaultEnabled() {
  return flagEnabled('OMEGA_CENTER_DEFAULT');
}

function fbGapGuardEnabled() {
  return flagEnabled('OMEGA_FB_GAP_GUARD');
}

/** Default on. OMEGA_REST_ADJ=0 keeps the played-yesterday rest proxy. */
function restAdjEnabled() {
  return flagEnabled('OMEGA_REST_ADJ');
}

/** Default on. OMEGA_FB_WEATHER=0 skips the NWS fetch and the total nudge. */
function fbWeatherEnabled() {
  return flagEnabled('OMEGA_FB_WEATHER');
}

/**
 * 2026-10-17: the empty-net end-game step was removed. Season GF/GA already
 * include empty-net goals, so the late-game Markov step double-counted them.
 * OMEGA_NHL_EMPTY_NET is ignored. audit_card still reads this field.
 */
const NHL_EMPTY_NET = Object.freeze({
  enabled: false,
});

function fbMarketGapLimits(sport) {
  const base = FB_MARKET_GAP[sport];
  if (!base) return null;
  if (sport === 'NCAAF') {
    return {
      margin: envNumber('OMEGA_FB_GAP_NCAAF_MARGIN', base.margin),
      total: envNumber('OMEGA_FB_GAP_NCAAF_TOTAL', base.total),
    };
  }
  if (sport === 'NFL') {
    return {
      margin: envNumber('OMEGA_FB_GAP_NFL_MARGIN', base.margin),
      total: envNumber('OMEGA_FB_GAP_NFL_TOTAL', base.total),
    };
  }
  return { margin: base.margin, total: base.total };
}

const CLV_KPI_FLOOR = '2026-09-22';

/**
 * One 10:00 ET generator request. Names Hard Rock. Does not add a second call.
 * Credits stay regions × markets. The list is the books the card already reads.
 */
const GENERATOR_BOOKMAKERS = [
  'pinnacle', 'draftkings', 'hardrockbet',
  'fanduel', 'betmgm', 'caesars', 'williamhill_us', 'espnbet', 'betrivers', 'fanatics',
  'bookmaker', 'betonlineag', 'lowvig',
].join(',');

const MODEL_NOTES = [
  'v12.4.0-webetai-pure: CURRENT (2026-10-18): SIMPLIFIED path. Final p = anchor (w*modelPureP + (1-w)*Pinnacle no-vig fair at the bet number). Gates are ONLY the Good Bet Checker sheet floors (bet_check_gate / v1 thresholds); EV>10% is an audit flag, not a reject. Rank by true anchored probability. Quarter-Kelly, 1.5u cap, daily cap trims lowest true-p first. No leans, no top-ups, no parlay at combined EV <= 0. Interim NFL margin bias -1.484 pts applies only to slates 2026-10-18..2026-11-01. QB margin points OFF (QB_MARGIN_SCALE=0). Everything below is history, not current spec.',
  '2026-10-17: normal cover uses effective SD sqrt(game_SD^2+SD_rating^2), SD_rating=base*sqrt(6/max(n,6)) (NCAAF margin 8 total 6; NHL/MLB half the game SD, ASSUMED; NFL/NBA base 0). NHL/MLB anchor p=0.25*p_cal+0.75*p_fair after calibration (ASSUMED). Published edge is that p minus the vigged price. v12.4.1-webetai-pure (2026-10-17): NCAAF no pull toward Pinnacle (weight 1); NHL empty-net step removed (double count); card copy sanitizer; parlay-leg edge string identity; Hard Rock same-line placeability. OMEGA_MARKET_ANCHOR is ignored, so edge and EV stay on the pure model probability versus the bet price and a short card still fills to 3. Published stake is flat by grade. A+ is 1.5u ($225), A is 1u ($150), A- is 0.75u ($113), and B or any lean is 0.5u ($75). Kelly rounding does not override the grade. A full card (any straight graded A- or better) parlays 0.5u ($75). A lean-only card parlays 0.25u ($38). Risk and to-win are whole dollars rounded up. DAILY_UNIT_CAP is 5.0u so three A+ plus the 0.5u parlay fit. Parlay legs carry pick, odds, matchup, sport, book, edge, and grade. Combined odds are the product of the leg decimal odds. Parlay EV is labeled assumes independent legs. Edge, EV, and pick selection are unchanged. OMEGA_X_AUTOPOST stays unset. Generate prices the stored board and does not re-pull paid odds.',
  'v12.4.2-webetai-textbook: 2026-10-17 ASSUMED. Final p = w(sport,market)*modelPureP + (1-w)*fair (Pinnacle power no-vig, else the unweighted mean of other sharp books that post both sides, else the unweighted mean of every stored book that posts both sides, else that single book power no-vig; 2026-10-18 ASSUMED mean; Circa is not on the stored board). NCAAF and NFL spread 0.25, ml 0.25, total 0.10; NHL and MLB 0.25 on every market; NBA unanchored. NFL-CHANGE: NFL point weights are 1 and RATING_ERROR_SD is margin 8 total 6 so the anchor is the only market pull. Edge floor is the flat 2% (EDGE_FLOOR_K default 0; the 1.5*SE hurdle double-counted the anchor, SIM-REPORT 2026-10-18, not fitted). OMEGA_EDGE_FLOOR_K still overrides. EV above 0.10 is ev-stale for every pick, with no spread exception. Stake is quarter Kelly on a 100u bankroll, 0.25u steps, 1.5u cap. Kelly is not scaled by (1-pPush): f* does not depend on push probability. The 0.5u floor is only a labelled lean; a graded Kelly under 0.5u is published as that lean. Straights rank by the anchored posterior-mean stake EV. A 3-leg parlay with evAtFair <= 0 still publishes as a lean at 0.25u. Parlay joint is the product of final p times 0.95^(n-1), a same-model-bias haircut. The card prints fairP, fairSource, evAtFair, p_model, and modelWeight.',
  'v12.3.74-omega-vnext-price-lock: Inclusion is a flat 2% stake-EV floor at the best DraftKings or Hard Rock price. The odds-scaled edge curve is display and tiebreak only, not an inclusion gate. EV above 12% is ev-stale and is logged, not published and not a lean. Straights stay inside -250 to +250. Rank is probability edge, then stake EV within 0.2 points. When fewer than 3 straights clear 2%, the card fills from the best remaining positive-EV candidates, then the best EV even if it is not positive, one per game, labeled leans at 0.5u. A full card parlays 0.5u and a lean-only card parlays 0.25u, from the best edges on distinct games, and it is labeled when combined EV is not positive. QA auto-corrects and does not block. Generate prices the stored 10:00 ET board (pinnacle, DraftKings, Hard Rock) from omega-pinnacle-line-moves slot 1000 and does not re-pull paid odds. line_move_prob is unchanged. OMEGA_X_AUTOPOST stays unset.',
  'v12.3.73-omega-vnext-price-lock: The 10:00 ET pull is the last Odds API pull and sets final prices. It ranks the top 10 by edge and leaves the card a draft. 10:15 re-ranks that top 10 after news, weather, injury, depth-chart, team-form, and stadium inputs. 10:30 drafts the top 3 and the parlay, then checks Hard Rock placeability at the displayed best US price (Hard Rock or DraftKings, never Pinnacle). A straight that fails is flagged. A parlay that fails is re-priced at the Hard Rock price or a leg is swapped for the next positive-EV distinct-game Hard Rock candidate. The re-price keeps positive edge versus the Pinnacle no-vig and positive EV on each leg and the ticket. The check does not block publish and does not pull odds. 10:45 writes context and summaries. 11:00 is the only finalization. The 3:00 and 10:00 checks are one call, bookmakers=pinnacle,draftkings,hardrockbet. The generator request names hardrockbet in one bookmakers parameter. Stake EV uses the displayed US price. DraftKings is still required. The optional sharp-book slot stays empty. OMEGA_X_AUTOPOST stays unset.',
  'v12.3.72-omega-vnext-price-lock: Every parlay publishes only when combined EV is positive, on a lean day and on a floor day. The probability is the same adjusted cover that sets straight edge and stake EV. A straight ticket that misses is rebuilt from the next-best positive-EV legs on distinct games. A Hard Rock offer on that row is the leg price, and a leg Hard Rock does not offer is swapped. No positive-EV 3-leg is marked no qualifying parlay. Straights still publish. A main still needs 3% edge and the 3% stake-EV floor. A lean still needs 1.5% edge and stake EV above 0.',
  'v12.3.72-omega-vnext-price-lock: The unused sharp book key is off the request list and the sharp priority. Sharp books are Pinnacle, then Bookmaker, BetOnline, and LowVig. The public card omits the read-time tier field. The Edge card does not show a Lean or Main tag. Lean selection, the 1.5% edge and positive-EV rule, 0.5u lean sizing, and 0.25u parlay sizing are unchanged.',
  'v12.3.71-omega-vnext-price-lock: Line movement uses only the 3:00 and 10:00 ET snapshots (plus a stored opener). Retired 6:00/7:30/9:00/9:15 snaps are ignored and a missing 3:00 or 10:00 is logged, not filled from stale data. Pinnacle (an optional second sharp book at equal weight when both ends are already stored) moves the blend weight toward the sharp side before edge, EV, and grade. The shift is capped at ±1.5 probability points and is 0 when the model already matches the sharp. A Pinnacle probability move of 2.0pp against the side, or 18 cents or 1.0 point against on the Pinnacle print, drops the candidate. There is no 10:30 steam recheck. Grade is the calibrated edge versus the Pinnacle no-vig. Stake EV is at the displayed US price. Both are labeled and share the adjusted probability. Floors, lean tier, Kelly, and unit caps are unchanged.',
  'v12.3.71-omega-vnext-price-lock: Daily Supabase sync at 09:25 ET posts yesterday\'s opener, the 10:00 ET snapshot, and the 3:00 ET close, plus the graded Omega card and that day\'s CLV ledger. Duplicate posts are ignored. No Odds API pull. No 10:30 lock capture exists; Odds API pulls stay 3:00 and 10:00 ET.',
  'v12.3.70-omega-vnext-price-lock: A lean-day parlay publishes only when combined EV is positive, at 0.25u. Public picks carry tier main or lean. The 6:00, 7:30, 9:00, and 9:15 ET morning snaps stay retired. Odds API pulls remain 3:00 and 10:00 ET. Results grade a parlay at the card stake and omit the row when the card has no parlay.',
  'v12.3.69-omega-vnext-price-lock: The 3:00 and 10:00 ET DraftKings call also requests Hard Rock (bookmakers=draftkings,hardrockbet, one call, 3 credits). DraftKings quotes and pricing are unchanged. Hard Rock stays review-only.',
  'v12.3.68-omega-vnext-price-lock: The 2026-10-10 golden card records the cover-probability stake cap. A main under 0.42 cover is 0.5u. The cap is unchanged. Leans stay flat 0.5u.',
  'v12.3.67-omega-vnext-price-lock: Power de-vig still runs past -250 or +210 when the raw implieds sum to more than 1. When they sum to less than 1, the fair prices are the proportional split and they sum to 1. Leans, floors, and Kelly are unchanged.',
  'v12.3.66-omega-vnext-price-lock: Main stake EV is 1.5x from +151 to +200 and 2x from +201 to +300. The base stays 3%. A miss can still be a lean. Odds outside -300/+300 stay ineligible.',
  'v12.3.65-omega-vnext-price-lock: 11:00 ET card post runs only when OMEGA_X_AUTOPOST is the string true. Copy containing the words Alpha or Omega is rejected. The flag stays unset.',
  'v12.3.64-omega-vnext-price-lock: NFL calibration report splits totals by wind band and counts spread pushes on margins 3 and 7. Display only. No price change.',
  'v12.3.63-omega-vnext-price-lock: NCAAF tempo weight default is 0.25. A name-matched altitude term is added on top of flat HFA, 0 at a neutral site, capped at 1 point. A frozen snap does not fetch the tempo table.',
  'v12.3.62-omega-vnext-price-lock: NHL goalie residual adds GSAx when both clubs already carry the number, inside the existing goalie cap. A missing side adds 0. Team xG and special teams are not priced.',
  'v12.3.61-omega-vnext-price-lock: Weekly calibration review runs Sunday 06:15 ET, outside the card window. It reports drift and one shrink recommendation and does not apply it. FIT stays off. self-optimize-omega stays paused.',
  'v12.3.60-omega-vnext-price-lock: Results views on the tracking page: win rate versus the break-even rate at the price paid, parlay hit rate versus the product of the straight prices, CLV by price band and market, and log-loss and Brier per sport. Display only. No price, stake, or selection change.',
  'v12.3.59-omega-vnext-price-lock: confirm-starters-mlb logs a would-be Omega scratch and does not rewrite or kill edge-picks-omega. Alpha still updates its card.',
  'v12.3.58-omega-vnext-price-lock: Same-game exposure is on. A main straight plus the parlay stake on that game stays at or under 1.75u. The parlay is not cut. Leans are not trimmed. The trim floor is 0.5u. OMEGA_GAME_EXPOSURE=0 turns it off.',
  'v12.3.57-omega-vnext-price-lock: A main stake is capped at 0.5u when cover probability is under 0.42, and at 1.0u when it is under 0.50. The cap is sizing only. Leans stay flat 0.5u.',
  'v12.3.56-omega-vnext-price-lock: Two-way de-vig uses the power method when either American price is past -250 or +210. Inside that band the split stays proportional. Fair probabilities still sum to one.',
  'v12.3.55-omega-vnext-price-lock: After three graded losses in a row, a main stake uses quarter-Kelly times 0.75 and then drops 0.5u, with a 0.5u floor, until a win. Leans stay 0.5u. Missing grades leave the cut off.',
  'v12.3.54-omega-vnext-price-lock: Two-way de-vig uses the power method when either American price is past -250 or +210. Prices inside that band stay proportional. The fair prices still sum to one. Leans, floors, and Kelly are unchanged.',
  'v12.3.53-omega-vnext-price-lock: At 10:15 ET the card is re-ranked after fresh injury and starter news. A postponed game or a main under the 3% edge floor is replaced from the 10:00 priced pool. If ESPN fails, or the clock is after 10:30 ET, the 10:00 card stays. No Odds API pull.',
  'v12.3.52-omega-vnext-price-lock: The desk CLV report splits stored 3:00 closes into published picks, other candidates, and the same split per sport. odds-master reads clv-candidates-v2 for those KPIs only. Nothing is graded and nothing is written.',
  'v12.3.51-omega-vnext-price-lock: A main pick needs edge of at least 3% versus the de-vigged sharp, and the odds-scaled curve can ask for more up to 6%. Stake EV stays at 3%. A sub-3% edge is not a main. The lean tier is unchanged: positive EV, edge at least 1.5%, DraftKings, one per game, filled only after the mains, flat 0.5u.',
  'v12.3.50-omega-vnext-price-lock: The steam gate and the rank nudge read the latest Pinnacle/DraftKings check against the 3:00 baseline (else the open). Suspended 06:00/07:30/09:00/09:15 snaps are a fallback only when that log has no snapshot. The 15-minute dense-check window is unchanged; a named 03:00 to 10:00 step still steams. Fair price, floors, Kelly, and unit caps are unchanged.',
  'v12.3.49-omega-vnext-price-lock: One straight per game treats vs, at, and @ as the same matchup, in either team order. The game key is the sorted team names. A doubleheader stays two games. An undated key has no commence suffix.',
  'v12.3.48-omega-vnext-price-lock: The 49,000 credit stop applies to backfill and extra pulls only. It does not stop the 3:00 or 10:00 checks, yesterday\'s closes, or the card. Open and other extra pulls still stop below 49,000.',
  'v12.3.47-omega-vnext-price-lock: At 10:30 the card\'s top 3 are compared to the re-ranked list on game, side, and edge. A mismatch rebuilds that order and the parlay. The bug log entry stays off the page.',
  'v12.3.46-omega-vnext-price-lock: The published card shows the three straights with their write-ups, then one parlay section at the bottom. That section is a short summary, the combined odds, and the three legs. It does not repeat each leg\'s write-up.',
  'v12.3.45-omega-vnext-price-lock: The 3:00 ET check grades yesterday\'s CLV from stored historical closes. Entry is the 10:00 fair. Close is the stored Pinnacle no-vig. clv, clvCents, and beatClose are written on clv-candidates-v2 for that date only. No Odds API pull. The grade still runs when the 49,000 credit floor stopped further pulls. The floor itself is unchanged.',
  'v12.3.44-omega-vnext-price-lock: Odds API pulls are 3:00 and 10:00 ET only. 9:00 and 10:30 Pinnacle checks are gone. Morning line snaps, the hourly opener, kickoff closes, the 9:05 shadow generate, and the live NBA shadow pull do not call the Odds API. track-clv-omega does not pull. Hard Rock and the parlay are reviewed from the 10:00 snapshot and pull only when that snapshot does not cover them. The 49,000 credit floor is unchanged.',
  'v12.3.43-omega-vnext-price-lock: Hybrid rank. Edge is the primary key for the top 10, the straights, and the re-rank. When two candidates are within 0.2 percentage points of edge, higher stake EV wins. When the floor does not fill three straights, positive-EV leans fill the open slots, sorted by EV. Probability does not gate or rank.',
  'v12.3.42-omega-vnext-price-lock: Daily card timeline. Final pricing is the 10:00 ET snapshot. Top 10 candidates are ranked by edge, one per game. News already on those rows is the 10:15-10:30 input; the same edge rank is the re-ranked list. QA at 10:30 checks DraftKings on that snapshot and Hard Rock coverage of the top 10 and the three parlay legs. A parlay leg with no Hard Rock price is a backend bug-log entry, silent on the page, and is swapped for the next edge-ranked candidate that has a Hard Rock price or noted. QA does not block publish. The parlay is those three straights. The optimizer is not used. The public card waits until 11:00 ET.',
  'v12.3.41-omega-vnext-price-lock: The 3:00 ET Pinnacle check also stores yesterday\'s pregame closes and today\'s 3:00 baseline. Closes use historical odds (regions=eu, bookmakers=pinnacle, markets=h2h,spreads,totals) at the last snapshot at or before each commence_time. Games that share a commence_time share one pull. A game whose close is already in odds-master, clv-candidates-v2, or clv-{date} is not pulled. Today\'s 3:00 board is the same live pull as v12.3.40: it is the baseline, and the open when none is stored. 10:00 ET pulls Pinnacle and DraftKings and reuses a same-sport odds_snapshot_cache entry younger than 5 minutes. Direction is from the 3:00 baseline, with the same steam rules, and is selection context only. 9:00 and 10:30 stay. Prices append once to odds-master. Priced pulls stop when x-requests-remaining is below 49000. dryRun and OMEGA_REPLAY_NO_WRITE write nothing. The published card is not written. Historical cost is 30 credits per pull. A typical day is about 10 unstored shared kickoffs, about 300 historical credits. No rank, EV, gate, floor, Kelly, or unit-cap change. CLV stays grading-only.',
  'v12.3.40-omega-vnext-price-lock: Pinnacle no-vig line moves (moneyline, spread, total; NFL, NCAAF, NHL, MLB) start from a free hourly /v4/sports/{sport}/events poll. A new event id gets one live Pinnacle open (regions=eu, bookmakers=pinnacle, markets=h2h,spreads,totals), stored once in omega-pinnacle-line-moves keyed by sport/eventId and never re-pulled. Checks at 3:00, 9:00, and 10:30 ET pull Pinnacle and DraftKings, one call per sport, through the snapshot cache. Moves between open, 3:00, 9:00, and 10:30 are logged. Steam is a no-vig move of at least 3 probability points or a spread/total move of at least 0.5 points, same direction at both books, with windowMinutes 15 (STEAM_WINDOW_MIN) on each steam record. The 10:30 card audit and each candidate receive that summary as context. Priced pulls stop when x-requests-remaining is below 49000. No historical odds call. dryRun and OMEGA_REPLAY_NO_WRITE write no blobs. No price, EV, gate, selection, floor, Kelly, or unit-cap change.',
  'v12.3.39-omega-vnext-price-lock: Odds API responses are stored once per sport, snapshot, markets, regions, and bookmakers. Repeat dry runs and replays reuse that snapshot. A cache hit does not spend credits. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.38-omega-vnext-price-lock: NHL moneyline market blend BLEND.ml 0.50->0.10. Replay NHL LL 0.6861->0.6775. Spread stays 0.50 and total stays 0.45. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.37-omega-vnext-price-lock: NCAAF market blend used NCAAF_MODEL_WEIGHT ml 0.10, spread 0.10, total 0.10. Replay 9/22-10/10 NCAAF LL vs close 0.6193->0.6008. 2026-10-17: Pinnacle is CLV-only, no pull toward the market line on NCAAF pick probabilities; weights are ml 1, spread 1, total 1. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.36-omega-vnext-price-lock: NBA stays off the daily card unless OMEGA_NBA=1. Off produces zero NBA candidates and the rest of the card is unchanged. On, NBA uses sports/nba.js and the net-rating seed, the Pinnacle no-vig anchor, DraftKings execution, and the same gates. Aliases: LA Rams, LA Chargers, NY Giants, NY Jets, UL Lafayette, Sixers, Portland Trailblazers. London Lions stays unmapped. No floor, lean-fill, Kelly, shrink, or unit-cap change.',
  'v12.3.35-omega-vnext-price-lock: Public /clv and /tracking pages only. /clv shows the running closing-line total (Alpha Jun 20–Oct 7 and Omega from Sep 5, one row per graded close, written at 9:15 ET). /tracking shows one daily Edge and Omega row for engineering percentiles, track-record KPIs, and closing-line totals, with the change from the previous day. No model change. No price, lean-fill, floor, Kelly, shrink, or unit-cap change.',
  'v12.3.34-omega-vnext-price-lock: NFL total market blend uses NFL_TOTAL_MODEL_WEIGHT 0.10. Replay 9/22-10/10 showed the NFL total projection has no predictive slope vs finals; w 0.45->0.10 cut NFL log-loss vs close 0.6755->0.6703. ML and spread stay 0.50. NCAAF and POINT_SHRINK unchanged. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.33-omega-vnext-price-lock: 10:30 pricing uses the ESPN probable or confirmed MLB starter, including the playoff summary when the scoreboard omits it (spConfirmed false when only the probable is posted), and the ESPN starting goalie on the existing save% term (top-games goalie with goalieConfirmed false when ESPN has no starter; a missing save rate stays 0). A lock snapshot missing a DraftKings spread or total retries that one event every 2 minutes for up to 10 minutes, then prices only the moneyline. Each retry is an audit_log row. OMEGA_DK_RETRY=0 disables it, and dryRun/replay skip unless OMEGA_DK_RETRY_TEST=1. Before publish, a straight or parlay leg whose model fair line is more than 12pp from Pinnacle paired no-vig, or whose spread/total point gap exceeds NFL 7, NCAAF 10, NHL 1.5, or MLB 2, sets dataReviewFlag with those numbers and logs it. Flag only. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.32-omega-vnext-price-lock: DraftKings lags Pinnacle. marketEv = one-book no-vig (Pinnacle, else Circa, no mixed books) times the DraftKings decimal minus 1 at the 10:30 lock. lagEdge = marketEv when that no-vig moved at least +1.0pp toward the side from the morning snap (omega-line-snap 06:00..09:15) or the opener and DraftKings implied moved less than half of that move (DK_LAG.maxDkFollowRatio 0.5). OMEGA_DK_LAG=0 disables. A lag side adds lagEdge to the ranking edge and publishes coverProb = max(model coverProb, the anchor no-vig), so stake EV is never based on a probability above the fresh fair unless the model was already higher. Floors, caps, Kelly, full-card and parlay rules are unchanged. Offline eval 2026-09-26..10-10: n lag 1, avg CLV +0.003029, beat close 100.0%, all-candidate LL off 0.635988 on 0.635988 (n=1082). No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.31-omega-vnext-price-lock: When fewer than 3 straights clear the floor, open slots fill from leans with stake EV > 0 after vig, edge >= 1.5% vs the no-vig sharp, a DraftKings line, and a pregame board. One pick per game. Games that already hold a straight are skipped. Leans rank by EV and stake flat 0.5u. The daily cap does not raise a lean. On a card that includes a lean, the parlay is the top 3 card picks on distinct games when their combined EV is positive, sized 0.25u. Otherwise it is the best positive-EV distinct-game 3-leg from the eligible pool, also 0.25u. A publishable positive-EV lean is not a No Qualifying Plays card. Floors, calibration, and the market anchor are unchanged.',
  'v12.3.30-omega-vnext-price-lock: prior weight is priorW(gp)=K/(K+gp). Replay 2026-09-26..10-10 (15 dates), all candidates vs Pinnacle close, model log-loss. NFL was preseason-deviation weight 1: K0.5 0.6756, K1 0.6736, K2 0.6753, K3 0.6760, K4 0.6799, K6 0.6807, K8 0.6812, K12 0.6829. Chosen NFL_PRIOR_K=1. 2026-10-18: NFL_PRIOR_K is 16, fitted on final scores (walk-forward Elo margin MSE on ESPN finals, 2023-2025 pooled n=855, prior = last-season end Elo regressed 1/3, prior shrunk by K/(K+games) and the walk started from the shrunk prior, game-bootstrap B=3000; K=1 MSE 177.4, K=16 about 174.85, pooled argmin 16, bootstrap argmin median 16, 95% CI 6..inf; K=1 minus K=13 = +2.5, 95% CI 0.3..4.7; 2026 first 80 games K=1 161.4, K=13 154.1, K=inf 152.8; file /workspace/fix-1017/allsports/fit_k_multi.json). NCAAF was strength 2 and pace ~14; one K now covers both: K0.5 0.5948, K1 0.5964, K2 0.5964, K3 0.5995, K4 0.6018, K6 0.6055, K8 0.6070, K12 0.6093. Chosen NCAAF_PRIOR_K=0.5. NHL was 34: K0.5 0.6877, K1 0.6863, K2 0.6833, K3 0.6824, K4 0.6806, K6 0.6790, K8 0.6801, K12 0.6796. Chosen NHL_PRIOR_K=6. Outcome rows moved with K (NFL 118-124, NCAAF 414-421, NHL 326-331). Every grid K, and the joint K=1/0.5/6 run, kept 2026-10-04 and 2026-10-10 at 3 straights plus a 3-leg parlay. MLB unchanged (no closes, no games-played prior). No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.29-omega-vnext-price-lock: NCAAF returning production, including transfers (Connelly/ESPN 2026), scales the opponent-adjusted seed prior. The priorWeight multiplier is clamp(0.6 + 0.8*(overallRet-0.5), 0.4, 1.0), so a low returning-production roster regresses the prior-year rating toward the mean. Games-played shrink is unchanged and in-season results take over as games are played. A missing team uses multiplier 1. OMEGA_NCAAF_RETPROD=0 disables. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.28-omega-vnext-price-lock: E2 quarter-Kelly units are x50, nearest 0.5u, floor 0.5u when Kelly > 0, drawdown x0.75 floored at 0.5u. E3 a football shutout pa === 0 with gp >= 1 is pf/gp. E4 NCAAF non-FBS games set fcsGame, widen spread/total/ML std by 1.25, and pull to the line at lambda 0.5 (OMEGA_NCAAF_FCS=0 disables). E6 the market anchor is Pinnacle, else Circa, else the existing sharp fair; posted MLB totals follow that order, then the median of the other sharp books. E1 and E5 were tested and dropped. E1 set the unset default to the 0.42–0.58 bandRetainClip; with publish cover floors off, the band lifted dog probabilities toward 0.42 and the 10/11 dry run picked +215/+205/+180 dogs at 14–24% EV. E5 dropped unpaired rows and NHL log-loss vs close worsened +0.0013.',
  'v12.3.27-omega-vnext-price-lock: NFL Elo blend default weight is 0.8 (OMEGA_NFL_ELO_WEIGHT still overrides). Replay 2026-09-26..10-10, NFL all candidates vs Pinnacle close: w0.5 LL 0.6965 KL 0.0089; w0.65 0.6898/0.0086; w0.8 0.6843/0.0085; w1.0 0.6709/0.0090. 0.8 chosen for lowest KL. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.26-omega-vnext-price-lock: Per-run audit log of API and model calls (omega-audit/<date>/<runId>, card.audit summary). Observe-only recal-report-omega at 9:15 ET scores per-sport CLV, log-loss, Brier, KL, and fitted shrink K on 7/14/28-day windows and writes omega-recal-report only. ESPN depth-chart QB1 is the starter feed for NFL; NCAAF falls back. NFL Elo uses K 20, the FiveThirtyEight margin-of-victory multiplier, one-third regression to 1505, and a 2:1 DraftKings win-total blend, attached at weight 0.5. Replay NFL log-loss .7153 to .6965 and KL .0127 to .0089. NHL empty-net end-game Markov: NHL log-loss .6850 to .6790 and KL .0059 to .0045. NCAAF tempo totals are present and off (weight 0); the replay sweep worsened log-loss. npm test runs in parallel with a network guard, a golden card, and invariant tests. No floor, Kelly, shrink, or unit-cap change.',
  'v12.3.25-omega-vnext-price-lock: A QB status adjustment applies only to the team\'s starting QB (ESPN depth QB1 when present, else the named-starter list, Lamar Jackson BAL). Injured backups have no effect. Parlay legs copy the capped straights\' units.',
  'v12.3.24-omega-vnext-price-lock: Live generate prices the 9:30 AM ET historical snapshot and does not refetch the live board when the run is late. Verify auto-corrects a material Hard Rock line or price. Floor tier is calibrated stake EV >= 3% and edge vs the de-vigged sharp at or above the odds-scaled curve (1.75% at -110, plus 0.05 per implied point of plus-money distance from -110, plus 0.04 per uncertainty point above 0.15, cap 6%). No flat coverProb floor. A short straight card fills from the 1.5% EV lean tier, labeled lean, max 0.5u. The grade-lift cannot raise a lean above 0.5u. ONE_STRAIGHT_PER_GAME defaults true, so straights keep one side per game and the next distinct game fills. Set it false to publish two sides of one game. Parlay legs need coverProb >= 45%. When the three published straights are on distinct games, each clears that cover, and their combined EV is positive, the parlay is those straights. Otherwise the best positive-EV 3-leg by edge, then the best 2-leg, or no parlay. Quarter-Kelly, 1.25u, 0.5u parlay, and 4u daily stay.',
  'v12.3.23-omega-vnext-price-lock: Live generate prices the 9:30 AM ET historical snapshot (any major US book) and does not refetch the live board when the run is late. Verify auto-corrects a material Hard Rock line or price: reprice at Hard Rock, keep the pick when the edge still clears the odds-scaled floor, otherwise take the next Hard Rock-confirmed candidate, and rebuild the parlay. The card still publishes. minEV and minCoverProb stay 0. The edge floor is 1.75% at -110 plus 0.05 per implied point of plus-money distance from -110 plus 0.04 per uncertainty point above 0.15, capped at 6%. No flat coverProb floor.',
  'v12.3.22-omega-vnext-no-floors: Publish floors are off. minEV and minCoverProb are 0, so a positive edge at a major book is not rejected for a 3% EV floor or a 48% coverProb floor. minPredictedClvCents is null and does not reject. Generate-time placeability is logged and does not block. Verify still confirms the Hard Rock line and may drop only when Hard Rock and US majors both fail. Mode A calibration stays the hand-set shrink. The 0.42–0.58 band is legacy only. Mode B K_MIN 0.3 and CAL_POOL sample floors are fit constraints, not publish gates. Odds band, liquidity, pregame, same ET day, and adverse steam stay. Kelly and unit caps stay. Straights, parlay, and the exposure cap are unchanged from v12.3.21.',
  'v12.3.21-omega-vnext-edge-card: Straights are the top edges vs no-vig fair, including a second side of the same game. Score nudges only break an exact edge tie. The parlay is the best edges on distinct games and may overlap the straights. The only parlay conflict is two legs from the same game. Same-direction totals and same-conference NCAAF totals may share a ticket. The same-direction haircut still lowers joint probability and never raises it. PER_GAME_EXPOSURE_CAP_ENABLED is false, so the 1.50u same-game stake cap does not run. Gate floors, Kelly, unit caps, SHRINK_K, and calibration are unchanged. A gate reject is logged. It does not throw.',
  'v12.3.20-omega-vnext-edge-rank: Straight rank is calibrated edge. _steamScoreAdj, _pmScoreAdj, and the steamToward softSportMixBonus are added together and capped at ±0.002, so they only break ties. A 0.03 steam boost plus the 0.02 mix bonus no longer outranks a higher edge. Adverse-steam hard rejects are unchanged. The parlay is chosen from the full yes pool, including straight sides. Same-game legs, same-direction same-league totals, and same-conference NCAAF totals still cannot share a ticket. OMEGA_GAME_EXPOSURE defaults off. Set it on to restore the 1.50u same-game cap. No gate, floor, Kelly, unit-cap, SHRINK_K, or calibration change.',
  'v12.3.19-omega-vnext-parlay-decorr: Parlay selection keeps one leg per game. It also refuses two same-direction totals in the same league, so three NFL overs cannot fill a ticket. NCAAF totals that share a conference are refused even when the sides differ. A missing conference does not invent a shared conference. Same-direction totals keep the 0.95/0.92 haircut. The joint probability used for EV stays at or below the independent product. Pearson ρ 0.08 only raised that joint, so OMEGA_PARLAY_CORR defaults off. Setting it on does not replace the haircut and cannot raise EV. No gate, floor, Kelly, unit-cap, SHRINK_K, or calibration change.',
  'v12.3.18-omega-vnext-keys: NFL and NCAAF spreads use an empirical key-number margin distribution. NFL totals use the Sports Insights shape. NCAAF totals stay on the normal. OMEGA_KEY_MASS=0 restores nflKeyNumberCover and the plain normal. Stake EV and quarter-Kelly scale by (1 − pPush) after calibration. Mode A still shrinks the conditional coverProb toward the hand-set sharp anchor and does not apply the unfitted band. calibrateCandidate copies pPush and lateNews through. attachEv and toPickObject then apply the push factor to that mode-A coverProb. edgePct stays coverProb − fair_sharp and is not scaled. OMEGA_PUSH_EV=0 leaves evAtOdds and Kelly on the same calibrated coverProb. NHL moneylines, puck lines, and totals are priced from a 60-minute joint and then overtime. OMEGA_NHL_PERIOD=0 restores the full-game normal. Same-direction cross-game totals use Pearson ρ 0.08 inside the Fréchet bounds. OMEGA_PARLAY_CORR=0 restores the 0.95/0.92 haircut. Same-game straight units plus the full parlay stake are capped at 1.50u after the slate cap and the grade hierarchy. A void-pregame parlay leg is not exposure. A void-pregame straight is not trimmed by that cap. OMEGA_GAME_EXPOSURE=0 leaves the slate cap. Late-news still drops or flags only, then resolveLockedParlay and enforceOmegaDailyUnitCap rerun this exposure cap on the surviving card. Each card stores a private audit of model version, config hash, and input snapshot hash. The public payload drops audit, lateNews, and voidedPregame, and omits void-pregame picks and legs. OMEGA_CARD_AUDIT=0 omits the field. No gate floor, SHRINK_K, or cal-mode default change.',
  'v12.3.17-omega-vnext-cal-a late-news: generate stamps lateNews after projectAll(snap, dateISO) and before calibrateAll(candidates, { cardDate }). The stamp records the generate-time MLB probable, NHL goalie (goalieEdge only when goalieResidual ran), and NFL/NCAAF QB tag. It does not change coverProb. Verify at 10:30 ET and pregame-check-omega every 30 minutes from 11:00 through 23:30 ET may void or flag a pick whose commence is inside 90 minutes. MLB drops on a stored probable change, postponement, or suspension. NHL flags a confirmed boxscore starter change and drops only when goalieEdge is true. NFL/NCAAF drops a newly out or IR quarterback and flags newly doubtful. Drop or flag only. Never add or swap a pick. No gate, floor, Kelly, unit-cap, or calibration change.',
  'v12.3.17-omega-vnext-cal-a identity: every slate team string resolves to one ESPN id on NFL, NCAAF, MLB, NBA, and NHL. Explicit aliases ship in the client and the server. Fuzzy matching runs only on the OMEGA_TEAM_EXACT_ONLY=0 allowFuzzy path. A shared league token (NBA "New York", MLB "sox", and the other ambiguous names) must stay unresolved. A suspended final grades as a push, the same as postponed or cancelled. No gate, floor, Kelly, unit-cap, or calibration change.',
  'v12.3.17-omega-vnext-cal-a: default calibration is mode A. Shrink K is still hand-set (SHRINK_K and MLB_CALIBRATION.shrinkK). Mode A removes the unfitted 0.42–0.58 band and keeps that hand-set shrink. The band kept 0.25 of the excess. It was named isotonicClip and was not a fitted isotonic regression. That function is bandRetainClip. OMEGA_CAL_MODE=legacy restores the hand-set shrink plus that band and is the exact rollback. Mode B stays selectable. It fits one K per sport and market on p=(1-K)*p_model+K*p_sharp by log-loss and does not apply the band. K is bounded to [0.3, 1.0]. The lower bound is a product constraint, the lowest hand-set K already on the card (MLB moneyline 0.30), not a log-loss estimate. kMle is the unconstrained minimizer on [0, 1] and is not applied below 0.3. On the full window that floor binds for MLB spread and MLB moneyline (kMle 0, applied K 0.3). Most other cells fit K=1, the sharp. A cell under 80 graded rows or 20 games uses the sport pool, then the global pool, then the hand-set K. Mode B is not the default: the 2026-10-10 and 2026-10-11 dry runs each published 0 picks under the valid-card requirement. Mode C stays selectable. It keeps the hand-set shrink and fits Platt, or isotonic regression when the train pool has at least 400 rows and 50 games and beats Platt by 0.001 train log-loss. Expanding window 2026-09-22..10-08, 4160 graded rows, 341 games, cluster bootstrap by game, B=1000, seed 6167. Log-loss: market 0.658108, B 0.659223, A 0.660488, C 0.662862, production 0.673287. A minus production -0.012840, 95% CI -0.017171..-0.008556. Replay on the current floors: base 30 straights, 1.765/day, 5 zero-pick days; A 30, 1.765/day, 5 zero days; B 27, 1.588/day, 4 zero days; C 44, 2.588/day, 0 zero days. A is the default because it beats production log-loss and keeps 1.765 picks/day. The fitted-K mode B has a lower out-of-sample log-loss and is still selectable, but it empties the live card. minCoverProb, minEV, Kelly, and the unit caps are unchanged.',
  'v12.3.16-omega-vnext-ncaaf-oa-wx: NCAAF opponent-adjusted ratings (1851e0b, 5fb30d3). Offense and defense are fit from completed scoreboards and shrunk toward the centered EPA seed by games played (strength K=2). Pace shrinks on its own prior (totalStd^2 over the seed pace variance, not the strength K), so a short run of blowouts does not print a 65-72 total. A non-FBS opponent is one shared rating, and those games still update the FBS side. Below 40 completed FBS games the pack is withheld and the previous path is unchanged. NCAAF EPA by ESPN id plus centered fallback totals (2f125a2): a seed row binds by ESPN id or an explicit alias, and a mascot collision with a different school is not logged as an EPA miss. When the opponent-adjusted pack is withheld, one missing EPA side is a games-played regression instead of dropping both teams to raw point differential. Fallback totals use the close-game FBS mean, and leaguePpg is 26 so it matches baseTotal 52. NFL/NCAAF NWS weather totals adjustment (46c592c): open-air totals take api.weather.gov hourly wind, precip, and temperature at the home stadium, or at the ESPN competition venue when the game is neutral. Domes, unknown venues, and fetch failures adjust 0. Spreads are not moved. Frozen replay has no NWS snap, so that adjustment is 0 and the card stays byte-identical. No gate, floor, Kelly, unit-cap, SHRINK_K, or calibration change.',
  'Football weather (NWS): open-air NFL and NCAAF totals take api.weather.gov hourly wind, precip probability, and temperature at the home stadium, or at the ESPN competition venue when the game is neutral. Wind adj = -0.35 * max(0, sustained mph - 10), wind cap -4.0. The coefficient is the midpoint of the published band of about -0.3 to -0.5 points per mph above ~10 mph (NFL Analytics, 7,276 games 1999-2025: calm games averaged 44.7 points and games above 16 mph averaged 40.5; wind, not cold, is the scoring driver). Precip probability at or above 70% is -0.5. Temperature below 20F is -0.5. Combined cap -4.5. A dome or a retractable roof adjusts 0 (retractable is assumed closed; there is no roof-status feed). An unknown venue, or a venue outside NWS coverage (international), adjusts 0. Spreads are not moved. A game outside the 7-day hourly window, a fetch error, or a timeout soft-fails to no NWS adjustment. When an NWS observation is present it is the only football total weather adjustment; an NWS miss leaves the existing ESPN scoreboard wind path in place for NFL. OMEGA_FB_WEATHER=0 disables the fetch and the adjustment. Frozen replay has no NWS snap, so this adjustment is 0 and the card stays byte-identical. OMEGA_FB_WEATHER_FIXTURE_DIR reads fixtures instead of the network.',
  'v12.3.15-omega-vnext-night: Saturday card correctness. MLB/NFL/NCAAF/NHL/NBA ESPN rows bind by resolved team id and nearest commence; two rows reject unless the nearest is within 75 minutes and at least 75 minutes clearer than the next (IDENTITY_CLEAR_MARGIN_MS). Doubleheader matchup keys include commence time (still one price per game, max 3 straights). Unused rank weights w_ev, w_clv, w_uncertainty, and corr_penalty are removed; rank stays qualityScore. The post-hoc softSportMixBonus write no longer reorders the chosen straights. NFL id-only fallback passes neutralSite. regrade-circa runs every ET hour at :40 including 01:40 and 02:40 (dstFold both). Played-yesterday rest proxy is documented as 1 day only. sharpPostedTotal is the posted sharp total point. NHL health copy says a snap that lacks goal columns is not a live 6.2 claim. Capture-health reports legacy clv-candidates-{date} row counts for today and yesterday (read only). No gate, floor, Kelly, unit-cap, SHRINK_K, or calibration change.',
  'v12.3.14-omega-vnext-rest: NFL/NCAAF rest days from ESPN weekly scoreboards (card week and the previous two). Short week, mini-bye, bye, and Monday-night into Sunday move the home margin by the team difference plus a small road-on-short-rest term. Hard cap ±1.0 pt. NCAAF midweek and bye are half the NFL size, same cap. Totals unchanged. The current kickoff is not a prior game (same team-id pair within 36h, and the prior kickoff must be an earlier ET date). A team that is not FBS is unknown, so the game adj is 0. Neutral site drops the road-short term. OMEGA_REST_ADJ=0 restores the played-yesterday proxy. No gate, Kelly, unit-cap, SHRINK_K, calibration, or parlay change.',
  `v12.3.13 omega-vnext: NHL projector ENABLED (WeBet 2026-09-30). Moneyline, puck line (Spread), and total come from per-game goals for/against plus HFA.NHL ${HFA.NHL} (FiveThirtyEight home ice is about 50 Elo, already this goal HFA). Season totals divide by games, counting OT losses when games is absent. Missing or unclean GF/GA stays on the 6.2 / HFA baseline. A winPct residual runs only on that unclean path. Shot efficiency runs only when both clubs have shots and savePct; a goalie residual runs only when both save rates are present. v1 does not require a goalie confirmation feed. Both residuals sit under ENGINE_SOFT.NHL HARD CAP ±${ENGINE_SOFT.NHL.maxAbsMarginAdj} goals margin / ±${ENGINE_SOFT.NHL.maxAbsTotalAdj} total (goalie alone ±${ENGINE_SOFT.NHL.goalieMaxAbsMarginAdj} / ±${ENGINE_SOFT.NHL.goalieMaxAbsTotalAdj}) and soft-fail to 0. Game-day B2B uses SHORT_REST_DAYS.NHL = 1 with a goal-scale HFA_ADJ (max 0.10). Projections soft-clamp at |margin| 6 and total 12 and still emit a candidate. Blend matches MLB: ML 0.50 / spread 0.50 / total 0.45, no-vig Pinnacle/Circa. SPORTS_ENABLED.NHL = true. Plug-in only on existing select path with MLB/NFL/NCAAF. No Omega core routing change. FIT off. No TSP. No gate, Kelly, unit-cap, global SHRINK_K, MLB_CALIBRATION, SELECT_WEIGHTS, or isotonic change. FIT off. No TSP. NBA off. DAILY_UNIT_CAP stays ${DAILY_UNIT_CAP}.`,
  'Patch 2026-09-28 (v12.3.12 label kept): NFL/NCAAF QB out/doubtful is no longer a QA hard-fail. Known QB injuries are priced once, not cancelled and not double-counted: qbSoftAdjust moves the model injury-blind baseline (margin NFL 3.0 / NCAAF 3.5 for out, 0.75x doubtful; total NFL -1.5 / NCAAF -2.0) before the 0.50/0.45 blend against the current market line (which already embeds the injury). qbContinuityAdjust no longer treats out/doubtful as unhealthy — that would have piled a second penalty on the same known injury. Continuity only moves for questionable. Edge gates then decide. MLB SP scratch/change hard-fail unchanged.',
  `v12.3.12 omega-vnext: desk lock. Verify may drop, flag, or resize inside the 3.5/0.5/${DAILY_UNIT_CAP} cap. It does not add a straight and it does not rebuild a generate-locked parlay from the straight card. Steam and placeability drops are not refilled (blockStraightRefill still records the steam block). Stale-odds cents use the American juice ladder, so a plus-to-minus cross is not a fake 200-cent hard-fail. Candidate-table rank follows the same quality score as the letter grade. Summary meanClvPct is the probability, not a second copy of the cent figure. Evening walk-forward observer at 23:45 UTC (7:45pm ET in EDT) writes omega-walkforward only, after the 23:00 UTC close pass. The 2026-11-01 EDT→EST cron shift is documented and not applied. No gate, Kelly, unit-cap, global SHRINK_K, MLB_CALIBRATION, or isotonic change. FIT off. No TSP. NBA/NHL off. LEAN_PAD false. DAILY_UNIT_CAP stays ${DAILY_UNIT_CAP}.`,
  `v12.3.11 omega-vnext: run environment. MLB base margin and total come from per-game runs scored and allowed (season totals divided by wins+losses when ESPN pointsFor is a season sum; missing or unclean standings stay on the 8.6 / HFA baseline). A 100-run season gap is about one run, so starter, park, and bullpen residuals move the probability instead of sitting under a clamped 0.95. Moneyline blend uses the same no-vig Pinnacle/Circa anchor as spreads and totals. Weights unchanged: MLB ML 0.50 / spread 0.50 / total 0.45, NFL ML 0.50 / spread 0.50 / total 0.45, NCAAF ML 0.45 / spread 0.45 / total 0.40. fair_sharp prefers a paired same-book no-vig (Pinnacle, then Circa, then the other sharp books) and does not de-vig mixed books. Open-to-now steam cents use the American juice ladder, so a plus-to-minus cross is not a fake 200-cent move. Capture-health retry labels a canonical slot within 12 minutes, or the latest due slot when the book is empty, and does not insert an off-slot poll. Close grades prefer Circa and Bookmaker ahead of exchanges when Pinnacle is absent. Straight rank is qualityScore (the same calibrated edge as the letter grade), not the old EV/CLV mix, so a plus-money dog does not outrank a cleaner price. SELECT_WEIGHTS numbers are unchanged and unused except softSportMixBonus. No gate, Kelly, unit-cap, global SHRINK_K, or MLB_CALIBRATION change. FIT off. No TSP. NBA/NHL off. DAILY_UNIT_CAP stays ${DAILY_UNIT_CAP}.`,
  `v12.3.10 omega-vnext: sharp blend. Spread and total market anchors are the equal-weight average of no-vig Pinnacle and no-vig Circa (circa or circasports). One of those books is used alone when the other has no two-way price. If both are missing, the anchor is the existing sharp no-vig pair. Never prices[0]. Blend weights unchanged: MLB spread 0.50 / total 0.45, NFL spread 0.50 / total 0.45, NCAAF spread 0.45 / total 0.40. Moneyline blend unchanged (vigged Pinnacle, else the first price) at MLB 0.50 / NFL 0.50 / NCAAF 0.45. No gate, Kelly, unit-cap, or global SHRINK_K change.`,
  `v12.3.9 omega-vnext: card fill. MLB second shrink only. Global SHRINK_K unchanged (Total ${SHRINK_K.Total} / Spread ${SHRINK_K.Spread} / Moneyline ${SHRINK_K.Moneyline} / default ${SHRINK_K.default}). MLB_CALIBRATION.shrinkK Total ${MLB_CALIBRATION.shrinkK.Total} / Spread ${MLB_CALIBRATION.shrinkK.Spread} / Moneyline ${MLB_CALIBRATION.shrinkK.Moneyline} / default ${MLB_CALIBRATION.shrinkK.default}. Isotonic stays global 0.42–0.58 keeping 0.25 of the excess for every sport, so a wild probability still cannot print a 15-point fake edge. At least 3 distinct gate-clear games in the yes pool publish 3 straights. Parlay primary rank is combined hit probability; EV is a tie-break only; a +EV 3-leg is preferred whenever one exists. Verify replacement units are quarter-Kelly via kellyToUnits capped at MAX_STRAIGHT_UNITS_PER_PICK ${MAX_STRAIGHT_UNITS_PER_PICK}, then the 3.5/0.5/${DAILY_UNIT_CAP} daily cap. No alpha-config read and no mlUnitCap ladder. Favorite parlay combinedOdds (decimal < 2) format as minus. NFL/NCAAF/MLB verify cover floor is GATES.minCoverProb 0.48. LEAN_PAD false. FIT off. No TSP. NBA/NHL off. DAILY_UNIT_CAP stays ${DAILY_UNIT_CAP}. GATES unchanged.`,
  `v12.3.8 omega-vnext: Grok Build 4.7 xhigh redo of v12.3.7 deeper sport engines. Same product intent and caps philosophy. MLB bullpen residual HARD CAP ±${ENGINE_SOFT.MLB.maxAbsMarginAdj} runs margin / ±${ENGINE_SOFT.MLB.maxAbsTotalAdj} total, and the post-bullpen total stays inside the existing 5.5–14.5 run band; SP-known spread/ML std reads SPORT_SPREAD_STD.MLB and tightens by at most ${ENGINE_SOFT.MLB.maxStdTighten} (0 → prior std). NFL success-rate margin and QB continuity stay individually capped, then the STACKED new-engine margin is HARD CAP ±${ENGINE_SOFT.NFL.maxAbsMarginAdj} so the two cannot add past the spine. NCAAF talent/spPlus uses the seed scale (centered values no longer flip sign above 5) at weight ${ENGINE_SOFT.NCAAF.talentWeight}, HARD CAP ±${ENGINE_SOFT.NCAAF.maxAbsMarginAdj}, and QB continuity shares that stack. Soft-fail: missing feed/seed → adj 0, generate continues. No FIT. No TSP. No SHRINK_K, SELECT_WEIGHTS, blend, gate, Kelly, grade, unit cap, or PM_SOFT retune. NBA/NHL off.`,
  `v12.3.7 omega-vnext: deeper MLB/NFL/NCAAF sport engines (capped). MLB: bullpen residual from team pitching − named SP (StatsAPI already loaded) with HARD CAP ±${ENGINE_SOFT.MLB.maxAbsMarginAdj} runs margin / ±${ENGINE_SOFT.MLB.maxAbsTotalAdj} total; when both SPs have player-quality, tighten spread/ML std by up to ${ENGINE_SOFT.MLB.maxStdTighten}. NFL: success-rate mismatch soft margin (capped ±${ENGINE_SOFT.NFL.maxAbsMarginAdj} pts) + QB continuity when injury map is non-empty and team has no flag (capped ±${ENGINE_SOFT.NFL.qbContinuityPts}). NCAAF: optional talent/spPlus seed overlay blended at weight ${ENGINE_SOFT.NCAAF.talentWeight} with HARD CAP ±${ENGINE_SOFT.NCAAF.maxAbsMarginAdj} pts — missing talent → prior EPA/standings. Soft-fail: missing feed/seed → adj 0, generate continues. Feeds existing modelRawP→coverProb pipeline; US sportsbook CLV spine primary. Does not change SHRINK_K, SELECT_WEIGHTS, blend weights, GATES, Kelly, grades, unit caps, or PM_SOFT. No FIT. No TSP. NBA/NHL off.`,
  `v12.3.6 omega-vnext: Kalshi/Polymarket soft features inside generate, before selectStraights. Moneyline only, clean 1:1 map. Venue combine is the average of available mapped venues. pmVsBookGap = PM implied minus fair_sharp_p (else American-implied). pmMove = current PM implied minus the morning open snap (omega-pm-observer/{date}-open) when that snap exists, averaged per venue present on both sides; omitted otherwise. Score-only _pmScoreAdj = clamp(scoreWeightVsBook*pmVsBookGap + scoreWeightMove*pmMove, ±maxAbsScoreAdj) with weights ${PM_SOFT.scoreWeightVsBook} / ${PM_SOFT.scoreWeightMove} and HARD CAP ±${PM_SOFT.maxAbsScoreAdj} so PM cannot dominate the US sportsbook CLV spine. Does not change coverProb, edgePct, gates, Kelly, grades, shrink, or unit caps. Soft-fail to _pmScoreAdj 0 if PM APIs are down or unmapped; generate continues. Historical replay skips live PM (no as-of snap). Observer audit omega-pm-observer/{date} retained (10:15 ET) plus 8:30 ET open snap; the observer logging path still never mutates locked picks. No TSP. No FIT.`,
  'v12.3.5 omega-vnext: scored historical replay joins real CLV/ROI from clv-{date} / picks-{date} settles (null + scoreReason when closes absent); capture-health ops snapshot at omega-ops/* + optional OMEGA_OPS_WEBHOOK_URL. No gate, weight, Kelly, engine, shrink, or live pick-math changes.',
  'v12.3.4 omega-vnext: historical replay pregame gate uses the snapshot asOf (historicalSnapshot) instead of Date.now(), so past slates are not rejected as in-progress-or-started. Live path unchanged when asOf is unset. 5-minute grace kept. No weight, Kelly, or engine changes.',
  'v12.3.3 omega-vnext: narrate-only ESPN copy. Straights 4-6 sentences, parlay legs 3-5, Daily Edge and insights 3-5. Locked-row context (edge band, steam hint, price compass) reaches the narrator and is translated into plain English, not raw EV/CLV/Kelly. Fallback blurbs use the same desk voice. No gate, weight, Kelly, engine, or TSP changes.',
  'v12.3.2 omega-vnext: verify adverse steam drops set blockStraightRefill so TARGET_PICKS backfill cannot undo the steam gate (empty/short card OK). Verify replace/backfill grades use toPickObject / qualityToRating (edge), not units.',
  'v12.3.1 omega-vnext: 9:15 ET line snap + capture health gate; feed warm 9:00; shadow dry-run 9:05 (isolated omega-shadow/*); TSP live hold lifted (observer /live-ai only — zero Omega hard dep).',
  'v12.3.0 omega-vnext: game-day rest/B2B + soft QB status (ESPN injuries) + MLB weather total adj on top of EPA/SP/park seeds. Soft fallback if feeds fail; empty card OK; no lean force-fill. Market blend + calibrate shrink unchanged. No NBA/NHL.',
  'v12.2.2 omega-vnext: Kalshi/Polymarket OBSERVER sidecar. Read-only implied probs logged to omega-pm-observer/{date} (alias pm-sidecar-{date}) when a PM moneyline maps cleanly 1:1 to a game ML. v12.2.2 did not apply PM to selection. v12.3.6 adds a hard-capped soft score only. No order placement. Soft-fail if PM APIs are down. Observer logging still does not mutate locked pick rating, units, or edge.',
  'v12.2.1 omega-vnext: placeability soft-veto. Published price must be offered within juice ballpark (≤3pp implied worse OR ≤15 American cents worse) at ≥2 US retail books from US_BOOK_PRIORITY (PLACEABILITY.minMajorBooks; not sharp-only, not Pinnacle). Reject reason placeability-soft-veto, distinct from insufficient-liquidity. Verify drops a pick only when Hard Rock and majors coverage both fail; odds-API down warns and does not clear the card. Empty card OK, no lean refill.',
  'v12.2.0 omega-vnext: NFL/CFB EPA-style off/def priors (seed JSON; Sierra-like standings blend only when pf/pa and games are clean; both teams required) with lower uncertainty. MLB SP quality from StatsAPI FIP/xFIP/ERA once per generate (discounted team prior only when a probable is named) plus static park factors move margin and total. Soft fallback: failed EPA/SP/park load keeps standings/Pythag behavior and never blanks the slate. Market blend and calibrate shrink unchanged. No NBA/NHL.',
  'v12.1.3 omega-vnext: <2% calibrated edge → B (no B+); legend stays A+/A/A-. v12.1.2 omega-vnext: Edge legend mobile (no Today\'s Record); A- floor 2.0%; exact 5%/3.5%/2% → higher grade; parlay legs sorted by quality grade. v12.1.1 omega-vnext: grades = quality (calibrated edge + expected CLV), not units/hit-rate; sort quality then units; A+ stake ≥ A on same card unless hard cap. v12.1.0 omega-vnext: US open→pick line-move pipeline (capture-omega-lines 6:00/7:30/9:00 ET); steamToward/Against gates + verify recheck; openPrint on lockSnapshot for CLV; stronger shrink; NFL/CFB HFA +0.1.',
  'v12.0.9 omega-vnext: SAME ET calendar day only (straights + parlay legs); parlay fixed 0.5u; straights ≤3.5u; card max 4.0u; remapped grades (fewer A+).',
  'v12.0.8 omega-vnext: DAILY_UNIT_CAP max 4.0u (not a fill target); parlay leg rating badges; Daily Lock titles + summary UX.',
  'v12.0.7 omega-vnext: fix isotonic soft-cap (was inflating ~hi); stronger shrink so Edge badge stays honest vs sharp fair.',
  'v12.0.6 omega-vnext: daily unit cap 5.0u incl. parlay; ML pick labels; Edge badge = model edge after shrink vs no-vig sharp; stronger shrink; Daily Lock Parlay UX.',
  'v12.0.5 omega-vnext: ensure whatLoses/dataVerified/clvExpectation after narrator pass + verify.',
  'v12.0.4 omega-vnext: journalistic narrate (match verify) + whatLoses/dataVerified/clvExpectation + verify parlay-leg writeups.',
  'v12.0.3 omega-vnext: narrate retries without web_search on tool failure.',
  'v12.0.2 omega-vnext: journalistic narratives + full parlay-leg pick cards.',
  'v12.0.1 omega-vnext: CLV-first composer + realized close-grade loop + QA hard-fails.',
  'v1 projections: sport power/market-hybrid (MLB Pythag/Elo-lite; NFL/CFB normal-spread; NBA/NHL disabled).',
  'Calibration: shrink p_model toward no-vig sharp with market K; isotonic clip soft-caps extremes (no 15% fake edges).',
  'Edge badge (edgePct): calibrated model edge after shrink = coverProb - no-vig sharp fair (fallback: vs book implied). Not predictedClv cents, not raw coverProb, not dog-inflated EV%.',
  'Predicted CLV is a proxy; residual CLV uses open→now steam; realized no-vig CLV graded by track-clv-omega (Pinnacle/Bookmaker).',
  'Weekly CLV report is OBSERVER ONLY — no auto-steer. openPrint+lockSnapshot populate open→close path.',
  'QA hard-fails drop scratched SP (MLB), stale odds, and adverse open→pick steam before publish. NFL/NCAAF QB out/doubtful is a soft projection adjustment only (game_day.js), never a hard-fail (2026-09-28).',
  'Empty card allowed when no candidate clears gates; no lean force-fill; no self-opt mutation.',
  'Day-scope: every straight + parlay leg commenceTime must fall on the card ET date (America/New_York).',
  'Unit structure: straights ≤3.5u + fixed 0.5u parlay = max 4.0u; may be under; never force-fill.',
  'Live card (get-picks-omega): newest store date with real picks ≤ tomorrowET; sticky prior-day when empty/missing; ?date= sticky unless forceEmpty.',
  'US books prioritized: DK/FD/BetMGM/Caesars/ESPN BET/Hard Rock/BetRivers/Fanatics; sharp refs Pinnacle/Bookmaker for CLV context.',
].join(' ');

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const BLOB_STORE = 'edge-picks-omega';

module.exports = {
  MODEL_VERSION,
  UNIT_DOLLARS,
  KELLY_FRACTION,
  BANKROLL_UNITS,
  EV_CAP_ALL,
  EDGE_FLOOR_K,
  CORR_HAIRCUT_PER_LEG,
  MAX_STRAIGHTS,
  ONE_STRAIGHT_PER_GAME,
  ALLOW_SAME_GAME_TOPUP,
  PER_GAME_EXPOSURE_CAP_ENABLED,
  STRAIGHT_UNIT_BUDGET,
  PARLAY_FIXED_UNITS,
  PARLAY_TOTAL_HAIRCUT,
  DAILY_UNIT_CAP,
  MAX_STRAIGHT_UNITS_PER_PICK,
  B_GRADE_UNIT_CAP,
  GRADE_STAKE_UNITS,
  marketAnchorOn,
  DAY_SCOPE_TZ,
  DAY_SCOPE_STRICT,
  SPORTS_ENABLED,
  NBA_CARD_LIVE,
  nbaModuleEnabled,
  NBA_SHADOW,
  ODDS_SPORT_KEYS,
  ESPN_LEAGUES,
  SHARP_BOOKS,
  US_BOOK_PRIORITY,
  US_BOOKS,
  PLACEABILITY,
  MAJOR_LIQUIDITY_BOOKS,
  LINE_MOVE,
  STEAM_WINDOW_MIN,
  PINNACLE_LINE_MOVE,
  GENERATOR_BOOKMAKERS,
  DK_LAG,
  LINE_MOVE_PROB,
  PM_SOFT,
  ENGINE_SOFT,
  SHRINK_K,
  MLB_CALIBRATION,
  GATES,
  LEAN_MIN_EV,
  LEAN_MIN_EDGE,
  LEAN_MAX_UNITS,
  LEAN_PARLAY_UNITS,
  PARLAY_MIN_COVER,
  QA_HARDFAIL,
  QB_INJURY,
  QB_MARGIN_SCALE,
  QUALITY_GRADE,
  SELECT_WEIGHTS,
  SPORT_SPREAD_STD,
  SPORT_TOTAL_STD,
  RATING_ERROR_SD,
  RATING_ERROR_N0,
  ratingGamesN,
  ratingErrorSd,
  effectiveSd,
  MARKET_ANCHOR_MODEL_WEIGHT,
  HFA,
  NFL_MODEL_WEIGHT,
  NFL_TOTAL_MODEL_WEIGHT,
  NCAAF_MODEL_WEIGHT,
  NFL_ELO_WEIGHT,
  nflEloWeight,
  NFL_MARGIN_BIAS_CORRECTION_PTS,
  NFL_MARGIN_BIAS_WINDOW,
  nflMarginBiasCorrectionPts,
  priorW,
  readPriorEnv,
  NFL_PRIOR_K,
  NCAAF_PRIOR_K,
  NHL_PRIOR_K,
  NCAAF_PACE_FOLLOWS_PRIOR,
  sportPriorK,
  ncaafPriorK,
  nhlPriorK,
  ncaafPaceFollowsPrior,
  NHL_EMPTY_NET,
  REST_ADJ,
  restAdjEnabled,
  WEATHER_NFL,
  FB_WEATHER,
  fbWeatherEnabled,
  NFL_KEY_NUMBERS,
  POINT_SHRINK,
  NCAAF_FCS,
  NCAAF_RET_PROD,
  ncaafRetProdMultiplier,
  MODEL_LINE_GAP,
  FB_MARKET_GAP,
  flagEnabled,
  envNumber,
  ncaafGpFixEnabled,
  ncaafShrinkK,
  teamExactOnly,
  centerDefaultEnabled,
  fbGapGuardEnabled,
  fbMarketGapLimits,
  CLV_KPI_FLOOR,
  MODEL_NOTES,
  SITE_ID,
  BLOB_STORE,
};
Object.defineProperty(module.exports, 'LEAN_PAD', { enumerable: true, get() { return marketAnchorOn() ? false : LEAN_PAD; } });
