// get-kalshi-paper.js
// Serves Kalshi paper picks for /prediction-markets page.
// Paper picks = what the model WOULD bet on Kalshi, tracked without live execution.
// Sources:
//   1. kalshi-paper-picks/{date} — stored paper picks with resolution outcomes
//   2. Falls back to latest kalshi-scan data if no paper picks stored yet

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function blobGet(store, key, token) {
  try {
    const r = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.ok) return r.json();
  } catch (e) { /* skip */ }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const params = event.queryStringParameters || {};

  try {
    // ── Get today's date in ET ──
    const now = new Date();
    const estFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const [m, d, y] = estFormatter.format(now).split('/');
    const today = params.date || `${y}-${m}-${d}`;

    // ── Try stored paper picks first ──
    let paperPicks = token ? await blobGet('kalshi-paper-picks', `picks-${today}`, token) : null;

    // ── Fall back: build from latest Kalshi scan ──
    if (!paperPicks) {
      const scanData = token ? await blobGet('kalshi-scans', 'latest', token) : null;

      const opp = [
        ...(scanData?.actionableOpportunities || []),
        ...(scanData?.marginalOpportunities || []),
      ].slice(0, 10);

      paperPicks = {
        date: today,
        generatedAt: scanData?.cachedAt || now.toISOString(),
        mode: 'paper',
        source: 'kalshi-scan',
        picks: opp.map((o, i) => ({
          id: `paper-${today}-${i}`,
          sport: o.sport || 'KALSHI',
          matchup: o.matchup || o.title || '',
          ticker: o.ticker || o.eventTicker || '',
          title: o.title || '',
          pick: o.side === 'YES' ? `YES — ${o.title}` : `NO — ${o.title}`,
          side: o.side,
          kalshiSide: o.kalshiSide,
          line: o.line,
          marketPrice: o.marketPrice,
          modelProb: o.coverProb,
          edge: o.edge,
          ev: o.ev,
          kellyQuarter: o.kellyQuarter,
          tier: o.tier,
          orderbook: o.orderbook || {},
          entryPrice: o.marketPrice,
          paperUnits: o.kellyQuarter ? Math.min(3, Math.max(0.5, Math.round(o.kellyQuarter / 10 * 2) / 2)) : 0.5,
          rating: o.tier === 'actionable' ? (o.edge >= 15 ? 'A+' : o.edge >= 10 ? 'A' : 'A-') : 'B+',
          status: 'pending',
          result: null,
          exitPrice: null,
          paperPnl: null,
          commenceTime: o.commenceTime || '',
        })),
        kpis: {
          totalPicks: 0,
          wins: 0,
          losses: 0,
          pending: 0,
          winRate: null,
          paperPnl: 0,
          roi: null,
          avgEdge: opp.length ? Math.round(opp.reduce((s, o) => s + (o.edge || 0), 0) / opp.length * 10) / 10 : 0,
        },
      };

      // Compute KPIs from picks
      const resolved = paperPicks.picks.filter(p => p.result === 'win' || p.result === 'loss');
      paperPicks.kpis.totalPicks = paperPicks.picks.length;
      paperPicks.kpis.pending = paperPicks.picks.filter(p => p.status === 'pending').length;
      paperPicks.kpis.wins = resolved.filter(p => p.result === 'win').length;
      paperPicks.kpis.losses = resolved.filter(p => p.result === 'loss').length;
      paperPicks.kpis.winRate = resolved.length ? Math.round(paperPicks.kpis.wins / resolved.length * 1000) / 10 : null;
      paperPicks.kpis.paperPnl = Math.round(paperPicks.picks.reduce((s, p) => s + (p.paperPnl || 0), 0) * 100) / 100;
      paperPicks.kpis.roi = resolved.length && paperPicks.kpis.paperPnl !== 0
        ? Math.round(paperPicks.kpis.paperPnl / (resolved.length * 10) * 1000) / 10 : null;
    }

    // ── Fetch historical summary across all dates ──
    let historicalKpis = { totalPicks: 0, wins: 0, losses: 0, pending: 0, paperPnl: 0, avgEdge: 0 };
    if (token) {
      try {
        const datesBlob = await blobGet('kalshi-paper-picks', 'picks-dates', token);
        const allDates = Array.isArray(datesBlob) ? datesBlob : [];
        for (const d of allDates.slice(-30)) {
          const pd = await blobGet('kalshi-paper-picks', `picks-${d}`, token);
          if (!pd?.kpis) continue;
          historicalKpis.totalPicks += pd.kpis.totalPicks || 0;
          historicalKpis.wins += pd.kpis.wins || 0;
          historicalKpis.losses += pd.kpis.losses || 0;
          historicalKpis.pending += pd.kpis.pending || 0;
          historicalKpis.paperPnl += pd.kpis.paperPnl || 0;
          historicalKpis.avgEdge += pd.kpis.avgEdge || 0;
        }
        if (allDates.length > 0) historicalKpis.avgEdge = Math.round(historicalKpis.avgEdge / allDates.length * 10) / 10;
        historicalKpis.paperPnl = Math.round(historicalKpis.paperPnl * 100) / 100;
        const resolved = historicalKpis.wins + historicalKpis.losses;
        historicalKpis.winRate = resolved ? Math.round(historicalKpis.wins / resolved * 1000) / 10 : null;
        historicalKpis.roi = resolved && historicalKpis.paperPnl !== 0
          ? Math.round(historicalKpis.paperPnl / (resolved * 10) * 1000) / 10 : null;
      } catch (e) { /* skip */ }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ...paperPicks, historicalKpis }),
    };

  } catch (err) {
    console.error('[kalshi-paper]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
