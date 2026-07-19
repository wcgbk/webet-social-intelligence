// ONE-OFF maintenance: correct the doubleheader "Game 1" mislabel in the 2026-07-19 Dodgers@Yankees
// Under pick (it's the Game 2 nightcap — Schlittler/Yamamoto). Idempotent, tightly scoped, and
// removed from the repo immediately after a single invocation. Gated on a confirm token.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

const DATE = '2026-07-19';
const EDITS = [
  { field: 'coreReasoning', pickIdx: 2,
    find: 'the pitching quality on the mound for Game 1 is the real story',
    repl: "the pitching quality on the mound in tonight's Game 2 nightcap is the real story" },
  { field: 'dataVerified', pickIdx: 2,
    find: 'as Game 1 starters',
    repl: 'as the Game 2 (nightcap) starters' },
  { field: 'edgeSummary', top: true,
    find: 'square off in a rain-makeup game',
    repl: 'square off in the nightcap of a rain-makeup doubleheader' },
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== 'game2-nightcap-fix') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'confirm token required' }) };
  }
  try {
    const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'no token' }) };
    const auth = { 'Authorization': `Bearer ${token}` };
    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha/picks-${DATE}`;

    const resp = await fetch(url, { headers: auth });
    if (!resp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'blob fetch failed', status: resp.status }) };
    const blob = await resp.json();

    // Guard: the target pick must actually be the Yankees Under (don't edit a shifted card).
    const p = (blob.picks || [])[2] || {};
    if (!/Yankees/i.test(p.matchup || '') || !/Under/i.test(p.pick || '')) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'pick[2] is not the Yankees Under', got: { matchup: p.matchup, pick: p.pick } }) };
    }

    const report = [];
    for (const e of EDITS) {
      const target = e.top ? blob : (blob.picks || [])[e.pickIdx];
      if (!target || typeof target[e.field] !== 'string') { report.push({ ...e, status: 'field-missing' }); continue; }
      const before = target[e.field];
      if (before.includes(e.repl) && !before.includes(e.find)) { report.push({ field: e.field, status: 'already-applied' }); continue; }
      if (!before.includes(e.find)) { report.push({ field: e.field, status: 'find-not-found' }); continue; }
      target[e.field] = before.split(e.find).join(e.repl);
      report.push({ field: e.field, status: 'replaced' });
    }

    const changed = report.some(r => r.status === 'replaced');
    if (changed) {
      const put = await fetch(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(blob) });
      if (!put.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'blob write failed', status: put.status, report }) };
      // Bust the results cache so the /alpha page re-reads fresh (harmless if key differs).
      try { await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha/results-alpha-cache-v5`, { method: 'DELETE', headers: auth }); } catch (e) {}
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ changed, report,
      coreReasoning: (blob.picks[2].coreReasoning || '').slice(0, 420),
      dataVerified: blob.picks[2].dataVerified,
      edgeSummary: (blob.edgeSummary || '').slice(0, 300) }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
