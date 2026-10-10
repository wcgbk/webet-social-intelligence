'use strict';

/**
 * GET /.netlify/functions/get-omega-capture-health
 * READ ONLY ops snapshot of last Omega captureHealth (omega-ops/*).
 * Does not change hardFail policy or pick math. Optional ?date=YYYY-MM-DD.
 */

const {
  readCaptureHealthLatest,
  readCaptureHealthDate,
  readJson,
} = require('./lib/omega-vnext/store');
const { coverageBySportMarket, candidateCloseKey, readWithFallback } = require('./lib/omega-vnext/candidate_closes_v2');
const { etParts } = require('./lib/et-schedule');

function previousEtYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return etParts(dt).ymd;
}

async function legacyCandidateRow(date, read) {
  const key = `clv-candidates-${date}`;
  try {
    const blob = await read(key);
    const rows = blob && Array.isArray(blob.candidates) ? blob.candidates.length : 0;
    return { date, key, exists: blob != null, rows };
  } catch (err) {
    return { date, key, exists: false, rows: 0, error: err && err.message };
  }
}

/**
 * Legacy v1 blobs clv-candidates-{today} and clv-candidates-{yesterday}.
 * Read only, same REST-fallback path as the v2 writer. Does not write.
 */
async function legacyCandidateReport(now, read) {
  const today = etParts(now || new Date()).ymd;
  const yesterday = previousEtYmd(today);
  const reader = read || ((key) => readWithFallback(key, {}));
  const [todayRow, yesterdayRow] = await Promise.all([
    legacyCandidateRow(today, reader),
    legacyCandidateRow(yesterday, reader),
  ]);
  return { today: todayRow, yesterday: yesterdayRow };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event, context, deps) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  const readLatest = (deps && deps.readCaptureHealthLatest) || readCaptureHealthLatest;
  const readDate = (deps && deps.readCaptureHealthDate) || readCaptureHealthDate;
  const readBlob = (deps && deps.readJson) || readJson;
  try {
    let snap = null;
    if (dateISO) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ ok: false, error: 'bad date (YYYY-MM-DD)' }),
        };
      }
      snap = await readDate(dateISO);
    } else {
      snap = await readLatest();
    }
    const coverageDate = dateISO || etParts((deps && deps.now) || new Date()).ymd;
    let candidateCloses = null;
    try {
      const closeBlob = await readBlob(candidateCloseKey(coverageDate));
      const rows = closeBlob && Array.isArray(closeBlob.candidates) ? closeBlob.candidates : [];
      const bySportMarket = coverageBySportMarket(rows);
      const candidates = rows.length;
      const withClose = rows.filter((row) => row && row.closeNoVig != null).length;
      candidateCloses = {
        date: coverageDate,
        key: candidateCloseKey(coverageDate),
        candidates,
        withClose,
        pct: candidates ? Math.round((1000 * withClose) / candidates) / 10 : 0,
        bySportMarket,
      };
    } catch (err) {
      candidateCloses = null;
    }
    let legacyCandidates = null;
    try {
      const readLegacy = deps && typeof deps.readWithFallback === 'function'
        ? deps.readWithFallback
        : null;
      legacyCandidates = await legacyCandidateReport(deps && deps.now, readLegacy);
    } catch (err) {
      legacyCandidates = null;
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key: dateISO ? `omega-ops/capture-health-${dateISO}` : 'omega-ops/capture-health-latest',
        snapshot: snap,
        candidateCloses,
        legacyCandidates,
        note: 'Ops signal only — does not change CAPTURE_HEALTH hardFail or live pick selection.',
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message, snapshot: null }),
    };
  }
};

exports.legacyCandidateReport = legacyCandidateReport;
