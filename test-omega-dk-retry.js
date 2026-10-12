'use strict';
/**
 * Lock-snapshot DraftKings retries. Fixture odds, injected fetch and sleep.
 * No network. No wall-clock wait.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { retryMissingDraftKings, needsDkRetry } = require(path.join(root, 'dk_retry'));
const { createAuditLog, runWithAudit } = require(path.join(root, 'audit_log'));
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'test/fixtures/dk-lock-missing-total.json'), 'utf8'));

function dkMarkets(event) {
  const book = (event.bookmakers || []).find((b) => b.key === 'draftkings');
  return new Set(((book && book.markets) || []).map((m) => m.key));
}

function totalPoint(event) {
  const book = (event.bookmakers || []).find((b) => b.key === 'draftkings');
  const market = ((book && book.markets) || []).find((m) => m.key === 'totals');
  const over = ((market && market.outcomes) || []).find((o) => o.name === 'Over');
  return over ? over.point : null;
}

(async () => {
  const savedRetry = process.env.OMEGA_DK_RETRY;
  const savedTest = process.env.OMEGA_DK_RETRY_TEST;
  const restore = () => {
    if (savedRetry == null) delete process.env.OMEGA_DK_RETRY;
    else process.env.OMEGA_DK_RETRY = savedRetry;
    if (savedTest == null) delete process.env.OMEGA_DK_RETRY_TEST;
    else process.env.OMEGA_DK_RETRY_TEST = savedTest;
  };
  try {
    delete process.env.OMEGA_DK_RETRY;
    delete process.env.OMEGA_DK_RETRY_TEST;

    const missing = fixture.NFL[1];
    const complete = fixture.NFL[0];
    assert.strictEqual(needsDkRetry(missing), true);
    assert.strictEqual(needsDkRetry(complete), false);
    assert.ok(indexSrc.includes('if (snap && snap.oddsBySport && oddsSnapshot)'));
    assert.ok(indexSrc.includes('retryMissingDraftKings'));

    const liveTotal = {
      id: 'nfl-missing-total',
      bookmakers: [{
        key: 'draftkings',
        markets: [{
          key: 'totals',
          outcomes: [
            { name: 'Over', price: -108, point: 46.5 },
            { name: 'Under', price: -112, point: 46.5 },
          ],
        }],
      }],
    };

    let fetches = 0;
    let sleeps = 0;
    const notes = [];
    const filled = await retryMissingDraftKings({ NFL: JSON.parse(JSON.stringify(fixture.NFL)) }, {
      apiKey: 'test-key',
      sleep: async () => { sleeps += 1; },
      log: (row) => notes.push(row),
      fetchJson: async (url) => {
        fetches += 1;
        assert.ok(String(url).includes('/events/nfl-missing-total/odds'));
        assert.ok(String(url).includes('bookmakers=draftkings'));
        assert.ok(!String(url).includes('nfl-complete'));
        return { data: liveTotal };
      },
    });
    assert.strictEqual(fetches, 1);
    assert.strictEqual(sleeps, 0);
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].note.includes('dk-retry'));
    assert.ok(notes[0].note.includes('missing=total'));
    const filledComplete = filled.NFL.find((e) => e.id === 'nfl-complete');
    assert.strictEqual(totalPoint(filledComplete), 47.5);
    assert.strictEqual(totalPoint(filled.NFL.find((e) => e.id === 'nfl-missing-total')), 46.5);
    const merged = filled.NFL.find((e) => e.id === 'nfl-missing-total');
    assert.ok(dkMarkets(merged).has('spreads'), 'a live body that omits spreads must keep the snapshot spread');
    assert.ok(dkMarkets(merged).has('h2h'));
    const pinSpread = (merged.bookmakers.find((b) => b.key === 'pinnacle').markets || []).some((m) => m.key === 'spreads');
    assert.strictEqual(pinSpread, true);

    const sameComplete = JSON.parse(JSON.stringify(fixture));
    let untouchedFetches = 0;
    const kept = await retryMissingDraftKings({ NFL: [sameComplete.NFL[0]] }, {
      apiKey: 'test-key',
      fetchJson: async () => { untouchedFetches += 1; return null; },
      sleep: async () => { throw new Error('complete line must not sleep'); },
    });
    assert.strictEqual(untouchedFetches, 0);
    assert.strictEqual(kept.NFL[0], sameComplete.NFL[0]);

    fetches = 0;
    sleeps = 0;
    const exhaustedNotes = [];
    const exhausted = await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
      apiKey: 'test-key',
      sleep: async () => { sleeps += 1; },
      log: (row) => exhaustedNotes.push(row),
      fetchJson: async () => {
        fetches += 1;
        return { bookmakers: [{ key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: -110 }] }] }] };
      },
    });
    assert.strictEqual(fetches, 6);
    assert.strictEqual(sleeps, 5);
    assert.strictEqual(exhaustedNotes.length, 6);
    const onlyMl = exhausted.NFL[0];
    assert.deepStrictEqual([...dkMarkets(onlyMl)], ['h2h']);
    const pin = onlyMl.bookmakers.find((b) => b.key === 'pinnacle');
    assert.ok(pin);
    assert.deepStrictEqual(pin.markets, []);
    assert.ok(dkMarkets(missing).has('spreads'), 'strip must not mutate the fixture event');

    let third = 0;
    const late = await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
      apiKey: 'test-key',
      sleep: async () => {},
      fetchJson: async () => {
        third += 1;
        if (third < 3) {
          const err = new Error('HTTP 500');
          err.status = 500;
          throw err;
        }
        return [liveTotal];
      },
    });
    assert.strictEqual(third, 3);
    assert.strictEqual(totalPoint(late.NFL[0]), 46.5);
    assert.ok(dkMarkets(late.NFL[0]).has('spreads'));

    fetches = 0;
    const dry = await retryMissingDraftKings(JSON.parse(JSON.stringify(fixture)), {
      dryRun: true,
      apiKey: 'test-key',
      fetchJson: async () => { fetches += 1; return liveTotal; },
    });
    assert.strictEqual(fetches, 0);
    assert.ok(needsDkRetry(dry.NFL[1]));

    process.env.OMEGA_DK_RETRY_TEST = '1';
    fetches = 0;
    const replay = await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
      replay: true,
      apiKey: 'test-key',
      fetchJson: async () => { fetches += 1; return { data: [liveTotal] }; },
      sleep: async () => { throw new Error('filled on the first try'); },
    });
    assert.strictEqual(fetches, 1);
    assert.strictEqual(totalPoint(replay.NFL[0]), 46.5);

    process.env.OMEGA_DK_RETRY = '0';
    fetches = 0;
    const off = await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
      dryRun: false,
      replay: true,
      apiKey: 'test-key',
      fetchJson: async () => { fetches += 1; return liveTotal; },
    });
    assert.strictEqual(fetches, 0);
    assert.ok(dkMarkets(off.NFL[0]).has('spreads'));
    assert.ok(!(dkMarkets(off.NFL[0]).has('totals')));
    delete process.env.OMEGA_DK_RETRY;
    delete process.env.OMEGA_DK_RETRY_TEST;

    const noKeyNotes = [];
    const stripped = await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
      apiKey: '',
      log: (row) => noKeyNotes.push(row),
      fetchJson: async () => { throw new Error('no key must not fetch'); },
    });
    assert.strictEqual(noKeyNotes.length, 1);
    assert.ok(noKeyNotes[0].note.includes('no api key'));
    assert.deepStrictEqual([...dkMarkets(stripped.NFL[0])], ['h2h']);

    const noId = await retryMissingDraftKings(JSON.parse(JSON.stringify({ MLB: fixture.MLB })), {
      apiKey: 'test-key',
      fetchJson: async () => { throw new Error('missing id must not fetch'); },
    });
    assert.deepStrictEqual([...dkMarkets(noId.MLB[0])], ['h2h']);

    const audit = createAuditLog({ runId: 'dk-retry-test', date: '2026-10-12' });
    await runWithAudit(audit, async () => {
      await retryMissingDraftKings({ NFL: [JSON.parse(JSON.stringify(missing))] }, {
        apiKey: 'live-secret-key',
        sleep: async () => {},
        fetchJson: async () => liveTotal,
      });
    });
    const rows = audit.entries();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].provider, 'odds-api');
    assert.ok(rows[0].note.includes('dk-retry'));
    assert.ok(rows[0].url.includes('apiKey=REDACTED'));
    assert.ok(!rows[0].url.includes('live-secret-key'));
    assert.ok(!rows[0].note.includes('live-secret-key'));
    assert.ok(!JSON.stringify(rows).includes('live-secret-key'));
  } finally {
    restore();
  }
  console.log('test-omega-dk-retry ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
