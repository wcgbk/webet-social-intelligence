'use strict';

/**
 * fix-omega-card-1103 — one-shot correction for the stored 2026-11-03 card.
 * POST /api/fix-omega-card-1103?key=PICKS_SECRET_KEY
 * Body: { date, dryRun }  dryRun defaults to true. date must be 2026-11-03.
 *
 * San Jose Sharks +1.5 (Sharks @ Kings, -180 DK, 0.25u) was listed a day
 * early. The game is the night of 2026-11-04. This removes that straight
 * from the 11/3 card, turns parlayLegs[0] into the Canucks +1.5 and
 * Oilers +1.5 ticket, and recomputes the parlay price from those two
 * American odds. It does not add the side to 11/4.
 *
 * get-results-omega grades picks[] and parlayLegs[0].legs from ESPN on each
 * cold read, then serves results-omega-cache-v9-kpi1030 until the KPI TTL.
 * report-tracking reads results-omega-cache-v10-parlay-legs. track-clv-omega
 * rebuilds clv-{date} from the card, but mergeCandidateRows keeps an old
 * published candidate, and the morning sweep writes results back onto the
 * picks it loaded. Applying this fix deletes those cache keys and drops
 * Sharks +1.5 rows from the 11/3 CLV / candidate settlement blobs.
 *
 * Live cards are read with readPicksLocated: getStore(BLOB_STORE), then the
 * REST picks-{date} blob. The write goes back to that same place (the SDK
 * store's setJSON, or writePicksRaw). latest-date and picks-dates stay put.
 * Idempotent: a card that is already corrected, with no Sharks settlement
 * row and no Sharks results cache, is a no-op.
 */

const { SITE_ID, BLOB_STORE } = require('./lib/omega-vnext/config');
const { readPicksLocated, writePicksRaw } = require('./lib/omega-vnext/store');
const { americanToDecimal, decimalToAmerican, formatAmerican } = require('./lib/omega-vnext/odds_math');

const DATE = '2026-11-03';
const CORRECTION_NOTE = 'San Jose Sharks +1.5 (Sharks @ Kings, -180 DK, 0.25u $38) was listed a day early and is removed from 2026-11-03. The game is the night of 2026-11-04. It is not pending and is not counted in the 11/3 record, wagered, profit, ROI, or accuracy. The parlay is a 2-leg of Canucks +1.5 and Oilers +1.5.';

/** Same keys get-results-omega and tracking-report persist. */
const CACHE_KEYS = Object.freeze([
  'results-omega-cache-v9-kpi1030',
  'results-omega-cache-v10-parlay-legs',
]);

/** Per-pick settlement blobs for this date. Morning-board slates are not these. */
const SETTLEMENT_KEYS = Object.freeze([
  `clv-${DATE}`,
  `clv-candidates-${DATE}`,
  `clv-candidates-v2/${DATE}`,
  `omega-candidates/${DATE}`,
]);

const ARRAY_FIELDS = ['picks', 'parlayLegs', 'candidates', 'sides', 'rows'];
const CARD_POOLS = ['chosen', 'parlayPool', 'candidateTable'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  return JSON.parse(event.body);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Same display as assemble.formatUnitsTotal. */
function formatUnitsTotal(n) {
  const q = Math.round((Number(n) || 0) * 100) / 100;
  if (Math.abs(q - Math.round(q)) < 1e-9) return `${Math.round(q)}u`;
  const quarters = Math.round(q * 4) / 4;
  const shown = Math.abs(q - quarters) < 1e-9 ? quarters : q;
  return `${(Math.round(shown * 100) / 100).toString()}u`;
}

function labelOf(row) {
  if (!row || typeof row !== 'object') return '';
  return [row.pick, row.pickDisplay, row.side].filter((part) => part != null && part !== '').join(' ');
}

function priceOf(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.odds != null ? row.odds : (row.pickTimeOdds != null ? row.pickTimeOdds : null);
  if (typeof raw === 'number') return Number.isFinite(raw) && raw !== 0 ? raw : null;
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw).replace(/[^0-9+-]/g, ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function isPlusOneAndHalf(row) {
  const label = labelOf(row);
  if (/\+1\.5\b/.test(label)) return true;
  const line = row && (row.line != null ? row.line : row.betLine);
  return Number(line) === 1.5;
}

/** The early Sharks +1.5 @ Kings (-180 when a price is stored). */
function isSharksEarly(row) {
  if (!row || typeof row !== 'object') return false;
  const label = labelOf(row);
  const matchup = String(row.matchup || '');
  if (!/shark/i.test(label)) return false;
  if (!isPlusOneAndHalf(row)) return false;
  if (!/king/i.test(matchup)) return false;
  const price = priceOf(row);
  if (price != null && price !== -180) return false;
  return true;
}

function isCanucksLeg(row) {
  return /canuck/i.test(labelOf(row)) && isPlusOneAndHalf(row);
}

function isOilersLeg(row) {
  return /oiler/i.test(labelOf(row)) && isPlusOneAndHalf(row);
}

function pairIsTarget(legs) {
  if (!Array.isArray(legs) || legs.length !== 2) return false;
  return legs.some(isCanucksLeg) && legs.some(isOilersLeg);
}

function unitsOf(row) {
  if (!row || typeof row !== 'object') return 0;
  if (row.unitsNum != null && row.unitsNum !== '') {
    const n = Number(row.unitsNum);
    if (Number.isFinite(n)) return n;
  }
  const n = parseFloat(String(row.units == null ? '' : row.units).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseProb(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1 ? raw / 100 : raw;
  }
  const text = String(raw).trim();
  if (!text) return null;
  const n = parseFloat(text.replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (text.includes('%') || n > 1) return n / 100;
  return n;
}

function writeUnits(card, key, value) {
  if (!Object.prototype.hasOwnProperty.call(card, key)) return;
  if (typeof card[key] === 'string') card[key] = formatUnitsTotal(value);
  else card[key] = round2(value);
}

function refreshUnits(card) {
  const straight = round2((card.picks || []).reduce((sum, pick) => sum + unitsOf(pick), 0));
  const ticket = card.parlayLegs && card.parlayLegs[0];
  const parlay = round2(ticket ? unitsOf(ticket) : 0);
  writeUnits(card, 'straightUnits', straight);
  writeUnits(card, 'parlayUnits', parlay);
  writeUnits(card, 'totalUnits', round2(straight + parlay));
  if (card.summary && typeof card.summary === 'object') {
    card.summary.totalPicks = (card.picks || []).length;
    card.summary.totalStraightBets = (card.picks || []).length;
    card.summary.totalUnits = formatUnitsTotal(straight + parlay);
    card.summary.sportsCovered = [...new Set((card.picks || []).map((pick) => pick.sport).filter(Boolean))];
  }
}

function decimalFrom(leg) {
  const price = priceOf(leg);
  if (price == null) return null;
  return americanToDecimal(price);
}

/**
 * 2-leg price from the stored American odds.
 * combinedDecimal is the product at 4 decimals (the card field).
 * combinedOdds is the American integer of that decimal, with a plus sign.
 * combinedProb is the product of stored winProbability values when each leg has one.
 * units and stakeUsd are left as stored.
 */
function repriceParlay(ticket, keptIdx, originalLen) {
  const legs = ticket.legs || [];
  const decimals = legs.map(decimalFrom);
  if (decimals.some((value) => value == null)) {
    const err = new Error('2-leg parlay is missing American odds');
    err.statusCode = 422;
    throw err;
  }
  const product = decimals.reduce((acc, value) => acc * value, 1);
  ticket.combinedDecimal = +product.toFixed(4);
  ticket.combinedOdds = formatAmerican(decimalToAmerican(ticket.combinedDecimal));
  ticket.type = '2-leg';
  ticket.uniqueGames = 2;
  const probs = legs.map((leg) => parseProb(leg && leg.winProbability));
  if (probs.every((value) => value != null)) {
    ticket.combinedProb = `${(probs.reduce((acc, value) => acc * value, 1) * 100).toFixed(1)}%`;
  }
  if (Array.isArray(ticket.legMarkets) && ticket.legMarkets.length === originalLen && originalLen !== legs.length) {
    ticket.legMarkets = keptIdx.map((index) => ticket.legMarkets[index]);
  } else if (!Array.isArray(ticket.legMarkets) || ticket.legMarkets.length !== legs.length) {
    ticket.legMarkets = legs.map((leg) => leg.betType || leg.market || 'Spread');
  }
}

function cardInScope(card) {
  const picks = Array.isArray(card.picks) ? card.picks : [];
  const ticket = card.parlayLegs && card.parlayLegs[0];
  const legs = ticket && Array.isArray(ticket.legs) ? ticket.legs : [];
  if (picks.some(isSharksEarly) || legs.some(isSharksEarly)) return true;
  if (pairIsTarget(legs)) return true;
  for (const field of CARD_POOLS) {
    if (Array.isArray(card[field]) && card[field].some(isSharksEarly)) return true;
  }
  return typeof card.correctionNote === 'string' && /sharks \+1\.5/i.test(card.correctionNote);
}

function applyCardFix(card) {
  if (!cardInScope(card)) return { card, changed: false };
  const next = JSON.parse(JSON.stringify(card));
  next.picks = (Array.isArray(next.picks) ? next.picks : []).filter((pick) => !isSharksEarly(pick));
  for (const field of CARD_POOLS) {
    if (!Array.isArray(next[field])) continue;
    next[field] = next[field].filter((row) => !isSharksEarly(row));
  }
  const ticket = next.parlayLegs && next.parlayLegs[0];
  if (ticket && Array.isArray(ticket.legs)) {
    const originalLen = ticket.legs.length;
    const keptIdx = [];
    const kept = [];
    ticket.legs.forEach((leg, index) => {
      if (isSharksEarly(leg)) return;
      keptIdx.push(index);
      kept.push(leg);
    });
    ticket.legs = kept;
    if (pairIsTarget(kept)) repriceParlay(ticket, keptIdx, originalLen);
  }
  refreshUnits(next);
  if (typeof next.edgeSummary === 'string' && next.picks.length === 2) {
    next.edgeSummary = next.edgeSummary.replace(/\b3 straights\b/g, '2 straights');
  }
  next.correctionNote = CORRECTION_NOTE;
  const changed = JSON.stringify(next) !== JSON.stringify(card);
  return { card: changed ? next : card, changed };
}

function view(card) {
  const ticket = card && Array.isArray(card.parlayLegs) ? card.parlayLegs[0] : null;
  const names = (rows) => (Array.isArray(rows) ? rows.filter(isSharksEarly).map((row) => row.pick || row.side || null) : []);
  return {
    picks: (card && card.picks || []).map((pick) => ({
      pick: pick.pick,
      matchup: pick.matchup,
      odds: pick.odds,
      units: pick.units,
      stakeUsd: pick.stakeUsd,
      book: pick.book,
    })),
    parlay: ticket ? {
      type: ticket.type,
      units: ticket.units,
      stakeUsd: ticket.stakeUsd,
      combinedDecimal: ticket.combinedDecimal,
      combinedOdds: ticket.combinedOdds,
      combinedProb: ticket.combinedProb,
      uniqueGames: ticket.uniqueGames,
      legMarkets: ticket.legMarkets,
      legs: (ticket.legs || []).map((leg) => ({
        pick: leg.pick,
        odds: leg.odds,
        book: leg.book,
        winProbability: leg.winProbability,
      })),
    } : null,
    straightUnits: card ? card.straightUnits : null,
    parlayUnits: card ? card.parlayUnits : null,
    totalUnits: card ? card.totalUnits : null,
    summary: card && card.summary ? {
      totalPicks: card.summary.totalPicks,
      totalStraightBets: card.summary.totalStraightBets,
      totalUnits: card.summary.totalUnits,
      sportsCovered: card.summary.sportsCovered,
    } : null,
    edgeSummary: card ? (card.edgeSummary || null) : null,
    correctionNote: card ? (card.correctionNote || null) : null,
    sharksInPools: {
      chosen: names(card && card.chosen),
      parlayPool: names(card && card.parlayPool),
      candidateTable: names(card && card.candidateTable),
    },
  };
}

function changedFields(before, after) {
  const left = {};
  const right = {};
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      left[key] = before[key];
      right[key] = after[key];
    }
  }
  return { before: left, after: right };
}

function cacheListsSharks(doc) {
  const days = doc && Array.isArray(doc.days) ? doc.days : [];
  for (const day of days) {
    if (!day || (day.date && day.date !== DATE)) continue;
    const picks = Array.isArray(day.picks) ? day.picks : [];
    if (picks.some(isSharksEarly)) return true;
  }
  return false;
}

function refreshClvScalars(blob) {
  const picks = Array.isArray(blob.picks) ? blob.picks : [];
  if (Object.prototype.hasOwnProperty.call(blob, 'totalPicks')) blob.totalPicks = picks.length;
  const hasSettle = ['wins', 'losses', 'pushes', 'totalProfit', 'settled', 'pending'].some((key) => (
    Object.prototype.hasOwnProperty.call(blob, key)
  ));
  if (hasSettle) {
    const settled = picks.filter((pick) => pick.result && pick.result !== 'pending');
    blob.wins = settled.filter((pick) => pick.result === 'win').length;
    blob.losses = settled.filter((pick) => pick.result === 'loss').length;
    blob.pushes = settled.filter((pick) => pick.result === 'push').length;
    blob.totalProfit = settled.reduce((sum, pick) => sum + (Number(pick.profit) || 0), 0);
    blob.settled = settled.length;
    blob.pending = picks.length - settled.length;
  }
  if (Object.prototype.hasOwnProperty.call(blob, 'avgCLV') || Object.prototype.hasOwnProperty.call(blob, 'totalTracked')) {
    const valid = picks.filter((pick) => pick.clv != null);
    const avg = valid.length
      ? +(valid.reduce((sum, pick) => sum + Number(pick.clv), 0) / valid.length).toFixed(4)
      : 0;
    if (Object.prototype.hasOwnProperty.call(blob, 'avgCLV')) blob.avgCLV = avg;
    if (Object.prototype.hasOwnProperty.call(blob, 'avgCLVCents')) blob.avgCLVCents = +(avg * 100).toFixed(2);
    if (Object.prototype.hasOwnProperty.call(blob, 'picksBeatClosing')) {
      blob.picksBeatClosing = valid.filter((pick) => pick.beatClosing).length;
    }
    if (Object.prototype.hasOwnProperty.call(blob, 'totalTracked')) blob.totalTracked = valid.length;
  }
}

function scrubStored(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc, removed: 0 };
  const next = JSON.parse(JSON.stringify(doc));
  let removed = 0;
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(next[field])) continue;
    const kept = [];
    for (const row of next[field]) {
      if (isSharksEarly(row)) {
        removed += 1;
        continue;
      }
      if (row && Array.isArray(row.legs) && row.legs.some(isSharksEarly)) {
        const copy = Object.assign({}, row, { legs: row.legs.filter((leg) => !isSharksEarly(leg)) });
        removed += row.legs.length - copy.legs.length;
        kept.push(copy);
        continue;
      }
      kept.push(row);
    }
    next[field] = kept;
  }
  if (removed > 0 && Array.isArray(doc.picks)) refreshClvScalars(next);
  return { doc: next, removed };
}

async function restBlob(key, method, body) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const err = new Error('NETLIFY_AUTH_TOKEN missing');
    err.statusCode = 500;
    throw err;
  }
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${BLOB_STORE}/${key}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body != null) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

function keyStoreFromLocated(located) {
  const sdk = located && located.via === 'sdk' ? located.store : null;
  if (sdk && typeof sdk.get === 'function') return sdk;
  return {
    async get(key) {
      const resp = await restBlob(key, 'GET');
      if (!resp.ok) return null;
      return resp.json();
    },
    async setJSON(key, data) {
      const resp = await restBlob(key, 'PUT', data);
      if (!resp.ok) throw new Error(`blob PUT ${key} → ${resp.status}`);
    },
    async delete(key) {
      const resp = await restBlob(key, 'DELETE');
      if (!resp.ok && resp.status !== 404) throw new Error(`blob DELETE ${key} → ${resp.status}`);
    },
  };
}

/**
 * Fake store (tests) or the live readPicks location.
 * @returns {Promise<{ card: any, write: (data: object) => Promise<void>, keys: object }>}
 */
async function loadCard(date, opts) {
  if (opts && opts.store) {
    const store = opts.store;
    if (typeof store.get !== 'function' || typeof store.setJSON !== 'function') {
      const err = new Error('edge-picks-omega store unavailable');
      err.statusCode = 500;
      throw err;
    }
    const key = `picks-${date}`;
    const card = await store.get(key, { type: 'json' });
    return {
      card,
      write: (data) => store.setJSON(key, data),
      keys: store,
    };
  }

  const located = await readPicksLocated(date);
  const via = located && located.via;
  const sdkStore = located && located.store;
  return {
    card: located ? located.card : null,
    write: async (data) => {
      if (via === 'sdk') {
        if (!sdkStore || typeof sdkStore.setJSON !== 'function') {
          const err = new Error('edge-picks-omega store unavailable');
          err.statusCode = 500;
          throw err;
        }
        await sdkStore.setJSON(`picks-${date}`, data);
        return;
      }
      await writePicksRaw(date, data);
    },
    keys: keyStoreFromLocated(located),
  };
}

async function readKey(store, key) {
  if (!store || typeof store.get !== 'function') return null;
  try {
    const value = await store.get(key, { type: 'json' });
    return value == null ? null : value;
  } catch (_) {
    return null;
  }
}

/**
 * @param {{ date: string, dryRun?: boolean, store?: { get: Function, setJSON: Function, delete?: Function } }} opts
 * dryRun defaults to true. store is optional and only for tests.
 */
async function fixOmegaCard1103(opts) {
  const date = opts && opts.date;
  const dryRun = !(opts && opts.dryRun === false);
  if (date !== DATE) {
    const err = new Error(`date must be ${DATE}`);
    err.statusCode = 400;
    throw err;
  }
  const loaded = await loadCard(date, opts);
  const card = loaded.card;
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    const err = new Error(`no card for ${date}`);
    err.statusCode = 404;
    throw err;
  }

  const beforeView = view(card);
  const applied = applyCardFix(card);
  const afterView = view(applied.card);
  const fields = changedFields(beforeView, afterView);

  const settlement = [];
  for (const key of SETTLEMENT_KEYS) {
    const existing = await readKey(loaded.keys, key);
    if (existing == null) continue;
    const scrubbed = scrubStored(existing);
    if (scrubbed.removed <= 0) continue;
    settlement.push({ key, removed: scrubbed.removed });
    if (!dryRun) await loaded.keys.setJSON(key, scrubbed.doc);
  }

  const cacheKeys = [];
  for (const key of CACHE_KEYS) {
    const existing = await readKey(loaded.keys, key);
    if (existing == null) continue;
    if (!applied.changed && !cacheListsSharks(existing)) continue;
    cacheKeys.push(key);
    if (!dryRun) {
      if (typeof loaded.keys.delete !== 'function') {
        const err = new Error('edge-picks-omega store cannot delete cache');
        err.statusCode = 500;
        throw err;
      }
      await loaded.keys.delete(key);
    }
  }

  const wroteCard = !dryRun && applied.changed;
  if (wroteCard) await loaded.write(applied.card);
  const wrote = !dryRun && (applied.changed || settlement.length > 0 || cacheKeys.length > 0);

  return {
    date,
    dryRun,
    wrote,
    alreadyCorrect: !applied.changed && settlement.length === 0 && cacheKeys.length === 0,
    before: fields.before,
    after: fields.after,
    cacheKeys,
    settlement,
  };
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!event || event.httpMethod !== 'POST') return json(405, { error: 'POST required' });

  const params = (event && event.queryStringParameters) || {};
  if (params.key !== process.env.PICKS_SECRET_KEY) return json(401, { error: 'Unauthorized' });

  let body;
  try {
    body = readBody(event);
  } catch (err) {
    return json(400, { error: 'invalid JSON' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'JSON object required' });
  if (body.date !== DATE) return json(400, { error: `date must be ${DATE}` });

  try {
    const result = await fixOmegaCard1103({
      date: body.date,
      dryRun: body.dryRun,
      store: deps && deps.store,
    });
    return json(200, result);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 500;
    return json(status, { error: err.message || 'fix failed' });
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
exports.fixOmegaCard1103 = fixOmegaCard1103;
exports.isSharksEarly = isSharksEarly;
exports.DATE = DATE;
exports.CORRECTION_NOTE = CORRECTION_NOTE;
exports.CACHE_KEYS = CACHE_KEYS;
exports.SETTLEMENT_KEYS = SETTLEMENT_KEYS;
exports.BLOB_STORE = BLOB_STORE;
