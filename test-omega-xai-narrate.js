'use strict';
/**
 * Omega copy path talks to api.x.ai. Mocked fetch only. No live key.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { xaiChat, GROK_MODEL, GROK_FALLBACK_MODELS, resolveModelChain, XAI_CHAT_URL, messageText } = require('./netlify/functions/lib/xai-chat');
const narrate = require('./netlify/functions/lib/omega-vnext/narrate');
const memo = require('./netlify/functions/lib/omega-vnext/fetch_memo');
const verify = require('./netlify/functions/verify-picks-omega');

const narrateSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/narrate.js'), 'utf8');
const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
const helperSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/xai-chat.js'), 'utf8');

assert.strictEqual(GROK_MODEL, 'grok-4.3');
assert.deepStrictEqual(GROK_FALLBACK_MODELS, [
  'grok-4-1-fast-reasoning',
  'grok-4-fast-non-reasoning',
  'grok-4.20-0309-non-reasoning',
]);
assert.ok(helperSrc.includes('XAI_MODEL'));
assert.ok(helperSrc.includes('XAI_FALLBACK_MODELS'));
assert.ok(helperSrc.includes('status === 429'));
assert.strictEqual(XAI_CHAT_URL, 'https://api.x.ai/v1/chat/completions');
assert.ok(helperSrc.includes('XAI_API_KEY'));
assert.ok(!/anthropic|claude|api\.anthropic\.com/i.test(helperSrc));
assert.ok(!/anthropic|api\.anthropic\.com|claude-sonnet/i.test(verifySrc));
assert.ok(!/claude/i.test(verifySrc));
assert.ok(indexSrc.includes('process.env.XAI_API_KEY'));
assert.ok(!/ANTHROPIC_API_KEY|api\.anthropic\.com/i.test(indexSrc));
assert.ok(/max_tokens = maxTokens/.test(helperSrc));
assert.ok(/maxTokens: NARRATIVE_MAX_TOKENS/.test(narrateSrc));
assert.ok(narrateSrc.includes('You are THE LOCK'));

function grokOk(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  };
}
function grokErr(status, body) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

function longBlurb(label) {
  return [
    `${label} is the side WeBetAI locked for this matchup.`,
    'The script favors that side at the posted number.',
    'The price is still paying relative to how this game should play.',
    'WeBetAI kept the stake measured.',
    'That is why this ticket is on the card.',
  ].join(' ');
}

(async () => {
  const prev = process.env.XAI_API_KEY;
  const prevModel = process.env.XAI_MODEL;
  const prevFallback = process.env.XAI_FALLBACK_MODELS;
  delete process.env.XAI_API_KEY;
  delete process.env.XAI_MODEL;
  delete process.env.XAI_FALLBACK_MODELS;
  assert.deepStrictEqual(resolveModelChain(), [GROK_MODEL, ...GROK_FALLBACK_MODELS]);
  const prevFetch = global.fetch;
  try {
    // ── helper request shape ──
    {
      let seen = null;
      global.fetch = async (url, init) => {
        seen = { url: String(url), init };
        return grokOk('{"ok":true}');
      };
      const text = await xaiChat({
        apiKey: 'test-xai',
        system: 'sys',
        user: 'user-prompt',
        maxTokens: 32,
        timeoutMs: 1000,
      });
      assert.strictEqual(text, '{"ok":true}');
      assert.strictEqual(seen.url, XAI_CHAT_URL);
      const headers = seen.init.headers;
      assert.strictEqual(headers.Authorization, 'Bearer test-xai');
      assert.ok(!JSON.stringify(seen).includes('x-api-key'));
      const body = JSON.parse(seen.init.body);
      assert.strictEqual(body.model, GROK_MODEL);
      assert.strictEqual(body.max_tokens, 32);
      assert.strictEqual(body.messages[0].role, 'system');
      assert.strictEqual(body.messages[0].content, 'sys');
      assert.strictEqual(body.messages[1].role, 'user');
      assert.strictEqual(body.messages[1].content, 'user-prompt');
      assert.ok(!('temperature' in body));
    }

    {
      let n = 0;
      global.fetch = async () => { n += 1; return grokErr(401, 'nope'); };
      await assert.rejects(() => xaiChat({ apiKey: 'test-xai', user: 'hi' }), /xAI HTTP 401/);
      assert.strictEqual(n, 1);
      assert.strictEqual(memo.narrateErrorShouldRetry(new Error('xAI HTTP 401: nope')), false);
    }

    {
      process.env.XAI_MODEL = 'grok-4-fast-non-reasoning';
      process.env.XAI_FALLBACK_MODELS = 'grok-4.3, grok-4-fast-non-reasoning';
      assert.deepStrictEqual(resolveModelChain(), ['grok-4-fast-non-reasoning', 'grok-4.3']);
      assert.deepStrictEqual(resolveModelChain('grok-4'), ['grok-4', 'grok-4.3', 'grok-4-fast-non-reasoning']);
      process.env.XAI_FALLBACK_MODELS = '';
      assert.deepStrictEqual(resolveModelChain(), ['grok-4-fast-non-reasoning']);
      delete process.env.XAI_MODEL;
      delete process.env.XAI_FALLBACK_MODELS;
    }

    {
      const seen = [];
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push(body.model);
        if (seen.length === 1) return grokErr(429, 'capacity');
        return grokOk('{"ok":true}');
      };
      const text = await xaiChat({ apiKey: 'test-xai', user: 'hi', timeoutMs: 5000 });
      assert.strictEqual(text, '{"ok":true}');
      assert.deepStrictEqual(seen, [GROK_MODEL, GROK_FALLBACK_MODELS[0]]);
    }

    {
      let n = 0;
      global.fetch = async () => { n += 1; return grokErr(503, 'unavailable'); };
      await assert.rejects(() => xaiChat({ apiKey: 'test-xai', user: 'hi', timeoutMs: 5000 }), /xAI HTTP 503/);
      assert.strictEqual(n, 1 + GROK_FALLBACK_MODELS.length);
    }

    {
      let n = 0;
      global.fetch = async () => { n += 1; return grokErr(400, 'bad'); };
      await assert.rejects(() => xaiChat({ apiKey: 'test-xai', user: 'hi' }), /xAI HTTP 400/);
      assert.strictEqual(n, 1);
    }

    assert.strictEqual(messageText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'a\nb');

    // ── narrate success: prose, veto, unit cut, parlay leg. One call. ──
    {
      let n = 0;
      let body = null;
      global.fetch = async (url, init) => {
        n += 1;
        assert.strictEqual(String(url), XAI_CHAT_URL);
        body = JSON.parse(init.body);
        return grokOk(JSON.stringify({
          picks: [
            {
              idx: 0,
              coreReasoning: longBlurb('Under 8.5'),
              whatLoses: 'Under 8.5 loses if both lineups turn this into a slugfest.',
              dataVerified: 'Locked number and price only on this pass.',
              clvExpectation: 'WeBetAI expects the close to lean toward the under.',
              veto: false,
              unitCut: 0.5,
            },
            {
              idx: 1,
              coreReasoning: 'News veto: the starter is scratched.',
              veto: true,
            },
          ],
          parlayLegs: [{
            idx: 0,
            coreReasoning: longBlurb('Yankees ML'),
            whatLoses: 'Yankees ML loses if Boston controls the game from the first inning.',
            dataVerified: 'Locked number and price only.',
            clvExpectation: 'WeBetAI expects a quiet close around Yankees ML.',
          }],
          edgeSummary: 'WeBetAI card thesis is the under. The value sits on one number. Stakes stay disciplined. Read the blurb. Bet the locked side.',
          insights: 'Today is baseball. Confirm the starter before lock. The card is a short list. Pass if a blurb does not convince you. Tomorrow is a new board.',
        }));
      };
      const out = await narrate.narrateAndVerify({
        picks: [
          { pick: 'Under 8.5', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Total', odds: '-110', units: '1u', rating: 'a', edgePct: '4.2%' },
          { pick: 'Dodgers ML', matchup: 'LAD @ SF', sport: 'MLB', betType: 'Moneyline', odds: '-140', units: '1u', rating: 'a' },
        ],
        parlayLegs: [{ units: '0.5u', legs: [{ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '+120' }] }],
        dateFormatted: 'Sunday, October 11',
        apiKey: 'test-xai',
      });
      assert.strictEqual(n, 1);
      assert.strictEqual(body.model, GROK_MODEL);
      assert.strictEqual(body.max_tokens, 5800);
      assert.ok(body.messages[0].content.includes('You are THE LOCK'));
      assert.ok(body.messages[1].content.includes('"_contextEv"') || body.messages[1].content.includes('_contextEv'));
      assert.ok(body.messages[1].content.includes('Under 8.5'));
      assert.strictEqual(out.claudeVerified, true);
      assert.strictEqual(out.picks.length, 1);
      assert.strictEqual(out.picks[0].pick, 'Under 8.5');
      assert.strictEqual(out.picks[0].units, '0.5u');
      assert.ok(out.picks[0].coreReasoning.includes('Under 8.5'));
      assert.strictEqual(out.rejections.length, 1);
      assert.strictEqual(out.rejections[0].side, 'Dodgers ML');
      assert.ok(/scratched/.test(out.rejections[0].reason));
      assert.ok(out.parlayLegs[0].legs[0].coreReasoning.includes('Yankees ML'));
      assert.ok(out.edgeSummary.includes('WeBetAI'));
    }

    // ── 400 is one call; locked side stays; flag stays false ──
    {
      let n = 0;
      global.fetch = async () => { n += 1; return grokErr(400, 'bad request'); };
      const out = await narrate.narrateAndVerify({
        picks: [{ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '-120', units: '1u' }],
        parlayLegs: [],
        dateFormatted: 'Sunday, October 11',
        apiKey: 'test-xai',
      });
      assert.strictEqual(n, 1);
      assert.strictEqual(out.claudeVerified, false);
      assert.strictEqual(out.picks[0].pick, 'Yankees ML');
      assert.strictEqual(out.picks[0].odds, '-120');
      assert.ok(out.rejections[0].reason.includes('xAI HTTP 400'));
    }

    // ── 429 on the primary model uses the next model and still verifies ──
    {
      const seen = [];
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push(body.model);
        if (body.model === GROK_MODEL) return grokErr(429, 'capacity');
        return grokOk(JSON.stringify({
          picks: [{
            idx: 0,
            coreReasoning: longBlurb('Yankees ML'),
            whatLoses: 'Boston wins the game outright and the moneyline loses.',
            dataVerified: 'Locked number and price only on this pass.',
            clvExpectation: 'WeBetAI expects the close to lean toward the Yankees.',
            veto: false,
            unitCut: null,
          }],
          parlayLegs: [],
          edgeSummary: 'WeBetAI card thesis is the Yankees. The value sits on one price. Stakes stay disciplined. Read the blurb. Bet the locked side.',
          insights: 'Today is baseball. Confirm the starter before lock. The card is a short list. Pass if a blurb does not convince you. Tomorrow is a new board.',
        }));
      };
      const out = await narrate.narrateAndVerify({
        picks: [{ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '-120', units: '1u' }],
        parlayLegs: [],
        dateFormatted: 'Sunday, October 11',
        apiKey: 'test-xai',
      });
      assert.deepStrictEqual(seen, [GROK_MODEL, GROK_FALLBACK_MODELS[0]]);
      assert.strictEqual(out.claudeVerified, true);
      assert.ok(out.picks[0].coreReasoning.includes('Yankees ML'));
    }

    // ── 500 walks the chain, narrate retries that chain once, locked side stays ──
    {
      let n = 0;
      global.fetch = async () => { n += 1; return grokErr(500, 'unavailable'); };
      const out = await narrate.narrateAndVerify({
        picks: [{ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '-120', units: '1u' }],
        parlayLegs: [],
        dateFormatted: 'Sunday, October 11',
        apiKey: 'test-xai',
      });
      assert.strictEqual(n, resolveModelChain().length * 2);
      assert.strictEqual(out.claudeVerified, false);
      assert.strictEqual(out.picks.length, 1);
    }

    // ── missing key: no fetch ──
    {
      let n = 0;
      global.fetch = async () => { n += 1; throw new Error('should not fetch'); };
      const out = await narrate.narrateAndVerify({
        picks: [{ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '-120', units: '1u' }],
        parlayLegs: [],
        dateFormatted: 'Sunday, October 11',
        apiKey: '',
      });
      assert.strictEqual(n, 0);
      assert.strictEqual(out.claudeVerified, false);
      assert.strictEqual(out.picks[0].pick, 'Yankees ML');
    }

    // ── sharp review ──
    {
      process.env.XAI_API_KEY = 'test-xai';
      let n = 0;
      global.fetch = async (url, init) => {
        n += 1;
        assert.strictEqual(String(url), XAI_CHAT_URL);
        const body = JSON.parse(init.body);
        assert.strictEqual(body.model, GROK_MODEL);
        assert.strictEqual(body.max_tokens, 1500);
        assert.ok(body.messages[0].content.includes('elite Las Vegas handicapper'));
        assert.ok(body.messages[1].content.includes('Yankees ML'));
        return grokOk('{"verdict":"clean","confidence":80,"analysis":"Card looks solid.","pickFlags":[]}');
      };
      const review = await verify.sharpReview([
        { rating: 'a', pick: 'Yankees ML', odds: '-120', units: '1u', sport: 'MLB', winProbability: '55%', ev: '3%', coreReasoning: 'x'.repeat(80), whatLoses: 'Boston wins the game outright.' },
      ], 'Sunday, October 11');
      assert.strictEqual(n, 1);
      assert.strictEqual(review.verdict, 'clean');
      assert.strictEqual(review.confidence, 80);
    }
    {
      delete process.env.XAI_API_KEY;
      let n = 0;
      global.fetch = async () => { n += 1; throw new Error('should not fetch'); };
      const review = await verify.sharpReview([{ pick: 'Yankees ML' }], 'Sunday, October 11');
      assert.strictEqual(n, 0);
      assert.strictEqual(review.verdict, 'skip');
      assert.strictEqual(review.analysis, 'No API key for sharp review');
    }
    {
      process.env.XAI_API_KEY = 'test-xai';
      global.fetch = async () => grokErr(500, 'down');
      const review = await verify.sharpReview([{ pick: 'Yankees ML', odds: '-120', units: '1u', sport: 'MLB' }], 'Sunday, October 11');
      assert.strictEqual(review.verdict, 'skip');
      assert.strictEqual(review.analysis, 'Sharp review unavailable');
    }

    // ── straight backfill: success, HTTP 400 leaves short copy, network uses template ──
    {
      process.env.XAI_API_KEY = 'test-xai';
      const picks = [{ pick: 'Yankees ML', odds: '-120', sport: 'MLB', betType: 'Moneyline', matchup: 'BOS @ NYY', coreReasoning: 'short' }];
      global.fetch = async () => grokOk(JSON.stringify([
        { pickIndex: 1, coreReasoning: longBlurb('Yankees ML'), whatLoses: 'Boston wins the game outright and the moneyline loses.', dataVerified: 'Model-grounded edge only.', clvExpectation: 'Expect the close to lean toward the Yankees.' },
      ]));
      const nFix = await verify.backfillStraightNarratives(picks, [0]);
      assert.strictEqual(nFix, 1);
      assert.ok(picks[0].coreReasoning.includes('Yankees ML'));
      assert.ok(picks[0].whatLoses.includes('Boston'));
    }
    {
      const picks = [{ pick: 'Yankees ML', odds: '-120', sport: 'MLB', betType: 'Moneyline', matchup: 'BOS @ NYY', coreReasoning: 'short' }];
      global.fetch = async () => grokErr(400, 'bad');
      const nFix = await verify.backfillStraightNarratives(picks, [0]);
      assert.strictEqual(nFix, 0);
      assert.strictEqual(picks[0].coreReasoning, 'short');
    }
    {
      const picks = [{ pick: 'Yankees ML', odds: '-120', sport: 'MLB', betType: 'Moneyline', matchup: 'BOS @ NYY', coreReasoning: 'short' }];
      global.fetch = async () => { throw new Error('network down'); };
      const nFix = await verify.backfillStraightNarratives(picks, [0]);
      assert.ok(nFix >= 1);
      assert.ok(picks[0].coreReasoning.includes('win probability'));
      assert.ok(picks[0].coreReasoning.length >= 80);
    }

    // ── parlay leg backfill ──
    {
      const legs = [{ pick: 'Under 8.5', odds: '-110', sport: 'MLB', betType: 'Total', matchup: 'BOS @ NYY', coreReasoning: '' }];
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        assert.strictEqual(body.max_tokens, 2000);
        assert.ok(body.messages[0].content.includes('parlay legs'));
        return grokOk(JSON.stringify([
          { legIndex: 1, coreReasoning: longBlurb('Under 8.5'), whatLoses: 'Under 8.5 loses if the game turns into a slugfest.', dataVerified: 'Locked price only.', clvExpectation: 'Expect the total to drift down.' },
        ]));
      };
      const nFix = await verify.backfillParlayLegNarratives(legs, [0]);
      assert.strictEqual(nFix, 1);
      assert.ok(legs[0].coreReasoning.includes('Under 8.5'));
    }
    {
      delete process.env.XAI_API_KEY;
      let n = 0;
      global.fetch = async () => { n += 1; throw new Error('should not fetch'); };
      const legs = [{ pick: 'Under 8.5', coreReasoning: '' }];
      const nFix = await verify.backfillParlayLegNarratives(legs, [0]);
      assert.strictEqual(n, 0);
      assert.strictEqual(nFix, 0);
      assert.strictEqual(legs[0].coreReasoning, '');
    }

    console.log('PASS test-omega-xai-narrate', { model: GROK_MODEL, fallbacks: GROK_FALLBACK_MODELS });
  } finally {
    global.fetch = prevFetch;
    if (prev == null) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prev;
    if (prevModel == null) delete process.env.XAI_MODEL;
    else process.env.XAI_MODEL = prevModel;
    if (prevFallback == null) delete process.env.XAI_FALLBACK_MODELS;
    else process.env.XAI_FALLBACK_MODELS = prevFallback;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
