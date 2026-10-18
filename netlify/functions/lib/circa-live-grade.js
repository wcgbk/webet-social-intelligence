// Circa Million VIII — ESPN NFL ATS grading + weekend KPI rollup.
// Used by get-picks-circa on read so /circa KPIs persist in edge-picks-circa.
// Contest scoring: 1 pt cover, 0.5 push, 0 miss. No juice. Grade vs the Circa
// number embedded in pick (e.g. "Steelers -3.5"), never a live sportsbook line.
//
// result: win | loss | push | live | pending
// Never invent scores — ESPN scoreboard only (lib/espn-scoreboard.js).

const { fetchESPNScores } = require("./espn-scoreboard");
const { defaultKpis, CONTEST } = require("./circa-contest");
const { resolveDoubleheader } = require("../../../js/live-score");

const FINAL = new Set(["win", "loss", "push"]);

function etDateFromISO(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch (e) {
    return null;
  }
}

function uniqueEtDates(picks) {
  const dates = new Set();
  for (const p of picks || []) {
    const et = etDateFromISO(p && p.commenceTime);
    if (et) dates.add(et);
  }
  return [...dates];
}

function normalizeTeam(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function teamsMatch(pickTeam, espnTeam, espnAbbr) {
  const p = normalizeTeam(pickTeam);
  const e = normalizeTeam(espnTeam);
  if (!p || !e) return false;
  if (p === e) return true;
  if (p.includes(e) || e.includes(p)) return true;
  if (espnAbbr && espnAbbr.length >= 2) {
    const a = espnAbbr.toLowerCase();
    const pWords = p.split(" ");
    if (pWords.includes(a)) return true;
  }
  const pLast = p.split(" ").pop();
  const eLast = e.split(" ").pop();
  if (pLast.length > 2 && pLast === eLast) return true;
  return false;
}

function parseContestPick(pickStr) {
  const s = String(pickStr || "").trim();
  const m = s.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const spread = parseFloat(m[2]);
  if (!Number.isFinite(spread)) return null;
  return { team: m[1].trim(), spread };
}

function contestPoints(result) {
  if (result === "win") return 1;
  if (result === "push") return 0.5;
  if (result === "loss") return 0;
  return null;
}

function mergeGames(lists) {
  const map = new Map();
  const key = (g) =>
    `${(g.awayAbbr || g.awayTeam || "").toLowerCase()}|${(g.homeAbbr || g.homeTeam || "").toLowerCase()}|${g.startISO || ""}`;
  const rank = (g) => (g.state === "in" ? 3 : g.state === "post" ? 2 : 1);
  for (const list of lists) {
    for (const g of list || []) {
      const k = key(g);
      const prev = map.get(k);
      if (!prev || rank(g) > rank(prev)) map.set(k, g);
    }
  }
  return [...map.values()];
}

function gameMatchesPickWindow(game, pick) {
  const gStart = game && game.startISO ? Date.parse(game.startISO) : NaN;
  const pStart = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
  if (!isNaN(gStart) && !isNaN(pStart) && Math.abs(gStart - pStart) > 10 * 3600 * 1000) return false;
  return true;
}

function disambiguate(matches, pick) {
  return resolveDoubleheader(matches, pick);
}

function findGame(pick, games) {
  const pool = (games || []).filter((g) => gameMatchesPickWindow(g, pick));
  if (pick.homeTeam && pick.awayTeam) {
    const structured = pool.filter(
      (g) =>
        teamsMatch(pick.awayTeam, g.awayTeam, g.awayAbbr) &&
        teamsMatch(pick.homeTeam, g.homeTeam, g.homeAbbr)
    );
    if (structured.length) return disambiguate(structured, pick);
  }

  const matchup = (pick.matchup || "").toLowerCase();
  const matchupParts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map((s) => s.trim()).filter(Boolean);
  const primary = [];
  for (const g of pool) {
    const awayLast = normalizeTeam(g.awayTeam).split(" ").pop();
    const homeLast = normalizeTeam(g.homeTeam).split(" ").pop();
    const awayMatch =
      matchupParts.some((part) => teamsMatch(part, g.awayTeam, g.awayAbbr)) ||
      (awayLast.length > 3 && matchup.includes(awayLast));
    const homeMatch =
      matchupParts.some((part) => teamsMatch(part, g.homeTeam, g.homeAbbr)) ||
      (homeLast.length > 3 && matchup.includes(homeLast));
    if (awayMatch && homeMatch) primary.push(g);
  }
  if (primary.length) return disambiguate(primary, pick);

  const parsed = parseContestPick(pick.pick);
  const pickTeam = (parsed && parsed.team) ||
    String(pick.pick || "").replace(/[+-]\d.*$/, "").trim();
  if (pickTeam) {
    const secondary = [];
    for (const g of pool) {
      if (teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) || teamsMatch(pickTeam, g.homeTeam, g.homeAbbr)) {
        const otherLast = normalizeTeam(
          teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) ? g.homeTeam : g.awayTeam
        ).split(" ").pop();
        if (otherLast.length > 3 && matchup.includes(otherLast)) secondary.push(g);
      }
    }
    if (secondary.length) return disambiguate(secondary, pick);
  }
  return null;
}

function gradeAts(pick, game) {
  if (!game) return { result: "pending" };
  if (game.state === "pre") return { result: "pending", status: "pre" };
  if (game.state === "in") {
    return {
      result: "live",
      status: "in",
      awayScore: game.awayScore,
      homeScore: game.homeScore,
      statusName: game.statusName || "",
      detail: game.detail || "",
    };
  }
  if (game.state !== "post") return { result: "pending" };

  if (/POSTPONED|CANCELL?ED/i.test(game.statusName || "") || (game.state === "post" && game.completed === false)) {
    return {
      result: "push",
      status: "post",
      awayScore: game.awayScore,
      homeScore: game.homeScore,
      statusName: game.statusName || "STATUS_POSTPONED",
      detail: game.detail || "PPD",
      finalScore: "PPD",
    };
  }

  const parsed = parseContestPick(pick.pick);
  const pickTeam = (parsed && parsed.team) || "";
  const spread = parsed ? parsed.spread : NaN;
  const pickedAway = teamsMatch(pickTeam, game.awayTeam, game.awayAbbr);
  const pickedHome = teamsMatch(pickTeam, game.homeTeam, game.homeAbbr);
  if (!Number.isFinite(spread) || (!pickedAway && !pickedHome)) {
    return {
      result: "pending",
      status: "post",
      awayScore: game.awayScore,
      homeScore: game.homeScore,
      statusName: game.statusName || "",
      detail: game.detail || "",
      finalScore: `${game.awayScore}-${game.homeScore}`,
    };
  }

  const pickedScore = pickedAway ? game.awayScore : game.homeScore;
  const oppScore = pickedAway ? game.homeScore : game.awayScore;
  const adjusted = pickedScore + spread;
  let result;
  if (adjusted === oppScore) result = "push";
  else result = adjusted > oppScore ? "win" : "loss";

  return {
    result,
    status: "post",
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    statusName: game.statusName || "",
    detail: game.detail || "Final",
    finalScore: `${game.awayScore}-${game.homeScore}`,
    contestPoints: contestPoints(result),
  };
}

// Prefer ESPN post/in over a stored pending. Never un-finalize a stored
// win/loss/push just because the scoreboard fetch missed.
function resolveResult(prevResult, next) {
  const prev = String(prevResult || "pending").toLowerCase();
  const nxt = String((next && next.result) || "pending").toLowerCase();
  if (nxt === "pending" && prev && prev !== "pending") {
    return { ...next, result: prev, keptPrior: true };
  }
  if (FINAL.has(prev) && nxt === "live") {
    return { ...next, result: prev, keptPrior: true };
  }
  return { ...next, result: nxt };
}

function applyGradeToPick(pick, graded) {
  const out = { ...pick };
  const resolved = resolveResult(pick.result, graded);
  out.result = resolved.result;
  if (resolved.awayScore != null) out.awayScore = resolved.awayScore;
  if (resolved.homeScore != null) out.homeScore = resolved.homeScore;
  if (resolved.status) out.status = resolved.status;
  if (resolved.statusName) out.statusName = resolved.statusName;
  if (resolved.detail) out.detail = resolved.detail;
  if (resolved.finalScore) out.finalScore = resolved.finalScore;
  const pts = contestPoints(out.result);
  if (pts != null) {
    out.contestPoints = pts;
    if (!out.settledAt && FINAL.has(out.result)) out.settledAt = new Date().toISOString();
  }
  return out;
}

function weekRecord(picks) {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let live = 0;
  let pending = 0;
  for (const p of picks || []) {
    const r = String((p && p.result) || "pending").toLowerCase();
    if (r === "win") wins++;
    else if (r === "loss") losses++;
    else if (r === "push") pushes++;
    else if (r === "live") live++;
    else pending++;
  }
  const points = wins * 1 + pushes * 0.5;
  const decided = wins + losses;
  const graded = wins + losses + pushes;
  let status = "pending";
  if (live > 0 || (graded > 0 && pending > 0)) status = "live";
  else if (pending === 0 && (picks || []).length > 0 && live === 0) status = "completed";
  else if (graded > 0) status = "live";
  return {
    wins,
    losses,
    pushes,
    live,
    pending,
    points,
    decided,
    graded,
    status,
    record: `${wins}W-${losses}L-${pushes}P`,
    rate: decided > 0 ? `${Math.round((wins / decided) * 100)}%` : "--",
  };
}

function weekNumOf(wk) {
  if (!wk) return null;
  if (wk.weekNum != null && Number.isFinite(Number(wk.weekNum))) return Number(wk.weekNum);
  const m = String(wk.label || "").match(/week\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function pickSummary(p) {
  return {
    pick: p.pick,
    matchup: p.matchup,
    result: p.result,
    commenceTime: p.commenceTime || "",
    awayScore: p.awayScore,
    homeScore: p.homeScore,
    status: p.status || null,
    finalScore: p.finalScore || null,
    contestPoints: p.contestPoints,
  };
}

function updateWeekRow(weeks, weekNum, picks) {
  const list = Array.isArray(weeks) && weeks.length ? weeks.map((w) => ({ ...w })) : [];
  const stats = weekRecord(picks);
  let row = list.find((w) => weekNumOf(w) === weekNum || (w.current && weekNum == null));
  if (!row) {
    row = { label: `Week ${weekNum}`, current: true };
    list.push(row);
  }
  row.weekNum = weekNum || row.weekNum;
  row.status = stats.status;
  row.points = stats.graded > 0 || stats.live > 0 ? stats.points : row.points;
  if (stats.graded > 0 || stats.live > 0 || stats.status === "completed") {
    row.record = stats.record;
    row.rate = stats.rate;
  }
  if (Array.isArray(picks) && picks.length) row.picks = picks.map(pickSummary);
  return { weeks: list, stats };
}

function recomputeKpis(weeks, fallbackPicks, currentWeekNum) {
  const kpis = defaultKpis();
  const list = Array.isArray(weeks) ? weeks : [];
  let counted = 0;
  for (const wk of list) {
    const n = weekNumOf(wk);
    const rowPicks = Array.isArray(wk.picks) && wk.picks.length
      ? wk.picks
      : (wk.current || n === currentWeekNum ? fallbackPicks : []);
    const stats = weekRecord(rowPicks);
    if (stats.graded > 0) {
      kpis.points += stats.points;
      kpis.wins += stats.wins;
      kpis.losses += stats.losses;
      kpis.pushes += stats.pushes;
      kpis.weeksPlayed += 1;
      counted++;
      continue;
    }
    const rec = String(wk.record || "").replace(/\s+/g, "").toUpperCase();
    const placeholder = !rec || rec === "0W-0L" || rec === "0-0" || rec === "0W-0L-0P" || rec === "0-0-0";
    if (wk.points != null && !placeholder) {
      kpis.points += Number(wk.points) || 0;
      const m = String(wk.record || "").match(/(\d+)\s*W\s*-\s*(\d+)\s*L(?:\s*-\s*(\d+)\s*P)?/i);
      if (m) {
        kpis.wins += Number(m[1]) || 0;
        kpis.losses += Number(m[2]) || 0;
        kpis.pushes += Number(m[3]) || 0;
      }
      kpis.weeksPlayed += 1;
      counted++;
    }
  }
  if (!counted && fallbackPicks && fallbackPicks.length) {
    const stats = weekRecord(fallbackPicks);
    if (stats.graded > 0) {
      kpis.points += stats.points;
      kpis.wins += stats.wins;
      kpis.losses += stats.losses;
      kpis.pushes += stats.pushes;
      kpis.weeksPlayed += 1;
    }
  }
  kpis.totalWeeks = CONTEST.totalWeeks;
  kpis.points = Math.round(kpis.points * 10) / 10;
  return kpis;
}

function anyPickLive(picks) {
  return (picks || []).some((p) => String((p && p.result) || "").toLowerCase() === "live");
}

function cacheControlFor(payload) {
  const picks = (payload && payload.picks) || [];
  const now = Date.now();
  for (const p of picks) {
    const r = String((p && p.result) || "").toLowerCase();
    if (r === "live") return "public, max-age=30, s-maxage=30, must-revalidate";
    if (r === "pending" || !r) {
      const t = p.commenceTime ? Date.parse(p.commenceTime) : NaN;
      if (!isNaN(t) && t <= now) return "public, max-age=30, s-maxage=30, must-revalidate";
    }
  }
  return "public, max-age=120, s-maxage=120, stale-while-revalidate=600";
}

function gradeChanged(beforePicks, afterPicks, beforeKpis, afterKpis, beforeWeeks, afterWeeks) {
  const sig = (picks) => (picks || []).map((p) =>
    [p.pick, p.result, p.awayScore, p.homeScore, p.status, p.finalScore].join("|")
  ).join(";");
  if (sig(beforePicks) !== sig(afterPicks)) return true;
  const k = (x) => JSON.stringify({
    points: (x && x.points) || 0,
    wins: (x && x.wins) || 0,
    losses: (x && x.losses) || 0,
    pushes: (x && x.pushes) || 0,
    weeksPlayed: (x && x.weeksPlayed) || 0,
  });
  if (k(beforeKpis) !== k(afterKpis)) return true;
  const wsig = (weeks) => (weeks || []).map((w) =>
    [w.label, w.status, w.points, w.record, w.rate].join("|")
  ).join(";");
  return wsig(beforeWeeks) !== wsig(afterWeeks);
}

async function fetchNflScoresForPicks(picks, fetchScores) {
  if (typeof fetchScores === "function") return fetchScores(picks) || [];
  const dates = uniqueEtDates(picks);
  if (!dates.length) return [];
  const lists = await Promise.all(dates.map((d) => fetchESPNScores(d, "NFL")));
  return mergeGames(lists);
}

function needsEspnFetch(picks, opts) {
  if (opts && opts.fetchScores) return true;
  return (picks || []).some((p) => {
    const r = String((p && p.result) || "").toLowerCase();
    if (!FINAL.has(r)) return true;
    if (p.awayScore == null && p.homeScore == null && !p.finalScore) return true;
    return false;
  });
}

async function gradeCircaPayload(payload, opts = {}) {
  if (!payload || !Array.isArray(payload.picks) || payload.picks.length === 0) return payload;
  const beforePicks = payload.picks;
  const fetchEspn = needsEspnFetch(beforePicks, opts);
  const games = fetchEspn ? await fetchNflScoresForPicks(beforePicks, opts.fetchScores) : [];
  const gradedPicks = fetchEspn
    ? beforePicks.map((p) => applyGradeToPick(p, gradeAts(p, findGame(p, games))))
    : beforePicks.map((p) => ({ ...p }));
  const weekNum = payload.weekNum || null;
  const { weeks, stats } = updateWeekRow(payload.weeks, weekNum, gradedPicks);
  const kpis = recomputeKpis(weeks, gradedPicks, weekNum);
  return {
    ...payload,
    picks: gradedPicks,
    weeks,
    kpis,
    _grade: { stats, changed: gradeChanged(beforePicks, gradedPicks, payload.kpis, kpis, payload.weeks, weeks) },
  };
}

// Patch only result/score fields + kpis/weeks onto an existing live card.
function mergeGradeIntoCard(existing, graded) {
  if (!existing || !Array.isArray(existing.picks) || existing.picks.length === 0) return existing;
  if (!graded || !Array.isArray(graded.picks)) return existing;
  const byKey = new Map(graded.picks.map((p) => [`${p.pick}||${p.matchup}`, p]));
  const picks = existing.picks.map((p) => {
    const g = byKey.get(`${p.pick}||${p.matchup}`);
    if (!g) return p;
    const next = { ...p };
    next.result = g.result;
    if (g.awayScore != null) next.awayScore = g.awayScore;
    if (g.homeScore != null) next.homeScore = g.homeScore;
    if (g.status) next.status = g.status;
    if (g.statusName) next.statusName = g.statusName;
    if (g.detail) next.detail = g.detail;
    if (g.finalScore) next.finalScore = g.finalScore;
    if (g.contestPoints != null) next.contestPoints = g.contestPoints;
    if (g.settledAt) next.settledAt = g.settledAt;
    return next;
  });
  return {
    ...existing,
    picks,
    kpis: graded.kpis || existing.kpis,
    weeks: graded.weeks || existing.weeks,
  };
}

module.exports = {
  parseContestPick,
  teamsMatch,
  findGame,
  gradeAts,
  applyGradeToPick,
  weekRecord,
  updateWeekRow,
  recomputeKpis,
  anyPickLive,
  cacheControlFor,
  gradeChanged,
  gradeCircaPayload,
  mergeGradeIntoCard,
  contestPoints,
  uniqueEtDates,
  mergeGames,
  needsEspnFetch,
};
