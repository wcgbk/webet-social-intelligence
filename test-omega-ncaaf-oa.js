'use strict';
/**
 * NCAAF opponent-adjusted ratings. A non-FBS game counts for the FBS side
 * and for one shared non-FBS opponent, and it does not move the FBS rating
 * by the full margin. The total center is the mean of FBS-vs-FBS games
 * decided by at most 28, not the raw mean and not a flat 52.
 * No schedule pack leaves the EPA / standings path unchanged.
 * The NHL odds URL keeps us,us2,eu and does not filter bookmakers.
 * No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const epa = require(path.join(root, 'sports/epa'));
const ingest = require(path.join(root, 'ingest'));
const config = require(path.join(root, 'config'));
const { isFbsTeamId } = require(path.join(root, 'sports/team_identity'));

const PLAYS = epa.SPORT_CFG.NCAAF.plays;
assert.strictEqual(epa.NCAAF_OA_PRIOR_GAMES, 2);
assert.strictEqual(epa.NCAAF_OA_BLOWOUT_MARGIN, 28);
assert.ok(epa.NCAAF_OA_MIN_GAMES >= 40);

function game(hid, aid, hs, as, extra) {
  return {
    hid: String(hid),
    aid: String(aid),
    hs, as,
    margin: hs - as,
    total: hs + as,
    neutral: false,
    commence: '2026-09-12T20:00:00Z',
    hFbs: isFbsTeamId(hid),
    aFbs: isFbsTeamId(aid),
    ...(extra || {}),
  };
}

// Auburn 2, UAB 5, Arizona 12, Arizona State 9 are FBS. 999 is not.
assert.strictEqual(isFbsTeamId('2'), true);
assert.strictEqual(isFbsTeamId('999'), false);

function boardFrom(games, commence) {
  return {
    events: games.map((g, i) => ({
      date: g.commence || commence,
      status: { type: { state: 'post' } },
      competitions: [{
        neutralSite: g.neutral === true,
        status: { type: { state: 'post' } },
        competitors: [
          { homeAway: 'home', score: String(g.hs), team: { id: g.hid } },
          { homeAway: 'away', score: String(g.as), team: { id: g.aid } },
        ],
      }],
      id: `g${i}`,
    })),
  };
}

// Close FBS games at 24-24, plus one 56-0 blowout and one 59-3 FCS win.
// The center ignores the blowout. Auburn's FCS win does not become its rating.
{
  const close = [
    game('2', '5', 24, 24),
    game('5', '12', 24, 24),
    game('12', '9', 24, 24),
    game('9', '2', 24, 24),
    game('2', '12', 27, 24),
    game('5', '9', 24, 21),
    game('12', '2', 24, 24),
    game('9', '5', 24, 24),
  ];
  // Repeat the close set on later dates so each team has several games.
  const more = close.map((g, i) => Object.assign({}, g, {
    commence: `2026-09-${String(19 + (i % 5)).padStart(2, '0')}T20:00:00Z`,
  }));
  const blowout = game('2', '5', 56, 0, { commence: '2026-09-26T20:00:00Z' });
  const fcs = game('2', '999', 59, 3, { commence: '2026-09-05T20:00:00Z' });
  const withBlowout = epa.solveNcaafOpponentRatings([boardFrom(close.concat(more, [blowout]))], {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 4,
  });
  assert.ok(withBlowout, 'pack');
  // 56-0 is outside 28, so the center stays the close-game mean (48).
  assert.strictEqual(withBlowout.leagueTotal, 48);
  const boards = [boardFrom(close.concat(more, [fcs]))];
  const pack = epa.solveNcaafOpponentRatings(boards, {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 4,
  });
  assert.ok(pack, 'fcs pack');
  const auburn = pack.byId['2'];
  assert.ok(auburn, 'auburn rated from FBS games');
  const strength = auburn.off + auburn.def;
  assert.ok(Math.abs(strength) < 12, `FCS 59-3 must not set Auburn's strength, got ${strength}`);
  assert.ok(pack.fcsStrength < -20, `non-FBS prior should be well below average FBS, got ${pack.fcsStrength}`);
  // The cupcake is a shared opponent with its own off and def, not a zero-pace stub.
  assert.ok(pack.fcsDef < pack.fcsOff, `non-FBS defense should be the worse side, off ${pack.fcsOff} def ${pack.fcsDef}`);
  // One shared opponent cannot be identified from a single game, so that
  // game does not move Auburn. Two different margins can: the bigger win
  // rates higher, and the pool keeps the lift well under the raw gap.
  const cupB = game('5', '999', 31, 28, { commence: '2026-09-05T23:00:00Z' });
  const base = epa.solveNcaafOpponentRatings([boardFrom(close.concat(more))], {
    asOf: '2026-10-10', efficiency: {}, minGames: 4,
  });
  const both = epa.solveNcaafOpponentRatings([boardFrom(close.concat(more, [fcs, cupB]))], {
    asOf: '2026-10-10', efficiency: {}, minGames: 4,
  });
  const edge = (p, id) => p.byId[id].off + p.byId[id].def;
  const lift = (edge(both, '2') - edge(both, '5')) - (edge(base, '2') - edge(base, '5'));
  assert.ok(lift > 1, `bigger cupcake win must rate higher, lift ${lift}`);
  assert.ok(lift < 25, `shared opponent absorbs most of a blowout, lift ${lift}`);
}

// One FBS win by 30 is shrunk by K=2, not taken whole. Opponent also played
// close games so the residual is not the raw margin.
{
  const games = [
    game('2', '5', 24, 24),
    game('5', '12', 24, 24),
    game('12', '9', 24, 24),
    game('9', '5', 24, 24),
    game('12', '2', 24, 24),
    game('9', '12', 24, 24),
    game('2', '12', 48, 18, { commence: '2026-09-19T20:00:00Z' }),
  ];
  const pack = epa.solveNcaafOpponentRatings([boardFrom(games)], {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 4,
  });
  const strength = pack.byId['2'].off + pack.byId['2'].def;
  assert.ok(strength > 0, 'a win still rates positive');
  assert.ok(strength < 20, `K=2 must shrink a single 30-point win, got ${strength}`);
}

// No pack: same numbers as the standings path. _oa absent.
{
  const home = 'Auburn Tigers';
  const away = 'UAB Blazers';
  const standings = {
    [home]: { pf: 140, pa: 100, wins: 4, losses: 1, gamesPlayed: 5 },
    [away]: { pf: 90, pa: 110, wins: 2, losses: 3, gamesPlayed: 5 },
  };
  const bare = epa.footballProjection({ sport: 'NCAAF', home, away, standings, efficiency: {}, hfa: 2.6 });
  const tagged = epa.footballProjection({
    sport: 'NCAAF', home, away, standings,
    efficiency: { _meta: { season: 2025 } },
    hfa: 2.6,
  });
  assert.strictEqual(bare.modelMargin, tagged.modelMargin);
  assert.strictEqual(bare.modelTotal, tagged.modelTotal);
  assert.notStrictEqual(bare.methods.family, 'cfb-oa-v1');
  assert.strictEqual(bare.usedEpa, false);
}

// A pack projects margin from strength and total from the stored center.
{
  const efficiency = {
    _oa: {
      byId: {
        '2': { off: 6, def: 4 },
        '5': { off: -1, def: 1 },
      },
      seedById: {},
      leagueTotal: 51.5,
      fcsOff: -18,
      fcsDef: -18,
      fcsStrength: -36,
      games: 50,
    },
  };
  const proj = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Auburn Tigers',
    away: 'UAB Blazers',
    standings: {},
    efficiency,
    hfa: config.HFA.NCAAF,
  });
  // (6+4) - (-1+1) + 2.6 = 12.6
  assert.ok(Math.abs(proj.modelMargin - 12.6) < 1e-9, proj.modelMargin);
  // 51.5 + (6-4) + (-1-1) = 51.5
  assert.ok(Math.abs(proj.modelTotal - 51.5) < 1e-9, proj.modelTotal);
  assert.strictEqual(proj.methods.family, 'cfb-oa-v1');
  assert.strictEqual(proj.engineSoft.used, false);
  const neutral = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Auburn Tigers',
    away: 'UAB Blazers',
    standings: {},
    efficiency,
    hfa: 0,
  });
  assert.ok(Math.abs(neutral.modelMargin - 10) < 1e-9, neutral.modelMargin);
  assert.ok(Math.abs(neutral.modelTotal - proj.modelTotal) < 1e-9);
}

{
  const ids = require(path.join(root, 'sports/data/ncaaf-team-ids.json'));
  let fcsName = null;
  let fcsId = null;
  for (const [id, rec] of Object.entries(ids.teams)) {
    if (rec && rec.division !== 'fbs' && rec.displayName) {
      fcsName = rec.displayName;
      fcsId = id;
      break;
    }
  }
  assert.ok(fcsName, 'fixture fcs name');
  const efficiency = {
    _oa: {
      byId: { '2': { off: 3, def: 3 } },
      leagueTotal: 50,
      fcsOff: -15,
      fcsDef: -15,
      games: 40,
    },
  };
  const proj = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Auburn Tigers',
    away: fcsName,
    standings: {},
    efficiency,
    hfa: 2.6,
  });
  // strength 6 - (-30) + 2.6 = 38.6. The OA cap is above that, so it is kept.
  assert.ok(proj.modelMargin > 20, proj.modelMargin);
  assert.strictEqual(proj.modelMargin, Math.min(epa.NCAAF_OA_MARGIN_CAP, (3 + 3) - (-15 + -15) + 2.6));
  assert.ok(epa.NCAAF_OA_MARGIN_CAP > epa.SPORT_CFG.NCAAF.marginCap);
  // pace of FBS is 0, pace of FCS is 0, total is the center
  assert.ok(Math.abs(proj.modelTotal - 50) < 1e-9, proj.modelTotal);
  assert.notStrictEqual(fcsId, '2');
}

// Too few games withholds the pack. Pre-kickoff games are not in the fit.
{
  const early = [game('2', '5', 30, 20, { commence: '2026-10-10T23:00:00Z' })];
  const pack = epa.solveNcaafOpponentRatings([boardFrom(early)], {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 1,
  });
  assert.strictEqual(pack, null);
  const played = [game('2', '5', 30, 20, { commence: '2026-10-09T23:00:00Z' })];
  for (let i = 0; i < 3; i += 1) {
    played.push(game('5', '12', 21, 21, { commence: `2026-10-0${i + 1}T20:00:00Z` }));
  }
  const ok = epa.solveNcaafOpponentRatings([boardFrom(played)], {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 1,
  });
  assert.ok(ok);
  assert.ok(ok.games >= 1);
  assert.ok(!ok.byId['2'] || ok.games === played.filter((g) => isFbsTeamId(g.hid) && isFbsTeamId(g.aid)).length);
}

// Live 9:30 odds request: US + US2 + EU, three markets, no bookmaker filter.
{
  const url = ingest.buildOddsUrl(config.ODDS_SPORT_KEYS.NHL, 'test-key', null);
  assert.ok(url.startsWith('https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds?'));
  assert.ok(url.includes('regions=us,us2,eu'));
  assert.ok(url.includes('markets=h2h,spreads,totals'));
  assert.ok(!/bookmakers=/.test(url));
  assert.strictEqual(ingest.ODDS_REGIONS, 'us,us2,eu');
  assert.strictEqual(ingest.ODDS_MARKETS, 'h2h,spreads,totals');
  const historical = ingest.buildOddsUrl('icehockey_nhl', 'test-key', '2026-10-10T13:30:00Z');
  assert.ok(historical.includes('/historical/sports/icehockey_nhl/odds?'));
  assert.ok(historical.includes('date=2026-10-10T13%3A30%3A00Z'));
  assert.ok(!/bookmakers=/.test(historical));
}

// Plays constant still converts a seed the way the solver documents.
assert.strictEqual(PLAYS, 68);

// Defense is points prevented by the opponent, not the scoring team's own offense.
// A planted round robin must come back as the same off/def (prior K = 0).
{
  const planted = {
    '2': { o: 8, d: 6 },
    '5': { o: -4, d: 2 },
    '12': { o: 2, d: -6 },
    '9': { o: -6, d: -2 },
  };
  const half = 24;
  const hfa = 2.6;
  const ids = Object.keys(planted);
  const rows = [];
  for (const h of ids) {
    for (const a of ids) {
      if (h === a) continue;
      rows.push({
        hid: h,
        aid: a,
        hs: Math.round(half + planted[h].o - planted[a].d + hfa / 2),
        as: Math.round(half + planted[a].o - planted[h].d - hfa / 2),
        commence: '2026-09-12T20:00:00Z',
      });
    }
  }
  const pack = epa.solveNcaafOpponentRatings([boardFrom(rows)], {
    asOf: '2026-10-10',
    efficiency: {},
    minGames: 1,
    priorGames: 0,
    iters: 40,
    hfa,
  });
  assert.ok(pack && pack.games === rows.length);
  for (const id of ids) {
    const fit = pack.byId[id];
    assert.ok(Math.abs(fit.off - planted[id].o) < 0.05, `${id} off ${fit.off}`);
    assert.ok(Math.abs(fit.def - planted[id].d) < 0.05, `${id} def ${fit.def}`);
  }
}

// Pace prior comes from the seed table's own dispersion, not from a slate.
{
  assert.strictEqual(epa.ncaafPacePriorGames({}), null);
  assert.strictEqual(epa.ncaafPacePriorGames(null), null);
  const centered = epa.centerSeed(require(path.join(root, 'sports/data/cfb-epa-seed.json')));
  const k = epa.ncaafPacePriorGames(centered);
  const paces = [];
  for (const [key, row] of Object.entries(centered)) {
    if (!key || key.startsWith('_') || !epa.isCleanEpa(row)) continue;
    paces.push((Number(row.offEpa) - Number(row.defEpa)) * PLAYS);
  }
  assert.ok(paces.length >= 8);
  const mean = paces.reduce((s, x) => s + x, 0) / paces.length;
  const variance = paces.reduce((s, x) => s + (x - mean) ** 2, 0) / paces.length;
  const expectK = Math.round((config.SPORT_TOTAL_STD.NCAAF ** 2) / variance);
  assert.strictEqual(k, expectK);
  assert.ok(k > epa.NCAAF_OA_PRIOR_GAMES, `pace K ${k} should exceed strength K`);
}

// Same scores. A larger pace prior pulls a high-total team in on pace and
// leaves its strength, which still uses K = 2, much closer to the loose fit.
{
  const dates = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'];
  const base = [];
  for (const d of dates) {
    base.push(game('5', '12', 24, 24, { commence: `${d}T16:00:00Z` }));
    base.push(game('12', '9', 24, 24, { commence: `${d}T19:00:00Z` }));
    base.push(game('9', '5', 24, 24, { commence: `${d}T22:00:00Z` }));
    base.push(game('2', '5', 45, 17, { commence: `${d}T23:00:00Z` }));
  }
  function side(k) {
    const pack = epa.solveNcaafOpponentRatings([boardFrom(base)], {
      asOf: '2026-10-10',
      efficiency: {},
      minGames: 1,
      pacePriorGames: k,
      iters: 30,
    });
    const fit = pack.byId['2'];
    return { pace: fit.off - fit.def, str: fit.off + fit.def };
  }
  const loose = side(2);
  const tight = side(14);
  assert.ok(loose.pace > tight.pace, `pace ${loose.pace} -> ${tight.pace}`);
  assert.ok(tight.pace > 0, tight.pace);
  assert.ok(Math.abs(tight.str - loose.str) < (loose.pace - tight.pace),
    `strength moved ${tight.str - loose.str} pace moved ${loose.pace - tight.pace}`);
}

const { LEAGUE_PPG, powerFromStandings } = require(path.join(root, 'sports/_common'));
const { resolveTeamId } = require(path.join(root, 'sports/team_identity'));

assert.strictEqual(epa.SPORT_CFG.NCAAF.leaguePpg * 2, epa.SPORT_CFG.NCAAF.baseTotal);
assert.strictEqual(LEAGUE_PPG.NCAAF, epa.SPORT_CFG.NCAAF.leaguePpg);
assert.strictEqual(epa.SPORT_CFG.NFL.baseTotal, 45);
assert.strictEqual(epa.SPORT_CFG.NFL.leaguePpg, 22);

// Short schedule still has a league center. The rating pack stays withheld.
{
  const boards = [boardFrom([
    game('2', '5', 24, 20),
    game('5', '12', 30, 27),
  ])];
  const center = epa.ncaafFbsLeagueTotal(boards, { asOf: '2026-10-10' });
  assert.ok(center);
  assert.strictEqual(center.games, 2);
  assert.strictEqual(center.leagueTotal, (44 + 57) / 2);
  assert.strictEqual(epa.solveNcaafOpponentRatings(boards, { asOf: '2026-10-10', efficiency: {} }), null);
}

function oldAbsTotal(homeSt, awaySt) {
  const hPow = powerFromStandings(homeSt, 'NCAAF');
  const aPow = powerFromStandings(awaySt, 'NCAAF');
  return 52 + Math.abs(hPow + aPow) * 0.04;
}

// Two low-scoring teams. The old abs(net) term raised the total. The
// league-centered pace term lowers it. Margin stays the point differential.
{
  const home = 'Ball State Cardinals';
  const away = 'Northern Illinois Huskies';
  const homeSt = { pf: 80, pa: 140, gamesPlayed: 5 };
  const awaySt = { pf: 80, pa: 140, gamesPlayed: 5 };
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away,
    standings: { [home]: homeSt, [away]: awaySt },
    efficiency: {},
    hfa: 2.6,
  });
  const hPow = powerFromStandings(homeSt, 'NCAAF');
  const aPow = powerFromStandings(awaySt, 'NCAAF');
  assert.strictEqual(proj.usedEpa, false);
  assert.ok(Math.abs(proj.modelMargin - ((hPow - aPow) + 2.6)) < 1e-9);
  assert.ok(proj.modelTotal < 52, proj.modelTotal);
  assert.ok(proj.modelTotal < oldAbsTotal(homeSt, awaySt), proj.modelTotal);
  assert.ok(proj.modelTotal > epa.SPORT_CFG.NCAAF.totalMin);
}

// Negative net with a high pace raises the total off the league center.
{
  const home = 'Ball State Cardinals';
  const away = 'Northern Illinois Huskies';
  const st = { pf: 150, pa: 170, gamesPlayed: 5 };
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away,
    standings: { [home]: st, [away]: st },
    efficiency: {},
    hfa: 2.6,
  });
  assert.strictEqual(proj.usedEpa, false);
  assert.ok(Math.abs(proj.modelMargin - 2.6) < 1e-9, proj.modelMargin);
  assert.ok(proj.modelTotal > 52, proj.modelTotal);
  assert.ok(proj.modelTotal > oldAbsTotal(st, st), proj.modelTotal);
}

// One EPA side. The other side is regressed, not dropped to raw differential.
{
  const home = 'Boise State Broncos';
  const away = 'Western Michigan Broncos';
  const awaySt = { pf: 50, pa: 150, gamesPlayed: 5 };
  const hfa = 2.6;
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away,
    standings: { [away]: awaySt },
    efficiency: { [home]: { offEpa: 0.05, defEpa: 0.05 } },
    hfa,
  });
  const plays = epa.SPORT_CFG.NCAAF.plays;
  const g = 5;
  const w = g / (g + epa.NCAAF_OA_PRIOR_GAMES);
  const pfPg = 10;
  const paPg = 30;
  const S = w * (pfPg - paPg);
  const P = w * (pfPg + paPg - 2 * epa.SPORT_CFG.NCAAF.leaguePpg);
  const aOff = ((S + P) / 2) / plays;
  const aDef = ((S - P) / 2) / plays;
  const hOff = 0.05;
  const hDef = 0.05;
  const margin = ((hOff - aDef) - (aOff - hDef)) * plays + hfa;
  const total = 52 + ((hOff - aDef) + (aOff - hDef)) * plays;
  assert.strictEqual(proj.usedEpa, true);
  assert.strictEqual(proj.methods.family, 'cfb-epa-v1');
  assert.ok(Math.abs(proj.modelMargin - margin) < 1e-9, `${proj.modelMargin} vs ${margin}`);
  assert.ok(Math.abs(proj.modelTotal - total) < 1e-9, `${proj.modelTotal} vs ${total}`);
  const raw = powerFromStandings(null, 'NCAAF') - powerFromStandings(awaySt, 'NCAAF') + hfa;
  assert.ok(Math.abs(proj.modelMargin - raw) > 1);
}

// A stored close-game mean replaces 52. The shared cfg is not mutated.
{
  const home = 'Auburn Tigers';
  const away = 'UAB Blazers';
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away, standings: {},
    efficiency: {
      [home]: { offEpa: 0, defEpa: 0 },
      [away]: { offEpa: 0, defEpa: 0 },
      _leagueTotal: 51.4,
    },
  });
  assert.ok(Math.abs(proj.modelTotal - 51.4) < 1e-9, proj.modelTotal);
  assert.strictEqual(epa.SPORT_CFG.NCAAF.baseTotal, 52);
  assert.strictEqual(epa.SPORT_CFG.NCAAF.leaguePpg, 26);
  const flat = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Not A Real University',
    away: 'Also Not Real',
    standings: {},
    efficiency: { _leagueTotal: 51.4 },
  });
  assert.ok(Math.abs(flat.modelTotal - 51.4) < 1e-9, flat.modelTotal);
  assert.strictEqual(epa.SPORT_CFG.NCAAF.baseTotal, 52);
}

// Opponent-adjusted pack wins over the one-sided EPA path.
{
  const home = 'Boise State Broncos';
  const away = 'Western Michigan Broncos';
  const homeId = resolveTeamId('NCAAF', home);
  const awayId = resolveTeamId('NCAAF', away);
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away, standings: {},
    efficiency: {
      [home]: { offEpa: 0.2, defEpa: 0.2 },
      _oa: {
        byId: { [homeId]: { off: 4, def: 2 }, [awayId]: { off: -1, def: -1 } },
        leagueTotal: 51,
        games: 50,
      },
    },
    hfa: 2.6,
  });
  assert.strictEqual(proj.methods.family, 'cfb-oa-v1');
  assert.strictEqual(proj.usedEpa, false);
  assert.ok(Math.abs(proj.modelMargin - ((4 + 2) - (-1 + -1) + 2.6)) < 1e-9);
  assert.ok(Math.abs(proj.modelTotal - (51 + (4 - 2) + (-1 - -1))) < 1e-9);
}

// No ESPN id: the known side keeps standings power. Its EPA is not used.
{
  const home = 'Boise State Broncos';
  const homeSt = { pf: 180, pa: 80, gamesPlayed: 5 };
  const proj = epa.footballProjection({
    sport: 'NCAAF',
    home,
    away: 'Not A Real University',
    standings: { [home]: homeSt },
    efficiency: { [home]: { offEpa: 0.1, defEpa: 0.1 } },
    hfa: 2.6,
  });
  const homePow = powerFromStandings(homeSt, 'NCAAF');
  assert.strictEqual(proj.unknownTeam, true);
  assert.strictEqual(proj.usedEpa, false);
  assert.ok(Math.abs(proj.modelMargin - (homePow + 2.6)) < 1e-9);
  assert.ok(Math.abs(proj.modelTotal - 52) < 1e-9, proj.modelTotal);
  assert.ok(Math.abs(proj.modelTotal - (52 + Math.abs(homePow) * 0.04)) > 0.1);
}

console.log('test-omega-ncaaf-oa: ok');
