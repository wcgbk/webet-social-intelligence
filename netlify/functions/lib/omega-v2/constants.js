'use strict';

/** Live Omega card. OMEGA_PIPELINE_V2=0 (or opts.pipelineV2 false) falls back to v1. */
const MODEL_VERSION = 'omega-v2-sharp-2026-11-01-dkhr';
const UNIT_DOLLARS = 150;
/**
 * Stated bankroll is 100u. 1u = $150, so the roll behind the Kelly display
 * is $15,000. A 1% Kelly fraction prints as 1.0u (units = fraction * 100).
 * See DATA-THRESHOLDS-V2.md.
 */
const BANKROLL_UNITS = 100;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
/**
 * Per-bet ceiling, 2u = $300 = 2% of the $15,000 roll.
 * Quarter-Kelly on a -290 price at 3.5% EV is 2.54u before this cap, which
 * is why that price printed 2u. The cap is a risk limit. The uncertainty
 * floor below is what keeps a noisy edge from reaching it.
 */
const PER_BET_CAP = 2;
const STRAIGHT_BUDGET = 3.5;
/** Straight budget 3.5u plus the 1u parlay cap. */
const CARD_BUDGET = 4.5;
const PARLAY_CAP = 0.5;
/** Parlay stake ceiling. Stated card limit for this path, not a fitted ROI cutoff. */
const PARLAY_STAKE_CAP = 1;
/**
 * Retired. The v1-seeded ticket used a 0.5u profit floor and a 0.25u lean.
 * The live path no longer reads these. A stake that rounds under 0.25u is
 * not a parlay.
 */
const PARLAY_PROFIT_FLOOR = 0.5;
const PARLAY_LEAN_STAKE = 0.25;
/** Retired. Joint EV must be positive. There is no 3% parlay floor. */
const PARLAY_MIN_EV = 0;
/**
 * Retired scaled floor. The live gate is the sign of the no-vig edge, then
 * the bucket uncertainty floor. A 1pp scaled floor was not estimated from
 * the graded sample. Kept at 0 so a stale caller cannot revive the 1pp screen.
 */
const EDGE_FLOOR = 0;
/**
 * Calibrated edge above this is treated as miscalibration and is not a bet.
 * Graded Omega straights that stored an edge (audit ds.json, n=99) top out
 * at 8.7pp. 10pp sits one step past that sample, matching the existing
 * miscalibration screen.
 */
const MAX_EDGE = 0.10;
/**
 * One uncertainty floor for every straight and every parlay leg.
 * edge = (pCal - penalty) - pNovig must exceed EDGE_FLOOR_K * SE(bucket).
 * Buckets are on the no-vig probability. SE and the long-shot penalty are
 * fit on the 4,160 graded walk-forward rows (341 games). A thin bucket is
 * shrunk toward the global residual variance (0.234655) and toward bias 0,
 * with prior strength 80. Penalty is max(0, -bias) only when pNovig < 0.35.
 * See DATA-THRESHOLDS-V2.md. k = 1.5. The <0.2 floor is 7.805pp, so a
 * +575 with pCal 0.167 and pNovig 0.140 (2.7pp) does not qualify.
 */
const EDGE_FLOOR_K = 1.5;
const NO_VIG_BUCKETS = [
  { lo: 0, hi: 0.2, n: 56, games: 55, se: 0.052035, bias: -0.032896, penalty: 0.032896 },
  { lo: 0.2, hi: 0.35, n: 145, games: 127, se: 0.037668, bias: -0.032354, penalty: 0.032354 },
  { lo: 0.35, hi: 0.65, n: 3541, games: 341, se: 0.008385, bias: 0.000670, penalty: 0 },
  { lo: 0.65, hi: 0.8, n: 221, games: 160, se: 0.031055, bias: 0.006278, penalty: 0 },
  { lo: 0.8, hi: 1, n: 197, games: 122, se: 0.026143, bias: -0.001903, penalty: 0 },
];
/** Prior shrink toward the no-vig price. Matches the known ~54% forecast vs ~50% hits. */
const PRIOR_SHRINK_K = 0.70;
/**
 * Sport priors used until a walk-forward fit has its own holdout.
 * Higher k trusts the no-vig price more. MLB stays looser so a real
 * starter miss is not shrunk under the edge floor.
 * NHL moneylines do not use 0.68 while NHL_ML_WALKFORWARD_BEATS_NOVIG
 * is false. That cell is NHL_ML_SHRINK_K (full no-vig).
 */
const SPORT_PRIOR_K = {
  MLB: 0.46,
  NFL: 0.70,
  NCAAF: 0.72,
  NBA: 0.75,
  NHL: 0.68,
  // No NCAAM walk-forward. Trust the no-vig price more than the NBA prior.
  NCAAM: 0.85,
};
const SHRINK_GRID = [0.40, 0.55, 0.70, 0.85, 0.95];
const MIN_POOLED = 8;
/**
 * Default graded-bet floor before a sport may use a fitted map.
 * Pooled n does not satisfy this. A sport under its own floor gets
 * shrink only. See SPORT_MIN_GAMES.
 */
const MIN_SPORT = 24;
/**
 * Per-sport minimum of graded bets (any market) before Platt or isotonic
 * may touch that sport. The number is the sport's own rows, not the
 * pooled card history. A pooled fit cannot override a sport under its floor,
 * and a sport fit is not stored or applied below it.
 * 24 matches the holdout floor already required for a sport model.
 */
const SPORT_MIN_GAMES = {
  MLB: MIN_SPORT,
  NFL: MIN_SPORT,
  NCAAF: MIN_SPORT,
  NBA: MIN_SPORT,
  NHL: MIN_SPORT,
  NCAAM: MIN_SPORT,
};
/** Daily model sports. MLB stays enabled for the summer and is not in this list. */
const MODEL_SPORTS = ['NBA', 'NHL', 'NCAAM', 'NFL', 'NCAAF'];
/**
 * Prior strength for the shrink weight. Weight on the sport prior is
 *   w = clamp(SHRINK_N0 / (SHRINK_N0 + n_sport), 0, 1)
 *   k = clamp(w * k_prior + (1 - w) * k_fit, 0, 1)
 *   logit(p) = (1 - k) * logit(pModel - intercept) + k * logit(pFair)
 * The intercept centers that blend on the no-vig price. It is not shrunk.
 * n = 0 or n under the sport floor has no fit, so k = k_prior (w = 1).
 * 80 is the same prior strength used on the uncertainty buckets above.
 * At n = 80 the prior and the fitted shrink split the weight evenly.
 */
const SHRINK_N0 = 80;
/**
 * Market-skill weight prior. The live card trusts the model's deviation
 * from the no-vig price only to the extent that deviation has beaten the
 * market on earlier, unselected morning-board rows:
 *   wHat = argmin log loss of sigmoid(logit(pMkt) + w*(logit(pCal) - logit(pMkt)))
 *   w = (n * wHat + N0 * 1) / (n + N0)
 * Shrink is toward 1, which is today's behaviour (use pCal as-is).
 * N0 = 150 rows is about one week of a single sport's morning board,
 * both sides. n = 0 keeps w = 1, so a sport with no graded board does
 * not move. OMEGA_V2_MARKET_SKILL=off forces w = 1 and skips the grade.
 */
const MARKET_SKILL_N0 = 150;
const MARKET_SKILL_ENV = 'OMEGA_V2_MARKET_SKILL';
/**
 * Spread/total opposite-side pairing. Default on.
 * OMEGA_V2_PAIR_FIX=off restores the pre-2026-11-11 oppositeBundle,
 * which could pair a spread with the same team at the same point when
 * alternate lines were present. off / 0 / false disable the fix.
 */
const PAIR_FIX_ENV = 'OMEGA_V2_PAIR_FIX';
/**
 * A board row is mispaired when its own American price implies a
 * probability inside (PAIR_SANITY_LO, PAIR_SANITY_HI) and that implied
 * probability is more than PAIR_SANITY_PP away from pMkt. On the saved
 * morning boards 2026-10-31 through 2026-11-10, correctly paired rows in
 * that band stayed within 6.0pp (p99 4.5pp). Every mispaired alt spread
 * was at least 9.3pp off. A row with no odds is not checked.
 * OMEGA_V2_PAIR_FIX=off skips the check.
 */
const PAIR_SANITY_PP = 0.08;
const PAIR_SANITY_LO = 0.10;
const PAIR_SANITY_HI = 0.90;

function pairFixEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[PAIR_FIX_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}
/**
 * Daily card is the top 3 ranked straights, and the parlay is those straights.
 * Default on. OMEGA_V2_FORCE_TOP3=off / 0 / false restores the positive-edge
 * gates, the uncertainty floor, and the separate parlay search.
 */
const FORCE_TOP3_ENV = 'OMEGA_V2_FORCE_TOP3';

function forceTop3Enabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[FORCE_TOP3_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Honest fill on a force-top3 card. A forced straight whose price EV is
 * negative at its DK/HR decimal is capped at 0.25u and marked filler.
 * Default on. OMEGA_V2_FILLER=off / 0 / false leaves the stake alone and
 * does not mark the pick.
 */
const FILLER_ENV = 'OMEGA_V2_FILLER';

function fillerEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[FILLER_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Haircut the bet probability by the fitted longshot penalty.
 * Multiplicative no-vig overstates longshots, so without this the EV rank
 * fills the card with +1500..+5000 college dogs.
 * Default on. OMEGA_V2_LONGSHOT_ADJ=off / 0 / false uses p = pCal.
 */
const LONGSHOT_ADJ_ENV = 'OMEGA_V2_LONGSHOT_ADJ';

function longshotAdjEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[LONGSHOT_ADJ_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Bet probability is the sharp no-vig price at the same line (wisdom of
 * the crowd), then the longshot penalty when that adjustment is on.
 * Default on. OMEGA_V2_MARKET_P=off / 0 / false uses the calibrated
 * probability as the base, which is the previous force-top3 rule.
 */
const MARKET_P_ENV = 'OMEGA_V2_MARKET_P';

function marketPEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[MARKET_P_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Morning board carries the sharp book's two American prices, the de-vig
 * that produced pMkt, and the power no-vig. Numbers and short labels only.
 * Default on. OMEGA_V2_BOARD_SHARP_PRICES=off / 0 / false keeps the
 * previous slim row.
 */
const BOARD_SHARP_PRICES_ENV = 'OMEGA_V2_BOARD_SHARP_PRICES';

function boardSharpPricesEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[BOARD_SHARP_PRICES_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Bet probability uses the power no-vig (pMktPower) and skips the longshot
 * trim, because power de-vig already handles favourite-longshot bias.
 * Default off. It cannot be replay-tested until boards carry two-sided
 * prices. Stays off until a replay on boards with two-sided prices beats
 * the multiplicative+trim path.
 * OMEGA_V2_POWER_DEVIG=on / 1 / true turns it on. Unset, off, 0, and false stay off.
 */
const POWER_DEVIG_ENV = 'OMEGA_V2_POWER_DEVIG';

function powerDevigEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[POWER_DEVIG_ENV];
  if (raw == null || String(raw).trim() === '') return false;
  const text = String(raw).trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * After the close is already captured, store one CLV row for each published
 * straight and each parlay leg on clv-{date}.pickClv. Default on.
 * OMEGA_V2_PICK_CLV=off / 0 / false skips that write. The row's clvPp is
 * the close power no-vig minus the bet price's implied probability, in
 * percentage points. Positive beat the close.
 */
const PICK_CLV_ENV = 'OMEGA_V2_PICK_CLV';

function pickClvEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[PICK_CLV_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * Write the bet-price true-close row for every published straight and parlay
 * leg onto clv-{date}.pickClv, from closes capture-pick-closes already stored.
 * Default on. OMEGA_V2_PICK_CLV_FILL=off / 0 / false leaves the blob unchanged.
 * Dates before 2026-11-14 are never filled.
 */
const PICK_CLV_FILL_ENV = 'OMEGA_V2_PICK_CLV_FILL';

function pickClvFillEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[PICK_CLV_FILL_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * American prices shorter than this are out of band for a forced straight.
 * -300 itself stays in band. -301, -600, and -1300 do not.
 * Default on. OMEGA_V2_FAV_CAP=off / 0 / false ranks every price together.
 */
const FAV_CAP_ENV = 'OMEGA_V2_FAV_CAP';
const FAV_CAP_AMERICAN = -300;

function favCapEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[FAV_CAP_ENV];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * opts.forceTop3 wins when the caller set it. Otherwise the env flag.
 * autoCorrect and validate do not use this: they follow card.selectionRule
 * so an unmarked fixture keeps the old gates while the flag is on.
 */
function forceTop3From(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'forceTop3')) return !!opts.forceTop3;
  return forceTop3Enabled(opts && opts.env);
}

/**
 * A stored card is on this rule only when the flag is on AND the card was
 * stamped. Flag off restores the old drops. An unmarked history card does too.
 */
function isForceTop3Card(card, env) {
  if (!forceTop3Enabled(env)) return false;
  if (!card || typeof card !== 'object') return false;
  if (card.selectionRule === 'force-top3') return true;
  const pipe = card.pipelineV2;
  return !!(pipe && typeof pipe === 'object' && pipe.selectionRule === 'force-top3');
}
/**
 * NHL moneyline shrink toward the Pinnacle no-vig fair.
 * Stored walk-forward (tools/omega-calibration/out/walkforward-cal4.md,
 * window 2026-09-22 through 2026-10-08): NHL|Moneyline K = 1.00, kMle = 1.00,
 * 128 rows / 64 games, Platt a = 0, b = 1.59. On the 64 graded ML dogs the
 * no-vig Brier was 0.232 and the model Brier was 0.237. That sample did not
 * beat the no-vig line, so k stays 1 and no Platt or isotonic is applied
 * on an NHL moneyline.
 * Set NHL_ML_WALKFORWARD_BEATS_NOVIG only after a new NHL-only walk-forward
 * beats the no-vig price out of sample. Until then this lock wins over
 * SPORT_PRIOR_K.NHL, the sample-size blend, and every pooled or sport map.
 */
const NHL_ML_SHRINK_K = 1;
const NHL_ML_WALKFORWARD_BEATS_NOVIG = false;
const ISOTONIC_MIN = 40;
/** Penalty on Brier when the fitted shrink leaves the prior. Walk-forward only. */
const SHRINK_PRIOR_PENALTY = 0.05;
const PLATT_LAMBDA = 4;
/**
 * Retired flat haircuts. Same-game pairs use the measured phi in parlay.js.
 * These are not applied on the live path.
 */
const SAME_SPORT_HAIRCUT = 1;
const TOTAL_HAIRCUT = { 2: 1, 3: 1 };
/**
 * Same-game outcome correlation from graded kpi.picks pairs (all models,
 * read 2026-10-30, n is decided win/loss pairs on one matchup).
 * phi SE is about 1/sqrt(n). apply is 0 when |phi| is inside 1.96 SE,
 * so the joint probability stays the product. ML+spread is not in this
 * table: that pair is disallowed (n=4, phi=1.0, SE=0.50, the interval
 * excludes 0). See DATA-THRESHOLDS-V2.md.
 */
const PAIR_PHI = {
  'Moneyline+Total': { phi: -0.02595, n: 14, se: 0.267, apply: 0 },
  'Spread+Total': { phi: 0.18712, n: 26, se: 0.196, apply: 0 },
};
/** Decimal at -110. No longer scales an edge floor. */
const PRICE_BASE_DECIMAL = 1 + 100 / 110;
const UNC_BASELINE = 0.18;
const FLAG_ENV = 'OMEGA_PIPELINE_V2';

/**
 * 3 AM -> 10 AM Pinnacle move. Veto a side the sharp book has moved
 * against, and rank a stale DK/HR price ahead of an equal-sign neighbor.
 * Default is on: the 10/31-11/13 replay at 1.5pp matched +1019 with the
 * top-3 shape intact. 1.0pp was +955. =off restores the old rank.
 * OMEGA_V2_LINE_MOVE_VETO_PP (1.5) and OMEGA_V2_LINE_MOVE_STALE_PP (1.0)
 * are percentage points.
 */
const LINE_MOVE_ENV = 'OMEGA_V2_LINE_MOVE';
const LINE_MOVE_DEFAULT_ON = true;

function lineMoveEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[LINE_MOVE_ENV];
  if (raw == null || String(raw).trim() === '') return LINE_MOVE_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (LINE_MOVE_DEFAULT_ON) return text !== 'off' && text !== '0' && text !== 'false';
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

function lineMoveVetoPp(env) {
  const source = env == null ? process.env : env;
  const n = Number(source.OMEGA_V2_LINE_MOVE_VETO_PP);
  if (Number.isFinite(n) && n > 0) return n / 100;
  return 0.015;
}

function lineMoveStalePp(env) {
  const source = env == null ? process.env : env;
  const n = Number(source.OMEGA_V2_LINE_MOVE_STALE_PP);
  if (Number.isFinite(n) && n > 0) return n / 100;
  return 0.01;
}

/**
 * Pull an NHL bet probability back toward the 3 AM price.
 * pBet = pBet - 0.35 * (p10 - p3). Other sports use lambda 0.
 * Replay alone was +984, under +1019, so the default stays off.
 * =off leaves pBet on the market price.
 */
const MOVE_SHRINK_ENV = 'OMEGA_V2_MOVE_SHRINK';
const MOVE_SHRINK_DEFAULT_ON = false;

function moveShrinkEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[MOVE_SHRINK_ENV];
  if (raw == null || String(raw).trim() === '') return MOVE_SHRINK_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (MOVE_SHRINK_DEFAULT_ON) return text !== 'off' && text !== '0' && text !== 'false';
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * Bet probability is Pinnacle's two-way at the number, else Circa, else
 * Pinnacle converted at most 1.5 points. Never the bet book's own implied.
 * Default is on: the 10/31-11/13 replay was +1687 with days3 15/15.
 * =off keeps the stored fair. No 3 AM/10 AM poll leaves the stored fair.
 * A 10 AM poll with no Pinnacle/Circa pair also keeps that stored fair.
 * The row stays placeable and ranks after every row that has a sharp fair.
 */
const PINNACLE_FAIR_ENV = 'OMEGA_V2_PINNACLE_FAIR';
const PINNACLE_FAIR_DEFAULT_ON = true;

function pinnacleFairEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[PINNACLE_FAIR_ENV];
  if (raw == null || String(raw).trim() === '') return PINNACLE_FAIR_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (PINNACLE_FAIR_DEFAULT_ON) return text !== 'off' && text !== '0' && text !== 'false';
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * Accept a DK/HR number within 1.5 points of Pinnacle and price the push.
 * Half-point same-line rows stay on today's EV.
 * HOLD: alone replay was +700 after alias grading (grade85 raw +683, two
 * Odds API names unmatched) and the stack with line-move plus Pinnacle
 * fair was +1367, under the +1687 Pinnacle-fair card. Default stays off.
 * =off rejects dk-hr-line-mismatch as before.
 */
const KEY_CONVERT_ENV = 'OMEGA_V2_KEY_CONVERT';
const KEY_CONVERT_DEFAULT_ON = false;

function keyConvertEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[KEY_CONVERT_ENV];
  if (raw == null || String(raw).trim() === '') return KEY_CONVERT_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (KEY_CONVERT_DEFAULT_ON) return text !== 'off' && text !== '0' && text !== 'false';
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * +EV rows cross the -300 cap ahead of an in-band 0% or negative-EV filler.
 * A -EV price shorter than -300 still waits until in-band rows run out.
 * +EV is pBet * decimal - 1 at the bet price. row.ev is not the tier key.
 * HOLD 2026-11-15: replay +$2023 (34-8, parlays 7-7) vs +$1687 but fav300=2
 * (ND -6500, NE -305) breaks the no-shorter-than--300 rule. Opt-in with
 * OMEGA_V2_EV_FIRST=on.
 * =off restores in-band-first fill.
 */
const EV_FIRST_ENV = 'OMEGA_V2_EV_FIRST';
const EV_FIRST_DEFAULT_ON = false;

function evFirstEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[EV_FIRST_ENV];
  if (raw == null || String(raw).trim() === '') return EV_FIRST_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (EV_FIRST_DEFAULT_ON) return text !== 'off' && text !== '0' && text !== 'false';
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

/**
 * Cap-respecting +EV-first fill. With the -300 cap on, every in-band row
 * ranks ahead of every out-of-band row. Inside the in-band set the order
 * is +EV sharp, +EV stored-fair, EV<=0 sharp, EV<=0 stored-fair. +EV is
 * pBet * decimal - 1, the same tier as OMEGA_V2_EV_FIRST. Out-of-band rows
 * keep the existing favCapFill order and take a slot only when fewer than
 * 3 in-band candidates remain. This flag wins over OMEGA_V2_EV_FIRST.
 * Cap off is a no-op.
 * Shipped default on. The 10/31-11/14 replay with line-move and Pinnacle
 * fair was +$1687, days3 15/15, fav300 0, the same card as that stack.
 * =off restores in-band sharp, then out-of-band sharp, then stored-fair.
 * Unset uses the default. on/1/true/yes turn it on. off/0/false and a
 * blank value turn it off.
 */
const EV_FIRST_CAPPED_ENV = 'OMEGA_V2_EV_FIRST_CAPPED';
const EV_FIRST_CAPPED_DEFAULT_ON = true;

function evFirstCappedEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[EV_FIRST_CAPPED_ENV];
  if (raw == null) return EV_FIRST_CAPPED_DEFAULT_ON;
  const text = String(raw).trim().toLowerCase();
  if (text === 'on' || text === '1' || text === 'true' || text === 'yes') return true;
  if (text === '' || text === 'off' || text === '0' || text === 'false') return false;
  return false;
}

/**
 * Drop an NBA game before the top-3 cut when an important player is still
 * Questionable, Doubtful, Day-To-Day, or a game-time decision.
 * Default off. Unset stays off. on/1/true/yes turn it on.
 * off/0/false/blank turn it off (=off is the rollback).
 * The fetch is once, in the v2 generate path, and a soft-fail does not veto.
 */
const NBA_INJURY_ENV = 'OMEGA_V2_NBA_INJURY';

function nbaInjuryEnabled(env) {
  const source = env == null ? process.env : env;
  const raw = source[NBA_INJURY_ENV];
  if (raw == null) return false;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'off' || text === '0' || text === 'false') return false;
  if (text === 'on' || text === '1' || text === 'true' || text === 'yes') return true;
  return false;
}

/**
 * NHL starter confirmation at build time. Default off.
 * Unset, blank, off, 0, and false stay off.
 * shadow records a would-veto and does not drop the candidate.
 * veto, and on/1/true/yes, drop a game when either goalie is unconfirmed.
 * Pinnacle limit is not on the public feed, so there is no full-limit mode.
 */
const NHL_GOALIE_ENV = 'OMEGA_V2_NHL_GOALIE';

function nhlGoalieMode(env) {
  const source = env == null ? process.env : env;
  const raw = source[NHL_GOALIE_ENV];
  if (raw == null) return 'off';
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'off' || text === '0' || text === 'false') return 'off';
  if (text === 'shadow') return 'shadow';
  if (text === 'veto' || text === 'on' || text === '1' || text === 'true' || text === 'yes') return 'veto';
  return 'off';
}

module.exports = {
  MODEL_VERSION,
  UNIT_DOLLARS,
  BANKROLL_UNITS,
  KELLY_FRACTION,
  MAX_STRAIGHTS,
  PER_BET_CAP,
  STRAIGHT_BUDGET,
  CARD_BUDGET,
  PARLAY_CAP,
  PARLAY_STAKE_CAP,
  PARLAY_PROFIT_FLOOR,
  PARLAY_LEAN_STAKE,
  PARLAY_MIN_EV,
  EDGE_FLOOR,
  MAX_EDGE,
  EDGE_FLOOR_K,
  NO_VIG_BUCKETS,
  PAIR_PHI,
  PRIOR_SHRINK_K,
  SPORT_PRIOR_K,
  MODEL_SPORTS,
  SHRINK_GRID,
  MIN_POOLED,
  MIN_SPORT,
  SPORT_MIN_GAMES,
  SHRINK_N0,
  MARKET_SKILL_N0,
  MARKET_SKILL_ENV,
  PAIR_FIX_ENV,
  PAIR_SANITY_PP,
  PAIR_SANITY_LO,
  PAIR_SANITY_HI,
  pairFixEnabled,
  FORCE_TOP3_ENV,
  forceTop3Enabled,
  FILLER_ENV,
  fillerEnabled,
  forceTop3From,
  isForceTop3Card,
  LONGSHOT_ADJ_ENV,
  longshotAdjEnabled,
  MARKET_P_ENV,
  marketPEnabled,
  BOARD_SHARP_PRICES_ENV,
  boardSharpPricesEnabled,
  POWER_DEVIG_ENV,
  powerDevigEnabled,
  PICK_CLV_ENV,
  pickClvEnabled,
  PICK_CLV_FILL_ENV,
  pickClvFillEnabled,
  FAV_CAP_ENV,
  FAV_CAP_AMERICAN,
  favCapEnabled,
  NHL_ML_SHRINK_K,
  NHL_ML_WALKFORWARD_BEATS_NOVIG,
  ISOTONIC_MIN,
  SHRINK_PRIOR_PENALTY,
  PLATT_LAMBDA,
  SAME_SPORT_HAIRCUT,
  TOTAL_HAIRCUT,
  PRICE_BASE_DECIMAL,
  UNC_BASELINE,
  FLAG_ENV,
  LINE_MOVE_ENV,
  LINE_MOVE_DEFAULT_ON,
  lineMoveEnabled,
  lineMoveVetoPp,
  lineMoveStalePp,
  MOVE_SHRINK_ENV,
  MOVE_SHRINK_DEFAULT_ON,
  moveShrinkEnabled,
  PINNACLE_FAIR_ENV,
  PINNACLE_FAIR_DEFAULT_ON,
  pinnacleFairEnabled,
  KEY_CONVERT_ENV,
  KEY_CONVERT_DEFAULT_ON,
  keyConvertEnabled,
  EV_FIRST_ENV,
  EV_FIRST_DEFAULT_ON,
  evFirstEnabled,
  EV_FIRST_CAPPED_ENV,
  EV_FIRST_CAPPED_DEFAULT_ON,
  evFirstCappedEnabled,
  NBA_INJURY_ENV,
  nbaInjuryEnabled,
  NHL_GOALIE_ENV,
  nhlGoalieMode,
};
