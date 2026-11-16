'use strict';

/**
 * NHL unconfirmed-goalie veto and shadow. Offline.
 * Fixture: /workspace/sharp-fix-1115/j/nhl-scoreboard.json (ESPN, 2026-11-15).
 * Default mode is off.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { nhlGoalieMode } = require('./netlify/functions/lib/omega-v2/constants');
const { annotateCandidate, selectForcedTop3 } = require('./netlify/functions/lib/omega-v2/select');
const { applyStatusVeto } = require('./netlify/functions/lib/omega-v2/status_veto');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const {
  buildNhlGoalieReport,
  fetchNhlGoalieReport,
  nhlScoreboardUrl,
  NHL_SCOREBOARD_URL,
  NHL_GOALIE_TIMEOUT_MS,
} = require('./netlify/functions/lib/omega-vnext/status_pull');

const FIX = '/workspace/sharp-fix-1115/j';
const COMMENCE = '2026-12-20T00:00:00Z';
const PULLED = '2026-11-15T15:15:00.000Z';
const saved = {
  goalie: process.env.OMEGA_V2_NHL_GOALIE,
  force: process.env.OMEGA_V2_FORCE_TOP3,
  injury: process.env.OMEGA_V2_NBA_INJURY,
};

function restore() {
  if (saved.goalie == null) delete process.env.OMEGA_V2_NHL_GOALIE;
  else process.env.OMEGA_V2_NHL_GOALIE = saved.goalie;
  if (saved.force == null) delete process.env.OMEGA_V2_FORCE_TOP3;
  else process.env.OMEGA_V2_FORCE_TOP3 = saved.force;
  if (saved.injury == null) delete process.env.OMEGA_V2_NBA_INJURY;
  else process.env.OMEGA_V2_NBA_INJURY = saved.injury;
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

delete process.env.OMEGA_V2_NHL_GOALIE;
assert.strictEqual(nhlGoalieMode(), 'off');
assert.strictEqual(nhlGoalieMode({}), 'off');
for (const off of ['', '  ', 'off', '0', 'false', 'OFF']) {
  assert.strictEqual(nhlGoalieMode({ OMEGA_V2_NHL_GOALIE: off }), 'off', `off ${JSON.stringify(off)}`);
}
assert.strictEqual(nhlGoalieMode({ OMEGA_V2_NHL_GOALIE: 'shadow' }), 'shadow');
assert.strictEqual(nhlGoalieMode({ OMEGA_V2_NHL_GOALIE: 'SHADOW' }), 'shadow');
for (const on of ['veto', 'on', '1', 'true', 'yes', 'VETO']) {
  assert.strictEqual(nhlGoalieMode({ OMEGA_V2_NHL_GOALIE: on }), 'veto', `veto ${on}`);
}
assert.strictEqual(nhlGoalieMode({ OMEGA_V2_NHL_GOALIE: 'maybe' }), 'off');
assert.strictEqual(NHL_GOALIE_TIMEOUT_MS, 5000);
assert.strictEqual(
  nhlScoreboardUrl('2026-11-15'),
  `${NHL_SCOREBOARD_URL}?dates=20261115`,
);
assert.strictEqual(nhlScoreboardUrl(''), NHL_SCOREBOARD_URL);
assert.strictEqual(nhlScoreboardUrl('not-a-date'), NHL_SCOREBOARD_URL);

const scoreboard = readJson('nhl-scoreboard.json');
const report = buildNhlGoalieReport(scoreboard, { pulledAt: PULLED });
assert.strictEqual(report.ok, true);
assert.strictEqual(report.softFail, false);
assert.strictEqual(report.pulledAt, PULLED);
assert.strictEqual(report.gamesOnBoard, 5);
assert.strictEqual(report.confirmedGames, 2);
assert.strictEqual(report.source, NHL_SCOREBOARD_URL);

const byMatch = {};
for (const game of report.games) byMatch[`${game.away} @ ${game.home}`] = game;
assert.strictEqual(byMatch['Edmonton Oilers @ Philadelphia Flyers'].bothConfirmed, true);
assert.strictEqual(byMatch['Nashville Predators @ San Jose Sharks'].bothConfirmed, true);
assert.strictEqual(byMatch['Nashville Predators @ San Jose Sharks'].homeGoalie.name, 'Alex Nedeljkovic');
assert.strictEqual(byMatch['Florida Panthers @ Dallas Stars'].bothConfirmed, false);
assert.strictEqual(byMatch['Florida Panthers @ Dallas Stars'].homeGoalie.status, 'expected');
assert.strictEqual(byMatch['Florida Panthers @ Dallas Stars'].homeGoalie.confirmed, false);
assert.strictEqual(byMatch['Florida Panthers @ Dallas Stars'].awayGoalie.confirmed, true);
assert.strictEqual(byMatch['Calgary Flames @ Anaheim Ducks'].homeGoalie.name, 'Ville Husso');
assert.strictEqual(byMatch['Calgary Flames @ Anaheim Ducks'].bothConfirmed, false);
assert.strictEqual(byMatch['Vancouver Canucks @ Vegas Golden Knights'].awayGoalie.status, 'expected');
assert.strictEqual(byMatch['Vancouver Canucks @ Vegas Golden Knights'].homeGoalie.status, 'expected');
assert.strictEqual(byMatch['Vancouver Canucks @ Vegas Golden Knights'].bothConfirmed, false);

const starterBody = {
  events: [{
    competitions: [{
      competitors: [
        {
          homeAway: 'away',
          team: { displayName: 'Alpha Team' },
          probables: [{
            name: 'probableStartingGoalie',
            athlete: { displayName: 'Starter Goalie', position: { abbreviation: 'G' } },
            starter: true,
            status: { type: 'expected', name: 'Expected' },
          }],
        },
        {
          homeAway: 'home',
          team: { displayName: 'Beta Team' },
          probables: [{
            name: 'probableStartingGoalie',
            athlete: { displayName: 'Maybe Goalie', position: { abbreviation: 'G' } },
            status: { type: 'probable', name: 'Probable' },
          }],
        },
      ],
    }],
  }, {
    competitions: [{
      competitors: [
        { homeAway: 'away', team: { displayName: 'Gamma Team' }, probables: [] },
        {
          homeAway: 'home',
          team: { displayName: 'Delta Team' },
          probables: [{
            name: 'probableStartingSkater',
            athlete: { displayName: 'Skater Only', position: { abbreviation: 'C' } },
            status: { type: 'confirmed', name: 'Confirmed' },
          }],
        },
      ],
    }],
  }],
};
const synthetic = buildNhlGoalieReport(starterBody, { pulledAt: PULLED });
assert.strictEqual(synthetic.gamesOnBoard, 2);
assert.strictEqual(synthetic.games[0].awayGoalie.confirmed, true, 'starter true counts as confirmed');
assert.strictEqual(synthetic.games[0].awayGoalie.status, 'expected');
assert.strictEqual(synthetic.games[0].homeGoalie.confirmed, false);
assert.strictEqual(synthetic.games[0].bothConfirmed, false);
assert.strictEqual(synthetic.games[1].homeGoalie.status, 'missing', 'a skater slot is not a goalie');
assert.strictEqual(synthetic.games[1].bothConfirmed, false);
assert.strictEqual(buildNhlGoalieReport(null, { pulledAt: PULLED }).softFail, true);

const baseEnv = { OMEGA_V2_MARKET_P: 'on', OMEGA_V2_LONGSHOT_ADJ: 'off', OMEGA_V2_NBA_INJURY: 'off' };
const offEnv = { ...baseEnv, OMEGA_V2_NHL_GOALIE: 'off' };
const vetoEnv = { ...baseEnv, OMEGA_V2_NHL_GOALIE: 'veto' };
const shadowEnv = { ...baseEnv, OMEGA_V2_NHL_GOALIE: 'shadow' };

function raw(over) {
  return {
    sport: 'NHL',
    matchup: 'Vancouver Canucks @ Vegas Golden Knights',
    awayTeam: 'Vancouver Canucks',
    homeTeam: 'Vegas Golden Knights',
    pick: 'Vegas Golden Knights ML',
    market: 'Moneyline',
    odds: -110,
    book: 'draftkings',
    commenceTime: COMMENCE,
    calibration: { pCal: 0.56, pMkt: 0.56, pModel: 0.40, method: 'board' },
    ...over,
  };
}

const same = raw();
const untouched = applyStatusVeto(same, { env: offEnv, nhlGoalies: report });
assert.strictEqual(untouched, same, 'flag off returns the same row');
assert.strictEqual(untouched.statusVeto, undefined);
assert.strictEqual(untouched.statusShadow, undefined);

const missingReport = applyStatusVeto(raw(), { env: vetoEnv, nhlGoalies: null });
assert.strictEqual(missingReport.qualified, undefined);
assert.strictEqual(missingReport.statusVeto, undefined);

const off = annotateCandidate(raw(), { forceTop3: true, env: offEnv, nhlGoalies: report });
assert.strictEqual(off.qualified, true);
assert.strictEqual(off.statusVeto, undefined);
assert.strictEqual(off.statusShadow, undefined);
assert.strictEqual(off.pBet, 0.56);

const hit = annotateCandidate(raw(), { forceTop3: true, env: vetoEnv, nhlGoalies: report });
assert.strictEqual(hit.qualified, false);
assert.strictEqual(hit.parlayQualified, false);
assert.strictEqual(hit.forcePlaceable, false);
assert.strictEqual(hit.rejectReason, 'nhl-goalie-unconfirmed');
assert.strictEqual(hit.statusVeto.dropped, true);
assert.strictEqual(hit.statusVeto.homeGoalie.name, 'Carter Hart');
assert.strictEqual(hit.statusShadow, undefined);

const oneSide = annotateCandidate(raw({
  matchup: 'Florida Panthers @ Dallas Stars',
  awayTeam: 'Florida Panthers',
  homeTeam: 'Dallas Stars',
  pick: 'Dallas Stars ML',
}), { forceTop3: true, env: vetoEnv, nhlGoalies: report });
assert.strictEqual(oneSide.qualified, false, 'either goalie unconfirmed drops the game');

const confirmed = annotateCandidate(raw({
  matchup: 'Edmonton Oilers @ Philadelphia Flyers',
  awayTeam: 'Edmonton Oilers',
  homeTeam: 'Philadelphia Flyers',
  pick: 'Philadelphia Flyers ML',
}), { forceTop3: true, env: vetoEnv, nhlGoalies: report });
assert.strictEqual(confirmed.qualified, true, 'both confirmed stays');
assert.strictEqual(confirmed.statusVeto, undefined);

const absent = annotateCandidate(raw({
  matchup: 'Boston Bruins @ Toronto Maple Leafs',
  awayTeam: 'Boston Bruins',
  homeTeam: 'Toronto Maple Leafs',
  pick: 'Toronto Maple Leafs ML',
}), { forceTop3: true, env: vetoEnv, nhlGoalies: report });
assert.strictEqual(absent.qualified, true, 'a game missing from the scoreboard is not a veto');

const nba = annotateCandidate(raw({
  sport: 'NBA',
  matchup: 'Boston Celtics @ Philadelphia 76ers',
  awayTeam: 'Boston Celtics',
  homeTeam: 'Philadelphia 76ers',
  pick: 'Philadelphia 76ers ML',
}), { forceTop3: true, env: vetoEnv, nhlGoalies: report });
assert.strictEqual(nba.qualified, true, 'non-NHL is untouched');

const soft = annotateCandidate(raw(), {
  forceTop3: true,
  env: vetoEnv,
  nhlGoalies: { ok: false, softFail: true, pulledAt: PULLED, games: [] },
});
assert.strictEqual(soft.qualified, true, 'soft-fail does not drop the slate');

const shadow = annotateCandidate(raw(), { forceTop3: true, env: shadowEnv, nhlGoalies: report });
assert.strictEqual(shadow.qualified, true, 'shadow keeps the candidate');
assert.strictEqual(shadow.parlayQualified, true);
assert.strictEqual(shadow.statusVeto, undefined);
assert.strictEqual(shadow.statusShadow.dropped, false);
assert.strictEqual(shadow.statusShadow.kind, 'nhl-goalie-unconfirmed');
assert.strictEqual(shadow.statusShadow.awayGoalie.name, 'Leevi Merilainen');

function game(matchup, away, home, pick, pMkt, env) {
  return annotateCandidate({
    sport: 'NHL',
    matchup,
    awayTeam: away,
    homeTeam: home,
    pick,
    market: 'Moneyline',
    odds: -110,
    book: 'draftkings',
    commenceTime: COMMENCE,
    calibration: { pCal: pMkt, pMkt, pModel: 0.4, method: 'board' },
  }, { forceTop3: true, env, nhlGoalies: report });
}

const pool = [
  game('Vancouver Canucks @ Vegas Golden Knights', 'Vancouver Canucks', 'Vegas Golden Knights', 'Vegas Golden Knights ML', 0.58, vetoEnv),
  game('Edmonton Oilers @ Philadelphia Flyers', 'Edmonton Oilers', 'Philadelphia Flyers', 'Philadelphia Flyers ML', 0.55, vetoEnv),
  game('Nashville Predators @ San Jose Sharks', 'Nashville Predators', 'San Jose Sharks', 'San Jose Sharks ML', 0.54, vetoEnv),
  game('Boston Bruins @ Toronto Maple Leafs', 'Boston Bruins', 'Toronto Maple Leafs', 'Toronto Maple Leafs ML', 0.53, vetoEnv),
];
assert.strictEqual(pool[0].qualified, false);
assert.strictEqual(pool[1].qualified, true);
const picked = selectForcedTop3(pool, { forceTop3: true, env: vetoEnv }).map((row) => row.pick);
assert.deepStrictEqual(picked, ['Philadelphia Flyers ML', 'San Jose Sharks ML', 'Toronto Maple Leafs ML']);

const shadowPool = [
  game('Vancouver Canucks @ Vegas Golden Knights', 'Vancouver Canucks', 'Vegas Golden Knights', 'Vegas Golden Knights ML', 0.58, shadowEnv),
  game('Edmonton Oilers @ Philadelphia Flyers', 'Edmonton Oilers', 'Philadelphia Flyers', 'Philadelphia Flyers ML', 0.55, shadowEnv),
  game('Nashville Predators @ San Jose Sharks', 'Nashville Predators', 'San Jose Sharks', 'San Jose Sharks ML', 0.54, shadowEnv),
  game('Boston Bruins @ Toronto Maple Leafs', 'Boston Bruins', 'Toronto Maple Leafs', 'Toronto Maple Leafs ML', 0.53, shadowEnv),
];
const shadowPicked = selectForcedTop3(shadowPool, { forceTop3: true, env: shadowEnv }).map((row) => row.pick);
assert.deepStrictEqual(shadowPicked, ['Vegas Golden Knights ML', 'Philadelphia Flyers ML', 'San Jose Sharks ML']);

async function main() {
  const calls = [];
  const fetched = await fetchNhlGoalieReport({
    dateISO: '2026-11-15',
    timeoutMs: 5000,
    now: PULLED,
    fetchImpl: (url) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: async () => scoreboard });
    },
  });
  assert.deepStrictEqual(calls, [`${NHL_SCOREBOARD_URL}?dates=20261115`]);
  assert.strictEqual(fetched.confirmedGames, 2);
  assert.strictEqual(fetched.gamesOnBoard, 5);
  assert.strictEqual(fetched.pulledAt, PULLED);
  assert.strictEqual(fetched.source, calls[0]);

  const hung = await fetchNhlGoalieReport({
    dateISO: '2026-11-15',
    timeoutMs: 30,
    now: PULLED,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.strictEqual(hung.ok, false);
  assert.strictEqual(hung.softFail, true);
  assert.strictEqual(hung.pulledAt, PULLED);
  assert.deepStrictEqual(hung.games, []);

  const thrown = await fetchNhlGoalieReport({
    now: PULLED,
    fetchImpl: () => { throw new Error('espn down'); },
  });
  assert.strictEqual(thrown.softFail, true);
  assert.strictEqual(thrown.error, 'soft-fail');

  const httpFail = await fetchNhlGoalieReport({
    now: PULLED,
    fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.strictEqual(httpFail.softFail, true);

  const gen = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  assert.ok(gen.includes('fetchNhlGoalieReport({ timeoutMs: 5000, dateISO })'), 'generate caps the pull at 5s');
  assert.ok(gen.includes("!replayLike && nhlGoalieMode() !== 'off'"), 'replay and flag off do not pull');
  const pullSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/status_pull.js'), 'utf8');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(pullSrc));
  const vetoSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-v2/status_veto.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(vetoSrc));

  process.env.OMEGA_V2_FORCE_TOP3 = '1';
  process.env.OMEGA_V2_NBA_INJURY = 'off';
  delete process.env.OMEGA_V2_NHL_GOALIE;
  const baseInput = {
    date: '2026-12-20',
    dateFormatted: 'Saturday, December 20, 2026',
    history: [],
    gradedBoardRows: [],
    marketSkill: 'off',
    candidates: [
      {
        sport: 'NHL', matchup: 'Vancouver Canucks @ Vegas Golden Knights',
        awayTeam: 'Vancouver Canucks', homeTeam: 'Vegas Golden Knights',
        side: 'Vegas Golden Knights ML', market: 'Moneyline', odds: -110, book: 'draftkings',
        pModel: 0.4, pMkt: 0.58, commenceTime: COMMENCE,
      },
      {
        sport: 'NHL', matchup: 'Edmonton Oilers @ Philadelphia Flyers',
        awayTeam: 'Edmonton Oilers', homeTeam: 'Philadelphia Flyers',
        side: 'Philadelphia Flyers ML', market: 'Moneyline', odds: -110, book: 'draftkings',
        pModel: 0.4, pMkt: 0.55, commenceTime: COMMENCE,
      },
      {
        sport: 'NHL', matchup: 'Nashville Predators @ San Jose Sharks',
        awayTeam: 'Nashville Predators', homeTeam: 'San Jose Sharks',
        side: 'San Jose Sharks ML', market: 'Moneyline', odds: -110, book: 'draftkings',
        pModel: 0.4, pMkt: 0.54, commenceTime: COMMENCE,
      },
      {
        sport: 'NHL', matchup: 'Boston Bruins @ Toronto Maple Leafs',
        awayTeam: 'Boston Bruins', homeTeam: 'Toronto Maple Leafs',
        side: 'Toronto Maple Leafs ML', market: 'Moneyline', odds: -110, book: 'draftkings',
        pModel: 0.4, pMkt: 0.53, commenceTime: COMMENCE,
      },
    ],
  };

  process.env.OMEGA_V2_NHL_GOALIE = 'off';
  const offCard = await buildCard({ ...baseInput, nhlGoalies: report });
  assert.strictEqual(offCard.diagnostics, undefined, 'flag off adds no diagnostics field');
  assert.ok(offCard.picks.some((p) => p.pick === 'Vegas Golden Knights ML'));

  process.env.OMEGA_V2_NHL_GOALIE = 'veto';
  const vetoCard = await buildCard({ ...baseInput, nhlGoalies: report });
  assert.deepStrictEqual(vetoCard.picks.map((p) => p.pick), [
    'Philadelphia Flyers ML',
    'San Jose Sharks ML',
    'Toronto Maple Leafs ML',
  ]);
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.mode, 'veto');
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.pulledAt, PULLED);
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.gamesOnBoard, 5);
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.confirmedGames, 2);
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.softFail, false);
  assert.ok(vetoCard.diagnostics.nhlGoalie.vetoes.some((v) => v.pick === 'Vegas Golden Knights ML'));
  assert.strictEqual(vetoCard.diagnostics.nhlGoalie.wouldVeto.length, 0);
  assert.ok((vetoCard.rejections || []).some((r) => r.reason === 'nhl-goalie-unconfirmed'));
  assert.ok(!JSON.stringify(vetoCard.picks).includes('Carter Hart'));
  assert.ok(!String(vetoCard.edgeSummary || '').includes('Carter Hart'));
  assert.ok(!String(vetoCard.insights || '').includes('Leevi Merilainen'));
  assert.strictEqual(vetoCard.diagnostics.nbaInjury, undefined);

  process.env.OMEGA_V2_NHL_GOALIE = 'shadow';
  const shadowCard = await buildCard({ ...baseInput, nhlGoalies: report });
  assert.ok(shadowCard.picks.some((p) => p.pick === 'Vegas Golden Knights ML'), 'shadow does not drop');
  assert.strictEqual(shadowCard.diagnostics.nhlGoalie.mode, 'shadow');
  assert.strictEqual(shadowCard.diagnostics.nhlGoalie.vetoes.length, 0);
  assert.deepStrictEqual(
    shadowCard.diagnostics.nhlGoalie.wouldVeto.map((v) => v.pick),
    ['Vegas Golden Knights ML'],
  );
  assert.ok(!shadowCard.diagnostics.nhlGoalie.wouldVeto.some((v) => v.pick === 'Philadelphia Flyers ML'));

  process.env.OMEGA_V2_NHL_GOALIE = 'on';
  const onCard = await buildCard({ ...baseInput, nhlGoalies: report });
  assert.ok(!onCard.picks.some((p) => p.pick === 'Vegas Golden Knights ML'), 'on is the veto mode');

  restore();
  console.log('PASS nhl goalie veto');
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
