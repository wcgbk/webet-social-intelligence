'use strict';
/** V1 generator — Spec v2.0 only. Stored board blind (no live odds fetch, no credits).
 *  Last-5 / injury / starter data are NOT on the stored board; without an
 *  injected verified source every game passes honestly (Spec §9).
 *  opts.byGame may inject {last5,injuries,keyStarter,h2h} per matchup in tests/replay. */
const { MODEL_VERSION_V1, ENGINE_V1, SPORTS_V1 } = require('./config-v1');
const { selectBoardPollV1, reconstructEventsV1 } = require('./board-v1');
const { projectAllV1 } = require('./project-v1');
const { selectV1, summaryTotalsV1 } = require('./select-v1');
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
  // Opening read for Filter 4: earliest stored poll (0600 capture / 0300
  // baseline merged into the board doc) vs the board poll's line.
  const sortedPolls=[...boardDoc.polls].filter(x=>x&&x.games&&Object.keys(x.games).length).sort((a,b)=>String(a.hhmm||a.slot).localeCompare(String(b.hhmm||b.slot)));
  const openPoll=sortedPolls[0]||null;
  const openSlot=openPoll?String(openPoll.hhmm||openPoll.slot):null;
  const openGames=(openPoll&&openPoll!==poll)?openPoll.games:(boardDoc.openGames||null);
  const allEvents=reconstructEventsV1(poll.games, openGames);
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
  const { picks, parlayLegs, funnel, rejections, diagnostics }=selectV1(candidates, passes);
  funnel.gamesOnBoard=events.length; funnel.boardSource=(boardDoc&&boardDoc.source)||'omega-line-path'; funnel.feedsWired=Object.keys(byGame).length; funnel.unsupportedSportsOnBoard=unsupported; funnel.boardSlot=boardSlot; funnel.boardCapturedAt=poll.capturedAt||null; funnel.openSlot=(openGames?openSlot:null); funnel.openSource=(boardDoc&&boardDoc.openSource)||(openGames?'earliest-poll':null);
  const totals=summaryTotalsV1(picks, parlayLegs);
  const card={ date:dateISO, dateFormatted:formatDateLong(dateISO), model:MODEL_VERSION_V1, engine:ENGINE_V1, source:'v1-lock',
    picks, parlayLegs:parlayLegs||[], sgps:[], rejections, diagnostics:diagnostics||{ fallback:[], dataFlags:[] }, generatedAt:new Date().toISOString(), boardSlot, boardCapturedAt:poll.capturedAt||null,
    summary:{ ...totals, sportsCovered:[...new Set(picks.map(p=>p.sport))], modelVersion:MODEL_VERSION_V1 },
    funnel, modelNotes:'V1 governed by The Lock — Unified Spec v2.0 (NFL, NCAAF, NHL, NBA, NCAAM, MLB): Hard Rock confirmed line, last-5 Tier 1, formula probability from team strength, mandatory passes. Grades are the edge versus the de-vigged Pinnacle fair (A+ ≥5pp, A 3.5–5, A- 2–3.5, B 1–2 at 0.5u). Fallback rows where probability equals that fair grade the edge versus the price. Below 1pp or EV ≤ 0 does not qualify. NFL/NCAAF probabilities shrink toward the de-vigged Pinnacle fair on the same line (formula weight 0.35, absolute cap 0.08) before grade and EV. A+ is 1.5u and no straight tier exceeds 1.5u. A straight shorter than -250 is not graded above A-. When fewer than 3 qualifying games exist, the remaining straights are positive-EV rows first, then the least-negative EV, at 0.5u. Any pick whose edge is below 1pp or whose EV is not positive is rating no-edge with flag no-edge-lean. Football projector live. NHL/NBA/NCAAM/MLB use de-vigged Pinnacle fair vs the best DraftKings/Hard Rock price. The card is 3 straights and a 3-leg parlay. Parlay legs use the same rule.',
    claudeVerified:false, fallback:false };
  if(!picks.length){ Object.assign(card, noPlaysFields(`No qualifying plays today. Discipline wins long term. (V1 priced ${events.length} game(s) from the stored ${boardSlot} board; see rejections/funnel for the Spec §9 pass reasons.)`, { noGames:events.length===0 })); card.edgeSummary=card.noPlaysReason; card.insights=''; }
  if(!dryRun) await storeCardV1(dateISO, card);
  return card;
}
module.exports={ generateV1Lock, MODEL_VERSION_V1 };
