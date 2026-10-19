'use strict';
/**
 * V1 projection — Spec §§4,6,7.4/7.5. Football fully implemented.
 * The formula probability comes from team strength ONLY
 * (expected margin / expected total vs the confirmed line).
 * No fitted bias, no hand points. Confirmed price = Hard Rock Bet only
 * (Spec §3.1). DraftKings is not a football price.
 *
 * NFL/NCAAF calibration: the raw formula (EPA margin, often on the sport
 * cap, mapped through a normal with the sport spread SD) is not the
 * probability we grade or price. When Pinnacle posts that market, shrink
 *   p = w * p_formula + (1 - w) * p_pinnacle
 * with w = 0.35, then cap |p - p_pinnacle| at 0.08. p_pinnacle is the
 * power de-vig of the two Pinnacle prices. The same point is used as-is.
 * A different point within 3 is pushed onto the confirmed number with the
 * sport normal SD (a half-point move is not a license to keep a 97% formula).
 * No Pinnacle quote leaves the formula unchanged. Straight and parlay EV
 * both use this p at the actual decimal of the confirmed price.
 * NHL/NBA/NCAAM/MLB have no V1 projector. Those sports use a Pinnacle
 * de-vigged fair probability against the best DraftKings/Hard Rock price
 * on the stored board. Never a borrowed Omega pick, never a live fetch.
 */
const { footballProjection } = require('../omega-vnext/sports/epa');
const { spreadCoverProb, totalCoverProb, mlFromSpread, formatMatchup } = require('../omega-vnext/sports/_common');
const { collectMarketOutcomes, sharpFairForSide } = require('../omega-vnext/edge');
const { americanToImplied, noVigTwoWay, normCdf } = require('../omega-vnext/odds_math');
const { SPORT_SPREAD_STD, SPORT_TOTAL_STD } = require('../omega-vnext/config');

const FORMULA_WEIGHT_FOOTBALL_V1 = 0.35;
const PINNACLE_DEV_CAP_V1 = 0.08;
const PINNACLE_POINT_GAP_V1 = 3;
const FORMULA_WEIGHT_V1 = { NFL: FORMULA_WEIGHT_FOOTBALL_V1, NCAAF: FORMULA_WEIGHT_FOOTBALL_V1 };

function normInv(p){
  const target=Math.min(0.999, Math.max(0.001, Number(p)));
  let lo=-8, hi=8;
  for(let i=0;i<60;i++){
    const mid=(lo+hi)/2;
    if(normCdf(mid)<target) lo=mid; else hi=mid;
  }
  return (lo+hi)/2;
}

function bookAmerican(bundle, book){
  const row=((bundle&&bundle.prices)||[]).find(p=>String(p.book||'').toLowerCase()===book&&Number.isFinite(Number(p.american)));
  return row?Number(row.american):null;
}
/** De-vigged Pinnacle fair for this exact side and point. Null when Pinnacle does not post both sides of the line. */
function pinnacleFairForBundle(bundles, bundle){
  const opp=oppositeBundleV1(bundles, bundle);
  if(!bundle||!opp) return null;
  const a1=bookAmerican(bundle,'pinnacle');
  const a2=bookAmerican(opp,'pinnacle');
  if(a1==null||a2==null) return null;
  const nv=noVigTwoWay(a1, a2);
  return nv&&Number.isFinite(nv.p1)?nv.p1:null;
}
/**
 * De-vigged Pinnacle fair at the confirmed point.
 * Exact point when Pinnacle posts it. Otherwise the closest Pinnacle
 * number within 3 points, pushed with the sport spread/total SD.
 */
function pinnacleFairAtLine(bundles, bundle, sport){
  const exact=pinnacleFairForBundle(bundles, bundle);
  if(exact!=null||!bundle||bundle.point==null) return exact;
  const isTotal=/over|under/i.test(bundle.side);
  let best=null, bestDist=Infinity;
  for(const s of bundles||[]){
    if(!s||s===bundle||s.point==null) continue;
    if(String(s.side).toLowerCase()!==String(bundle.side).toLowerCase()) continue;
    const dist=Math.abs(Number(s.point)-Number(bundle.point));
    if(!(dist>1e-9)||dist>PINNACLE_POINT_GAP_V1||dist>=bestDist) continue;
    const fair=pinnacleFairForBundle(bundles, s);
    if(fair==null) continue;
    bestDist=dist; best={ fair, point:Number(s.point) };
  }
  if(!best) return null;
  const key=String(sport||'').toUpperCase();
  const std=isTotal?(SPORT_TOTAL_STD[key]||10):(SPORT_SPREAD_STD[key]||13.5);
  if(!(std>0)) return null;
  const z=normInv(best.fair);
  const d=Number(bundle.point)-best.point;
  const z2=/^over/i.test(bundle.side)?z-d/std:(/^under/i.test(bundle.side)?z+d/std:z+d/std);
  const p=normCdf(z2);
  return Number.isFinite(p)?p:null;
}
/**
 * p = w*p_formula + (1-w)*p_pinnacle, then |p - p_pinnacle| <= 0.08.
 * Non-football sports and a missing Pinnacle fair return p_formula.
 */
function shrinkFormulaProbV1(pFormula, pPinnacle, sport){
  const pRaw=Number(pFormula);
  if(!Number.isFinite(pRaw)) return { p:pFormula, shrunk:false, w:null, pPinnacle:null, pFormula };
  const w=FORMULA_WEIGHT_V1[String(sport||'').toUpperCase()];
  // null/undefined is "no Pinnacle quote". Number(null) is 0, which is not a fair.
  if(w==null||pPinnacle==null||pPinnacle==='') return { p:pRaw, shrunk:false, w:w==null?null:w, pPinnacle:null, pFormula:pRaw };
  const pin=Number(pPinnacle);
  if(!Number.isFinite(pin)) return { p:pRaw, shrunk:false, w, pPinnacle:null, pFormula:pRaw };
  let p=w*pRaw+(1-w)*pin;
  const lo=pin-PINNACLE_DEV_CAP_V1, hi=pin+PINNACLE_DEV_CAP_V1;
  if(p<lo) p=lo;
  if(p>hi) p=hi;
  if(p<1e-6) p=1e-6;
  if(p>1-1e-6) p=1-1e-6;
  return { p, shrunk:true, w, pPinnacle:pin, pFormula:pRaw };
}

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
      const raw=built.pModel;
      const pin=pinnacleFairAtLine(bundles, b, sport);
      const shrunk=shrinkFormulaProbV1(raw, pin, sport);
      const p=shrunk.p;
      const hr=hardRockPriceV1(b);
      const implied=hr?americanToImplied(hr.american):null;
      const edge=(Number.isFinite(p)&&implied!=null)?p-implied:null;
      out.push({ ...base, ...built, pModel:p,
        pFormula:Number.isFinite(raw)?+Number(raw).toFixed(6):null,
        pPinnacle:Number.isFinite(pin)?+pin.toFixed(6):null,
        shrinkWeight:shrunk.shrunk?shrunk.w:null,
        trueProbability:Number.isFinite(p)?+p.toFixed(6):null,
        edge:edge!=null?+edge.toFixed(6):null,
        fairProb:Number.isFinite(pin)?+pin.toFixed(6):null,
        impliedProb:implied!=null?+implied.toFixed(6):null,
        formulaInputs:{ ...base.formulaInputs,
          pFormula:Number.isFinite(raw)?+Number(raw).toFixed(6):null,
          pPinnacle:Number.isFinite(pin)?+pin.toFixed(6):null,
          shrinkW:shrunk.shrunk?shrunk.w:null,
          pinnacleDevCap:shrunk.shrunk?PINNACLE_DEV_CAP_V1:null },
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
module.exports={ projectGameV1, projectAllV1, isHardRock, shrinkFormulaProbV1, pinnacleFairForBundle, pinnacleFairAtLine,
  FORMULA_WEIGHT_FOOTBALL_V1, PINNACLE_DEV_CAP_V1, PINNACLE_POINT_GAP_V1 };
