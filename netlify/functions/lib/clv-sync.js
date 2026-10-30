'use strict';
/**
 * clv-sync — builds clv.games / clv.odds_snapshots rows for one ET date from Netlify Blobs:
 *   odds-master: by-date/{date} events + {sport}/{eventId}/{book}/{market}/{ts} price blobs
 *                (3:00 / 10:00 ET pulls; legacy role=open|close blobs keep their role)
 *   edge-picks-omega: clv-{date} pick closes (Pinnacle anchor) -> line_type 'closing'
 * Read-only on blobs. No Odds API call. No omega-vnext imports.
 */
const { seasonFor, marketFromBetType, num, mapLimit } = require('./clv-supabase');

const BOOKS = ['pinnacle', 'draftkings'];
const MARKETS = ['h2h', 'spreads', 'totals'];
const ROLE_LINE = { open: 'opening', close: 'closing' };

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function lineTypeFor(doc, commence) {
  const ts = doc.snapshotAt || doc.timestamp || doc.at;
  if (commence && ts && new Date(ts) > new Date(commence)) return null; // live / post-start: skip
  if (doc.role && ROLE_LINE[doc.role]) {
    if (doc.role === 'close' && doc.pregame === false) return null;
    return ROLE_LINE[doc.role];
  }
  return 'snapshot';
}

function snapsFromPriceDoc(doc, ev) {
  const lineType = lineTypeFor(doc, ev.commenceTime);
  if (!lineType) return [];
  const ts = doc.snapshotAt || doc.timestamp || doc.at;
  const rows = [];
  for (const [k, s] of Object.entries(doc.sides || {})) {
    if (!s || num(s.price) == null) continue;
    let side;
    if (k === 'over') side = 'Over';
    else if (k === 'under') side = 'Under';
    else if (k === 'home') side = s.team || ev.homeTeam;
    else if (k === 'away') side = s.team || ev.awayTeam;
    else continue;
    rows.push({
      game_id: ev.eventId, sport: ev.sport, book: doc.book, market: doc.market, side,
      point: doc.market === 'h2h' ? null : num(s.line), price: num(s.price), line_type: lineType,
      snapshot_ts: ts, source: 'netlify:odds-master',
    });
  }
  return rows;
}

function gameRow(ev, source) {
  return {
    game_id: ev.eventId, sport: ev.sport, season: seasonFor(ev.sport, ev.commenceTime),
    commence_time: ev.commenceTime || null, home_team: ev.homeTeam || null, away_team: ev.awayTeam || null, source,
  };
}

function pickSide(p, market, ev) {
  const pick = String(p.pick || '');
  if (market === 'totals') return /^under/i.test(pick) ? 'Under' : 'Over';
  if (norm(pick).startsWith(norm(ev.homeTeam))) return ev.homeTeam;
  if (norm(pick).startsWith(norm(ev.awayTeam))) return ev.awayTeam;
  return null;
}

function clvRows(clvDoc, events) {
  const out = { snaps: [], unmatched: [] };
  for (const p of (clvDoc && clvDoc.picks) || []) {
    if (p.closingOdds == null || !/pinnacle/i.test(String(p.anchor || p.anchorBook || ''))) continue;
    const [away, home] = String(p.matchup || '').split(' @ ');
    const ev = events.find((e) => e.sport === p.sport && norm(e.homeTeam) === norm(home) && norm(e.awayTeam) === norm(away));
    const market = marketFromBetType(p.betType || p.market, p.pick);
    const side = ev && pickSide(p, market, ev);
    if (!ev || !side) { out.unmatched.push(`${p.sport} ${p.matchup} ${p.pick}`); continue; }
    let point = null;
    if (market !== 'h2h') {
      point = num(p.closingLine);
      const m = String(p.pick).match(/([+-]\d+(?:\.\d+)?)\s*$/);
      if (market === 'spreads' && point != null && m && Math.sign(Number(m[1])) !== Math.sign(point)) point = -point;
    }
    out.snaps.push({
      game_id: ev.eventId, sport: ev.sport, book: 'pinnacle', market, side, point,
      price: num(p.closingOdds), line_type: 'closing', snapshot_ts: p.closeSnapshotAt || clvDoc.capturedAt,
      source: 'netlify:clv-blob',
    });
  }
  return out;
}

async function buildDay(date, blobs, opts = {}) {
  const limit = opts.concurrency || 12;
  const byDate = (await blobs.get('odds-master', `by-date/${date}`)) || { events: [] };
  const events = (byDate.events || []).filter((e) => e && e.eventId && e.sport);
  const games = events.map((e) => gameRow(e, 'netlify:odds-master'));
  const snaps = [];
  const stats = { events: events.length, priceBlobs: 0, errors: [] };
  await mapLimit(events, limit, async (ev) => {
    try {
      const keys = await blobs.list('odds-master', `${ev.sport}/${ev.eventId}/`);
      const wanted = keys.filter((k) => {
        const parts = k.split('/');
        return parts.length >= 5 && BOOKS.includes(parts[2]) && MARKETS.includes(parts[3]);
      });
      stats.priceBlobs += wanted.length;
      const docs = await mapLimit(wanted, 4, (k) => blobs.get('odds-master', k));
      for (const d of docs) if (d) snaps.push(...snapsFromPriceDoc({ ...d, book: d.book, market: d.market }, ev));
    } catch (e) {
      stats.errors.push(`${ev.sport}/${ev.eventId}: ${e.message}`);
    }
  });
  // Pick closes from the CLV ledger blob (matched against this and neighbouring days' events).
  const clvDoc = await blobs.get('edge-picks-omega', `clv-${date}`);
  let clv = { snaps: [], unmatched: [] };
  if (clvDoc) {
    const near = [...events];
    for (const d of opts.neighbourDates || []) {
      const extra = await blobs.get('odds-master', `by-date/${d}`);
      for (const e of (extra && extra.events) || []) if (e && e.eventId) near.push(e);
    }
    clv = clvRows(clvDoc, near);
    for (const s of clv.snaps) {
      const e = near.find((x) => x.eventId === s.game_id);
      if (e && !games.find((g) => g.game_id === e.eventId)) games.push(gameRow(e, 'netlify:odds-master'));
    }
  }
  stats.clvBlob = !!clvDoc;
  stats.clvCloses = clv.snaps.length;
  stats.clvUnmatched = clv.unmatched;
  return { games, snaps: [...snaps, ...clv.snaps], stats };
}

module.exports = { buildDay, snapsFromPriceDoc, clvRows, lineTypeFor, gameRow, BOOKS, MARKETS };
