'use strict';
/**
 * V1 projection — Spec §§4,6,7.4/7.5. Football fully implemented.
 * True probability is a FORMULA probability from team strength ONLY
 * (expected margin / expected total vs the confirmed line).
 * No market anchor, no fitted weight, no bias correction, no hand points.
 * Confirmed line = Hard Rock Bet only (Spec §3.1). Other books are ignored.
 * NHL/NBA/NCAAM/MLB: no V1 projector in this build -> documented pass
 * (Spec §9, formula inputs unavailable), never a borrowed Omega pick.
 */
const { footballProjection } = require('../omega-vnext/sports/epa');
const { spreadCoverProb, totalCoverProb, mlFromSpread, formatMatchup } = require('../omega-vnext/sports/_common');
const { collectMarketOutcomes } = require('../omega-vnext/edge');

function isHardRock(book){ const k=String(book||'').toLowerCase(); return k==='hardrockbet'||k==='hardrock'||k==='hardrockbet_oh'; }
function hardRockPriceV1(target){
  const p=((target&&target.prices)||[]).find(x=>isHardRock(x.book));
  return p && Number.isFinite(p.american) ? p : null;
}
function projectGameV1(event, sport, efficiency, meta={}) {
  const home=event.home_team, away=event.away_team, commenceTime=event.commence_time;
  const matchup=formatMatchup(away,home);
  if (!['NFL','NCAAF'].includes(sport)) {
    return { candidates:[], pass:{ matchup, sport, commenceTime, reason:'v1-no-projector-for-sport',
      detail:'No V1 formula projector for this sport in this build; pass per Spec §9 (formula inputs unavailable).' } };
  }
  const env=footballProjection({ sport, home, away, standings:{}, efficiency:efficiency||{} });
  const formulaComplete=!!(env && env.usedEpa && Number.isFinite(env.modelMargin) && Number.isFinite(env.modelTotal));
  if (!formulaComplete) {
    return { candidates:[], pass:{ matchup, sport, commenceTime, reason:'lock-missing-formula',
      detail:'Team-strength ratings missing for one or both teams; no traceable formula probability (Spec §§4,6,9).' } };
  }
  const modelMargin=env.modelMargin, modelTotal=env.modelTotal;
  const gameMeta=(meta.byGame&&meta.byGame[matchup])||{};
  const base={ sport, homeTeam:home, awayTeam:away, matchup, commenceTime,
    formulaSpreadHome:+modelMargin.toFixed(2), formulaTotal:+modelTotal.toFixed(2),
    formulaInputs:{ method:(env.methods&&env.methods.family)||'team-strength ratings', modelMargin:+modelMargin.toFixed(2), modelTotal:+modelTotal.toFixed(2) },
    last5: gameMeta.last5||null, injuries: gameMeta.injuries||null, h2h: gameMeta.h2h||null,
    keyStarter: gameMeta.keyStarter||null, // {homeConfirmed,awayConfirmed,unknownReplacement,note}
    boardSlot: meta.boardSlot||null };
  const out=[];
  const emit=(bundles,build)=>{
    for(const b of bundles){ if(b.point===undefined) continue; const built=build(b); if(!built) continue;
      const hr=hardRockPriceV1(b);
      out.push({ ...base, ...built, trueProbability: Number.isFinite(built.pModel)?+built.pModel.toFixed(6):null,
        confirmedBook: hr?'Hard Rock Bet':null, odds: hr?hr.american:null,
        oddsStr: hr?String(hr.american>0?`+${hr.american}`:`${hr.american}`):null, book: hr?'hardrockbet':null });
    }};
  emit(collectMarketOutcomes(event,'h2h'),(b)=>{ const isHome=b.side===home; const p=isHome?mlFromSpread(modelMargin,sport):1-mlFromSpread(modelMargin,sport); return { market:'Moneyline', side:b.side, line:null, pModel:p }; });
  emit(collectMarketOutcomes(event,'spreads'),(b)=>{ if(b.point==null) return null; const isHome=b.side===home; const p=spreadCoverProb(isHome?modelMargin:-modelMargin,b.point,sport); return { market:'Spread', side:b.point>0?`${b.side} +${b.point}`:`${b.side} ${b.point}`, line:b.point, pModel:p }; });
  emit(collectMarketOutcomes(event,'totals'),(b)=>{ if(b.point==null) return null; const p=totalCoverProb(modelTotal,b.point,b.side,sport); return { market:'Total', side:`${b.side} ${b.point}`, line:b.point, pModel:p }; });
  return { candidates:out, pass:null };
}
function projectAllV1(events, efficiencyBySport, meta={}) {
  const candidates=[], passes=[];
  for(const ev of events||[]){ const sport=ev.sport;
    try{ const r=projectGameV1(ev,sport,(efficiencyBySport||{})[sport]||{},meta); candidates.push(...r.candidates); if(r.pass) passes.push(r.pass); }
    catch(e){ passes.push({ matchup:`${ev.away_team} @ ${ev.home_team}`, sport, commenceTime:ev.commence_time, reason:'lock-missing-formula', detail:e.message }); }
  }
  return { candidates, passes };
}
module.exports={ projectGameV1, projectAllV1, isHardRock };
