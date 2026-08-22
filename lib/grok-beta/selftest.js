"use strict";
const { shinTwoWay, impliedFromAmerican, evaluateGame, selectAndCap } = require("./engine");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const piA = impliedFromAmerican(-110);
const piB = impliedFromAmerican(-110);
const shin = shinTwoWay(piA, piB);
assert(shin && Math.abs(shin.pA - 0.5) < 0.01, "shin -110/-110 ~ 0.5");

const juice = shinTwoWay(impliedFromAmerican(-150), impliedFromAmerican(+130));
assert(juice && juice.method === "shin", "shin method on juiced two-way");
assert(juice.pA > 0.55 && juice.pA < 0.62, "favorites de-vig into (0.55,0.62)");
assert(Math.abs(juice.pA + juice.pB - 1) < 1e-8, "shin sums to 1");

function books({ pinHome, pinAway, dkHome, dkAway, spread, total }) {
  return {
    home_team: "Boston Celtics", away_team: "New York Knicks",
    commence_time: "2026-10-23T00:00:00Z",
    bookmakers: [
      { key: "pinnacle", markets: [
        { key: "h2h", outcomes: [{ name: "Boston Celtics", price: pinHome }, { name: "New York Knicks", price: pinAway }] },
        { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -110, point: spread }, { name: "New York Knicks", price: -110, point: -spread }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] },
      ]},
      { key: "draftkings", markets: [
        { key: "h2h", outcomes: [{ name: "Boston Celtics", price: dkHome }, { name: "New York Knicks", price: dkAway }] },
        { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -108, point: spread }, { name: "New York Knicks", price: -112, point: -spread }] },
        { key: "totals", outcomes: [{ name: "Over", price: -105, point: total }, { name: "Under", price: -115, point: total }] },
      ]},
      { key: "fanduel", markets: [
        { key: "h2h", outcomes: [{ name: "Boston Celtics", price: dkHome - 5 }, { name: "New York Knicks", price: dkAway + 5 }] },
        { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -110, point: spread }, { name: "New York Knicks", price: -110, point: -spread }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] },
      ]},
      { key: "hardrockbet", markets: [
        { key: "h2h", outcomes: [{ name: "Boston Celtics", price: dkHome }, { name: "New York Knicks", price: dkAway }] },
        { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -110, point: spread }, { name: "New York Knicks", price: -110, point: -spread }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] },
      ]},
    ],
  };
}

const game = {
  label: "NBA", family: "points", sportKey: "basketball_nba",
  homeTeam: "Boston Celtics", awayTeam: "New York Knicks",
  homeInjuries: [], awayInjuries: [],
  homePlayedYesterday: false, awayPlayedYesterday: false,
  homeWinPct: 0.72, awayWinPct: 0.45,
  homePF: 118, homePA: 108, awayPF: 110, awayPA: 112,
  homeStarter: null, awayStarter: null,
};

// Soft DK number on the dog vs sharp Pinnacle — must be able to emit +EV.
const lagged = books({ pinHome: -180, pinAway: +155, dkHome: -165, dkAway: +175, spread: -6.5, total: 224.5 });
const r1 = evaluateGame(game, lagged, null);
assert(Array.isArray(r1.candidates) && Array.isArray(r1.rejections), "evaluate returns arrays");
const again = evaluateGame(game, lagged, null);
assert(JSON.stringify(again.candidates) === JSON.stringify(r1.candidates), "same snapshot → same candidates");
assert(r1.candidates.length > 0, "soft +175 on a Pinnacle +155 dog must clear hold+EV");
assert(r1.candidates.every(c => c.holdEv >= 0.006), "never fade sharp no-vig");
for (const c of r1.candidates) {
  assert(c.ev >= 0.018, "emitted EV >= 1.8%");
  assert(c.pModel != null && c.pMarket != null, "p_model frozen");
  assert(c.hardRock && c.hardRock.available, "Hard Rock placeable");
}
const noHr = JSON.parse(JSON.stringify(lagged));
noHr.bookmakers = noHr.bookmakers.filter(b => b.key !== "hardrockbet");
const blocked = evaluateGame(game, noHr, null);
assert(blocked.candidates.length === 0, "no Hard Rock → no published candidate");
assert(blocked.rejections.some(r => /Hard Rock/i.test(r.reason || "")), "HR miss is a rejection");

const { picks, parlay } = selectAndCap(r1.candidates);
assert(picks.length <= 3, "card is 3 straights max");
if (picks.length >= 2) assert(parlay && parlay.legs.length === picks.length, "parlay uses the same legs");

console.log("grok-beta selftest ok", {
  candidates: r1.candidates.length,
  rejections: r1.rejections.length,
  card: picks.map(p => `${p.pick} EV ${(p.ev * 100).toFixed(1)}%`),
  parlay: parlay && parlay.combinedOdds,
  shinZ: juice.z,
});
