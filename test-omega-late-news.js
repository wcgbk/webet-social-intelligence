'use strict';
/** Late-news re-checks. No network. Fetch is injected. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const late = require('./netlify/functions/lib/omega-vnext/late_news');
const select = require('./netlify/functions/lib/omega-vnext/select');
const store = require('./netlify/functions/lib/omega-vnext/store');
const et = require('./netlify/functions/lib/et-schedule');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const results = require('./netlify/functions/get-results-omega');
const pregame = require('./netlify/functions/pregame-check-omega');

const prevFetch = global.fetch;
global.fetch = async () => {
  throw new Error('network disabled in late-news tests');
};

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

const NOW = new Date('2026-10-10T16:00:00Z');
const IN_60 = '2026-10-10T17:00:00Z';
const IN_90 = new Date(NOW.getTime() + 90 * 60 * 1000).toISOString();
const AT_NOW = NOW.toISOString();
const OUT_91 = new Date(NOW.getTime() + 91 * 60 * 1000).toISOString();

function mlbPick(overrides = {}) {
  return {
    sport: 'MLB',
    pick: 'Cleveland Guardians ML',
    betType: 'Moneyline',
    matchup: 'Chicago White Sox @ Cleveland Guardians',
    homeTeam: 'Cleveland Guardians',
    awayTeam: 'Chicago White Sox',
    commenceTime: IN_60,
    odds: '-120',
    lateNews: {
      mlb: {
        homeSp: { id: 111, name: 'Sean Burke' },
        awaySp: { id: 222, name: 'Drew Rasmussen' },
        gamePk: '849831',
        lineupsPosted: false,
      },
    },
    ...overrides,
  };
}

function mlbSchedule(overrides = {}) {
  const status = overrides.status || { detailedState: 'Scheduled', statusCode: 'S', abstractGameState: 'Preview' };
  const home = overrides.home || { id: 111, fullName: 'Sean Burke' };
  const away = overrides.away || { id: 222, fullName: 'Drew Rasmussen' };
  return {
    dates: [{
      games: [{
        gamePk: 849831,
        gameDate: IN_60,
        status,
        teams: {
          home: { team: { name: 'Cleveland Guardians' }, probablePitcher: home },
          away: { team: { name: 'Chicago White Sox' }, probablePitcher: away },
        },
        lineups: overrides.lineups || {},
      }],
    }],
  };
}

function card(picks, extra = {}) {
  return { picks: picks.slice(), parlayLegs: extra.parlayLegs || [], yesPool: extra.yesPool || [], ...extra.rest };
}

(async () => {
  try {
    assert.strictEqual(late.RULES.neverAdd, true);
    assert.strictEqual(late.WITHIN_MIN, 90);
    assert.strictEqual(late.MAX_CALLS, 30);
    assert.strictEqual(late.TIMEOUT_MS, 4000);
    assert.ok(/3\.5/.test(late.RULES.qb));
    assert.ok(/not half of NFL/.test(late.RULES.qb));

    const sameLive = { homeSp: { id: 999, name: 'Sean Burke' }, awaySp: { id: 222, name: 'Drew Rasmussen' } };
    assert.strictEqual(late.decideLateNews(mlbPick(), sameLive).action, 'none', 'cross-system id with the same name is not a scratch');

    const scratched = late.decideLateNews(mlbPick(), {
      homeSp: { id: 333, name: 'Tanner Bibee' },
      awaySp: { id: 222, name: 'Drew Rasmussen' },
    });
    assert.strictEqual(scratched.action, 'drop');
    assert.strictEqual(scratched.code, 'sp-changed');

    const helps = late.decideLateNews(mlbPick(), {
      homeSp: { id: 111, name: 'Sean Burke' },
      awaySp: { id: 444, name: 'A Different Arm' },
    });
    assert.strictEqual(helps.action, 'drop', 'a change that would help the side still drops');
    assert.strictEqual(helps.code, 'sp-changed');

    assert.strictEqual(late.decideLateNews(mlbPick(), {
      homeSp: null,
      awaySp: { id: 222, name: 'Drew Rasmussen' },
    }).action, 'none', 'missing live probable is no action');
    assert.strictEqual(late.decideLateNews(mlbPick(), {
      homeSp: { id: 5, name: '', tbd: true },
      awaySp: { id: 222, name: 'Drew Rasmussen' },
    }).action, 'none');

    const noStored = mlbPick({ lateNews: { mlb: { homeSp: null, awaySp: null } } });
    assert.strictEqual(late.decideLateNews(noStored, {
      homeSp: { id: 1, name: 'New Arm' },
      awaySp: { id: 2, name: 'Other Arm' },
    }).action, 'none', 'no stored pitcher is no SP action');

    const postponed = late.decideLateNews(noStored, { detailedState: 'Postponed', statusCode: 'D' });
    assert.strictEqual(postponed.action, 'drop');
    assert.strictEqual(postponed.code, 'postponed');
    assert.strictEqual(late.decideLateNews(mlbPick(), { detailedState: 'Delayed: Rain', statusCode: 'DR' }).code, 'postponed');
    assert.strictEqual(late.decideLateNews(mlbPick(), { detailedState: 'Suspended', statusCode: 'U' }).code, 'suspended');
    assert.strictEqual(late.decideLateNews(mlbPick(), { detailedState: 'Delayed', statusCode: 'DI', homeSp: { id: 111, name: 'Sean Burke' }, awaySp: { id: 222, name: 'Drew Rasmussen' } }).action, 'none');

    const flagGoalie = late.decideLateNews({
      sport: 'NHL',
      lateNews: { nhl: { home: { id: 1, name: 'Philipp Grubauer' }, away: { id: 2, name: 'Jake Oettinger' }, goalieEdge: false } },
    }, {
      goalieConfirmed: true,
      homeGoalie: { id: 9, name: 'Jeremy Swayman' },
      awayGoalie: { id: 2, name: 'Jake Oettinger' },
    });
    assert.strictEqual(flagGoalie.action, 'flag');
    assert.strictEqual(flagGoalie.code, 'goalie-changed');

    const dropGoalie = late.decideLateNews({
      sport: 'NHL',
      lateNews: { nhl: { home: { id: 1, name: 'Philipp Grubauer' }, away: { id: 2, name: 'Jake Oettinger' }, goalieEdge: true } },
    }, {
      goalieConfirmed: true,
      homeGoalie: { id: 9, name: 'Jeremy Swayman' },
      awayGoalie: { id: 2, name: 'J. Oettinger' },
    });
    assert.strictEqual(dropGoalie.action, 'drop');
    assert.strictEqual(dropGoalie.code, 'goalie-changed');

    assert.strictEqual(late.decideLateNews({
      sport: 'NHL',
      lateNews: { nhl: { home: { id: 1, name: 'Philipp Grubauer' }, away: null, goalieEdge: true } },
    }, { goalieConfirmed: false, homeGoalie: null, awayGoalie: null }).action, 'none', 'unconfirmed goalie is no action');
    assert.strictEqual(late.decideLateNews({
      sport: 'NHL',
      lateNews: { nhl: { home: { id: 1, name: 'Philipp Grubauer' }, away: { name: 'Jake Oettinger' }, goalieEdge: false } },
    }, {
      goalieConfirmed: true,
      homeGoalie: { name: 'P. Grubauer' },
      awayGoalie: { name: 'Jake Oettinger' },
    }).action, 'none', 'first initial plus surname is the same goalie');
    assert.strictEqual(late.decideLateNews({
      sport: 'NHL',
      lateNews: { nhl: { home: null, away: null, goalieEdge: true } },
    }, {
      goalieConfirmed: true,
      homeGoalie: { name: 'Jeremy Swayman' },
      awayGoalie: { name: 'Jake Oettinger' },
    }).action, 'none', 'no stored goalie is no action');

    const qbPick = (homeStatus, awayStatus, loaded = true) => ({
      sport: 'NFL',
      pick: 'Baltimore Ravens ML',
      homeTeam: 'Baltimore Ravens',
      awayTeam: 'Buffalo Bills',
      lateNews: {
        qb: {
          loaded,
          home: { qbStatus: homeStatus, qbName: homeStatus ? 'Lamar Jackson' : null },
          away: { qbStatus: awayStatus, qbName: awayStatus ? 'Josh Allen' : null },
        },
      },
    });
    const newlyOut = late.decideLateNews(qbPick(null, null), {
      qbLoaded: true,
      homeQb: { qbStatus: 'out', qbName: 'Lamar Jackson' },
      awayQb: { qbStatus: null },
    });
    assert.strictEqual(newlyOut.action, 'drop');
    assert.strictEqual(newlyOut.code, 'qb-out');
    assert.strictEqual(late.decideLateNews(qbPick('out', null), {
      qbLoaded: true,
      homeQb: { qbStatus: 'out' },
      awayQb: { qbStatus: null },
    }).action, 'none', 'already out is priced');
    const doubtful = late.decideLateNews(qbPick(null, null), {
      qbLoaded: true,
      homeQb: { qbStatus: null },
      awayQb: { qbStatus: 'doubtful' },
    });
    assert.strictEqual(doubtful.action, 'flag');
    assert.strictEqual(doubtful.code, 'qb-doubtful');
    assert.notStrictEqual(doubtful.action, 'drop');
    assert.strictEqual(late.decideLateNews(qbPick(null, null), {
      qbLoaded: true,
      homeQb: { qbStatus: 'questionable' },
      awayQb: { qbStatus: null },
    }).action, 'none');
    assert.strictEqual(late.decideLateNews(qbPick('out', null), {
      qbLoaded: true,
      homeQb: { qbStatus: null },
      awayQb: { qbStatus: null },
    }).action, 'none', 'improvement is no action');
    assert.strictEqual(late.decideLateNews(qbPick(null, null, false), {
      qbLoaded: true,
      homeQb: { qbStatus: 'out' },
      awayQb: { qbStatus: 'out' },
    }).action, 'none', 'generate load failure is no action');
    assert.strictEqual(late.decideLateNews(qbPick(null, null, true), { qbLoaded: false }).action, 'none');
    assert.strictEqual(late.decideLateNews({
      sport: 'NCAAF',
      lateNews: { qb: { loaded: true, home: { qbStatus: null }, away: { qbStatus: null } } },
    }, { qbLoaded: true, homeQb: { qbStatus: 'ruled out' }, awayQb: { qbStatus: null } }).code, 'qb-out');

    assert.strictEqual(late.pickInWindow(mlbPick(), NOW, 90), true);
    assert.strictEqual(late.pickInWindow(mlbPick({ commenceTime: IN_90 }), NOW, 90), true);
    assert.strictEqual(late.pickInWindow(mlbPick({ commenceTime: AT_NOW }), NOW, 90), false);
    assert.strictEqual(late.pickInWindow(mlbPick({ commenceTime: OUT_91 }), NOW, 90), false);
    assert.strictEqual(late.pickInWindow(mlbPick({ commenceTime: '' }), NOW, 90), false);
    assert.strictEqual(late.pickInWindow(mlbPick({ result: 'win' }), NOW, 90), false);

    const namesBefore = ['Cleveland Guardians ML', 'Chicago White Sox ML'];
    const two = card([
      mlbPick(),
      mlbPick({ pick: 'Chicago White Sox ML', result: 'win' }),
    ], { yesPool: [{ pick: 'Sneaky Add', sport: 'MLB' }] });
    const applied = late.applyCardActions(two, [
      { index: 0, action: 'drop', code: 'sp-changed', reason: 'starter' },
      { index: 1, action: 'drop', code: 'sp-changed', reason: 'starter' },
      { index: 9, action: 'add', yesPool: [{ pick: 'Sneaky Add' }] },
    ], NOW);
    assert.strictEqual(applied.dropped, 1, 'graded win is not voided');
    assert.deepStrictEqual(two.picks.map((p) => p.pick), ['Chicago White Sox ML']);
    assert.strictEqual(two.voidedPregame.length, 1);
    assert.strictEqual(two.voidedPregame[0].status, 'void-pregame');
    assert.strictEqual(two.voidedPregame[0].voidCode, 'sp-changed');
    assert.ok(two.voidedPregame[0].voidedAt);
    assert.ok(!two.picks.concat(two.voidedPregame).some((p) => p.pick === 'Sneaky Add' && p !== two.yesPool[0]));
    assert.deepStrictEqual(two.yesPool, [{ pick: 'Sneaky Add', sport: 'MLB' }]);
    for (const name of two.picks.map((p) => p.pick).concat(two.voidedPregame.map((p) => p.pick))) {
      assert.ok(namesBefore.includes(name), name);
    }

    const already = card([mlbPick({ lateFlags: ['goalie-changed'], sport: 'NHL', lateNews: { nhl: { goalieEdge: false, home: { name: 'A Goalie' }, away: { name: 'B Goalie' } } } })]);
    const again = late.applyCardActions(already, [{ index: 0, action: 'flag', code: 'goalie-changed', reason: 'again' }], NOW);
    assert.strictEqual(again.flagged, 0);
    assert.strictEqual(already.picks[0].lateFlags.length, 1);

    const rebuildCard = card([mlbPick()], { parlayLegs: [{ type: 'locked', legs: [{ pick: 'Cleveland Guardians ML' }] }] });
    assert.throws(() => late.commitLateNewsCard(rebuildCard, { dropped: 1, flagged: 0, removed: ['Cleveland Guardians ML'] }, {
      resolveLockedParlay: () => ({ parlayLegs: [{ type: 'rebuilt' }], rebuilt: true }),
    }), /rebuild/);
    assert.strictEqual(rebuildCard.parlayLegs[0].type, 'locked');

    let calls = 0;
    const scratchCard = card([mlbPick(), mlbPick({ pick: 'Outside', commenceTime: OUT_91 })]);
    const scratchRun = await late.runLateNews({
      picksData: scratchCard,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async (url) => {
        calls += 1;
        assert.ok(String(url).includes('statsapi.mlb.com'), String(url));
        assert.ok(String(url).includes('hydrate=probablePitcher,lineups'));
        return json(mlbSchedule({ home: { id: 333, fullName: 'Tanner Bibee' }, lineups: { homePlayers: [{ id: 1 }] } }));
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(scratchRun.dropped, 1);
    assert.strictEqual(scratchRun.httpCalls, 1);
    assert.deepStrictEqual(scratchCard.picks.map((p) => p.pick), ['Outside']);
    assert.strictEqual(scratchCard.voidedPregame[0].voidCode, 'sp-changed');
    assert.ok(scratchCard.picks.length + scratchCard.voidedPregame.length === 2);

    const postCard = card([mlbPick()]);
    const postRun = await late.runLateNews({
      picksData: postCard,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async () => json(mlbSchedule({ status: { detailedState: 'Postponed', statusCode: 'D' } })),
    });
    assert.strictEqual(postRun.dropped, 1);
    assert.strictEqual(postCard.voidedPregame[0].voidCode, 'postponed');

    const quiet = card([mlbPick()]);
    const quietRun = await late.runLateNews({
      picksData: quiet,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async () => json(mlbSchedule({ lineups: { homePlayers: [{ id: 9 }], awayPlayers: [] } })),
    });
    assert.strictEqual(quietRun.dropped, 0);
    assert.strictEqual(quietRun.flagged, 0);
    assert.strictEqual(quiet.picks.length, 1);
    assert.strictEqual(quietRun.checks[0].lineupsPosted, true);
    assert.strictEqual(quietRun.checks[0].action, 'none');

    const blown = card([mlbPick()]);
    const blownRun = await late.runLateNews({
      picksData: blown,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async () => { throw new Error('stats down'); },
    });
    assert.strictEqual(blownRun.dropped, 0);
    assert.strictEqual(blownRun.httpCalls, 1);
    assert.strictEqual(blown.picks.length, 1);
    assert.ok(!blown.voidedPregame);

    const far = card([mlbPick({ commenceTime: OUT_91 })]);
    let farCalls = 0;
    const farRun = await late.runLateNews({
      picksData: far,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async () => { farCalls += 1; throw new Error('should not fetch'); },
    });
    assert.strictEqual(farCalls, 0);
    assert.strictEqual(farRun.checked, 0);

    const edgeCard = card([
      mlbPick({ commenceTime: AT_NOW, pick: 'Starting now' }),
      mlbPick({ commenceTime: IN_90, pick: 'Exactly 90' }),
    ]);
    const edgeRun = await late.runLateNews({
      picksData: edgeCard,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async () => json(mlbSchedule({ status: { detailedState: 'Postponed', statusCode: 'D' } })),
    });
    assert.strictEqual(edgeRun.checked, 1);
    assert.strictEqual(edgeRun.dropped, 1);
    assert.ok(edgeCard.picks.some((p) => p.pick === 'Starting now'));
    assert.ok(edgeCard.voidedPregame.some((p) => p.pick === 'Exactly 90'));

    const nhlPicks = [];
    for (let i = 1; i <= 31; i += 1) {
      nhlPicks.push({
        sport: 'NHL',
        pick: `Home Club ${i} ML`,
        homeTeam: `Home Club ${i}`,
        awayTeam: `Away Club ${i}`,
        commenceTime: IN_60,
        lateNews: {
          nhl: {
            home: { id: 100 + i, name: 'Philipp Grubauer' },
            away: { id: 200 + i, name: 'Jake Oettinger' },
            goalieEdge: false,
          },
        },
      });
    }
    const nhlCard = card(nhlPicks);
    const nhlUrls = [];
    const nhlRun = await late.runLateNews({
      picksData: nhlCard,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async (url) => {
        const text = String(url);
        nhlUrls.push(text);
        if (text.includes('/schedule/')) {
          return json({
            gameWeek: [{
              date: '2026-10-10',
              games: nhlPicks.map((pick, idx) => ({
                id: idx + 1,
                startTimeUTC: IN_60,
                gameState: 'FUT',
                homeTeam: { placeName: { default: 'Home' }, commonName: { default: `Club ${idx + 1}` } },
                awayTeam: { placeName: { default: 'Away' }, commonName: { default: `Club ${idx + 1}` } },
              })),
            }],
          });
        }
        assert.ok(text.includes('/boxscore'), text);
        const id = Number((text.match(/gamecenter\/(\d+)/) || [])[1]);
        const homeName = id === 1 ? 'Jeremy Swayman' : 'Philipp Grubauer';
        return json({
          playerByGameStats: {
            homeTeam: { goalies: [{ starter: true, playerId: 9, name: { default: homeName } }] },
            awayTeam: { goalies: [{ starter: true, playerId: 8, name: { default: 'Jake Oettinger' } }] },
          },
        });
      },
    });
    assert.strictEqual(nhlUrls.length, 30, `budget used ${nhlUrls.length}`);
    assert.strictEqual(nhlRun.httpCalls, 30);
    assert.strictEqual(nhlRun.exhausted, true);
    assert.strictEqual(nhlCard.picks.length, 31, 'flag does not remove and never adds');
    assert.ok(nhlCard.picks[0].lateFlags.includes('goalie-changed'));
    assert.ok(!nhlCard.picks[30].lateFlags);
    assert.strictEqual(nhlRun.flagged, 1);
    assert.ok(!nhlUrls.some((url) => url.includes('/landing')));

    const edgeGoalie = card([{
      sport: 'NHL',
      pick: 'Boston Bruins ML',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Philadelphia Flyers',
      commenceTime: IN_60,
      lateNews: { nhl: { home: { name: 'Jeremy Swayman' }, away: { name: 'Samuel Ersson' }, goalieEdge: true } },
    }]);
    const edgeGoalieRun = await late.runLateNews({
      picksData: edgeGoalie,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async (url) => {
        if (String(url).includes('/schedule/')) {
          return json({
            gameWeek: [{
              date: '2026-10-10',
              games: [{
                id: 70,
                startTimeUTC: IN_60,
                gameState: 'FUT',
                homeTeam: { placeName: { default: 'Boston' }, commonName: { default: 'Bruins' } },
                awayTeam: { placeName: { default: 'Philadelphia' }, commonName: { default: 'Flyers' } },
              }],
            }],
          });
        }
        return json({
          playerByGameStats: {
            homeTeam: { goalies: [{ starter: true, name: { default: 'Joonas Korpisalo' } }] },
            awayTeam: { goalies: [{ starter: true, name: { default: 'Samuel Ersson' } }] },
          },
        });
      },
    });
    assert.strictEqual(edgeGoalieRun.dropped, 1);
    assert.strictEqual(edgeGoalie.voidedPregame[0].voidCode, 'goalie-changed');
    assert.strictEqual(edgeGoalie.picks.length, 0);

    const qbCard = card([{
      sport: 'NFL',
      pick: 'Baltimore Ravens ML',
      homeTeam: 'Baltimore Ravens',
      awayTeam: 'Buffalo Bills',
      commenceTime: IN_60,
      lateNews: { qb: { loaded: true, home: { qbStatus: null }, away: { qbStatus: null } } },
    }]);
    const qbRun = await late.runLateNews({
      picksData: qbCard,
      now: NOW,
      dateISO: '2026-10-10',
      fetchImpl: async (url) => {
        assert.ok(String(url).includes('/football/nfl/injuries'), String(url));
        return json({
          injuries: [{
            displayName: 'Baltimore Ravens',
            injuries: [{
              status: 'Out',
              date: '2026-10-09',
              athlete: { displayName: 'Lamar Jackson', position: { abbreviation: 'QB' } },
            }],
          }],
        });
      },
    });
    assert.strictEqual(qbRun.dropped, 1);
    assert.strictEqual(qbCard.voidedPregame[0].voidCode, 'qb-out');

    const stale = late.parseFootballQbMap({
      injuries: [{
        displayName: 'Florida Gators',
        injuries: [{
          date: '2020-11-21',
          status: 'Out',
          athlete: { displayName: 'Old QB', position: { abbreviation: 'QB' } },
        }],
      }],
    }, { maxAgeDays: 400, cardDate: '2026-10-10' });
    assert.deepStrictEqual(stale, {});
    const keptNfl = late.parseFootballQbMap({
      injuries: [{
        displayName: 'Florida Gators',
        injuries: [{
          date: '2020-11-21',
          status: 'Out',
          athlete: { displayName: 'Old QB', position: { abbreviation: 'QB' } },
        }],
      }],
    }, { cardDate: '2026-10-10' });
    assert.strictEqual(keptNfl['Florida Gators'].qbStatus, 'out');

    const filled = await late.fillNcaafQbMap({
      map: {},
      games: [{ id: '401', homeId: '57', awayId: '333' }],
      dateISO: '2026-10-10',
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes('summary?event=401')) {
          return json({
            injuries: [{
              team: { displayName: 'Oregon Ducks' },
              injuries: [{
                status: { description: 'Out' },
                date: '2026-10-01',
                athlete: { displayName: 'Dante Moore', position: { abbreviation: 'QB' } },
              }],
            }],
          });
        }
        if (text.includes('/teams/57/injuries')) {
          return json({
            team: { displayName: 'Florida Gators' },
            injuries: [{
              status: 'Doubtful',
              date: '2026-10-08',
              athlete: { displayName: 'DJ Lagway', position: { abbreviation: 'QB' } },
            }],
          });
        }
        return json({});
      },
    });
    assert.strictEqual(filled.ok, true);
    assert.strictEqual(filled.map['Oregon Ducks'].qbStatus, 'out');
    assert.strictEqual(filled.map['Florida Gators'].qbStatus, 'doubtful');
    assert.ok(filled.calls <= 30);

    const seeded = { Keepers: { team: 'Keepers', qbStatus: 'out', qbName: 'A' } };
    const thrownFill = await late.fillNcaafQbMap({
      map: seeded,
      games: [{ id: '9', homeId: '1', awayId: '2' }],
      dateISO: '2026-10-10',
      fetchImpl: async () => { throw new Error('espn down'); },
    });
    assert.deepStrictEqual(Object.keys(thrownFill.map), ['Keepers']);
    assert.strictEqual(thrownFill.map.Keepers.qbName, 'A');

    const stamped = late.stampCandidates([{
      sport: 'MLB',
      market: 'Total',
      side: 'Over 8.5',
      homeTeam: 'Cleveland Guardians',
      awayTeam: 'Chicago White Sox',
      commenceTime: IN_60,
    }], {
      espnBySport: {
        MLB: {
          games: [{
            id: '849831',
            homeTeam: 'Cleveland Guardians',
            awayTeam: 'Chicago White Sox',
            commenceTime: IN_60,
            homeProbable: { name: 'Tanner Bibee', id: 676440 },
            awayProbable: { name: 'Sean Burke', id: 680732 },
          }],
        },
      },
    });
    assert.strictEqual(stamped[0].lateNews.mlb.homeSp.name, 'Tanner Bibee');
    assert.strictEqual(stamped[0].lateNews.mlb.awaySp.id, 680732);
    const published = select.toPickObject({
      ...stamped[0],
      odds: -110,
      coverProb: 0.54,
      ev: 0.03,
      edgePct: 0.02,
      matchup: 'Chicago White Sox @ Cleveland Guardians',
    });
    assert.strictEqual(published.lateNews.mlb.awaySp.name, 'Sean Burke');
    assert.strictEqual(published.lateNews.mlb.homeSp.id, 676440);

    const qbStamped = late.stampCandidates([{
      sport: 'NFL',
      homeTeam: 'Baltimore Ravens',
      awayTeam: 'Buffalo Bills',
      commenceTime: IN_60,
    }], {
      gameDay: {
        qbStatusBySport: {
          NFL: { 'Baltimore Ravens': { qbStatus: 'out', qbName: 'Lamar Jackson' } },
        },
      },
    });
    assert.strictEqual(qbStamped[0].lateNews.qb.loaded, true);
    assert.strictEqual(qbStamped[0].lateNews.qb.home.qbStatus, 'out');
    assert.strictEqual(qbStamped[0].lateNews.qb.away.qbStatus, null);
    const failedStamp = late.stampCandidates([{
      sport: 'NCAAF',
      homeTeam: 'Oregon Ducks',
      awayTeam: 'Florida Gators',
    }], { gameDay: { qbStatusMeta: { NCAAF: { ok: false } }, qbStatusBySport: { NCAAF: {} } } });
    assert.strictEqual(failedStamp[0].lateNews.qb.loaded, false);

    const slots = et.ET_SCHEDULE['pregame-check-omega'].etTimes;
    assert.strictEqual(slots.length, 26);
    assert.strictEqual(slots[0], '11:00');
    assert.strictEqual(slots[slots.length - 1], '23:30');
    for (let i = 1; i < slots.length; i += 1) {
      const [ph, pm] = slots[i - 1].split(':').map(Number);
      const [h, m] = slots[i].split(':').map(Number);
      assert.strictEqual((h * 60 + m) - (ph * 60 + pm), 30);
    }
    assert.ok(!slots.some((slot) => slot.endsWith(':40')));
    assert.strictEqual(et.etGuard('pregame-check-omega', { headers: { 'x-nf-event': 'schedule' }, body: '{"next_run":"x"}' }, new Date('2026-10-10T15:00:00Z')).run, true);
    assert.strictEqual(et.etGuard('pregame-check-omega', { headers: { 'x-nf-event': 'schedule' }, body: '{"next_run":"x"}' }, new Date('2026-10-10T14:30:00Z')).run, false);
    assert.strictEqual(et.etGuard('pregame-check-omega', { headers: { 'x-nf-event': 'schedule' }, body: '{"next_run":"x"}' }, new Date('2026-10-11T03:30:00Z')).matched, '23:30');
    // 23:40 ET is still inside the shared ±10 min slot tolerance of 23:30.
    // The cron itself is minute 0,30, so :40 is never scheduled. 23:41 is outside.
    assert.strictEqual(et.etGuard('pregame-check-omega', { headers: { 'x-nf-event': 'schedule' }, body: '{"next_run":"x"}' }, new Date('2026-10-11T03:41:00Z')).run, false);
    const pregameCron = et.parseCron('0,30 15-23,0-4 * * *');
    assert.ok(pregameCron.minute.has(0) && pregameCron.minute.has(30));
    assert.ok(!pregameCron.minute.has(40));

    assert.doesNotThrow(() => store.assertOpsKey('omega-ops/late-news-latest'));
    assert.doesNotThrow(() => store.assertOpsKey('omega-ops/late-news-2026-10-10'));
    assert.doesNotThrow(() => store.assertOpsKey('omega-ops/capture-health-latest'));
    for (const bad of ['omega-ops/other', 'omega-ops/late-news', 'omega-ops/capture-health', 'picks-2026-10-10', 'latest-date']) {
      assert.throws(() => store.assertOpsKey(bad), /refused/, bad);
    }

    const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
    assert.ok(verifySrc.includes('lateNews.runLateNews'));
    const steamAt = verifySrc.indexOf('let droppedSteam = 0');
    const steamRegion = verifySrc.slice(steamAt, verifySrc.indexOf('Step 3: Sharp handicapper review', steamAt));
    assert.ok(/steamDropBlocksStraightRefill\(\s*droppedSteam/.test(steamRegion));
    assert.ok(/blockStraightRefill\s*=\s*true/.test(steamRegion));
    assert.ok(steamRegion.includes('runLateNews'));
    const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
    assert.ok(indexSrc.indexOf('stampCandidates(candidates, snap)') > indexSrc.indexOf('projectAll(snap'));
    assert.ok(indexSrc.indexOf('calibrateAll(candidates)') > indexSrc.indexOf('stampCandidates(candidates, snap)'));

    const hidden = publicPicksPayload({
      picks: [mlbPick({ status: 'void-pregame' }), mlbPick({ pick: 'Still live' })],
      voidedPregame: [mlbPick({ status: 'void-pregame' })],
      lateNews: { secret: true },
      parlayLegs: [{ legs: [mlbPick({ status: 'void-pregame' }), mlbPick({ pick: 'Leg live' })] }],
    });
    assert.deepStrictEqual(hidden.picks.map((p) => p.pick), ['Still live']);
    assert.ok(!Object.prototype.hasOwnProperty.call(hidden, 'voidedPregame'));
    assert.ok(!Object.prototype.hasOwnProperty.call(hidden, 'lateNews'));
    assert.deepStrictEqual(hidden.parlayLegs[0].legs.map((p) => p.pick), ['Leg live']);
    assert.strictEqual(results._test.gradePick({ status: 'void-pregame', pick: 'Cleveland Guardians ML' }, null), 'push');

    assert.ok(pregame.handler.length <= 2);
    const sched = {
      httpMethod: 'POST',
      headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
      body: JSON.stringify({ next_run: '2026-10-10T15:00:00Z' }),
    };
    let skippedReads = 0;
    const skipped = await pregame.handler(sched, {
      now: new Date('2026-10-10T14:30:00Z'),
      readCard: async () => { skippedReads += 1; return { picks: [] }; },
      fetchImpl: async () => { throw new Error('no fetch'); },
    });
    assert.strictEqual(JSON.parse(skipped.body).reason, 'outside-et-slot');
    assert.strictEqual(skippedReads, 0);

    let opsRuns = 0;
    let writes = 0;
    const liveCard = card([mlbPick()]);
    const ran = await pregame.handler(sched, {
      now: NOW,
      dateKey: '2026-10-10',
      readCard: async () => ({ dateKey: '2026-10-10', data: liveCard }),
      writeCard: async (_date, data) => {
        writes += 1;
        assert.strictEqual(data.picks.length, 0);
        assert.strictEqual(data.voidedPregame[0].status, 'void-pregame');
        assert.ok(!data.picks.some((p) => p.pick === 'Added'));
        return true;
      },
      recordOps: async (_date, run) => {
        opsRuns += 1;
        assert.strictEqual(run.function, 'pregame-check-omega');
        assert.strictEqual(run.withinMin, 90);
        assert.strictEqual(run.maxCalls, 30);
        assert.strictEqual(run.timeoutMs, 4000);
        assert.ok(run.dropped >= 1);
      },
      fetchImpl: async () => json(mlbSchedule({ home: { id: 8, fullName: 'Tanner Bibee' } })),
    });
    const ranBody = JSON.parse(ran.body);
    assert.strictEqual(ranBody.dropped, 1);
    assert.strictEqual(ranBody.written, true);
    assert.strictEqual(writes, 1);
    assert.strictEqual(opsRuns, 1);

    const evening = await pregame.handler(sched, {
      now: new Date('2026-10-11T03:30:00Z'),
      readCard: async () => ({ picks: [] }),
      recordOps: async () => {},
      fetchImpl: async () => { throw new Error('no fetch'); },
    });
    assert.strictEqual(JSON.parse(evening.body).summary, 'No picks found');
    const tooLate = await pregame.handler(sched, {
      now: new Date('2026-10-11T03:41:00Z'),
      readCard: async () => { throw new Error('should not read'); },
    });
    assert.strictEqual(JSON.parse(tooLate.body).reason, 'outside-et-slot');

    console.log('PASS test-omega-late-news');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    global.fetch = prevFetch;
  }
})();
