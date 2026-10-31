#!/usr/bin/env node
'use strict';

/**
 * No-write card from the stored odds-master board.
 * Does not call The Odds API. Does not write blobs, picks, or prod state.
 * Loads a Netlify token only to read cached boards. Never prints the token.
 *
 *   node tools/omega-v2/dryrun-card.js
 *   node tools/omega-v2/dryrun-card.js --date 2026-10-30,2026-10-31 --out /workspace/dryrun-card.json
 */

const fs = require('fs');

process.env.OMEGA_REPLAY_NO_WRITE = '1';
process.env.OMEGA_X_AUTOPOST = 'false';
delete process.env.ODDS_API_KEY;

function loadNetlifyToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return 'env';
  const path = '/home/box/.config/netlify/config.json';
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); } catch (_) { return 'missing-file'; }
  let json;
  try { json = JSON.parse(raw); } catch (_) { return 'bad-json'; }
  const users = json && json.users;
  if (!users || typeof users !== 'object') return 'no-users';
  for (const user of Object.values(users)) {
    const token = user && user.auth && user.auth.token;
    if (typeof token === 'string' && token.length > 0) {
      process.env.NETLIFY_AUTH_TOKEN = token;
      return 'config';
    }
  }
  return 'no-token';
}

const tokenSource = loadNetlifyToken();

const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : (url && url.url) || '';
  if (/the-odds-api\.com/i.test(String(href))) {
    throw new Error('paid odds pull blocked');
  }
  return realFetch(url, init);
};

const { generateOmegaVnext } = require('../../netlify/functions/lib/omega-vnext');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function redact(text) {
  return String(text || '')
    .replace(/apiKey=[^&\s]*/gi, 'apiKey=REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/https:\/\/[^\s)]+/gi, 'https://REDACTED')
    .replace(/[A-Za-z0-9_\-]{20,}/g, (m) => (m.length > 40 ? '[redacted]' : m));
}

/** UTC millis for 10:00 America/New_York on dateISO. */
function tenAmEtMs(dateISO) {
  for (const offset of ['-04:00', '-05:00']) {
    const ms = Date.parse(`${dateISO}T10:00:00${offset}`);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type).value;
    const ymd = `${get('year')}-${get('month')}-${get('day')}`;
    if (ymd === dateISO && get('hour') === '10' && get('minute') === '00') return ms;
  }
  throw new Error(`could not resolve 10:00 ET for ${dateISO}`);
}

function legSlim(leg) {
  return {
    sport: leg.sport || null,
    matchup: leg.matchup || null,
    pick: leg.pick || leg.side || null,
    market: leg.betType || leg.market || null,
    odds: leg.odds != null ? leg.odds : null,
    units: leg.units != null ? leg.units : null,
    unitsNum: leg.unitsNum != null ? leg.unitsNum : null,
    ev: leg.ev != null ? leg.ev : null,
    edgePct: leg.edgePct != null ? leg.edgePct : null,
    edgeNovig: leg.edgeNovig != null ? leg.edgeNovig : null,
    pCal: leg.pCal != null ? leg.pCal : null,
    pMkt: leg.pMkt != null ? leg.pMkt : null,
    book: leg.book || null,
  };
}

function straightSlim(p) {
  return {
    sport: p.sport || null,
    matchup: p.matchup || null,
    pick: p.pick || null,
    market: p.betType || p.market || null,
    odds: p.odds != null ? p.odds : null,
    units: p.units || null,
    unitsNum: p.unitsNum != null ? p.unitsNum : null,
    ev: p.ev != null ? p.ev : null,
    edgePct: p.edgePct != null ? p.edgePct : null,
    edgeNovig: p.edgeNovig != null ? p.edgeNovig : null,
    pCal: p.pCal != null ? p.pCal : null,
    pMkt: p.pMkt != null ? p.pMkt : null,
    rating: p.rating || null,
  };
}

function ticketSlim(card) {
  const ticket = card && card.parlayLegs && card.parlayLegs[0];
  if (!ticket) return null;
  return {
    type: ticket.type || null,
    units: ticket.units || null,
    unitsNum: ticket.unitsNum != null ? ticket.unitsNum : null,
    ev: ticket.ev != null ? ticket.ev : null,
    combinedOdds: ticket.combinedOdds || null,
    correlationFactor: ticket.correlationFactor != null ? ticket.correlationFactor : null,
    correlationHaircut: ticket.correlationHaircut || null,
    parlayStake: ticket.parlayStake || null,
    legs: (ticket.legs || []).map(legSlim),
  };
}

function cardSlim(card) {
  if (!card) return null;
  const pipe = card.pipelineV2 && typeof card.pipelineV2 === 'object' ? card.pipelineV2 : null;
  return {
    model: card.model || null,
    engine: card.engine || null,
    straightCount: (card.picks || []).length,
    straights: (card.picks || []).map(straightSlim),
    parlay: ticketSlim(card),
    parlaySkips: (card.rejections || [])
      .filter((row) => row && (row.market === 'Parlay' || row.reason === 'edge-below-uncertainty-floor' || /kent state|warriors|bulls/i.test(`${row.side || ''} ${row.matchup || ''}`)))
      .slice(0, 40)
      .map((row) => ({
        matchup: row.matchup || null,
        side: row.side || row.pick || null,
        market: row.market || null,
        reason: row.reason || null,
        edgeNovig: row.edgeNovig != null ? row.edgeNovig : null,
        pCal: row.pCal != null ? row.pCal : null,
        pMkt: row.pMkt != null ? row.pMkt : null,
        odds: row.odds != null ? row.odds : null,
      })),
    v1WouldParlay: card.v1WouldParlay === true,
    parlaySource: pipe ? pipe.parlaySource : null,
    leakageChecked: pipe ? pipe.leakageChecked === true : null,
    morningBoard: pipe ? pipe.morningBoard : null,
    captureHealth: card.captureHealth ? {
      ok: card.captureHealth.ok,
      hardFail: card.captureHealth.hardFail,
      usableSnapCount: card.captureHealth.usableSnapCount,
      missingSlotsET: card.captureHealth.missingSlotsET || null,
      warning: card.captureHealth.warning || null,
    } : null,
  };
}

async function runOne(date, pipelineV2) {
  const pregameAsOfMs = tenAmEtMs(date);
  try {
    const card = await generateOmegaVnext({
      date,
      dryRun: true,
      skipNarrate: true,
      pipelineV2,
      pregameAsOfMs,
    });
    return { error: null, pregameAsOf: new Date(pregameAsOfMs).toISOString(), card: cardSlim(card) };
  } catch (err) {
    return {
      error: redact(err && err.message ? err.message : err),
      code: err && err.code ? err.code : null,
      pregameAsOf: new Date(pregameAsOfMs).toISOString(),
      card: null,
    };
  }
}

(async () => {
  const dates = argValue('--date', '2026-10-30,2026-10-31').split(',').map((s) => s.trim()).filter(Boolean);
  const outPath = argValue('--out', '/workspace/dryrun-card.json');
  console.error(`[omega-v2-dryrun] tokenSource=${tokenSource} noWrite=1 oddsApi=blocked dates=${dates.join(',')}`);
  const days = [];
  for (const date of dates) {
    const v2 = await runOne(date, true);
    const v1 = await runOne(date, false);
    const v1RulesParlay = !!(v1.card && v1.card.parlay);
    const v2HasParlay = !!(v2.card && v2.card.parlay);
    const v1WouldParlay = v1RulesParlay || !!(v2.card && v2.card.v1WouldParlay);
    days.push({
      date,
      v1WouldParlay,
      v1RulesParlay,
      v2HasParlay,
      parlayPreserved: !v1WouldParlay || v2HasParlay,
      v2,
      v1,
    });
    const v2s = v2.card ? v2.card.straightCount : 'err';
    const v2p = v2HasParlay ? `${v2.card.parlay.legs.length} legs ${v2.card.parlay.units}` : 'none';
    console.error(`[omega-v2-dryrun] ${date} v1Parlay=${v1RulesParlay} v2Parlay=${v2HasParlay} v2Straights=${v2s} ticket=${v2p} preserved=${!v1WouldParlay || v2HasParlay}${v2.error ? ` v2Error=${v2.error}` : ''}${v1.error ? ` v1Error=${v1.error}` : ''}`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    modelVersion: 'omega-v2-sharp-2026-10-30',
    dryRun: true,
    wroteProd: false,
    oddsApiCalled: false,
    tokenSource,
    days,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[omega-v2-dryrun] wrote ${outPath}`);
})().catch((err) => {
  console.error(redact(err && err.stack ? err.stack : err));
  process.exit(1);
});
