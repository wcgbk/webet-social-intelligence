// market-bet.js — WeBit-escrowed head-to-head P2P market bets (BettorEdge methodology, free WeBit version)
// One user takes a single market line (ML / spread / total) and stakes WeBits; a friend takes the
// OTHER side and matches the stake. Winner takes the pot, graded vs the final score (see
// market-bet-settle.js). Delivery via X DM or text. Built to later swap to real-money BettorEdge.
//
// Actions (POST): create | accept     ·     Reads (GET): ?id=  |  ?mine= (session)
// Escrow reuses webit-ledger (evt_{userId}_mbstake_{betId}); bets live in the `market-bets` store.

const { createHmac } = require('crypto');

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  str.split(';').forEach(p => { const i = p.indexOf('='); if (i < 0) return; const k = p.slice(0, i).trim(); try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch { out[k] = p.slice(i + 1).trim(); } });
  return out;
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const MIN_STAKE = 0, MAX_STAKE = 1000;

function genId() { const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = 'mb_'; for (let i = 0; i < 10; i++) s += c[Math.floor(((Date.now() + i * 7919) % c.length))]; return s + Math.floor((Date.now() % 9000) + 1000).toString(36); }

// Opposite side label for the opponent's display
function oppositeSide(market, side, pick, matchup) {
  if (market === 'total') return side === 'over' ? 'Under' : 'Over';
  // ml/spread: flip the team. matchup = "Away vs Home"
  const parts = String(matchup || '').split(/\s+vs\.?\s+/i);
  const away = (parts[0] || '').trim(), home = (parts[1] || '').trim();
  const pickedHome = side === 'home';
  const other = pickedHome ? away : home;
  return other || 'Other side';
}

async function sendSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM;
  if (!sid || !tok || !from || !to) return false;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    return r.ok;
  } catch { return false; }
}
function normPhone(raw) { const d = String(raw || '').replace(/[^\d+]/g, ''); if (/^\+\d{10,15}$/.test(d)) return d; const n = d.replace(/\D/g, ''); if (n.length === 10) return '+1' + n; if (n.length === 11 && n[0] === '1') return '+' + n; return null; }

async function getSessionUser(stores, cookieHeader) {
  const sid = parseCookies(cookieHeader)['wbai_session'];
  if (!sid) return null;
  const s = await stores.users.get(`session_${sid}`, { type: 'json' }).catch(() => null);
  if (!s || !s.user_id || (s.expires && Date.now() > s.expires)) return null;
  const rec = await stores.users.get(`user_${s.user_id}`, { type: 'json' }).catch(() => null);
  if (!rec) return null;
  return { id: s.user_id, rec };
}

// Idempotent escrow: one ledger event per (user, bet). Debits credit_balance.
async function escrow(stores, userId, betId, amount) {
  if (amount <= 0) return { ok: true, balance: undefined };
  const key = `evt_${userId}_mbstake_${betId}`;
  const existing = await stores.ledger.get(key, { type: 'json' }).catch(() => null);
  const rec = await stores.users.get(`user_${userId}`, { type: 'json' }).catch(() => null);
  if (existing) return { ok: true, already: true, balance: rec ? rec.credit_balance : undefined };
  const bal = rec ? (rec.credit_balance ?? 1000) : 0;
  if (bal < amount) return { ok: false, error: 'insufficient_webits', balance: bal };
  await stores.ledger.setJSON(key, { userId, delta: -amount, reason: 'market_bet_stake', betId, ts: new Date().toISOString() });
  rec.credit_balance = bal - amount;
  await stores.users.setJSON(`user_${userId}`, rec);
  return { ok: true, balance: rec.credit_balance };
}

async function indexAdd(stores, userId, betId) {
  const k = `idx_${userId}`;
  const idx = (await stores.bets.get(k, { type: 'json' }).catch(() => null)) || { bets: [] };
  if (!idx.bets.includes(betId)) { idx.bets.unshift(betId); idx.bets = idx.bets.slice(0, 60); await stores.bets.setJSON(k, idx); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const { getStore } = await import('@netlify/blobs');
  const cfg = { siteID: SITE_ID, token: process.env.NETLIFY_TOKEN };
  const stores = {
    users: getStore({ name: 'wbai-users', ...cfg }),
    ledger: getStore({ name: 'webit-ledger', ...cfg }),
    bets: getStore({ name: 'market-bets', ...cfg }),
  };

  // ── READS ──
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.id) {
      const bet = await stores.bets.get(String(q.id), { type: 'json' }).catch(() => null);
      return bet ? { statusCode: 200, headers: CORS, body: JSON.stringify(bet) } : { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };
    }
    // ?mine= : the signed-in user's bets
    const u = await getSessionUser(stores, event.headers.cookie || event.headers.Cookie);
    if (!u) return { statusCode: 200, headers: CORS, body: JSON.stringify({ bets: [] }) };
    const idx = (await stores.bets.get(`idx_${u.id}`, { type: 'json' }).catch(() => null)) || { bets: [] };
    const bets = [];
    for (const id of idx.bets.slice(0, 30)) { const b = await stores.bets.get(id, { type: 'json' }).catch(() => null); if (b) bets.push(b); }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ bets }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
  const u = await getSessionUser(stores, event.headers.cookie || event.headers.Cookie);
  if (!u) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };
  const myHandle = u.rec.handle || null, myName = u.rec.name || u.rec.handle || 'Member';

  // ── CREATE ──
  if (body.action === 'create') {
    const stake = Math.min(MAX_STAKE, Math.max(MIN_STAKE, parseInt(body.stake, 10) || 0));
    const market = ['ml', 'spread', 'total'].includes(body.market) ? body.market : 'ml';
    const side = String(body.side || '').slice(0, 8);
    const pick = String(body.pick || '').slice(0, 80);
    const matchup = String(body.matchup || body.event || '').slice(0, 120);
    if (!pick || !matchup) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing_fields' }) };
    const deliver = body.deliver === 'sms' ? 'sms' : 'link';
    const friendPhone = deliver === 'sms' ? normPhone(body.friendPhone) : null;
    if (deliver === 'sms' && !friendPhone) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_phone' }) };

    const betId = genId();
    if (stake > 0) {
      const e = await escrow(stores, u.id, betId, stake);
      if (!e.ok) return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: e.error, balance: e.balance, stake }) };
    }

    const bet = {
      id: betId, type: 'market', status: 'open',
      sport: String(body.sport || '').slice(0, 12), league: String(body.league || '').slice(0, 24),
      event: String(body.event || matchup).slice(0, 120), matchup,
      market, side, pick, line: Number(body.line) || 0, odds: Number(body.odds) || 0,
      date: new Date().toISOString().slice(0, 10),
      stake,
      challenger: { identity: u.id, handle: myHandle, name: myName, side, pick },
      opponent: { identity: null, handle: null, name: null, side: oppositeSide(market, side, pick, matchup) },
      deliver, created: new Date().toISOString(), responded: null, graded: null,
    };
    await stores.bets.setJSON(betId, bet);
    await indexAdd(stores, u.id, betId);

    const inviteUrl = `https://webetsocial.com/p2p-sports/?bet=${betId}`;
    const stakeLbl = stake > 0 ? `${stake} WeBits` : 'bragging rights';
    if (deliver === 'sms' && friendPhone) {
      await sendSMS(friendPhone, `${myName} bet you on WeBetAI: ${pick} (${matchup}) for ${stakeLbl}. Take the other side: ${inviteUrl}`);
    }
    const balRec = await stores.users.get(`user_${u.id}`, { type: 'json' }).catch(() => null);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, betId, inviteUrl, balance: balRec ? balRec.credit_balance : undefined, oppositeSide: bet.opponent.side }) };
  }

  // ── ACCEPT (take the other side) ──
  if (body.action === 'accept') {
    const betId = String(body.betId || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
    const bet = await stores.bets.get(betId, { type: 'json' }).catch(() => null);
    if (!bet) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };
    if (bet.status !== 'open') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'already_taken' }) };
    if (bet.challenger.identity === u.id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'own_bet' }) };

    if (bet.stake > 0) {
      const e = await escrow(stores, u.id, betId, bet.stake);
      if (!e.ok) return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: e.error, balance: e.balance, stake: bet.stake }) };
    }
    bet.opponent = { identity: u.id, handle: myHandle, name: myName, side: bet.opponent.side };
    bet.status = 'active';
    bet.responded = new Date().toISOString();
    await stores.bets.setJSON(betId, bet);
    await indexAdd(stores, u.id, betId);

    const balRec = await stores.users.get(`user_${u.id}`, { type: 'json' }).catch(() => null);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, betId, balance: balRec ? balRec.credit_balance : undefined, pot: bet.stake * 2 }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'unknown_action' }) };
};
