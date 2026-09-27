// card-readiness.js
// Truthful "not ready yet" payload for the NFL / CFB cards. Before the morning cron
// writes today's blob, get-picks-nfl / get-picks-cfb used to say "No ... Games Scheduled
// For Today" even on game days. Betty (Grok Bot) and pick-promising posts need to know
// the difference between "no games" and "card not generated yet".
// status: "ready" | "pending" (games today, card not generated yet) | "no_games".

const SPORTS = {
  nfl: { label: 'NFL', path: 'football/nfl', extra: '', cron: '9:05 AM ET', readyBy: '9:20 AM ET' },
  cfb: { label: 'College Football', path: 'football/college-football', extra: '&groups=80&limit=300', cron: '9:10 AM ET', readyBy: '9:25 AM ET' },
};

function etMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = +parts.find(p => p.type === 'hour').value % 24;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

function fmtET(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
  } catch (e) { return null; }
}

async function todaysSlate(sport, dateISO) {
  const cfg = SPORTS[sport];
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/scoreboard?dates=${dateISO.replace(/-/g, '')}${cfg.extra}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.events || []).map(e => ({
      matchup: e.name || e.shortName,
      start: e.date,
      startET: fmtET(e.date),
      state: e.status && e.status.type ? e.status.type.state : null,
    }));
  } catch (e) {
    return null; // unknown: caller falls back to the old no-games payload
  } finally {
    clearTimeout(t);
  }
}

// Returns a pending payload when today has games but no card yet, else null.
async function pendingPayload(sport, dateISO, basePayload) {
  const cfg = SPORTS[sport];
  const slate = await todaysSlate(sport, dateISO);
  if (!slate || slate.length === 0) return null;
  const late = etMinutesNow() > 10 * 60 + 30; // past 10:30 ET and still no card
  const msg = late
    ? `Today's ${cfg.label} card is running late. It normally posts by about ${cfg.readyBy}.`
    : `Today's ${cfg.label} card is generated at ${cfg.cron} and posts by about ${cfg.readyBy}.`;
  return {
    ...basePayload,
    noPlays: msg,
    noGames: false,
    pending: true,
    status: 'pending',
    cardReady: false,
    readyByET: cfg.readyBy,
    gamesToday: slate.length,
    slate: slate.slice(0, 20),
  };
}

function markReady(payload) {
  const has = payload && Array.isArray(payload.picks) && payload.picks.length > 0;
  return { ...payload, status: has ? 'ready' : (payload && payload.noGames ? 'no_games' : 'ready'), cardReady: true };
}

module.exports = { pendingPayload, markReady, SPORTS };
