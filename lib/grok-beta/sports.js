"use strict";

// Odds API sport keys already used in this repo, plus WNBA / NCAAF / UFC
// which The Odds API serves and the user listed as in-scope if present.
const ODDS_SPORTS = [
  { key: "baseball_mlb", label: "MLB", family: "runs", espnSport: "baseball", espnLeague: "mlb" },
  { key: "basketball_nba", label: "NBA", family: "points", espnSport: "basketball", espnLeague: "nba" },
  { key: "basketball_wnba", label: "WNBA", family: "points", espnSport: "basketball", espnLeague: "wnba" },
  { key: "basketball_ncaab", label: "NCAAB", family: "points", espnSport: "basketball", espnLeague: "mens-college-basketball" },
  { key: "icehockey_nhl", label: "NHL", family: "goals", espnSport: "hockey", espnLeague: "nhl" },
  { key: "americanfootball_nfl", label: "NFL", family: "points", espnSport: "football", espnLeague: "nfl" },
  { key: "americanfootball_nfl_preseason", label: "NFL", family: "points", espnSport: "football", espnLeague: "nfl" },
  { key: "americanfootball_ncaaf", label: "NCAAF", family: "points", espnSport: "football", espnLeague: "college-football" },
  { key: "soccer_usa_mls", label: "MLS", family: "goals", espnSport: "soccer", espnLeague: "usa.1" },
  { key: "soccer_epl", label: "EPL", family: "goals", espnSport: "soccer", espnLeague: "eng.1" },
  { key: "soccer_spain_la_liga", label: "La Liga", family: "goals", espnSport: "soccer", espnLeague: "esp.1" },
  { key: "soccer_italy_serie_a", label: "Serie A", family: "goals", espnSport: "soccer", espnLeague: "ita.1" },
  { key: "soccer_germany_bundesliga", label: "Bundesliga", family: "goals", espnSport: "soccer", espnLeague: "ger.1" },
  { key: "soccer_france_ligue_one", label: "Ligue 1", family: "goals", espnSport: "soccer", espnLeague: "fra.1" },
  { key: "soccer_uefa_champs_league", label: "UCL", family: "goals", espnSport: "soccer", espnLeague: "uefa.champions" },
  { key: "soccer_uefa_europa_league", label: "UEL", family: "goals", espnSport: "soccer", espnLeague: "uefa.europa" },
  { key: "mma_mixed_martial_arts", label: "UFC", family: "fight", espnSport: "mma", espnLeague: "ufc" },
];

const FAMILY = {
  runs: {
    mu: 4.45, hfa: 0.14, restCoef: 0.05, muMin: 0.35,
    injPos: 0.07, injPitcher: 0.32, injQ: 0.4,
  },
  points: {
    // per-label overrides below
    muMin: 8,
    injQ: 0.4,
  },
  goals: {
    muMin: 0.35, injQ: 0.4,
  },
  fight: {
    mu: 0.5, hfa: 0, restCoef: 0.01, muMin: 0.05,
  },
};

const POINTS_BY_LABEL = {
  NBA:   { mu: 113.0, hfa: 2.3, restCoef: 0.6, sigmaM: 12.0, sigmaT: 14.5, injStarter: 2.6, injBench: 1.0 },
  WNBA:  { mu: 82.5,  hfa: 1.5, restCoef: 0.5, sigmaM: 10.5, sigmaT: 12.0, injStarter: 2.4, injBench: 0.9 },
  NCAAB: { mu: 73.0,  hfa: 3.1, restCoef: 0.8, sigmaM: 11.0, sigmaT: 13.5, injStarter: 2.2, injBench: 0.9 },
  NFL:   { mu: 22.8,  hfa: 2.0, restCoef: 0.9, sigmaM: 13.8, sigmaT: 10.4, injStarter: 1.8, injBench: 0.7 },
  NCAAF: { mu: 27.4,  hfa: 2.6, restCoef: 1.0, sigmaM: 16.0, sigmaT: 13.0, injStarter: 1.8, injBench: 0.7 },
};

const GOALS_BY_LABEL = {
  NHL: { mu: 3.05, hfa: 0.18, restCoef: 0.04, injSkater: 0.22, injGoalie: 0.50 },
  MLS: { mu: 1.40, hfa: 0.16, restCoef: 0.03, injSkater: 0.12, injGoalie: 0.20 },
  DEFAULT_SOCCER: { mu: 1.38, hfa: 0.16, restCoef: 0.03, injSkater: 0.12, injGoalie: 0.20 },
};

const US_RETAIL = new Set([
  "draftkings", "fanduel", "betmgm", "caesars", "espnbet",
  "hardrockbet", "hardrockbet_oh", "betrivers", "fanatics", "ballybet", "betparx",
]);

function sportByKey(key) {
  return ODDS_SPORTS.find(s => s.key === key) || null;
}

function familyParams(label, family) {
  if (family === "runs") return { family, ...FAMILY.runs };
  if (family === "points") return { family, ...FAMILY.points, ...(POINTS_BY_LABEL[label] || POINTS_BY_LABEL.NBA) };
  if (family === "goals") {
    const g = GOALS_BY_LABEL[label] || GOALS_BY_LABEL.DEFAULT_SOCCER;
    return { family, ...FAMILY.goals, ...g };
  }
  return { family: "fight", ...FAMILY.fight };
}

function isPitcherSensitive(label, market) {
  if (label !== "MLB") return false;
  return market === "h2h" || market === "spreads";
}

module.exports = {
  ODDS_SPORTS, US_RETAIL, sportByKey, familyParams, isPitcherSensitive,
};
