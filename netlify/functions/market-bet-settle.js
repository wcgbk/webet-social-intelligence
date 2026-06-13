// market-bet-settle.js — grade a P2P market bet vs the final score, settle WeBit stakes.
// POST {betId} or {mine} (settles the signed-in user's due bets). Idempotent (settle marker +
// per-event ledger keys). Grades the CHALLENGER's line (ML/spread/total); opponent is the inverse.
// Winner takes the pot; push/tie or expired-unaccepted bets refund. Lazy-called from the page.

function parseCookies(str) { const o = {}; if (!str) return o; str.split(';').forEach(p => { const i = p.indexOf('='); if (i < 0) return; const k = p.slice(0, i).trim(); try { o[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch { o[k] = p.slice(i + 1).trim(); } }); return o; }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const ESPN = {
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
};

async function fetchScores(sport, dateISO) {
  const url = ESPN[sport];
  if (!url) return [];
  const ymd = (dateISO || '').replace(/-/g, '');
  const r = await fetch(`${url}?dates=${ymd}`).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  return ((j && j.events) || []).map(ev => {
    const c = (ev.competitions || [])[0] || {};
    const done = c.status && c.status.type && c.status.type.completed;
    const teams = (c.competitors || []).map(x => ({ name: (x.team || {}).displayName || '', score: parseFloat(x.score || 0), winner: !!x.winner, homeAway: x.homeAway }));
    return { done, teams, total: teams.reduce((s, t) => s + t.score, 0) };
  });
}

function findGame(bet, games) {
  const parts = String(bet.matchup || '').split(/\s+vs\.?\s+|\s+@\s+/i).map(s => s.trim().toLowerCase()).filter(Boolean);
  return games.find(g => parts.every(mt => g.teams.some(t => { const tn = t.name.toLowerCase(); const last = tn.split(' ').pop(); return tn.includes(mt) || mt.includes(last) || mt.split(' ').pop() === last; })));
}

// Grade the challenger's line. Returns 'win' | 'loss' | 'push' | null(not gradeable yet)
function gradeChallenger(bet, game) {
  if (!game || !game.done) return null;
  if (bet.market === 'total') {
    if (!bet.line) return null;
    if (game.total === bet.line) return 'push';
    return (bet.side === 'over' ? game.total > bet.line : game.total < bet.line) ? 'win' : 'loss';
  }
  // ml / spread: identify the picked team from side (home/away) or pick text
  let team = null;
  if (bet.side === 'home' || bet.side === 'away') team = game.teams.find(t => t.homeAway === bet.side);
  if (!team) { const pl = String(bet.pick || '').toLowerCase().split(' ').pop(); team = game.teams.find(t => t.name.toLowerCase().split(' ').pop() === pl || t.name.toLowerCase().includes(pl)); }
  if (!team) return null;
  const other = game.teams.find(t => t !== team);
  if (bet.market === 'spread' && bet.line) {
    const margin = team.score - (other ? other.score : 0);
    const adj = margin + Number(bet.line); // line is the picked team's spread (e.g. +5.5)
    if (adj === 0) return 'push';
    return adj > 0 ? 'win' : 'loss';
  }
  // moneyline
  return team.winner ? 'win' : 'loss';
}

async function settleOne(stores, betId) {
  const bet = await stores.bets.get(betId, { type: 'json' }).catch(() => null);
  if (!bet) return { betId, result: 'not_found' };
  if (bet.settled) return { betId, result: 'already_settled', outcome: bet.settled.outcome };

  const ageDays = (Date.now() - new Date(bet.created).getTime()) / 86400000;

  async function credit(uid, amount, reason) {
    if (!uid || amount <= 0) return;
    const key = `evt_${uid}_${reason}_${betId}`;
    if (await stores.ledger.get(key, { type: 'json' }).catch(() => null)) return;
    await stores.ledger.setJSON(key, { userId: uid, delta: amount, reason, betId, ts: new Date().toISOString() });
    const rec = await stores.users.get(`user_${uid}`, { type: 'json' }).catch(() => null);
    if (rec) { rec.credit_balance = (rec.credit_balance ?? 1000) + amount; await stores.users.setJSON(`user_${uid}`, rec); }
  }
  const refund = async () => { if (bet.stake > 0) { await credit(bet.challenger.identity, bet.stake, 'mbrefund'); if (bet.opponent.identity) await credit(bet.opponent.identity, bet.stake, 'mbrefund'); } };

  // Open + unaccepted past 2 days → refund challenger
  if (bet.status === 'open') {
    if (ageDays < 2) return { betId, result: 'awaiting_opponent' };
    if (bet.stake > 0) await credit(bet.challenger.identity, bet.stake, 'mbrefund');
    bet.status = 'expired'; bet.settled = { outcome: 'expired_refund', at: new Date().toISOString() };
    await stores.bets.setJSON(betId, bet);
    return { betId, result: 'expired_refund' };
  }
  if (bet.status !== 'active') return { betId, result: 'not_active' };

  const games = await fetchScores(bet.sport, bet.date);
  const game = findGame(bet, games);
  const grade = gradeChallenger(bet, game);
  if (!grade) return { betId, result: 'game_not_final' };

  bet.status = 'graded'; bet.graded = new Date().toISOString(); bet.challengerResult = grade;
  const pot = bet.stake * 2;
  let outcome;
  if (grade === 'push') { await refund(); outcome = 'push_refund'; }
  else {
    const winnerUid = grade === 'win' ? bet.challenger.identity : bet.opponent.identity;
    if (winnerUid && pot > 0) await credit(winnerUid, pot, 'mbpayout');
    bet.winner = grade === 'win' ? 'challenger' : 'opponent';
    outcome = bet.winner + '_wins';
  }
  bet.settled = { outcome, pot, at: new Date().toISOString() };
  await stores.bets.setJSON(betId, bet);
  return { betId, result: 'settled', outcome, pot };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
  const { getStore } = await import('@netlify/blobs');
  const cfg = { siteID: SITE_ID, token: process.env.NETLIFY_TOKEN };
  const stores = { users: getStore({ name: 'wbai-users', ...cfg }), ledger: getStore({ name: 'webit-ledger', ...cfg }), bets: getStore({ name: 'market-bets', ...cfg }) };

  try {
    const results = [];
    if (body.betId) {
      results.push(await settleOne(stores, String(body.betId).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40)));
    } else if (body.mine) {
      const sid = parseCookies(event.headers.cookie || event.headers.Cookie)['wbai_session'];
      const s = sid ? await stores.users.get(`session_${sid}`, { type: 'json' }).catch(() => null) : null;
      if (!s || !s.user_id) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, results: [] }) };
      const idx = (await stores.bets.get(`idx_${s.user_id}`, { type: 'json' }).catch(() => null)) || { bets: [] };
      for (const id of idx.bets.slice(0, 15)) results.push(await settleOne(stores, id));
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'need betId or mine' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error('[market-bet-settle]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
