'use strict';

/**
 * Full-board closing capture for capture-pick-closes.
 * One Odds API odds call per sport per tick, for games already on the
 * stored odds-master by-date index. No slate list call. No new env vars.
 * OMEGA_FULL_BOARD_CLOSES defaults on; off / 0 / false skips this path.
 */

const { defaultOnFlag } = require('./default_on_flag');

const SPORTS = ['NFL', 'NCAAF', 'NBA', 'NCAAM', 'NHL'];
const BOOKS = ['pinnacle', 'draftkings', 'hardrockbet', 'hardrockbet_fl', 'hardrockbet_oh'];
const MARKETS = ['h2h', 'spreads', 'totals'];
const COST = 3;
const SOURCE = 'oddsapi-live:capture-all-closes';

function fullBoardEnabled(env) {
  return defaultOnFlag('OMEGA_FULL_BOARD_CLOSES', env);
}

/** Same commence key the card-leg path writes into done/{sport}/{ct}/{market}. */
function normalizeCommence(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().replace('.000Z', 'Z');
}

function isoSecond(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Events whose kickoff is inside the card-leg pre-game window.
 * MLB is dropped. The same event id on today and yesterday counts once.
 */
function dueBoardEvents(events, now, windowMin, windowMax) {
  const when = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  const seen = new Set();
  for (const ev of events || []) {
    if (!ev) continue;
    const sport = String(ev.sport || '').toUpperCase();
    if (!SPORTS.includes(sport)) continue;
    const eventId = ev.eventId || ev.id;
    if (!eventId || !ev.commenceTime) continue;
    const commenceTime = normalizeCommence(ev.commenceTime);
    if (!commenceTime) continue;
    const mins = (new Date(commenceTime).getTime() - when) / 60000;
    if (!(mins >= windowMin && mins <= windowMax)) continue;
    const dedupe = `${sport}|${String(eventId)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      sport,
      eventId: String(eventId),
      homeTeam: ev.homeTeam || ev.home_team || null,
      awayTeam: ev.awayTeam || ev.away_team || null,
      commenceTime,
    });
  }
  return out;
}

function groupBySport(events) {
  const map = new Map();
  for (const ev of events || []) {
    if (!map.has(ev.sport)) map.set(ev.sport, []);
    map.get(ev.sport).push(ev);
  }
  return map;
}

/** Worst-case window for one sport call: min due commence −1 min through max +1 min. */
function commenceBounds(events) {
  const times = (events || []).map((ev) => new Date(ev.commenceTime).getTime()).filter(Number.isFinite);
  if (!times.length) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { from: isoSecond(min - 60000), to: isoSecond(max + 60000) };
}

/**
 * Live odds URL. regions=us is kept in the same param style as the card-leg
 * call. The Odds API ignores regions when bookmakers is set; bookmakers is
 * what gets billed (≤10 books = 1 region). Worst-case cost is markets × 1 = 3.
 */
function buildFullBoardUrl(apiKey, sportKey, from, to) {
  const qs = new URLSearchParams({
    apiKey,
    regions: 'us',
    markets: MARKETS.join(','),
    bookmakers: BOOKS.join(','),
    oddsFormat: 'american',
    dateFormat: 'iso',
    commenceTimeFrom: from,
    commenceTimeTo: to,
  });
  return `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?${qs}`;
}

function publicUrl(url) {
  const u = new URL(url);
  u.searchParams.delete('apiKey');
  u.searchParams.delete('api_key');
  return u.toString();
}

function archiveKey(etDate, sport, fetchedAt) {
  return `raw/${etDate}/${sport}/${fetchedAt}.json`;
}

function doneEvKey(sport, eventId) {
  return `done-ev/${sport}/${eventId}`;
}

function doneMarketKey(sport, commenceTime, market) {
  return `done/${sport}/${commenceTime}/${market}`;
}

function headerValue(resp, name) {
  if (!resp || !resp.headers || !name) return null;
  const h = resp.headers;
  if (typeof h.get === 'function') {
    const direct = h.get(name);
    if (direct != null && direct !== '') return direct;
    const lower = h.get(String(name).toLowerCase());
    if (lower != null && lower !== '') return lower;
    return null;
  }
  if (h[name] != null && h[name] !== '') return h[name];
  const lowerName = String(name).toLowerCase();
  if (h[lowerName] != null && h[lowerName] !== '') return h[lowerName];
  return null;
}

function actualFromHeader(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function spentCredits(credits) {
  return Math.max(Number(credits && credits.used) || 0, Number(credits && credits.usedActual) || 0);
}

function canAfford(credits, cost, cap) {
  return spentCredits(credits) + cost <= cap;
}

/** `used` stays the estimated spend. `usedActual` moves only when the header is present. */
function applySpend(credits, estCost, actualCost) {
  credits.used = (Number(credits.used) || 0) + (Number(estCost) || 0);
  if (actualCost != null && Number.isFinite(Number(actualCost))) {
    credits.usedActual = (Number(credits.usedActual) || 0) + Number(actualCost);
  }
  return credits;
}

module.exports = {
  SPORTS,
  BOOKS,
  MARKETS,
  COST,
  SOURCE,
  fullBoardEnabled,
  normalizeCommence,
  dueBoardEvents,
  groupBySport,
  commenceBounds,
  buildFullBoardUrl,
  publicUrl,
  archiveKey,
  doneEvKey,
  doneMarketKey,
  headerValue,
  actualFromHeader,
  spentCredits,
  canAfford,
  applySpend,
};
