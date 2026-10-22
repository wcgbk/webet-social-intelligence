'use strict';
/**
 * Daily Omega vs Omega V1 A/B comparison. READ-ONLY on both ledgers.
 * Picks: picks-{date} in edge-picks-omega and edge-picks-omega-v1ab.
 * Results: the two public results endpoints (same ESPN grading rules).
 * CLV: Omega's clv-{date} (track-clv-omega). A V1 pick gets CLV only when the
 * same pick is on Omega's card; no extra paid close pulls are made for V1.
 * Calibration: Brier + reliability buckets from V1 graded straights (calibrated p).
 */
const S = require('./lib/omega-v1ab/sharp');
const HDR = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' };

const key = (m, p) => `${String(m || '').toLowerCase()}|${String(p || '').toLowerCase()}`;
function clvMap(clv) {
  const out = new Map();
  for (const r of (clv && clv.picks) || []) {
    const v = Number(r.clvPct != null ? r.clvPct : r.clv);
    if (r && Number.isFinite(v)) out.set(key(r.matchup, r.pick), v);
  }
  return out;
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const base = process.env.URL || 'https://webetsocial.com';
  try {
    const { store } = require('./lib/omega-v1ab/blob');
    const omega = store('edge-picks-omega'); // read-only
    const ab = store(S.V1AB_STORE);          // read-only here
    const abDates = ((await ab.getJSON('picks-dates')) || []).filter(d => d >= S.V1AB_KPI_START);
    const [rO, rV] = await Promise.all([
      fetch(`${base}/api/get-results-omega?range=30`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/get-results-omega-v1?range=30`).then(r => r.json()).catch(() => null),
    ]);
    const dayOf = (res, d) => ((res && res.days) || []).find(x => x.date === d) || null;
    const calRows = [];
    const days = [];
    for (const d of abDates.slice().reverse()) {
      const [oc, vc, clv] = await Promise.all([
        omega.getJSON(`picks-${d}`), ab.getJSON(`picks-${d}`), omega.getJSON(`clv-${d}`),
      ]);
      const cm = clvMap(clv);
      const oDay = dayOf(rO, d), vDay = dayOf(rV, d);
      const vRes = new Map(((vDay && vDay.picks) || []).map(p => [key(p.matchup, p.pick), p]));
      for (const p of (vc && vc.picks) || []) {
        const r = vRes.get(key(p.matchup, p.pick));
        const y = r && r.result === 'win' ? 1 : r && r.result === 'loss' ? 0 : null;
        if (y != null && p.sharp) calRows.push({ p: p.sharp.pSharp, y });
      }
      const side = (card, day) => ({
        picks: ((card && card.picks) || []).map(p => ({ pick: p.pick, matchup: p.matchup, odds: p.odds, units: p.units, book: p.book, clvPct: cm.has(key(p.matchup, p.pick)) ? cm.get(key(p.matchup, p.pick)) : null })),
        parlay: ((card && card.parlayLegs) || []).map(l => ({ combinedOdds: l.combinedOdds, ev: l.ev, legs: (l.legs || []).map(x => x.pick) })),
        record: day ? { wins: day.wins, losses: day.losses, pushes: day.pushes, pending: day.pending, profit: day.profit } : null,
      });
      days.push({ date: d, omega: side(oc, oDay), v1: side(vc, vDay), overlap: ((vc && vc.picks) || []).filter(p => ((oc && oc.picks) || []).some(o => key(o.matchup, o.pick) === key(p.matchup, p.pick))).map(p => p.pick) });
    }
    const cum = (res) => {
      const ds = ((res && res.days) || []).filter(x => x.date >= S.V1AB_KPI_START);
      const a = ds.reduce((s, x) => ({ w: s.w + (x.wins || 0), l: s.l + (x.losses || 0), p: s.p + (x.profit || 0) + (x.parlayProfit || 0) }), { w: 0, l: 0, p: 0 });
      return { from: S.V1AB_KPI_START, wins: a.w, losses: a.l, profit: a.p };
    };
    return {
      statusCode: 200, headers: HDR,
      body: JSON.stringify({
        from: S.V1AB_KPI_START, omegaModel: 'live Omega', v1Model: S.V1AB_MODEL_VERSION,
        cumulative: { omega: cum(rO), v1: cum(rV) },
        v1Calibration: { n: calRows.length, brier: S.brierScore(calRows), reliability: S.reliabilityBuckets(calRows) },
        clvNote: 'CLV from Omega track-clv close prices; V1-only picks have no close (no extra paid pulls).',
        days,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: e.message }) };
  }
};
