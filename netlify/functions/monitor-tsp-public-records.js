'use strict';
/**
 * Daily lightweight monitor: refresh public TSP Performance Terminal summary
 * into tsp-research digests/{date}. OBSERVER ONLY — no Discord by default.
 * Isolated store — never edge-picks-omega live selection/config.
 */

const {
  downloadPublicRecords,
  buildDailyDigest,
  storeSnapshot,
  storeDigest,
  TSP_FETCH_ON_HOLD,
  BLOB_STORE,
} = require('./lib/tsp-research');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function runMonitor() {
  const date = todayET();
  console.log(`[tsp-monitor] start date=${date} blob=${BLOB_STORE} memberHold=${TSP_FETCH_ON_HOLD}`);
  const snapshot = await downloadPublicRecords();
  snapshot.date = date;
  const digest = buildDailyDigest(snapshot, { dateISO: date });
  digest.monitor = true;

  let snapshotKey = null;
  let digestKey = null;
  try {
    snapshotKey = await storeSnapshot(date, snapshot);
    digestKey = await storeDigest(date, digest);
  } catch (e) {
    console.error(`[tsp-monitor] store soft-fail: ${e.message}`);
    digest.storeError = e.message;
  }

  // Optional Discord — only if already configured
  if (process.env.TSP_RESEARCH_DISCORD_WEBHOOK && process.env.TSP_RESEARCH_DISCORD_ENABLE === 'true') {
    try {
      const lines = (digest.feeds || [])
        .slice(0, 8)
        .map((f) => {
          const s = f.summary;
          if (!s) return `• ${f.name}: ${f.error || 'n/a'}`;
          if (f.kind === 'summary') return `• ${f.name}: ${s.rows} lines`;
          return `• ${f.name}: ${s.rows} rows, W${s.wins}-L${s.losses}, ~${s.unitsApprox}u`;
        })
        .join('\n');
      await fetch(process.env.TSP_RESEARCH_DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `TSP public-records digest ${date} (observer)\n${lines}`,
        }),
      });
    } catch (e) {
      console.error(`[tsp-monitor] discord optional fail: ${e.message}`);
    }
  }

  return { date, digest, snapshotKey, digestKey };
}

exports.handler = async () => {
  try {
    const out = await runMonitor();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        date: out.date,
        snapshotKey: out.snapshotKey,
        digestKey: out.digestKey,
        okCount: out.digest.okCount,
        errors: out.digest.errors,
        blobStore: BLOB_STORE,
      }),
    };
  } catch (e) {
    console.error(`[tsp-monitor] fatal: ${e.message}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};

exports.runMonitor = runMonitor;
