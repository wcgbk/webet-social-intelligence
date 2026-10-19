'use strict';
/**
 * V1 projection — Spec §§4,6,7.4/7.5. Football fully implemented.
 * True probability is a FORMULA probability from team strength ONLY
 * (expected margin / expected total vs the confirmed line).
 * No market anchor, no fitted weight, no bias correction, no hand points.
 * Confirmed line = Hard Rock Bet only (Spec §3.1). Other books are ignored.
 * NHL/NBA/NCAAM/MLB have no V1 projector. Those sports use a Pinnacle
 * de-vigged fair probability against the best DraftKings/Hard Rock price
 * on the stored board. Never a borrowed Omega pick, never a live fetch.
 */
const { footballProjection } = require('../omega-vnext/sports/epa');
const { spreadCoverProb, totalCoverProb, mlFromSpread, formatMatchup } = require('../omega-vnext/sports/_common');
const { collectMarketOutcomes, sharpFairForSide } = require('../omega-vnext/edge');
const { americanToImplied } = require('../omega-vnext/odds_math');

function isHardRock(book){ const k=String(book||'').toLowerCase(); return k==='hardrockbet'||k==='hardrock'||k==='hardrockbet_oh'; }
function isDraftKings(book){ return String(book||'').toLowerCase()==='draftkings'; }
function hardRockPriceV1(target){
  const p=((target&&target.prices)||[]).find(x=>isHardRock(x.book));
  return p && Number.isFinite(p.american) ? p : null;
}
/** Best of draftkings and hardrockbet. Higher American is the better price. */
function bestDkHrPriceV1(prices){
  let best=null;
  for(const p of prices||[]){
    if(!isHardRock(p.book)&&!isDraftKings(p.book)) continue;
    if(!Number.isFinite(p.american)) continue;
    if(!best||p.american>best.american) best=p;
  }
  return best;
}
function hasPinnaclePrice(bundle){
  return !!(bundle&&(bundle.prices||[]).some(p=>String(p.book||'').toLowerCase()==='pinnacle'&&Number.isFinite(Number(p.american))));
}
function oppositeBundleV1(bundles, target){
  if(!target) return null;
  if(target.point==null) return (bundles||[]).find(s=>s.side!==target.side)||null;
  return (bundles||[]).find(s=>{
    if(s===target) return false;
    if(/over|under/i.test(target.side)&&/over|under/i.test(s.side)) return s.point===target.point;
    return s.point===-target.point;
  })||null;
}
/**
 * No projector: de-vigged Pinnacle fair vs best DK/Hard Rock price.
 * edge = fair prob − implied prob of that price. Missing Pinnacle pair or
 * missing DK/Hard Rock price produces no candidate.
 */
function projectFallbackV1(event, sport, meta){
  const home=event.home_team, away=event.away_team, commenceTime=event.commence_time;
  const matchup=formatMatchup(away, home);
  const gameMeta=(meta.byGame&&meta.byGame[matchup])||{};
  const base={ sport, homeTeam:home, awayTeam:away, matchup, commenceTime,
    fallback:true, projector:'pinnacle-fair',
    formulaSpreadHome:null, formulaTotal:null,
    formulaInputs:{ method:'pinnacle-fair-devig' },
    last5:gameMeta.last5||null, injuries:gameMeta.injuries||null, h2h:gameMeta.h2h||null,
    form:gameMeta.form||null, situational:gameMeta.situational||null, openBooks:event.openBooks||null,
    keyStarter:gameMeta.keyStarter||null, boardSlot:meta.boardSlot||null, boardCapturedAt:meta.boardCapturedAt||null };
  const out=[];
  const markets=[['h2h','Moneyline'],['spreads','Spread'],['totals','Total']];
  for(const [key, market] of markets){
    const bundles=collectMarketOutcomes(event, key);
    for(const b of bundles){
      if(key!=='h2h'&&b.point==null) continue;
      const opp=oppositeBundleV1(bundles, b);
      if(!hasPinnaclePrice(b)||!hasPinnaclePrice(opp)) continue;
      const fair=sharpFairForSide(bundles, b.side, b.point);
      const px=bestDkHrPriceV1(b.prices);
      if(fair==null||!px) continue;
      const implied=americanToImplied(px.american);
      if(implied==null) continue;
      const edge=fair-implied;
      const side=market==='Moneyline'?b.side:(market==='Total'?`${b.side} ${b.point}`:(b.point>0?`${b.side} +${b.point}`:`${b.side} ${b.point}`));
      const hr=isHardRock(px.book);
      out.push({ ...base, market, side, line:market==='Moneyline'?null:b.point,
        trueProbability:+fair.toFixed(6), edge:+edge.toFixed(6), fairProb:+fair.toFixed(6), impliedProb:+implied.toFixed(6),
        confirmedBook:hr?'Hard Rock Bet':'DraftKings', odds:px.american,
        oddsStr:String(px.american>0?`+${px.american}`:`${px.american}`), book:hr?'hardrockbet':'draftkings' });
    }
  }
  if(!out.length){
    return { candidates:[], pass:{ matchup, sport, commenceTime, reason:'v1-no-pinnacle-fair',
      detail:'No de-vigged Pinnacle pair versus a DraftKings or Hard Rock price on the stored board.' } };
  }
  return { candidates:out, pass:null };
}
function projectGameV1(event, sport, efficiency, meta={}) {
  const home=event.home_team, away=event.away_team, commenceTime=event.commence_time;
  const matchup=formatMatchup(away,home);
  if (!['NFL','NCAAF'].includes(sport)) {
    return projectFallbackV1(event, sport, meta);
  }
  const env=footballProjection({ sport, home, away, standings:{}, efficiency:efficiency||{} });
  const formulaComplete=!!(env && env.usedEpa && Number.isFinite(env.modelMargin) && Number.isFinite(env.modelTotal));
  if (!formulaComplete) {
    return { candidates:[], pass:{ matchup, sport, commenceTime, reason:'lock-missing-formula',
      detail:'Team-strength ratings missing for one or both teams; no traceable formula probability (Spec §§4,6,9).' } };
  }
  let modelMargin=env.modelMargin, modelTotal=env.modelTotal;
  const gameMeta=(meta.byGame&&meta.byGame[matchup])||{};
  // Spec §4 Tier 1: last 5 is the dominant read of team strength. When both
  // teams have 5 completed games on file, the formula margin blends the
  // season ratings margin (0.40) with the last-5 net margin (0.60, capped).
  // Entries without a numeric margin (test fixtures) leave the formula as-is.
  let last5Net=null;
  const l5=gameMeta.last5;
  const avgMargin=(rows)=>{ if(!Array.isArray(rows)||!rows.length||!rows.every(r=>r&&Number.isFinite(r.margin))) return null; return rows.reduce((s,r)=>s+r.margin,0)/rows.length; };
  if(l5){ const am=avgMargin(l5.away), hm=avgMargin(l5.home); if(am!=null&&hm!=null){ last5Net=Math.max(-21,Math.min(21,hm-am)); modelMargin=0.40*modelMargin+0.60*last5Net; } }
  const base={ sport, homeTeam:home, awayTeam:away, matchup, commenceTime,
    formulaSpreadHome:+modelMargin.toFixed(2), formulaTotal:+modelTotal.toFixed(2),
    formulaInputs:{ method:(env.methods&&env.methods.family)||'team-strength ratings', seasonMargin:+env.modelMargin.toFixed(2), last5NetMargin:last5Net, modelMargin:+modelMargin.toFixed(2), modelTotal:+modelTotal.toFixed(2) },
    last5: gameMeta.last5||null, injuries: gameMeta.injuries||null, h2h: gameMeta.h2h||null, form: gameMeta.form||null, situational: gameMeta.situational||null, openBooks: event.openBooks||null,
    keyStarter: gameMeta.keyStarter||null, // {homeConfirmed,awayConfirmed,unknownReplacement,note}
    boardSlot: meta.boardSlot||null, boardCapturedAt: meta.boardCapturedAt||null };
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
