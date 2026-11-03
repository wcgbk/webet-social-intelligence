#!/usr/bin/env node
'use strict';

/**
 * Refresh math-gate fixtures from the public Omega card endpoint (stored card,
 * public trim, includes stakeUsd). No token. No Odds API.
 *
 *   node tools/omega-v2/refresh-fixtures.js 2026-11-04 [2026-11-05 ...]
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.OMEGA_CARD_URL || 'https://webetsocial.com/.netlify/functions/get-picks-omega';
const OUT = path.join(__dirname, '../../test/fixtures/omega-v2-cards');

async function main() {
  const dates = process.argv.slice(2).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!dates.length) throw new Error('usage: refresh-fixtures.js YYYY-MM-DD [...]');
  fs.mkdirSync(OUT, { recursive: true });
  for (const date of dates) {
    const res = await fetch(`${BASE}?date=${date}`);
    if (!res.ok) throw new Error(`${date}: HTTP ${res.status}`);
    const card = await res.json();
    if (card.date !== date || !Array.isArray(card.picks) || !card.picks.length) {
      console.log(`${date} skipped: no stored card with picks`);
      continue;
    }
    const missing = card.picks.concat(card.parlayLegs || []).filter((r) => r.stakeUsd == null).length;
    fs.writeFileSync(path.join(OUT, `card-${date}.json`), `${JSON.stringify(card)}\n`);
    console.log(`${date} saved${missing ? ` (${missing} rows without stakeUsd)` : ''}`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
