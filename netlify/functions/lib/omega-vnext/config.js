'use strict';

/** Omega vNext — CLV-first multi-sport composer (replaces v11 megascript). */
const MODEL_VERSION = 'v12.3.11-omega-vnext-run-env';

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

/** Shrinkage toward no-vig sharp (higher K = more trust in market). v12.1: slightly stronger.
 *  NFL / NCAAF / any non-MLB sport. MLB uses MLB_CALIBRATION.shrinkK. */
const SHRINK_K = { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 };

/**
 * MLB-only second shrink (v12.3.9). Global SHRINK_K and the global isotonic
 * band (0.42–0.58, keep 0.25) stay put for every sport, including MLB.
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
 * Historical mix. v12.3.11 straight rank is qualityScore (calibrated edge vs
 * no-vig), not w_ev / w_clv / w_uncertainty. softSportMixBonus is still added.
 * The numbers stay so a silent retune of the old mix is still visible in tests.
 */
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
  PM_SOFT,
  ENGINE_SOFT,
  SHRINK_K,
  MLB_CALIBRATION,
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
