'use strict';

/**
 * Agentics ledger: read-only blob function, display contract, and page copy.
 * Does not call the network and does not write blobs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = __dirname;
const fnPath = path.join(root, 'netlify/functions/agentics-ledger.js');
const samplePath = path.join(root, 'docs/agentics-dashboard-sample.json');
const schemaPath = path.join(root, 'docs/agentics-dashboard-schema.json');
const pagePath = path.join(root, 'agentics/index.html');

let behavior = async () => null;
let reads = 0;

function install() {
  delete require.cache[fnPath];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@netlify/blobs') {
      return {
        getStore(name) {
          if (name !== 'agentics') throw new Error('unexpected store ' + name);
          return {
            get(key, opts) {
              reads += 1;
              assert.strictEqual(key, 'omega-shadow/latest.json');
              assert.deepStrictEqual(opts, { type: 'text' });
              return behavior();
            },
            set() { throw new Error('ledger must not write'); },
            setJSON() { throw new Error('ledger must not write'); },
            delete() { throw new Error('ledger must not write'); },
          };
        },
      };
    }
    return original.apply(this, arguments);
  };
  try {
    return require(fnPath);
  } finally {
    Module._load = original;
  }
}

function jsonBody(res) {
  assert.strictEqual(res.headers['Content-Type'], 'application/json; charset=utf-8');
  return JSON.parse(res.body);
}

(async () => {
  const src = fs.readFileSync(fnPath, 'utf8');
  assert.ok(!/\.setJSON\s*\(/.test(src), 'no setJSON');
  assert.ok(!/\.set\s*\(/.test(src), 'no blob set');
  assert.ok(!/\.delete\s*\(/.test(src), 'no blob delete');
  assert.ok(!/omega-vnext|get-picks-omega|generate-picks-omega/.test(src), 'isolated from Omega pick code');
  assert.ok(src.includes("getStore(STORE)"), 'reads via getStore');
  assert.ok(src.includes('omega-shadow/latest.json'));
  assert.ok(src.includes('public, max-age=60'));
  assert.ok(src.includes('netlify blobs:set agentics omega-shadow/latest.json --input <file>'));

  const ledger = install();
  assert.strictEqual(ledger._test.STORE, 'agentics');
  assert.strictEqual(ledger._test.KEY, 'omega-shadow/latest.json');

  reads = 0;
  const opt = await ledger.handler({ httpMethod: 'OPTIONS' });
  assert.strictEqual(opt.statusCode, 204);
  assert.strictEqual(reads, 0);

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    reads = 0;
    const denied = await ledger.handler({ httpMethod: method });
    assert.strictEqual(denied.statusCode, 405, method);
    assert.strictEqual(denied.headers['Cache-Control'], 'no-store');
    assert.deepStrictEqual(jsonBody(denied), { ok: false, error: 'GET only' });
    assert.strictEqual(reads, 0, method + ' must not read');
  }

  reads = 0;
  behavior = async () => null;
  const missing = await ledger.handler({ httpMethod: 'GET' });
  assert.strictEqual(missing.statusCode, 200);
  assert.strictEqual(missing.headers['Cache-Control'], 'public, max-age=60');
  assert.strictEqual(reads, 1);
  const empty = jsonBody(missing);
  assert.strictEqual(empty.ok, true);
  assert.strictEqual(empty.empty, true);
  assert.strictEqual(empty.reason, 'missing');
  assert.deepStrictEqual(empty.today.picks, []);
  assert.deepStrictEqual(empty.ledger, []);
  assert.strictEqual(empty.summary.record, '0-0-0');
  assert.strictEqual(empty.summary.pl, 0);
  assert.strictEqual(empty.summary.roiPct, 0);
  assert.strictEqual(empty.gate.daysRequired, 14);
  assert.strictEqual(empty.gate.tradesRequired, 20);
  assert.strictEqual(empty.gate.daysElapsed, 0);
  assert.strictEqual(empty.gate.trades, 0);
  assert.deepStrictEqual(empty.limits, {
    dailyDrawdownPct: 5,
    weeklyDrawdownPct: 7.5,
    totalDrawdownPct: 12,
  });
  assert.strictEqual(empty.clv.vs, 'polymarket-close');
  assert.ok(!Number.isNaN(Date.parse(empty.asOf)));

  behavior = async () => '   ';
  const blank = jsonBody(await ledger.handler({ httpMethod: 'GET' }));
  assert.strictEqual(blank.empty, true);
  assert.strictEqual(blank.reason, 'missing');

  behavior = async () => '{';
  const bad = jsonBody(await ledger.handler({ httpMethod: 'GET' }));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'invalid-json');
  assert.strictEqual(bad.empty, true);

  behavior = async () => '[1,2]';
  const shape = jsonBody(await ledger.handler({ httpMethod: 'GET' }));
  assert.strictEqual(shape.reason, 'invalid-shape');

  behavior = async () => { throw new Error('blobs down'); };
  const down = await ledger.handler({ httpMethod: 'GET' });
  assert.strictEqual(down.headers['Cache-Control'], 'no-store');
  const downBody = jsonBody(down);
  assert.strictEqual(downBody.ok, false);
  assert.strictEqual(downBody.reason, 'read-error');
  assert.strictEqual(downBody.error, 'blobs down');

  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  behavior = async () => JSON.stringify(sample);
  const live = await ledger.handler({ httpMethod: 'GET' });
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(live.headers['Cache-Control'], 'public, max-age=60');
  assert.deepStrictEqual(jsonBody(live), sample);

  behavior = async () => '\uFEFF' + JSON.stringify({ ok: true, marker: 'bom' });
  assert.strictEqual(jsonBody(await ledger.handler({ httpMethod: 'get' })).marker, 'bom');

  assertSample(sample);

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.strictEqual(schema['x-publish'].command, 'netlify blobs:set agentics omega-shadow/latest.json --input <file>');
  assert.strictEqual(schema['x-publish'].store, 'agentics');
  assert.strictEqual(schema['x-publish'].key, 'omega-shadow/latest.json');
  assert.ok(schema.description.includes('netlify blobs:set agentics omega-shadow/latest.json --input <file>'));
  assert.strictEqual(schema.$defs.limits.properties.dailyDrawdownPct.const, 5);
  assert.strictEqual(schema.$defs.limits.properties.weeklyDrawdownPct.const, 7.5);
  assert.strictEqual(schema.$defs.limits.properties.totalDrawdownPct.const, 12);
  assert.strictEqual(schema.properties.gate.properties.daysRequired.const, 14);
  assert.strictEqual(schema.properties.gate.properties.tradesRequired.const, 20);

  const doc = fs.readFileSync(path.join(root, 'docs/AGENTICS-DASHBOARD.md'), 'utf8');
  assert.ok(doc.includes('netlify blobs:set agentics omega-shadow/latest.json --input <file>'));
  assert.ok(doc.includes('netlify blobs:get agentics omega-shadow/latest.json'));

  const page = fs.readFileSync(pagePath, 'utf8');
  for (const phrase of [
    "Today's matched Omega picks",
    'Running ledger',
    'Max drawdown',
    '5% daily',
    '7.5% weekly',
    '12% total',
    'Daily CLV vs Polymarket close',
    '14-day / 20-trade gate',
    '/.netlify/functions/agentics-ledger',
    'WeBetAI - Social Intelligence | Agentics',
    'https://webetsocial.com/agentics',
  ]) {
    assert.ok(page.includes(phrase), 'page missing: ' + phrase);
  }
  assert.ok(!/\b(bets?|betting|wagers?|wagering)\b/i.test(page), 'page copy uses pick/position/trade');
  assert.ok(page.includes('>Record<') && page.includes('>P/L<') && page.includes('>ROI<'));
  assert.ok(page.includes('>Price<') && page.includes('>Fee<') && page.includes('>Stake<') && page.includes('>Status<'));

  const redirects = fs.readFileSync(path.join(root, '_redirects'), 'utf8');
  assert.ok(/\/agentics\s+\/agentics\/index\.html\s+200/.test(redirects));
  assert.ok(/\/api\/agentics-ledger\s+\/\.netlify\/functions\/agentics-ledger\s+200/.test(redirects));
  const headers = fs.readFileSync(path.join(root, '_headers'), 'utf8');
  assert.ok(headers.includes('/agentics/*'));

  const roadmap = fs.readFileSync(path.join(root, 'docs/ROADMAP-NEXT.md'), 'utf8');
  assert.ok(roadmap.length > 0);

  console.log('PASS test-agentics-ledger', {
    sampleTrades: sample.ledger.length,
    record: sample.summary.record,
    roiPct: sample.summary.roiPct,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function assertSample(sample) {
  assert.strictEqual(sample.sample, true);
  assert.strictEqual(sample.empty, false);
  assert.strictEqual(sample.mode, 'shadow');
  assert.deepStrictEqual(sample.limits, {
    dailyDrawdownPct: 5,
    weeklyDrawdownPct: 7.5,
    totalDrawdownPct: 12,
  });
  assert.strictEqual(sample.gate.daysRequired, 14);
  assert.strictEqual(sample.gate.tradesRequired, 20);
  assert.strictEqual(sample.gate.daysElapsed, 6);
  assert.strictEqual(sample.gate.trades, sample.ledger.length);
  assert.strictEqual(sample.gate.met, false);
  assert.ok(sample.gate.daysElapsed < 14 && sample.gate.trades < 20);

  const settled = sample.ledger.filter((row) => row.result !== 'open');
  const open = sample.ledger.filter((row) => row.result === 'open');
  assert.strictEqual(open.length, sample.summary.open);
  assert.strictEqual(settled.filter((r) => r.result === 'win').length, sample.summary.wins);
  assert.strictEqual(settled.filter((r) => r.result === 'loss').length, sample.summary.losses);
  assert.strictEqual(settled.filter((r) => r.result === 'push').length, sample.summary.pushes);

  let pl = 0;
  let staked = 0;
  const statuses = new Set();
  for (const row of sample.ledger) {
    assert.ok(row.market && row.pick);
    assert.ok(row.price >= 0 && row.price <= 1);
    assert.ok(row.fee >= 0 && row.stake >= 0);
    assert.ok(row.status === 'shadow' || row.status === 'paper');
    statuses.add(row.status);
    if (row.closePrice == null) {
      assert.strictEqual(row.clvCents, null);
    } else {
      assert.strictEqual(row.clvCents, Math.round((row.closePrice - row.price) * 100));
    }
    if (row.result === 'open') {
      assert.strictEqual(row.pl, null);
      continue;
    }
    const expected = row.result === 'win'
      ? round2(row.stake * (1 - row.price) / row.price - row.fee)
      : row.result === 'loss'
        ? round2(-(row.stake + row.fee))
        : 0;
    assert.strictEqual(row.pl, expected, row.id);
    pl = round2(pl + row.pl);
    staked = round2(staked + row.stake);
  }
  assert.ok(statuses.has('shadow') && statuses.has('paper'));
  assert.strictEqual(sample.summary.pl, pl);
  assert.strictEqual(sample.summary.staked, staked);
  assert.strictEqual(sample.summary.roiPct, Math.round((100 * pl / staked) * 100) / 100);
  assert.strictEqual(sample.summary.record, sample.summary.wins + '-' + sample.summary.losses + '-' + sample.summary.pushes);
  assert.deepStrictEqual(sample.today.picks.map((p) => p.id), open.map((p) => p.id));
  assert.ok(sample.drawdown.dailyPct <= 5);
  assert.ok(sample.drawdown.weeklyPct <= 7.5);
  assert.ok(sample.drawdown.totalPct <= 12);
  assert.strictEqual(sample.drawdown.withinLimits, true);
  assert.strictEqual(sample.clv.vs, 'polymarket-close');

  const byDate = {};
  for (const row of settled) {
    if (row.clvCents == null) continue;
    if (!byDate[row.date]) byDate[row.date] = [];
    byDate[row.date].push(row.clvCents);
  }
  for (const day of sample.clv.byDay) {
    const vals = byDate[day.date];
    assert.ok(vals, day.date);
    assert.strictEqual(day.n, vals.length);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    assert.strictEqual(day.avgClvCents, avg);
  }
}
