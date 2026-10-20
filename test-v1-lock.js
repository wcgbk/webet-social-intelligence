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
assert.strictEqual(unitsForGradeV1('A+'),1.5); assert.strictEqual(unitsForGradeV1('A'),1.0);
assert.strictEqual(unitsForGradeV1('A-'),1.0); assert.strictEqual(unitsForGradeV1('B+'),1.0); assert.strictEqual(unitsForGradeV1('B'),0.5);
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
  assert.strictEqual(sel.diagnostics.fallback.length, 1, 'only the negative-EV game is a fill');
  assert.strictEqual(sel.diagnostics.fallback[0].rating, 'no-edge');
  assert.ok(sel.diagnostics.fallback.every(f => f.fill === true));
  assert.ok(sel.diagnostics.dataFlags.length >= 3);
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-missing-last5'));
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-missing-injury-reports'));
  assert.ok(!sel.rejections.some(r => r.reason === 'lock-key-starter-unknown'));
  assert.ok(sel.rejections.some(r => r.reason === 'lock-road-favorite-75'));
  assert.ok(!sel.picks.some(p => p.matchup === 'G @ H'));
  assert.strictEqual(sel.picks.find(p => p.matchup === 'A @ B').grade, 'A');
  assert.strictEqual(sel.picks.find(p => p.matchup === 'A @ B').units, '1u');
  assert.strictEqual(sel.picks.find(p => p.matchup === 'C @ D').grade, 'B');
  assert.strictEqual(sel.picks.find(p => p.matchup === 'C @ D').units, '0.5u');
  assert.strictEqual(sel.picks.find(p => p.matchup === 'E @ F').rating, 'no-edge');
  assert.strictEqual(sel.picks.find(p => p.matchup === 'E @ F').units, '0.5u');
}
console.log('test-v1-lock 1019 fallback: PASS');
// --- 1019 v1: A+ cap, heavy-favorite guard, Pinnacle shrink, parlay EV ---
{
  const { capGradeForPriceV1, isHeavyFavoritePriceV1, MAX_STRAIGHT_UNITS_V1 } = L('config-v1');
  const { shrinkFormulaProbV1, pinnacleFairAtLine, FORMULA_WEIGHT_FOOTBALL_V1, PINNACLE_DEV_CAP_V1 } = L('project-v1');
  const { decFromAmerican } = L('select-v1');
  assert.strictEqual(MAX_STRAIGHT_UNITS_V1, 1.5);
  assert.strictEqual(FORMULA_WEIGHT_FOOTBALL_V1, 0.35);
  assert.strictEqual(PINNACLE_DEV_CAP_V1, 0.08);
  for (const g of ['A+','A','A-','B+','B']) assert.ok(unitsForGradeV1(g) <= 1.5, g);
  assert.strictEqual(unitsForGradeV1('A+'), 1.5);
  // -250 is the boundary: shorter means more negative than -250.
  assert.strictEqual(isHeavyFavoritePriceV1(-250), false);
  assert.strictEqual(isHeavyFavoritePriceV1(-251), true);
  assert.strictEqual(isHeavyFavoritePriceV1(-425), true);
  assert.strictEqual(isHeavyFavoritePriceV1(-110), false);
  assert.strictEqual(capGradeForPriceV1('A+', -425), 'A-');
  assert.strictEqual(capGradeForPriceV1('A', -300), 'A-');
  assert.strictEqual(capGradeForPriceV1('A-', -400), 'A-');
  assert.strictEqual(capGradeForPriceV1('B+', -400), 'B+');
  assert.strictEqual(capGradeForPriceV1('A+', -250), 'A+');
  assert.strictEqual(capGradeForPriceV1('A+', -110), 'A+');
  // Blend then cap. 0.35*0.977 + 0.65*0.50 = 0.66695, which is outside ±0.08.
  const capped = shrinkFormulaProbV1(0.97725, 0.5, 'NFL');
  assert.strictEqual(capped.shrunk, true);
  assert.ok(Math.abs(capped.p - 0.58) < 1e-12, capped.p);
  assert.ok(Math.abs(capped.p - 0.5) <= 0.08);
  const mild = shrinkFormulaProbV1(0.55, 0.52, 'NCAAF');
  const mildBlend = 0.35 * 0.55 + 0.65 * 0.52;
  assert.ok(Math.abs(mild.p - mildBlend) < 1e-12);
  assert.ok(Math.abs(mild.p - 0.52) <= 0.08);
  const raw = shrinkFormulaProbV1(0.91, null, 'NFL');
  assert.strictEqual(raw.shrunk, false);
  assert.strictEqual(raw.p, 0.91);
  assert.strictEqual(shrinkFormulaProbV1(0.8, 0.55, 'NHL').shrunk, false);

  const full = {
    last5: { home: [1,2,3,4,5], away: [1,2,3,4,5] },
    injuries: { home: [], away: [] },
    keyStarter: { homeConfirmed: true, awayConfirmed: true, unknownReplacement: false },
    formulaSpreadHome: 8, formulaTotal: 45, formulaInputs: { method: 'test' },
    confirmedBook: 'Hard Rock Bet', book: 'hardrockbet', commenceTime: '2026-10-18T17:00:00Z',
  };
  const row = (matchup, side, p, odds, extra = {}) => {
    const [awayTeam, homeTeam] = matchup.split(' @ ');
    return {
      sport: 'NFL', matchup, awayTeam, homeTeam, side, trueProbability: p, odds, oddsStr: String(odds),
      market: 'Moneyline', line: null, ...full, ...extra,
    };
  };
  // A+ at a normal price is 1.5u, not 2u.
  {
    const sel = selectV1([row('Away @ Home', 'Home', 0.86, -150)], []);
    assert.strictEqual(sel.picks.length, 1);
    assert.strictEqual(sel.picks[0].grade, 'A+');
    assert.strictEqual(sel.picks[0].units, '1.5u');
    assert.strictEqual(sel.picks[0].lockReceipt.unitSize, '1.5u');
  }
  // -425 cannot be graded above A-, even at 90%.
  {
    const sel = selectV1([row('Washington Commanders @ San Francisco 49ers', 'San Francisco 49ers', 0.90, -425)], []);
    assert.strictEqual(sel.picks.length, 1);
    assert.strictEqual(sel.picks[0].grade, 'A-');
    assert.strictEqual(sel.picks[0].units, '1u');
    assert.notStrictEqual(sel.picks[0].grade, 'A+');
  }
  // -250 itself may still be A+. A price one cent shorter may not.
  {
    const at = selectV1([row('A @ B', 'B', 0.85, -250)], []);
    assert.strictEqual(at.picks[0].grade, 'A+');
    assert.strictEqual(at.picks[0].units, '1.5u');
    const under = selectV1([row('A @ B', 'B', 0.85, -251)], []);
    assert.strictEqual(under.picks[0].grade, 'A-');
    assert.strictEqual(under.picks[0].units, '1u');
  }
  // Heavy chalk loses the first straight slot to the next qualifying price.
  {
    const sel = selectV1([
      row('Washington Commanders @ San Francisco 49ers', 'San Francisco 49ers', 0.90, -425),
      row('Carolina Panthers @ Philadelphia Eagles', 'Philadelphia Eagles', 0.72, -110),
      row('Buffalo Bills @ Las Vegas Raiders', 'Buffalo Bills', 0.88, -300),
      row('Dallas Cowboys @ Green Bay Packers', 'Green Bay Packers', 0.71, 100),
    ], []);
    assert.strictEqual(sel.picks.length, 3);
    assert.deepStrictEqual(sel.picks.map(p => p.odds), ['-110', '100', '-425']);
    assert.ok(sel.picks.every(p => !(Number(p.odds) < -250) || p.grade === 'A-' || p.grade === 'B+' || p.grade === 'B'));
    assert.ok(!sel.picks.some(p => Number(p.odds) < -250 && (p.grade === 'A+' || p.grade === 'A')));
    const heavy = sel.picks.find(p => p.odds === '-425');
    assert.strictEqual(heavy.grade, 'A-');
    assert.strictEqual(heavy.units, '1u');
  }

  // Wild formula vs a pick'em Pinnacle line stays inside the 0.08 band.
  const mkts = (home, away, priceHome, priceAway, point) => ([
    { key: 'h2h', outcomes: [{ name: away, price: priceAway }, { name: home, price: priceHome }] },
    { key: 'spreads', outcomes: [{ name: away, price: -110, point }, { name: home, price: -110, point: -point }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 45 }, { name: 'Under', price: -110, point: 45 }] },
  ]);
  const nflGame = (home, away) => ({
    sport: 'NFL', home_team: home, away_team: away, commence_time: '2026-10-18T17:00:00Z',
    bookmakers: [
      { key: 'pinnacle', markets: mkts(home, away, -110, -110, 3) },
      { key: 'hardrockbet', markets: mkts(home, away, -110, -110, 3) },
    ],
  });
  const pairs = [['Home One', 'Away One'], ['Home Two', 'Away Two'], ['Home Three', 'Away Three']];
  const eff = {};
  for (const [h, a] of pairs) {
    eff[h] = { offEpa: 0.35, defEpa: 0.25 };
    eff[a] = { offEpa: -0.30, defEpa: -0.25 };
  }
  const projected = [];
  for (const [h, a] of pairs) {
    const { candidates, pass } = projectGameV1(nflGame(h, a), 'NFL', eff, {});
    assert.strictEqual(pass, null);
    assert.ok(candidates.length >= 4);
    for (const c of candidates) {
      if (!Number.isFinite(c.pPinnacle)) continue;
      assert.ok(Math.abs(c.trueProbability - c.pPinnacle) <= 0.08 + 1e-9, `${c.side} ${c.trueProbability} vs ${c.pPinnacle}`);
      assert.strictEqual(c.shrinkWeight, 0.35);
      if (c.market !== 'Total') assert.ok(c.pFormula > 0.8 || c.pFormula < 0.2, `expected a wild formula, got ${c.pFormula} on ${c.market} ${c.side}`);
    }
    const homeMl = candidates.find(c => c.market === 'Moneyline' && c.side === h);
    assert.ok(homeMl.pFormula > 0.9, homeMl.pFormula);
    assert.ok(homeMl.trueProbability <= homeMl.pPinnacle + 0.08 + 1e-9);
    assert.ok(homeMl.trueProbability < 0.7, homeMl.trueProbability);
    projected.push(...candidates);
  }
  const card = selectV1(projected, []);
  assert.strictEqual(card.picks.length, 3);
  assert.strictEqual(card.parlayLegs.length, 1);
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.strictEqual(card.parlayLegs[0].units, '0.5u');
  assert.ok(card.picks.every(p => parseFloat(p.units) <= 1.5));
  // Edge vs the de-vigged fair (capped at 8pp) grades A+ at 1.5u. The win-probability floor no longer forces a 0.5u fill.
  assert.ok(card.picks.every(p => p.grade === 'A+' && p.units === '1.5u'), card.picks.map(p => `${p.pick} ${p.units} ${p.grade}`).join(' | '));
  const evNum = parseFloat(card.parlayLegs[0].ev);
  assert.ok(evNum < 60, `parlay EV ${card.parlayLegs[0].ev} should be under +60% for three near-even legs`);
  let dec = 1, jp = 1;
  for (const leg of card.parlayLegs[0].legs) {
    dec *= decFromAmerican(Number(leg.odds));
    jp *= leg.trueProbability;
    assert.ok(Math.abs(Number(leg.odds)) <= 110, leg.odds);
  }
  assert.ok(Math.abs((jp * dec - 1) * 100 - evNum) < 0.06, `${(jp * dec - 1) * 100} vs ${evNum}`);

  // Half-point off Pinnacle is still anchored. Laying -3.5 against a -3 pick'em
  // fair must not keep a 90% formula.
  const offBundles = [
    { side: 'Home', point: -3.5, prices: [{ book: 'hardrockbet', american: -110 }] },
    { side: 'Away', point: 3.5, prices: [{ book: 'hardrockbet', american: -110 }] },
    { side: 'Home', point: -3, prices: [{ book: 'pinnacle', american: -110 }] },
    { side: 'Away', point: 3, prices: [{ book: 'pinnacle', american: -110 }] },
  ];
  const shifted = pinnacleFairAtLine(offBundles, offBundles[0], 'NFL');
  assert.ok(shifted < 0.5 && shifted > 0.45, shifted);
  const offGame = {
    sport: 'NFL', home_team: 'Home', away_team: 'Away', commence_time: '2026-10-18T17:00:00Z',
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'spreads', outcomes: [
        { name: 'Away', price: -110, point: 3 }, { name: 'Home', price: -110, point: -3 },
      ] }] },
      { key: 'hardrockbet', markets: [{ key: 'spreads', outcomes: [
        { name: 'Away', price: -110, point: 3.5 }, { name: 'Home', price: -110, point: -3.5 },
      ] }] },
    ],
  };
  const off = projectGameV1(offGame, 'NFL', { Home: { offEpa: 0.35, defEpa: 0.25 }, Away: { offEpa: -0.30, defEpa: -0.25 } }, {});
  const homeLay = off.candidates.find(c => c.market === 'Spread' && c.side.startsWith('Home'));
  assert.ok(homeLay, 'home spread candidate');
  assert.ok(homeLay.pFormula > 0.8, homeLay.pFormula);
  assert.ok(Math.abs(homeLay.trueProbability - homeLay.pPinnacle) <= 0.08 + 1e-9);
  assert.ok(homeLay.trueProbability < 0.65, homeLay.trueProbability);
  assert.notStrictEqual(gradeForV1('NFL', homeLay.trueProbability), 'A+');
}
console.log('test-v1-lock 1019 caps and shrink: PASS');
// --- 1019 v1: negative-EV and fallback fills are lean / B at 0.5u, never A ---
{
  const { summaryTotalsV1 } = L('select-v1');
  const A_FAMILY = new Set(['A+', 'A', 'A-', 'a+', 'a', 'a-']);
  const assertNoEdgeFill = (p) => {
    assert.ok(p, 'missing fill pick');
    assert.strictEqual(p.fallback, true);
    assert.strictEqual(p.rating, 'no-edge');
    assert.strictEqual(p.flag, 'no-edge-lean');
    assert.ok(p.filterFlags.includes('no-edge-lean'));
    assert.strictEqual(p.grade, 'B');
    assert.strictEqual(p.lockGrade, 'B');
    assert.strictEqual(p.units, '0.5u');
    assert.strictEqual(p.lockReceipt.rating, 'no-edge');
    assert.strictEqual(p.lockReceipt.unitSize, '0.5u');
    assert.ok(/no-edge/i.test(p.coreReasoning));
    assert.ok(!A_FAMILY.has(p.grade) && !A_FAMILY.has(p.rating) && !A_FAMILY.has(p.lockGrade) && !A_FAMILY.has(p.lockReceipt.rating));
    assert.ok(parseFloat(p.ev) <= 0, p.ev);
  };
  // NHL win-prob band would call 0.664 an A. The price edge is about -0.2pp
  // and EV is about -0.3%, so the row is a no-edge fill, not that A.
  const pCanes = 0.664439;
  assert.strictEqual(gradeForV1('NHL', pCanes), 'A');
  assert.ok(evFor(pCanes, -200) < 0);
  assert.ok(Math.abs(evFor(pCanes, -200) * 100 + 0.3) < 0.05);
  const canes = {
    sport: 'NHL', matchup: 'Carolina Hurricanes @ Calgary Flames',
    awayTeam: 'Carolina Hurricanes', homeTeam: 'Calgary Flames',
    side: 'Carolina Hurricanes', edge: -0.002227, trueProbability: pCanes,
    odds: -200, oddsStr: '-200', market: 'Moneyline', line: null, fallback: true,
    projector: 'pinnacle-fair', confirmedBook: 'Hard Rock Bet', book: 'hardrockbet',
    commenceTime: '2026-10-18T23:00:00Z', last5: null, injuries: null, keyStarter: null,
    formulaSpreadHome: null, formulaTotal: null, formulaInputs: { method: 'pinnacle-fair-devig' },
  };
  const strict = (matchup, side, p, odds) => {
    const [awayTeam, homeTeam] = matchup.split(' @ ');
    return {
      sport: 'NFL', matchup, awayTeam, homeTeam, side, trueProbability: p, odds, oddsStr: String(odds),
      market: 'Moneyline', line: null, fallback: false, confirmedBook: 'Hard Rock Bet', book: 'hardrockbet',
      commenceTime: '2026-10-18T17:00:00Z',
      last5: { home: [1, 2, 3, 4, 5], away: [1, 2, 3, 4, 5] },
      injuries: { home: [], away: [] },
      keyStarter: { homeConfirmed: true, awayConfirmed: true, unknownReplacement: false },
      formulaSpreadHome: 3, formulaTotal: 44, formulaInputs: { method: 'test' },
    };
  };
  const sel = selectV1([
    strict('Buffalo Bills @ Las Vegas Raiders', 'Buffalo Bills', 0.72, -250),
    strict('Baltimore Ravens @ Cleveland Browns', 'Baltimore Ravens', 0.68, -175),
    canes,
  ], []);
  assert.strictEqual(sel.picks.length, 3);
  assert.strictEqual(sel.parlayLegs.length, 1);
  assert.strictEqual(sel.parlayLegs[0].legs.length, 3);
  assert.strictEqual(sel.funnel.fallbackFill, 2);
  const fill = sel.picks.find(p => p.pick === 'Carolina Hurricanes');
  assertNoEdgeFill(fill);
  const ravens = sel.picks.find(p => p.pick === 'Baltimore Ravens');
  assert.strictEqual(ravens.grade, 'A');
  assert.strictEqual(ravens.units, '1u');
  assert.ok(parseFloat(ravens.ev) > 0);
  const bills = sel.picks.find(p => p.pick === 'Buffalo Bills');
  assert.strictEqual(bills.rating, 'lean');
  assert.strictEqual(bills.units, '0.5u');
  assert.ok(parseFloat(bills.ev) > 0);
  const leg = sel.parlayLegs[0].legs.find(p => p.pick === 'Carolina Hurricanes');
  assertNoEdgeFill(leg);
  assert.strictEqual(sel.diagnostics.fallback.length, 2);
  assert.ok(sel.diagnostics.fallback.some(f => f.rating === 'no-edge' && /Hurricanes/.test(f.side || '')));
  const totals = summaryTotalsV1(sel.picks, sel.parlayLegs);
  assert.strictEqual(totals.gradeUnits.A, '1u');
  assert.strictEqual(totals.gradeUnits['A+'], '0u');
  assert.strictEqual(totals.gradeUnits.B, '1u');
  assert.strictEqual(totals.leanUnits, '0.5u');
  assert.strictEqual(totals.straightUnits, '2u');
  assert.strictEqual(totals.totalUnits, '2.5u');
  const aFamilyUnits = ['A+', 'A', 'A-'].reduce((s, g) => s + parseFloat(totals.gradeUnits[g]), 0);
  const nonLeanUnits = sel.picks.filter(p => p.rating !== 'lean').reduce((s, p) => s + parseFloat(p.units), 0);
  assert.ok(aFamilyUnits <= nonLeanUnits + 1e-9);
  assert.ok(Math.abs(aFamilyUnits + parseFloat(totals.gradeUnits['B+']) + parseFloat(totals.gradeUnits.B) - parseFloat(totals.straightUnits)) < 1e-9);

  // A straight with EV<=0 is not graded above B. An 80% price at -425 is a
  // negative price-edge, so the card labels it no-edge rather than A+.
  assert.strictEqual(gradeForV1('NFL', 0.80), 'A+');
  assert.ok(evFor(0.80, -425) <= 0);
  const chalk = selectV1([strict('Washington Commanders @ San Francisco 49ers', 'San Francisco 49ers', 0.80, -425)], []);
  assert.strictEqual(chalk.picks.length, 1);
  assertNoEdgeFill(chalk.picks[0]);
  assert.notStrictEqual(chalk.picks[0].grade, 'A-');
  assert.notStrictEqual(chalk.picks[0].grade, 'A+');
  const chalkTotals = summaryTotalsV1(chalk.picks, chalk.parlayLegs);
  assert.strictEqual(chalkTotals.gradeUnits['A-'], '0u');
  assert.strictEqual(chalkTotals.gradeUnits['A+'], '0u');
  assert.strictEqual(chalkTotals.gradeUnits.A, '0u');
  assert.strictEqual(chalkTotals.gradeUnits.B, '0.5u');
  assert.strictEqual(chalkTotals.leanUnits, '0u');

  // A fallback that clears the strict pass with EV>0 keeps its grade and stake.
  const plus = {
    sport: 'NHL', matchup: 'Away Ice @ Home Ice', awayTeam: 'Away Ice', homeTeam: 'Home Ice',
    side: 'Home Ice', trueProbability: 0.70, odds: 110, oddsStr: '+110', edge: 0.20,
    market: 'Moneyline', line: null, fallback: true, confirmedBook: 'DraftKings', book: 'draftkings',
    commenceTime: '2026-10-18T23:00:00Z', last5: null, injuries: null, keyStarter: null,
    formulaInputs: { method: 'pinnacle-fair-devig' },
  };
  assert.ok(evFor(0.70, 110) > 0);
  const kept = selectV1([plus], []);
  assert.strictEqual(kept.picks.length, 1);
  assert.strictEqual(kept.funnel.fallbackFill, 0);
  assert.strictEqual(kept.picks[0].grade, 'A+');
  assert.strictEqual(kept.picks[0].rating, 'a+');
  assert.strictEqual(kept.picks[0].lockGrade, 'A+');
  assert.strictEqual(kept.picks[0].lockReceipt.rating, 'A+');
  assert.strictEqual(kept.picks[0].units, '1.5u');
  assert.strictEqual(summaryTotalsV1(kept.picks, kept.parlayLegs).gradeUnits['A+'], '1.5u');
}
console.log('test-v1-lock 1019 lean fill: PASS');
