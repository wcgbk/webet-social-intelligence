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

console.log('test-omega-ncaaf-oa: ok');
