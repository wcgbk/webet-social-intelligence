'use strict';

/**
 * 11:00 AM America/New_York card lock.
 *
 * Once the picks are set by 11am EST those are the picks for the day.
 * After that instant, a live write of picks-{date} keeps the snapshot's
 * straights and parlays (identity, price, stake, and the published numbers).
 * Grading, CLV, live scores, and verification notes on the incoming write
 * stay. OMEGA_CARD_LOCK_11AM=off (also 0, false, no) is the rollback.
 * Unset stays on. Replay, shadow, sim, and dry-run writes are not locked.
 * Snapshot key: omega-card-lock/picks-{date} in the live edge-picks-omega store.
 * The card always publishes: snapshot I/O failures are logged and never thrown.
 */

const { etLocalToUtcISO } = require('./price_lock');
const { replayNoWrite } = require('./no_write');

const FLAG = 'OMEGA_CARD_LOCK_11AM';
const CORRECTION_CAP = 20;

const LOCKED_PICK_FIELDS = Object.freeze([
  'pick',
  'pickDisplay',
  'matchup',
  'sport',
  'betType',
  'market',
  'side',
  'line',
  'point',
  'book',
  'bookKey',
  'commenceTime',
  'pickId',
  'homeTeam',
  'awayTeam',
  'gameId',
  'eventId',
  'odds',
  'oddsAmerican',
  'americanOdds',
  'decimalOdds',
  'decimal',
  'price',
  'priceAmerican',
  'priceDecimal',
  'american',
  'units',
  'unitsNum',
  'stakeUsd',
  'stake',
  'stakeUnits',
  'stakeDollars',
  'toWin',
  'toWinUsd',
  'toWinDollars',
  'kellyUnits',
  'confidence',
  'grade',
  'edgePct',
  'ev',
  'winProbability',
  'coverProb',
  'qualityGrade',
  'rating',
]);

const LOCKED_PARLAY_FIELDS = Object.freeze([
  'type',
  'units',
  'unitsNum',
  'stakeUsd',
  'stake',
  'stakeUnits',
  'stakeDollars',
  'toWin',
  'toWinUsd',
  'toWinDollars',
  'combinedOdds',
  'combinedDecimal',
  'combinedProb',
  'combinedAmerican',
  'ev',
  'uniqueGames',
  'uniqueSports',
  'independent',
  'legMarkets',
  'correlationNote',
  'correlationHaircut',
  'candidatesScanned',
  'source',
  'pickId',
]);

function cardLockEnabled(env) {
  const source = env == null ? process.env : env;
  if (source == null) return true;
  const raw = source[FLAG];
  if (raw == null || String(raw).trim() === '') return true;
  const text = String(raw).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false' && text !== 'no';
}

function lockTimeUtc(dateISO) {
  return etLocalToUtcISO(dateISO, 11, 0);
}

function toMillis(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.parse(now);
}

function isCardLocked(dateISO, now) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return false;
    const lockMs = Date.parse(lockTimeUtc(dateISO));
    const nowMs = toMillis(now);
    if (!Number.isFinite(lockMs) || !Number.isFinite(nowMs)) return false;
    return nowMs >= lockMs;
  } catch (_) {
    return false;
  }
}

function snapshotKey(dateISO) {
  return `omega-card-lock/picks-${dateISO}`;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' && typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function marketOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.betType != null && String(row.betType).trim() !== '') return row.betType;
  return row.market;
}

function pickKey(row) {
  return [norm(row && row.sport), norm(row && row.matchup), norm(row && row.pick), norm(marketOf(row))].join('|');
}

function pickLabel(row) {
  if (!row || typeof row !== 'object') return 'pick';
  const name = row.pick || row.pickDisplay || row.side || 'pick';
  return String(name);
}

function straightCount(card) {
  return Array.isArray(card && card.picks) ? card.picks.length : 0;
}

function parlayCount(card) {
  return Array.isArray(card && card.parlayLegs) ? card.parlayLegs.length : 0;
}

function usableCard(card) {
  return !!(card && typeof card === 'object' && !Array.isArray(card) && (straightCount(card) > 0 || parlayCount(card) > 0));
}

function snapshotUsable(snapshot) {
  return usableCard(snapshot);
}

function hasField(row, field) {
  return !!row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined;
}

function applyLockedFields(out, source, fields, label, corrections) {
  for (const field of fields) {
    if (hasField(source, field)) {
      if (!sameValue(out[field], source[field])) {
        corrections.push(`reverted ${label} ${field}`);
        out[field] = clone(source[field]);
      }
    } else if (out && Object.prototype.hasOwnProperty.call(out, field)) {
      corrections.push(`removed ${label} ${field}`);
      delete out[field];
    }
  }
}

function matchRow(rows, key, used) {
  if (!Array.isArray(rows)) return -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (used.has(i)) continue;
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    if (pickKey(row) === key) return i;
  }
  return -1;
}

function lockRows(incomingRows, snapshotRows, corrections, labelFor) {
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  const snapshot = Array.isArray(snapshotRows) ? snapshotRows : [];
  const used = new Set();
  const out = [];
  snapshot.forEach((snapRow, index) => {
    if (!snapRow || typeof snapRow !== 'object') {
      out.push(snapRow);
      return;
    }
    const key = pickKey(snapRow);
    const found = matchRow(incoming, key, used);
    const label = labelFor(snapRow, index);
    let base;
    if (found >= 0) {
      used.add(found);
      base = clone(incoming[found]);
    } else {
      base = clone(snapRow);
      corrections.push(`restored missing ${label}`);
    }
    applyLockedFields(base, snapRow, LOCKED_PICK_FIELDS, label, corrections);
    out.push(base);
  });
  incoming.forEach((row, index) => {
    if (used.has(index)) return;
    if (!row || typeof row !== 'object') return;
    corrections.push(`dropped extra ${labelFor(row, index)}`);
  });
  return out;
}

function lockParlays(incomingRows, snapshotRows, corrections) {
  const incoming = Array.isArray(incomingRows) ? incomingRows : [];
  const snapshot = Array.isArray(snapshotRows) ? snapshotRows : [];
  const out = [];
  snapshot.forEach((snapRow, index) => {
    const label = `parlay ${index + 1}`;
    if (!snapRow || typeof snapRow !== 'object') {
      out.push(snapRow);
      return;
    }
    const incomingRow = incoming[index];
    const legLabel = (leg) => `${label} leg "${pickLabel(leg)}"`;
    let base;
    if (incomingRow && typeof incomingRow === 'object') {
      base = clone(incomingRow);
      applyLockedFields(base, snapRow, LOCKED_PARLAY_FIELDS, label, corrections);
      base.legs = lockRows(incomingRow.legs, snapRow.legs, corrections, legLabel);
    } else {
      base = clone(snapRow);
      corrections.push(`restored missing ${label}`);
    }
    out.push(base);
  });
  for (let i = snapshot.length; i < incoming.length; i += 1) {
    if (incoming[i] == null) continue;
    corrections.push(`dropped extra parlay ${i + 1}`);
  }
  return out;
}

function applyCardLock(nextCard, snapshot) {
  const card = (nextCard && typeof nextCard === 'object' && !Array.isArray(nextCard))
    ? clone(nextCard)
    : {};
  const snap = (snapshot && typeof snapshot === 'object') ? snapshot : {};
  const corrections = [];
  card.picks = lockRows(card.picks, snap.picks, corrections, (row) => `pick "${pickLabel(row)}"`);
  card.parlayLegs = lockParlays(card.parlayLegs, snap.parlayLegs, corrections);
  const dateISO = snap.date || card.date;
  let lockedAt = null;
  try {
    if (dateISO) lockedAt = lockTimeUtc(dateISO);
  } catch (_) {
    lockedAt = null;
  }
  card.cardLock = {
    lockedAt,
    snapshotAt: snap.takenAt || null,
    flag: FLAG,
    corrections: corrections.slice(0, CORRECTION_CAP),
  };
  return {
    card,
    corrections,
    changed: corrections.length > 0,
  };
}

function snapshotFromCard(card) {
  const src = (card && typeof card === 'object' && !Array.isArray(card)) ? card : {};
  return {
    date: src.date || null,
    takenAt: new Date().toISOString(),
    picks: clone(Array.isArray(src.picks) ? src.picks : []),
    parlayLegs: clone(Array.isArray(src.parlayLegs) ? src.parlayLegs : []),
  };
}

function emit(log, msg) {
  console.error(msg);
  if (typeof log !== 'function') return;
  try { log(msg); } catch (_) { /* the card still publishes */ }
}

function skipGuard(dateISO, deps) {
  const env = deps.env != null ? deps.env : process.env;
  if (!cardLockEnabled(env)) return true;
  if (deps.dryRun || deps.shadow || deps.simMode || deps.replay) return true;
  if (replayNoWrite(env)) return true;
  if (!isCardLocked(dateISO, deps.now)) return true;
  return false;
}

async function readStoreKey(store, key) {
  if (store && typeof store.getJSON === 'function') return store.getJSON(key);
  if (store && typeof store.get === 'function') return store.get(key, { type: 'json' });
  const { readJson } = require('./store');
  return readJson(key);
}

async function writeStoreKey(store, key, value) {
  if (store && typeof store.setJSON === 'function') return store.setJSON(key, value);
  const { storeJson } = require('./store');
  return storeJson(key, value);
}

/**
 * Deps for a live edge-picks-omega store. store may be an injected fake,
 * the Netlify blobs SDK store, or null (REST/SDK helpers in store.js).
 */
function liveStoreDeps(dateISO, store) {
  return {
    readSnapshot: (key) => readStoreKey(store, key),
    writeSnapshot: (key, value) => writeStoreKey(store, key, value),
    readCurrent: () => readStoreKey(store, `picks-${dateISO}`),
  };
}

async function guardCardWrite(dateISO, nextCard, deps) {
  const options = deps || {};
  if (skipGuard(dateISO, options)) return nextCard;
  const log = options.log;
  const key = snapshotKey(dateISO);

  let snapshot = null;
  let snapshotReadFailed = false;
  try {
    if (typeof options.readSnapshot === 'function') snapshot = await options.readSnapshot(key);
    else snapshot = await readStoreKey(null, key);
  } catch (err) {
    snapshotReadFailed = true;
    snapshot = null;
    emit(log, `[card-lock] snapshot read failed for ${dateISO}: ${err && err.message ? err.message : err}`);
  }

  if (snapshotUsable(snapshot)) {
    const locked = applyCardLock(nextCard, snapshot);
    if (locked.changed) {
      emit(log, `[card-lock] ${dateISO} ${locked.corrections.length} correction(s): ${locked.corrections.slice(0, 8).join('; ')}`);
    }
    return locked.card;
  }

  let current = null;
  let currentReadFailed = false;
  try {
    if (typeof options.readCurrent === 'function') current = await options.readCurrent();
    else current = await readStoreKey(null, `picks-${dateISO}`);
  } catch (err) {
    currentReadFailed = true;
    current = null;
    emit(log, `[card-lock] current card read failed for ${dateISO}: ${err && err.message ? err.message : err}`);
  }

  if (snapshotReadFailed && currentReadFailed) {
    emit(log, `[card-lock] ${dateISO} snapshot and current card unreadable; allowing write`);
    return nextCard;
  }

  if (straightCount(current) > 0) {
    const taken = snapshotFromCard(current);
    if (!taken.date) taken.date = dateISO;
    try {
      const write = options.writeSnapshot || ((k, value) => writeStoreKey(null, k, value));
      await write(key, taken);
      emit(log, `[card-lock] snapshotted ${dateISO} from the current card (${taken.picks.length} picks)`);
    } catch (err) {
      emit(log, `[card-lock] snapshot write failed for ${dateISO}: ${err && err.message ? err.message : err}`);
    }
    const locked = applyCardLock(nextCard, taken);
    if (locked.changed) {
      emit(log, `[card-lock] ${dateISO} ${locked.corrections.length} correction(s): ${locked.corrections.slice(0, 8).join('; ')}`);
    }
    return locked.card;
  }

  if (usableCard(nextCard)) {
    const taken = snapshotFromCard(nextCard);
    taken.date = dateISO || taken.date;
    try {
      const write = options.writeSnapshot || ((k, value) => writeStoreKey(null, k, value));
      await write(key, taken);
      emit(log, `[card-lock] snapshotted first non-empty write for ${dateISO} (${taken.picks.length} picks)`);
    } catch (err) {
      emit(log, `[card-lock] snapshot write failed for ${dateISO}: ${err && err.message ? err.message : err}`);
    }
  } else {
    emit(log, `[card-lock] ${dateISO} has no straights on the current card; allowing write`);
  }
  return nextCard;
}

async function seedCardLock(dateISO, card, deps) {
  const options = deps || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) {
    throw new Error(`bad date: ${dateISO}`);
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error('seedCardLock requires a card');
  }
  const key = snapshotKey(dateISO);
  if (!options.force) {
    let existing = null;
    if (typeof options.readSnapshot === 'function') existing = await options.readSnapshot(key);
    else existing = await readStoreKey(null, key);
    if (snapshotUsable(existing)) {
      const err = new Error(`card lock snapshot already exists for ${dateISO}`);
      err.code = 'SNAPSHOT_EXISTS';
      throw err;
    }
  }
  const snap = snapshotFromCard(card);
  snap.date = dateISO;
  const write = options.writeSnapshot || ((k, value) => writeStoreKey(null, k, value));
  await write(key, snap);
  return snap;
}

module.exports = {
  FLAG,
  LOCKED_PICK_FIELDS,
  LOCKED_PARLAY_FIELDS,
  CORRECTION_CAP,
  cardLockEnabled,
  lockTimeUtc,
  isCardLocked,
  snapshotKey,
  applyCardLock,
  snapshotFromCard,
  guardCardWrite,
  seedCardLock,
  liveStoreDeps,
};
