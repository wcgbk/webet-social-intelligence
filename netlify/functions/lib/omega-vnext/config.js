'use strict';

/** Omega vNext — CLV-first multi-sport composer (replaces v11 megascript). */
const MODEL_VERSION = 'v12.3.17-omega-vnext-cal-a';

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
/**
 * Same-direction total parlays (every leg Over, or every leg Under) share
 * a scoring day. Multiply combinedProb by this factor before EV and
 * ranking. Each value is at most 1, so no ticket's hit probability rises.
 * A mixed ticket, or any ticket that is not all totals, stays at 1.
 */
const PARLAY_TOTAL_HAIRCUT = {
  2: 0.95,
  3: 0.92,
};
const DAILY_UNIT_CAP = 4.0;
/** Per-straight Kelly display cap (before card-level 3.5u budget trim). */
const MAX_STRAIGHT_UNITS_PER_PICK = 1.25;
/**
 * Post-Kelly stake cap for quality grade B only.
 * Grade B is qualityToRating 'b': calibrated edge under QUALITY_GRADE.aminus (2%).
 * Applied after Kelly units and the letter grade both exist. Lowers a stake
 * above this value and never raises one. A- / A / A+ are not capped.
 * The parlay ticket is not on this path (PARLAY_FIXED_UNITS, or thin-slate 0.25u).
 */
const B_GRADE_UNIT_CAP = 0.5;
const LEAN_PAD = false; // empty card OK — never force-fill

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
  /** Verify (10:30): harder adverse thresholds — drop, do not refill. Empty OK. */
  verifyAdverseCents: 20,
  verifyAdversePts: { Spread: 1.5, Total: 1.5 },
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
 * the initial sort only. It does not re-rank the three already chosen.
 */
const SELECT_WEIGHTS = {
  softSportMixBonus: 0.02,
};

const SPORT_SPREAD_STD = { NFL: 13.5, NCAAF: 16.0, NBA: 12.0, NHL: 2.5, MLB: 4.2 };
/**
 * Total residual SD. NBA is 18: spread SD (12) is the home-margin residual.
 * Total = H+A and pace shocks move both scores the same way, so SD(total)
 * is wider than SD(margin). A pace-aware model still leaves about 16–19
 * (legacy omega used 18.5). 18 pulls total probabilities toward 0.5.
 * It does not change a gate. NBA stays off the daily card.
 */
const SPORT_TOTAL_STD = { NFL: 10.5, NCAAF: 13.5, NBA: 18.0, NHL: 1.8, MLB: 3.5 };
/** HFA base; game_day.js applies soft rest/B2B deltas on top. */
const HFA = { MLB: 0.12, NFL: 2.1, NCAAF: 2.6, NBA: 2.5, NHL: 0.15 };

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

const MODEL_NOTES = [
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
  'v12.3.3 omega-vnext: narrate-only ESPN copy. Straights 4-6 sentences, parlay legs 3-5, Daily Edge and insights 3-5. Locked-row context (edge band, steam hint, price compass) reaches Claude and is translated into plain English, not raw EV/CLV/Kelly. Fallback blurbs use the same desk voice. No gate, weight, Kelly, engine, or TSP changes.',
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
  'QA hard-fails drop scratched SP (MLB), stale odds, and adverse open→pick steam before publish. NFL/NCAAF QB out/doubtful is a soft projection adjustment only (game_day.js), never a hard-fail (2026-09-28).',
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
  PARLAY_TOTAL_HAIRCUT,
  DAILY_UNIT_CAP,
  MAX_STRAIGHT_UNITS_PER_PICK,
  B_GRADE_UNIT_CAP,
  LEAN_PAD,
  DAY_SCOPE_TZ,
  DAY_SCOPE_STRICT,
  SPORTS_ENABLED,
  NBA_CARD_LIVE,
  NBA_SHADOW,
  ODDS_SPORT_KEYS,
  ESPN_LEAGUES,
  SHARP_BOOKS,
  US_BOOK_PRIORITY,
  US_BOOKS,
  PLACEABILITY,
  MAJOR_LIQUIDITY_BOOKS,
  LINE_MOVE,
  PM_SOFT,
  ENGINE_SOFT,
  SHRINK_K,
  MLB_CALIBRATION,
  GATES,
  QA_HARDFAIL,
  QB_INJURY,
  QUALITY_GRADE,
  SELECT_WEIGHTS,
  SPORT_SPREAD_STD,
  SPORT_TOTAL_STD,
  HFA,
  REST_ADJ,
  restAdjEnabled,
  WEATHER_NFL,
  FB_WEATHER,
  fbWeatherEnabled,
  NFL_KEY_NUMBERS,
  POINT_SHRINK,
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
