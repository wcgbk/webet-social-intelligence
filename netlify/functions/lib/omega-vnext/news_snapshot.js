'use strict';

/**
 * Daily ESPN news log for a later backtest of OMEGA_V2_NBA_INJURY,
 * OMEGA_V2_NHL_GOALIE, and OMEGA_NFL_QB_ADJ. Not a pick input.
 * Live v2 generate calls this once. Replay does not.
 * The per-game slate is news_slate.js (OMEGA_NEWS_SLATE), a separate blob key.
 * Each pull is 5s. A failure is recorded and does not throw.
 * NBA and NHL bodies already pulled for a veto are reused.
 */

const { newsSnapshotEnabled } = require('../omega-v2/constants');
const { SITE_ID } = require('./config');
const { blobRestUrl } = require('./blob_key');
const {
  NBA_INJURY_URL,
  NBA_RATES_URL,
  nhlScoreboardUrl,
  parseRatePlayers,
  pullNewsJson,
} = require('./status_pull');

const NFL_INJURY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const NEWS_SNAPSHOT_STORE = 'omega-news-snapshots';
const NEWS_SNAPSHOT_TIMEOUT_MS = 5000;
const COMMENT_MAX = 240;

function fetchedAtISO(now) {
  const d = now == null ? new Date() : (now instanceof Date ? now : new Date(now));
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function hhmmET(when) {
  const parsed = when instanceof Date ? when : new Date(when || Date.now());
  const stamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  let hour = '00';
  let minute = '00';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(stamp);
    hour = (parts.find((p) => p.type === 'hour') || {}).value || '00';
    minute = (parts.find((p) => p.type === 'minute') || {}).value || '00';
  } catch (_) {
    hour = '00';
    minute = '00';
  }
  if (hour === '24') hour = '00';
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

/** Blob key `{date}/{HHMM-ET}`, clock in America/New_York. */
function newsBlobKey(dateISO, when) {
  return `${dateISO}/${hhmmET(when)}-ET`;
}

function clip(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > COMMENT_MAX ? s.slice(0, COMMENT_MAX) : s;
}

function teamNameOf(block) {
  if (!block || typeof block !== 'object') return '';
  return block.displayName
    || (block.team && (block.team.displayName || block.team.name))
    || block.teamName
    || '';
}

function statusOf(inj) {
  if (!inj || typeof inj !== 'object') return '';
  if (typeof inj.status === 'string') return inj.status;
  if (inj.status && typeof inj.status === 'object') {
    return inj.status.description || inj.status.name || inj.status.type || '';
  }
  if (typeof inj.type === 'string') return inj.type;
  return '';
}

function positionOf(inj) {
  const athlete = inj && inj.athlete && typeof inj.athlete === 'object' ? inj.athlete : null;
  const pos = (athlete && athlete.position) || (inj && inj.position);
  if (!pos) return '';
  if (typeof pos === 'string') return pos;
  return pos.abbreviation || pos.name || '';
}

function athleteOf(inj) {
  const athlete = inj && inj.athlete && typeof inj.athlete === 'object' ? inj.athlete : inj;
  if (!athlete || typeof athlete !== 'object') return '';
  return athlete.displayName || athlete.fullName || athlete.shortName || '';
}

function dateOf(inj) {
  if (!inj || typeof inj !== 'object') return null;
  const raw = inj.date || inj.injuryDate || (inj.details && inj.details.date) || null;
  if (raw == null || raw === '') return null;
  return String(raw);
}

function eachInjury(data, visit) {
  const blocks = []
    .concat((data && data.injuries) || [])
    .concat((data && data.teams) || []);
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const team = teamNameOf(block);
    const list = Array.isArray(block.injuries)
      ? block.injuries
      : (Array.isArray(block.athletes) ? block.athletes : null);
    if (list && list.length) {
      for (const inj of list) visit(team, inj);
    } else if (block.athlete || block.status) {
      visit(team, block);
    }
  }
}

function compactInjuries(data, opts) {
  const qbOnly = !!(opts && opts.qbOnly);
  const out = [];
  if (!data || typeof data !== 'object') return out;
  eachInjury(data, (team, inj) => {
    if (!inj || typeof inj !== 'object') return;
    const athlete = athleteOf(inj);
    if (!athlete) return;
    if (qbOnly && String(positionOf(inj)).toUpperCase() !== 'QB') return;
    out.push({
      team: team || '',
      athlete,
      status: String(statusOf(inj) || ''),
      shortComment: clip(inj.shortComment || inj.shortText || ''),
      date: dateOf(inj),
    });
  });
  return out;
}

function compactRates(data) {
  if (!data) return null;
  try {
    return parseRatePlayers(data).map((p) => ({
      team: p.team,
      athlete: p.name,
      mpg: p.mpg,
      ppg: p.ppg,
    }));
  } catch (_) {
    return null;
  }
}

function statusTrio(raw) {
  const status = raw && raw.status && typeof raw.status === 'object' ? raw.status : {};
  let type = status.type || null;
  if (!type && raw && typeof raw.status === 'string') type = raw.status;
  return {
    type: type || null,
    name: status.name || null,
    id: status.id != null && status.id !== '' ? String(status.id) : null,
  };
}

function compactProbables(data) {
  const events = data && Array.isArray(data.events) ? data.events : [];
  const out = [];
  for (const event of events) {
    const competitions = event && Array.isArray(event.competitions) ? event.competitions : [];
    const comp = competitions[0] || null;
    const competitors = comp && Array.isArray(comp.competitors) ? comp.competitors : [];
    for (const competitor of competitors) {
      const teamObj = competitor && competitor.team;
      const team = teamObj ? (teamObj.displayName || teamObj.name || '') : '';
      const list = competitor && Array.isArray(competitor.probables) ? competitor.probables : [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const athlete = raw.athlete && typeof raw.athlete === 'object' ? raw.athlete : {};
        const pos = typeof athlete.position === 'string'
          ? athlete.position
          : ((athlete.position && (athlete.position.abbreviation || athlete.position.name)) || '');
        const slot = String(raw.name || '');
        if (!/goalie/i.test(slot) && String(pos).toUpperCase() !== 'G') continue;
        out.push({
          team,
          goalie: athlete.displayName || athlete.fullName || null,
          status: statusTrio(raw),
        });
      }
    }
  }
  return out;
}

/**
 * Ingest already keeps the out/doubtful/questionable QB map when NCAAF is
 * on the slate. That map is the cheap copy. No second college fetch.
 * A missing map is the string 'unavailable'.
 */
function ncaafQbRows(source) {
  if (source == null || source === 'unavailable') return 'unavailable';
  if (typeof source !== 'object') return 'unavailable';
  const rows = [];
  for (const [key, row] of Object.entries(source)) {
    if (!row || typeof row !== 'object' || key === '_meta') continue;
    const team = row.team || key;
    const athlete = row.qbName || row.athlete || row.name || null;
    const status = row.qbStatus || row.status || null;
    if (!team && !athlete) continue;
    rows.push({
      team: team || '',
      athlete: athlete || null,
      status: status || null,
    });
  }
  return rows;
}

function normJoin(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function boardGameId(candidate, oddsBySport) {
  if (!candidate || typeof candidate !== 'object') return null;
  const explicit = candidate.gameId || candidate.eventId || candidate.event_id;
  if (explicit != null && explicit !== '') return String(explicit);
  const sport = candidate.sport;
  const bag = oddsBySport && (oddsBySport[sport] || oddsBySport[String(sport || '').toUpperCase()]);
  const events = Array.isArray(bag) ? bag : [];
  const home = normJoin(candidate.homeTeam);
  const away = normJoin(candidate.awayTeam);
  if (home && away) {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const eh = normJoin(ev.home_team || ev.homeTeam);
      const ea = normJoin(ev.away_team || ev.awayTeam);
      const same = eh === home && ea === away;
      const swapped = eh === away && ea === home;
      if ((same || swapped) && ev.id != null && ev.id !== '') return String(ev.id);
    }
  }
  if (candidate.id != null && candidate.id !== '' && typeof candidate.id !== 'object') {
    return String(candidate.id);
  }
  return null;
}

function candidateGames(candidates, oddsBySport) {
  const seen = new Set();
  const games = [];
  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const sport = candidate.sport || null;
    const matchup = candidate.matchup || null;
    const gameId = boardGameId(candidate, oddsBySport);
    const key = `${sport || ''}|${String(matchup || '').toLowerCase()}`;
    if (!matchup || seen.has(key)) continue;
    seen.add(key);
    games.push({
      sport,
      matchup,
      gameId,
      homeTeam: candidate.homeTeam || null,
      awayTeam: candidate.awayTeam || null,
      commenceTime: candidate.commenceTime || null,
    });
  }
  return games;
}

function settledBody(result) {
  if (!result || result.status !== 'fulfilled') return null;
  return result.value || null;
}

async function openNewsStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore(NEWS_SNAPSHOT_STORE);
}

function raceTimeout(work, timeoutMs) {
  let timer;
  const pending = Promise.resolve().then(work);
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function safeDetail(msg) {
  return String(msg || 'error').replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
}

async function writeDoc(store, key, doc, timeoutMs) {
  await raceTimeout(() => {
    if (typeof store.setJSON === 'function') return store.setJSON(key, doc);
    return store.set(key, JSON.stringify(doc));
  }, timeoutMs);
}

/**
 * SDK miss uses the same Blobs REST PUT as the other omega-vnext writers.
 * A slash key stays a path (`date/1000-ET`). Encoding the whole key would
 * store a different object (`date%2F1000-ET`).
 */
async function restPutNews(key, doc, timeoutMs, opts) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const url = blobRestUrl(SITE_ID, NEWS_SNAPSHOT_STORE, key, 'canonical');
  const doFetch = opts && typeof opts.blobFetch === 'function' ? opts.blobFetch : fetch;
  const resp = await raceTimeout(() => doFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(doc),
  }), timeoutMs);
  if (!resp || resp.ok !== true) {
    const status = resp && resp.status != null ? resp.status : 'no-response';
    throw new Error(`blob PUT ${key} → ${status}`);
  }
}

/** 'sdk' or 'rest'. Throws when both miss. Any SDK error, including timeout, tries REST. */
async function writeSnapshot(key, doc, timeoutMs, opts) {
  let sdkErr = null;
  try {
    const store = (opts && opts.store) || await openNewsStore();
    await writeDoc(store, key, doc, timeoutMs);
    return 'sdk';
  } catch (err) {
    sdkErr = err;
  }
  try {
    await restPutNews(key, doc, timeoutMs, opts || {});
    return 'rest';
  } catch (restErr) {
    const msg = (restErr && restErr.message) || (sdkErr && sdkErr.message) || 'error';
    throw new Error(safeDetail(msg));
  }
}

function logSnapshot(pathUsed, key, doc, detail) {
  if (pathUsed === 'failed') {
    console.warn(`[omega-news] snapshot path=failed key=${key} soft-fail: ${safeDetail(detail)}`);
    return;
  }
  const rates = doc && doc.nba ? doc.nba.rates : null;
  const nba = doc && doc.nba && Array.isArray(doc.nba.injuries) ? doc.nba.injuries.length : 0;
  const nhl = doc && doc.nhl && Array.isArray(doc.nhl.probables) ? doc.nhl.probables.length : 0;
  const nfl = Array.isArray(doc && doc.nflQb) ? doc.nflQb.length : 0;
  console.log(`[omega-news] snapshot path=${pathUsed} key=${key} nba=${nba} rates=${rates ? rates.length : 0} nhl=${nhl} nflQb=${nfl}`);
}

/**
 * Fetch the compact snapshot and write `{date}/{HHMM-ET}`.
 * Returns without throwing. Flag off and replay do not fetch or write.
 * opts.store injects an in-memory blob store for tests.
 * opts.blobFetch injects the REST client. Production uses global fetch.
 * The summary path is 'sdk', 'rest', or 'failed'. This function does not throw.
 */
async function captureNewsSnapshot(opts = {}) {
  const env = opts.env == null ? process.env : opts.env;
  if (!newsSnapshotEnabled(env)) return { wrote: false, skipped: 'flag-off' };
  if (opts.replay || opts.replayLike) return { wrote: false, skipped: 'replay' };
  const dateISO = opts.dateISO || opts.date;
  if (!dateISO) return { wrote: false, skipped: null, error: 'soft-fail' };
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
    ? Number(opts.timeoutMs)
    : NEWS_SNAPSHOT_TIMEOUT_MS;
  const when = opts.now == null ? new Date() : opts.now;
  const fetchedAt = fetchedAtISO(when);
  const fetchImpl = opts.fetchImpl;
  try {
    const nhlUrl = nhlScoreboardUrl(dateISO);
    const settled = await Promise.allSettled([
      pullNewsJson('nbaInjuries', NBA_INJURY_URL, timeoutMs, fetchImpl),
      pullNewsJson('nbaRates', NBA_RATES_URL, timeoutMs, fetchImpl),
      pullNewsJson('nhlBoard', nhlUrl, timeoutMs, fetchImpl),
      pullNewsJson('nflInjuries', NFL_INJURY_URL, timeoutMs, fetchImpl),
    ]);
    const nbaBody = settledBody(settled[0]);
    const ratesBody = settledBody(settled[1]);
    const nhlBody = settledBody(settled[2]);
    const nflBody = settledBody(settled[3]);
    const rates = ratesBody ? compactRates(ratesBody) : null;
    const doc = {
      fetchedAt,
      date: dateISO,
      games: candidateGames(opts.candidates, opts.oddsBySport),
      nba: {
        injuries: nbaBody ? compactInjuries(nbaBody) : [],
        rates,
      },
      nhl: {
        probables: nhlBody ? compactProbables(nhlBody) : [],
      },
      nflQb: nflBody ? compactInjuries(nflBody, { qbOnly: true }) : [],
      ncaafQb: ncaafQbRows(opts.ncaafQb),
    };
    if (!nbaBody) doc.nba.error = 'soft-fail';
    if (!ratesBody || rates == null) doc.nba.ratesError = 'soft-fail';
    if (!nhlBody) doc.nhl.error = 'soft-fail';
    if (!nflBody) doc.nflQbError = 'soft-fail';
    const key = newsBlobKey(dateISO, when);
    try {
      const pathUsed = await writeSnapshot(key, doc, timeoutMs, opts);
      logSnapshot(pathUsed, key, doc);
      return { wrote: true, key, skipped: null, path: pathUsed };
    } catch (err) {
      const msg = err && err.message ? err.message : 'error';
      logSnapshot('failed', key, doc, msg);
      return { wrote: false, key, skipped: null, error: 'soft-fail', path: 'failed' };
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'error';
    console.warn(`[omega-news] snapshot soft-fail: ${msg}`);
    return { wrote: false, skipped: null, error: 'soft-fail' };
  }
}

module.exports = {
  NFL_INJURY_URL,
  NEWS_SNAPSHOT_STORE,
  NEWS_SNAPSHOT_TIMEOUT_MS,
  newsBlobKey,
  hhmmET,
  clip,
  fetchedAtISO,
  writeNewsBlob: writeSnapshot,
  captureNewsSnapshot,
};
