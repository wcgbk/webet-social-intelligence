'use strict';
/**
 * Observe-only per-sport recalibration report.
 * Synthetic rows only. No network. No blob writes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const config = require('./netlify/functions/lib/omega-vnext/config');

function snapConfig() {
  return JSON.stringify({
    MODEL_VERSION: config.MODEL_VERSION,
    SHRINK_K: config.SHRINK_K,
    MLB_CALIBRATION: config.MLB_CALIBRATION,
    GATES: config.GATES,
    KELLY_FRACTION: config.KELLY_FRACTION,
    DAILY_UNIT_CAP: config.DAILY_UNIT_CAP,
    MAX_STRAIGHTS: config.MAX_STRAIGHTS,
    UNIT_DOLLARS: config.UNIT_DOLLARS,
    LINE_MOVE: config.LINE_MOVE,
    SELECT_WEIGHTS: config.SELECT_WEIGHTS,
  });
}

const configBefore = snapConfig();
const recal = require('./netlify/functions/lib/omega-vnext/recal_report');
const job = require('./netlify/functions/recal-report-omega');
const et = require('./netlify/functions/lib/et-schedule');
const configAfter = snapConfig();

assert.strictEqual(configAfter, configBefore, 'importing the report changes config');
assert.strictEqual(job.handler.length <= 2, true, 'handler arity');

const libSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/recal_report.js'), 'utf8');
const jobSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/recal-report-omega.js'), 'utf8');
assert.ok(!/require\('\.\/config'\)/.test(libSrc), 'report lib must not load config');
assert.ok(!/MODEL_VERSION\s*=/.test(libSrc));
assert.ok(!/SHRINK_K\s*=/.test(libSrc));
assert.ok(!/storeJson/.test(libSrc));
assert.ok(!/calibrateAll/.test(jobSrc));
assert.ok(!/generateOmega|selectStraights/.test(jobSrc));

function near(actual, expected, eps, label) {
  assert.ok(Number.isFinite(actual), `${label || 'value'} is not finite: ${actual}`);
  const gap = Math.abs(actual - expected);
  assert.ok(gap <= (eps == null ? 1e-9 : eps), `${label || 'value'} ${actual} vs ${expected} (gap ${gap})`);
}

function refLogLoss(p, y) {
  return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
}

function refBrier(p, y) {
  return (p - y) * (p - y);
}

function refKl(p, q) {
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q));
}

function bet(over) {
  const y = over.y == null ? 1 : over.y;
  return {
    date: over.date,
    sport: over.sport,
    market: over.market || 'Spread',
    matchup: over.matchup || 'Away @ Home',
    side: over.side || 'Home',
    line: Object.prototype.hasOwnProperty.call(over, 'line') ? over.line : -3.5,
    odds: over.odds == null ? -110 : over.odds,
    entryImplied: over.entryImplied,
    p_model: over.p_model,
    coverProb: Object.prototype.hasOwnProperty.call(over, 'coverProb') ? over.coverProb : over.p_model,
    fair_sharp_p: over.fair_sharp_p,
    closeNoVig: over.closeNoVig,
    result: over.result != null ? over.result : (y === 1 ? 'win' : 'loss'),
    y: over.forceY === false ? undefined : y,
  };
}

function repeats(n, make) {
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(make(i));
  return rows;
}

const AS_OF = '2026-10-11';

function reportOf(rows) {
  return recal.buildRecalReport({ asOf: AS_OF, generatedAt: '2026-10-11T13:15:00.000Z', rows });
}

function cell(report, sport, days, market) {
  const block = report.sports[sport].windows[days];
  return market ? block.markets[market] : block;
}

// CLV sign: close no-vig minus vigged implied entry.
{
  const implied = recal.americanToImplied(-110);
  near(implied, 110 / 210, 1e-12, 'implied -110');
  assert.ok(recal.clvProb(0.60, implied) > 0, 'close above the entry price is +CLV');
  assert.ok(recal.clvProb(0.40, implied) < 0, 'close below the entry price is -CLV');
  const rows = [
    bet({ date: AS_OF, sport: 'NFL', p_model: 0.56, fair_sharp_p: 0.52, closeNoVig: 0.60, y: 1 }),
    bet({ date: AS_OF, sport: 'NFL', p_model: 0.56, fair_sharp_p: 0.52, closeNoVig: 0.40, y: 0 }),
    bet({ date: AS_OF, sport: 'NFL', p_model: 0.56, fair_sharp_p: 0.52, closeNoVig: implied, y: 1 }),
  ];
  const block = cell(reportOf(rows), 'NFL', 7);
  assert.strictEqual(block.n, 3);
  near(block.meanClv, ((0.60 - implied) + (0.40 - implied) + 0) / 3, 1e-12, 'mean CLV');
  near(block.pctBeatingClose, (100 * 1) / 3, 1e-12, 'pct beating');
  assert.ok(rows[0] && recal.clvProb(0.60, implied) > 0);
}

// Log-loss, Brier, KL, edge vs realized CLV.
{
  const pModel = 0.8;
  const pClose = 0.5;
  const pSharp = 0.62;
  const entry = 0.47;
  const rows = [
    bet({
      date: AS_OF, sport: 'NHL', market: 'Moneyline', p_model: pModel, fair_sharp_p: pSharp,
      closeNoVig: pClose, entryImplied: entry, y: 1,
    }),
    bet({
      date: AS_OF, sport: 'NHL', market: 'Moneyline', p_model: pModel, fair_sharp_p: pSharp,
      closeNoVig: pClose, entryImplied: entry, y: 0,
    }),
  ];
  const block = cell(reportOf(rows), 'NHL', 14);
  const llModel = (refLogLoss(pModel, 1) + refLogLoss(pModel, 0)) / 2;
  const llClose = (refLogLoss(pClose, 1) + refLogLoss(pClose, 0)) / 2;
  const brModel = (refBrier(pModel, 1) + refBrier(pModel, 0)) / 2;
  const brClose = (refBrier(pClose, 1) + refBrier(pClose, 0)) / 2;
  const kl = refKl(pModel, pClose);
  near(recal.logLoss(pModel, 1), refLogLoss(pModel, 1), 1e-12, 'logLoss');
  near(recal.brier(pModel, 0), refBrier(pModel, 0), 1e-12, 'brier');
  near(recal.klBernoulli(pModel, pClose), kl, 1e-12, 'kl');
  near(block.logLossModel, llModel, 1e-12, 'mean ll model');
  near(block.logLossClose, llClose, 1e-12, 'mean ll close');
  near(block.brierModel, brModel, 1e-12, 'mean brier model');
  near(block.brierClose, brClose, 1e-12, 'mean brier close');
  near(block.meanKl, kl, 1e-12, 'mean kl');
  near(block.meanEdge, pModel - pSharp, 1e-12, 'mean edge');
  near(block.meanRealizedClv, pClose - entry, 1e-12, 'mean realized clv');
  near(block.drift, (pModel - pSharp) - (pClose - entry), 1e-12, 'drift');
  assert.strictEqual(block.meanClv, block.meanRealizedClv);
}

// 10-bin calibration curve. 0.10 starts the second bin. 0.95 is the last bin.
{
  const rows = [
    bet({ date: AS_OF, sport: 'MLB', market: 'Total', p_model: 0.05, fair_sharp_p: 0.50, closeNoVig: 0.10, entryImplied: 0.40, y: 0 }),
    bet({ date: AS_OF, sport: 'MLB', market: 'Total', p_model: 0.05, fair_sharp_p: 0.50, closeNoVig: 0.20, entryImplied: 0.40, y: 1 }),
    bet({ date: AS_OF, sport: 'MLB', market: 'Total', p_model: 0.10, fair_sharp_p: 0.50, closeNoVig: 0.30, entryImplied: 0.40, y: 0 }),
    bet({ date: AS_OF, sport: 'MLB', market: 'Total', p_model: 0.95, fair_sharp_p: 0.50, closeNoVig: 0.90, entryImplied: 0.40, y: 1 }),
  ];
  const curve = cell(reportOf(rows), 'MLB', 28, 'Total').calibration;
  assert.strictEqual(curve.length, 10);
  assert.strictEqual(curve[0].lo, 0);
  assert.strictEqual(curve[0].hi, 0.1);
  assert.strictEqual(curve[0].n, 2);
  near(curve[0].meanModel, 0.05, 1e-12, 'bin0 model');
  near(curve[0].outcomeRate, 0.5, 1e-12, 'bin0 rate');
  near(curve[0].meanClose, 0.15, 1e-12, 'bin0 close');
  assert.strictEqual(curve[1].n, 1);
  near(curve[1].meanModel, 0.10, 1e-12, 'bin1 model');
  assert.strictEqual(curve[1].outcomeRate, 0);
  assert.strictEqual(curve[9].n, 1);
  near(curve[9].meanModel, 0.95, 1e-12, 'bin9 model');
  assert.strictEqual(curve[9].outcomeRate, 1);
  near(curve[9].meanClose, 0.90, 1e-12, 'bin9 close');
  assert.strictEqual(curve[4].n, 0);
  assert.strictEqual(curve[4].meanModel, null);
  assert.strictEqual(curve[4].outcomeRate, null);
  const direct = recal.calibrationCurve([{ pScore: 1, pClose: 0.5, y: 1 }]);
  assert.strictEqual(direct[9].n, 1, 'p=1 lands in the last bin');
}

// Fitted K recovers a known shrink. p = (1-K)*p_model + K*p_close.
function fitKnown(k, pRaw, pAnchor, n) {
  const rate = (1 - k) * pRaw + k * pAnchor;
  const wins = Math.round(rate * n);
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push({ pRaw, pAnchor, y: i < wins ? 1 : 0 });
  const fit = recal.fitShrinkK(rows);
  assert.strictEqual(fit.k, k, `recovered K ${fit.k} wanted ${k}`);
  assert.strictEqual(fit.n, n);
  assert.strictEqual(fit.applied, false);
  return fit;
}
fitKnown(0.25, 0.2, 0.6, 100);
fitKnown(0.5, 0.2, 0.8, 100);
fitKnown(0, 0.7, 0.3, 100);
fitKnown(1, 0.3, 0.7, 100);

// The report K matches the direct fit, and the largest log-loss gain is the one change.
{
  function blockRows(sport, market, pRaw, pClose, k, n) {
    const rate = (1 - k) * pRaw + k * pClose;
    const wins = Math.round(rate * n);
    return repeats(n, (i) => bet({
      date: AS_OF,
      sport,
      market,
      p_model: pRaw,
      coverProb: pRaw,
      fair_sharp_p: 0.5,
      closeNoVig: pClose,
      entryImplied: 0.45,
      y: i < wins ? 1 : 0,
    }));
  }
  const rows = [
    ...blockRows('NFL', 'Spread', 0.2, 0.8, 0.5, 100),
    ...blockRows('NFL', 'Total', 0.52, 0.48, 0, 100),
    ...blockRows('NCAAF', 'Moneyline', 0.4, 0.6, 0.5, 100),
  ];
  const report = reportOf(rows);
  const spread = cell(report, 'NFL', 28, 'Spread');
  assert.strictEqual(spread.shrinkK.k, 0.5);
  assert.strictEqual(spread.shrinkK.n, 100);
  assert.strictEqual(spread.shrinkK.applied, false);
  assert.strictEqual(cell(report, 'NFL', 28, 'Total').shrinkK.k, 0);
  assert.strictEqual(report.recommendation.change, true);
  assert.strictEqual(report.recommendation.parameter, 'shrinkK');
  assert.strictEqual(report.recommendation.sport, 'NFL');
  assert.strictEqual(report.recommendation.market, 'Spread');
  assert.strictEqual(report.recommendation.k, 0.5);
  assert.strictEqual(report.recommendation.applied, false);
  assert.ok(report.recommendation.gain > recal.MIN_GAIN || report.recommendation.gain > 0.01);
  assert.ok(/Not applied/.test(report.recommendation.text));
  assert.ok(/NFL Spread/.test(report.recommendation.text));
  assert.ok(!/NCAAF/.test(report.recommendation.text));
  assert.strictEqual(report.applied, false);
  assert.strictEqual(report.observerOnly, true);
}

// Rolling windows are inclusive calendar days ending on asOf.
{
  const marks = [
    ['2026-10-11', 'all'],
    ['2026-10-05', 'all'],
    ['2026-10-04', '14'],
    ['2026-09-28', '14'],
    ['2026-09-27', '28'],
    ['2026-09-14', '28'],
    ['2026-09-13', 'out'],
  ];
  const rows = marks.map(([date]) => bet({
    date,
    sport: 'NFL',
    market: 'Moneyline',
    p_model: 0.55,
    fair_sharp_p: 0.5,
    closeNoVig: 0.57,
    entryImplied: 0.48,
    y: 1,
  }));
  rows.push(bet({
    date: AS_OF, sport: 'NFL', market: 'Spread', p_model: 0.55, fair_sharp_p: 0.5,
    closeNoVig: 0.57, entryImplied: 0.48, result: 'push', forceY: false,
  }));
  rows.push(bet({
    date: AS_OF, sport: 'NFL', market: 'Spread', p_model: 0.55, fair_sharp_p: 0.5,
    closeNoVig: 0.57, entryImplied: 0.48, result: 'pending', forceY: false,
  }));
  const report = reportOf(rows);
  assert.strictEqual(cell(report, 'NFL', 7).from, '2026-10-05');
  assert.strictEqual(cell(report, 'NFL', 7).through, AS_OF);
  assert.strictEqual(cell(report, 'NFL', 7).n, 2);
  assert.strictEqual(cell(report, 'NFL', 14).from, '2026-09-28');
  assert.strictEqual(cell(report, 'NFL', 14).n, 4);
  assert.strictEqual(cell(report, 'NFL', 28).from, '2026-09-14');
  assert.strictEqual(cell(report, 'NFL', 28).n, 6);
  assert.strictEqual(cell(report, 'NHL', 28).n, 0);
  assert.strictEqual(cell(report, 'NHL', 28).meanClv, null);
  assert.strictEqual(cell(report, 'NHL', 28, 'Total').shrinkK.k, null);
}

// Drift flags: 14-day mean CLV < 0 with n>=50, or KL more than 25% above the 28-day value.
{
  const neg = repeats(50, () => bet({
    date: '2026-10-10', sport: 'MLB', market: 'Moneyline',
    p_model: 0.55, fair_sharp_p: 0.52, closeNoVig: 0.40, y: 0,
  }));
  const almost = repeats(49, () => bet({
    date: '2026-10-10', sport: 'NHL', market: 'Moneyline',
    p_model: 0.55, fair_sharp_p: 0.52, closeNoVig: 0.40, y: 0,
  }));
  const recentKl = repeats(20, () => bet({
    date: '2026-10-10', sport: 'NFL', market: 'Spread',
    p_model: 0.9, coverProb: 0.9, fair_sharp_p: 0.55, closeNoVig: 0.5, odds: 200, y: 1,
  }));
  const olderKl = repeats(80, () => bet({
    date: '2026-09-20', sport: 'NFL', market: 'Spread',
    p_model: 0.5, coverProb: 0.5, fair_sharp_p: 0.5, closeNoVig: 0.5, odds: 200, y: 1,
  }));
  const calm = repeats(10, () => bet({
    date: AS_OF, sport: 'NCAAF', market: 'Total',
    p_model: 0.56, fair_sharp_p: 0.5, closeNoVig: 0.6, entryImplied: 0.45, y: 1,
  }));
  const report = reportOf([...neg, ...almost, ...recentKl, ...olderKl, ...calm]);
  const codes = report.driftFlags.map((flag) => `${flag.sport}:${flag.code}`);
  assert.ok(codes.includes('MLB:negative-clv'), codes.join(','));
  assert.ok(codes.includes('NFL:kl-rise'), codes.join(','));
  assert.ok(!codes.some((code) => code.startsWith('NHL')), codes.join(','));
  assert.ok(!codes.some((code) => code.startsWith('NCAAF')), codes.join(','));
  const mlb = report.driftFlags.find((flag) => flag.sport === 'MLB');
  assert.strictEqual(mlb.n, 50);
  assert.ok(mlb.meanClv < 0);
  assert.ok(/Do not veto/.test(mlb.text));
  const nfl = report.driftFlags.find((flag) => flag.code === 'kl-rise');
  assert.ok(nfl.rise > 0.25);
  const kl14 = cell(report, 'NFL', 14).meanKl;
  const kl28 = cell(report, 'NFL', 28).meanKl;
  near(kl14, refKl(0.9, 0.5), 1e-12, 'kl14');
  near(kl28, (20 / 100) * refKl(0.9, 0.5), 1e-12, 'kl28');
  assert.ok(kl14 > kl28 * 1.25);

  const boundary = {};
  for (const sport of recal.SPORTS) {
    boundary[sport] = {
      windows: {
        14: { n: 10, meanClv: 0.01, meanKl: 0.05 },
        28: { n: 10, meanClv: 0.01, meanKl: 0.04 },
      },
    };
  }
  const exact = recal.collectDriftFlags(boundary);
  assert.ok(!exact.some((flag) => flag.code === 'kl-rise'), 'a 25% KL rise is not above 25%');
  boundary.NFL.windows[14].meanKl = 0.05 + 1e-6;
  const above = recal.collectDriftFlags(boundary);
  assert.ok(above.some((flag) => flag.sport === 'NFL' && flag.code === 'kl-rise'));
  boundary.MLB.windows[14] = { n: 49, meanClv: -0.02, meanKl: 0.01 };
  boundary.MLB.windows[28].meanKl = 0.01;
  const under = recal.collectDriftFlags(boundary);
  assert.ok(!under.some((flag) => flag.sport === 'MLB' && flag.code === 'negative-clv'));
  boundary.MLB.windows[14].n = 50;
  const at = recal.collectDriftFlags(boundary);
  assert.ok(at.some((flag) => flag.sport === 'MLB' && flag.code === 'negative-clv'));
}

// Join ledger + close + graded pick. A push is not in the cohort.
{
  const report = recal.buildRecalReport({
    asOf: AS_OF,
    generatedAt: '2026-10-11T13:15:00.000Z',
    ledgers: [{
      date: '2026-10-10',
      candidates: [
        {
          sport: 'CFB', matchup: 'Ohio State @ Michigan', market: 'Moneyline', side: 'Michigan',
          line: null, odds: -110, p_model: 0.61, coverProb: 0.58, fair_sharp_p: 0.53,
        },
        {
          sport: 'NHL', matchup: 'A @ B', market: 'Total', side: 'Over 6.5', line: 6.5,
          odds: -110, p_model: 0.55, coverProb: 0.54, fair_sharp_p: 0.51,
        },
      ],
    }],
    closes: [{
      date: '2026-10-10',
      candidates: [
        {
          sport: 'NCAAF', matchup: 'Ohio State @ Michigan', market: 'Moneyline', side: 'Michigan',
          line: null, closeNoVig: 0.6,
        },
        {
          sport: 'NHL', matchup: 'A @ B', market: 'Total', side: 'Over 6.5', line: 6.5,
          closeNoVig: 0.57, result: 'push',
        },
      ],
    }],
    results: [{
      date: '2026-10-10',
      picks: [{ sport: 'NCAAF', matchup: 'Ohio State @ Michigan', pick: 'Michigan ML', result: 'win' }],
    }],
  });
  const ncaaf = cell(report, 'NCAAF', 28, 'Moneyline');
  assert.strictEqual(ncaaf.n, 1);
  near(ncaaf.meanEdge, 0.58 - 0.53, 1e-12, 'joined edge uses calibrated prob');
  near(ncaaf.meanClv, 0.6 - (110 / 210), 1e-12, 'joined clv');
  assert.strictEqual(ncaaf.calibration[5].n, 1);
  assert.strictEqual(cell(report, 'NHL', 28).n, 0, 'push is excluded');
  assert.strictEqual(report.cohort, 1);
}

// Schedule is 9:15 ET, both UTC hours, and the job writes only its own keys.
{
  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  const active = et.activeTomlSchedules(toml).find((row) => row.functionName === 'recal-report-omega');
  assert.ok(active, 'toml schedule missing');
  assert.strictEqual(active.cron, '15 13,14 * * *');
  assert.deepStrictEqual(et.ET_SCHEDULE['recal-report-omega'].etTimes, ['09:15']);
  const parsed = et.parseCron(active.cron);
  const want = et.utcHoursForEt('09:15');
  assert.ok(parsed.minute.has(want.minute));
  for (const hour of want.hours) assert.ok(parsed.hour.has(hour));

  const sched = {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
  };
  assert.strictEqual(et.etGuard('recal-report-omega', sched, new Date('2026-10-11T13:15:00Z')).matched, '09:15');
  assert.strictEqual(et.etGuard('recal-report-omega', sched, new Date('2026-10-11T14:15:00Z')).run, false);
  assert.strictEqual(et.etGuard('recal-report-omega', sched, new Date('2026-11-02T14:15:00Z')).matched, '09:15');
  assert.strictEqual(et.etGuard('recal-report-omega', sched, new Date('2026-11-02T13:15:00Z')).run, false);
}

function memoryStore(seed) {
  const blobs = Object.assign(Object.create(null), seed || {});
  const writes = [];
  return {
    blobs,
    writes,
    readJson: async (key) => (Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null),
    writeJson: async (key, data) => {
      writes.push(key);
      blobs[key] = data;
    },
  };
}

async function main() {
  const now = new Date('2026-10-11T13:15:00.000Z');
  const ledger = {
    date: '2026-10-10',
    candidates: [{
      sport: 'MLB', matchup: 'Dodgers @ Padres', market: 'Moneyline', side: 'Padres', line: null,
      odds: 130, p_model: 0.48, coverProb: 0.46, fair_sharp_p: 0.44,
    }],
  };
  const close = {
    date: '2026-10-10',
    candidates: [{
      sport: 'MLB', matchup: 'Dodgers @ Padres', market: 'Moneyline', side: 'Padres', line: null,
      closeNoVig: 0.5,
    }],
  };
  const picks = {
    date: '2026-10-10',
    picks: [{ sport: 'MLB', matchup: 'Dodgers @ Padres', pick: 'Padres ML', result: 'win' }],
  };

  const prevFlag = process.env.OMEGA_REPLAY_NO_WRITE;
  process.env.OMEGA_REPLAY_NO_WRITE = '1';
  try {
    const mem = memoryStore({
      'omega-candidates/2026-10-10': ledger,
      'clv-candidates-v2/2026-10-10': close,
      'picks-2026-10-10': picks,
    });
    const res = await job.handle({
      httpMethod: 'POST',
      queryStringParameters: { date: AS_OF },
    }, now, mem);
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.wrote, false);
    assert.strictEqual(body.reason, 'no-write');
    assert.strictEqual(body.applied, false);
    assert.strictEqual(body.observerOnly, true);
    assert.deepStrictEqual(body.keys, []);
    assert.strictEqual(mem.writes.length, 0);
    assert.strictEqual(body.sports.MLB.windows[28].markets.Moneyline.n, 1);
    const clv = 0.5 - recal.americanToImplied(130);
    near(body.sports.MLB.windows[28].meanClv, clv, 1e-12, 'handler clv');
    assert.ok(clv > 0);
  } finally {
    if (prevFlag == null) delete process.env.OMEGA_REPLAY_NO_WRITE;
    else process.env.OMEGA_REPLAY_NO_WRITE = prevFlag;
  }

  {
    const mem = memoryStore({
      'omega-candidates/2026-10-10': ledger,
      'clv-candidates-v2/2026-10-10': close,
      'picks-2026-10-10': picks,
    });
    const res = await job.handle({
      httpMethod: 'GET',
      queryStringParameters: { dryRun: '1', date: AS_OF },
    }, now, mem);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.wrote, false);
    assert.strictEqual(body.reason, 'dry-run');
    assert.strictEqual(mem.writes.length, 0);
    assert.strictEqual(body.applied, false);
    assert.strictEqual(configAfter, snapConfig(), 'dry run changed config');
  }

  {
    const mem = memoryStore({});
    const res = await job.handle({
      httpMethod: 'POST',
      queryStringParameters: { date: AS_OF },
    }, now, { ...mem, env: {} });
    const body = JSON.parse(res.body);
    assert.strictEqual(body.wrote, true);
    assert.deepStrictEqual(mem.writes, [
      'omega-recal-report/2026-10-11',
      'omega-recal-report/latest',
    ]);
    assert.strictEqual(mem.blobs['omega-recal-report/latest'].schema, recal.SCHEMA);
    assert.strictEqual(mem.blobs['omega-recal-report/latest'].applied, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(mem.blobs['omega-recal-report/latest'], 'wrote'));
    const got = await job.handle({ httpMethod: 'GET' }, now, mem);
    const latest = JSON.parse(got.body);
    assert.strictEqual(latest.schema, recal.SCHEMA);
    assert.strictEqual(latest.asOf, AS_OF);
    assert.strictEqual(latest.applied, false);
    assert.strictEqual(mem.writes.length, 2, 'GET latest must not write');
  }

  {
    const mem = memoryStore({});
    const skipped = await job.handle({
      httpMethod: 'POST',
      headers: { 'x-nf-event': 'schedule' },
      body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
    }, new Date('2026-10-11T14:15:00.000Z'), mem);
    const body = JSON.parse(skipped.body);
    assert.strictEqual(body.skipped, 'et-guard');
    assert.strictEqual(mem.writes.length, 0);
  }

  {
    const missing = await job.handle({ httpMethod: 'GET' }, now, memoryStore({}));
    assert.strictEqual(JSON.parse(missing.body).missing, true);
    const bad = await job.handle({
      httpMethod: 'POST',
      queryStringParameters: { date: 'tomorrow', dryRun: '1' },
    }, now, memoryStore({}));
    assert.strictEqual(bad.statusCode, 400);
  }

  assert.strictEqual(snapConfig(), configBefore, 'the run changed config');
  console.log('PASS test-omega-recal-report');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
