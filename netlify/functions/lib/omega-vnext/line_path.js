'use strict';

/**
 * Omega open→pick line-path helpers (pure + blob I/O).
 * Morning US-hours polls → steamToward / steamAgainst / residual CLV features.
 */

const {
  SITE_ID, BLOB_STORE, US_BOOKS, SHARP_BOOKS, LINE_MOVE, US_BOOK_PRIORITY,
} = require('./config');
const { americanToImplied } = require('./odds_math');
const { americanCentsWorse } = require('./edge');
const { replayNoWrite, logBlocked } = require('./no_write');
const { resolveFetch, auditBlobCall } = require('./audit_log');

function gameKey(away, home) {
  return `${String(away || '').trim()} @ ${String(home || '').trim()}`.toLowerCase();
}

function bookKey(b) {
  return String(b || '').toLowerCase();
}

function median(nums) {
  const a = (nums || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}

function hhmmET(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return `${h.padStart(2, '0')}${m.padStart(2, '0')}`;
}

function etDateISO(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function snapBlobKey(dateISO, hhmm) {
  return `omega-line-snap-${dateISO}-${hhmm}`;
}

function pathBlobKey(dateISO) {
  return `omega-line-path/${dateISO}`;
}

async function blobFetch(path, { method = 'GET', body } = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${BLOB_STORE}/${path}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  return resolveFetch(fetch, { kind: 'blob', provider: 'netlify-blobs' })(url, opts);
}

async function readJsonBlob(path) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    return await auditBlobCall('GET', path, () => store.get(path, { type: 'json' }));
  } catch (_) {
    try {
      const resp = await blobFetch(path);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    }
  }
}

async function writeJsonBlob(path, data) {
  if (replayNoWrite()) {
    logBlocked(`writeJsonBlob ${path}`);
    return false;
  }
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    await auditBlobCall('PUT', path, () => store.setJSON(path, data));
    return true;
  } catch (sdkErr) {
    const resp = await blobFetch(path, { method: 'PUT', body: data });
    if (!resp.ok) throw new Error(`blob PUT ${path} → ${resp.status}`);
    return true;
  }
}

/**
 * Extract per-book line snapshot from an Odds API event.
 */
function extractGameBooks(event, { usBooks = US_BOOKS, sharpBooks = SHARP_BOOKS } = {}) {
  const books = {};
  const usSpread = [];
  const usTotal = [];
  const usMlHome = [];
  const usMlAway = [];
  const sharpSpread = [];
  const sharpTotal = [];
  const sharpMlHome = [];
  const sharpMlAway = [];

  const home = event.home_team;
  const away = event.away_team;

  for (const bk of (event.bookmakers || [])) {
    const key = bookKey(bk.key);
    const row = {
      spreadHome: null, spreadHomeOdds: null, spreadAway: null, spreadAwayOdds: null,
      total: null, overOdds: null, underOdds: null,
      mlHome: null, mlAway: null,
    };
    for (const mkt of (bk.markets || [])) {
      if (mkt.key === 'spreads') {
        for (const o of mkt.outcomes || []) {
          if (o.name === home && o.point != null) {
            row.spreadHome = Number(o.point);
            row.spreadHomeOdds = Number(o.price);
          }
          if (o.name === away && o.point != null) {
            row.spreadAway = Number(o.point);
            row.spreadAwayOdds = Number(o.price);
          }
        }
      }
      if (mkt.key === 'totals') {
        for (const o of mkt.outcomes || []) {
          if (/^over$/i.test(o.name) && o.point != null) {
            row.total = Number(o.point);
            row.overOdds = Number(o.price);
          }
          if (/^under$/i.test(o.name) && o.point != null) {
            row.underOdds = Number(o.price);
            if (row.total == null && o.point != null) row.total = Number(o.point);
          }
        }
      }
      if (mkt.key === 'h2h') {
        for (const o of mkt.outcomes || []) {
          if (o.name === home) row.mlHome = Number(o.price);
          if (o.name === away) row.mlAway = Number(o.price);
        }
      }
    }
    books[key] = row;
    const isUs = usBooks.map(bookKey).includes(key);
    const isSharp = sharpBooks.map(bookKey).includes(key);
    if (isUs || isSharp) {
      if (row.spreadHome != null) (isUs ? usSpread : sharpSpread).push(row.spreadHome);
      if (row.total != null) (isUs ? usTotal : sharpTotal).push(row.total);
      if (row.mlHome != null) (isUs ? usMlHome : sharpMlHome).push(row.mlHome);
      if (row.mlAway != null) (isUs ? usMlAway : sharpMlAway).push(row.mlAway);
    }
    // sharp also contributes to sharp arrays when dual-listed
    if (isUs && isSharp) {
      /* already counted in us — also add sharp if not already */
    } else if (isSharp) {
      /* already in sharp */
    }
  }

  // Prefer explicit sharp books even if also in US list
  for (const bk of (event.bookmakers || [])) {
    const key = bookKey(bk.key);
    if (!sharpBooks.map(bookKey).includes(key)) continue;
    const row = books[key];
    if (!row) continue;
    if (row.spreadHome != null) sharpSpread.push(row.spreadHome);
    if (row.total != null) sharpTotal.push(row.total);
    if (row.mlHome != null) sharpMlHome.push(row.mlHome);
    if (row.mlAway != null) sharpMlAway.push(row.mlAway);
  }

  return {
    homeTeam: home,
    awayTeam: away,
    commenceTime: event.commence_time || null,
    books,
    usConsensus: {
      spreadHome: median(usSpread),
      total: median(usTotal),
      mlHome: median(usMlHome),
      mlAway: median(usMlAway),
    },
    sharpConsensus: {
      spreadHome: median(sharpSpread),
      total: median(sharpTotal),
      mlHome: median(sharpMlHome),
      mlAway: median(sharpMlAway),
    },
  };
}

/**
 * First book in `ordered` that posts this side.
 * Spread/total/ML matching is the same for a US print and a sharp print.
 */
function sidePrint(gameSnap, candidate, ordered) {
  if (!gameSnap || !gameSnap.books) return null;
  const market = String(candidate.market || candidate.betType || '');
  const side = String(candidate.side || candidate.pick || '');
  const home = gameSnap.homeTeam;
  const away = gameSnap.awayTeam;

  for (const bk of ordered) {
    const row = gameSnap.books[bk];
    if (!row) continue;
    if (/total/i.test(market)) {
      const isOver = /over/i.test(side);
      const odds = isOver ? row.overOdds : row.underOdds;
      if (row.total != null && odds != null) {
        return { book: bk, line: row.total, odds, market: 'Total', side: isOver ? 'Over' : 'Under' };
      }
    } else if (/spread|run line/i.test(market)) {
      const isHome = side.toLowerCase().includes(String(home || '').toLowerCase().split(' ').pop() || '___')
        || (candidate.homeTeam && side.toLowerCase().includes(String(candidate.homeTeam).toLowerCase().split(' ').pop()));
      // Prefer matching home/away by team token
      let useHome = null;
      if (home && side.toLowerCase().includes(normToken(home))) useHome = true;
      else if (away && side.toLowerCase().includes(normToken(away))) useHome = false;
      if (useHome === true && row.spreadHome != null) {
        return { book: bk, line: row.spreadHome, odds: row.spreadHomeOdds, market: 'Spread', side: 'home' };
      }
      if (useHome === false && row.spreadAway != null) {
        return { book: bk, line: row.spreadAway, odds: row.spreadAwayOdds, market: 'Spread', side: 'away' };
      }
      // fallback: home spread
      if (row.spreadHome != null) {
        return { book: bk, line: row.spreadHome, odds: row.spreadHomeOdds, market: 'Spread', side: 'home' };
      }
    } else {
      // Moneyline
      let useHome = null;
      if (home && side.toLowerCase().includes(normToken(home))) useHome = true;
      else if (away && side.toLowerCase().includes(normToken(away))) useHome = false;
      if (useHome === true && row.mlHome != null) {
        return { book: bk, line: null, odds: row.mlHome, market: 'Moneyline', side: 'home' };
      }
      if (useHome === false && row.mlAway != null) {
        return { book: bk, line: null, odds: row.mlAway, market: 'Moneyline', side: 'away' };
      }
    }
  }
  return null;
}

/**
 * Best US book print for a candidate side (priority order).
 * openPrint for CLV stays on this print. Toward/against does not.
 */
function bestUsPrint(gameSnap, candidate) {
  if (!gameSnap || !gameSnap.books) return null;
  const priority = (US_BOOK_PRIORITY || US_BOOKS).map(bookKey);
  const ordered = [
    ...priority.filter(k => gameSnap.books[k]),
    ...Object.keys(gameSnap.books).filter(k => !priority.includes(k) && US_BOOKS.map(bookKey).includes(k)),
  ];
  return sidePrint(gameSnap, candidate, ordered);
}

/**
 * Pinnacle, else Circa. A US-only move does not set steam toward/against.
 */
function sharpPrint(gameSnap, candidate) {
  if (!gameSnap || !gameSnap.books) return null;
  const ordered = ['pinnacle', 'circa', 'circasports'].filter((key) => gameSnap.books[key]);
  return sidePrint(gameSnap, candidate, ordered);
}

function normToken(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Signed steam toward pick:
 *  +positive ⇒ market moved toward our side (good for residual CLV if we already got better price)
 *  For odds: higher American is better for the bettor. The move is American
 *  cents on the juice ladder (the +100/-100 gap is not 200 cents). Positive
 *  means the price got longer.
 *  For spread when picking a side: more points for dog / fewer for favorite = toward
 *  We use pick's line perspective: lineMoveToward = openLine - nowLine for favorites (negative line),
 *  but simpler unified rule below.
 *
 * Returns { oddsMoveCents, lineMovePts, steamToward, steamAgainst, towardScore, residualClvProxy }
 */
function computeOpenToNowMove(candidate, openGame, nowGame) {
  const cfg = LINE_MOVE || {};
  if (!openGame) {
    return {
      oddsMoveCents: null,
      lineMovePts: null,
      steamToward: false,
      steamAgainst: false,
      towardScore: 0,
      residualClvProxy: null,
      openPrint: null,
      nowPrint: null,
      missingOpen: true,
    };
  }

  const openPrint = bestUsPrint(openGame, candidate);
  const nowPrint = nowGame ? bestUsPrint(nowGame, candidate) : null;
  // US print is the CLV open only. Toward/against and the 18c/1pt gate
  // read Pinnacle (else Circa). A DraftKings-only move does not count.
  const sharpOpen = sharpPrint(openGame, candidate);
  const sharpNow = nowGame ? sharpPrint(nowGame, candidate) : null;

  let usOddsMoveCents = null;
  if (openPrint && openPrint.odds != null && nowPrint && nowPrint.odds != null) {
    const usWorse = americanCentsWorse(openPrint.odds, nowPrint.odds);
    usOddsMoveCents = usWorse == null ? null : +(-usWorse).toFixed(2);
  }

  let oddsMoveCents = null;
  if (sharpOpen && sharpOpen.odds != null && sharpNow && sharpNow.odds != null) {
    const worseForBettor = americanCentsWorse(sharpOpen.odds, sharpNow.odds);
    oddsMoveCents = worseForBettor == null ? null : +(-worseForBettor).toFixed(2);
  }

  let lineMovePts = null;
  if (sharpOpen && sharpOpen.line != null && sharpNow && sharpNow.line != null) {
    lineMovePts = +(sharpNow.line - sharpOpen.line).toFixed(3);
  }

  // Direction: for the bettor, longer odds = toward; for points, more favorable line = toward
  let towardScore = 0;
  const market = String(candidate.market || candidate.betType || '');
  const side = String(candidate.side || candidate.pick || '');

  if (/total/i.test(market)) {
    const isOver = /over/i.test(side);
    // Over wants higher total; Under wants lower
    if (lineMovePts != null) {
      towardScore += isOver ? lineMovePts : -lineMovePts;
    }
    if (oddsMoveCents != null) towardScore += oddsMoveCents / 100; // soft
  } else if (/spread|run line/i.test(market)) {
    // Higher line number is better for the side (e.g. +3.5 → +4.5, or -3 → -2.5)
    if (lineMovePts != null) towardScore += lineMovePts;
    if (oddsMoveCents != null) towardScore += oddsMoveCents / 100;
  } else {
    // ML: longer American odds = toward
    if (oddsMoveCents != null) towardScore += oddsMoveCents / 25; // scale cents
  }

  const steamToward = towardScore > (cfg.steamTowardEpsilon || 0.15);
  const steamAgainst = towardScore < -(cfg.steamTowardEpsilon || 0.15);

  // Residual CLV proxy: if we still have +EV and steam toward, expect more close value;
  // if steam against, residual shrinks.
  let residualClvProxy = null;
  const pred = typeof candidate.predictedClv === 'number' ? candidate.predictedClv : 0;
  if (steamToward) residualClvProxy = +(pred + Math.min(8, Math.abs(towardScore) * 4)).toFixed(2);
  else if (steamAgainst) residualClvProxy = +(pred - Math.min(12, Math.abs(towardScore) * 5)).toFixed(2);
  else residualClvProxy = +pred.toFixed(2);

  // Sharp move since the stored open. Size and direction are a
  // selection input at the 10:30 lock. They are not added to fair_sharp_p.
  let sharpLineMove = null;
  if (openGame.sharpConsensus && nowGame && nowGame.sharpConsensus) {
    if (/total/i.test(market)
      && openGame.sharpConsensus.total != null
      && nowGame.sharpConsensus.total != null) {
      sharpLineMove = +(nowGame.sharpConsensus.total - openGame.sharpConsensus.total).toFixed(3);
    } else if (/spread|run line/i.test(market)
      && openGame.sharpConsensus.spreadHome != null
      && nowGame.sharpConsensus.spreadHome != null) {
      sharpLineMove = +(nowGame.sharpConsensus.spreadHome - openGame.sharpConsensus.spreadHome).toFixed(3);
    }
  }
  const sharpSteam = sharpSteamSinceOpen(openGame, nowGame, market);

  return {
    oddsMoveCents,
    lineMovePts,
    usOddsMoveCents,
    steamToward,
    steamAgainst,
    towardScore: +towardScore.toFixed(4),
    residualClvProxy,
    _market: market,
    missingSharp: !sharpOpen || !sharpNow,
    openPrint: openPrint ? {
      book: openPrint.book,
      line: openPrint.line,
      odds: openPrint.odds,
      capturedAt: openGame.capturedAt || null,
    } : null,
    nowPrint: nowPrint ? {
      book: nowPrint.book,
      line: nowPrint.line,
      odds: nowPrint.odds,
    } : null,
    sharpOpen: sharpOpen ? { book: sharpOpen.book, line: sharpOpen.line, odds: sharpOpen.odds } : null,
    sharpNow: sharpNow ? { book: sharpNow.book, line: sharpNow.line, odds: sharpNow.odds } : null,
    sharpLineMove,
    sharpMovePts: sharpSteam.sharpMovePts,
    sharpMoveSize: sharpSteam.sharpMoveSize,
    sharpMoveDir: sharpSteam.sharpMoveDir,
    dkMovePts: sharpSteam.dkMovePts,
    dkLagsSharp: sharpSteam.dkLagsSharp,
    missingOpen: false,
  };
}

function consensusLine(game, market) {
  if (!game || !game.sharpConsensus) return null;
  if (/total/i.test(market)) return numberOrNull(game.sharpConsensus.total);
  if (/spread|run line/i.test(market)) return numberOrNull(game.sharpConsensus.spreadHome);
  return null;
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dkBookRow(game) {
  const books = game && game.books;
  if (!books) return null;
  return books.draftkings || books.draftkings_us || null;
}

function dkLine(game, market) {
  const row = dkBookRow(game);
  if (!row) return null;
  if (/total/i.test(market)) return numberOrNull(row.total);
  if (/spread|run line/i.test(market)) return numberOrNull(row.spreadHome);
  return null;
}

/**
 * Sharp line from the stored open to the 10:30 snapshot.
 * dkLagsSharp is true when the sharp moved at least half a point and
 * DraftKings has not moved as far in that same direction.
 * Selection input only. Do not add this onto the fair price.
 *
 * The written spec sentence says steam is not monitored and is not an
 * input. The user STEAM note overrides that sentence: open-to-10:30
 * sharp-move size, direction, and the DraftKings-lag flag are a
 * selection input only (inside the score cap, before lock). They are
 * never added to the fair price.
 */
function sharpSteamSinceOpen(openGame, nowGame, market) {
  const openSharp = consensusLine(openGame, market);
  const nowSharp = consensusLine(nowGame, market);
  const sharpMovePts = (openSharp != null && nowSharp != null)
    ? +(nowSharp - openSharp).toFixed(3)
    : null;
  const openDk = dkLine(openGame, market);
  const nowDk = dkLine(nowGame, market);
  const dkMovePts = (openDk != null && nowDk != null)
    ? +(nowDk - openDk).toFixed(3)
    : null;
  let dkLagsSharp = false;
  if (sharpMovePts != null && Math.abs(sharpMovePts) + 1e-9 >= 0.5) {
    const dk = dkMovePts == null ? 0 : dkMovePts;
    const sameOrFlat = dk === 0 || Math.sign(dk) === Math.sign(sharpMovePts);
    const behind = Math.abs(sharpMovePts) - Math.abs(dk);
    dkLagsSharp = sameOrFlat && behind + 1e-9 >= 0.5;
  }
  let sharpMoveDir = 'flat';
  if (sharpMovePts != null && Math.abs(sharpMovePts) >= 0.05) {
    sharpMoveDir = sharpMovePts > 0 ? 'up' : 'down';
  }
  return {
    sharpMovePts,
    sharpMoveSize: sharpMovePts == null ? null : +Math.abs(sharpMovePts).toFixed(3),
    sharpMoveDir,
    dkMovePts,
    dkLagsSharp,
  };
}

/**
 * Gate / QA: is adverse steam past reject threshold?
 */
function adverseSteamReason(move, { verify = false, market = null } = {}) {
  const cfg = LINE_MOVE || {};
  // No 10:30 pull. verifyAdverseCents / verifyAdversePts stay in config
  // and are not applied. Generate still uses 18 cents and 1.0 point.
  if (verify) return null;
  if (!move || move.missingOpen) return null;
  if (!move.steamAgainst) return null;

  const centsThresh = cfg.rejectSteamAgainstCents != null ? cfg.rejectSteamAgainstCents : 18;
  const ptsMap = cfg.rejectSteamAgainstPts || { Spread: 1.0, Total: 1.0 };

  // Odds shortened against pick (negative move = worse American for bettor)
  if (move.oddsMoveCents != null && move.oddsMoveCents <= -centsThresh) {
    return `steam_against_odds: ${move.oddsMoveCents}c (threshold -${centsThresh})`;
  }

  if (move.lineMovePts != null && move.towardScore < 0) {
    const adversePts = Math.abs(move.lineMovePts);
    const m = String(market || move._market || '');
    let t;
    if (/total/i.test(m)) t = ptsMap.Total != null ? ptsMap.Total : 1.0;
    else if (/spread|run line/i.test(m)) t = ptsMap.Spread != null ? ptsMap.Spread : 1.0;
    else t = ptsMap.Spread != null ? ptsMap.Spread : 1.0;
    if (adversePts >= t) {
      return `steam_against_line: ${move.lineMovePts} pts (threshold ${t})`;
    }
  }
  return null;
}

/**
 * Annotate candidates with open→now line-move features.
 * openPath: { polls: [...] } or a single snap { games }
 * nowSnap optional — else uses candidate odds as now.
 *
 * Toward and against come from the Pinnacle print (else Circa), not the
 * best US price. The probability adjustment in line_move_prob is what
 * changes cover, edge, and EV. These flags are not a score bump and they
 * are never added to the fair price. There is no 10:30 recheck.
 */
function annotateLineMoves(candidates, openSnap, nowSnap) {
  const openGames = (openSnap && openSnap.games) || {};
  const nowGames = (nowSnap && nowSnap.games) || openGames;

  return (candidates || []).map(c => {
    const key = gameKey(c.awayTeam, c.homeTeam);
    const openG = openGames[key] || null;
    const nowG = nowGames[key] || null;
    // Attach capturedAt onto game objects for openPrint
    const openWithTs = openG
      ? { ...openG, capturedAt: (openSnap && (openSnap.capturedAt || openSnap.fetchedAt)) || null }
      : null;
    const move = computeOpenToNowMove(c, openWithTs, nowG);
    const steamBoost = move.steamToward ? (LINE_MOVE.scoreBoostSteamToward || 0.03) : 0;
    const steamPenalty = move.steamAgainst ? (LINE_MOVE.scorePenaltySteamAgainst || 0.04) : 0;
    return {
      ...c,
      lineMove: move,
      steamToward: move.steamToward,
      steamAgainst: move.steamAgainst,
      predictedResidualClv: move.residualClvProxy,
      openPrint: move.openPrint,
      _steamScoreAdj: steamBoost - steamPenalty,
      // Recorded for selection before 10:30. Not added to fair_sharp_p.
      sharpMovePts: move.sharpMovePts != null ? move.sharpMovePts : null,
      sharpMoveSize: move.sharpMoveSize != null ? move.sharpMoveSize : null,
      sharpMoveDir: move.sharpMoveDir || 'flat',
      dkMovePts: move.dkMovePts != null ? move.dkMovePts : null,
      dkLagsSharp: move.dkLagsSharp === true,
    };
  });
}

const OFFICIAL_MOVE_SLOTS = new Set(['0300', '1000', 'open']);

function moveSlotLabel(poll) {
  if (!poll) return '';
  const raw = poll.hhmm != null && poll.hhmm !== '' ? poll.hhmm : poll.slot;
  if (raw == null || raw === '') return '';
  const text = String(raw);
  if (text === 'open') return 'open';
  return text.padStart(4, '0');
}

/**
 * Line-move polls are 0300, 1000, and a stored open. Retired morning
 * slots are dropped. latest is the 1000 poll only. earliest is 0300,
 * else the stored open. Open does not stand in for a missing 0300 or
 * 1000 as a move endpoint (missingSlots says so).
 */
function shapeOfficialLinePath(polls, dateISO) {
  const by = {};
  for (const poll of polls || []) {
    const slot = moveSlotLabel(poll);
    if (!OFFICIAL_MOVE_SLOTS.has(slot) || !poll) continue;
    if (!by[slot]) by[slot] = poll;
  }
  const ordered = ['open', '0300', '1000'].map((slot) => by[slot]).filter(Boolean);
  const earliest = by['0300'] || by.open || null;
  const latest = by['1000'] || null;
  const missingSlots = [];
  if (!by['0300']) missingSlots.push('0300');
  if (!by['1000']) missingSlots.push('1000');
  return {
    path: ordered.length ? { date: dateISO || null, polls: ordered } : null,
    earliest,
    latest,
    missingSlots,
    source: latest ? 'pull-0300-1000' : 'missing-0300-1000',
  };
}

function earliestAndLatestPolls(pathDoc) {
  const polls = (pathDoc && Array.isArray(pathDoc.polls)) ? pathDoc.polls.slice() : [];
  if (!polls.length) return { earliest: null, latest: null };
  polls.sort((a, b) => String(a.hhmm || a.slot || '').localeCompare(String(b.hhmm || b.slot || '')));
  return { earliest: polls[0], latest: polls[polls.length - 1] };
}

function pollGameCount(poll) {
  if (!poll || typeof poll !== 'object') return 0;
  const games = poll.games;
  const keyCount = games && typeof games === 'object' ? Object.keys(games).length : 0;
  const declared = Number(poll.gameCount);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return keyCount;
}

function isUsablePoll(poll) {
  return pollGameCount(poll) > 0;
}

/** Required slots whose ET clock time has arrived. Later slots are not "missing" yet. */
function missingDueSlots(missingSlotsET, now = new Date()) {
  const nowSlot = hhmmET(now);
  return (missingSlotsET || []).filter((s) => String(s) <= String(nowSlot));
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || '').padStart(4, '0');
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Label for a capture-health retry.
 * A raw 0905 poll sorts between 0900 and 0915 and becomes "latest" before the
 * real 0915 snap. Use a missing canonical slot only when the clock is within
 * 12 minutes of it. When the book is empty, label the live fetch with the
 * latest due canonical slot so health can see one real snap. Otherwise return
 * null and skip the write — do not invent a 0600 open from a 9:30 price.
 */
function canonicalRetrySlot(now, opts = {}) {
  const list = (opts.slots && opts.slots.length)
    ? opts.slots
    : ((LINE_MOVE && LINE_MOVE.captureSlotsET) || ['0600', '0730', '0900', '0915']);
  const cur = hhmmToMinutes(hhmmET(now instanceof Date ? now : new Date()));
  const missing = new Set((opts.missingDue || []).map((s) => String(s)));
  const usable = Number(opts.usableSnapCount) || 0;
  if (cur == null) return usable === 0 ? list[list.length - 1] : null;
  let nearestMissing = null;
  let nearestDist = Infinity;
  for (const slot of list) {
    if (!missing.has(String(slot))) continue;
    const dist = Math.abs(hhmmToMinutes(slot) - cur);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestMissing = String(slot);
    }
  }
  if (nearestMissing && nearestDist <= 12) return nearestMissing;
  if (usable === 0) {
    let latest = null;
    for (const slot of list) {
      const t = hhmmToMinutes(slot);
      if (t != null && t <= cur + 2) latest = String(slot);
    }
    return latest || String(list[0]);
  }
  return null;
}

/**
 * Capture-health view of a loaded line path. Does not fetch or invent snaps.
 * A poll is usable only when it has games (gameCount > 0 or a non-empty games map).
 */
function assessCaptureHealth(dateISO, linePathMeta, opts = {}) {
  const required = (opts.requiredSlotsET || (LINE_MOVE && LINE_MOVE.captureSlotsET) || ['0600', '0730', '0900', '0915']).slice();
  const polls = (linePathMeta && linePathMeta.path && Array.isArray(linePathMeta.path.polls))
    ? linePathMeta.path.polls
    : [];
  const usable = polls.filter(isUsablePoll);
  const present = [];
  for (const slot of required) {
    const hit = usable.some((p) => String(p.hhmm || '') === slot || String(p.slot || '') === slot);
    if (hit) present.push(slot);
  }
  const missing = required.filter((s) => !present.includes(s));
  const usableSnapCount = usable.length;
  const hardFail = usableSnapCount === 0;
  const retriedCapture = !!opts.retriedCapture;
  const retryOk = opts.retryOk == null ? null : !!opts.retryOk;
  let warning = null;
  let reason = null;
  if (hardFail) {
    reason = opts.pullSlots
      ? `CAPTURE_HEALTH: zero usable 3:00/10:00 pulls for ${dateISO} after retry`
      : `CAPTURE_HEALTH: zero usable morning line snaps for ${dateISO} after retry`;
    warning = reason;
  } else if (missing.length) {
    const noun = opts.pullSlots ? '3:00/10:00 pulls' : 'morning snaps';
    warning = `CAPTURE_HEALTH: missing required ${noun} ${missing.join(',')} for ${dateISO} (present ${present.join(',') || 'none'}; usable=${usableSnapCount})`;
  }
  return {
    ok: !hardFail && missing.length === 0,
    requiredSlotsET: required,
    presentSlotsET: present,
    missingSlotsET: missing,
    usableSnapCount,
    retriedCapture,
    retryOk,
    warning,
    hardFail,
    reason,
  };
}

/** Odds API pulls capture-omega-pinnacle-lines actually schedules. */
const PULL_SLOTS_ET = ['0300', '1000'];

/** Retired morning line snaps. Absence does not warn and does not count. */
const RETIRED_MORNING_SLOTS_ET = ['0600', '0730', '0900', '0915'];

function bookHasQuote(books) {
  if (!books || typeof books !== 'object') return false;
  for (const quotes of Object.values(books)) {
    if (quotes && typeof quotes === 'object' && Object.keys(quotes).length > 0) return true;
  }
  return false;
}

function slotFromOddsRole(role) {
  const text = String(role || '');
  if (text === 'baseline-0300' || text === 'check-0300') return '0300';
  if (text === 'check-1000') return '1000';
  return null;
}

function notePinnaclePulls(doc, present) {
  if (!doc) return;
  const events = Array.isArray(doc) ? doc : (Array.isArray(doc.events) ? doc.events : [doc]);
  for (const eventDoc of events) {
    const checks = eventDoc && eventDoc.checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      const slot = check && String(check.slot || '');
      if ((slot === '0300' || slot === '1000') && bookHasQuote(check.books)) present.add(slot);
    }
  }
}

function noteOddsMasterPulls(index, present) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return;
  if (index.baseline0300) present.add('0300');
  const checks = index.checks;
  if (checks && typeof checks === 'object' && !Array.isArray(checks)) {
    if (checks['0300']) present.add('0300');
    if (checks['1000']) present.add('1000');
  }
  const prices = index.prices;
  if (!prices || typeof prices !== 'object') return;
  for (const row of Object.values(prices)) {
    if (!row || typeof row !== 'object') continue;
    const roles = [];
    if (row.role) roles.push(row.role);
    if (Array.isArray(row.roles)) roles.push(...row.roles);
    for (const role of roles) {
      const slot = slotFromOddsRole(role);
      if (slot) present.add(slot);
    }
  }
}

function noteLinePathPulls(linePath, present) {
  const polls = linePath && linePath.path && Array.isArray(linePath.path.polls)
    ? linePath.path.polls
    : (linePath && Array.isArray(linePath.polls) ? linePath.polls : null);
  if (!polls) return;
  for (const poll of polls) {
    if (!isUsablePoll(poll)) continue;
    for (const label of [poll.hhmm, poll.slot]) {
      const slot = String(label || '');
      if (slot === '0300' || slot === '1000') present.add(slot);
    }
  }
}

/**
 * Slots present in the 3:00 / 10:00 capture.
 * A pinnacle line-move check (slot 0300 or 1000 with quotes), the same
 * slots on a line-path poll, or the odds-master equivalents
 * (baseline-0300, check-0300, check-1000, or checks['0300'/'1000']).
 * Retired 0600/0730/0900/0915 polls are ignored.
 */
function presentPullSlots(sources) {
  const present = new Set();
  const src = sources && typeof sources === 'object' ? sources : {};
  notePinnaclePulls(src.pinnacleDoc || src.lineMoveDoc, present);
  noteLinePathPulls(src.linePath || src.linePathMeta, present);
  if (src.path || Array.isArray(src.polls)) noteLinePathPulls(src, present);
  const master = src.oddsMaster != null ? src.oddsMaster : src.oddsMasterIndexes;
  const rows = Array.isArray(master) ? master : (master ? [master] : []);
  for (const row of rows) {
    if (row && Array.isArray(row.events) && !row.prices && !row.baseline0300 && !row.checks) {
      for (const eventIndex of row.events) noteOddsMasterPulls(eventIndex, present);
    } else {
      noteOddsMasterPulls(row, present);
    }
  }
  return present;
}

/**
 * Capture health for the live Odds API pulls. Required slots are 0300 and
 * 1000. Missing retired morning slots do not warn.
 */
function assessPullCaptureHealth(dateISO, sources, opts = {}) {
  const present = presentPullSlots(sources);
  const polls = PULL_SLOTS_ET.filter((slot) => present.has(slot)).map((slot) => ({
    hhmm: slot,
    slot,
    gameCount: 1,
    games: { pull: true },
  }));
  return assessCaptureHealth(dateISO, { path: { polls } }, {
    retriedCapture: opts.retriedCapture,
    retryOk: opts.retryOk,
    requiredSlotsET: PULL_SLOTS_ET.slice(),
    pullSlots: true,
  });
}

/**
 * Missing morning slots, including zero usable snaps, do not block the card.
 * assessCaptureHealth still reports hardFail when nothing usable was stored.
 * Generate turns that into a warning and publishes.
 */
function warnCaptureHealth(health, dateISO) {
  if (!health || health.hardFail !== true) return health;
  const warning = health.warning
    || health.reason
    || `CAPTURE_HEALTH: missing morning snaps for ${dateISO}; card still publishes`;
  return {
    ...health,
    hardFail: false,
    reason: null,
    ok: false,
    warning,
  };
}

/**
 * Load line path for date; return { path, earliest, latest }.
 */
async function loadLinePath(dateISO) {
  const path = await readJsonBlob(pathBlobKey(dateISO));
  const fromPath = path && Array.isArray(path.polls) ? path.polls : [];
  const retired = fromPath.filter((poll) => {
    const slot = moveSlotLabel(poll);
    return slot && !OFFICIAL_MOVE_SLOTS.has(slot);
  });
  let shaped = shapeOfficialLinePath(fromPath, dateISO);
  if (!shaped.latest && !shaped.earliest) {
    const found = [];
    for (const hhmm of ['open', '0300', '1000']) {
      const snap = await readJsonBlob(snapBlobKey(dateISO, hhmm));
      if (snap && snap.games) found.push({ hhmm, slot: snap.slot || hhmm, ...snap, games: snap.games });
    }
    if (found.length) shaped = shapeOfficialLinePath(found, dateISO);
  }
  if (shaped.missingSlots.length || retired.length) {
    console.warn(JSON.stringify({
      event: 'line-move-snapshot-missing',
      date: dateISO,
      missing: shaped.missingSlots,
      ignoredRetiredSlots: retired.map(moveSlotLabel),
      source: shaped.source,
      note: 'line-move reads 0300 and 1000 only; retired morning snaps are not a fallback',
    }));
  }
  return shaped;
}

/**
 * Append a poll to omega-line-path/{date} and write omega-line-snap-{date}-{HHMM}.
 */
async function storeLinePoll(dateISO, poll) {
  const hhmm = poll.hhmm || hhmmET();
  const snapKey = snapBlobKey(dateISO, hhmm);
  const pathKey = pathBlobKey(dateISO);
  const snapDoc = {
    date: dateISO,
    hhmm,
    slot: poll.slot || hhmm,
    capturedAt: poll.capturedAt || new Date().toISOString(),
    games: poll.games || {},
    gameCount: Object.keys(poll.games || {}).length,
    sports: poll.sports || [],
    bookmakers: poll.bookmakers || [],
  };
  await writeJsonBlob(snapKey, snapDoc);

  let pathDoc = await readJsonBlob(pathKey);
  if (!pathDoc || !Array.isArray(pathDoc.polls)) {
    pathDoc = { date: dateISO, polls: [], store: BLOB_STORE };
  }
  // Replace same hhmm if re-run
  pathDoc.polls = pathDoc.polls.filter(p => String(p.hhmm) !== String(hhmm));
  pathDoc.polls.push({
    hhmm,
    slot: snapDoc.slot,
    capturedAt: snapDoc.capturedAt,
    games: snapDoc.games,
    gameCount: snapDoc.gameCount,
  });
  pathDoc.polls.sort((a, b) => String(a.hhmm).localeCompare(String(b.hhmm)));
  pathDoc.updatedAt = new Date().toISOString();
  await writeJsonBlob(pathKey, pathDoc);
  return { snapKey, pathKey, gameCount: snapDoc.gameCount };
}

module.exports = {
  gameKey,
  hhmmET,
  etDateISO,
  snapBlobKey,
  pathBlobKey,
  extractGameBooks,
  bestUsPrint,
  sharpPrint,
  sidePrint,
  computeOpenToNowMove,
  sharpSteamSinceOpen,
  adverseSteamReason,
  annotateLineMoves,
  earliestAndLatestPolls,
  shapeOfficialLinePath,
  moveSlotLabel,
  pollGameCount,
  isUsablePoll,
  missingDueSlots,
  canonicalRetrySlot,
  assessCaptureHealth,
  assessPullCaptureHealth,
  presentPullSlots,
  PULL_SLOTS_ET,
  RETIRED_MORNING_SLOTS_ET,
  warnCaptureHealth,
  loadLinePath,
  storeLinePoll,
  readJsonBlob,
  writeJsonBlob,
  median,
  normToken,
};
