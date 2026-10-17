'use strict';
// Card copy must not claim the rest of the slate is empty, and must not
// claim injuries or lineups are already in the price. The sanitizer drops
// those sentences. Fewer than two sentences left uses the template.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitizeCardCopy, buildCardFallbackCopy } = require('./netlify/functions/lib/omega-vnext/narrate');

const narrateSrc = fs.readFileSync(
  path.join(__dirname, 'netlify/functions/lib/omega-vnext/narrate.js'),
  'utf8',
);

assert.ok(narrateSrc.includes('Never say other sports are absent'));
assert.ok(narrateSrc.includes('no other sports appear'));
assert.ok(narrateSrc.includes('Only say the card\'s picks are in sport X'));
assert.ok(narrateSrc.includes('Never say injuries, lineups, goalies, or weather are priced in'));
assert.ok(!/priced the quarterback injury/i.test(narrateSrc));

function sentences(text) {
  return String(text || '').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

const ABSENT = 'No other sports appear on the locked slate.';
const PRICED = 'WeBetAI is on totals and spreads that already price in the usual injury and lineup variables.';
const CLEAN_A = "The card's picks are in the NHL.";
const CLEAN_B = 'WeBetAI locked three sides because each win rate is above the posted price.';
const CLEAN_C = 'Stakes stay inside the daily card because a good slate is a set of prices.';

const picks = [{ sport: 'NHL', pick: 'Avalanche ML', side: 'Avalanche', matchup: 'Penguins @ Avalanche' }];
const template = buildCardFallbackCopy({ picks, dateFormatted: 'October 17, 2026' });
assert.ok(sentences(template.edgeSummary).length >= 2);
assert.ok(sentences(template.insights).length >= 2);
assert.ok(!/no other sports/i.test(template.edgeSummary));
assert.ok(!/no other sports/i.test(template.insights));
assert.ok(!/already price/i.test(template.edgeSummary));
assert.ok(!/already price/i.test(template.insights));
assert.ok(!/lineup variables/i.test(template.edgeSummary + template.insights));

// Both exact bad sentences, nothing else: fall back to the template.
const onlyBad = `${ABSENT} ${PRICED}`;
assert.strictEqual(sanitizeCardCopy(onlyBad, template.edgeSummary), template.edgeSummary);
assert.ok(!/no other sports/i.test(sanitizeCardCopy(onlyBad, template.insights)));
assert.ok(!/already price/i.test(sanitizeCardCopy(onlyBad, template.insights)));
assert.ok(!/lineup variables/i.test(sanitizeCardCopy(onlyBad, template.insights)));

// Bad sentences are removed. Two clean sentences stay, and the fallback is not used.
const mixed = [CLEAN_A, ABSENT, CLEAN_B, PRICED, CLEAN_C].join(' ');
const cleaned = sanitizeCardCopy(mixed, 'SHOULD NOT USE. Fallback stays unused.');
assert.ok(!/no other sports/i.test(cleaned));
assert.ok(!/already price/i.test(cleaned));
assert.ok(!/lineup variables/i.test(cleaned));
assert.ok(!/SHOULD NOT USE/.test(cleaned));
assert.ok(cleaned.includes(CLEAN_A));
assert.ok(cleaned.includes(CLEAN_B));
assert.ok(cleaned.includes(CLEAN_C));
assert.ok(sentences(cleaned).length >= 2);

// Case-insensitive, including the other three patterns.
const cased = [
  'NO OTHER SPORTS are missing from this board.',
  'These totals already priced in the usual news.',
  'The number prices in the usual injury report.',
  'The book used injuries and lineup variables.',
  CLEAN_A,
  CLEAN_B,
].join(' ');
const casedOut = sanitizeCardCopy(cased, template.edgeSummary);
assert.strictEqual(casedOut, `${CLEAN_A} ${CLEAN_B}`);
assert.ok(!/no other sports/i.test(casedOut));
assert.ok(!/already priced in/i.test(casedOut));
assert.ok(!/prices in the usual injur/i.test(casedOut));
assert.ok(!/injuries and lineup variables/i.test(casedOut));

// One bad sentence and one clean sentence is under two. Use the template.
const thin = sanitizeCardCopy(`${ABSENT} ${CLEAN_A}`, template.insights);
assert.strictEqual(thin, template.insights);
assert.ok(sentences(thin).length >= 2);

// Clean copy is unchanged, including a template that already has two sentences.
const clean = `${CLEAN_A} ${CLEAN_B}`;
assert.strictEqual(sanitizeCardCopy(clean, template.edgeSummary), clean);
assert.strictEqual(sanitizeCardCopy(template.edgeSummary, null), template.edgeSummary);
assert.strictEqual(sanitizeCardCopy(template.insights, null), template.insights);
