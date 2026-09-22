'use strict';
/**
 * TSP research observer — ISOLATED from Omega live selection.
 * Blob store: tsp-research (NEVER edge-picks-omega live config/picks).
 * tsp.live member scrape stays ON HOLD (TSP_FETCH_ON_HOLD=true).
 */

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const BLOB_STORE = 'tsp-research';

/** Hard hold for tsp.live member pages — do not flip without TSP permission. */
const TSP_FETCH_ON_HOLD = true;

/**
 * Public Performance Terminal feed (same CSVs the public TSP terminal loads).
 * Normal HTTPS GET only — no IP rotate, no spoof, no member cookies.
 */
const PUBLIC_LAMBDA_BASE =
  process.env.TSP_PUBLIC_LAMBDA_BASE
  || 'https://kjcvzfri7oqq3iddfgcz72oice0qdqfd.lambda-url.us-east-1.on.aws';

/**
 * Sheet ids used by the public Performance Terminal (script-10.js SHEETS + summaries).
 * These are public wager-log / summary CSVs, not member-only Hermes live picks.
 */
const PUBLIC_FEEDS = [
  { id: 1, key: 'consensus', name: 'TSP Consensus', kind: 'wager_log' },
  { id: 3, key: 'in_play_targets', name: 'In-Play Targets', kind: 'wager_log' },
  { id: 4, key: 'insiders', name: 'TSP Insiders', kind: 'wager_log' },
  { id: 6, key: 'hermes_elite', name: 'Hermes Elite', kind: 'wager_log' },
  { id: 7, key: 'live_portfolio', name: 'TSP Live Portfolio', kind: 'wager_log' },
  { id: 8, key: 'content_summary', name: 'Content Summary', kind: 'summary' },
  { id: 9, key: 'general_content_log', name: 'General Content Log', kind: 'wager_log' },
  { id: 11, key: 'lab_research', name: 'Lab Research Summary', kind: 'summary' },
  { id: 12, key: 'personal_plays_since_2011', name: 'Personal Plays Since 2011', kind: 'summary' },
  { id: 13, key: 'compass', name: 'TSP Compass', kind: 'wager_log' },
];

const USER_AGENT = 'WeBetTspResearchObserver/1.0 (+public-records; tos-safe; no-member-scrape)';

module.exports = {
  SITE_ID,
  BLOB_STORE,
  TSP_FETCH_ON_HOLD,
  PUBLIC_LAMBDA_BASE,
  PUBLIC_FEEDS,
  USER_AGENT,
};
