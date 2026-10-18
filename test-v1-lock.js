'use strict';
/** V1 — The Lock Unified Spec v2.0 tests. No network, no blobs. */
const assert=require('assert'); const path=require('path');
const L=p=>require(path.join(__dirname,'netlify/functions/lib/v1-lock',p));
const { gradeForV1, floorForV1, unitsForGradeV1, SPORTS_V1 }=L('config-v1');
const { selectBoardPollV1, reconstructEventsV1 }=L('board-v1');
const { projectGameV1 }=L('project-v1');
const { selectV1, evFor }=L('select-v1');
assert.deepStrictEqual(SPORTS_V1,['NFL','NCAAF','NHL','NBA','NCAAM','MLB']);
// Grading bands (Spec §6)
assert.strictEqual(gradeForV1('NFL',0.80),'A+'); assert.strictEqual(gradeForV1('NCAAF',0.75),'A');
assert.strictEqual(gradeForV1('NBA',0.60),'B'); assert.strictEqual(gradeForV1('NFL',0.59),null);
assert.strictEqual(gradeForV1('NHL',0.70),'A+'); assert.strictEqual(gradeForV1('MLB',0.58),'B'); assert.strictEqual(gradeForV1('MLB',0.57),null);
assert.strictEqual(floorForV1('NFL'),0.60); assert.strictEqual(floorForV1('NHL'),0.58);
assert.strictEqual(unitsForGradeV1('A+'),2.0); assert.strictEqual(unitsForGradeV1('B'),0.5);
// EV (Spec §9 negative-EV pass)
assert.ok(Math.abs(evFor(0.55,-110)-0.05)<1e-9);
// Board poll
assert.strictEqual(selectBoardPollV1([{hhmm:'0600',games:{a:{}}},{hhmm:'0915',games:{a:{}}},{hhmm:'1200',games:{a:{}}}]).hhmm,'0915');
const games={'Away @ Home':{sport:'NFL',homeTeam:'Home',awayTeam:'Away',commenceTime:'2026-10-18T17:00:00Z',books:{
  hardrockbet:{spreadHome:-3,spreadHomeOdds:-110,spreadAway:3,spreadAwayOdds:-110,total:45,overOdds:-110,underOdds:-110,mlHome:-150,mlAway:130},
  draftkings:{spreadHome:-3,spreadHomeOdds:-105,spreadAway:3,spreadAwayOdds:-115,total:45,overOdds:-108,underOdds:-112,mlHome:-145,mlAway:125}}}};
const events=reconstructEventsV1(games); assert.strictEqual(events.length,1);
const eff={'Home':{offEpa:0.10,defEpa:0.05},'Away':{offEpa:-0.05,defEpa:-0.02}};
// Formula traceability + Hard Rock only
{ const {candidates,pass}=projectGameV1(events[0],'NFL',eff,{}); assert.strictEqual(pass,null); assert.ok(candidates.length>=6);
  const s=candidates.find(c=>c.market==='Spread'&&c.side.startsWith('Away'));
  assert.ok(s.formulaSpreadHome!=null&&s.formulaTotal!=null&&s.formulaInputs); assert.strictEqual(s.book,'hardrockbet'); assert.strictEqual(s.confirmedBook,'Hard Rock Bet'); assert.ok(s.trueProbability>0&&s.trueProbability<1); }
// Missing ratings = pass
{ const {candidates,pass}=projectGameV1(events[0],'NFL',{},{}); assert.strictEqual(candidates.length,0); assert.strictEqual(pass.reason,'lock-missing-formula'); }
// No Hard Rock line = pass at selection (even if other books exist)
{ const noHR=reconstructEventsV1({'Away @ Home':{...games['Away @ Home'],books:{draftkings:games['Away @ Home'].books.draftkings}}});
  const {candidates}=projectGameV1(noHR[0],'NFL',eff,{}); const sel=selectV1(candidates,[]);
  assert.strictEqual(sel.picks.length,0); assert.ok(sel.funnel.noConfirmedHardRockLine>=6); }
// Missing last-5 = pass; missing injuries = pass; key starter unknown = pass
const fullMeta={byGame:{'Away @ Home':{last5:{home:[1,2,3,4,5],away:[1,2,3,4,5]},injuries:{home:[],away:[]},keyStarter:{homeConfirmed:true,awayConfirmed:true,unknownReplacement:false}}}};
{ const {candidates}=projectGameV1(events[0],'NFL',eff,{}); const sel=selectV1(candidates,[]); assert.strictEqual(sel.picks.length,0); assert.ok(sel.funnel.missingLast5>=1); }
{ const {candidates}=projectGameV1(events[0],'NFL',eff,fullMeta);
  // with full data, any pick must carry 12-field receipt and Hard Rock line
  const sel=selectV1(candidates,[]);
  for(const p of sel.picks){ const r=p.lockReceipt; for(const k of ['game','pick','rating','confirmedLine','trueWinProbability','last5TeamA','last5TeamB','h2h','keyInjuryFlags','coreReasoning','unitSize','whatLoses']) assert.ok(k in r, `receipt missing ${k}`); assert.strictEqual(p.book,'hardrockbet'); }
  // B-grade picks never appear as straights
  assert.ok(sel.picks.every(p=>p.grade!=='B')); }
// Non-football sport = documented pass, no borrowed projector
{ const ev2={...events[0],sport:'NHL'}; const {candidates,pass}=projectGameV1(ev2,'NHL',{},{}); assert.strictEqual(candidates.length,0); assert.strictEqual(pass.reason,'v1-no-projector-for-sport'); }
console.log('test-v1-lock: ALL PASS (Spec v2.0)');
// --- Oct 18 additions: odds-master board + Filters 2/4 (appendix assertions) ---
{ const { pickTimestamp, applyPrice }=L('board-master-v1');
  assert.strictEqual(pickTimestamp({checks:{'1000':{at:'T10'}},baseline0300:{at:'T03'}}).hhmm,'1000');
  assert.strictEqual(pickTimestamp({baseline0300:{at:'T03'}}).hhmm,'0300');
  const row={}; applyPrice(row,'spreads',{home:{price:-105,line:-3},away:{price:-115,line:3}});
  assert.strictEqual(row.spreadHome,-3); assert.strictEqual(row.spreadAwayOdds,-115); }
{ // Filter 2: sub-.500 form backed against better form = pass
  const {candidates}=projectGameV1(events[0],'NFL',eff,{byGame:{'Away @ Home':{last5:{home:[{margin:3},{margin:3},{margin:3},{margin:3},{margin:3}],away:[{margin:-3},{margin:-3},{margin:-3},{margin:-3},{margin:-3}]},injuries:{home:[],away:[]},keyStarter:{homeConfirmed:true,awayConfirmed:true,unknownReplacement:false},form:{awayLast10WinPct:0.3,homeLast10WinPct:0.8,awayLastGameMargin:-3,homeLastGameMargin:3}}}});
  const sel=selectV1(candidates,[]);
  assert.ok(sel.funnel.filter2Form>=1, 'filter2 should reject away-form candidates'); assert.ok(!sel.picks.some(x=>String(x.pick).startsWith('Away'))); }
console.log('test-v1-lock appendix: PASS');
