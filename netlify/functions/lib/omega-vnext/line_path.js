'use strict';

/**
 * Omega open→pick line-path helpers (pure + blob I/O).
 * Morning US-hours polls → steamToward / steamAgainst / residual CLV features.
 */

const {
  SITE_ID, BLOB_STORE, US_BOOKS, SHARP_BOOKS, LINE_MOVE, US_BOOK_PRIORITY,
} = require('./config');
const { americanToImplied } = require('./odds_math');

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
  return fetch(url, opts);
}

async function readJsonBlob(path) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    return await store.get(path, { type: 'json' });
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
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    await store.setJSON(path, data);
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
 * Best US book print for a candidate side (priority order).
 */
function bestUsPrint(gameSnap, candidate) {
  if (!gameSnap || !gameSnap.books) return null;
  const market = String(candidate.market || candidate.betType || '');
  const side = String(candidate.side || candidate.pick || '');
  const home = gameSnap.homeTeam;
  const away = gameSnap.awayTeam;
  const priority = (US_BOOK_PRIORITY || US_BOOKS).map(bookKey);

  const ordered = [
    ...priority.filter(k => gameSnap.books[k]),
    ...Object.keys(gameSnap.books).filter(k => !priority.includes(k) && US_BOOKS.map(bookKey).includes(k)),
  ];

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

function normToken(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Signed steam toward pick:
 *  +positive ⇒ market moved toward our side (good for residual CLV if we already got better price)
 *  For odds: higher American is better for bettor → move = nowOdds - openOdds (positive = steam toward / got longer)
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
  // Fallback now from candidate posted odds/line
  const nowOdds = nowPrint && nowPrint.odds != null
    ? nowPrint.odds
    : (typeof candidate.odds === 'number' ? candidate.odds : null);
  const nowLine = nowPrint && nowPrint.line != null
    ? nowPrint.line
    : (candidate.line != null ? Number(candidate.line) : null);

  let oddsMoveCents = null;
  if (openPrint && openPrint.odds != null && nowOdds != null) {
    oddsMoveCents = +(nowOdds - openPrint.odds).toFixed(2);
  }

  let lineMovePts = null;
  if (openPrint && openPrint.line != null && nowLine != null) {
    lineMovePts = +(nowLine - openPrint.line).toFixed(3);
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

  // vs sharp open→now (optional context)
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

  return {
    oddsMoveCents,
    lineMovePts,
    steamToward,
    steamAgainst,
    towardScore: +towardScore.toFixed(4),
    residualClvProxy,
    _market: market,
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
    } : { line: nowLine, odds: nowOdds },
    sharpLineMove,
    missingOpen: false,
  };
}

/**
 * Gate / QA: is adverse steam past reject threshold?
 */
function adverseSteamReason(move, { verify = false, market = null } = {}) {
  const cfg = LINE_MOVE || {};
  if (!move || move.missingOpen) return null;
  if (!move.steamAgainst) return null;

  const centsThresh = verify
    ? (cfg.verifyAdverseCents != null ? cfg.verifyAdverseCents : 20)
    : (cfg.rejectSteamAgainstCents != null ? cfg.rejectSteamAgainstCents : 18);
  const ptsMap = verify
    ? (cfg.verifyAdversePts || { Spread: 1.5, Total: 1.5 })
    : (cfg.rejectSteamAgainstPts || { Spread: 1.0, Total: 1.0 });

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
    };
  });
}

function earliestAndLatestPolls(pathDoc) {
  const polls = (pathDoc && Array.isArray(pathDoc.polls)) ? pathDoc.polls.slice() : [];
  if (!polls.length) return { earliest: null, latest: null };
  polls.sort((a, b) => String(a.hhmm || a.slot || '').localeCompare(String(b.hhmm || b.slot || '')));
  return { earliest: polls[0], latest: polls[polls.length - 1] };
}

/**
 * Load line path for date; return { path, earliest, latest }.
 */
async function loadLinePath(dateISO) {
  const path = await readJsonBlob(pathBlobKey(dateISO));
  if (path && Array.isArray(path.polls) && path.polls.length) {
    const { earliest, latest } = earliestAndLatestPolls(path);
    return { path, earliest, latest };
  }
  // Fallback: try common morning snap keys
  const slots = ['0600', '0730', '0900'];
  const found = [];
  for (const hhmm of slots) {
    const snap = await readJsonBlob(snapBlobKey(dateISO, hhmm));
    if (snap && snap.games) found.push({ hhmm, ...snap, games: snap.games });
  }
  if (!found.length) return { path: null, earliest: null, latest: null };
  found.sort((a, b) => String(a.hhmm).localeCompare(String(b.hhmm)));
  return {
    path: { date: dateISO, polls: found },
    earliest: found[0],
    latest: found[found.length - 1],
  };
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
  computeOpenToNowMove,
  adverseSteamReason,
  annotateLineMoves,
  earliestAndLatestPolls,
  loadLinePath,
  storeLinePoll,
  readJsonBlob,
  writeJsonBlob,
  median,
  normToken,
};
