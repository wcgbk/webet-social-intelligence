'use strict';
// NCAAF standings fallback. Fixture only — no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network disabled');
};

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const ingest = require(path.join(root, 'ingest'));
const epa = require(path.join(root, 'sports/epa'));
const cfb = require(path.join(root, 'sports/cfb'));
const { powerFromStandings } = require(path.join(root, 'sports/_common'));
const { cfbStandingsFixEnabled } = require(path.join(root, 'gaps_flags'));

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'tests/fixtures/omega-cfb-standings-fix.json'),
  'utf8'
));

const FLAG = 'OMEGA_CFB_STANDINGS_FIX';

function withFlag(value, fn) {
  const prev = process.env[FLAG];
  if (value == null) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

function rating(entry, label, flag) {
  return withFlag(flag, () => ingest.ratingFromEspnEntry(entry, label).rating);
}

function synthEvent(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-11-24T17:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -5.5 },
          { name: away, price: -110, point: 5.5 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 48.5 },
          { name: 'Under', price: -110, point: 48.5 },
        ]},
      ],
    })),
  };
}

const KENT = 'Kent State Golden Flashes';
const EMU = 'Eastern Michigan Eagles';

{
  assert.strictEqual(withFlag(null, () => cfbStandingsFixEnabled()), true);
  for (const off of ['off', 'OFF', ' off ', '0', 'false', 'no']) {
    assert.strictEqual(withFlag(off, () => cfbStandingsFixEnabled()), false, off);
  }
}

// CFB entry with no losses stat → per-game power from the overall record.
{
  const kent = rating(fixture.kentState, 'NCAAF', null);
  const emu = rating(fixture.easternMichigan, 'NCAAF', null);
  assert.strictEqual(kent.wins, 3);
  assert.strictEqual(kent.losses, 8);
  assert.strictEqual(kent.ties, 0);
  assert.strictEqual(kent.games, 11);
  assert.strictEqual(kent.pf, 160);
  assert.strictEqual(kent.pa, 328);
  assert.strictEqual(emu.wins, 4);
  assert.strictEqual(emu.losses, 7);
  assert.strictEqual(emu.ties, 0);
  assert.strictEqual(emu.games, 11);
  assert.strictEqual(emu.pf, 226);
  assert.strictEqual(emu.pa, 300);
  assert.ok(Math.abs(powerFromStandings(kent, 'NCAAF') - ((160 - 328) / 11)) < 1e-9);
  assert.ok(Math.abs(powerFromStandings(emu, 'NCAAF') - ((226 - 300) / 11)) < 1e-9);

  const tied = rating(fixture.tied, 'NCAAF', null);
  assert.strictEqual(tied.losses, 4);
  assert.strictEqual(tied.ties, 1);
  assert.strictEqual(tied.games, 11);
  assert.ok(Math.abs(powerFromStandings(tied, 'NCAAF') - ((210 - 180) / 11)) < 1e-9);

  const standings = { [KENT]: kent, [EMU]: emu };
  const proj = withFlag(null, () => epa.footballProjection({
    sport: 'NCAAF', home: EMU, away: KENT, standings, efficiency: {},
  }));
  const expected = ((226 - 300) / 11) - ((160 - 328) / 11) + config.HFA.NCAAF;
  assert.ok(Math.abs(proj.modelMargin - expected) < 1e-9);
  assert.ok(Math.abs(proj.modelMargin) < epa.SPORT_CFG.NCAAF.marginCap);
  assert.strictEqual(proj.usedEpa, false);
  assert.strictEqual(proj.methods.spread, 'cfb-normal-spread');
  assert.strictEqual(+proj.modelMargin.toFixed(2), 11.15);

  const slate = withFlag(null, () => cfb.project({
    oddsEvents: [synthEvent(EMU, KENT)],
    standings,
    efficiency: {},
    gameDay: {},
  }));
  const spread = slate.find(c => c.market === 'Spread');
  assert.ok(spread, 'spread candidate');
  assert.strictEqual(spread.projMethod, 'cfb-normal-spread');
  assert.strictEqual(spread.modelProjection, 11.15);
}

// Flag off restores wins-only division and the uncapped 40.1 margin.
{
  const kent = rating(fixture.kentState, 'NCAAF', 'off');
  const emu = rating(fixture.easternMichigan, 'NCAAF', 'off');
  assert.deepStrictEqual(kent, {
    winPct: null, pf: 160, pa: 328, wins: 3, losses: null,
  });
  assert.deepStrictEqual(emu, {
    winPct: null, pf: 226, pa: 300, wins: 4, losses: null,
  });
  assert.strictEqual(powerFromStandings(kent, 'NCAAF'), (160 - 328) / 3);
  assert.strictEqual(powerFromStandings(emu, 'NCAAF'), (226 - 300) / 4);

  const standings = { [KENT]: kent, [EMU]: emu };
  const proj = withFlag('off', () => epa.footballProjection({
    sport: 'NCAAF', home: EMU, away: KENT, standings, efficiency: {},
  }));
  const expected = ((226 - 300) / 4) - ((160 - 328) / 3) + config.HFA.NCAAF;
  assert.strictEqual(proj.modelMargin, expected);
  assert.strictEqual(+proj.modelMargin.toFixed(2), 40.1);
  assert.strictEqual(proj.methods.spread, 'cfb-normal-spread');

  const slate = withFlag('off', () => cfb.project({
    oddsEvents: [synthEvent(EMU, KENT)],
    standings,
    efficiency: {},
    gameDay: {},
  }));
  const spread = slate.find(c => c.market === 'Spread');
  assert.strictEqual(spread.projMethod, 'cfb-normal-spread');
  assert.strictEqual(spread.modelProjection, 40.1);
}

// Standings fallback margin clamps to ±marginCap. Inside the cap it does not move.
{
  const home = { pf: 90, pa: 10, wins: 1, losses: 0 };
  const away = { pf: 10, pa: 90, wins: 0, losses: 1 };
  const raw = (90 - 10) - (10 - 90) + config.HFA.NCAAF;
  assert.ok(raw > epa.SPORT_CFG.NCAAF.marginCap);
  const capped = withFlag(null, () => epa.footballProjection({
    sport: 'NCAAF', home: 'Home', away: 'Away',
    standings: { Home: home, Away: away }, efficiency: {},
  }));
  assert.strictEqual(capped.modelMargin, epa.SPORT_CFG.NCAAF.marginCap);
  assert.strictEqual(capped.modelMargin, 31);
  assert.strictEqual(capped.usedEpa, false);
  assert.strictEqual(capped.methods.spread, 'cfb-normal-spread');

  const flipped = withFlag('on', () => epa.footballProjection({
    sport: 'NCAAF', home: 'Home', away: 'Away',
    standings: { Home: away, Away: home }, efficiency: {},
  }));
  assert.strictEqual(flipped.modelMargin, -31);

  const uncapped = withFlag('off', () => epa.footballProjection({
    sport: 'NCAAF', home: 'Home', away: 'Away',
    standings: { Home: home, Away: away }, efficiency: {},
  }));
  assert.strictEqual(uncapped.modelMargin, raw);

  const mildHome = { pf: 30, pa: 20, wins: 3, losses: 1 };
  const mildAway = { pf: 22, pa: 24, wins: 2, losses: 2 };
  const mild = { Home: mildHome, Away: mildAway };
  const onMild = withFlag(null, () => epa.footballProjection({
    sport: 'NCAAF', home: 'Home', away: 'Away', standings: mild, efficiency: {},
  }));
  const offMild = withFlag('off', () => epa.footballProjection({
    sport: 'NCAAF', home: 'Home', away: 'Away', standings: mild, efficiency: {},
  }));
  assert.strictEqual(onMild.modelMargin, offMild.modelMargin);
  assert.ok(Math.abs(onMild.modelMargin) < 31);
}

// NFL entry that already has losses is unchanged, including vs a bad overall record.
{
  const expected = { winPct: null, pf: 360, pa: 240, wins: 10, losses: 4 };
  const on = rating(fixture.nflWithLosses, 'NFL', null);
  const off = rating(fixture.nflWithLosses, 'NFL', 'off');
  assert.deepStrictEqual(on, expected);
  assert.deepStrictEqual(off, expected);
  assert.strictEqual(on.games, undefined);
  assert.strictEqual(on.ties, undefined);
  const power = (360 - 240) / (10 + 4);
  assert.strictEqual(powerFromStandings(on, 'NFL'), power);
  assert.strictEqual(powerFromStandings(off, 'NFL'), power);
}

console.log('PASS omega cfb standings fix');
