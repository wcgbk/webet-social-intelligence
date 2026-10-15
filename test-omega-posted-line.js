'use strict';

const assert = require('assert');
const { holdReason } = require('./netlify/functions/lib/omega-vnext/posted_line');

function event(home, away, favorite, spread, total) {
  const homeFav = favorite === 'home';
  return {
    competitions: [{
      competitors: [
        { homeAway: 'home', team: { displayName: home } },
        { homeAway: 'away', team: { displayName: away } },
      ],
      odds: [{
        spread,
        overUnder: total,
        homeTeamOdds: { favorite: homeFav },
        awayTeamOdds: { favorite: !homeFav },
      }],
    }],
  };
}

const { quoteFromEspnEvent } = require('./netlify/functions/lib/omega-vnext/posted_line');
const quotes = [
  quoteFromEspnEvent(event('Old Dominion Monarchs', 'Georgia Southern Eagles', 'away', 3, 45.5)),
  quoteFromEspnEvent(event('UAB Blazers', 'East Carolina Pirates', 'away', 4.5, 48.5)),
  quoteFromEspnEvent(event('Texas State Bobcats', 'Colorado State Rams', 'home', -14.5, 70.5)),
];

assert.strictEqual(holdReason({
  betType: 'Spread', pick: 'Georgia Southern Eagles -3.5', line: -3.5,
  homeTeam: 'Old Dominion Monarchs', awayTeam: 'Georgia Southern Eagles',
}, quotes), 'line-moved');

assert.strictEqual(holdReason({
  betType: 'Total', pick: 'Under 47.5', line: 47.5,
  homeTeam: 'UAB Blazers', awayTeam: 'East Carolina Pirates',
}, quotes), 'line-moved');

assert.strictEqual(holdReason({
  betType: 'Spread', pick: 'Colorado State Rams +13.5', line: 13.5,
  homeTeam: 'Texas State Bobcats', awayTeam: 'Colorado State Rams',
}, quotes), 'line-moved');

assert.strictEqual(holdReason({
  betType: 'Spread', pick: 'Colorado State Rams +14.5', line: 14.5,
  homeTeam: 'Texas State Bobcats', awayTeam: 'Colorado State Rams',
}, quotes), null);

assert.strictEqual(holdReason({
  betType: 'Spread', pick: 'Georgia Southern Eagles -3.5', line: -3.5,
  homeTeam: 'Old Dominion Monarchs', awayTeam: 'Georgia Southern Eagles',
  dataReviewFlag: { flagged: true },
}, []), 'pinnacle-sanity');

assert.strictEqual(holdReason({
  betType: 'Spread', pick: 'Colorado State Rams +13.5', line: 13.5,
  homeTeam: 'Texas State Bobcats', awayTeam: 'Colorado State Rams',
}, []), null);

console.log('test-omega-posted-line ok');
