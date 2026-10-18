'use strict';
/**
 * V1 LOCK generator — parallel backend, governed by NFL-NCAAF-LOCK.md v1.2.
 * Football only (NFL + NCAAF). NHL/MLB/NBA: OUT (football-only spec).
 * Replay/blind: odds come from the STORED morning board (no Odds API, no
 * credits, no live scores). QB flags come from ESPN's injuries feed (flags
 * only, zero points); an out/doubtful QB with unknown replacement passes
 * the whole game (§8). If the QB feed cannot be read, availability is
 * unknown for every game and the card passes honestly (missing-data rule).
 */
const { MODEL_VERSION_V1, ENGINE_V1 } = require('./config-v1');
const { selectBoardPollV1, reconstructEventsV1 } = require('./board-v1');
const { projectAllV1 } = require('./project-v1');
const { selectV1 } = require('./select-v1');
const { readStoredBoardV1, storeCardV1 } = require('./store-v1');
const { loadEfficiencySeeds } = require('../omega-vnext/ingest');
const { lookupQb } = require('../omega-vnext/sports/game_day');
const { noPlaysFields } = require('../no-plays');

function todayET() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function formatDateLong(dateISO) {
  try { const [y, m, d] = dateISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 16)).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  } catch (_) { return dateISO; }
}
async function fetchQbMapV1(leagueSlug) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/${leagueSlug}/injuries`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`QB feed HTTP ${resp.status}`);
  const data = await resp.json();
  const out = {};
  const apply = (teamName, pos, status, athleteName) => {
    if ((pos || '').toUpperCase() !== 'QB' || !teamName) return;
    const st = String(status || '').toLowerCase();
    if (!/(out|doubtful|questionable|injured reserve|\bir\b|ruled out)/i.test(st)) return;
    const rank = s => (/out|ruled out|ir|injured reserve/.test(s) ? 3 : /doubtful/.test(s) ? 2 : 1);
    const prev = out[teamName];
    if (prev && rank(String(prev.qbStatus)) >= rank(st)) return;
    out[teamName] = { team: teamName, qbStatus: st, qbName: athleteName || null };
  };
  for (const team of (data.injuries || data.teams || [])) {
    const teamName = team.displayName || (team.team && team.team.displayName) || '';
    for (const inj of (team.injuries || team.athletes || [])) {
      apply(teamName, (inj.athlete && inj.athlete.position && inj.athlete.position.abbreviation) || inj.position,
        inj.status || inj.type, (inj.athlete && inj.athlete.displayName) || inj.displayName);
    }
  }
  return { ok: true, map: out };
}
async function generateV1Lock(opts = {}) {
  const dateISO = opts.date || todayET();
  const dryRun = !!opts.dryRun;
  const boardDoc = opts.boardDoc || await readStoredBoardV1(dateISO);
  if (!boardDoc || !Array.isArray(boardDoc.polls) || !boardDoc.polls.length) {
    throw new Error(`V1: no stored board (omega-line-path/${dateISO}) — refusing to fetch live odds`);
  }
  const poll = selectBoardPollV1(boardDoc.polls, opts.boardCutoff || '1000');
  if (!poll) throw new Error('V1: stored board has no usable poll');
  const boardSlot = String(poll.hhmm || poll.slot);
  const allEvents = reconstructEventsV1(poll.games);
  const events = allEvents.filter(e => e.sport === 'NFL' || e.sport === 'NCAAF');
  const otherSportsOnBoard = [...new Set(allEvents.map(e => e.sport).filter(s => s && s !== 'NFL' && s !== 'NCAAF'))];

  // QB flags (flags only). Feed failure => availability unknown => all pass.
  let qbFeedOk = true; const qbMaps = {};
  for (const [sport, slug] of [['NFL', 'nfl'], ['NCAAF', 'college-football']]) {
    try { qbMaps[sport] = (await fetchQbMapV1(slug)).map; }
    catch (e) { qbFeedOk = false; qbMaps[sport] = {}; console.error(`[v1-lock] QB feed ${sport} failed: ${e.message}`); }
    if (opts.qbMaps && opts.qbMaps[sport]) { qbMaps[sport] = opts.qbMaps[sport]; qbFeedOk = true; }
  }
  const qbByGame = {};
  for (const ev of events) {
    const map = qbMaps[ev.sport] || {};
    const hq = lookupQb(ev.home_team, map); const aq = lookupQb(ev.away_team, map);
    const flags = [];
    let unknown = false;
    for (const [side, q] of [['home', hq], ['away', aq]]) {
      if (!q) continue;
      const st = String(q.qbStatus || '');
      flags.push(`${side} QB ${q.qbName || ''} (${st})`.trim());
      if (/(out|doubtful|ruled out|injured reserve|\bir\b)/i.test(st)) unknown = true;
    }
    if (!qbFeedOk) unknown = true; // availability unknown for every game
    qbByGame[`${ev.away_team} @ ${ev.home_team}`] = {
      flag: !qbFeedOk ? 'QB availability unknown (feed unavailable)' : (flags.length ? flags.join('; ') : null),
      unknownReplacement: unknown,
    };
  }

  const seeds = loadEfficiencySeeds();
  const efficiencyBySport = { NFL: seeds.NFL || {}, NCAAF: seeds.NCAAF || {} };
  const { candidates, passes } = projectAllV1(events, efficiencyBySport, { qbByGame, boardSlot });
  const { picks, parlayLegs, funnel, rejections } = selectV1(candidates, passes);
  funnel.gamesOnBoard = events.length;
  funnel.otherSportsExcluded = otherSportsOnBoard;
  funnel.qbFeedOk = qbFeedOk;
  funnel.boardSlot = boardSlot;
  funnel.boardCapturedAt = poll.capturedAt || null;

  const totalUnits = picks.reduce((s, p) => s + (parseFloat(p.units) || 0), 0)
    + (parlayLegs || []).reduce((s, pl) => s + (parseFloat(pl.units) || 0), 0);
  const card = {
    date: dateISO, dateFormatted: formatDateLong(dateISO),
    model: MODEL_VERSION_V1, engine: ENGINE_V1, source: 'v1-lock',
    picks, parlayLegs: picks.length ? parlayLegs : [], sgps: [],
    rejections, generatedAt: new Date().toISOString(),
    boardSlot, boardCapturedAt: poll.capturedAt || null,
    summary: { totalPicks: picks.length, totalStraightBets: picks.length,
      totalUnits: `${totalUnits.toFixed(2).replace(/\.?0+$/, '') || '0'}u`,
      aplusLocks: picks.filter(p => p.lockGrade === 'A').length,
      sportsCovered: [...new Set(picks.map(p => p.sport))], modelVersion: MODEL_VERSION_V1 },
    funnel, modelNotes: 'V1 Lock (NFL-NCAAF-LOCK.md v1.2): formula-first ratings, Pinnacle power de-vig receipt, fitted anchor (NFL/NCAAF w=0.10, NFL total w=0), sheet admission, Grade A verified only. Football only.',
    claudeVerified: false, fallback: false,
  };
  if (!picks.length) {
    Object.assign(card, noPlaysFields(
      `V1 Lock priced ${events.length} football game(s) from the stored ${boardSlot} board and none cleared the Lock verification and sheet admission. An empty card is a valid card.`,
      { noGames: events.length === 0 }));
    card.edgeSummary = card.noPlaysReason; card.insights = '';
  }
  if (!dryRun) await storeCardV1(dateISO, card);
  return card;
}
module.exports = { generateV1Lock, fetchQbMapV1, MODEL_VERSION_V1 };
