"use strict";
const { shinTwoWay, impliedFromAmerican, evaluateGame, selectAndCap } = require("./engine");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const piA = impliedFromAmerican(-110);
const piB = impliedFromAmerican(-110);
const shin = shinTwoWay(piA, piB);
assert(shin && Math.abs(shin.pA - 0.5) < 0.01, "shin -110/-110 ~ 0.5");
assert(shin.method === "shin" || shin.method === "fair", "shin method");

const juice = shinTwoWay(impliedFromAmerican(-150), impliedFromAmerican(+130));
assert(juice && juice.method === "shin", "shin method on juiced two-way");
assert(juice.pA > 0.55 && juice.pA < 0.62, "favorites de-vig into (0.55,0.62)");
assert(Math.abs(juice.pA + juice.pB - 1) < 1e-8, "shin sums to 1");
assert(juice.z > 0 && juice.z < 0.3, "shin z interior");

const game = {
  label: "NBA", family: "points",
  homeTeam: "Boston Celtics", awayTeam: "New York Knicks",
  homeInjuries: [], awayInjuries: [],
  homePlayedYesterday: false, awayPlayedYesterday: true,
  homeStarter: null, awayStarter: null,
};
const odds = {
  home_team: "Boston Celtics", away_team: "New York Knicks",
  commence_time: "2026-08-23T00:00:00Z",
  bookmakers: [
    { key: "draftkings", markets: [
      { key: "h2h", outcomes: [{ name: "Boston Celtics", price: -140 }, { name: "New York Knicks", price: +120 }] },
      { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -110, point: -4.5 }, { name: "New York Knicks", price: -110, point: 4.5 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -110, point: 220.5 }, { name: "Under", price: -110, point: 220.5 }] },
    ]},
    { key: "fanduel", markets: [
      { key: "h2h", outcomes: [{ name: "Boston Celtics", price: -145 }, { name: "New York Knicks", price: +125 }] },
      { key: "spreads", outcomes: [{ name: "Boston Celtics", price: -108, point: -4.5 }, { name: "New York Knicks", price: -112, point: 4.5 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -105, point: 220.5 }, { name: "Under", price: -115, point: 220.5 }] },
    ]},
  ],
};
const { candidates, rejections } = evaluateGame(game, odds, null);
assert(Array.isArray(candidates) && Array.isArray(rejections), "evaluate returns arrays");
const again = evaluateGame(game, odds, null);
assert(JSON.stringify(again.candidates) === JSON.stringify(candidates), "same snapshot → same candidates");
const capped = selectAndCap(candidates);
assert(capped.length <= 7, "cap 7");

const injured = { ...game, homeInjuries: [{ name: "Star", status: "Out", detail: "starting forward" }] };
const injEval = evaluateGame(injured, odds, null);
assert(JSON.stringify(evaluateGame(injured, odds, null).candidates) === JSON.stringify(injEval.candidates), "injury snapshot stable");
for (const c of injEval.candidates) {
  assert(c.edge <= 0.1001, "clip 10pt");
  assert(c.pModel === injEval.candidates.find(x => x.pick === c.pick).pModel, "p_model frozen");
}
console.log("grok-beta selftest ok", { candidates: candidates.length, rejections: rejections.length, capped: capped.length, injCandidates: injEval.candidates.length, shinZ: juice.z });
