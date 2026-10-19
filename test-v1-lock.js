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
// Missing last-5 / injuries / key starter are diagnostic flags when the strict
// pass is short of 3. They do not empty the one priced game on the board.
const fullMeta={byGame:{'Away @ Home':{last5:{home:[1,2,3,4,5],away:[1,2,3,4,5]},injuries:{home:[],away:[]},keyStarter:{homeConfirmed:true,awayConfirmed:true,unknownReplacement:false}}}};
{ const {candidates}=projectGameV1(events[0],'NFL',eff,{}); const sel=selectV1(candidates,[]);
  assert.ok(sel.funnel.missingLast5>=1);
  assert.ok(!sel.rejections.some(r=>r.reason==='lock-missing-last5'));
  assert.strictEqual(sel.picks.length,1);
  assert.ok(sel.diagnostics.dataFlags.length>=1); }
{ const {candidates}=projectGameV1(events[0],'NFL',eff,fullMeta);
  // with full data, any pick must carry 12-field receipt and Hard Rock line
  const sel=selectV1(candidates,[]);
  for(const p of sel.picks){ const r=p.lockReceipt; for(const k of ['game','pick','rating','confirmedLine','trueWinProbability','last5TeamA','last5TeamB','h2h','keyInjuryFlags','coreReasoning','unitSize','whatLoses']) assert.ok(k in r, `receipt missing ${k}`); assert.strictEqual(p.book,'hardrockbet'); }
  // B-grade picks never appear as straights
  assert.ok(sel.picks.every(p=>p.grade!=='B')); }
// Non-football with no Pinnacle pair: no borrowed projector, no candidate
{ const ev2={...events[0],sport:'NHL'}; const {candidates,pass}=projectGameV1(ev2,'NHL',{},{}); assert.strictEqual(candidates.length,0); assert.strictEqual(pass.reason,'v1-no-pinnacle-fair'); }
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
// --- Oct 18 QA additions: depth-chart QB1, -7 boundary, 0600/0300 open read ---
{ const { qbConfirmFromDepth }=L('feeds-v1');
  const depth=(qbs)=>({depthchart:[{positions:{qb:{athletes:qbs}}}]});
  // QB1 healthy, QB3 Out (Patriots case) -> confirmed (pre-fix: false pass)
  assert.strictEqual(qbConfirmFromDepth(depth([{displayName:'Starter A',injuries:[]},{displayName:'Backup B',injuries:[]},{displayName:'Third C',injuries:[{status:'Out'}]}],[])).confirmed,true);
  // QB1 Out -> not confirmed, replacement named but unproven
  const out=qbConfirmFromDepth(depth([{displayName:'Starter A',injuries:[{status:'Out'}]},{displayName:'Backup B',injuries:[]}]),[]);
  assert.strictEqual(out.confirmed,false); assert.strictEqual(out.unknownReplacement,true); assert.strictEqual(out.replacement,'Backup B');
  // QB1 Questionable -> not confirmed
  assert.strictEqual(qbConfirmFromDepth(depth([{displayName:'Starter A',injuries:[{status:'Questionable'}]}]),[]).confirmed,false);
  // No depth chart -> null (fallback)
  assert.strictEqual(qbConfirmFromDepth({},[]),null); assert.strictEqual(qbConfirmFromDepth(null,[]),null); }
{ // Road favourite at exactly -7 is NOT "more than -7": must not hit the 75% rule
  const {candidates}=projectGameV1(events[0],'NFL',eff,{});
  const c={...candidates.find(x=>x.market==='Spread'), side:'Away -7', line:-7, trueProbability:0.65,
    last5:{home:[1,2,3,4,5],away:[1,2,3,4,5]}, injuries:{home:[],away:[]}, keyStarter:{homeConfirmed:true,awayConfirmed:true,unknownReplacement:false}, form:null, odds:-110, confirmedBook:'Hard Rock Bet'};
  const sel=selectV1([c],[]); assert.ok(!sel.rejections.some(r=>r.reason==='lock-road-favorite-75'), '-7 exactly must not trigger road-favorite-75');
  const c2={...c, side:'Away -7.5', line:-7.5}; const sel2=selectV1([c2],[]);
  assert.ok(sel2.rejections.some(r=>r.reason==='lock-road-favorite-75'), '-7.5 must trigger road-favorite-75'); }
{ // Earliest poll (0600) attaches as openBooks for Filter 4
  const open={'Away @ Home':{books:{hardrockbet:{spreadHome:-2.5,spreadHomeOdds:-110,spreadAway:2.5,spreadAwayOdds:-110,total:44,overOdds:-110,underOdds:-110,mlHome:-140,mlAway:120}}}};
  const evs=reconstructEventsV1(games, open); assert.strictEqual(evs[0].openBooks.hardrockbet.spreadHome,-2.5); }
console.log('test-v1-lock QA additions: PASS');
// --- 1019: Pinnacle-fair fallback + never-empty card ---
{
  const { sharpFairForSide, collectMarketOutcomes } = require(path.join(__dirname, 'netlify/functions/lib/omega-vnext/edge'));
  const { americanToImplied } = require(path.join(__dirname, 'netlify/functions/lib/omega-vnext/odds_math'));
  const nhl = {
    sport: 'NHL', home_team: 'Home Ice', away_team: 'Away Ice', commence_time: '2026-10-18T23:00:00Z',
    bookmakers: [
      { key: 'pinnacle', markets: [
        { key: 'h2h', outcomes: [{ name: 'Away Ice', price: 140 }, { name: 'Home Ice', price: -160 }] },
        { key: 'spreads', outcomes: [{ name: 'Away Ice', price: -110, point: 1.5 }, { name: 'Home Ice', price: -110, point: -1.5 }] },
      ] },
      { key: 'draftkings', markets: [
        { key: 'h2h', outcomes: [{ name: 'Away Ice', price: 150 }, { name: 'Home Ice', price: -170 }] },
        { key: 'spreads', outcomes: [{ name: 'Away Ice', price: -120, point: 1.5 }, { name: 'Home Ice', price: -120, point: -1.5 }] },
      ] },
      { key: 'hardrockbet', markets: [
        { key: 'h2h', outcomes: [{ name: 'Away Ice', price: 130 }, { name: 'Home Ice', price: -155 }] },
      ] },
      { key: 'hardrockbet_oh', markets: [
        { key: 'spreads', outcomes: [{ name: 'Away Ice', price: -105, point: 1.5 }, { name: 'Home Ice', price: -115, point: -1.5 }] },
      ] },
    ],
  };
  const { candidates, pass } = projectGameV1(nhl, 'NHL', {}, {});
  assert.strictEqual(pass, null);
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.every(c => c.fallback === true && c.projector === 'pinnacle-fair'));
  const awayMl = candidates.find(c => c.market === 'Moneyline' && c.side === 'Away Ice');
  const homeMl = candidates.find(c => c.market === 'Moneyline' && c.side === 'Home Ice');
  assert.ok(awayMl && homeMl);
  assert.strictEqual(awayMl.book, 'draftkings');
  assert.strictEqual(awayMl.odds, 150);
  assert.strictEqual(homeMl.book, 'hardrockbet');
  assert.strictEqual(homeMl.odds, -155);
  const bundles = collectMarketOutcomes(nhl, 'h2h');
  const fair = sharpFairForSide(bundles, 'Away Ice', null);
  const implied = americanToImplied(150);
  assert.ok(Math.abs(awayMl.edge - (fair - implied)) < 1e-5);
  assert.ok(Math.abs(awayMl.fairProb - fair) < 1e-5);
  const awaySpread = candidates.find(c => c.market === 'Spread' && c.side.startsWith('Away Ice'));
  assert.ok(awaySpread);
  assert.strictEqual(awaySpread.book, 'hardrockbet', 'hardrockbet_oh is Hard Rock and beats DraftKings -120');
  assert.strictEqual(awaySpread.odds, -105);
  assert.ok(!String(pass && pass.reason).includes('v1-no-projector-for-sport'));
}
{
  // Strict grades miss (below the floor). Fill still publishes 3 straights + a 3-leg
  // from the best fallback edge per game. Missing last-5 is a flag, not a rejection.
  const fb = (matchup, side, edge, trueProbability, odds, extra = {}) => {
    const [awayTeam, homeTeam] = matchup.split(' @ ');
    return {
      sport: 'NHL', matchup, awayTeam, homeTeam, side, edge, trueProbability, odds,
      oddsStr: String(odds), market: 'Moneyline', line: null, fallback: true,
      projector: 'pinnacle-fair', confirmedBook: 'DraftKings', book: 'draftkings',
      commenceTime: '2026-10-18T23:00:00Z', last5: null, injuries: null, keyStarter: null,
      formulaSpreadHome: null, formulaTotal: null, formulaInputs: { method: 'pinnacle-fair-devig' },
      ...extra,
    };
  };
  const rows = [
    fb('A @ B', 'B', 0.04, 0.55, -110),
    fb('A @ B', 'A', -0.01, 0.45, 110),
    fb('C @ D', 'D', 0.01, 0.52, -105),
    fb('E @ F', 'F', -0.02, 0.49, -115),
    fb('G @ H', 'G -7.5', 0.08, 0.60, -110, { market: 'Spread', line: -7.5 }),
  ];
  const sel = selectV1(rows, []);
  assert.strictEqual(sel.picks.length, 3);
  assert.deepStrictEqual(sel.picks.map(p => p.matchup), ['A @ B', 'C @ D', 'E @ F']);
  assert.strictEqual(sel.picks[0].pick, 'B');
  assert.ok(sel.picks.every(p => p.fallback === true));
  assert.strictEqual(sel.parlayLegs.length, 1);
  assert.strictEqual(sel.parlayLegs[0].type, '3-leg-parlay-v1-lock');
  assert.strictEqual(sel.parlayLegs[0].units, '0.5u');
  assert.strictEqual(sel.parlayLegs[0].legs.length, 3);
  assert.strictEqual(sel.diagnostics.fallback.length, 3);
  assert.ok(sel.diagnostics.fallback.every(f => f.fill === true));
  assert.ok(sel.diagnostics.dataFlags.length >= 3);
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-missing-last5'));
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-missing-injury-reports'));
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-key-starter-unknown'));
  assert.ok(sel.rejections.some(r => r.reason === 'lock-road-favorite-75'));
  assert.ok(!sel.picks.some(p => p.matchup === 'G @ H'));
}
console.log('test-v1-lock 1019 fallback: PASS');
