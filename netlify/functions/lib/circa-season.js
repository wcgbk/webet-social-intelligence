// Circa Million VIII — frozen weekly final cards + season rollup (ops/display).
//
// The Saturday ~1:00 PM PT refresh (before the 4:00 PM PT deadline) is the card
// WeBet submits. It is stored once per week as an immutable snapshot:
//   frozen-card-<year>-Wnn   (written once, NEVER overwritten)
//   frozen-grade-<year>-Wnn  (ESPN results for that frozen card; re-polled until final)
// Weekly KPIs, points and the season total are graded ONLY from frozen cards.
// Scoring: win 1, push 0.5, loss 0 (Circa rules 6–7).
//
// Stuck-game guard: every non-final pick is re-polled on each read/regrade, and a
// pick still not final 6h after kickoff raises circa-ops/stuck-game-alert.

"use strict";

const {
  CONTEST,
  weekKey,
  weekBlobKey,
  saturdayDeadline,
  instantFromZoned,
  weekSaturdayYmd,
  defaultKpis,
} = require("./circa-contest");
const { gradeCircaPayload, weekRecord, FINAL } = require("./circa-live-grade");

const STUCK_AFTER_MS = 6 * 3600 * 1000;
const STUCK_ALERT_KEY = "circa-ops/stuck-game-alert";
const FROZEN_SCHEMA = "circa-frozen-card/v1";

function frozenKey(weekNum) {
  return `frozen-card-${weekKey(weekNum)}`;
}
function frozenGradeKey(weekNum) {
  return `frozen-grade-${weekKey(weekNum)}`;
}

// Saturday final refresh window: 12:30 PM – 4:00 PM PT on the week's Saturday.
function finalWindow(weekNum) {
  return {
    start: instantFromZoned(weekSaturdayYmd(weekNum), 12, 30, "America/Los_Angeles"),
    end: saturdayDeadline(weekNum),
  };
}

function ptLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " PT";
}

function pickKey(p) {
  return `${p && p.pick}||${p && p.matchup}`;
}

const IDENTITY_FIELDS = [
  "sport", "betType", "pick", "matchup", "homeTeam", "awayTeam", "venue", "commenceTime",
  "contestLine", "circaSpread", "contestId", "lineSource", "sourceUrl", "coverProb",
  "rating", "confidence", "earlyKickoff",
];

function hasLivePicks(card) {
  return !!(card && Array.isArray(card.picks) && card.picks.length > 0 && card.preview !== true);
}

function buildFrozenCard(card, weekNum, { sourceKey, via, now = new Date() } = {}) {
  const win = finalWindow(weekNum);
  const gen = card.generatedAt ? new Date(card.generatedAt) : null;
  const notes = [];
  let inFinalWindow = false;
  if (!gen || isNaN(gen.getTime())) {
    notes.push("source card has no generatedAt timestamp");
  } else {
    inFinalWindow = gen >= win.start && gen < win.end;
    if (gen >= win.end) notes.push(`source card generated ${ptLabel(gen.toISOString())}, after the Sat 4:00 PM PT deadline (possible forced regeneration)`);
    else if (!inFinalWindow) notes.push(`source card generated ${ptLabel(gen.toISOString())}, before the Sat ~1:00 PM PT final refresh (final run may have been skipped)`);
  }
  if (card.picks.length !== 5) notes.push(`card has ${card.picks.length} pick(s), expected 5`);
  return {
    schema: FROZEN_SCHEMA,
    immutable: true,
    contest: CONTEST.name,
    week: weekKey(weekNum),
    weekNum,
    frozenAt: now.toISOString(),
    frozenVia: via || "unknown",
    sourceKey: sourceKey || weekBlobKey(weekNum),
    sourceGeneratedAt: card.generatedAt || null,
    sourceGeneratedAtPT: ptLabel(card.generatedAt),
    inFinalWindow,
    uncertain: notes.length > 0,
    uncertaintyNotes: notes,
    contestPdfUrl: card.sourceUrl || null,
    modelVersion: card.modelVersion || card.model || null,
    picks: card.picks.map((p) => {
      const o = {};
      for (const f of IDENTITY_FIELDS) if (p[f] !== undefined) o[f] = p[f];
      return o;
    }),
  };
}

/**
 * Return the frozen card for weekNum, creating it once if allowed.
 * - candidate: the Saturday final card just stored by the generator (slot "final").
 * - otherwise, after the Sat 4 PM PT deadline, freeze the stored week card (backfill).
 * Never overwrites an existing frozen card.
 */
async function ensureFrozen(io, weekNum, { now = new Date(), candidate = null, via } = {}) {
  const key = frozenKey(weekNum);
  const existing = await io.read(key);
  if (existing && Array.isArray(existing.picks) && existing.picks.length) {
    return { frozen: existing, created: false };
  }
  const deadline = saturdayDeadline(weekNum);
  let card = candidate;
  if (card) {
    if (now >= deadline) return { frozen: null, created: false, reason: "candidate-after-deadline" };
  } else {
    if (now < deadline) return { frozen: null, created: false, reason: "before-deadline" };
    card = await io.read(weekBlobKey(weekNum));
  }
  if (!hasLivePicks(card)) return { frozen: null, created: false, reason: "no-card" };
  const frozen = buildFrozenCard(card, weekNum, {
    sourceKey: weekBlobKey(weekNum),
    via: via || (candidate ? "generator-saturday-final" : "backfill-from-week-card"),
    now,
  });
  // Re-check immediately before the one-time write (no overwrite on races).
  const again = await io.read(key);
  if (again && Array.isArray(again.picks) && again.picks.length) return { frozen: again, created: false };
  const ok = await io.write(key, frozen);
  return { frozen, created: !!ok };
}

function resultFields(p) {
  const o = {};
  for (const f of ["result", "status", "statusName", "detail", "awayScore", "homeScore", "finalScore", "contestPoints", "settledAt"]) {
    if (p[f] !== undefined && p[f] !== null) o[f] = p[f];
  }
  return o;
}

function stuckPicks(picks, now = new Date()) {
  return (picks || []).filter((p) => {
    const r = String((p && p.result) || "pending").toLowerCase();
    if (FINAL.has(r)) return false;
    const t = p.commenceTime ? Date.parse(p.commenceTime) : NaN;
    return !isNaN(t) && now.getTime() - t >= STUCK_AFTER_MS;
  });
}

/** Grade a frozen card (re-poll ESPN for anything not final). Picks identity never changes. */
async function gradeFrozenWeek(io, frozen, { now = new Date(), fetchScores } = {}) {
  const weekNum = frozen.weekNum;
  const gKey = frozenGradeKey(weekNum);
  const prev = (await io.read(gKey)) || {};
  let seedPicks = (prev && prev.picks) || [];
  if (!seedPicks.length) {
    // First grade: seed from results already on the stored week card (same picks).
    const wk = await io.read(frozen.sourceKey || weekBlobKey(weekNum));
    seedPicks = (wk && Array.isArray(wk.picks)) ? wk.picks : [];
  }
  const prevByKey = new Map(seedPicks.map((p) => [pickKey(p), p]));
  const merged = frozen.picks.map((p) => ({ ...p, ...resultFields(prevByKey.get(pickKey(p)) || {}) }));
  const needs = merged.some((p) => !FINAL.has(String(p.result || "").toLowerCase()) || (p.awayScore == null && p.homeScore == null));
  let picks = merged;
  if (needs) {
    try {
      const g = await gradeCircaPayload({ weekNum, picks: merged }, fetchScores ? { fetchScores } : {});
      picks = g.picks;
    } catch (e) {
      console.error(`[circa-season] W${weekNum} ESPN regrade failed: ${e.message}`);
    }
  }
  const stats = weekRecord(picks);
  const sig = (list) => list.map((p) => [pickKey(p), p.result, p.awayScore, p.homeScore, p.status].join("|")).join(";");
  if (!prev.picks || sig(prev.picks) !== sig(picks)) {
    await io.write(gKey, {
      week: frozen.week,
      weekNum,
      frozenKey: frozenKey(weekNum),
      gradedAt: now.toISOString(),
      stats,
      picks: picks.map((p) => ({ pick: p.pick, matchup: p.matchup, commenceTime: p.commenceTime, ...resultFields(p) })),
    });
  }
  return { weekNum, picks, stats, stuck: stuckPicks(picks, now) };
}

function frozenMeta(frozen) {
  return {
    key: frozenKey(frozen.weekNum),
    frozenAt: frozen.frozenAt,
    frozenVia: frozen.frozenVia,
    sourceKey: frozen.sourceKey,
    sourceGeneratedAt: frozen.sourceGeneratedAt,
    sourceGeneratedAtPT: frozen.sourceGeneratedAtPT,
    inFinalWindow: !!frozen.inFinalWindow,
    uncertain: !!frozen.uncertain,
    uncertaintyNotes: frozen.uncertaintyNotes || [],
    contestPdfUrl: frozen.contestPdfUrl || null,
  };
}

function summaryPick(p) {
  return {
    pick: p.pick,
    matchup: p.matchup,
    result: p.result || "pending",
    commenceTime: p.commenceTime || "",
    awayScore: p.awayScore,
    homeScore: p.homeScore,
    status: p.status || null,
    finalScore: p.finalScore || null,
    contestPoints: p.contestPoints,
  };
}

/**
 * Build the season view: weeks 1..currentWeekNum graded from frozen cards.
 * Returns { weeks, kpis, seasonTotal, alerts }. The current week before its
 * deadline shows the live (not yet frozen) card as provisional and is NOT counted.
 */
async function buildSeason(io, { currentWeekNum, currentCard, baseWeeks, now = new Date(), fetchScores, maxWeek } = {}) {
  const last = Math.min(CONTEST.totalWeeks, maxWeek || currentWeekNum || 1);
  const rows = Array.isArray(baseWeeks) ? baseWeeks.map((w) => ({ ...w })) : [];
  const rowFor = (n) => {
    let r = rows.find((w) => Number(w.weekNum) === n || new RegExp(`^week\\s*${n}$`, "i").test(String(w.label || "")));
    if (!r) { r = { label: `Week ${n}`, current: n === currentWeekNum }; rows.push(r); }
    r.weekNum = n;
    return r;
  };
  const kpis = defaultKpis();
  const alerts = [];
  const byWeek = [];
  const results = await Promise.all(Array.from({ length: last }, (_, i) => i + 1).map(async (n) => {
    try {
      const { frozen } = await ensureFrozen(io, n, { now });
      if (!frozen) return { n, frozen: null };
      const graded = await gradeFrozenWeek(io, frozen, { now, fetchScores });
      return { n, frozen, graded };
    } catch (e) {
      console.error(`[circa-season] W${n} failed: ${e.message}`);
      return { n, frozen: null, error: e.message };
    }
  }));
  for (const { n, frozen, graded } of results) {
    const row = rowFor(n);
    if (!frozen) {
      row.frozen = null;
      if (n === currentWeekNum && hasLivePicks(currentCard)) row.provisional = true;
      continue;
    }
    const s = graded.stats;
    row.frozen = frozenMeta(frozen);
    row.provisional = false;
    row.picks = graded.picks.map(summaryPick);
    row.status = s.status;
    row.points = s.graded > 0 || s.live > 0 ? s.points : null;
    row.record = `${s.wins}W-${s.losses}L-${s.pushes}P`;
    row.rate = s.decided > 0 ? `${Math.round((s.wins / s.decided) * 100)}%` : "--";
    if (s.graded > 0) {
      kpis.points += s.points;
      kpis.wins += s.wins;
      kpis.losses += s.losses;
      kpis.pushes += s.pushes;
      kpis.weeksPlayed += 1;
    }
    byWeek.push({ weekNum: n, points: s.points, record: row.record, status: s.status, uncertain: !!frozen.uncertain });
    for (const p of graded.stuck) {
      alerts.push({
        type: "circa-game-not-final-6h",
        weekNum: n,
        pick: p.pick,
        matchup: p.matchup,
        commenceTime: p.commenceTime,
        result: p.result || "pending",
        status: p.status || null,
        score: p.awayScore != null ? `${p.awayScore}-${p.homeScore}` : null,
      });
    }
  }
  kpis.points = Math.round(kpis.points * 10) / 10;
  kpis.totalWeeks = CONTEST.totalWeeks;
  const seasonTotal = {
    points: kpis.points,
    wins: kpis.wins,
    losses: kpis.losses,
    pushes: kpis.pushes,
    record: `${kpis.wins}-${kpis.losses}-${kpis.pushes}`,
    weeksGraded: kpis.weeksPlayed,
    source: "frozen-final-cards",
    byWeek,
  };
  rows.sort((a, b) => (Number(a.weekNum) || 99) - (Number(b.weekNum) || 99));
  return { weeks: rows, kpis, seasonTotal, alerts };
}

async function writeStuckAlert(io, alerts, now = new Date()) {
  if (!alerts || !alerts.length) return false;
  const payload = { ok: false, status: "stuck-game", alerts, checkedAt: now.toISOString(), opsOnly: true };
  console.error(`[circa-season] ALERT ${alerts.length} Circa pick(s) not final 6h after kickoff: ${alerts.map((a) => `W${a.weekNum} ${a.pick}`).join(", ")}`);
  await io.write(STUCK_ALERT_KEY, payload);
  return true;
}

module.exports = {
  FROZEN_SCHEMA,
  STUCK_AFTER_MS,
  STUCK_ALERT_KEY,
  frozenKey,
  frozenGradeKey,
  finalWindow,
  buildFrozenCard,
  ensureFrozen,
  gradeFrozenWeek,
  stuckPicks,
  buildSeason,
  writeStuckAlert,
  ptLabel,
};
