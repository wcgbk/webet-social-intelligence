// get-trending-challenges.js — live feed of OPEN WeBit P2P bets anyone can join.
// Surfaces market bets (status 'open') + Pick3 challenges (status 'pending') waiting for
// an opponent, so users without a direct invite can discover and take the other side.
// Read-only. Returns a merged, recency-sorted feed for the Trending Challenges tab.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const REST_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const { getStore } = await import('@netlify/blobs');
    const cfg = { siteID: SITE_ID, token: process.env.NETLIFY_TOKEN };
    const feed = [];

    // ── Market bets (SDK store) — status 'open' ──
    try {
      const bets = getStore({ name: 'market-bets', ...cfg });
      const listing = await bets.list();
      const keys = (listing.blobs || []).map(b => b.key).filter(k => k.startsWith('mb_')).slice(0, 80);
      const rows = await Promise.all(keys.map(k => bets.get(k, { type: 'json' }).catch(() => null)));
      for (const b of rows) {
        if (!b || b.status !== 'open') continue;
        feed.push({
          type: 'market', id: b.id,
          challenger: b.challenger?.handle ? '@' + b.challenger.handle : (b.challenger?.name || 'Someone'),
          summary: b.pick, detail: b.matchup, sport: b.sport || b.league || '',
          oppositeSide: b.opponent?.side || null,
          stake: b.stake || 0, created: b.created || null,
          inviteUrl: `/p2p-sports/?bet=${b.id}`,
        });
      }
    } catch (e) { console.error('[trending] market-bets:', e.message); }

    // ── Pick3 challenges (REST store) — status 'pending' ──
    try {
      const base = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/p2p-challenges`;
      const lr = await fetch(`${base}?prefix=ch_`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } }).catch(() => null);
      if (lr && lr.ok) {
        const list = await lr.json().catch(() => ({}));
        const keys = (list.blobs || list || []).map(x => x.key || x).filter(k => typeof k === 'string' && k.startsWith('ch_')).slice(0, 60);
        const rows = await Promise.all(keys.map(k => fetch(`${base}/${k}`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } }).then(r => r.ok ? r.json() : null).catch(() => null)));
        for (const c of rows) {
          if (!c || c.status !== 'pending') continue;
          const picks = (c.challenger?.picks || []).map(p => p.side).filter(Boolean).slice(0, 3).join(' · ');
          feed.push({
            type: 'pick3', id: c.id,
            challenger: c.challenger?.handle ? '@' + c.challenger.handle : (c.challenger?.name || 'Someone'),
            summary: 'Pick 3 challenge', detail: picks || '3 picks locked', sport: 'Pick3',
            oppositeSide: null,
            stake: c.wager || 0, created: c.created || null,
            inviteUrl: `/pick3p2p/?challenge=${c.id}`,
          });
        }
      }
    } catch (e) { console.error('[trending] p2p-challenges:', e.message); }

    feed.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=30, s-maxage=30' },
      body: JSON.stringify({ generatedAt: new Date().toISOString(), count: feed.length, challenges: feed.slice(0, 24) }),
    };
  } catch (err) {
    console.error('[get-trending-challenges]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message, challenges: [] }) };
  }
};
