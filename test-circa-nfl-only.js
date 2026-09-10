#!/usr/bin/env node
// Smoke checks for Circa Million VIII: NFL-only page + weekly ATS pipeline.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const {
  CONTEST,
  parseWeekQuery,
  resolveContestWeek,
  weekKey,
  weekBlobKey,
  pendingPayload,
  selectCircaCard,
  isEarlyKickoff,
  gameAlreadyStarted,
  circaCronSlot,
  saturdayDeadline,
  holidayForWeek,
  defaultWeeks,
  coverToRating,
  RATING_TO_CONFIDENCE,
} = require("./netlify/functions/lib/circa-contest");
const lines = require("./netlify/functions/lib/circa-contest-lines");
const getPicks = require("./netlify/functions/get-picks-circa");
const gen = require("./netlify/functions/generate-picks-circa-background");
const trigger = require("./netlify/functions/trigger-picks-circa");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { failed++; console.error("  FAIL " + name + ": " + e.message); }
}

const root = __dirname;
const html = fs.readFileSync(path.join(root, "circa/index.html"), "utf8");
const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");

console.log("circa/index.html");
check("no CFB section id", () => {
  assert.ok(!/id=["']cfb["']/.test(html));
});
check("no CIRCA_DATA sample blob", () => {
  assert.ok(!/\bCIRCA_DATA\b/.test(html));
});
check("does not render a cfb section", () => {
  assert.ok(!/renderSection\(\s*['"]cfb['"]\s*\)/.test(html));
});
check("no college-football copy", () => {
  assert.ok(!/college\s+football/i.test(html));
  assert.ok(!/\bCFB\b/.test(html));
});
check("title is Circa Million VIII", () => {
  assert.ok(html.includes("WeBetAI - Social Intelligence | Circa Million VIII"));
});
check("intro is NFL-only Circa Million VIII", () => {
  assert.ok(html.includes("Circa Million VIII"));
  assert.ok(/NFL only/i.test(html));
});
check("holiday chips Nov 25 / Dec 23", () => {
  assert.ok(html.includes("Nov 25"));
  assert.ok(html.includes("Dec 23"));
});
check("wires live get-picks-circa API", () => {
  assert.ok(html.includes("get-picks-circa"));
});
check("pending empty-state copy", () => {
  assert.ok(html.includes("card pending — lines post"));
  assert.ok(html.includes("Sat 4pm PT") || html.includes("Saturday 4"));
});
check("preview banner is hidden until API says preview", () => {
  assert.ok(/id="preview-banner"/.test(html));
  assert.ok(/preview-banner"[^>]*hidden/.test(html) || html.includes('id="preview-banner" hidden'));
});
check("page shows Circa vs market (contest PDF language)", () => {
  assert.ok(/market-chip/.test(html) || /marketMove/.test(html));
  assert.ok(/vs Circa/.test(html));
  assert.ok(/contest PDF|contest point spreads/i.test(html));
  assert.ok(/frozen/i.test(html));
  assert.ok(/W1-4/.test(html) && /W5-9/.test(html) && /W10-13/.test(html) && /W14-18/.test(html));
  assert.ok(/rule 8/i.test(html));
  assert.ok(!/When the Odds API carries/.test(html));
  assert.ok(html.includes("CircaMillionVIIIContest.2026.pdf"));
});
check("page empty state mentions contest PDF missing / no Pinnacle fallback", () => {
  assert.ok(/will not publish a card on Pinnacle/i.test(html) || /contest-pdf-unavailable/.test(html));
});

console.log("lib/circa-contest");
check("contest metadata", () => {
  assert.strictEqual(CONTEST.name, "Circa Million VIII");
  assert.strictEqual(CONTEST.totalWeeks, 18);
  assert.strictEqual(CONTEST.storeName, "edge-picks-circa");
  assert.ok(/contest-pdf/.test(CONTEST.modelVersion));
  assert.strictEqual(CONTEST.modelVersion, "v1.2-circa-contest-pdf");
  assert.ok(CONTEST.rulesUrl && /CircaMillionVIIIContest/.test(CONTEST.rulesUrl));
});
check("week keys", () => {
  assert.strictEqual(weekKey(1), "2026-W01");
  assert.strictEqual(weekBlobKey(1), "picks-week-2026-W01");
  assert.strictEqual(weekBlobKey("2026-W12"), "picks-week-2026-W12");
  assert.deepStrictEqual(parseWeekQuery("1"), { year: 2026, weekNum: 1, week: "2026-W01" });
  assert.deepStrictEqual(parseWeekQuery("2026-W03"), { year: 2026, weekNum: 3, week: "2026-W03" });
  assert.strictEqual(parseWeekQuery("99"), null);
});
check("resolveContestWeek Sep 10 2026 is Week 1", () => {
  const w = resolveContestWeek(new Date("2026-09-10T18:00:00Z"));
  assert.strictEqual(w.weekNum, 1);
  assert.strictEqual(w.week, "2026-W01");
});
check("Thanksgiving Wed Nov 25 2026 maps to the holiday week, not the prior week", () => {
  const w = resolveContestWeek(new Date("2026-11-25T18:00:00-08:00"));
  assert.ok(w.weekNum >= 12);
  assert.ok(holidayForWeek(w.weekNum));
});
check("Christmas Wed Dec 23 2026 is a holiday lines day", () => {
  const w = resolveContestWeek(new Date("2026-12-23T18:00:00-08:00"));
  assert.ok(holidayForWeek(w.weekNum));
});
check("pending payload shape", () => {
  const p = pendingPayload({ weekNum: 1, week: "2026-W01" });
  assert.strictEqual(p.preview, false);
  assert.strictEqual(p.pending, true);
  assert.strictEqual(p.contest, "Circa Million VIII");
  assert.ok(Array.isArray(p.picks) && p.picks.length === 0);
  assert.ok(p.kpis && p.kpis.totalWeeks === 18);
  assert.ok(Array.isArray(p.weeks) && p.weeks.length === 18);
  assert.ok(/Week 1 card pending/.test(p.pendingMessage));
  assert.ok(/Thu 10am PT/.test(p.pendingMessage));
  assert.ok(/Sat 4pm PT/.test(p.pendingMessage));
  assert.strictEqual(p.week, "2026-W01");
  assert.ok(p.deadline);
  assert.ok(p.strategy);
});
check("default weeks highlight current", () => {
  const weeks = defaultWeeks(1);
  assert.strictEqual(weeks[0].current, true);
  assert.strictEqual(weeks[1].current, false);
});
check("TNF / early kickoff vs Sat 4pm PT", () => {
  assert.strictEqual(isEarlyKickoff("2026-09-11T00:20:00Z", 1), true);
  assert.strictEqual(isEarlyKickoff("2026-09-13T17:00:00Z", 1), false);
  assert.ok(saturdayDeadline(1) instanceof Date);
});
check("started games filtered", () => {
  assert.strictEqual(gameAlreadyStarted("2026-09-10T00:20:00Z", new Date("2026-09-10T18:00:00Z")), true);
  assert.strictEqual(gameAlreadyStarted("2026-09-13T17:00:00Z", new Date("2026-09-10T18:00:00Z")), false);
});
check("selectCircaCard: top 5 unique games, skip started, avoid early unless gap", () => {
  const now = new Date("2026-09-10T18:00:00Z");
  const sun = (i) => ({
    pick: `Sun${i} +3`,
    coverProb: 0.56 - i * 0.002,
    commenceTime: "2026-09-13T17:00:00Z",
    awayTeam: `Away${i}`,
    homeTeam: `Home${i}`,
    gameKey: `Away${i}@Home${i}`,
  });
  const started = {
    pick: "Started +3", coverProb: 0.70, commenceTime: "2026-09-09T00:20:00Z",
    awayTeam: "Patriots", homeTeam: "Seahawks", gameKey: "Patriots@Seahawks",
  };
  const tnfWeak = {
    pick: "TNF +3", coverProb: 0.555, commenceTime: "2026-09-11T00:20:00Z",
    awayTeam: "49ers", homeTeam: "Rams", gameKey: "49ers@Rams",
  };
  const tnfStrong = {
    pick: "TNF +7", coverProb: 0.62, commenceTime: "2026-09-11T00:20:00Z",
    awayTeam: "49ers", homeTeam: "Rams", gameKey: "49ers@Rams",
  };
  const late = [0, 1, 2, 3, 4, 5].map(sun);
  const avoided = selectCircaCard([...late, started, tnfWeak], { now, weekNum: 1 });
  assert.strictEqual(avoided.length, 5);
  assert.ok(!avoided.some(p => p.pick.startsWith("TNF") || p.pick.startsWith("Started")));
  const swapped = selectCircaCard([...late, tnfStrong], { now, weekNum: 1 });
  assert.ok(swapped.some(p => p.pick === "TNF +7"), "large coverProb gap should take TNF");
  assert.strictEqual(swapped.length, 5);
  const keys = new Set(swapped.map(p => p.gameKey));
  assert.strictEqual(keys.size, 5);
});
check("selectCircaCard fills to 5 from early when late pool is short", () => {
  const now = new Date("2026-09-10T18:00:00Z");
  const cands = [
    { pick: "A +3", coverProb: 0.56, commenceTime: "2026-09-13T17:00:00Z", gameKey: "a@b" },
    { pick: "B +3", coverProb: 0.55, commenceTime: "2026-09-13T17:00:00Z", gameKey: "c@d" },
    { pick: "C +3", coverProb: 0.54, commenceTime: "2026-09-11T00:20:00Z", gameKey: "e@f" },
  ];
  const picked = selectCircaCard(cands, { now, weekNum: 1 });
  assert.strictEqual(picked.length, 3);
  assert.ok(picked.some(p => p.pick === "C +3"));
});
check("cover ratings", () => {
  assert.strictEqual(coverToRating(0.57), "A+");
  assert.strictEqual(RATING_TO_CONFIDENCE["A+"], "aplus");
});
check("cron windows (UTC)", () => {
  assert.strictEqual(circaCronSlot(new Date("2026-09-10T17:15:00Z")), "first");
  assert.strictEqual(circaCronSlot(new Date("2026-09-11T17:00:00Z")), "refresh");
  assert.strictEqual(circaCronSlot(new Date("2026-09-12T20:00:00Z")), "final");
  assert.strictEqual(circaCronSlot(new Date("2026-09-10T13:00:00Z")), null);
  assert.strictEqual(circaCronSlot(new Date("2026-11-25T17:15:00Z")), "holiday-first");
  assert.strictEqual(circaCronSlot(new Date("2026-09-09T17:15:00Z")), null);
});

console.log("get-picks-circa");
check("exports handler + payload helpers", () => {
  assert.strictEqual(typeof getPicks.handler, "function");
  assert.strictEqual(typeof getPicks.normalizePayload, "function");
  assert.strictEqual(getPicks.hasLivePicks({ picks: [] }), false);
  assert.strictEqual(getPicks.hasLivePicks({ picks: [{ pick: "Jets +3" }] }), true);
  assert.strictEqual(getPicks.hasLivePicks({ preview: true, picks: [{ pick: "Jets +3" }] }), false);
});

console.log("lib/circa-contest-lines");
check("Week 1 fixture matches official sheet (Browns +8.5 / Jaguars -8.5)", () => {
  const fx = lines.getWeekFixture(1);
  assert.ok(fx);
  assert.strictEqual(fx.weekNum, 1);
  assert.strictEqual(fx.lineSource, "circa-contest-pdf");
  assert.strictEqual(fx.games.length, 16);
  const jax = fx.games.find(g => /Jaguars/.test(g.home) && /Browns/.test(g.away));
  assert.ok(jax, "Browns @ Jaguars missing");
  assert.strictEqual(jax.away, "Cleveland Browns");
  assert.strictEqual(jax.home, "Jacksonville Jaguars");
  assert.strictEqual(jax.awaySpread, 8.5);
  assert.strictEqual(jax.homeSpread, -8.5);
  const bills = fx.games.find(g => /Bills/.test(g.away));
  assert.strictEqual(bills.awaySpread, -0.5);
  assert.strictEqual(bills.homeSpread, 0.5);
  const rams = fx.games.find(g => /Rams/.test(g.home));
  assert.strictEqual(rams.awaySpread, 4);
  assert.strictEqual(rams.homeSpread, -4);
  const pats = fx.games.find(g => /Patriots/.test(g.away));
  assert.strictEqual(pats.homeSpread, -3);
  assert.strictEqual(pats.awaySpread, 3);
});
check("½ parses to .5", () => {
  assert.strictEqual(lines.parseSpreadToken("+8½"), 8.5);
  assert.strictEqual(lines.parseSpreadToken("-3½"), -3.5);
  assert.strictEqual(lines.parseSpreadToken("-½"), -0.5);
  assert.strictEqual(lines.parseSpreadToken("+3"), 3);
});
check("parseContestText maps ALL CAPS sheet tokens including ½", () => {
  const text = "BROWNS +8½\nJAGUARS -8½\nBUCS +3½\nBENGALS -3½";
  const parsed = lines.parseContestText(text, 1);
  assert.ok(parsed.games.length >= 2, JSON.stringify(parsed.games));
  const jax = parsed.games.find(g => /Jaguars/.test(g.home) && /Browns/.test(g.away));
  assert.ok(jax, JSON.stringify(parsed.games));
  assert.strictEqual(jax.away, "Cleveland Browns");
  assert.strictEqual(jax.home, "Jacksonville Jaguars");
  assert.strictEqual(jax.awaySpread, 8.5);
  assert.strictEqual(jax.homeSpread, -8.5);
});
check("candidate URLs include Week-1 2026/09 path", () => {
  const urls = lines.candidateSpreadUrls(1);
  assert.ok(urls.some(u => /Week-1\.pdf/.test(u)));
  assert.ok(urls.some(u => /2026\/09/.test(u)));
});
check("no pinnacle-as-contest in lines module", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/circa-contest-lines.js"), "utf8");
  assert.ok(!/lineSource\s*=\s*["']pinnacle["']/.test(src));
  assert.ok(src.includes("circa-contest-pdf"));
  assert.ok(/never/i.test(src) && /Pinnacle/i.test(src));
});

console.log("generate-picks-circa-background");
check("exports handler and contest/market helpers", () => {
  assert.strictEqual(typeof gen.handler, "function");
  assert.strictEqual(typeof gen.extractMarketSpread, "function");
  assert.strictEqual(typeof gen.mergeContestAndMarket, "function");
  assert.strictEqual(typeof gen.buildFinalPicks, "function");
  assert.strictEqual(typeof gen.formatMarketMove, "function");
  assert.ok(/contest-pdf/.test(gen.MODEL_VERSION));
  assert.strictEqual(gen.MODEL_VERSION, "v1.2-circa-contest-pdf");
  assert.strictEqual(typeof gen.buildPostedSpread, "undefined");
});
check("generator source never treats pinnacle as contest lineSource", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/generate-picks-circa-background.js"), "utf8");
  assert.ok(!/lineSource\s*=\s*["']pinnacle["']/.test(src));
  assert.ok(!/using Pinnacle/.test(src));
  assert.ok(src.includes("circa-contest-pdf") || src.includes("CONTEST_LINE_SOURCE"));
  assert.ok(src.includes("loadContestLines"));
  assert.ok(!/Posted number: Circa Sports \(`circasports`\) when Odds API has it/.test(src));
});
check("integer contest numbers format without trailing .0", () => {
  const sides = gen.computeSpreadSides({
    home: "Tennessee Titans",
    away: "New York Jets",
    commenceTime: "2026-09-13T17:00:00Z",
    consensusSpread: -3,
    spreadHomeNoVig: 0.48,
    contestHomePoint: -3,
    contestAwayPoint: 3,
    lineSource: "circa-contest-pdf",
    lineNote: null,
    bookCount: 2,
  }, { venue: "Nissan Stadium" }, {}, {});
  assert.ok(sides.some(s => s.pick === "Jets +3"), JSON.stringify(sides.map(s => s.pick)));
  assert.ok(sides.some(s => s.pick === "Titans -3"), JSON.stringify(sides.map(s => s.pick)));
  assert.ok(sides.every(s => s.lineSource === "circa-contest-pdf"));
});
check("Pinnacle is market-only, never the contest number", () => {
  const market = gen.extractMarketSpread({
    home_team: "Jacksonville Jaguars",
    away_team: "Cleveland Browns",
    commence_time: "2026-09-13T17:00:00Z",
    bookmakers: [
      {
        key: "pinnacle",
        markets: [{ key: "spreads", outcomes: [
          { name: "Jacksonville Jaguars", point: -9.5, price: -110 },
          { name: "Cleveland Browns", point: 9.5, price: -110 },
        ] }],
      },
    ],
  });
  assert.ok(market);
  assert.notStrictEqual(market.lineSource, "pinnacle");
  assert.strictEqual(market.homePoint, -9.5);
  const merged = gen.mergeContestAndMarket({
    home: "Jacksonville Jaguars",
    away: "Cleveland Browns",
    homeSpread: -8.5,
    awaySpread: 8.5,
    commenceTime: "2026-09-13T17:00:00Z",
  }, {
    home_team: "Jacksonville Jaguars",
    away_team: "Cleveland Browns",
    commence_time: "2026-09-13T17:00:00Z",
    bookmakers: [
      {
        key: "pinnacle",
        markets: [{ key: "spreads", outcomes: [
          { name: "Jacksonville Jaguars", point: -9.5, price: -110 },
          { name: "Cleveland Browns", point: 9.5, price: -110 },
        ] }],
      },
    ],
  }, { sourceUrl: lines.WEEK1_SOURCE_URL });
  assert.strictEqual(merged.lineSource, "circa-contest-pdf");
  assert.strictEqual(merged.contestHomePoint, -8.5);
  assert.strictEqual(merged.contestAwayPoint, 8.5);
  assert.strictEqual(merged.marketAwayPoint, 9.5);
});
check("marketMove fields on contest sides (Browns +8.5 vs market +9.5)", () => {
  const sides = gen.computeSpreadSides({
    home: "Jacksonville Jaguars",
    away: "Cleveland Browns",
    commenceTime: "2026-09-13T17:00:00Z",
    contestHomePoint: -8.5,
    contestAwayPoint: 8.5,
    marketHomePoint: -9.5,
    marketAwayPoint: 9.5,
    marketHomePrice: -110,
    marketAwayPrice: -110,
    consensusSpread: -9.5,
    lineSource: "circa-contest-pdf",
    sourceUrl: lines.WEEK1_SOURCE_URL,
  }, { venue: "EverBank Stadium" }, {}, {});
  const browns = sides.find(s => /Browns/.test(s.pick));
  assert.ok(browns, JSON.stringify(sides.map(s => s.pick)));
  assert.strictEqual(browns.pick, "Browns +8.5");
  assert.strictEqual(browns.lineSource, "circa-contest-pdf");
  assert.strictEqual(browns.circaSpread, "+8.5");
  assert.ok(/Market now Browns \+9\.5 \(\+1\.0 vs Circa\)/.test(browns.marketMove), browns.marketMove);
  const final = gen.buildFinalPicks([browns], 1)[0];
  assert.strictEqual(final.lineSource, "circa-contest-pdf");
  assert.ok(final.marketMove);
  assert.ok(final.circaSpread);
  assert.ok(final.contestLine);
  assert.ok(final.marketSpread);
});
check("final pick fields match the page", () => {
  const picks = gen.buildFinalPicks([{
    pick: "Jets +1.5",
    odds: null,
    coverProb: 0.581,
    homeTeam: "Tennessee Titans",
    awayTeam: "New York Jets",
    commenceTime: "2026-09-13T17:00:00Z",
    lineSource: "circa-contest-pdf",
    circaSpread: "+1.5",
    contestLine: "Jets +1.5",
    marketSpread: "+2",
    marketMove: "Market now Jets +2 (+0.5 vs Circa)",
    postedPoint: 1.5,
    venue: "Nissan Stadium",
  }], 1);
  const p = picks[0];
  for (const k of ["matchup", "pick", "odds", "coverProb", "edgePct", "commenceTime", "coreReasoning", "confidence", "sport", "betType", "circaSpread", "contestLine", "marketMove", "lineSource"]) {
    assert.ok(p[k] != null && p[k] !== "", "missing " + k);
  }
  assert.strictEqual(p.sport, "NFL");
  assert.strictEqual(p.betType, "spread");
  assert.strictEqual(p.matchup, "New York Jets @ Tennessee Titans");
  assert.strictEqual(p.lineSource, "circa-contest-pdf");
  assert.ok(String(p.coverProb).includes("%"));
  assert.ok(String(p.edgePct).includes("%"));
  assert.ok(/vs Circa/.test(p.marketMove));
});
check("live card payload is flat (not nested under .nfl)", () => {
  const card = gen.liveCardPayload({
    weekNum: 1, week: "2026-W01", picks: [{ pick: "Jets +3" }], strategy: "x",
  });
  assert.strictEqual(card.contest, "Circa Million VIII");
  assert.strictEqual(card.preview, false);
  assert.ok(Array.isArray(card.picks));
  assert.ok(!card.nfl);
});

console.log("trigger-picks-circa");
check("exports handler", () => {
  assert.strictEqual(typeof trigger.handler, "function");
});

console.log("netlify.toml");
check("circa trigger cron + background comment block", () => {
  assert.ok(toml.includes('[functions."trigger-picks-circa"]'));
  assert.ok(toml.includes('[functions."generate-picks-circa-background"]'));
  assert.ok(toml.includes("15 17") || toml.includes("0,15 17,20"));
  assert.ok(/10:15 AM PT/.test(toml));
  assert.ok(/1:00 PM PT/.test(toml));
  assert.ok(/2026-11-25/.test(toml) && /2026-12-23/.test(toml));
});
check("pipeline files exist", () => {
  for (const f of [
    "netlify/functions/generate-picks-circa-background.js",
    "netlify/functions/trigger-picks-circa.js",
    "netlify/functions/get-picks-circa.js",
    "netlify/functions/lib/circa-contest.js",
    "netlify/functions/lib/circa-contest-lines.js",
  ]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

async function runAsync() {
  console.log("lib/circa-contest-lines async");
  try {
    const board = await lines.loadContestLines(1, { skipFetch: true });
    assert.strictEqual(board.weekNum, 1);
    assert.strictEqual(board.lineSource, "circa-contest-pdf");
    assert.ok(board.games.length >= 16);
    const jax = board.games.find(g => /Jaguars/.test(g.home));
    assert.strictEqual(jax.awaySpread, 8.5);
    assert.strictEqual(jax.homeSpread, -8.5);
    const chiefs = board.games.find(g => /Chiefs/.test(g.home));
    assert.strictEqual(chiefs.awaySpread, 3);
    assert.strictEqual(chiefs.homeSpread, -3);
    console.log("  ok  loadContestLines week 1 fixture");
  } catch (e) {
    failed++;
    console.error("  FAIL loadContestLines week 1 fixture: " + e.message);
  }
  try {
    let threw = false;
    try { await lines.loadContestLines(2, { skipFetch: true }); }
    catch (e) {
      threw = e instanceof lines.ContestLinesError || /not available/.test(e.message);
    }
    assert.ok(threw, "week 2 without PDF/fixture must refuse (no Pinnacle fallback)");
    console.log("  ok  week 2 without sheet throws");
  } catch (e) {
    failed++;
    console.error("  FAIL week 2 without sheet throws: " + e.message);
  }

  console.log("get-picks-circa handler (no blob → pending JSON)");
  try {
    const res = await getPicks.handler({ httpMethod: "GET", queryStringParameters: { week: "1" } });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.contest, "Circa Million VIII");
    assert.ok(Array.isArray(body.picks));
    assert.strictEqual(body.picks.length, 0);
    assert.strictEqual(body.pending, true);
    assert.strictEqual(body.preview, false);
    assert.ok(body.pendingMessage);
    assert.strictEqual(body.week, "2026-W01");
    assert.ok(body.rulesUrl);
    console.log("  ok  pending JSON shape");
  } catch (e) {
    failed++;
    console.error("  FAIL pending JSON shape: " + e.message);
  }

  if (failed) {
    console.error("\n" + failed + " check(s) failed");
    process.exit(1);
  }
  console.log("\nall circa smoke checks passed");
}

runAsync();
