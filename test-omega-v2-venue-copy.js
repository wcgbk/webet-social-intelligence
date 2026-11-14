'use strict';
// Venue facts go to the narrator. A home-card claim that is not true of every
// pick is replaced with the template. Three real home picks keep the sentence.
const assert = require('assert');
const narrate = require('./netlify/functions/lib/omega-vnext/narrate');
const integrity = require('./netlify/functions/lib/omega-vnext/card_integrity');

function row(partial) {
  return {
    sport: 'NCAAF',
    betType: partial.betType || 'Moneyline',
    market: partial.market || partial.betType || 'Moneyline',
    ...partial,
  };
}

const south = row({
  pick: 'South Alabama Jaguars -3.5',
  betType: 'Spread',
  market: 'Spread',
  matchup: 'Troy Trojans @ South Alabama Jaguars',
  homeTeam: 'South Alabama Jaguars',
  awayTeam: 'Troy Trojans',
});
const alabamaAway = row({
  pick: 'Alabama Crimson Tide',
  matchup: 'Alabama Crimson Tide @ Vanderbilt Commodores',
  homeTeam: 'Vanderbilt Commodores',
  awayTeam: 'Alabama Crimson Tide',
});
const alabamaHome = row({
  pick: 'Alabama Crimson Tide',
  matchup: 'Vanderbilt Commodores @ Alabama Crimson Tide',
  homeTeam: 'Alabama Crimson Tide',
  awayTeam: 'Vanderbilt Commodores',
});
const virginia = row({
  pick: 'Virginia Cavaliers',
  matchup: 'California Golden Bears @ Virginia Cavaliers',
  homeTeam: 'Virginia Cavaliers',
  awayTeam: 'California Golden Bears',
});
const total = row({
  pick: 'Over 57.5',
  betType: 'Total',
  market: 'Total',
  matchup: 'Troy Trojans @ South Alabama Jaguars',
  homeTeam: 'South Alabama Jaguars',
  awayTeam: 'Troy Trojans',
});

assert.strictEqual(integrity.venueOfRow(south), 'HOME');
assert.strictEqual(integrity.venueOfRow(alabamaAway), 'AWAY');
assert.strictEqual(integrity.venueOfRow(virginia), 'HOME');
assert.strictEqual(integrity.venueOfRow(total), 'total');
assert.strictEqual(integrity.venueOfRow({ pick: 'Alabama Crimson Tide' }), 'neutral-unknown');

const awayRow = narrate.lockedRow(alabamaAway, 1, 'straight');
const homeRow = narrate.lockedRow(south, 0, 'straight');
const totalRow = narrate.lockedRow(total, 2, 'straight');
assert.strictEqual(awayRow.venue, 'AWAY');
assert.strictEqual(homeRow.venue, 'HOME');
assert.strictEqual(totalRow.venue, 'total');
assert.ok(/never generalize venue/i.test(narrate.VENUE_RULE));
const facts = narrate.formatVenueFacts([south, alabamaAway, virginia]);
assert.ok(facts.indexOf('South Alabama Jaguars -3.5: HOME') !== -1);
assert.ok(facts.indexOf('Alabama Crimson Tide: AWAY') !== -1);
assert.ok(facts.indexOf('Virginia Cavaliers: HOME') !== -1);
assert.ok(/do not generalize venue/i.test(facts));
const shared = narrate.formatVenueFacts([south, alabamaHome, virginia]);
assert.ok(/Every pick shares venue HOME/.test(shared));

const badText = 'A normal fan reading this card should understand it as three home-team plays.';
const keptSummary = 'Jaguars, Tide, and Cavaliers are the plays on this card.';

function proseCard(list) {
  return {
    dateFormatted: 'Saturday, November 14, 2026',
    picks: list,
    parlayLegs: [],
    edgeSummary: keptSummary,
    insights: badText,
  };
}

const mixed = proseCard([south, alabamaAway, virginia]);
const mixedProblems = integrity.venueClaimProblems(mixed);
assert.ok(mixedProblems.length > 0, 'away Alabama plus a home-team claim is a venue miss');
const rebuilt = integrity.applyVenueCopy(mixed);
assert.strictEqual(rebuilt.changed, true);
const template = narrate.buildCardFallbackCopy({
  picks: [south, alabamaAway, virginia],
  dateFormatted: 'Saturday, November 14, 2026',
});
assert.strictEqual(rebuilt.card.edgeSummary, template.edgeSummary);
assert.strictEqual(rebuilt.card.insights, template.insights);
assert.ok(!/home-team/i.test(`${rebuilt.card.edgeSummary} ${rebuilt.card.insights}`));

const homes = proseCard([south, alabamaHome, virginia]);
assert.deepStrictEqual(integrity.venueClaimProblems(homes), []);
const kept = integrity.applyVenueCopy(homes);
assert.strictEqual(kept.changed, false);
assert.strictEqual(kept.card.insights, badText);
assert.strictEqual(kept.card.edgeSummary, keptSummary);

const viaRefresh = integrity.refreshCardText(proseCard([south, alabamaHome, virginia]));
assert.strictEqual(viaRefresh.card.insights, badText);
assert.ok(!viaRefresh.problems.some((p) => /venue claim/.test(p)));

const onPrompt = narrate.narratorUserPrompt({
  dateFormatted: 'Saturday, November 14, 2026',
  lockedStraights: [homeRow, awayRow],
  lockedLegs: [],
});
assert.ok(onPrompt.indexOf('VENUE FACTS') !== -1);
assert.ok(onPrompt.indexOf('"venue": "HOME"') !== -1);
assert.ok(onPrompt.indexOf('"venue": "AWAY"') !== -1);
assert.ok(narrate.narratorSystemPrompt().indexOf(narrate.VENUE_RULE) !== -1);

const { copyVenueCheckEnabled } = require('./netlify/functions/lib/default_on_flag');
assert.strictEqual(copyVenueCheckEnabled(), true);
for (const value of ['off', '0', 'false']) {
  const env = { OMEGA_COPY_VENUE_CHECK: value };
  assert.strictEqual(copyVenueCheckEnabled(env), false, value);
  const rowOff = narrate.lockedRow(alabamaAway, 1, 'straight', env);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rowOff, 'venue'), false, value);
  const prompt = narrate.narratorUserPrompt({
    dateFormatted: 'Saturday, November 14, 2026',
    lockedStraights: [narrate.lockedRow(south, 0, 'straight', env), rowOff],
    lockedLegs: [narrate.lockedRow(virginia, 0, 'parlay', env)],
    env,
  });
  assert.strictEqual(prompt.indexOf('VENUE FACTS'), -1, value);
  assert.strictEqual(prompt.indexOf('"venue"'), -1, value);
  assert.strictEqual(narrate.narratorSystemPrompt(env).indexOf(narrate.VENUE_RULE), -1, value);
  const mixedOff = proseCard([south, alabamaAway, virginia]);
  const applied = integrity.applyVenueCopy(mixedOff, env);
  assert.strictEqual(applied.changed, false, value);
  assert.strictEqual(applied.card.insights, badText, value);
  assert.strictEqual(applied.card.edgeSummary, keptSummary, value);
  const refreshed = integrity.refreshCardText(proseCard([south, alabamaAway, virginia]), env);
  assert.strictEqual(refreshed.card.insights, badText, value);
  assert.strictEqual(refreshed.card.edgeSummary, keptSummary, value);
  assert.ok(!refreshed.problems.some((problem) => /venue claim/.test(problem)), value);
}

console.log('PASS test-omega-v2-venue-copy');
