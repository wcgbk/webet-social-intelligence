'use strict';

/**
 * Omega QA hard-fails — drop pick before publish unlock; try next diversified YES.
 * NO lean force-fill. Claude remains verifier/narrator only.
 *
 * Checks:
 *  - MLB: starting pitcher scratched/changed vs assumed SP
 *  - NFL/NCAAF: QB ruled out / downgraded
 *  - Odds stale vs lockSnapshot / market gone at major books
 */

const {
  QA_HARDFAIL, MAJOR_LIQUIDITY_BOOKS, MAX_STRAIGHTS, ESPN_LEAGUES,
} = require('./config');
const { matchupKey, selectStraights, toPickObject } = require('./select');
const { adverseSteamReason } = require('./line_path');

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function teamsFuzzy(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const la = na.split(' ').pop();
  const lb = nb.split(' ').pop();
  return la && lb && la === lb && la.length > 3;
}

function parseAmerican(odds) {
  if (odds == null) return null;
  if (typeof odds === 'number' && Number.isFinite(odds)) return odds;
  const m = String(odds).trim().match(/^[+-]?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function americanCentsMove(a, b) {
  const x = parseAmerican(a);
  const y = parseAmerican(b);
  if (x == null || y == null) return null;
  return Math.abs(x - y);
}

function lineMove(a, b) {
  if (a == null || b == null) return null;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.abs(x - y);
}

// ── Fetch helpers (best-effort; failures = no hard-fail from that signal) ──

async function fetchJson(url, timeoutMs = 10000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/**
 * MLB StatsAPI probable pitchers keyed by normalized team name.
 * Returns { [team]: { name, id, scratched?: boolean } }
 */
async function fetchMlbProbables(dateISO) {
  const out = {};
  try {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateISO}&hydrate=probablePitcher`;
    const data = await fetchJson(url, 10000);
    for (const d of (data.dates || [])) {
      for (const g of (d.games || [])) {
        for (const side of ['home', 'away']) {
          const t = g.teams && g.teams[side];
          const pp = t && t.probablePitcher;
          const teamName = t && t.team && t.team.name;
          if (!teamName) continue;
          if (pp && pp.fullName) {
            out[normName(teamName)] = {
              name: pp.fullName,
              id: pp.id,
              team: teamName,
            };
          }
        }
      }
    }
  } catch (e) {
    console.log(`[qa_hardfail] MLB probables skipped: ${e.message}`);
  }
  return out;
}

/**
 * ESPN injuries → map of teamName → { qbStatus, qbName } for football.
 */
async function fetchFootballQbStatus(leagueSlug) {
  const out = {};
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/${leagueSlug}/injuries`;
    const data = await fetchJson(url, 8000);
    const apply = (teamName, pos, status, athleteName) => {
      if ((pos || '').toUpperCase() !== 'QB') return;
      const st = String(status || '').toLowerCase();
      const hit = QA_HARDFAIL.qbOutStatuses.some(k => st.includes(k));
      if (!hit) return;
      out[normName(teamName)] = {
        team: teamName,
        qbStatus: st,
        qbName: athleteName || null,
      };
    };
    for (const team of (data.injuries || data.teams || [])) {
      const teamName = team.displayName || (team.team && team.team.displayName) || '';
      for (const inj of (team.injuries || team.athletes || [])) {
        apply(
          teamName,
          (inj.athlete && inj.athlete.position && inj.athlete.position.abbreviation) || inj.position,
          inj.status || inj.type,
          (inj.athlete && inj.athlete.displayName) || inj.displayName
        );
      }
    }
    if (!Object.keys(out).length && Array.isArray(data.items)) {
      for (const item of data.items) {
        apply(
          (item.team && item.team.displayName) || '',
          item.athlete && item.athlete.position && item.athlete.position.abbreviation,
          item.status,
          item.athlete && item.athlete.displayName
        );
      }
    }
  } catch (e) {
    console.log(`[qa_hardfail] QB injuries ${leagueSlug} skipped: ${e.message}`);
  }
  return out;
}

/**
 * ESPN MLB scoreboard notes / scratch signals (best-effort headlines).
 * Returns { [normTeam]: { note, scratched: boolean } }
 */
async function fetchMlbScratchSignals(dateISO) {
  const out = {};
  try {
    const dates = String(dateISO || '').replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dates}`;
    const data = await fetchJson(url, 10000);
    for (const ev of (data.events || [])) {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const notes = (comp.notes || []).map(n => String(n.headline || n.text || '')).join(' | ');
      const headlines = (ev.competitions || []).flatMap(c => (c.notes || []).map(n => n.headline || '')).join(' ');
      const blob = `${notes} ${headlines} ${ev.name || ''}`.toLowerCase();
      for (const c of (comp.competitors || [])) {
        const team = (c.team && (c.team.displayName || c.team.name)) || '';
        if (!team) continue;
        const scratched = QA_HARDFAIL.spScratchKeywords.some(k => blob.includes(k) && blob.includes(normName(team).split(' ').pop()));
        // Also check probable pitcher change flags on competitor
        const probables = c.probables || c.probablePitchers || [];
        let statusNote = '';
        for (const p of probables) {
          statusNote += ` ${p.status || ''} ${p.athlete && p.athlete.displayName || ''}`;
        }
        const statusBlob = statusNote.toLowerCase();
        const statusScratch = QA_HARDFAIL.spScratchKeywords.some(k => statusBlob.includes(k));
        if (scratched || statusScratch) {
          out[normName(team)] = { team, note: blob.slice(0, 200), scratched: true };
        }
      }
    }
  } catch (e) {
    console.log(`[qa_hardfail] MLB scratch signals skipped: ${e.message}`);
  }
  return out;
}

function findQbOut(qbMap, teamName) {
  const n = normName(teamName);
  if (qbMap[n]) return qbMap[n];
  for (const [k, v] of Object.entries(qbMap)) {
    if (teamsFuzzy(k, teamName)) return v;
  }
  return null;
}

function findProbable(probMap, teamName) {
  const n = normName(teamName);
  if (probMap[n]) return probMap[n];
  for (const [k, v] of Object.entries(probMap)) {
    if (teamsFuzzy(k, teamName)) return v;
  }
  return null;
}

/**
 * Pure check: return hard-fail reason string or null.
 * ctx supplies pre-fetched maps + optional liveOddsEvent.
 */
function evaluateHardFail(pick, ctx = {}) {
  const cfg = QA_HARDFAIL;
  const sport = (pick.sport || '').toUpperCase();
  const market = pick.betType || pick.market || '';
  const home = pick.homeTeam || '';
  const away = pick.awayTeam || '';

  // ── Stale odds ──
  const lock = pick.lockSnapshot || ctx.lockSnapshot;
  if (lock && (lock.odds != null || lock.line != null)) {
    const liveOdds = pick.liveOdds != null ? pick.liveOdds : (ctx.liveOdds != null ? ctx.liveOdds : pick.odds);
    const liveLine = pick.liveLine != null ? pick.liveLine : (ctx.liveLine != null ? ctx.liveLine : pick.line);
    const cents = americanCentsMove(lock.odds, liveOdds);
    if (cents != null && cents > cfg.staleOddsCents) {
      return `stale_odds: moved ${cents}c vs lock (threshold ${cfg.staleOddsCents})`;
    }
    const mKey = /total/i.test(market) ? 'Total'
      : (/spread|run line|puck/i.test(market) ? 'Spread' : 'Moneyline');
    const lineThresh = cfg.staleLinePts[mKey];
    if (lineThresh != null) {
      const lm = lineMove(lock.line, liveLine);
      if (lm != null && lm > lineThresh) {
        return `stale_line: moved ${lm} pts vs lock (threshold ${lineThresh})`;
      }
    }
  }

  // Open→pick adverse steam (generate annotate or verify recheck)
  {
    const move = pick.lineMove || ctx.lineMove || null;
    if (move) {
      const reason = adverseSteamReason(move, { verify: !!ctx.verifySteam });
      if (reason) return reason;
    }
  }

  // Market no longer offered at major books
  if (cfg.requireMajorBookStillOffered && ctx.majorBooksOffering === false) {
    return 'market_gone: no longer offered at major liquidity books';
  }

  // ── MLB SP scratch ──
  if (sport === 'MLB') {
    const isMlOrSpread = /moneyline|ml|spread|run line/i.test(market) || !/total/i.test(market);
    const assumed = pick.assumedStarter || pick.probablePitcher || null;
    const liveHome = findProbable(ctx.mlbProbables || {}, home);
    const liveAway = findProbable(ctx.mlbProbables || {}, away);
    const scratchHome = (ctx.mlbScratches || {})[normName(home)] || findScratch(ctx.mlbScratches, home);
    const scratchAway = (ctx.mlbScratches || {})[normName(away)] || findScratch(ctx.mlbScratches, away);

    if (assumed && assumed.name) {
      const assumedNorm = normName(assumed.name);
      const teamSide = assumed.teamSide || assumed.team || '';
      const live = /home/i.test(teamSide) || teamsFuzzy(teamSide, home)
        ? liveHome
        : (/away/i.test(teamSide) || teamsFuzzy(teamSide, away) ? liveAway : (liveHome || liveAway));
      if (live && live.name && normName(live.name) !== assumedNorm) {
        return `sp_changed: assumed ${assumed.name} → live ${live.name}`;
      }
    }
    if (isMlOrSpread && (scratchHome || scratchAway)) {
      if (assumed || cfg.mlbScratchWithoutAssumedSp) {
        const which = scratchHome || scratchAway;
        return `sp_scratched: ${which.team || 'team'} — ${which.note || 'scratch signal'}`;
      }
    }
  }

  // ── NFL / NCAAF QB out ──
  if (sport === 'NFL' || sport === 'NCAAF' || sport === 'CFB') {
    const qbMap = sport === 'NFL' ? (ctx.nflQb || {}) : (ctx.cfbQb || {});
    const homeQb = findQbOut(qbMap, home);
    const awayQb = findQbOut(qbMap, away);
    // Projection depends on QB for ML/Spread; Totals also QB-sensitive — hard-fail all when QB out
    if (homeQb) return `qb_out: ${homeQb.team} QB ${homeQb.qbName || ''} (${homeQb.qbStatus})`;
    if (awayQb) return `qb_out: ${awayQb.team} QB ${awayQb.qbName || ''} (${awayQb.qbStatus})`;
  }

  return null;
}

function findScratch(map, teamName) {
  if (!map) return null;
  const n = normName(teamName);
  if (map[n]) return map[n];
  for (const [k, v] of Object.entries(map)) {
    if (teamsFuzzy(k, teamName)) return v;
  }
  return null;
}

/**
 * Check whether a candidate's market is still offered at ≥1 major book on a live odds event.
 */
function majorBookStillOffers(event, candidate) {
  if (!event || !Array.isArray(event.bookmakers)) return null; // unknown
  const marketKey = /total/i.test(candidate.market || '') ? 'totals'
    : (/spread|run line/i.test(candidate.market || '') ? 'spreads' : 'h2h');
  const sideHint = normName(candidate.side || candidate.pick || '').split(' ')[0];
  for (const b of event.bookmakers) {
    if (!MAJOR_LIQUIDITY_BOOKS.includes(b.key)) continue;
    const mkt = (b.markets || []).find(m => m.key === marketKey);
    if (!mkt || !mkt.outcomes || !mkt.outcomes.length) continue;
    // any matching outcome is enough
    if (!sideHint) return true;
    if (mkt.outcomes.some(o => normName(o.name).includes(sideHint) || sideHint.includes(normName(o.name).split(' ')[0]))) {
      return true;
    }
    return true; // market present at major book
  }
  return false;
}

/**
 * Fetch injury/probable context for a date.
 */
async function loadQaContext(dateISO, sportsNeeded = []) {
  const need = new Set((sportsNeeded || []).map(s => String(s).toUpperCase()));
  const ctx = { mlbProbables: {}, mlbScratches: {}, nflQb: {}, cfbQb: {} };
  const jobs = [];
  if (need.has('MLB') || need.size === 0) {
    jobs.push(fetchMlbProbables(dateISO).then(v => { ctx.mlbProbables = v; }));
    jobs.push(fetchMlbScratchSignals(dateISO).then(v => { ctx.mlbScratches = v; }));
  }
  if (need.has('NFL') || need.size === 0) {
    jobs.push(fetchFootballQbStatus('nfl').then(v => { ctx.nflQb = v; }));
  }
  if (need.has('NCAAF') || need.has('CFB') || need.size === 0) {
    jobs.push(fetchFootballQbStatus('college-football').then(v => { ctx.cfbQb = v; }));
  }
  await Promise.all(jobs);
  return ctx;
}

/**
 * Apply hard-fails to selected picks; refill from yesPool when possible.
 * @returns {{ picks, hardFails, yesPoolRemaining }}
 */
function applyHardFails(selectedCandidates, yesPool, ctx, { maxN = MAX_STRAIGHTS, modelVersion } = {}) {
  const fails = [];
  const kept = [];
  const usedGames = new Set();
  const rejectedKeys = new Set();

  const checkOne = (c) => {
    const reason = evaluateHardFail(c, {
      ...ctx,
      majorBooksOffering: c.majorBooksOffering,
      liveOdds: c.liveOdds,
      liveLine: c.liveLine,
    });
    return reason;
  };

  for (const c of selectedCandidates || []) {
    const reason = checkOne(c);
    if (reason) {
      fails.push({
        matchup: c.matchup,
        side: c.side,
        sport: c.sport,
        reason,
        hardFail: true,
      });
      rejectedKeys.add(`${matchupKey(c)}||${c.side}`);
      continue;
    }
    kept.push(c);
    usedGames.add(matchupKey(c));
  }

  // Refill from remaining yes pool (diversified)
  if (kept.length < maxN && yesPool && yesPool.length) {
    const remaining = yesPool.filter(c => {
      if (rejectedKeys.has(`${matchupKey(c)}||${c.side}`)) return false;
      if (usedGames.has(matchupKey(c))) return false;
      if (kept.some(k => matchupKey(k) === matchupKey(c) && k.side === c.side)) return false;
      return true;
    });
    // Re-select from remaining, skipping hard-fails
    const sorted = selectStraights(remaining, maxN - kept.length);
    for (const c of sorted) {
      if (kept.length >= maxN) break;
      const reason = checkOne(c);
      if (reason) {
        fails.push({
          matchup: c.matchup,
          side: c.side,
          sport: c.sport,
          reason,
          hardFail: true,
        });
        rejectedKeys.add(`${matchupKey(c)}||${c.side}`);
        continue;
      }
      kept.push(c);
      usedGames.add(matchupKey(c));
    }
  }

  const picks = kept.map(c => {
    const obj = toPickObject(c, { modelVersion });
    // preserve lock snapshot seed from candidate odds
    obj.lockSnapshot = c.lockSnapshot || {
      odds: obj.odds,
      line: c.line != null ? c.line : null,
      book: c.book || null,
      capturedAt: new Date().toISOString(),
    };
    if (c.assumedStarter) obj.assumedStarter = c.assumedStarter;
    if (c.probablePitcher) obj.probablePitcher = c.probablePitcher;
    if (c.openPrint) {
      obj.openPrint = c.openPrint;
      obj.lockSnapshot = obj.lockSnapshot || {};
      obj.lockSnapshot.openPrint = c.openPrint;
    }
    if (c.lineMove) obj.lineMove = c.lineMove;
    if (c.steamToward != null) obj.steamToward = !!c.steamToward;
    if (c.steamAgainst != null) obj.steamAgainst = !!c.steamAgainst;
    if (c.predictedResidualClv != null) obj.predictedResidualClv = c.predictedResidualClv;
    return obj;
  });

  return {
    picks,
    hardFails: fails,
    yesPoolRemaining: (yesPool || []).filter(c => !rejectedKeys.has(`${matchupKey(c)}||${c.side}`)),
  };
}

module.exports = {
  evaluateHardFail,
  applyHardFails,
  loadQaContext,
  majorBookStillOffers,
  americanCentsMove,
  lineMove,
  parseAmerican,
  fetchMlbProbables,
  fetchFootballQbStatus,
  fetchMlbScratchSignals,
  normName,
  teamsFuzzy,
};
