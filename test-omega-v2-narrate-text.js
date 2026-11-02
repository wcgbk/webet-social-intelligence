'use strict';
// v2 narration is text only: picks/legs/stakes/prices identical with narration on vs off.
const assert = require('assert');
const fs = require('fs');
const { narrateTextOnly } = require('./netlify/functions/lib/omega-vnext/narrate_text');

const picks = [
  { pick: 'Orlando Magic ML', matchup: 'Magic @ Hornets', odds: '-150', units: '1u', grade: 'A', rating: 'a', coreReasoning: '' },
  { pick: 'OKC Thunder ML', matchup: 'Thunder @ Grizzlies', odds: '-180', units: '1.5u', grade: 'B+', coreReasoning: '' },
];
const parlayLegs = [{ combinedOdds: '+260', units: '0.5u', legs: [
  { pick: 'Orlando Magic ML', matchup: 'Magic @ Hornets', odds: '-150', coreReasoning: '' },
  { pick: 'Over 220.5', matchup: 'Jazz @ Kings', odds: '-110', coreReasoning: '' },
] }];
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'coreReasoning' ? undefined : v)));

// Hostile narrator: vetoes Thunder, cuts Magic units, rewrites odds, reorders, drops a leg.
const hostile = async ({ picks: ps, parlayLegs: pls }) => ({
  picks: [{ ...ps[0], units: '0.5u', odds: '+999', coreReasoning: 'Magic defend at an elite rate and Charlotte is missing its starting center tonight.' }],
  parlayLegs: [{ ...pls[0], units: '9u', legs: [
    { ...pls[0].legs[0], coreReasoning: 'Magic leg write-up.' },
    { ...pls[0].legs[1], coreReasoning: 'Jazz-Kings pace leans over.' },
  ] }],
  insights: 'Two NBA favorites and a small parlay.',
  claudeVerified: true,
  rejections: [{ matchup: 'Thunder @ Grizzlies', side: 'OKC Thunder ML', reason: 'news veto' }],
});

(async () => {
  const before = JSON.parse(JSON.stringify({ picks, parlayLegs }));
  const on = await narrateTextOnly({ picks, parlayLegs, dateFormatted: 'Nov 2', narrateFn: hostile });
  // Inputs not mutated
  assert.deepStrictEqual({ picks, parlayLegs }, before);
  // Card identical apart from text
  assert.deepStrictEqual(strip(on.picks), strip(picks));
  assert.deepStrictEqual(strip(on.parlayLegs), strip(parlayLegs));
  // Veto did not remove Thunder; got non-empty template text, not the veto reason
  assert.strictEqual(on.picks.length, 2);
  assert.ok(on.picks[1].coreReasoning.length > 0 && on.picks[1].coreReasoning !== 'news veto');
  // Text filled
  assert.ok(/Charlotte/.test(on.picks[0].coreReasoning));
  assert.strictEqual(on.parlayLegs[0].legs[1].coreReasoning, 'Jazz-Kings pace leans over.');
  assert.strictEqual(on.insights, 'Two NBA favorites and a small parlay.');
  assert.strictEqual(on.claudeVerified, true);
  assert.strictEqual(on.narration.vetoesIgnored, 1);

  // Narration off (failure) => same card, empty text, never throws
  const off = await narrateTextOnly({ picks, parlayLegs, narrateFn: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(off.picks, picks);
  assert.deepStrictEqual(off.parlayLegs, parlayLegs);
  assert.strictEqual(off.insights, '');
  assert.strictEqual(off.claudeVerified, false);
  assert.deepStrictEqual(strip(on.picks), strip(off.picks));
  assert.deepStrictEqual(strip(on.parlayLegs), strip(off.parlayLegs));

  // Timeout => publish anyway
  const slow = await narrateTextOnly({ picks, parlayLegs, timeoutMs: 50, narrateFn: () => new Promise(() => {}) });
  assert.deepStrictEqual(slow.picks, picks);
  assert.match(slow.narration.status, /timeout/);

  // Wiring: veto/re-publish and caps stay on !usePipelineV2 only
  const src = fs.readFileSync('./netlify/functions/lib/omega-vnext/index.js', 'utf8');
  assert.ok(/if \(usePipelineV2\) \{[\s\S]*?narrateTextOnly\([\s\S]*?\} else if \(!skipNarrate\) \{[\s\S]*?narr\.rejections\.length/.test(src));
  assert.ok(/if \(!usePipelineV2\) \{\s*const capped = applyDailyUnitCap/.test(src));
  console.log('test-omega-v2-narrate-text: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
