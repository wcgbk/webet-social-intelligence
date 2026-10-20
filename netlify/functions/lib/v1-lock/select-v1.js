'use strict';
/**
 * V1 selection — Spec §§3,5,6,8,9,10 ONLY.
 * Mandatory passes first, then Filter 1 grading. B = parlay only.
 * No sheet, no haircut, no stake-EV floor beyond Spec §9
 * (negative expected value at the confirmed price = pass).
 * Heavy-favorite guard (config-v1): American odds shorter than -250
 * cannot grade above A-, and lose the straight slot to the next
 * qualifying price that is not that short.
 * Straight EV is win probability times the confirmed decimal price, minus 1.
 * Parlay joint probability is the product of the leg probabilities;
 * parlay EV is that joint probability times the product of the leg decimals, minus 1.
 * Grades are the edge versus the de-vigged Pinnacle fair
 * (trueProbability - pPinnacle). Fallback rows where p equals that fair
 * use the edge versus the price (or the row's edge). Bands: A+ ≥5pp,
 * A 3.5–5, A- 2–3.5, B 1–2 at 0.5u. Below 1pp or EV ≤ 0 does not qualify.
 * Fill still publishes 3 straights when the board has the games: EV>0
 * rows first, then the least-negative EV. Any pick whose edge is below 1pp
 * or whose EV is not positive is rating no-edge, flag no-edge-lean, 0.5u.
 * The parlay uses the same rows.
 * A straight with EV at or below 0 is never an A-family stake.
 */
const { gradeForV1, unitsForGradeV1, MODEL_VERSION_V1, capGradeForPriceV1, isHeavyFavoritePriceV1, isGradeAboveBV1 } = require('./config-v1');
function fmtPct(p){ return p==null||!Number.isFinite(p)?null:`${(p*100).toFixed(1)}%`; }
function decFromAmerican(a){ return a>0?1+a/100:1+100/Math.abs(a); }
function evFor(p, odds){ return odds==null?null:p*decFromAmerican(odds)-1; }
function whatLosesV1(c){
  if(c.market==='Total') return /^over/i.test(c.side)?`The game stays under ${c.line} total points.`:`The game goes over ${c.line} total points.`;
  if(c.market==='Spread') return `${c.side} fails to cover against the final margin.`;
  return `${c.side} loses the game outright.`;
}
function impliedFromAmerican(a){
  const n=Number(a);
  if(!Number.isFinite(n)||n===0) return null;
  return n>0?100/(n+100):Math.abs(n)/(Math.abs(n)+100);
}
function pinnacleFairV1(c){
  if(c&&Number.isFinite(c.pPinnacle)) return c.pPinnacle;
  if(c&&Number.isFinite(c.fairProb)) return c.fairProb;
  return null;
}
/** Grade input: p - pinnacle fair, or the price edge when p equals that fair. */
function edgeForGradeV1(c){
  const p=c&&Number(c.trueProbability);
  const fair=pinnacleFairV1(c);
  if(Number.isFinite(p)&&fair!=null&&Math.abs(p-fair)>1e-6) return p-fair;
  if(c&&Number.isFinite(c.edge)) return c.edge;
  const imp=impliedFromAmerican(c&&c.odds);
  if(Number.isFinite(p)&&imp!=null) return p-imp;
  return null;
}
function edgeOfV1(c){
  const graded=edgeForGradeV1(c);
  if(graded!=null) return graded;
  if(c&&Number.isFinite(c.edge)) return c.edge;
  const imp=impliedFromAmerican(c&&c.odds);
  if(c&&Number.isFinite(c.trueProbability)&&imp!=null) return c.trueProbability-imp;
  return Number.isFinite(c&&c.ev)?c.ev:-Infinity;
}
function receiptV1(c, grade, ev, unitOverride){
  const unit=unitOverride!=null?unitOverride:unitsForGradeV1(grade);
  const bookName=c.confirmedBook||'Hard Rock Bet';
  const method=c.formulaInputs&&c.formulaInputs.method;
  const shrinkNote=(Number.isFinite(c.pPinnacle)&&c.shrinkWeight!=null)
    ? ` Probability is ${Math.round(c.shrinkWeight*100)}% formula / de-vigged Pinnacle fair ${fmtPct(c.pPinnacle)} (raw formula ${fmtPct(c.pFormula)}), capped within 0.08 of that fair.`
    : '';
  const core=c.fallback
    ? `Pinnacle de-vigged fair ${fmtPct(c.trueProbability)} versus the best DraftKings/Hard Rock price ${c.oddsStr} (${bookName}); edge ${fmtPct(c.edge)}.`
    : `Formula line (expected margin ${c.formulaSpreadHome}, expected total ${c.formulaTotal}, inputs: ${method}) prices this at ${fmtPct(c.trueProbability)} against the confirmed Hard Rock Bet line; expected value at that price is ${ev!=null?(ev*100).toFixed(1)+'%':''}.${shrinkNote}`;
  return {
    game:`${c.awayTeam} vs ${c.homeTeam}`,
    pick:c.market==='Moneyline'?c.side:c.side,
    rating:grade||'fallback',
    confirmedLine:`${bookName} ${c.oddsStr}${c.line!=null?` (${c.line})`:''}`,
    trueWinProbability:fmtPct(c.trueProbability),
    last5TeamA:c.last5&&c.last5.away?c.last5.away:null,
    last5TeamB:c.last5&&c.last5.home?c.last5.home:null,
    h2h:c.h2h||null,
    keyInjuryFlags:c.injuries?JSON.stringify(c.injuries):null,
    coreReasoning:core,
    unitSize:`${unit}u`,
    whatLoses:whatLosesV1(c),
  };
}
function canonGradeV1(g){
  if(g==null) return null;
  const map={'a+':'A+','a':'A','a-':'A-','b+':'B+','b':'B','A+':'A+','A':'A','A-':'A-','B+':'B+','B':'B'};
  return map[String(g).trim()]||null;
}
function mustUseLeanFillV1(grade, ev, opts){
  // Fills miss the strict pass. EV<=0 never keeps a grade above B.
  if(opts&&opts.fillLabel) return true;
  if(typeof ev==='number'&&ev>0) return false;
  return isGradeAboveBV1(canonGradeV1(grade))
    ||isGradeAboveBV1(canonGradeV1(opts&&opts.lockGrade))
    ||isGradeAboveBV1(canonGradeV1(opts&&opts.rating));
}
/** Below the 1pp edge floor, or EV that is not positive, is not a graded pick. */
function belowQualifyingThresholdV1(c, ev){
  if(typeof ev==='number'&&!(ev>0)) return true;
  const edge=edgeForGradeV1(c);
  if(edge==null||edge<0.01-1e-12) return true;
  return false;
}
function toPickV1(c, grade, ev, opts={}){
  let unit=opts.units!=null?opts.units:unitsForGradeV1(grade);
  let outGrade=grade;
  let rating=opts.rating!=null?opts.rating:(grade?String(grade).toLowerCase():'fallback');
  let lockGrade=opts.lockGrade!==undefined?opts.lockGrade:grade;
  const noEdge=!!(opts.noEdge)||belowQualifyingThresholdV1(c, ev);
  if(noEdge){
    outGrade='B'; lockGrade='B'; rating='no-edge'; unit=0.5;
  } else if(mustUseLeanFillV1(outGrade, ev, { ...opts, lockGrade, rating })){
    outGrade='B'; lockGrade='B'; rating='lean'; unit=0.5;
  }
  const receiptGrade=rating==='no-edge'?'no-edge':outGrade;
  const r=receiptV1(c,receiptGrade,ev,unit);
  const bookName=c.confirmedBook||'Hard Rock Bet';
  const filterFlags=noEdge?Array.from(new Set([...(c.filterFlags||[]), 'no-edge-lean'])):(c.filterFlags||[]);
  return { sport:c.sport, matchup:c.matchup, homeTeam:c.homeTeam, awayTeam:c.awayTeam,
    pick:r.pick, pickDisplay:r.pick, betType:c.market, odds:c.oddsStr, units:`${unit}u`,
    rating, lockGrade, grade:outGrade, commenceTime:c.commenceTime,
    winProbability:fmtPct(c.trueProbability), trueProbability:c.trueProbability, filterFlags,
    ev:ev!=null?fmtPct(ev):null, edge:Number.isFinite(c.edge)?c.edge:null,
    book:c.book||'hardrockbet', displayBook:bookName, executionBook:bookName,
    fallback:!!(c.fallback||opts.fallback),
    source:'v1-lock', model:MODEL_VERSION_V1, coreReasoning:r.coreReasoning, lockReceipt:r,
    ...(noEdge?{ flag:'no-edge-lean' }:{}),
    formula:{ spreadHome:c.formulaSpreadHome, total:c.formulaTotal, inputs:c.formulaInputs } };
}
function dataGapsV1(c){
  const data=[];
  if(!c.last5||!Array.isArray(c.last5.home)||c.last5.home.length<5||!Array.isArray(c.last5.away)||c.last5.away.length<5) data.push('lock-missing-last5');
  if(!c.injuries||c.injuries.home==null||c.injuries.away==null) data.push('lock-missing-injury-reports');
  if(!c.keyStarter||!c.keyStarter.homeConfirmed||!c.keyStarter.awayConfirmed||c.keyStarter.unknownReplacement) data.push('lock-key-starter-unknown');
  return data;
}
function classifyV1(c){
  if(c.boardCapturedAt&&c.commenceTime&&!(String(c.commenceTime)>String(c.boardCapturedAt))) return { c, hard:'lock-game-started-at-board', funnelKey:'startedAtBoard', data:[], grade:null, ev:null };
  if(c.odds==null||!c.confirmedBook) return { c, hard:'lock-no-confirmed-hard-rock-line', funnelKey:'noConfirmedHardRockLine', data:[], grade:null, ev:null };
  const data=dataGapsV1(c);
  if(c.market==='Spread'&&c.side&&c.side.startsWith(c.awayTeam)&&c.line!=null&&c.line<-7&&c.trueProbability<0.75) return { c, hard:'lock-road-favorite-75', funnelKey:'roadFavoriteRule', data, grade:null, ev:null };
  const flags=[];
  const isAwaySide=c.side&&c.side.startsWith(c.awayTeam); const isHomeSide=c.side&&c.side.startsWith(c.homeTeam);
  if(c.form&&c.market!=='Total'){
    const sideW=isAwaySide?c.form.awayLast10WinPct:(isHomeSide?c.form.homeLast10WinPct:null);
    const oppW=isAwaySide?c.form.homeLast10WinPct:(isHomeSide?c.form.awayLast10WinPct:null);
    if(sideW!=null&&oppW!=null&&sideW<0.5&&oppW>=sideW) return { c, hard:'lock-filter2-form', funnelKey:'filter2Form', data, grade:null, ev:null };
    if(isAwaySide&&c.form.awayLast10WinPct>=0.6) flags.push('strong road form (Filter 2 credit)');
  }
  let lineMoveAgainst=false;
  const ob=c.openBooks&&c.openBooks.hardrockbet;
  if(ob){
    if(c.market==='Spread'&&c.line!=null){ const openLine=isAwaySide?ob.spreadAway:(isHomeSide?ob.spreadHome:null); if(openLine!=null&&c.line-openLine>=0.5) lineMoveAgainst=true; }
    else if(c.market==='Total'&&c.line!=null&&ob.total!=null){ if(/^over/i.test(c.side)&&ob.total-c.line>=1) lineMoveAgainst=true; if(/^under/i.test(c.side)&&c.line-ob.total>=1) lineMoveAgainst=true; }
  }
  if(lineMoveAgainst) flags.push('line movement against pick (Filter 4 flag)');
  if(c.situational){
    if(isAwaySide&&c.situational.homeDemoralized) flags.push('demoralized opponent (Filter 4)');
    if(isHomeSide&&c.situational.awayDemoralized) flags.push('demoralized opponent (Filter 4)');
    if(isAwaySide&&c.situational.awayRevenge) flags.push('revenge spot (Filter 4)');
    if(isHomeSide&&c.situational.homeRevenge) flags.push('revenge spot (Filter 4)');
  }
  const sideLastMargin=isAwaySide?(c.form&&c.form.awayLastGameMargin):(isHomeSide?(c.form&&c.form.homeLastGameMargin):null);
  const trapRisk=c.market==='Spread'&&c.line!=null&&c.line<=-10&&sideLastMargin!=null&&sideLastMargin>=15;
  if(trapRisk){ flags.push('trap-game scrutiny (Filter 4)'); if(lineMoveAgainst) return { c, hard:'lock-filter4-trap-line-against', funnelKey:'filter4Trap', data, grade:null, ev:null }; }
  c.filterFlags=flags;
  const gradeEdge=edgeForGradeV1(c);
  const grade=capGradeForPriceV1(gradeForV1(c.sport, gradeEdge, 'edge'), c.odds);
  const ev=evFor(c.trueProbability,c.odds);
  return { c, hard:null, data, flags, grade, ev, gradeEdge };
}
function qualifiesV1(row, soften){
  if(row.hard) return false;
  if(row.data.length&&!row.c.fallback&&!soften) return false;
  // Below 1pp has no grade. B (1–2pp) qualifies at 0.5u. EV<=0 never qualifies.
  if(!row.grade) return false;
  if(row.ev==null||row.ev<=0) return false;
  return true;
}
function takeStraightsV1(pool){
  const picks=[]; const used=new Set();
  // Non-heavy prices first. A -425 at 80% must not outrank the next
  // qualifying straight just because win-probability grading is high.
  const sorted=[...pool].sort((a,b)=>{
    const ha=isHeavyFavoritePriceV1(a.c.odds)?1:0;
    const hb=isHeavyFavoritePriceV1(b.c.odds)?1:0;
    if(ha!==hb) return ha-hb;
    return b.c.trueProbability-a.c.trueProbability||(b.ev||0)-(a.ev||0);
  });
  for(const q of sorted){
    if(picks.length>=3) break;
    if(used.has(q.c.matchup)) continue;
    used.add(q.c.matchup);
    picks.push(toPickV1(q.c,q.grade,q.ev));
  }
  return picks;
}
function bestByGameV1(rows, skip){
  const best=new Map();
  for(const row of rows){
    if(row.hard||skip.has(row.c.matchup)) continue;
    const e=edgeOfV1(row.c);
    const prev=best.get(row.c.matchup);
    if(!prev||e>prev.e) best.set(row.c.matchup,{ row, e });
  }
  return [...best.values()].sort((a,b)=>b.e-a.e);
}
function leanFillPickV1(row){
  return toPickV1({ ...row.c, fallback:true }, 'B', row.ev, { fallback:true, units:0.5, rating:'lean', lockGrade:'B', fillLabel:true });
}
function noEdgeFillPickV1(row){
  const flags=Array.from(new Set([...(row.c.filterFlags||[]), 'no-edge-lean']));
  const edge=edgeForGradeV1(row.c);
  const lowEdge=edge==null||edge<0.01-1e-12;
  const negEv=!(row.ev>0);
  const why=negEv&&lowEdge
    ? 'edge is below 1 percentage point and expected value is not positive'
    : (negEv ? 'expected value is not positive' : 'edge is below 1 percentage point');
  const note=`No-edge lean: ${why}. Published at 0.5u to complete the card.`;
  const pick=toPickV1({ ...row.c, fallback:true, filterFlags:flags }, 'B', row.ev, { fallback:true, units:0.5, rating:'no-edge', lockGrade:'B', noEdge:true });
  pick.coreReasoning=`${note} ${pick.coreReasoning||''}`.trim();
  pick.flag='no-edge-lean';
  pick.filterFlags=flags;
  pick.rating='no-edge';
  pick.grade='B';
  pick.lockGrade='B';
  pick.units='0.5u';
  if(pick.lockReceipt){
    pick.lockReceipt.coreReasoning=pick.coreReasoning;
    pick.lockReceipt.rating='no-edge';
    pick.lockReceipt.unitSize='0.5u';
  }
  return pick;
}
function rowsByEvV1(rows, used, pred){
  const best=new Map();
  for(const row of rows){
    if(row.hard||used.has(row.c.matchup)) continue;
    if(pred&&!pred(row)) continue;
    const ev=Number.isFinite(row.ev)?row.ev:-Infinity;
    const prev=best.get(row.c.matchup);
    if(!prev||ev>prev.ev) best.set(row.c.matchup,{ row, ev });
  }
  return [...best.values()].sort((a,b)=>b.ev-a.ev);
}
function fmtUnitsV1(n){
  const r=Math.round((Number(n)||0)*100)/100;
  return `${r}u`;
}
function summaryTotalsV1(picks, parlayLegs){
  const straightUnits=(picks||[]).reduce((s,p)=>s+(parseFloat(p.units)||0),0);
  const parlayUnits=(parlayLegs||[]).reduce((s,p)=>s+(parseFloat(p.units)||0),0);
  // Partition straight units by the published grade. A lean fill is grade B,
  // so its stake cannot land in an A-family total.
  const gradeUnits={'A+':0,'A':0,'A-':0,'B+':0,'B':0};
  let leanUnits=0;
  for(const p of picks||[]){
    const units=parseFloat(p.units)||0;
    if(p.rating==='lean') leanUnits+=units;
    const g=p.rating==='lean'?'B':(p.lockGrade||p.grade);
    if(Object.prototype.hasOwnProperty.call(gradeUnits, g)) gradeUnits[g]+=units;
  }
  const formatted={};
  for(const k of Object.keys(gradeUnits)) formatted[k]=fmtUnitsV1(gradeUnits[k]);
  return {
    totalPicks:(picks||[]).length,
    totalStraightBets:(picks||[]).length,
    straightUnits:fmtUnitsV1(straightUnits),
    totalUnits:fmtUnitsV1(straightUnits+parlayUnits),
    gradeUnits:formatted,
    leanUnits:fmtUnitsV1(leanUnits),
  };
}
function parlayFromPicksV1(legs){
  if(!legs||legs.length<3) return [];
  const three=legs.slice(0,3);
  let dec=1, p=1;
  for(const leg of three){
    const odds=Number(leg.odds); const prob=Number(leg.trueProbability);
    if(!Number.isFinite(odds)||!Number.isFinite(prob)) return [];
    // Decimal of the confirmed American price, not the American number itself.
    dec*=decFromAmerican(odds); p*=prob;
  }
  if(!(dec>1)||!Number.isFinite(p)) return [];
  // Joint p = product of leg probabilities. EV at the product of decimals.
  const ev=p*dec-1;
  const am=dec>=2?Math.round((dec-1)*100):Math.round(-100/(dec-1));
  return [{ type:'3-leg-parlay-v1-lock', units:'0.5u', combinedOdds:String(am>0?`+${am}`:`${am}`),
    combinedProb:fmtPct(p), ev:fmtPct(ev), uniqueGames:3, source:'v1-lock', legs:three }];
}
function selectV1(candidates, formulaPasses=[]){
  const funnel={ candidates:(candidates||[]).length, formulaPassGames:formulaPasses.length,
    startedAtBoard:0, noConfirmedHardRockLine:0, missingLast5:0, missingInjuries:0, keyStarterUnknown:0,
    belowFloor:0, negativeEv:0, roadFavoriteRule:0, filter2Form:0, filter4Trap:0, qualified:0, straights:0, parlayLegPool:0, fallbackFill:0 };
  const diagnostics={ fallback:[], dataFlags:[] };
  const rejections=formulaPasses.map(p=>({ matchup:p.matchup, sport:p.sport, reason:p.reason, detail:p.detail }));
  const rows=(candidates||[]).map(classifyV1);
  const strictPool=rows.filter(r=>qualifiesV1(r,false));
  const soften=takeStraightsV1(strictPool).length<3;
  const qualified=rows.filter(r=>qualifiesV1(r,soften));
  let picks=takeStraightsV1(qualified);
  for(const row of rows){
    if(row.hard){ funnel[row.funnelKey]++; rejections.push({ matchup:row.c.matchup, sport:row.c.sport, side:row.c.side, reason:row.hard }); }
    if(row.data.includes('lock-missing-last5')) funnel.missingLast5++;
    if(row.data.includes('lock-missing-injury-reports')) funnel.missingInjuries++;
    if(row.data.includes('lock-key-starter-unknown')) funnel.keyStarterUnknown++;
    if(row.data.length&&!row.hard){
      if(row.c.fallback||soften) diagnostics.dataFlags.push({ matchup:row.c.matchup, sport:row.c.sport, side:row.c.side, flags:row.data, fallback:!!row.c.fallback });
      else rejections.push({ matchup:row.c.matchup, sport:row.c.sport, side:row.c.side, reason:row.data[0] });
    }
    if(row.hard) continue;
    if(!row.grade){ funnel.belowFloor++; if(!row.c.fallback) rejections.push({ matchup:row.c.matchup, sport:row.c.sport, side:row.c.side, reason:'lock-below-grade-floor' }); }
    else if(row.ev==null||row.ev<=0){ funnel.negativeEv++; if(!row.c.fallback) rejections.push({ matchup:row.c.matchup, sport:row.c.sport, side:row.c.side, reason:'lock-negative-ev' }); }
    else if(qualifiesV1(row,soften)) funnel.qualified++;
  }
  const pushFill=(row, e, noEdge)=>{
    const pick=noEdge?noEdgeFillPickV1(row):leanFillPickV1(row);
    picks.push(pick);
    diagnostics.fallback.push({
      matchup:row.c.matchup, side:row.c.side, sport:row.c.sport, edge:e,
      grade:'B', rating:noEdge?'no-edge':'lean', flag:noEdge?'no-edge-lean':null,
      flags:row.data, fill:true,
    });
    funnel.fallbackFill++;
  };
  // Prefer any remaining EV>0 game. Only then pad with the least-negative EV.
  if(picks.length<3){
    const used=new Set(picks.map(p=>p.matchup));
    for(const { row, ev } of rowsByEvV1(rows, used, r=>r.ev!=null&&r.ev>0)){
      if(picks.length>=3) break;
      // Positive EV under 1pp still missed the qualifying grade.
      pushFill(row, ev, true); used.add(row.c.matchup);
    }
  }
  if(picks.length<3){
    const used=new Set(picks.map(p=>p.matchup));
    for(const { row, ev } of rowsByEvV1(rows, used, r=>!(r.ev>0))){
      if(picks.length>=3) break;
      pushFill(row, ev, true); used.add(row.c.matchup);
    }
  }
  funnel.straights=picks.length;
  let legPicks=picks.slice(0,3);
  if(legPicks.length<3){
    const seen=new Set(legPicks.map(p=>p.matchup));
    const positive=rowsByEvV1(rows, seen, r=>r.ev!=null&&r.ev>0);
    const negative=rowsByEvV1(rows, seen, r=>!(r.ev>0));
    for(const { row } of positive.concat(negative)){
      if(legPicks.length>=3) break;
      legPicks.push(noEdgeFillPickV1(row));
      seen.add(row.c.matchup);
    }
  }
  const parlayLegs=parlayFromPicksV1(legPicks);
  funnel.parlayLegPool=legPicks.length;
  return { picks, parlayLegs, funnel, rejections, diagnostics, qualifiedPoolSize:qualified.length };
}
module.exports={ selectV1, receiptV1, evFor, decFromAmerican, summaryTotalsV1 };
