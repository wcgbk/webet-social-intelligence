'use strict';

/**
 * Private ledger of every gate-evaluated Omega candidate.
 * Key: omega-candidates/{YYYY-MM-DD} in edge-picks-omega.
 *
 * Written only on a live generate (not dryRun, replay, shadow, or sim).
 * OMEGA_CANDIDATE_LEDGER defaults on. "0" / "false" / "off" / "no" disables it.
 * OMEGA_REPLAY_NO_WRITE=1 writes nothing.
 *
 * The card object is not read back and not modified. storeJson is the same
 * helper the generator already uses (SDK setJSON, REST fallback).
 */

const { ODDS_SPORT_KEYS } = require('./config');
const { formatMoneylinePick } = require('./odds_math');
const { storeJson } = require('./store');

function ledgerEnabled(env) {
  const source = env || process.env;
  const raw = source.OMEGA_CANDIDATE_LEDGER;
  if (raw == null || String(raw).trim() === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function shouldWriteCandidateLedger(opts = {}) {
  const env = opts.env || process.env;
  if (!ledgerEnabled(env)) return false;
  if (opts.dryRun) return false;
  if (opts.shadow) return false;
  if (opts.simMode) return false;
  if (opts.replay || opts.replayLike) return false;
  if (opts.historicalSnapshot) return false;
  const flag = env.OMEGA_REPLAY_NO_WRITE;
  if (flag === '1' || String(flag).toLowerCase() === 'true') return false;
  return true;
}

function candidateLedgerKey(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`omega-candidates refused bad date: ${dateISO}`);
  }
  return `omega-candidates/${d}`;
}

function sportKeyFor(sport) {
  if (!sport) return null;
  if (sport === 'CFB' || sport === 'NCAAF') return ODDS_SPORT_KEYS.NCAAF || null;
  return ODDS_SPORT_KEYS[sport] || null;
}

function lineToken(line) {
  if (line == null || line === '') return '';
  const n = Number(line);
  return Number.isFinite(n) ? String(n) : String(line);
}

function rowKey(row) {
  return [
    row && row.sport || '',
    row && row.matchup || '',
    row && row.market || '',
    row && row.side || '',
    lineToken(row && row.line),
  ].join('|').toLowerCase();
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventIdFor(row, oddsBySport) {
  if (!row) return null;
  if (row.eventId != null && row.eventId !== '') return String(row.eventId);
  if (row.event_id != null && row.event_id !== '') return String(row.event_id);
  const events = (oddsBySport && oddsBySport[row.sport]) || [];
  const home = String(row.homeTeam || '').toLowerCase();
  const away = String(row.awayTeam || '').toLowerCase();
  if (!home || !away) return null;
  const ev = events.find((e) => {
    if (!e) return false;
    const h = String(e.home_team || e.homeTeam || '').toLowerCase();
    const a = String(e.away_team || e.awayTeam || '').toLowerCase();
    return (h === home && a === away) || (h === away && a === home);
  });
  if (!ev) return null;
  const id = ev.id != null ? ev.id : (ev.eventId != null ? ev.eventId : ev.event_id);
  return id == null || id === '' ? null : String(id);
}

function sameTicket(row, ticket) {
  if (!row || !ticket) return false;
  const name = ticket.pick || ticket.side || '';
  if (!name) return false;
  const labeled = formatMoneylinePick(row.side, row.market);
  if (name !== row.side && name !== labeled) return false;
  if (ticket.matchup && row.matchup && ticket.matchup !== row.matchup) return false;
  return true;
}

function isPublished(row, picks, parlayLegs) {
  if ((picks || []).some((p) => sameTicket(row, p))) return true;
  for (const pl of parlayLegs || []) {
    const legs = pl && Array.isArray(pl.legs) ? pl.legs : [];
    if (legs.some((leg) => sameTicket(row, leg))) return true;
  }
  return false;
}

function ledgerRow(source, { reason, published, generatedAt, oddsBySport }) {
  const line = numOrNull(source && source.line);
  return {
    sport: (source && source.sport) || null,
    sportKey: sportKeyFor(source && source.sport),
    eventId: eventIdFor(source, oddsBySport),
    matchup: (source && source.matchup) || null,
    homeTeam: (source && source.homeTeam) || null,
    awayTeam: (source && source.awayTeam) || null,
    commenceTime: (source && source.commenceTime) || null,
    market: (source && source.market) || null,
    side: (source && source.side) || null,
    line,
    odds: source && source.odds != null ? source.odds : null,
    book: (source && source.book) || null,
    fair_sharp_p: numOrNull(source && source.fair_sharp_p),
    p_model: numOrNull(source && source.p_model),
    coverProb: numOrNull(source && source.coverProb),
    ev: numOrNull(source && source.ev),
    reason: reason || 'yes',
    published: !!published,
    generatedAt: generatedAt || null,
  };
}

/**
 * Yes pool + every gate rejection. Uncapped. Dedupe keeps the first row,
 * and the yes pool is walked first so a duplicate keeps reason "yes".
 * Does not mutate inputs.
 */
function buildCandidateLedger(opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const picks = opts.picks || (opts.picksData && opts.picksData.picks) || [];
  const parlayLegs = opts.parlayLegs || (opts.picksData && opts.picksData.parlayLegs) || [];
  const oddsBySport = opts.oddsBySport || null;
  const seen = new Set();
  const candidates = [];
  const add = (source, reason) => {
    if (!source) return;
    const side = source.side || source.pick;
    if (!side || !source.matchup) return;
    const draft = { ...source, side };
    const key = rowKey(draft);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(ledgerRow(draft, {
      reason,
      published: isPublished(draft, picks, parlayLegs),
      generatedAt,
      oddsBySport,
    }));
  };
  for (const row of opts.yesPool || []) add(row, 'yes');
  for (const row of opts.rejected || []) {
    add(row, row.rejectReason || row.reason || 'reject');
  }
  return {
    date: opts.dateISO || null,
    generatedAt,
    private: true,
    schema: 'omega-candidates-v1',
    note: 'Every gate-evaluated candidate. Not a card field. Not a KPI.',
    count: candidates.length,
    candidates,
  };
}

/**
 * Side effect only. Returns { wrote: false } when this generate must not
 * touch the store. Throws on a real write failure so the caller can soft-fail
 * without changing the card.
 */
async function persistCandidateLedger(opts = {}) {
  if (!shouldWriteCandidateLedger(opts)) return { wrote: false, reason: 'skipped' };
  const key = candidateLedgerKey(opts.dateISO);
  const payload = buildCandidateLedger(opts);
  const write = opts.storeJson || storeJson;
  await write(key, payload);
  return { wrote: true, key, count: payload.count, payload };
}

module.exports = {
  ledgerEnabled,
  shouldWriteCandidateLedger,
  candidateLedgerKey,
  sportKeyFor,
  rowKey,
  lineToken,
  buildCandidateLedger,
  persistCandidateLedger,
  eventIdFor,
  isPublished,
};
