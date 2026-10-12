'use strict';
/**
 * Offline DraftKings-lags-Pinnacle evaluator. No network. No writes.
 *
 * Reads a replay dump (coverProb is the change-off probability), the
 * morning line path / omega-line-snap polls, and the 10:30-ish odds
 * snapshot. Lag is the production applyDkLag decision. Closing prices
 * and finals come from the replay calib inputs.
 *
 *   node tools/eval-dklag.js [--from 2026-09-26] [--to 2026-10-10]
 *                            [--label decay-eb3d277]
 *                            [--replay /workspace/omega-replay-2w]
 *
 * Prints n lag candidates, their average CLV vs the Pinnacle no-vig
 * close, the percent that beat the close, and all-candidate log-loss
 * vs the close with the change off and on.
 */
const fs = require('fs');
const path = require('path');

const WORK = path.join(__dirname, '..');
const { applyDkLag, sideRole, lockAnchor } = require(path.join(WORK, 'netlify/functions/lib/omega-vnext/dk_lag'));

const FROM_DEFAULT = '2026-09-26';
const TO_DEFAULT = '2026-10-10';
const LABEL_DEFAULT = 'decay-eb3d277';
const REPLAY_DEFAULT = '/workspace/omega-replay-2w';
const MORNING = ['0600', '0730', '0900', '0915'];

function parseArgs(argv) {
  const out = {
    from: FROM_DEFAULT,
    to: TO_DEFAULT,
    label: LABEL_DEFAULT,
    replay: REPLAY_DEFAULT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--replay') out.replay = argv[++i];
    else {
      console.error('unknown arg ' + a);
      process.exit(2);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from) || !/^\d{4}-\d{2}-\d{2}$/.test(out.to)) {
    console.error('usage: node tools/eval-dklag.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--label name] [--replay dir]');
    process.exit(2);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function slotOf(poll) {
  if (!poll) return '';
  const raw = poll.hhmm != null ? poll.hhmm : poll.slot;
  if (raw == null || raw === '') return '';
  return String(raw).padStart(4, '0');
}

function loadPolls(replay, date) {
  const blobs = path.join(replay, 'inputs', date, 'blobs');
  const bySlot = new Map();
  let pathPolls = [];
  const pathFile = path.join(blobs, 'omega-line-path', date);
  if (fs.existsSync(pathFile)) {
    try {
      const doc = readJson(pathFile);
      pathPolls = Array.isArray(doc.polls) ? doc.polls : [];
    } catch (_) {
      pathPolls = [];
    }
  }
  for (const poll of pathPolls) {
    const slot = slotOf(poll);
    if (slot && poll && poll.games) bySlot.set(slot, poll);
  }
  for (const slot of MORNING) {
    if (bySlot.has(slot)) continue;
    const snap = path.join(blobs, `omega-line-snap-${date}-${slot}`);
    if (!fs.existsSync(snap)) continue;
    try {
      const doc = readJson(snap);
      if (doc && doc.games) bySlot.set(slot, doc);
    } catch (_) { /* skip a bad snap */ }
  }
  const polls = [...bySlot.values()];
  const ordered = (pathPolls.length ? pathPolls : polls)
    .slice()
    .sort((a, b) => slotOf(a).localeCompare(slotOf(b)));
  const opener = ordered.find((p) => p && p.games) || null;
  return { polls, opener };
}

function sportOf(sport) {
  const s = String(sport || '').toUpperCase();
  if (s === 'CFB') return 'NCAAF';
  return s;
}

function loadEvents(replay, date) {
  const dir = path.join(replay, 'inputs', date, 'odds');
  const events = [];
  if (!fs.existsSync(dir)) return events;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const sport = name.replace(/\.json$/i, '').toUpperCase();
    let doc = null;
    try { doc = readJson(path.join(dir, name)); } catch (_) { doc = null; }
    for (const ev of (doc && doc.data) || []) events.push({ sport, ev });
  }
  return events;
}

function canonIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseAmerican(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return null;
    return value;
  }
  const text = String(value).trim().replace(/[−–]/g, '-');
  const match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function entryLine(row) {
  if (row.line != null && row.line !== '' && Number.isFinite(Number(row.line))) return Number(row.line);
  return null;
}

function dedupeKey(row) {
  const market = String(row.market || '').toLowerCase();
  const line = entryLine(row);
  return [
    sportOf(row.sport),
    String(row.matchup || '').toLowerCase(),
    market,
    String(row.side || row.pick || '').toLowerCase(),
    line == null ? '' : String(line),
  ].join('|');
}

function probOk(p) {
  const n = Number(p);
  return Number.isFinite(n) && n > 0 && n < 1;
}

function fmt(n, digits, signed) {
  if (n == null || !Number.isFinite(n)) return '—';
  const text = n.toFixed(digits);
  return signed && n >= 0 ? `+${text}` : text;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const match = require(path.join(args.replay, 'calib/match'));
  const math = require(path.join(args.replay, 'calib/math'));
  const finals = loadFinals(args.replay, match);
  const closeCache = new Map();

  let nLag = 0;
  let nClv = 0;
  let clvSum = 0;
  let beats = 0;
  let nLl = 0;
  let llOff = 0;
  let llOn = 0;
  let days = 0;

  for (const date of dateRange(args.from, args.to)) {
    const dumpFile = path.join(args.replay, 'out', args.label, `${date}.json`);
    if (!fs.existsSync(dumpFile)) continue;
    let dump = null;
    try { dump = readJson(dumpFile); } catch (_) { dump = null; }
    if (!dump || dump.error) continue;
    const yes = Array.isArray(dump.yes) ? dump.yes : [];
    if (!yes.length && !(dump.rejected || []).length) continue;
    days += 1;
    const { polls, opener } = loadPolls(args.replay, date);
    const events = loadEvents(args.replay, date);
    const seen = new Set();
    const rows = [];
    for (const row of yes) remember(rows, seen, row);
    for (const row of dump.rejected || []) remember(rows, seen, row);

    for (const row of rows) {
      const event = matchEvent(events, row, match);
      const role = sideRole(row);
      const line = entryLine(row);
      const anchor = (event && role) ? lockAnchor(event, role.market, role.role, line) : null;
      const stamped = {
        sport: row.sport,
        market: row.market,
        side: row.side || row.pick,
        pick: row.pick || row.side,
        line: row.line,
        odds: parseAmerican(row.odds),
        book: 'draftkings',
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        commenceTime: row.commenceTime,
        coverProb: Number(row.coverProb),
        fair_sharp_p: row.fair_sharp_p != null ? Number(row.fair_sharp_p) : null,
        pinnacleNoVigP: anchor ? anchor.p : null,
        sharpAnchorBook: anchor ? anchor.book : null,
        distribution: row.distribution,
        sigma: row.sigma,
        std: row.std,
      };
      const out = applyDkLag([stamped], { polls, opener, enabled: true })[0];
      const lag = out && out.lagEdge != null && out.lagEdge > 0;
      if (lag) nLag += 1;
      const graded = gradeRow(args.replay, row, event, finals, match, math, closeCache);
      if (lag && graded && graded.clv != null) {
        nClv += 1;
        clvSum += graded.clv;
        if (graded.clv > 0) beats += 1;
      }
      const offP = Number(row.coverProb);
      const onP = out && Number.isFinite(Number(out.coverProb)) ? Number(out.coverProb) : offP;
      if (graded && (graded.y === 0 || graded.y === 1) && probOk(offP) && probOk(onP)) {
        const a = math.logLossOne(offP, graded.y);
        const b = math.logLossOne(onP, graded.y);
        if (a != null && b != null) {
          nLl += 1;
          llOff += a;
          llOn += b;
        }
      }
    }
  }

  const avgClv = nClv ? clvSum / nClv : null;
  const pctBeat = nClv ? (100 * beats) / nClv : null;
  const meanOff = nLl ? llOff / nLl : null;
  const meanOn = nLl ? llOn / nLl : null;

  console.log(`dk-lag ${args.label} ${args.from}..${args.to} days=${days}`);
  console.log('n_lag  n_clv  avg_clv  pct_beat_close  ll_off  ll_on  n_ll');
  console.log([
    String(nLag).padStart(5),
    String(nClv).padStart(6),
    fmt(avgClv, 6, true).padStart(8),
    (pctBeat == null ? '—' : `${pctBeat.toFixed(1)}%`).padStart(15),
    fmt(meanOff, 6, false).padStart(7),
    fmt(meanOn, 6, false).padStart(6),
    String(nLl).padStart(5),
  ].join('  '));
  console.log(
    `Offline eval ${args.from.slice(0, 10)}..${args.to.slice(5)}: `
    + `n lag ${nLag}, avg CLV ${fmt(avgClv, 6, true)}, beat close ${pctBeat == null ? '—' : pctBeat.toFixed(1) + '%'}, `
    + `all-candidate LL off ${fmt(meanOff, 6, false)} on ${fmt(meanOn, 6, false)} (n=${nLl}).`,
  );
}

function remember(rows, seen, row) {
  if (!row || !(row.side || row.pick) || !row.matchup) return;
  const key = dedupeKey(row);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

function matchEvent(events, row, match) {
  const sport = sportOf(row.sport);
  const hits = events.filter((x) => x.sport === sport
    && match.sameGame(row.homeTeam, row.awayTeam, x.ev.home_team, x.ev.away_team, sport));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0].ev;
  const want = Date.parse(row.commenceTime);
  hits.sort((a, b) => Math.abs(Date.parse(a.ev.commence_time) - want) - Math.abs(Date.parse(b.ev.commence_time) - want));
  return hits[0].ev;
}

function mapEspn(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
  const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
  if (!away || !home) return null;
  const status = comp.status || ev.status || {};
  const type = status.type || {};
  const awayScore = Number.parseInt(away.score, 10);
  const homeScore = Number.parseInt(home.score, 10);
  return {
    awayTeam: (away.team && (away.team.displayName || away.team.name)) || '',
    homeTeam: (home.team && (home.team.displayName || home.team.name)) || '',
    awayScore: Number.isFinite(awayScore) ? awayScore : null,
    homeScore: Number.isFinite(homeScore) ? homeScore : null,
    state: type.state || 'pre',
    statusName: type.name || '',
    completed: !!type.completed,
    startISO: ev.date || comp.date || '',
  };
}

function loadFinals(replay, match) {
  const games = [];
  const roots = [
    path.join(replay, 'inputs/_espn-finals'),
    path.join(replay, 'inputs/_espn'),
  ];
  for (let ri = 0; ri < roots.length; ri += 1) {
    const root = roots[ri];
    const rankBase = ri === 0 ? 10 : 0;
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const sport = dir.name.startsWith('ncaaf') ? 'NCAAF'
        : dir.name === 'nfl' ? 'NFL'
          : dir.name === 'nhl' ? 'NHL'
            : dir.name === 'mlb' ? 'MLB'
              : null;
      if (!sport) continue;
      const folder = path.join(root, dir.name);
      for (const name of fs.readdirSync(folder)) {
        if (!name.endsWith('.json')) continue;
        let doc = null;
        try { doc = readJson(path.join(folder, name)); } catch (_) { doc = null; }
        for (const ev of (doc && doc.events) || []) {
          const g = mapEspn(ev);
          if (!g) continue;
          const done = g.completed && g.state === 'post' ? 3 : g.state === 'post' ? 2 : g.state === 'in' ? 1 : 0;
          games.push({ sport, game: g, rank: rankBase + done });
        }
      }
    }
  }
  games.findFinal = (sport, home, away, commence) => {
    const hits = [];
    for (const row of games) {
      if (row.sport !== sport) continue;
      if (!match.sameGame(home, away, row.game.homeTeam, row.game.awayTeam, sport)) continue;
      hits.push(row);
    }
    if (!hits.length) return null;
    const want = Date.parse(commence);
    let best = null;
    let bestDt = Infinity;
    for (const row of hits) {
      const dt = Math.abs(Date.parse(row.game.startISO) - want);
      const distance = Number.isFinite(dt) ? dt : Infinity;
      if (!best || distance < bestDt - 1 || (Math.abs(distance - bestDt) <= 1 && row.rank > best.rank)) {
        best = row;
        bestDt = distance;
      }
    }
    if (!best || bestDt > 12 * 60 * 60 * 1000) return null;
    return best.game;
  };
  return games;
}

function gradeOutcome(market, role, line, game) {
  if (!game || game.state !== 'post') return 'pending';
  if (/POSTPONED|CANCELL?ED|SUSPENDED/i.test(game.statusName || '') || !game.completed) return 'push';
  const away = game.awayScore;
  const home = game.homeScore;
  if (!Number.isFinite(away) || !Number.isFinite(home)) return 'pending';
  if (market === 'total') {
    if (!Number.isFinite(line) || (role !== 'over' && role !== 'under')) return 'pending';
    const total = away + home;
    if (total === line) return 'push';
    const over = total > line;
    return (role === 'over') === over ? 'win' : 'loss';
  }
  if (role !== 'home' && role !== 'away') return 'pending';
  const picked = role === 'away' ? away : home;
  const opp = role === 'away' ? home : away;
  if (market === 'spread') {
    if (!Number.isFinite(line)) return 'pending';
    const adj = picked + line;
    if (adj === opp) return 'push';
    return adj > opp ? 'win' : 'loss';
  }
  if (picked === opp) return 'push';
  return picked > opp ? 'win' : 'loss';
}

function loadClose(replay, sport, iso, cache) {
  const file = path.join(replay, 'inputs/_closes', sport, `${iso}.json`);
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) {
    cache.set(file, null);
    return null;
  }
  try {
    const doc = readJson(file);
    cache.set(file, doc);
    return doc;
  } catch (_) {
    cache.set(file, null);
    return null;
  }
}

function eventsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.data)) return doc.data;
  return [];
}

function findCloseEvent(doc, row, home, away, match) {
  const sport = sportOf(row.sport);
  const hits = eventsOf(doc).filter((ev) => match.sameGame(home, away, ev.home_team, ev.away_team, sport));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const want = canonIso(row.commenceTime);
  hits.sort((a, b) => Math.abs(Date.parse(a.commence_time) - Date.parse(want)) - Math.abs(Date.parse(b.commence_time) - Date.parse(want)));
  return hits[0];
}

function pinnacleBook(event) {
  return ((event && event.bookmakers) || []).find((b) => String(b.key || '').toLowerCase() === 'pinnacle') || null;
}

function sameSideName(a, b, match) {
  const norm = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm(a) === norm(b)) return true;
  return match.namesMatch(a, b, 'NFL')
    || match.namesMatch(a, b, 'NCAAF')
    || match.namesMatch(a, b, 'MLB')
    || match.namesMatch(a, b, 'NHL');
}

function pairPrice(book, market, role, home, away, line, math, match) {
  const key = market === 'ML' ? 'h2h' : market === 'spread' ? 'spreads' : 'totals';
  const block = ((book && book.markets) || []).find((m) => m.key === key) || null;
  const outcomes = (block && block.outcomes) || [];
  const devigSide = (ours, opp) => {
    if (!ours || !opp) return null;
    return math.devigTwoWay(ours.price, opp.price);
  };
  if (market === 'total') {
    const groups = new Map();
    for (const o of outcomes) {
      const pt = Number(o.point);
      if (!Number.isFinite(pt)) continue;
      const g = groups.get(String(pt)) || { point: pt };
      if (/^over$/i.test(o.name)) g.over = o;
      else if (/^under$/i.test(o.name)) g.under = o;
      groups.set(String(pt), g);
    }
    const pairs = [...groups.values()].filter((g) => g.over && g.under);
    if (!pairs.length) return null;
    const sideOf = (pair) => (role === 'under' ? pair.under : pair.over);
    const oppOf = (pair) => (role === 'under' ? pair.over : pair.under);
    const primary = pairs[0];
    const primaryDev = devigSide(sideOf(primary), oppOf(primary));
    if (!primaryDev) return null;
    const exact = Number.isFinite(Number(line))
      ? pairs.find((p) => Math.abs(p.point - Number(line)) <= 1e-6)
      : null;
    let altProb = null;
    if (exact && exact !== primary) {
      const altDev = devigSide(sideOf(exact), oppOf(exact));
      if (altDev) altProb = altDev.p1;
    }
    return { closeProb: primaryDev.p1, closeLine: primary.point, altProb };
  }
  const wantHome = role !== 'away';
  const pairs = [];
  for (const o of outcomes) {
    if (!sameSideName(o.name, home, match)) continue;
    const opp = outcomes.find((x) => sameSideName(x.name, away, match) && (
      market === 'ML' || Math.abs(Number(x.point) + Number(o.point)) <= 1e-6
    ));
    if (!opp) continue;
    pairs.push({ home: o, away: opp, point: market === 'ML' ? null : Number(o.point) });
  }
  if (!pairs.length) return null;
  const sidePoint = (pair) => {
    if (market === 'ML') return null;
    return wantHome ? pair.point : -pair.point;
  };
  const primary = pairs[0];
  const primaryDev = devigSide(wantHome ? primary.home : primary.away, wantHome ? primary.away : primary.home);
  if (!primaryDev) return null;
  const exact = market === 'ML' || !Number.isFinite(Number(line))
    ? null
    : pairs.find((p) => Math.abs(sidePoint(p) - Number(line)) <= 1e-6);
  let altProb = null;
  if (exact && exact !== primary) {
    const altDev = devigSide(wantHome ? exact.home : exact.away, wantHome ? exact.away : exact.home);
    if (altDev) altProb = altDev.p1;
  }
  return { closeProb: primaryDev.p1, closeLine: sidePoint(primary), altProb };
}

function gradeRow(replay, row, lockEvent, finals, match, math, cache) {
  const market = match.marketFamily(row.market, row.side || row.pick);
  const home = row.homeTeam;
  const away = row.awayTeam;
  const sport = sportOf(row.sport);
  const line = market === 'ML' ? null : entryLine(row);
  if (!sport || !home || !away) return null;
  const isos = [];
  const own = canonIso(row.commenceTime);
  if (own) isos.push(own);
  const lockIso = canonIso(lockEvent && lockEvent.commence_time);
  if (lockIso && !isos.includes(lockIso)) isos.push(lockIso);
  let event = null;
  for (const iso of isos) {
    const doc = loadClose(replay, sport, iso, cache);
    event = doc ? findCloseEvent(doc, row, home, away, match) : null;
    if (event) break;
  }
  if (!event) return null;
  const book = pinnacleBook(event);
  if (!book) return null;
  const role = match.roleOf(
    { sport, side: row.side, pick: row.pick || row.side },
    event.home_team || home,
    event.away_team || away,
    market,
  );
  if (!role) return null;
  const priced = pairPrice(book, market, role, event.home_team || home, event.away_team || away, line, math, match);
  if (!priced) return null;
  const resolved = math.resolveCloseProb({
    closeProb: priced.closeProb,
    altProb: priced.altProb,
    entryLine: line,
    closeLine: priced.closeLine,
    market,
    role,
    distribution: math.distributionFrom(row),
  });
  if (resolved.excluded) return null;
  const clv = math.clvProb(resolved.prob, row.odds);
  if (clv == null) return null;
  const game = finals.findFinal(sport, home, away, row.commenceTime);
  const outcome = gradeOutcome(market, role, line, game);
  const y = outcome === 'win' ? 1 : outcome === 'loss' ? 0 : null;
  return { clv, y, closeP: resolved.prob };
}

main();
