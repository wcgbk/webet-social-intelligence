'use strict';

/**
 * Pinnacle-led line movement as a blend-weight shift.
 *
 * The 10:00 no-vig already contains the move, so this does not add Δp on
 * top of fair_sharp_p. It raises the shrink weight K when the 3:00 → 10:00
 * move is informative, which pulls cover probability toward the sharp
 * before edge, stake EV, and the letter grade are recomputed from that
 * one probability.
 *
 * Inputs are the 3:00 and 10:00 captures for the slate date, plus a stored
 * opener when one exists. Retired 06:00/07:30/09:00/09:15 snaps are ignored.
 * A missing 3:00 or 10:00 logs and contributes 0. It is not filled from a
 * stale morning snap or from the opener.
 *
 * extraSharpBooks is an optional second sharp book, off by default. A stored
 * Circa quote is ignored unless that list names it. Hard Rock only dampens
 * the weight when it opposes Pinnacle. DraftKings lag adds a small extra
 * weight when Pinnacle moved toward the side and DraftKings did not follow.
 *
 * OMEGA_LINE_MOVE_PROB=0 leaves cover, edge, and EV untouched.
 */

const { LINE_MOVE_PROB } = require('./config');
const { shrinkKForMarket } = require('./calibrate');
const { attachEv } = require('./edge');
const { sideRole, probsFromRow } = require('./dk_lag');
const { spreadCoverProb, totalCoverProb } = require('./sports/_common');
const { gameKey } = require('./line_path');

function movementEnabled(env) {
  const source = env || process.env;
  const raw = source.OMEGA_LINE_MOVE_PROB;
  if (raw == null || String(raw).trim() === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return value;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function slotLabel(poll) {
  if (!poll) return '';
  const raw = poll.hhmm != null && poll.hhmm !== '' ? poll.hhmm : poll.slot;
  if (raw == null || raw === '') return '';
  const text = String(raw);
  if (text === 'open') return 'open';
  return text.padStart(4, '0');
}

function marketFamily(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return 'Total';
  if (/spread|puck|run\s*line/i.test(m)) return 'Spread';
  return 'Moneyline';
}

function weightFor(cfg, sport, market) {
  const table = (cfg.weights && (cfg.weights[sport] || cfg.weights.default)) || {};
  const family = marketFamily(market);
  const n = Number(table[family]);
  if (Number.isFinite(n)) return n;
  const fallback = cfg.weights && cfg.weights.default;
  const alt = fallback ? Number(fallback[family]) : NaN;
  return Number.isFinite(alt) ? alt : 0.2;
}

function dkLagWeightFor(cfg, sport) {
  const table = cfg.dkLagWeight || {};
  const n = Number(table[sport]);
  if (Number.isFinite(n)) return n;
  const alt = Number(table.default);
  return Number.isFinite(alt) ? alt : 0;
}

function findGame(poll, candidate) {
  if (!poll || !poll.games) return null;
  const games = poll.games;
  const key = gameKey(candidate && candidate.awayTeam, candidate && candidate.homeTeam);
  if (games[key]) return games[key];
  const away = normName(candidate && candidate.awayTeam);
  const home = normName(candidate && candidate.homeTeam);
  if (!away || !home) return null;
  for (const game of Object.values(games)) {
    if (!game) continue;
    if (normName(game.awayTeam) === away && normName(game.homeTeam) === home) return game;
  }
  return null;
}

function bookRow(game, names) {
  const books = game && game.books;
  if (!books) return null;
  const want = (names || []).map((name) => String(name).toLowerCase());
  for (const name of want) {
    if (books[name]) return books[name];
  }
  for (const [key, row] of Object.entries(books)) {
    if (want.includes(String(key).toLowerCase())) return row;
  }
  return null;
}

function betLineFor(candidate, row10, role) {
  const posted = finite(candidate && candidate.line);
  if (posted != null) return posted;
  if (!row10 || !role || role.market === 'ML') return null;
  if (role.market === 'total') return finite(row10.total);
  if (role.role === 'home') return finite(row10.spreadHome);
  const away = finite(row10.spreadAway);
  if (away != null) return away;
  const home = finite(row10.spreadHome);
  return home == null ? null : -home;
}

/**
 * Side probability at one book print.
 * Moneyline is the two-way no-vig. Spread and total are the key-aware
 * cover of the fixed 10:00 bet line under that print's point, plus the
 * juice skew (no-vig − 0.5). A point move is visible even when both
 * prices are −110.
 */
function sideProbability(row, candidate, betLine) {
  const role = sideRole(candidate);
  if (!role || !row) return null;
  const pack = probsFromRow(row, role.market, role.role);
  if (!pack || !Number.isFinite(pack.noVig)) return null;
  if (role.market === 'ML') {
    return { p: pack.noVig, nv: pack.noVig, point: null };
  }
  const sport = candidate && candidate.sport;
  const line = finite(betLine);
  if (line == null) return null;
  if (role.market === 'total') {
    const point = finite(row.total);
    if (point == null) return null;
    const cover = totalCoverProb(point, line, role.role, sport);
    if (!Number.isFinite(cover)) return null;
    return { p: cover + (pack.noVig - 0.5), nv: pack.noVig, point, cover };
  }
  const homePoint = finite(row.spreadHome);
  if (homePoint == null) return null;
  const mu = -homePoint;
  const cover = role.role === 'home'
    ? spreadCoverProb(mu, line, sport)
    : (1 - spreadCoverProb(mu, -line, sport));
  if (!Number.isFinite(cover)) return null;
  return { p: cover + (pack.noVig - 0.5), nv: pack.noVig, point: homePoint, cover };
}

function bookDelta(game3, game10, gameOpen, candidate, names) {
  const row3 = bookRow(game3, names);
  const row10 = bookRow(game10, names);
  if (!row3 || !row10) return null;
  const role = sideRole(candidate);
  const line = betLineFor(candidate, row10, role);
  const at3 = sideProbability(row3, candidate, line);
  const at10 = sideProbability(row10, candidate, line);
  if (!at3 || !at10 || !Number.isFinite(at3.p) || !Number.isFinite(at10.p)) return null;
  let dOpen = null;
  const rowOpen = bookRow(gameOpen, names);
  if (rowOpen) {
    const atOpen = sideProbability(rowOpen, candidate, line);
    if (atOpen && Number.isFinite(atOpen.p)) dOpen = at3.p - atOpen.p;
  }
  return { d310: at10.p - at3.p, dOpen, p3: at3.p, p10: at10.p };
}

function magnitudeOf(pack, openWeight) {
  if (!pack || !Number.isFinite(pack.d310)) return null;
  let mag = Math.abs(pack.d310);
  if (pack.dOpen != null && Number.isFinite(pack.dOpen)
    && pack.d310 !== 0
    && Math.sign(pack.dOpen) === Math.sign(pack.d310)) {
    mag += openWeight * Math.abs(pack.dOpen);
  }
  return mag;
}

function pollsBySlot(meta) {
  const by = {};
  const polls = meta && meta.path && Array.isArray(meta.path.polls) ? meta.path.polls : [];
  for (const poll of polls) {
    const slot = slotLabel(poll);
    if (slot === '0300' || slot === '1000' || slot === 'open') by[slot] = poll;
  }
  if (meta && meta.earliest) {
    const slot = slotLabel(meta.earliest);
    if ((slot === '0300' || slot === 'open') && !by[slot]) by[slot] = meta.earliest;
  }
  if (meta && meta.latest) {
    const slot = slotLabel(meta.latest);
    if (slot === '1000' && !by[slot]) by[slot] = meta.latest;
  }
  return by;
}

function labelOf(candidate) {
  return {
    matchup: (candidate && (candidate.matchup || `${candidate.awayTeam} @ ${candidate.homeTeam}`)) || '',
    market: (candidate && candidate.market) || '',
    side: (candidate && (candidate.side || candidate.pick)) || '',
    sport: (candidate && candidate.sport) || '',
  };
}

/**
 * One candidate. Missing 0300 or 1000 → adjustment 0 and a loud warning.
 * fair_sharp_p is not rewritten. p_model === p_sharp → adjustment 0
 * (the 10:00 fair already has the move) while an adverse drop still fires.
 */
function adjustCandidate(candidate, meta, cfg) {
  const config = cfg || LINE_MOVE_PROB;
  const slots = pollsBySlot(meta);
  const game3 = findGame(slots['0300'], candidate);
  const game10 = findGame(slots['1000'], candidate);
  const gameOpen = findGame(slots.open, candidate);
  const id = labelOf(candidate);
  const missing = [];
  if (!slots['0300'] || !game3) missing.push('0300');
  if (!slots['1000'] || !game10) missing.push('1000');
  const snapLog = {
    event: 'line-move-snapshots',
    ...id,
    source: (meta && meta.source) || null,
    slots: {
      open: !!(slots.open && gameOpen),
      '0300': !!(slots['0300'] && game3),
      '1000': !!(slots['1000'] && game10),
    },
  };
  if (missing.length) {
    console.warn(JSON.stringify({
      event: 'line-move-snapshot-missing',
      ...id,
      missing,
      source: snapLog.source,
      ignoredRetiredSlots: ['0600', '0730', '0900', '0915'],
      note: 'line-move adjustment 0; stale morning snapshots are not used',
    }));
    console.log(JSON.stringify({ ...snapLog, deltaP: null, adj: 0, drop: false, missing }));
    return attachEv({
      ...candidate,
      movementAdjusted: true,
      movementAdj: 0,
      movementDeltaP: null,
      movementMissing: missing,
      movementDrop: false,
      movementDropReason: null,
      movementSnapshots: snapLog.slots,
    });
  }

  const pin = bookDelta(game3, game10, gameOpen, candidate, ['pinnacle']);
  const extraNames = extraSharpNames(config);
  const extraSharp = extraNames.length
    ? bookDelta(game3, game10, gameOpen, candidate, extraNames)
    : null;
  const hardRock = bookDelta(game3, game10, gameOpen, candidate, ['hardrockbet', 'hardrock']);
  const dk = bookDelta(game3, game10, gameOpen, candidate, ['draftkings']);
  const sharpWeight = extraSharpWeightOf(config);

  let signed = null;
  let magnitude = null;
  let extraUsed = false;
  if (pin && extraSharp) {
    const w = clamp(sharpWeight, 0, 1);
    signed = (1 - w) * pin.d310 + w * extraSharp.d310;
    const magPin = magnitudeOf(pin, config.openWeight);
    const magExtra = magnitudeOf(extraSharp, config.openWeight);
    magnitude = (1 - w) * magPin + w * magExtra;
    extraUsed = true;
  } else if (pin) {
    signed = pin.d310;
    magnitude = magnitudeOf(pin, config.openWeight);
  }

  const noise = Number(config.noise);
  const scale = Number(config.scale);
  const span = scale - noise;
  let info = 0;
  if (magnitude != null && Number.isFinite(span) && span > 0) {
    info = clamp((magnitude - noise) / span, 0, 1);
  }

  let damp = 1;
  if (hardRock && pin && Number.isFinite(hardRock.d310) && Number.isFinite(pin.d310)
    && Math.sign(hardRock.d310) !== 0
    && Math.sign(pin.d310) !== 0
    && Math.sign(hardRock.d310) !== Math.sign(pin.d310)
    && Math.abs(hardRock.d310) > noise) {
    damp = Number(config.hardRockOppositionDamp);
    if (!Number.isFinite(damp) || damp < 0) damp = 0.5;
  }

  let extra = weightFor(config, candidate && candidate.sport, candidate && candidate.market) * info * damp;
  let dkLag = false;
  if (pin && pin.d310 > noise && dk && Number.isFinite(dk.d310)) {
    const follow = pin.d310 === 0 ? 1 : dk.d310 / pin.d310;
    if (!(follow >= 0.5)) dkLag = true;
  }
  if (dkLag) extra += dkLagWeightFor(config, candidate && candidate.sport);

  const handK = shrinkKForMarket(candidate && candidate.market, candidate && candidate.sport);
  const baseK = finite(candidate && candidate.calibK);
  const K = baseK == null ? handK : baseK;
  const maxK = Number(config.maxK);
  const raised = K + (1 - K) * Math.max(0, extra);
  // Never lower K. A fitted K already above the cap stays put.
  const Keff = !Number.isFinite(K)
    ? K
    : (K >= maxK ? K : Math.min(maxK, raised));

  const pModel = finite(candidate && candidate.p_model);
  const pSharp = finite(candidate && candidate.fair_sharp_p);
  const pSharpAlt = pSharp == null ? finite(candidate && candidate.sharpFairP) : pSharp;
  const pBase = finite(candidate && candidate.coverProb);
  const cap = Number(config.maxAbsProbAdj);
  let adj = 0;
  if (pModel != null && pSharpAlt != null && pBase != null && Number.isFinite(K) && Number.isFinite(Keff)
    && Math.abs(pModel - pSharpAlt) > 1e-12) {
    const raw = (Keff - K) * (pSharpAlt - pModel);
    adj = clamp(raw, -cap, cap);
  }
  const lo = (config.probClamp && config.probClamp[0]) || 0.02;
  const hi = (config.probClamp && config.probClamp[1]) || 0.98;
  const pAdj = pBase == null ? null : clamp(pBase + adj, lo, hi);

  const dropCut = Number(config.adverseDropProb);
  const leader = pin;
  const drop = !!(leader && Number.isFinite(leader.d310) && leader.d310 <= -dropCut);
  const dropReason = drop
    ? `sharp_prob_against: ${leader.d310.toFixed(4)} (threshold ${dropCut})`
    : null;

  console.log(JSON.stringify({
    ...snapLog,
    deltaP: signed == null ? null : +signed.toFixed(6),
    magnitude: magnitude == null ? null : +magnitude.toFixed(6),
    info: +info.toFixed(4),
    adj: +adj.toFixed(6),
    K: Number.isFinite(K) ? +K.toFixed(4) : null,
    Keff: Number.isFinite(Keff) ? +Keff.toFixed(4) : null,
    extraSharp: extraUsed,
    dkLag,
    drop,
  }));

  const next = {
    ...candidate,
    movementAdjusted: true,
    movementAdj: +adj.toFixed(6),
    movementDeltaP: signed == null ? null : +signed.toFixed(6),
    movementInfo: +info.toFixed(6),
    movementK: Number.isFinite(K) ? +K.toFixed(6) : null,
    movementKEff: Number.isFinite(Keff) ? +Keff.toFixed(6) : null,
    movementCirca: false,
    movementExtraSharp: extraUsed,
    movementDkLag: dkLag,
    movementDrop: drop,
    movementDropReason: dropReason,
    movementMissing: null,
    movementSnapshots: { ...snapLog.slots, extraSharp: extraUsed },
    fair_sharp_p: candidate.fair_sharp_p,
    p_model: candidate.p_model,
  };
  if (pAdj != null) next.coverProb = pAdj;
  return attachEv(next);
}

function extraSharpNames(config) {
  const named = config && Array.isArray(config.extraSharpBooks) ? config.extraSharpBooks : [];
  return named.map((name) => String(name || '').toLowerCase()).filter(Boolean);
}

function extraSharpWeightOf(config) {
  const raw = config && (config.extraSharpWeight != null ? config.extraSharpWeight : config.circaWeight);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.5;
}

function applyLineMoveProb(candidates, meta, opts) {
  const options = opts || {};
  const env = options.env || process.env;
  if (options.enabled === false || !movementEnabled(env)) return candidates || [];
  const cfg = options.config || LINE_MOVE_PROB;
  return (candidates || []).map((candidate) => adjustCandidate(candidate, meta, cfg));
}

module.exports = {
  movementEnabled,
  marketFamily,
  weightFor,
  sideProbability,
  bookDelta,
  magnitudeOf,
  pollsBySlot,
  adjustCandidate,
  applyLineMoveProb,
};
