#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const htmlPath = path.join(__dirname, 'daily-omega/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function check(name, fn) {
  fn();
  console.log('  ok  ' + name);
}

function visibleServerDates(picksDate, pickCount, days) {
  const renderedLiveCardRow = pickCount > 0;
  return days.filter((date) => !(renderedLiveCardRow && picksDate === date));
}

function cardDateLabel(dateISO) {
  return new Date(dateISO + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

console.log('daily-omega 30-day table: do not drop yesterday on an empty leftover card');

check('source sets renderedLiveCardRow only when the live pick row is drawn', () => {
  assert.ok(html.includes('let renderedLiveCardRow = false;'));
  assert.ok(html.includes('renderedLiveCardRow = true;'));
  const trueIdx = html.indexOf('renderedLiveCardRow = true;');
  const ifIdx = html.indexOf('if (picksData && picksData.picks && picksData.picks.length > 0)');
  const trueBlockEnd = html.indexOf('// ── HISTORICAL DAYS');
  assert.ok(ifIdx >= 0 && trueIdx > ifIdx && trueIdx < trueBlockEnd);
});

check('source skips the server day only when that live row was rendered', () => {
  assert.ok(html.includes('if (renderedLiveCardRow && picksData && picksData.date === day.date) continue;'));
  assert.ok(!html.includes('if (picksData && picksData.date === day.date) continue;'));
});

check('live row is labeled with the card date, not the clock', () => {
  const section = html.slice(html.indexOf("TODAY'S ROW"), html.indexOf('// ── HISTORICAL DAYS'));
  assert.ok(section.includes("picksData.date + 'T12:00:00'"));
  assert.ok(section.includes("new Date(picksData.date + 'T12:00:00')"));
  // Clock fallback is allowed only when picksData.date is missing.
  assert.ok(section.includes('const todayDate = picksData.date'));
});

check('overnight 0-pick leftover card keeps Nov 11 and the Nov 12 placeholder', () => {
  const days = ['2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09'];
  assert.deepStrictEqual(
    visibleServerDates('2026-11-11', 0, days),
    ['2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09']
  );
});

check('a live card with picks still hides its matching server row so it is not listed twice', () => {
  const days = ['2026-11-12', '2026-11-11', '2026-11-10'];
  assert.deepStrictEqual(visibleServerDates('2026-11-12', 3, days), ['2026-11-11', '2026-11-10']);
  assert.deepStrictEqual(visibleServerDates('2026-11-11', 2, days), ['2026-11-12', '2026-11-10']);
});

check('card date label for 2026-11-11 is Nov 11', () => {
  assert.strictEqual(cardDateLabel('2026-11-11'), 'Nov 11');
  assert.strictEqual(cardDateLabel('2026-11-12'), 'Nov 12');
});

console.log('all checks passed');
