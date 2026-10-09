#!/usr/bin/env node
// Circa: frozen Saturday final cards, season rollup, stuck-game guard, standings PDF links.
const assert = require("assert");
const season = require("./netlify/functions/lib/circa-season");
const grade = require("./netlify/functions/lib/circa-live-grade");
const standings = require("./netlify/functions/lib/circa-standings");
const { weekBlobKey } = require("./netlify/functions/lib/circa-contest");

let failed = 0;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

function memIo(seed = {}) {
  const m = new Map(Object.entries(seed));
  const writes = [];
  return { m, writes, read: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null), write: async (k, v) => { writes.push(k); m.set(k, JSON.parse(JSON.stringify(v))); return true; } };
}
const W3 = {
  week: "2026-W03", weekNum: 3, generatedAt: "2026-09-26T20:01:19.585Z", sourceUrl: "x.pdf",
  picks: [
    { pick: "Bears +4.5", matchup: "Philadelphia Eagles @ Chicago Bears", homeTeam: "Chicago Bears", awayTeam: "Philadelphia Eagles", commenceTime: "2026-09-29T00:15Z", result: "live", status: "in", awayScore: 0, homeScore: 7 },
    { pick: "Vikings -1", matchup: "Minnesota Vikings @ Tampa Bay Buccaneers", homeTeam: "Tampa Bay Buccaneers", awayTeam: "Minnesota Vikings", commenceTime: "2026-09-27T20:05Z", result: "win", status: "post", awayScore: 23, homeScore: 16 },
    { pick: "Bills -7", matchup: "Los Angeles Chargers @ Buffalo Bills", homeTeam: "Buffalo Bills", awayTeam: "Los Angeles Chargers", commenceTime: "2026-09-27T17:00Z", result: "win", status: "post", awayScore: 16, homeScore: 24 },
    { pick: "49ers -8.5", matchup: "Arizona Cardinals @ San Francisco 49ers", homeTeam: "San Francisco 49ers", awayTeam: "Arizona Cardinals", commenceTime: "2026-09-27T20:05Z", result: "loss", status: "post", awayScore: 30, homeScore: 36 },
    { pick: "Dolphins +11.5", matchup: "Kansas City Chiefs @ Miami Dolphins", homeTeam: "Miami Dolphins", awayTeam: "Kansas City Chiefs", commenceTime: "2026-09-27T17:00Z", result: "loss", status: "post", awayScore: 24, homeScore: 10 },
  ],
};
const bearsFinal = [{ awayTeam: "Philadelphia Eagles", awayAbbr: "PHI", homeTeam: "Chicago Bears", homeAbbr: "CHI", awayScore: 7, homeScore: 27, state: "post", statusName: "STATUS_FINAL", completed: true, startISO: "2026-09-29T00:15Z", detail: "Final" }];
const now = new Date("2026-10-09T18:00:00Z");

check("mergeGames: final beats a stale in-progress copy", () => {
  const inG = { ...bearsFinal[0], state: "in", awayScore: 0, homeScore: 7 };
  const out = grade.mergeGames([[bearsFinal[0]], [inG]]);
  assert.strictEqual(out[0].state, "post");
  const out2 = grade.mergeGames([[inG], [bearsFinal[0]]]);
  assert.strictEqual(out2[0].state, "post");
});

check("backfill freezes week card after deadline; Week 3 corrected to 3-2 / 3 pts", async () => {
  const io = memIo({ [weekBlobKey(3)]: W3 });
  const { frozen, created } = await season.ensureFrozen(io, 3, { now });
  assert.ok(created && frozen.inFinalWindow && !frozen.uncertain, JSON.stringify(frozen.uncertaintyNotes));
  const g = await season.gradeFrozenWeek(io, frozen, { now, fetchScores: async () => bearsFinal });
  assert.strictEqual(g.stats.points, 3);
  assert.strictEqual(g.stats.record, "3W-2L-0P");
  assert.strictEqual(g.stuck.length, 0);
});

check("frozen card is immutable: later refresh never overwrites", async () => {
  const io = memIo({ [weekBlobKey(3)]: W3 });
  await season.ensureFrozen(io, 3, { now });
  const changed = { ...W3, generatedAt: "2026-09-27T01:00:00Z", picks: W3.picks.map((p) => ({ ...p, pick: "Other +1" })) };
  io.m.set(weekBlobKey(3), changed);
  const r = await season.ensureFrozen(io, 3, { now, candidate: changed });
  assert.strictEqual(r.created, false);
  assert.strictEqual(r.frozen.picks[0].pick, "Bears +4.5");
  assert.strictEqual(io.writes.filter((k) => k === season.frozenKey(3)).length, 1);
});

check("no freeze before deadline without the Saturday final candidate", async () => {
  const io = memIo({ [weekBlobKey(5)]: { ...W3, weekNum: 5 } });
  const r = await season.ensureFrozen(io, 5, { now: new Date("2026-10-09T18:00:00Z") });
  assert.strictEqual(r.frozen, null);
  const r2 = await season.ensureFrozen(io, 5, { now: new Date("2026-10-10T20:02:00Z"), candidate: { ...W3, weekNum: 5, generatedAt: "2026-10-10T20:01:00Z" } });
  assert.ok(r2.created && r2.frozen.inFinalWindow);
});

check("stuck game (not final 6h after kickoff) raises an alert", async () => {
  const io = memIo({ [weekBlobKey(3)]: W3 });
  const s = await season.buildSeason(io, { currentWeekNum: 3, now, fetchScores: async () => [{ ...bearsFinal[0], state: "in", awayScore: 0, homeScore: 7 }] });
  assert.strictEqual(s.alerts.length, 1);
  assert.strictEqual(s.alerts[0].pick, "Bears +4.5");
  await season.writeStuckAlert(io, s.alerts, now);
  assert.ok(io.m.get(season.STUCK_ALERT_KEY));
});

check("season total sums frozen weeks only (win 1 / push .5 / loss 0)", async () => {
  const W4 = { ...W3, week: "2026-W04", weekNum: 4, generatedAt: "2026-10-03T20:01:10Z", picks: W3.picks.map((p, i) => ({ ...p, commenceTime: "2026-10-04T17:00Z", result: ["win", "loss", "win", "win", "push"][i], status: "post", awayScore: 1, homeScore: 1 })) };
  const io = memIo({ [weekBlobKey(3)]: W3, [weekBlobKey(4)]: W4, [weekBlobKey(5)]: { ...W3, weekNum: 5, picks: W3.picks.map((p) => ({ ...p, result: "pending", commenceTime: "2026-10-11T17:00Z" })) } });
  const s = await season.buildSeason(io, { currentWeekNum: 5, now, fetchScores: async () => bearsFinal });
  assert.strictEqual(s.seasonTotal.points, 6.5);
  assert.strictEqual(s.seasonTotal.record, "6-3-1");
  const w5 = s.weeks.find((w) => w.weekNum === 5);
  assert.ok(!w5.frozen);
});

check("standings: newest 'After Week N' wins; titles decoded", () => {
  const mk = (id, title, url, date) => ({ id, title: { rendered: title }, source_url: url, date });
  const r = standings.pickLatestPdfs([
    mk(1, "Circa Sports Million VIII &#8211; Full Season &#038; 1st Quarter Standings After Week 3", "https://x/Week-3.pdf", "2026-09-29"),
    mk(2, "Circa Sports Million VIII &#8211; Full Season Standings &#038; 1st Quarter Winners After Week 4", "https://x/S-After-Week-4.pdf", "2026-10-06"),
    mk(3, "Circa Sports Million VIII &#8211; Full Season Last Place Standings &#038; 1st Quarter Winner After Week 4", "https://x/L-After-Week-4.pdf", "2026-10-06"),
    mk(4, "Circa Sports Million VIII &#8211; Full Season Last Place Booby Prize Leaders After Week 3", "https://x/L3.pdf", "2026-10-07"),
  ]);
  assert.strictEqual(r.season.week, 4);
  assert.strictEqual(r.lastPlace.url, "https://x/L-After-Week-4.pdf");
  assert.strictEqual(r.season.title, "Circa Sports Million VIII – Full Season Standings & 1st Quarter Winners After Week 4");
});

check("standings: unverifiable new URL keeps the last good PDF", async () => {
  const io = memIo({ [standings.PDF_LINKS_KEY]: { season: { url: "https://x/S4.pdf", week: 4, title: "S4" }, lastPlace: { url: "https://x/L4.pdf", week: 4, title: "L4" } } });
  const r = await standings.resolveStandingsPdfs({
    readBlob: io.read, writeBlob: io.write,
    discover: async () => ({ season: { url: "https://x/S5.pdf", week: 5, title: "S5" }, lastPlace: { url: "https://x/L5.pdf", week: 5, title: "L5" } }),
    verify: async (u) => u.endsWith("S5.pdf"),
  });
  assert.strictEqual(r.season.url, "https://x/S5.pdf");
  assert.strictEqual(r.lastPlace.url, "https://x/L4.pdf");
  const r2 = await standings.resolveStandingsPdfs({ readBlob: io.read, writeBlob: io.write, discover: async () => { throw new Error("down"); } });
  assert.strictEqual(r2.season.url, "https://x/S5.pdf");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok  " + name); } catch (e) { failed++; console.log("  FAIL " + name + ": " + e.message); }
  }
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall circa frozen-season checks passed");
})();
