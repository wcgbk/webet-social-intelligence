'use strict';
/**
 * Per-run Omega audit log: redaction, fetch/model records, no blob write
 * on replay, and unchanged card numbers.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAuditLog, runWithAudit, persistAuditLog, attachAuditSummary, resolveFetch,
} = require('./netlify/functions/lib/omega-vnext/audit_log');
const { xaiChat } = require('./netlify/functions/lib/xai-chat');
const { memoFetchJson, runWithFetchMemo } = require('./netlify/functions/lib/omega-vnext/fetch_memo');
const { americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
const store = require('./netlify/functions/lib/omega-vnext/store');

const SECRET = 'SECRET';
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function jsonResp(body, status, extraHeaders) {
  const text = JSON.stringify(body);
  const headers = Object.assign({ 'content-length': String(text.length) }, extraHeaders || {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const want = String(name || '').toLowerCase();
        return headers[want] != null ? headers[want] : null;
      },
    },
    json: async () => body,
    text: async () => text,
  };
}

function dump(log) {
  return JSON.stringify({ entries: log.entries(), summary: log.summary() });
}

function cardFromBody(body) {
  const price = body.price;
  const implied = americanToImplied(price);
  return {
    picks: [{
      odds: price,
      units: '1.25u',
      edgePct: Number(((implied - 0.5) * 100).toFixed(4)),
      ev: Number((implied - americanToImplied(-110)).toFixed(6)),
      coverProb: implied,
      winProbability: implied,
    }],
    summary: { totalUnits: '1.25u', totalPicks: 1 },
    model: 'v12.3.25-omega-vnext-price-lock',
  };
}

function stripAudit(card) {
  const copy = JSON.parse(JSON.stringify(card));
  delete copy.audit;
  return copy;
}

(async () => {
  const prevFetch = global.fetch;
  const prevKey = process.env.XAI_API_KEY;
  const prevModel = process.env.XAI_MODEL;
  const prevFallback = process.env.XAI_FALLBACK_MODELS;
  const prevNoWrite = process.env.OMEGA_REPLAY_NO_WRITE;
  const prevAuditFile = process.env.OMEGA_AUDIT_FILE;
  const origStoreJson = store.storeJson;
  const auditFile = path.join(os.tmpdir(), `omega-audit-test-${process.pid}.jsonl`);
  let storeJsonCalls = 0;
  store.storeJson = async () => {
    storeJsonCalls += 1;
    throw new Error('storeJson should not be called');
  };

  try {
    // ── redaction ──
    {
      const log = createAuditLog({ runId: 'redact-run', date: '2026-10-11', fn: 'test' });
      const oddsUrl = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?regions=us&apiKey=SECRET&oddsFormat=american';
      const mixedUrl = 'https://api.example.com/v1?api_key=SECRET&api-key=SECRET&key=SECRET&token=SECRET&access_token=SECRET&safe=ok&key=1';
      await log.wrapFetch(async () => jsonResp({ ok: true }, 200, {
        'x-requests-last': '1',
        'x-requests-remaining': '99',
      }), { method: 'GET' })(oddsUrl, { headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE' } });
      await log.wrapFetch(async () => jsonResp({ ok: true }, 200))(mixedUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE' },
      });
      let thrown = null;
      try {
        await log.wrapFetch(async () => {
          const err = new Error('upstream SECRET failed apiKey=SECRET');
          err.status = 500;
          throw err;
        })('https://api.weather.gov/points/1?apiKey=SECRET');
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown);
      assert.strictEqual(thrown.message, 'upstream SECRET failed apiKey=SECRET');

      const blob = dump(log);
      assert.ok(!blob.includes(SECRET), 'secret value leaked into entries or summary');
      assert.ok(!blob.includes('apiKey=SECRET'));
      assert.ok(!blob.includes('SECRET-TOKEN-VALUE'));
      assert.ok(!blob.includes('Bearer'));
      assert.ok(!blob.includes('Authorization'));

      const entries = log.entries();
      assert.strictEqual(entries.length, 3);
      assert.ok(entries[0].url.includes('apiKey=REDACTED'));
      assert.ok(entries[0].url.includes('regions=us'));
      assert.ok(entries[0].url.includes('oddsFormat=american'));
      assert.ok(entries[1].url.includes('api_key=REDACTED'));
      assert.ok(entries[1].url.includes('api-key=REDACTED'));
      assert.ok(entries[1].url.includes('key=REDACTED'));
      assert.ok(entries[1].url.includes('token=REDACTED'));
      assert.ok(entries[1].url.includes('access_token=REDACTED'));
      assert.ok(entries[1].url.includes('safe=ok'));
      assert.ok(!entries[2].error.includes(SECRET));
      assert.ok(entries[2].error.includes('REDACTED'));
      assert.strictEqual(log.summary().runId, 'redact-run');
      assert.strictEqual(log.summary().count, 3);
    }

    // ── wrapFetch status / ms / errors ──
    {
      const log = createAuditLog({ runId: 'fetch-run', date: '2026-10-11', fn: 'test' });
      const espn = await log.wrapFetch(async () => jsonResp({ games: 1 }, 201))(
        'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
      );
      assert.strictEqual(espn.status, 201);
      const odds = await log.wrapFetch(async () => jsonResp({ price: -110 }, 200, {
        'x-requests-last': '1',
        'x-requests-remaining': '99',
      }))('https://api.the-odds-api.com/v4/sports/?apiKey=SECRET');
      assert.strictEqual(odds.status, 200);

      let nwsErr = null;
      try {
        await log.wrapFetch(async () => {
          const err = new Error('socket down');
          err.status = 503;
          throw err;
        })('https://api.weather.gov/gridpoints/OKX/1,1');
      } catch (err) {
        nwsErr = err;
      }
      assert.strictEqual(nwsErr && nwsErr.message, 'socket down');

      const poly = await log.wrapFetch(async () => jsonResp({ error: 'slow' }, 429))(
        'https://gamma-api.polymarket.com/markets',
      );
      assert.strictEqual(poly.status, 429);

      const entries = log.entries();
      assert.strictEqual(entries.length, 4);
      assert.strictEqual(entries[0].seq, 1);
      assert.ok(ISO_TS.test(entries[0].ts));
      assert.strictEqual(entries[0].kind, 'http');
      assert.strictEqual(entries[0].provider, 'espn');
      assert.strictEqual(entries[0].method, 'GET');
      assert.strictEqual(entries[0].status, 201);
      assert.strictEqual(typeof entries[0].ms, 'number');
      assert.ok(entries[0].ms >= 0);
      assert.strictEqual(entries[0].bytes, JSON.stringify({ games: 1 }).length);
      assert.strictEqual(entries[0].ok, true);
      assert.strictEqual(entries[0].error, null);

      assert.strictEqual(entries[1].provider, 'odds-api');
      assert.strictEqual(entries[1].status, 200);
      assert.strictEqual(entries[1].ok, true);
      assert.strictEqual(entries[1]['x-requests-last'], 1);
      assert.strictEqual(entries[1]['x-requests-remaining'], 99);
      assert.ok(!entries[1].url.includes(SECRET));

      assert.strictEqual(entries[2].provider, 'nws');
      assert.strictEqual(entries[2].status, 503);
      assert.strictEqual(entries[2].ok, false);
      assert.strictEqual(entries[2].error, 'socket down');
      assert.strictEqual(typeof entries[2].ms, 'number');

      assert.strictEqual(entries[3].provider, 'polymarket');
      assert.strictEqual(entries[3].status, 429);
      assert.strictEqual(entries[3].ok, false);
      assert.strictEqual(entries[3].error, 'HTTP 429');
      assert.strictEqual(log.summary().errors.length, 2);
    }

    // No current-run log: the raw fetch is returned and nothing is recorded.
    {
      const quiet = createAuditLog({ runId: 'quiet-fetch', date: '2026-10-11', fn: 'test' });
      let calls = 0;
      const impl = async () => {
        calls += 1;
        return jsonResp({ price: -110 }, 200);
      };
      const wrapped = resolveFetch(impl);
      assert.strictEqual(wrapped, impl);
      const resp = await wrapped('https://site.api.espn.com/scoreboard');
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(calls, 1);
      assert.strictEqual(quiet.entries().length, 0);
    }

    // ── model fallback: primary 429, fallback answered ──
    {
      delete process.env.XAI_MODEL;
      process.env.XAI_FALLBACK_MODELS = 'grok-answered-other';
      const seen = [];
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push({ url: String(url), model: body.model, max_tokens: body.max_tokens });
        if (body.model === 'grok-4.3') {
          return {
            ok: false,
            status: 429,
            headers: { get() { return null; } },
            text: async () => 'capacity test-xai-secret-key',
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get(name) { return String(name).toLowerCase() === 'content-length' ? '12' : null; } },
          text: async () => 'ok-text',
          json: async () => ({
            model: 'grok-silent-other',
            choices: [{ message: { content: 'ok-text' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
        };
      };

      const log = createAuditLog({ runId: 'model-run', date: '2026-10-11', fn: 'narrate' });
      const text = await runWithAudit(log, () => xaiChat({
        apiKey: 'test-xai-secret-key',
        model: 'grok-4.3',
        user: 'hello',
        maxTokens: 32,
        timeoutMs: 5000,
      }));
      assert.strictEqual(text, 'ok-text');
      assert.deepStrictEqual(seen.map((s) => s.model), ['grok-4.3', 'grok-answered-other']);
      assert.ok(seen.every((s) => s.max_tokens === 32));

      const entries = log.entries();
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].kind, 'model');
      assert.strictEqual(entries[0].provider, 'xai');
      assert.strictEqual(entries[0].method, 'POST');
      assert.strictEqual(entries[0].model, 'grok-4.3');
      assert.strictEqual(entries[0].modelAnswered, null);
      assert.strictEqual(entries[0].attempt, 0);
      assert.strictEqual(entries[0].status, 429);
      assert.strictEqual(entries[0].ok, false);
      assert.ok(ISO_TS.test(entries[0].ts));
      assert.strictEqual(entries[1].kind, 'model');
      assert.strictEqual(entries[1].model, 'grok-answered-other');
      assert.strictEqual(entries[1].modelAnswered, 'grok-silent-other');
      assert.strictEqual(entries[1].attempt, 1);
      assert.strictEqual(entries[1].status, 200);
      assert.strictEqual(entries[1].ok, true);
      assert.deepStrictEqual(entries[1].tokens, { prompt: 10, completion: 2, total: 12 });

      const summary = log.summary();
      assert.strictEqual(summary.models.length, 2);
      assert.strictEqual(summary.errors.length, 1);
      assert.strictEqual(summary.models[1].modelAnswered, 'grok-silent-other');
      const blob = dump(log);
      assert.ok(!blob.includes('test-xai-secret-key'));
      assert.ok(!blob.includes('Bearer'));

      const untouched = createAuditLog({ runId: 'no-context', date: '2026-10-11', fn: 'test' });
      const text2 = await xaiChat({
        apiKey: 'test-xai-secret-key',
        model: 'grok-answered-other',
        user: 'hi',
        maxTokens: 8,
        timeoutMs: 5000,
      });
      assert.strictEqual(text2, 'ok-text');
      assert.strictEqual(untouched.entries().length, 0);
    }

    // ── no blob write under OMEGA_REPLAY_NO_WRITE or dryRun ──
    {
      try { fs.unlinkSync(auditFile); } catch (_) { /* fresh file */ }
      process.env.OMEGA_REPLAY_NO_WRITE = '1';
      process.env.OMEGA_AUDIT_FILE = auditFile;
      const log = createAuditLog({ runId: 'run1', date: '2026-10-11', fn: 'generate-picks-omega' });
      await log.wrapFetch(async () => jsonResp({ price: -110 }, 200, {
        'x-requests-last': '2',
        'x-requests-remaining': '40',
      }))('https://api.the-odds-api.com/v4/sports/?regions=us&apiKey=SECRET');
      const blocked = await persistAuditLog(log);
      assert.strictEqual(storeJsonCalls, 0);
      assert.strictEqual(blocked.wrote, false);
      assert.strictEqual(blocked.file, auditFile);
      const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 1);
      const payload = JSON.parse(lines[0]);
      assert.strictEqual(payload.runId, 'run1');
      assert.strictEqual(payload.date, '2026-10-11');
      assert.strictEqual(payload.entries.length, 1);
      assert.ok(!JSON.stringify(payload).includes(SECRET));
      assert.ok(!JSON.stringify(payload).includes('apiKey=SECRET'));

      delete process.env.OMEGA_REPLAY_NO_WRITE;
      const dry = await persistAuditLog(log, { dryRun: true });
      assert.strictEqual(storeJsonCalls, 0);
      assert.strictEqual(dry.wrote, false);
      assert.strictEqual(dry.reason, 'dryRun');
      const lines2 = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines2.length, 2);
      assert.ok(!lines2[1].includes(SECRET));

      const beforePositive = lines2.length;
      let stored = null;
      const wrote = await persistAuditLog(log, {
        storeJson: async (key, body) => { stored = { key, body }; },
      });
      assert.strictEqual(storeJsonCalls, 0);
      assert.strictEqual(wrote.wrote, true);
      assert.strictEqual(wrote.key, 'omega-audit/2026-10-11/run1');
      assert.strictEqual(stored.key, 'omega-audit/2026-10-11/run1');
      assert.strictEqual(stored.body.entries.length, 1);
      assert.strictEqual(stored.body.summary.count, 1);
      assert.ok(!JSON.stringify(stored.body).includes(SECRET));
      const after = fs.readFileSync(auditFile, 'utf8').trim().split('\n').length;
      assert.strictEqual(after, beforePositive);
    }

    // ── card numbers unchanged with vs without the audit log ──
    {
      const oddsUrl = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?regions=us&apiKey=SECRET&oddsFormat=american';
      const fetchImpl = async () => jsonResp({ price: -110 }, 200, {
        'x-requests-last': '3',
        'x-requests-remaining': '10',
      });

      const log = createAuditLog({ runId: 'card-run', date: '2026-10-11', fn: 'generate-picks-omega' });
      let calls = 0;
      const counting = async (url, init) => {
        calls += 1;
        return fetchImpl(url, init);
      };
      let withBody;
      await runWithAudit(log, () => runWithFetchMemo(async () => {
        withBody = await memoFetchJson(oddsUrl, 1000, counting);
        const again = await memoFetchJson(oddsUrl, 1000, counting);
        assert.deepStrictEqual(again, withBody);
      }));
      assert.strictEqual(calls, 1);
      assert.strictEqual(log.entries().length, 1);

      let withoutBody;
      await runWithFetchMemo(async () => {
        withoutBody = await memoFetchJson(oddsUrl, 1000, fetchImpl);
      });

      const withAudit = cardFromBody(withBody);
      withAudit.audit = { configHash: 'abc', modelVersion: 'v12.3.25-omega-vnext-price-lock' };
      attachAuditSummary(withAudit, log);
      const without = cardFromBody(withoutBody);

      assert.deepStrictEqual(stripAudit(withAudit), stripAudit(without));
      assert.strictEqual(withAudit.picks[0].odds, without.picks[0].odds);
      assert.strictEqual(withAudit.picks[0].odds, -110);
      assert.strictEqual(withAudit.picks[0].units, '1.25u');
      assert.strictEqual(withAudit.picks[0].coverProb, without.picks[0].coverProb);
      assert.strictEqual(withAudit.summary.totalUnits, without.summary.totalUnits);
      assert.strictEqual(withAudit.summary.totalUnits, '1.25u');
      assert.strictEqual(withAudit.model, without.model);
      assert.strictEqual(withAudit.audit.configHash, 'abc');
      assert.strictEqual(withAudit.audit.runId, 'card-run');
      assert.ok(withAudit.audit.count >= 1);
      assert.ok(withAudit.audit.byProvider['odds-api'] >= 1);
      assert.ok(Array.isArray(withAudit.audit.models));
      assert.ok(Array.isArray(withAudit.audit.errors));
      assert.ok(!JSON.stringify(withAudit).includes(SECRET));
      assert.ok(!JSON.stringify(withAudit).includes('apiKey=SECRET'));
    }

    console.log('test-omega-audit-log: ok');
  } finally {
    global.fetch = prevFetch;
    store.storeJson = origStoreJson;
    if (prevKey == null) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prevKey;
    if (prevModel == null) delete process.env.XAI_MODEL; else process.env.XAI_MODEL = prevModel;
    if (prevFallback == null) delete process.env.XAI_FALLBACK_MODELS; else process.env.XAI_FALLBACK_MODELS = prevFallback;
    if (prevNoWrite == null) delete process.env.OMEGA_REPLAY_NO_WRITE; else process.env.OMEGA_REPLAY_NO_WRITE = prevNoWrite;
    if (prevAuditFile == null) delete process.env.OMEGA_AUDIT_FILE; else process.env.OMEGA_AUDIT_FILE = prevAuditFile;
    try { fs.unlinkSync(auditFile); } catch (_) { /* already gone */ }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
