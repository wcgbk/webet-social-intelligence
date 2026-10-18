'use strict';
/**
 * V1 data feeds — Spec §§3,4,5 (last 5, injuries, key starter) for football.
 * Source: the same public ESPN feeds the Omega pipeline already ingests
 * (scoreboard for team ids, team schedule for last-5 results, injuries for
 * the QB/injury read). Everything soft-fails: a feed that cannot be pulled
 * leaves the field null, and Spec §9 then passes the game — nothing is
 * fabricated. NHL/NBA/NCAAM/MLB have no V1 projector, so no feed is pulled
 * for them (documented pass in project-v1).
 */
const LEAGUES = { NFL: 'football/nfl', NCAAF: 'football/college-football' };
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'webet-v1-lock' } });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  return r.json();
}
function teamIdMap(scoreboard) {
  const map = {};
  for (const ev of (scoreboard && scoreboard.events) || []) {
    for (const comp of (ev.competitions || [])) for (const c of (comp.competitors || [])) {
      if (c.team && c.team.id) { map[c.team.displayName] = String(c.team.id); if (c.team.name) map[c.team.name] = String(c.team.id); }
    }
  }
  return map;
}
function lastGamesFromSchedule(schedule, teamId, beforeISO, n) {
  const rows = [];
  for (const ev of (schedule && schedule.events) || []) {
    const comp = ((ev.competitions || [])[0]) || {};
    const status = comp.status && comp.status.type && comp.status.type.completed;
    if (!status) continue;
    if (beforeISO && ev.date && !(ev.date < beforeISO)) continue;
    const mine = (comp.competitors || []).find(c => String(c.team && c.team.id) === String(teamId));
    const opp = (comp.competitors || []).find(c => String(c.team && c.team.id) !== String(teamId));
    if (!mine || !opp) continue;
    const sf = Number(mine.score && (mine.score.value != null ? mine.score.value : mine.score));
    const sa = Number(opp.score && (opp.score.value != null ? opp.score.value : opp.score));
    if (!Number.isFinite(sf) || !Number.isFinite(sa)) continue;
    rows.push({ date: ev.date, opponent: (opp.team && (opp.team.displayName || opp.team.name)) || null,
      scoreFor: sf, scoreAgainst: sa, margin: sf - sa, home: mine.homeAway === 'home' });
  }
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return n ? rows.slice(-n) : rows;
}
function qbRead(injuryRows) {
  // injuryRows: ESPN injury entries for one team.
  const qbs = (injuryRows || []).filter(x => /quarterback|\bQB\b/i.test(String((x.position && (x.position.abbreviation || x.position.name)) || x.position || '')) || /quarterback/i.test(String(x.athlete && x.athlete.position && x.athlete.position.name || '')));
  const flags = (injuryRows || []).map(x => {
    const a = x.athlete || {}; const pos = (a.position && (a.position.abbreviation || a.position.name)) || '';
    return `${a.displayName || a.name || 'player'}${pos ? ` (${pos})` : ''}: ${x.status || x.type || 'listed'}`;
  });
  let confirmed = true; let unknownReplacement = false;
  for (const q of qbs) {
    const st = String(q.status || (q.type && q.type.description) || '').toLowerCase();
    if (/out|doubtful|injured reserve|\bir\b/.test(st)) { confirmed = false; unknownReplacement = true; }
    else if (/questionable/.test(st)) { confirmed = false; }
  }
  return { confirmed, unknownReplacement, qbFlags: qbs.map(q => String((q.athlete && q.athlete.displayName) || 'QB') + ': ' + (q.status || '')), flags };
}
/**
 * Depth-chart QB1 confirmation (Spec §§5,7.4,9): the required starter is the
 * QB1 on the ESPN depth chart. A backup/QB3 listed Out does NOT make the
 * starter unknown — the pre-fix qbRead treated any QB Out as starter-unknown
 * and falsely passed whole games (2026-10-18: 36 of 48 starter passes).
 * QB1 Out/Doubtful/IR -> starter not confirmed; replacement is named on the
 * depth chart but its quality is unproven on this feed, so the game passes
 * per §7.4 (unknown/unproven replacement). QB1 Questionable -> not confirmed.
 * QB1 with no adverse status -> confirmed, regardless of backups.
 * Returns null when no depth chart is available (caller falls back to qbRead).
 */
function depthQb1(depthJson) {
  const charts = (depthJson && depthJson.depthchart) || [];
  for (const dc of charts) {
    const pos = dc && dc.positions && dc.positions.qb;
    const ath = (pos && pos.athletes) || [];
    if (ath.length) return { starter: ath[0].displayName || ath[0].name || null,
      starterInjuries: ath[0].injuries || [],
      replacement: ath.length > 1 ? (ath[1].displayName || ath[1].name || null) : null };
  }
  return null;
}
function qbConfirmFromDepth(depthJson, injuryRows) {
  const d = depthQb1(depthJson);
  if (!d || !d.starter) return null;
  let status = '';
  const di = (d.starterInjuries || [])[0];
  if (di && di.status) status = String(di.status);
  if (!status) {
    const row = (injuryRows || []).find(x => String((x.athlete && (x.athlete.displayName || x.athlete.name)) || '') === d.starter);
    if (row) status = String(row.status || (row.type && row.type.description) || '');
  }
  const st = status.toLowerCase();
  const flags = [`starter ${d.starter}${status ? `: ${status}` : ': no adverse injury status'}${d.replacement ? `; replacement on depth chart: ${d.replacement}` : ''}`];
  if (/out|doubtful|injured reserve|\bir\b/.test(st)) return { confirmed: false, unknownReplacement: true, starter: d.starter, replacement: d.replacement, status, qbFlags: flags };
  if (/questionable/.test(st)) return { confirmed: false, unknownReplacement: false, starter: d.starter, replacement: d.replacement, status, qbFlags: flags };
  return { confirmed: true, unknownReplacement: false, starter: d.starter, replacement: d.replacement, status: status || 'active', qbFlags: flags };
}
async function loadFootballFeedsV1(sport, dateISO, games) {
  const league = LEAGUES[sport]; if (!league) return {};
  const ymd = String(dateISO).replace(/-/g, '');
  const sb = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${ymd}&limit=100`);
  const ids = teamIdMap(sb);
  let injuriesByTeam = {};
  try {
    const inj = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${league}/injuries`);
    for (const t of (inj.injuries || inj.teams || [])) injuriesByTeam[t.displayName || t.name] = t.injuries || t.athletes || [];
  } catch (_) { injuriesByTeam = null; }
  const depthCache = {};
  const depthFor = async (team) => {
    const id = ids[team]; if (!id) return null;
    if (!(id in depthCache)) { try { depthCache[id] = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${id}/depthcharts`); } catch (_) { depthCache[id] = null; } }
    return depthCache[id];
  };
  const schedCache = {};
  const schedFor = async (team) => {
    const id = ids[team]; if (!id) return null;
    if (!(id in schedCache)) { try { schedCache[id] = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${id}/schedule`); } catch (_) { schedCache[id] = null; } }
    return { id, schedule: schedCache[id] };
  };
  const byGame = {};
  for (const g of games || []) {
    const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
    const entry = { last5: null, injuries: null, keyStarter: null, form: null, situational: null, h2h: null };
    const [awayS, homeS] = await Promise.all([schedFor(g.awayTeam), schedFor(g.homeTeam)]);
    if (awayS && homeS && awayS.schedule && homeS.schedule) {
      const a5 = lastGamesFromSchedule(awayS.schedule, awayS.id, g.commenceTime, 5);
      const h5 = lastGamesFromSchedule(homeS.schedule, homeS.id, g.commenceTime, 5);
      const a10 = lastGamesFromSchedule(awayS.schedule, awayS.id, g.commenceTime, 10);
      const h10 = lastGamesFromSchedule(homeS.schedule, homeS.id, g.commenceTime, 10);
      entry.last5 = { away: a5, home: h5 };
      const wf = (rows) => rows.length ? rows.filter(r => r.margin > 0).length / rows.length : null;
      entry.form = { awayLast10WinPct: wf(a10), homeLast10WinPct: wf(h10),
        awayLastGameMargin: a5.length ? a5[a5.length - 1].margin : null,
        homeLastGameMargin: h5.length ? h5[h5.length - 1].margin : null,
        awayLastOpponent: a5.length ? a5[a5.length - 1].opponent : null,
        homeLastOpponent: h5.length ? h5[h5.length - 1].opponent : null };
    }
    if (entry.form) {
      entry.situational = {
        awayDemoralized: entry.form.awayLastGameMargin != null && entry.form.awayLastGameMargin <= -15,
        homeDemoralized: entry.form.homeLastGameMargin != null && entry.form.homeLastGameMargin <= -15,
        awayRevenge: entry.form.awayLastOpponent === g.homeTeam && entry.form.awayLastGameMargin != null && entry.form.awayLastGameMargin < 0,
        homeRevenge: entry.form.homeLastOpponent === g.awayTeam && entry.form.homeLastGameMargin != null && entry.form.homeLastGameMargin < 0,
      };
    }
    if (injuriesByTeam) {
      const aInj = injuriesByTeam[g.awayTeam] || []; const hInj = injuriesByTeam[g.homeTeam] || [];
      const [aDepth, hDepth] = await Promise.all([depthFor(g.awayTeam), depthFor(g.homeTeam)]);
      const aqD = qbConfirmFromDepth(aDepth, aInj); const hqD = qbConfirmFromDepth(hDepth, hInj);
      const aq = aqD || qbRead(aInj); const hq = hqD || qbRead(hInj);
      entry.injuries = { away: aq.flags || qbRead(aInj).flags, home: hq.flags || qbRead(hInj).flags };
      entry.keyStarter = { awayConfirmed: aq.confirmed, homeConfirmed: hq.confirmed,
        unknownReplacement: aq.unknownReplacement || hq.unknownReplacement,
        starterSource: aqD && hqD ? 'espn-depth-chart-qb1' : 'espn-injury-list-fallback',
        note: [...(aq.qbFlags || []).map(x => `away QB ${x}`), ...(hq.qbFlags || []).map(x => `home QB ${x}`)].join('; ') || 'no QB on ESPN injury report for either team' };
    }
    byGame[matchup] = entry;
  }
  return byGame;
}
module.exports = { loadFootballFeedsV1, lastGamesFromSchedule, qbRead, qbConfirmFromDepth, depthQb1, teamIdMap, LEAGUES };
