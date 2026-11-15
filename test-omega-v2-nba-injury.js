'use strict';

/**
 * NBA uncertain-star veto. Offline. Fixtures are the saved ESPN samples
 * under /workspace/sharp-fix-1115/j/. Flag default is off.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  nbaInjuryEnabled,
} = require('./netlify/functions/lib/omega-v2/constants');
const { annotateCandidate, selectForcedTop3 } = require('./netlify/functions/lib/omega-v2/select');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const {
  uncertainStatus,
  parseInjuryRows,
  parseRatePlayers,
  buildNbaReport,
  fetchNbaInjuryReport,
  NBA_INJURY_TIMEOUT_MS,
  NBA_INJURY_URL,
  NBA_RATES_URL,
} = require('./netlify/functions/lib/omega-vnext/status_pull');

const FIX = '/workspace/sharp-fix-1115/j';
const COMMENCE = '2026-12-20T00:00:00Z';
const saved = {
  injury: process.env.OMEGA_V2_NBA_INJURY,
  force: process.env.OMEGA_V2_FORCE_TOP3,
};

function restore() {
  if (saved.injury == null) delete process.env.OMEGA_V2_NBA_INJURY;
  else process.env.OMEGA_V2_NBA_INJURY = saved.injury;
  if (saved.force == null) delete process.env.OMEGA_V2_FORCE_TOP3;
  else process.env.OMEGA_V2_FORCE_TOP3 = saved.force;
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

delete process.env.OMEGA_V2_NBA_INJURY;
assert.strictEqual(nbaInjuryEnabled(), false, 'unset is off');
assert.strictEqual(nbaInjuryEnabled({}), false, 'missing key is off');
for (const off of ['', '   ', 'off', '0', 'false', 'OFF']) {
  assert.strictEqual(nbaInjuryEnabled({ OMEGA_V2_NBA_INJURY: off }), false, `off ${JSON.stringify(off)}`);
}
for (const on of ['on', '1', 'true', 'yes', 'ON']) {
  assert.strictEqual(nbaInjuryEnabled({ OMEGA_V2_NBA_INJURY: on }), true, `on ${on}`);
}
assert.strictEqual(nbaInjuryEnabled({ OMEGA_V2_NBA_INJURY: 'no' }), false, 'unknown stays off');
assert.strictEqual(NBA_INJURY_TIMEOUT_MS, 5000);

assert.strictEqual(uncertainStatus('Out'), null);
assert.strictEqual(uncertainStatus('Suspension'), null);
assert.strictEqual(uncertainStatus('Probable'), null);
assert.strictEqual(uncertainStatus('Questionable'), 'questionable');
assert.strictEqual(uncertainStatus('Doubtful'), 'doubtful');
assert.strictEqual(uncertainStatus('Day-To-Day'), 'day-to-day');
assert.strictEqual(uncertainStatus('day to day'), 'day-to-day');
assert.strictEqual(uncertainStatus('Game-Time-Decision'), 'game-time-decision');
assert.strictEqual(uncertainStatus('GTD'), 'game-time-decision');

const shape = readJson('nba-byathlete-shape.json');
const shaped = parseRatePlayers(shape);
assert.strictEqual(shaped.length, 1);
assert.strictEqual(shaped[0].name, 'Darius Acuff Jr.');
assert.strictEqual(shaped[0].team, 'Sacramento Kings');
assert.ok(Math.abs(shaped[0].mpg - 37.166668) < 1e-4, `mpg ${shaped[0].mpg}`);
assert.ok(Math.abs(shaped[0].ppg - 25.416666) < 1e-4, `ppg ${shaped[0].ppg}`);

const injuries = readJson('nba-injuries.json');
const rates = readJson('nba-player-rates.json');
const rows = parseInjuryRows(injuries);
const byStatus = {};
for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
assert.strictEqual(rows.length, 102, `injury rows ${rows.length}`);
assert.strictEqual(byStatus.Out, 86);
assert.strictEqual(byStatus['Day-To-Day'], 15);
assert.strictEqual(byStatus.Suspension, 1);

const report = buildNbaReport(injuries, rates, { pulledAt: '2026-11-15T15:15:00.000Z' });
assert.strictEqual(report.ok, true);
assert.strictEqual(report.softFail, false);
assert.strictEqual(report.pulledAt, '2026-11-15T15:15:00.000Z');
assert.strictEqual(report.importance, 'top3-mpg-or-ppg');
assert.strictEqual(report.source, NBA_INJURY_URL);
assert.strictEqual(report.importanceSource, NBA_RATES_URL);
const listed = [];
for (const block of Object.values(report.teams)) {
  for (const player of block.uncertain) {
    listed.push(`${block.team}|${player.name}|${player.status}|mpg${player.mpgRank}|ppg${player.ppgRank}`);
  }
}
listed.sort();
assert.deepStrictEqual(listed, [
  'Detroit Pistons|Duncan Robinson|day-to-day|mpg2|ppg2',
  'Indiana Pacers|Andrew Nembhard|day-to-day|mpg1|ppg2',
  'Oklahoma City Thunder|Ajay Mitchell|day-to-day|mpg2|ppg2',
  'Philadelphia 76ers|Joel Embiid|day-to-day|mpg5|ppg3',
]);
assert.strictEqual(report.uncertainPlayers, 4);
assert.ok(!listed.some((line) => line.includes('Jock Landale')), 'announced Out is not a veto');
assert.ok(!listed.some((line) => line.includes('Jalen Smith')), 'Day-To-Day outside the top 3 is not a veto');

function raw(over) {
  return {
    sport: 'NBA',
    matchup: 'Boston Celtics @ Philadelphia 76ers',
    awayTeam: 'Boston Celtics',
    homeTeam: 'Philadelphia 76ers',
    pick: 'Philadelphia 76ers ML',
    market: 'Moneyline',
    odds: -110,
    book: 'draftkings',
    commenceTime: COMMENCE,
    calibration: { pCal: 0.56, pMkt: 0.56, pModel: 0.50, method: 'board' },
    ...over,
  };
}

const offEnv = { OMEGA_V2_NBA_INJURY: 'off', OMEGA_V2_MARKET_P: 'on', OMEGA_V2_LONGSHOT_ADJ: 'off' };
const onEnv = { ...offEnv, OMEGA_V2_NBA_INJURY: 'on' };
const off = annotateCandidate(raw(), { forceTop3: true, env: offEnv, nbaInjury: report });
const bare = annotateCandidate(raw(), { forceTop3: true, env: {}, nbaInjury: report });
assert.strictEqual(off.qualified, true);
assert.strictEqual(off.statusVeto, undefined);
assert.strictEqual(bare.qualified, true);
assert.strictEqual(bare.statusVeto, undefined);
assert.strictEqual(off.pBet, 0.56, 'market p is the bet probability');
assert.notStrictEqual(off.pBet, off.calibration.pModel);

const hit = annotateCandidate(raw(), { forceTop3: true, env: onEnv, nbaInjury: report });
assert.strictEqual(hit.qualified, false);
assert.strictEqual(hit.parlayQualified, false);
assert.strictEqual(hit.rejectReason, 'nba-uncertain-star');
assert.strictEqual(hit.statusVeto.players[0].name, 'Joel Embiid');
assert.strictEqual(hit.statusVeto.dropped, true);

const total = annotateCandidate(raw({
  pick: 'Over 220.5',
  market: 'Total',
  line: 220.5,
}), { forceTop3: true, env: onEnv, nbaInjury: report });
assert.strictEqual(total.qualified, false, 'every market in the game drops');

const other = annotateCandidate(raw({
  sport: 'NHL',
  matchup: 'Boston Bruins @ Philadelphia Flyers',
  awayTeam: 'Boston Bruins',
  homeTeam: 'Philadelphia Flyers',
  pick: 'Philadelphia Flyers ML',
}), { forceTop3: true, env: onEnv, nbaInjury: report });
assert.strictEqual(other.qualified, true, 'non-NBA is untouched');

const outOnly = buildNbaReport(injuries, rates, { pulledAt: '2026-11-15T15:15:00.000Z' });
const hawks = annotateCandidate(raw({
  matchup: 'Milwaukee Bucks @ Atlanta Hawks',
  awayTeam: 'Milwaukee Bucks',
  homeTeam: 'Atlanta Hawks',
  pick: 'Atlanta Hawks ML',
}), { forceTop3: true, env: onEnv, nbaInjury: outOnly });
assert.strictEqual(hawks.qualified, true, 'Jock Landale Out does not veto the Hawks');

const soft = annotateCandidate(raw(), {
  forceTop3: true,
  env: onEnv,
  nbaInjury: { ok: false, softFail: true, pulledAt: '2026-11-15T15:15:00.000Z', teams: {} },
});
assert.strictEqual(soft.qualified, true, 'soft-fail is a no-op');
assert.strictEqual(soft.statusVeto, undefined);

const missing = annotateCandidate(raw(), { forceTop3: true, env: onEnv, nbaInjury: null });
assert.strictEqual(missing.qualified, true, 'no report does not veto');

function game(matchup, away, home, pick, pMkt) {
  return annotateCandidate({
    sport: 'NBA',
    matchup,
    awayTeam: away,
    homeTeam: home,
    pick,
    market: 'Moneyline',
    odds: -110,
    book: 'draftkings',
    commenceTime: COMMENCE,
    calibration: { pCal: pMkt, pMkt, pModel: 0.4, method: 'board' },
  }, { forceTop3: true, env: onEnv, nbaInjury: report });
}

const pool = [
  game('Boston Celtics @ Philadelphia 76ers', 'Boston Celtics', 'Philadelphia 76ers', 'Philadelphia 76ers ML', 0.58),
  game('Milwaukee Bucks @ Atlanta Hawks', 'Milwaukee Bucks', 'Atlanta Hawks', 'Atlanta Hawks ML', 0.55),
  game('Miami Heat @ New York Knicks', 'Miami Heat', 'New York Knicks', 'New York Knicks ML', 0.54),
  game('Dallas Mavericks @ Denver Nuggets', 'Dallas Mavericks', 'Denver Nuggets', 'Denver Nuggets ML', 0.53),
];
assert.strictEqual(pool[0].qualified, false);
assert.strictEqual(pool[1].qualified, true);
const picked = selectForcedTop3(pool, { forceTop3: true, env: onEnv }).map((row) => row.pick);
assert.deepStrictEqual(picked, ['Atlanta Hawks ML', 'New York Knicks ML', 'Denver Nuggets ML']);

const kept = selectForcedTop3(pool.map((row) => ({ ...row, qualified: true, statusVeto: undefined, rejectReason: null })), {
  forceTop3: true,
  env: offEnv,
});
assert.strictEqual(kept[0].pick, 'Philadelphia 76ers ML', 'flag off keeps the star game in the top 3');

async function main() {
let calls = [];
const fetched = await fetchNbaInjuryReport({
  timeoutMs: 5000,
  now: '2026-11-15T15:15:00.000Z',
  fetchImpl: (url) => {
    calls.push(url);
    const body = url.indexOf('/injuries') >= 0 ? injuries : rates;
    return Promise.resolve({ ok: true, json: async () => body });
  },
});
assert.strictEqual(calls.length, 2);
assert.ok(calls.some((url) => url === NBA_INJURY_URL));
assert.ok(calls.some((url) => url === NBA_RATES_URL));
assert.strictEqual(fetched.uncertainPlayers, 4);
assert.strictEqual(fetched.pulledAt, '2026-11-15T15:15:00.000Z');

const failed = await fetchNbaInjuryReport({
  timeoutMs: 30,
  now: '2026-11-15T15:15:00.000Z',
  fetchImpl: () => new Promise(() => {}),
});
assert.strictEqual(failed.ok, false);
assert.strictEqual(failed.softFail, true);
assert.strictEqual(failed.pulledAt, '2026-11-15T15:15:00.000Z');
assert.deepStrictEqual(failed.teams, {});

const thrown = await fetchNbaInjuryReport({
  now: '2026-11-15T15:15:00.000Z',
  fetchImpl: () => { throw new Error('espn down'); },
});
assert.strictEqual(thrown.softFail, true);
assert.strictEqual(thrown.error, 'soft-fail');

const gen = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
assert.ok(gen.includes('fetchNbaInjuryReport({ timeoutMs: 5000 })'), 'generate caps the pull at 5s');
assert.ok(gen.includes('!replayLike && nbaInjuryEnabled()'), 'replay does not pull live injuries');
assert.ok(!/the-odds-api|api\.the-odds-api/i.test(fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/status_pull.js'), 'utf8')));
assert.ok(!/\bfetch\s*\(/.test(fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-v2/status_veto.js'), 'utf8')));

process.env.OMEGA_V2_FORCE_TOP3 = '1';
process.env.OMEGA_V2_NBA_INJURY = 'on';
const baseInput = {
  date: '2026-12-20',
  dateFormatted: 'Saturday, December 20, 2026',
  history: [],
  gradedBoardRows: [],
  marketSkill: 'off',
  candidates: [
    {
      sport: 'NBA', matchup: 'Boston Celtics @ Philadelphia 76ers',
      awayTeam: 'Boston Celtics', homeTeam: 'Philadelphia 76ers',
      side: 'Philadelphia 76ers ML', market: 'Moneyline', odds: -110, book: 'draftkings',
      pModel: 0.5, pMkt: 0.58, commenceTime: COMMENCE,
    },
    {
      sport: 'NBA', matchup: 'Milwaukee Bucks @ Atlanta Hawks',
      awayTeam: 'Milwaukee Bucks', homeTeam: 'Atlanta Hawks',
      side: 'Atlanta Hawks ML', market: 'Moneyline', odds: -110, book: 'draftkings',
      pModel: 0.5, pMkt: 0.55, commenceTime: COMMENCE,
    },
    {
      sport: 'NBA', matchup: 'Miami Heat @ New York Knicks',
      awayTeam: 'Miami Heat', homeTeam: 'New York Knicks',
      side: 'New York Knicks ML', market: 'Moneyline', odds: -110, book: 'draftkings',
      pModel: 0.5, pMkt: 0.54, commenceTime: COMMENCE,
    },
    {
      sport: 'NBA', matchup: 'Dallas Mavericks @ Denver Nuggets',
      awayTeam: 'Dallas Mavericks', homeTeam: 'Denver Nuggets',
      side: 'Denver Nuggets ML', market: 'Moneyline', odds: -110, book: 'draftkings',
      pModel: 0.5, pMkt: 0.53, commenceTime: COMMENCE,
    },
  ],
};
const onCard = await buildCard({ ...baseInput, nbaInjury: report });
const onPicks = onCard.picks.map((p) => p.pick);
assert.deepStrictEqual(onPicks, ['Atlanta Hawks ML', 'New York Knicks ML', 'Denver Nuggets ML']);
assert.ok(onCard.diagnostics && onCard.diagnostics.nbaInjury, 'diagnostics are on the card');
assert.strictEqual(onCard.diagnostics.nbaInjury.pulledAt, '2026-11-15T15:15:00.000Z');
assert.ok(onCard.diagnostics.nbaInjury.vetoes.some((v) => v.pick === 'Philadelphia 76ers ML'));
assert.ok(!JSON.stringify(onCard.picks).includes('Joel Embiid'), 'player name stays off the pick');
assert.ok(!String(onCard.edgeSummary || '').includes('Embiid'));
assert.ok(!String(onCard.insights || '').includes('Embiid'));
assert.ok((onCard.rejections || []).some((r) => r.reason === 'nba-uncertain-star'));

process.env.OMEGA_V2_NBA_INJURY = 'off';
const offCard = await buildCard({ ...baseInput, nbaInjury: report });
assert.strictEqual(offCard.diagnostics, undefined, 'flag off adds no diagnostics field');
assert.ok(offCard.picks.some((p) => p.pick === 'Philadelphia 76ers ML'));
const offAgain = await buildCard(baseInput);
assert.strictEqual(offAgain.diagnostics, undefined);

restore();
console.log('PASS nba injury veto');
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
