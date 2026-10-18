'use strict';
/** V1 generator — Spec v2.0 only. Stored board blind (no live odds fetch, no credits).
 *  Last-5 / injury / starter data are NOT on the stored board; without an
 *  injected verified source every game passes honestly (Spec §9).
 *  opts.byGame may inject {last5,injuries,keyStarter,h2h} per matchup in tests/replay. */
const { MODEL_VERSION_V1, ENGINE_V1, SPORTS_V1 } = require('./config-v1');
const { selectBoardPollV1, reconstructEventsV1 } = require('./board-v1');
const { projectAllV1 } = require('./project-v1');
const { selectV1 } = require('./select-v1');
const { readStoredBoardV1, storeCardV1 } = require('./store-v1');
const { loadEfficiencySeeds } = require('../omega-vnext/ingest');
const { noPlaysFields } = require('../no-plays');
function todayET(){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}); }
function formatDateLong(d){ try{ const [y,m,dd]=d.split('-').map(Number); return new Date(Date.UTC(y,m-1,dd,16)).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'America/New_York'}); }catch(_){ return d; } }
async function generateV1Lock(opts={}){
  const dateISO=opts.date||todayET(); const dryRun=!!opts.dryRun;
  const boardDoc=opts.boardDoc||await readStoredBoardV1(dateISO);
  if(!boardDoc||!Array.isArray(boardDoc.polls)||!boardDoc.polls.length) throw new Error(`V1: no stored board (omega-line-path/${dateISO}) — refusing to fetch live odds`);
  const poll=selectBoardPollV1(boardDoc.polls, opts.boardCutoff||'1000');
  if(!poll) throw new Error('V1: stored board has no usable poll');
  const boardSlot=String(poll.hhmm||poll.slot);
  const allEvents=reconstructEventsV1(poll.games);
  const events=allEvents.filter(e=>SPORTS_V1.includes(e.sport));
  const unsupported=[...new Set(allEvents.map(e=>e.sport).filter(s=>s&&!SPORTS_V1.includes(s)))];
  const seeds=loadEfficiencySeeds();
  const efficiencyBySport={ NFL:seeds.NFL||{}, NCAAF:seeds.NCAAF||{} };
  // Spec §§3-5 data: last-5 / injuries / key starter from ESPN (feeds-v1).
  // Soft-fail: any feed error leaves byGame empty and §9 passes honestly.
  let byGame=opts.byGame||{};
  if(!opts.byGame && !opts.skipFeeds){
    try {
      const { loadFootballFeedsV1 } = require('./feeds-v1');
      for(const sport of ['NFL','NCAAF']){
        const games=events.filter(e=>e.sport===sport).map(e=>({ homeTeam:e.home_team, awayTeam:e.away_team, commenceTime:e.commence_time }));
        if(games.length) Object.assign(byGame, await loadFootballFeedsV1(sport, dateISO, games));
      }
    } catch(e) { byGame = {}; }
  }
  const { candidates, passes }=projectAllV1(events, efficiencyBySport, { byGame, boardSlot, boardCapturedAt: poll.capturedAt||null });
  const { picks, parlayLegs, funnel, rejections }=selectV1(candidates, passes);
  funnel.gamesOnBoard=events.length; funnel.boardSource=(boardDoc&&boardDoc.source)||'omega-line-path'; funnel.feedsWired=Object.keys(byGame).length; funnel.unsupportedSportsOnBoard=unsupported; funnel.boardSlot=boardSlot; funnel.boardCapturedAt=poll.capturedAt||null;
  const totalUnits=picks.reduce((s,p)=>s+(parseFloat(p.units)||0),0)+(parlayLegs||[]).reduce((s,p)=>s+(parseFloat(p.units)||0),0);
  const card={ date:dateISO, dateFormatted:formatDateLong(dateISO), model:MODEL_VERSION_V1, engine:ENGINE_V1, source:'v1-lock',
    picks, parlayLegs:parlayLegs||[], sgps:[], rejections, generatedAt:new Date().toISOString(), boardSlot, boardCapturedAt:poll.capturedAt||null,
    summary:{ totalPicks:picks.length, totalStraightBets:picks.length, totalUnits:`${totalUnits}u`, sportsCovered:[...new Set(picks.map(p=>p.sport))], modelVersion:MODEL_VERSION_V1 },
    funnel, modelNotes:'V1 governed solely by The Lock — Unified Spec v2.0 (NFL, NCAAF, NHL, NBA, NCAAM, MLB): Hard Rock confirmed line, last-5 Tier 1, formula probability from team strength, Filter 1 grading (B parlay only), mandatory passes. Football projector live; NHL/NBA/NCAAM/MLB documented pass until a V1 projector exists.',
    claudeVerified:false, fallback:false };
  if(!picks.length){ Object.assign(card, noPlaysFields(`No qualifying plays today. Discipline wins long term. (V1 priced ${events.length} game(s) from the stored ${boardSlot} board; see rejections/funnel for the Spec §9 pass reasons.)`, { noGames:events.length===0 })); card.edgeSummary=card.noPlaysReason; card.insights=''; }
  if(!dryRun) await storeCardV1(dateISO, card);
  return card;
}
module.exports={ generateV1Lock, MODEL_VERSION_V1 };
