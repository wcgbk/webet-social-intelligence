'use strict';
/**
 * V1 selection — Spec §§3,5,6,8,9,10 ONLY.
 * Mandatory passes first, then Filter 1 grading. B = parlay only.
 * No sheet, no anchor, no haircut, no stake-EV floor beyond Spec §9
 * (negative expected value at the confirmed price = pass).
 */
const { gradeForV1, floorForV1, unitsForGradeV1, MODEL_VERSION_V1 } = require('./config-v1');
function fmtPct(p){ return p==null||!Number.isFinite(p)?null:`${(p*100).toFixed(1)}%`; }
function decFromAmerican(a){ return a>0?1+a/100:1+100/Math.abs(a); }
function evFor(p, odds){ return odds==null?null:p*decFromAmerican(odds)-1; }
function whatLosesV1(c){
  if(c.market==='Total') return /^over/i.test(c.side)?`The game stays under ${c.line} total points.`:`The game goes over ${c.line} total points.`;
  if(c.market==='Spread') return `${c.side} fails to cover against the final margin.`;
  return `${c.side} loses the game outright.`;
}
function receiptV1(c, grade, ev){
  const unit=unitsForGradeV1(grade);
  return {
    game:`${c.awayTeam} vs ${c.homeTeam}`,
    pick:c.market==='Moneyline'?c.side:c.side,
    rating:grade,
    confirmedLine:`Hard Rock Bet ${c.oddsStr}${c.line!=null?` (${c.line})`:''}`,
    trueWinProbability:fmtPct(c.trueProbability),
    last5TeamA:c.last5&&c.last5.away?c.last5.away:null,
    last5TeamB:c.last5&&c.last5.home?c.last5.home:null,
    h2h:c.h2h||null,
    keyInjuryFlags:c.injuries?JSON.stringify(c.injuries):null,
    coreReasoning:`Formula line (expected margin ${c.formulaSpreadHome}, expected total ${c.formulaTotal}, inputs: ${c.formulaInputs.method}) prices this at ${fmtPct(c.trueProbability)} against the confirmed Hard Rock Bet line; expected value at that price is ${ev!=null?(ev*100).toFixed(1)+'%':''}.`,
    unitSize:`${unit}u`,
    whatLoses:whatLosesV1(c),
  };
}
function toPickV1(c, grade, ev){
  const unit=unitsForGradeV1(grade); const r=receiptV1(c,grade,ev);
  return { sport:c.sport, matchup:c.matchup, homeTeam:c.homeTeam, awayTeam:c.awayTeam,
    pick:r.pick, pickDisplay:r.pick, betType:c.market, odds:c.oddsStr, units:`${unit}u`,
    rating:grade.toLowerCase(), lockGrade:grade, grade, commenceTime:c.commenceTime,
    winProbability:fmtPct(c.trueProbability), trueProbability:c.trueProbability,
    ev:ev!=null?fmtPct(ev):null, book:'hardrockbet', displayBook:'Hard Rock Bet', executionBook:'Hard Rock Bet',
    source:'v1-lock', model:MODEL_VERSION_V1, coreReasoning:r.coreReasoning, lockReceipt:r,
    formula:{ spreadHome:c.formulaSpreadHome, total:c.formulaTotal, inputs:c.formulaInputs } };
}
function selectV1(candidates, formulaPasses=[]){
  const funnel={ candidates:(candidates||[]).length, formulaPassGames:formulaPasses.length,
    noConfirmedHardRockLine:0, missingLast5:0, missingInjuries:0, keyStarterUnknown:0,
    belowFloor:0, negativeEv:0, roadFavoriteRule:0, qualified:0, straights:0, parlayLegPool:0 };
  const rejections=formulaPasses.map(p=>({ matchup:p.matchup, sport:p.sport, reason:p.reason, detail:p.detail }));
  const qualified=[];
  for(const c of candidates||[]){
    const reject=(reason)=>{ rejections.push({ matchup:c.matchup, sport:c.sport, side:c.side, reason }); };
    if(c.odds==null||!c.confirmedBook){ funnel.noConfirmedHardRockLine++; reject('lock-no-confirmed-hard-rock-line'); continue; }
    if(!c.last5||!Array.isArray(c.last5.home)||c.last5.home.length<5||!Array.isArray(c.last5.away)||c.last5.away.length<5){ funnel.missingLast5++; reject('lock-missing-last5'); continue; }
    if(!c.injuries||c.injuries.home==null||c.injuries.away==null){ funnel.missingInjuries++; reject('lock-missing-injury-reports'); continue; }
    if(!c.keyStarter||!c.keyStarter.homeConfirmed||!c.keyStarter.awayConfirmed||c.keyStarter.unknownReplacement){ funnel.keyStarterUnknown++; reject('lock-key-starter-unknown'); continue; }
    const grade=gradeForV1(c.sport,c.trueProbability);
    if(!grade){ funnel.belowFloor++; reject('lock-below-grade-floor'); continue; }
    const ev=evFor(c.trueProbability,c.odds);
    if(ev==null||ev<=0){ funnel.negativeEv++; reject('lock-negative-ev'); continue; }
    // Filter 2: road favourite > -7 needs 75%+ (points sports)
    if(c.market==='Spread'&&c.side.startsWith(c.awayTeam)&&c.line!=null&&c.line<=-7&&c.trueProbability<0.75){ funnel.roadFavoriteRule++; reject('lock-road-favorite-75'); continue; }
    funnel.qualified++; qualified.push({c,grade,ev});
  }
  qualified.sort((a,b)=>b.c.trueProbability-a.c.trueProbability||b.ev-a.ev);
  const picks=[]; const used=new Set();
  for(const q of qualified){ if(q.grade==='B') continue; if(used.has(q.c.matchup)) continue; used.add(q.c.matchup); picks.push(toPickV1(q.c,q.grade,q.ev)); }
  funnel.straights=picks.length;
  // Parlay (Spec §8): B and above, distinct games, 0.5u flat. No haircut rule in Spec.
  const legPool=qualified.filter(q=>!used.has(q.c.matchup)||true); // all qualified may be legs; straights already qualify independently
  funnel.parlayLegPool=legPool.length;
  let parlayLegs=[];
  const distinct=[]; const seen=new Set();
  for(const q of qualified){ if(seen.has(q.c.matchup)) continue; seen.add(q.c.matchup); distinct.push(q); if(distinct.length>=3) break; }
  if(distinct.length>=2){
    let dec=1,p=1; for(const q of distinct){ dec*=decFromAmerican(q.c.odds); p*=q.c.trueProbability; }
    const ev=p*dec-1;
    if(ev>0){ const am=dec>=2?Math.round((dec-1)*100):Math.round(-100/(dec-1));
      parlayLegs=[{ type:`${distinct.length}-leg-parlay-v1-lock`, units:'0.5u', combinedOdds:String(am>0?`+${am}`:`${am}`),
        combinedProb:fmtPct(p), ev:fmtPct(ev), uniqueGames:distinct.length, source:'v1-lock',
        legs:distinct.map(q=>toPickV1(q.c,q.grade,q.ev)) }]; }
  }
  return { picks, parlayLegs, funnel, rejections, qualifiedPoolSize:qualified.length };
}
module.exports={ selectV1, receiptV1, evFor, decFromAmerican };
