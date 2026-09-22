'use strict';

const {
  PUBLIC_LAMBDA_BASE,
  PUBLIC_FEEDS,
  USER_AGENT,
  TSP_FETCH_ON_HOLD,
} = require('./config');
const { parseCsv, summarizeWagerLog, summarizeSummarySheet } = require('./parse_csv');

async function fetchFeedCsv(feed, { base = PUBLIC_LAMBDA_BASE, timeoutMs = 25000 } = {}) {
  const url = `${base.replace(/\/$/, '')}/?id=${encodeURIComponent(feed.id)}`;
  const resp = await fetch(url, {
    headers: { Accept: 'text/csv,text/plain,*/*', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for feed ${feed.id}`);
    err.status = resp.status;
    throw err;
  }
  const text = await resp.text();
  if (text.trim().startsWith('{')) {
    // Lambda error JSON
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error || msg; } catch (_) {}
    throw new Error(`feed ${feed.id} returned JSON error: ${msg}`);
  }
  return text;
}

function buildFeedArtifact(feed, csvText) {
  const parsed = parseCsv(csvText);
  const summary = feed.kind === 'summary'
    ? summarizeSummarySheet(parsed.rows)
    : summarizeWagerLog(parsed.rows);
  return {
    id: feed.id,
    key: feed.key,
    name: feed.name,
    kind: feed.kind,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    summary,
    // Cap row payload to keep blobs reasonable; full CSV stored separately when needed
    rowsPreview: parsed.rows.slice(0, 25),
    rows: parsed.rows.length <= 5000 ? parsed.rows : parsed.rows.slice(-5000),
    truncated: parsed.rows.length > 5000,
  };
}

/**
 * Download all public Performance Terminal feeds.
 * Does NOT touch tsp.live member pages. TSP_FETCH_ON_HOLD is irrelevant here
 * (that flag only gates fetch-tsp-live.js member scrape).
 */
async function downloadPublicRecords({ feeds = PUBLIC_FEEDS, base = PUBLIC_LAMBDA_BASE } = {}) {
  const fetchedAt = new Date().toISOString();
  const results = [];
  const errors = [];

  for (const feed of feeds) {
    try {
      const csv = await fetchFeedCsv(feed, { base });
      results.push(buildFeedArtifact(feed, csv));
    } catch (e) {
      errors.push({ id: feed.id, key: feed.key, name: feed.name, error: e.message, status: e.status || null });
      results.push({
        id: feed.id, key: feed.key, name: feed.name, kind: feed.kind,
        error: e.message, rowCount: 0, headers: [], rows: [], summary: null,
      });
    }
  }

  return {
    observer: 'tsp-public-records',
    version: 'v1',
    source: 'tsp_performance_terminal_public_lambda',
    sourceUrl: base,
    fetchedAt,
    completedAt: new Date().toISOString(),
    tspLiveMemberFetch: 'ON_HOLD',
    tspFetchOnHold: TSP_FETCH_ON_HOLD,
    isolation: {
      blobStore: 'tsp-research',
      neverWrites: ['edge-picks-omega', 'omega live picks', 'omega selection/config'],
      neverCopiesPicksIntoOmega: true,
      neverTrainsOmegaToMimicHermes: true,
    },
    feedCount: feeds.length,
    okCount: results.filter((r) => !r.error).length,
    errors,
    feeds: results,
    disclaimer:
      'OBSERVER / RESEARCH ONLY — public TSP Performance Terminal wager-log snapshots. '
      + 'Isolated tsp-research blob. Not Omega live config. Not a copy of Hermes member picks. '
      + 'tsp.live member scrape remains ON HOLD.',
  };
}

function buildDailyDigest(snapshot, { dateISO } = {}) {
  const feeds = (snapshot && snapshot.feeds) || [];
  return {
    observer: 'tsp-public-records-digest',
    version: 'v1',
    date: dateISO || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    fetchedAt: snapshot && snapshot.fetchedAt,
    sourceUrl: snapshot && snapshot.sourceUrl,
    okCount: snapshot && snapshot.okCount,
    errors: snapshot && snapshot.errors,
    isolation: snapshot && snapshot.isolation,
    feeds: feeds.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      kind: f.kind,
      rowCount: f.rowCount || 0,
      error: f.error || null,
      summary: f.summary || null,
    })),
    disclaimer: snapshot && snapshot.disclaimer,
  };
}

module.exports = {
  fetchFeedCsv,
  buildFeedArtifact,
  downloadPublicRecords,
  buildDailyDigest,
};
