#!/usr/bin/env node
// NFL v2.0-nfl-omega: the /nfl card runs Omega's EXACT engine (computeEdgeTable + gates), NFL only.
// This test exercises the integration on synthetic Odds-API-shaped input (no network / no API key).
const assert = require('assert');
const nfl = require('./netlify/functions/generate-picks-nfl-background');

let failed = 0;
function check(name, fn) {
  const run = (v) => { try { v; console.log('  ok  ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); } };
  return fn().then(() => run(true)).catch(e => { failed++; console.error('  FAIL ' + name + ': ' + e.message); });
}

function book(key, home, away, o) {
  return { key, title: key, markets: [
    { key: 'spreads', outcomes: [ { name: home, price: o.spHo, point: o.spH }, { name: away, price: o.spAo, point: -o.spH } ] },
    { key: 'totals', outcomes: [ { name: 'Over', price: o.ov, point: o.total }, { name: 'Under', price: o.un, point: o.total } ] },
    { key: 'h2h', outcomes: [ { name: home, price: o.mlH }, { name: away, price: o.mlA } ] },
  ] };
}
function game(id, home, away, line, books = ['draftkings','fanduel','betmgm','pinnacle']) {
  const o = { spH: 3, spHo: -110, spAo: -110, total: line, ov: -110, un: -110, mlH: 150, mlA: -170 };
  return { id, commence_time: '2026-11-15T18:00:00Z', home_team: home, away_team: away,
    bookmakers: books.map(k => book(k, home, away, o)) };
}
function espn(home, away, state = 'pre') {
  return { homeTeam: home, awayTeam: away, venue: 'Test Stadium, Chicago', indoor: false,
    date: '2026-11-15T18:00:00Z', homeRecord: '', awayRecord: '', state };
}

(async () => {
  console.log('\nNFL v2.0-nfl-omega (Omega engine integration)');

  await check('MODEL_VERSION is v2.0-nfl-omega', async () => {
    assert.strictEqual(nfl.MODEL_VERSION, 'v2.0-nfl-omega');
  });

  await check('buildEspnData drops started games (Omega prices pre-game only)', async () => {
    const es = nfl.buildEspnData([espn('Carolina Panthers', 'Chicago Bears', 'pre'), espn('X', 'Y', 'in')]);
    assert.strictEqual(es[0].games.length, 1);
    assert.strictEqual(es[0].games[0].home, 'Carolina Panthers');
  });

  await check('best-3 board always fills: even a modest-edge game produces the best available pick', async () => {
    // Omega math, but no hard floor — the card must not gate to zero.
    const g = await nfl.runOmegaNfl([espn('Carolina Panthers', 'Chicago Bears')], [game('w', 'Carolina Panthers', 'Chicago Bears', 47)], {}, {}, true);
    assert.ok(g.candidates.length >= 1, 'engine should produce candidates (spread/total/ML)');
    assert.ok(g.selected.length === 1, 'one game -> one best pick on the card');
  });

  await check('a strong-edge total is the model side, sized up, and ships (no hard floor)', async () => {
    const strong = await nfl.runOmegaNfl([espn('Carolina Panthers', 'Chicago Bears')], [game('s', 'Carolina Panthers', 'Chicago Bears', 52)], {}, {}, true);
    assert.ok(strong.selected.length >= 1, 'strong edge should be selected');
    const picks = nfl.buildFinalPicks(strong.selected, false, 'regular');
    assert.ok(picks.some(p => /Under/.test(p.pick)), 'model side of a 52-total game is the Under');
    assert.ok(picks.every(p => !/Lean/.test(p.rating)), 'straights are graded, never Lean');
  });

  await check('best-3 across a multi-game slate: at most 3 straights, one per game', async () => {
    const es = [espn('Carolina Panthers','Chicago Bears'), espn('Green Bay Packers','Minnesota Vikings'), espn('Detroit Lions','New Orleans Saints'), espn('Kansas City Chiefs','Las Vegas Raiders')];
    const og = [game('1','Carolina Panthers','Chicago Bears',52), game('2','Green Bay Packers','Minnesota Vikings',49), game('3','Detroit Lions','New Orleans Saints',51), game('4','Kansas City Chiefs','Las Vegas Raiders',44)];
    const r = await nfl.runOmegaNfl(es, og, {}, {}, true);
    assert.ok(r.selected.length === 3, 'card fills to exactly 3 on a 4-game slate, got ' + r.selected.length);
    const games = new Set(r.selected.map(c => c.matchup));
    assert.strictEqual(games.size, 3, 'one pick per game');
  });

  await check('never a plus-money dog ML on the card (dogs take the spread, not the ML)', async () => {
    // A near-pickem game with a plus-money home dog — the pick must be a spread/total, never the dog ML.
    const r = await nfl.runOmegaNfl([espn('Carolina Panthers', 'Chicago Bears')], [game('d', 'Carolina Panthers', 'Chicago Bears', 44)], {}, {}, true);
    const picks = nfl.buildFinalPicks(r.selected, false, 'regular');
    assert.ok(picks.every(p => !(p.betType === 'Moneyline' && String(p.odds).startsWith('+'))), 'no plus-money dog ML: ' + picks.map(p=>p.pick+' '+p.odds).join(', '));
  });

  await check('no picks when there are no pre-game games', async () => {
    const none = await nfl.runOmegaNfl([espn('A', 'B', 'in')], [], {}, {}, false);
    assert.strictEqual(none.selected.length, 0);
  });

  if (failed) { console.error('\n' + failed + ' failed'); process.exit(1); }
  console.log('\nall passed');
})();
