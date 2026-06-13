// p2p-settle.js — grade Pick3P2P challenges + settle WeBit stakes (loop-c9, "finish pick3p2p")
// POST {challengeId} or {identity} (settles that user's due challenges). Idempotent:
// a settle marker blob per challenge guards double-payouts. Called lazily from the
// pick3p2p page on load — no cron needed (netlify.toml stays untouched/protected).
//
// Grading v1: team-name picks grade as "did that team win" (ML-style — spread cushions
// are approximated as ML; noted limitation), Over/Under picks grade against the final
// total. Winner = best record of 3 graded picks. Tie or expired/unanswered → refund.

const CORS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const REST_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;

const ESPN = {
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
};

// p2p-challenges store is written by p2p-challenge.js via the blobs REST API — read it the same way.
async function restGet(store, key) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, { headers: { Authorization: `Bearer ${REST_TOKEN}` } }).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}
async function restPut(store, key, val) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, { method: 'PUT', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(val) }).catch(() => null);
}

function identityToLedgerUserId(identity) {
  const s = String(identity || '');
  if (s.startsWith('wbai:')) return s.slice(5);
  const digits = s.replace(/\D/g, '');
  return digits ? 'sms_' + digits : null;
}

async function fetchScores(sport, dateISO) {
  const url = ESPN[sport];
  if (!url) return [];
  const ymd = dateISO.replace(/-/g, '');
  const r = await fetch(`${url}?dates=${ymd}`).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  return ((j && j.events) || []).map(ev => {
    const comp = (ev.competitions || [])[0] || {};
    const done = comp.status && comp.status.type && comp.status.type.completed;
    const teams = (comp.competitors || []).map(c => ({ name: (c.team || {}).displayName || '', score: parseFloat(c.score || 0), winner: !!c.winner }));
    return { done, teams, total: teams.reduce((s, t) => s + t.score, 0) };
  });
}

function gradePick(pick, gamesBySport) {
  const games = gamesBySport[pick.sport] || [];
  const side = String(pick.side || '').trim();
  const ou = side.match(/^(over|under)\s+([\d.]+)/i);
  // find the game by matchup team names
  const matchTeams = String(pick.matchup || '').split(/\s*@\s*|\s+vs\.?\s+/i).map(t => t.trim().toLowerCase()).filter(Boolean);
  const game = games.find(g => matchTeams.every(mt => g.teams.some(t => t.name.toLowerCase().includes(mt.split(' ').pop()) || mt.includes(t.name.toLowerCase().split(' ').pop()))));
  if (!game || !game.done) return null; // not gradeable yet
  if (ou) {
    const line = parseFloat(ou[2]);
    if (game.total === line) return 'push';
    return (ou[1].toLowerCase() === 'over' ? game.total > line : game.total < line) ? 'win' : 'loss';
  }
  // team-name pick → did that team win (ML-style; spreads approximated)
  const team = game.teams.find(t => t.name.toLowerCase().includes(side.toLowerCase().split(' ').pop()) || side.toLowerCase().includes(t.name.toLowerCase().split(' ').pop()));
  if (!team) return null;
  return team.winner ? 'win' : 'loss';
}

async function settleChallenge(challengeId, getStore) {
  const ch = await restGet('p2p-challenges', challengeId);
  if (!ch || !ch.id) return { challengeId, result: 'not_found' };
  if (ch.settled) return { challengeId, result: 'already_settled', outcome: ch.settled.outcome };

  const ageDays = (Date.now() - new Date(ch.created).getTime()) / 86400000;
  const ledger = getStore({ name: 'webit-ledger', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
  const users = getStore({ name: 'wbai-users', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });

  // collect escrows for this challenge
  const escrows = [];
  for (const who of [ch.challenger, ch.opponent]) {
    const uid = identityToLedgerUserId(who && who.phone);
    if (!uid) continue;
    const evt = await ledger.get(`evt_${uid}_p2pstake_${challengeId}`, { type: 'json' }).catch(() => null);
    if (evt && evt.delta < 0) escrows.push({ uid, amount: -evt.delta, side: who === ch.challenger ? 'challenger' : 'opponent' });
  }

  async function credit(uid, amount, reason) {
    const key = `evt_${uid}_${reason}_${challengeId}`;
    const dup = await ledger.get(key, { type: 'json' }).catch(() => null);
    if (dup) return;
    await ledger.setJSON(key, { userId: uid, delta: amount, reason, challengeId, ts: new Date().toISOString() });
    const rec = await users.get(`user_${uid}`, { type: 'json' }).catch(() => null);
    if (rec) { rec.credit_balance = (rec.credit_balance ?? 1000) + amount; await users.setJSON(`user_${uid}`, rec); }
  }

  // Expired: pending (never answered) past 2 days → refund any escrow
  if (ch.status === 'pending') {
    if (ageDays < 2) return { challengeId, result: 'awaiting_opponent' };
    for (const e of escrows) await credit(e.uid, e.amount, 'p2prefund');
    ch.status = 'expired';
    ch.settled = { outcome: 'expired_refund', at: new Date().toISOString(), refunded: escrows.map(e => e.uid) };
    await restPut('p2p-challenges', challengeId, ch);
    return { challengeId, result: 'expired_refund', refunded: escrows.length };
  }

  if (ch.status !== 'active' && ch.status !== 'graded') return { challengeId, result: 'not_active' };

  // Grade both sides
  const sports = [...new Set([...(ch.challenger.picks || []), ...(ch.opponent.picks || [])].map(p => p.sport).filter(Boolean))];
  const gamesBySport = {};
  for (const s of sports) gamesBySport[s] = await fetchScores(s, ch.date);

  let allGraded = true;
  const records = { challenger: 0, opponent: 0 };
  for (const sideKey of ['challenger', 'opponent']) {
    for (const p of (ch[sideKey].picks || [])) {
      const res = p.result || gradePick(p, gamesBySport);
      if (!res) { allGraded = false; continue; }
      p.result = res;
      if (res === 'win') records[sideKey]++;
    }
  }
  if (!allGraded) {
    await restPut('p2p-challenges', challengeId, ch); // persist partial grading
    return { challengeId, result: 'games_not_final' };
  }

  // Decide + settle
  ch.status = 'graded';
  ch.graded = new Date().toISOString();
  const pot = escrows.reduce((s, e) => s + e.amount, 0);
  let outcome;
  if (records.challenger === records.opponent) {
    for (const e of escrows) await credit(e.uid, e.amount, 'p2prefund');
    outcome = 'tie_refund';
  } else {
    const winnerSide = records.challenger > records.opponent ? 'challenger' : 'opponent';
    const winnerUid = identityToLedgerUserId(ch[winnerSide].phone);
    if (winnerUid && pot > 0) await credit(winnerUid, pot, 'p2ppayout');
    outcome = winnerSide + '_wins';
    ch.winner = winnerSide;
  }
  ch.settled = { outcome, pot, records, at: new Date().toISOString() };
  await restPut('p2p-challenges', challengeId, ch);
  return { challengeId, result: 'settled', outcome, pot, records };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  try {
    const { getStore } = await import('@netlify/blobs');
    const results = [];

    if (body.challengeId) {
      results.push(await settleChallenge(String(body.challengeId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64), getStore));
    } else if (body.identity) {
      // settle all due challenges for one user (page-load hook)
      const digits = String(body.identity).replace(/\D/g, '');
      const idx = await restGet('p2p-challenges', 'index-' + digits);
      const ids = ((idx && idx.challenges) || []).slice(0, 10);
      for (const id of ids) results.push(await settleChallenge(id, getStore));
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'need challengeId or identity' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error('[p2p-settle] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
