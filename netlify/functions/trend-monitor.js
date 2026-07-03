// trend-monitor.js
// API: GET /.netlify/functions/trend-monitor  (also /api/trend-monitor)
//
// The self-catching "negative-trend tracker." Walks the trailing window of alpha picks and
// grades EACH one independently against ESPN (full-game finals + first-5 linescores for F5) —
// it does NOT depend on the leaky track-clv write-back, so it sees every pick, settled or not.
// Then it computes realized ROI by segment (sport × market × segment × side) and raises an
// ALARM when a segment crosses the tripwire. This is the automated, general version of the
// hand-built MLB_UNDER_SKIP_TOTAL filter.
//
// DETECTION + ALARM ONLY — never changes pick generation (auto-throttle is a separate,
// env-gated follow-up). Would have flagged "MLB | moneyline | F5 | underdog" at ~40 bets.
//
// Query params (optional): ?days=60  ?minN=40  ?roi=-0.10
// Side effect: writes snapshot blob `trend-monitor-latest` to the edge-picks-alpha store.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const DEFAULTS = { days: 60, minN: 40, roi: -0.10, watchN: 20, watchRoi: -0.05 };
const Z = 1.96;
const SPORT_PATH = { MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl', WNBA: 'basketball/wnba' };
const CONCURRENCY = 8;

// ── helpers ──
const oddsNum = (o) => { const n = parseFloat((o ?? '').toString().replace(/[^\d+\-.]/g, '')); return isFinite(n) ? n : null; };
const unitsNum = (u) => parseFloat((u ?? '1u').toString().replace(/u$/i, '')) || 1;
const a2d = (a) => (a == null ? null : a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
function wilsonLower(w, n) {
  if (!n) return 0;
  const p = w / n, d = 1 + (Z * Z) / n, c = p + (Z * Z) / (2 * n);
  const m = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * n)) / n);
  return (c - m) / d;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── ESPN scoreboard ──
async function scoreboard(sport, date) {
  const path = SPORT_PATH[sport]; if (!path) return null;
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${date.replace(/-/g, '')}`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.events || []).map((e) => {
      const comp = e.competitions[0];
      return {
        completed: comp.status?.type?.completed,
        comps: comp.competitors.map((t) => ({
          loc: (t.team.location || '').toLowerCase(), name: (t.team.name || '').toLowerCase(),
          disp: (t.team.displayName || '').toLowerCase(), home: t.homeAway === 'home',
          score: +t.score, line: (t.linescores || []).map((x) => +x.value),
        })),
      };
    });
  } catch { return null; }
}
const teamMatch = (text, c) => { const t = (text || '').toLowerCase(); return (c.name && t.includes(c.name)) || (c.loc && t.includes(c.loc)) || (c.disp && t.includes(c.disp)); };
function findGame(matchup, games) { if (!games) return null; const m = (matchup || '').toLowerCase(); return games.find((g) => g.comps.every((c) => teamMatch(m, c))) || games.find((g) => g.comps.some((c) => teamMatch(m, c))); }
const f5 = (ls) => ls.slice(0, 5).reduce((a, b) => a + b, 0);

// ── parse pick text → classification + gradeable structure ──
function parse(pick) {
  const raw = (pick.pick || '').trim(), t = raw.toLowerCase();
  const bt = (pick.betType || pick.market || '').toLowerCase();
  const sport = pick.sport || 'unknown';
  const seg = /\bf5\b|first 5|1st 5|first-5/.test(t) || pick.segment === 'f5' ? 'F5' : 'full';
  const odds = oddsNum(pick.odds ?? pick.pickTimeOdds);
  let market, side, ou = null, line = null, team = null;
  if (/\bover\b/.test(t) || /\bunder\b/.test(t) || bt.includes('total')) {
    market = 'total'; ou = /\bover\b/.test(t) ? 'over' : 'under'; side = ou;
    line = parseFloat((t.match(/(over|under)\s*([0-9.]+)/) || [])[2]);
  } else {
    const body = raw.replace(/^f5\s*/i, '').replace(/\bf5\b/ig, '').replace(/^ml:\s*/i, '').trim();
    const spr = body.match(/([+-]\d+(?:\.\d+)?)\s*$/);
    if (spr && Math.abs(parseFloat(spr[1])) <= 4) { market = 'spread'; line = parseFloat(spr[1]); team = body.replace(/([+-]\d+(?:\.\d+)?)\s*$/, '').trim(); }
    else { market = 'moneyline'; team = body.replace(/\bml\b/ig, '').trim(); }
    side = odds != null ? (odds < 0 ? 'favorite' : 'underdog') : 'unknown';
  }
  return { key: `${sport} | ${market} | ${seg} | ${side}`, sport, market, seg, side, odds, ou, line, team };
}
function gradeVsEspn(p, game) {
  if (!game) return 'pending';
  const useF5 = p.seg === 'F5';
  if (useF5 && !game.comps.every((c) => c.line.length >= 5)) return 'pending';
  if (!useF5 && !game.completed) return 'pending';
  const A = game.comps.find((c) => !c.home), H = game.comps.find((c) => c.home);
  const sA = useF5 ? f5(A.line) : A.score, sH = useF5 ? f5(H.line) : H.score;
  if (p.market === 'total') { const tot = sA + sH; if (tot === p.line) return 'push'; return (p.ou === 'over') === (tot > p.line) ? 'win' : 'loss'; }
  const my = teamMatch(p.team, A) ? A : teamMatch(p.team, H) ? H : null; if (!my) return 'pending';
  const myS = my === A ? sA : sH, opS = my === A ? sH : sA;
  if (p.market === 'spread') { const adj = myS + p.line; return adj > opS ? 'win' : adj < opS ? 'loss' : 'push'; }
  return myS > opS ? 'win' : myS < opS ? 'loss' : 'push';
}

exports.handler = async (event) => {
  event = event || {}; // scheduled invocations pass no HTTP event
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  const cfg = {
    days: parseInt(q.days) || DEFAULTS.days, minN: parseInt(q.minN) || DEFAULTS.minN,
    roi: q.roi != null ? parseFloat(q.roi) : DEFAULTS.roi, watchN: DEFAULTS.watchN, watchRoi: DEFAULTS.watchRoi,
  };
  try {
    // Blob access: on-demand invocations don't get auto-injected Blobs context, so prefer the
    // REST Blobs API (api.netlify.com) with a Bearer token — the proven path get-picks-alpha
    // falls back to. Only use the SDK auto-context when no token is configured.
    const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
    const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha`;
    const auth = { Authorization: `Bearer ${token}` };
    let sdkStore = null;
    if (!token) { const { getStore } = await import('@netlify/blobs'); sdkStore = getStore('edge-picks-alpha'); }
    const bGet = async (key, asJson) => {
      if (token) { const r = await fetch(`${baseUrl}/${key}`, { headers: auth }); if (!r.ok) return null; return asJson ? r.json() : r.text(); }
      return sdkStore.get(key, asJson ? { type: 'json' } : undefined);
    };
    const bPut = async (key, obj) => {
      if (token) { await fetch(`${baseUrl}/${key}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }); return; }
      await sdkStore.setJSON(key, obj);
    };
    const latest = (await bGet('latest-date', false))?.trim();
    if (!latest) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: false, note: 'no picks yet', segments: [], alarms: [] }) };

    // 1) collect picks across the window
    const end = new Date(latest + 'T12:00:00Z');
    const picks = []; let datesSeen = 0;
    for (let i = 0; i < cfg.days; i++) {
      const dk = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
      let data; try { data = await bGet(`picks-${dk}`, true); } catch { data = null; }
      if (!data || !Array.isArray(data.picks) || !data.picks.length) continue;
      datesSeen++;
      for (const p of data.picks) picks.push({ ...p, _date: dk, _parsed: parse(p) });
    }

    // 2) grade every pick vs ESPN (concurrent scoreboard fetches, cached per sport+date)
    const sbKeys = [...new Set(picks.map((p) => `${p._parsed.sport}|${p._date}`))].filter((k) => SPORT_PATH[k.split('|')[0]]);
    const sbCache = {};
    await pool(sbKeys, CONCURRENCY, async (k) => { const [s, d] = k.split('|'); sbCache[k] = await scoreboard(s, d); });

    // 3) aggregate into segment buckets
    const buckets = {}; let settled = 0;
    for (const p of picks) {
      const c = p._parsed;
      const games = sbCache[`${c.sport}|${p._date}`];
      let res = ['win', 'loss', 'push'].includes(p.result) ? p.result : gradeVsEspn(c, findGame(p.matchup, games));
      if (res !== 'win' && res !== 'loss' && res !== 'push') continue;
      settled++;
      const b = buckets[c.key] || (buckets[c.key] = { w: 0, l: 0, pu: 0, profit: 0, risk: 0, decSum: 0, decN: 0, sport: c.sport, market: c.market, seg: c.seg, side: c.side, examples: [] });
      const u = unitsNum(p.units), dec = a2d(c.odds);
      if (res === 'win') b.w++; else if (res === 'loss') b.l++; else b.pu++;
      if (res !== 'push') { b.risk += u; b.profit += res === 'win' && dec ? u * (dec - 1) : -u; if (dec) { b.decSum += dec; b.decN++; } }
      if (res === 'loss' && b.examples.length < 3) b.examples.push(`${p._date}: ${p.pick} (${p.matchup})`);
    }

    // 4) stats + tripwire
    const segments = Object.entries(buckets).map(([key, b]) => {
      const decisive = b.w + b.l, winRate = decisive ? b.w / decisive : 0;
      const avgDec = b.decN ? b.decSum / b.decN : null, breakeven = avgDec ? 1 / avgDec : null;
      const roi = b.risk ? b.profit / b.risk : null, wLow = wilsonLower(b.w, decisive);
      let status = 'ok';
      if (decisive >= cfg.minN && roi != null && roi <= cfg.roi && breakeven != null && wLow < breakeven) status = 'ALARM';
      else if (decisive >= cfg.watchN && roi != null && roi <= cfg.watchRoi) status = 'watch';
      return {
        key, sport: b.sport, market: b.market, segment: b.seg, side: b.side,
        record: `${b.w}-${b.l}${b.pu ? '-' + b.pu : ''}`, decisive, winRatePct: +(winRate * 100).toFixed(1),
        roiPct: roi != null ? +(roi * 100).toFixed(1) : null, unitsPL: +b.profit.toFixed(2),
        avgOdds: avgDec ? +avgDec.toFixed(2) : null, breakevenPct: breakeven != null ? +(breakeven * 100).toFixed(1) : null,
        wilsonLowPct: +(wLow * 100).toFixed(1), status, losingExamples: b.examples,
      };
    }).sort((a, b) => (a.roiPct ?? 0) - (b.roiPct ?? 0));

    const alarms = segments.filter((s) => s.status === 'ALARM');
    const watch = segments.filter((s) => s.status === 'watch');
    const payload = {
      error: false, generatedFor: latest, gradedVia: 'espn-independent',
      window: { days: cfg.days, datesSeen, picksGraded: settled },
      tripwire: { minN: cfg.minN, roi: cfg.roi },
      alarmCount: alarms.length, watchCount: watch.length, alarms, watch, segments,
    };
    try { await bPut('trend-monitor-latest', payload); } catch (e) { console.error('[trend-monitor] snapshot write failed:', e.message); }
    if (alarms.length) console.warn(`[trend-monitor] ${alarms.length} ALARM(s):`, alarms.map((a) => `${a.key} ROI=${a.roiPct}% n=${a.decisive}`).join(' | '));

    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=600' }, body: JSON.stringify(payload) };
  } catch (err) {
    console.error('[trend-monitor] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message }) };
  }
};
