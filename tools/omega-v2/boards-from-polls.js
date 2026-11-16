// Offline 10 AM board from a 3-book polls-DATE.json.
// No network. Does not read secrets. Does not write a live picks key.
//
//   node tools/omega-v2/boards-from-polls.js --from YYYY-MM-DD --to YYYY-MM-DD --out-dir DIR
//   node tools/omega-v2/boards-from-polls.js --validate --out-dir DIR
//
// Each row is the best DraftKings or Hard Rock price on one side and number
// (higher American, DraftKings on a tie). Fair is live sharpQuoteForSide:
// power no-vig
// (noVigTwoWay) when Pinnacle posts both sides of that same number.
// coverProb and pCalRaw equal that fair. pModel is null. The longshot
// penalty is not baked in. select.annotateCandidate applies it
// (OMEGA_V2_LONGSHOT_ADJ, default on) on top of the market price
// (OMEGA_V2_MARKET_P, default on), which is the live bet probability.
// Baking it here would subtract it twice.
//
// No Pinnacle same-line two-way: the row is still emitted. pMkt is whatever
// sharpQuoteForSide returns from this poll (DK/HR multiplicative consensus,
// fairSource "missing-sharp"). BetOnline and the rest of the stored-board
// consensus are not in these polls, so that fallback is not the number the
// morning board stored. Replay with OMEGA_V2_PINNACLE_FAIR on still
// overwrites pMkt when the live fairAt path finds a Pinnacle (or converted)
// pair, and keeps this value only as the stored-fair fallback.
// MLB and any other non-model sport are omitted.
'use strict';

const fs = require('fs');
const path = require('path');

const WT = path.resolve(__dirname, '../..');
const edge = require(path.join(WT, 'netlify/functions/lib/omega-vnext/edge'));
const { formatAmerican } = require(path.join(WT, 'netlify/functions/lib/omega-vnext/odds_math'));
const { sportOf } = require(path.join(WT, 'netlify/functions/lib/omega-v2/key_convert'));
const { MODEL_SPORTS, MODEL_VERSION } = require(path.join(WT, 'netlify/functions/lib/omega-v2/constants'));

const POLL_DIR = process.env.OMEGA_V2_POLL_DIR || '/workspace/sharp-fix-1115/data';
const STORED_DIR = '/workspace/force3-1113/lowpay/b2';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MARKETS = [
  { key: 'h2h', family: 'Moneyline' },
  { key: 'spreads', family: 'Spread' },
  { key: 'totals', family: 'Total' },
];
const PLACE_ORDER = ['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh'];
const PLACES = new Set(PLACE_ORDER);

/**
 * Best DK/HR American price. Higher American wins, same rule as
 * bestDkHrPrice. Equal prices take the earlier book in PLACE_ORDER.
 * The polls list Hard Rock before DraftKings, and bestDkHrPrice keeps
 * whichever row it sees first, so an equal price was landing on Hard Rock.
 * Stored morning boards keep DraftKings on that tie. The number is the same.
 */
function bestPlaceable(prices) {
  let best = null;
  let rank = PLACE_ORDER.length;
  for (const p of prices || []) {
    const book = String(p && p.book || '').toLowerCase();
    const r = PLACE_ORDER.indexOf(book);
    if (r < 0) continue;
    const american = Number(p.american);
    if (!Number.isFinite(american) || american === 0) continue;
    if (!best || american > best.american || (american === best.american && r < rank)) {
      best = { book, american };
      rank = r;
    }
  }
  return best;
}

function nextDate(iso) {
  const t = Date.parse(`${iso}T12:00:00Z`) + 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function dateRange(from, to) {
  if (!YMD.test(from) || !YMD.test(to) || from > to) {
    throw new Error(`bad range ${from}..${to}`);
  }
  const out = [];
  for (let cur = from; cur <= to; cur = nextDate(cur)) out.push(cur);
  return out;
}

function pointText(n) {
  const x = Number(n);
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(x);
}

function lineNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (Math.abs(x - Math.round(x)) < 1e-9) return Math.round(x);
  return x;
}

function sideLabel(family, bundle) {
  const name = bundle && bundle.side != null ? String(bundle.side) : '';
  if (family === 'Total') {
    return bundle.point == null ? name : `${name} ${pointText(bundle.point)}`;
  }
  if (family === 'Spread') {
    if (bundle.point == null) return name;
    const n = Number(bundle.point);
    const text = pointText(Math.abs(n));
    const signed = n > 0 ? `+${text}` : (n < 0 ? `-${text}` : '0');
    return `${name} ${signed}`;
  }
  return name;
}

function loadPoll(date) {
  const file = path.join(POLL_DIR, `polls-${date}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildBoard(date, pollDoc) {
  const events = (pollDoc && (pollDoc['1000'] || pollDoc[1000])) || [];
  const rows = [];
  const seen = new Set();
  let pinnacleFair = 0;
  let missingSharp = 0;
  let omitted = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const sport = sportOf(ev.sport || ev.sport_key);
    if (!MODEL_SPORTS.includes(sport)) {
      omitted += 1;
      continue;
    }
    const away = ev.away_team || ev.awayTeam || '';
    const home = ev.home_team || ev.homeTeam || '';
    if (!away || !home) continue;
    const matchup = `${away} @ ${home}`;
    const commenceTime = ev.commence_time || ev.commenceTime || '';
    for (const market of MARKETS) {
      const bundles = edge.collectMarketOutcomes(ev, market.key);
      for (const side of bundles) {
        const dk = bestPlaceable(side.prices);
        if (!dk) {
          omitted += 1;
          continue;
        }
        const quote = edge.sharpQuoteForSide(bundles, side.side, side.point);
        const p = quote ? Number(quote.p) : NaN;
        if (!(p > 0 && p < 1)) {
          omitted += 1;
          continue;
        }
        const pinn = quote.book === 'pinnacle' && quote.devig === 'power';
        if (pinn) pinnacleFair += 1;
        else missingSharp += 1;
        const label = sideLabel(market.family, side);
        const line = market.family === 'Moneyline' ? null : lineNum(side.point);
        const dedupe = [sport, matchup, label, market.family, line, dk.book].join('|');
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const priced = edge.attachEv({
          coverProb: p,
          odds: dk.american,
          fair_sharp_p: p,
        });
        rows.push({
          sport,
          matchup,
          side: label,
          market: market.family,
          odds: formatAmerican(dk.american),
          line,
          pModel: null,
          pMkt: p,
          coverProb: p,
          pCalRaw: p,
          ev: priced.ev,
          edgePct: priced.edgePct,
          uncertainty: null,
          book: dk.book,
          edgeLine: line,
          dkLine: line,
          lineAgrees: true,
          commenceTime,
          homeTeam: home,
          awayTeam: away,
          fairSource: pinn ? 'pinnacle' : 'missing-sharp',
          sharpBook: quote.book || null,
          sharpOdds: quote.odds == null ? null : quote.odds,
          sharpOddsOther: quote.oddsOther == null ? null : quote.oddsOther,
          sharpDevig: quote.devig || null,
          pMktPower: quote.pPower == null ? null : quote.pPower,
          bestDkHr: { american: dk.american, book: dk.book, point: line },
          pinnPrices: pinn ? { american: quote.odds, other: quote.oddsOther } : null,
        });
      }
    }
  }
  rows.sort((a, b) => String(a.commenceTime).localeCompare(String(b.commenceTime))
    || String(a.sport).localeCompare(String(b.sport))
    || String(a.matchup).localeCompare(String(b.matchup))
    || String(a.market).localeCompare(String(b.market))
    || String(a.side).localeCompare(String(b.side)));
  return {
    date,
    source: 'polls-1000',
    modelVersion: MODEL_VERSION,
    count: rows.length,
    pinnacleFair,
    missingSharp,
    omitted,
    note: 'missing-sharp pMkt is the 3-book DK/HR consensus from sharpQuoteForSide, not the stored BetOnline/full-book fair. Pinnacle same-line rows use power no-vig.',
    candidates: rows,
  };
}

function writeBoard(board, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mb-${board.date}.json`);
  fs.writeFileSync(file, JSON.stringify(board));
  return file;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function rowKey(c) {
  const line = c.line == null || c.line === '' ? '' : String(lineNum(c.line));
  return [c.sport, norm(c.matchup), norm(c.side), c.market, line, String(c.book || '').toLowerCase()].join('|');
}

function oddsNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

function storedCandidates(date) {
  const file = path.join(STORED_DIR, `mb-${date}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).candidates;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function validateRange(from, to) {
  const perDate = [];
  let storedN = 0;
  let reconN = 0;
  let matched = 0;
  let oddsEq = 0;
  const diffs = [];
  const pinDiffs = [];
  const missDiffs = [];
  for (const date of dateRange(from, to)) {
    const board = buildBoard(date, loadPoll(date));
    const stored = storedCandidates(date).filter((c) => PLACES.has(String(c.book || '').toLowerCase()) && c.lineAgrees !== false);
    const byKey = new Map();
    for (const row of board.candidates) byKey.set(rowKey(row), row);
    let dayMatch = 0;
    let dayOdds = 0;
    const dayDiff = [];
    let dayMissStored = 0;
    for (const row of stored) {
      storedN += 1;
      const hit = byKey.get(rowKey(row));
      if (!hit) {
        dayMissStored += 1;
        continue;
      }
      matched += 1;
      dayMatch += 1;
      const same = oddsNum(hit.odds) === oddsNum(row.odds);
      if (same) {
        oddsEq += 1;
        dayOdds += 1;
      }
      const d = Math.abs(Number(hit.pMkt) - Number(row.pMkt));
      if (Number.isFinite(d)) {
        diffs.push(d);
        dayDiff.push(d);
        if (hit.fairSource === 'pinnacle') pinDiffs.push(d);
        else missDiffs.push(d);
      }
    }
    reconN += board.candidates.length;
    perDate.push({
      date,
      storedDkHr: stored.length,
      reconstructed: board.candidates.length,
      pinnacleFair: board.pinnacleFair,
      missingSharp: board.missingSharp,
      matched: dayMatch,
      matchedPct: stored.length ? dayMatch / stored.length : null,
      oddsEq: dayOdds,
      meanAbsPMkt: mean(dayDiff),
      storedMissing: dayMissStored,
    });
  }
  return {
    from,
    to,
    storedDkHr: storedN,
    reconstructed: reconN,
    matched,
    matchedPctOfStored: storedN ? matched / storedN : null,
    oddsEq,
    oddsEqPctOfMatched: matched ? oddsEq / matched : null,
    meanAbsPMkt: mean(diffs),
    meanAbsPMktPinnacle: mean(pinDiffs),
    nPinnacleMatched: pinDiffs.length,
    meanAbsPMktMissingSharp: mean(missDiffs),
    nMissingSharpMatched: missDiffs.length,
    perDate,
  };
}

function parseArgs(argv) {
  const out = { from: null, to: null, outDir: null, validate: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--validate') out.validate = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else throw new Error(`unknown arg ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.validate) {
    const report = validateRange('2026-10-31', '2026-11-13');
    if (args.outDir) {
      for (const date of dateRange('2026-10-31', '2026-11-13')) {
        writeBoard(buildBoard(date, loadPoll(date)), args.outDir);
      }
      report.wrote = args.outDir;
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (!args.from || !args.to || !args.outDir) {
    throw new Error('usage: boards-from-polls.js --from YYYY-MM-DD --to YYYY-MM-DD --out-dir DIR');
  }
  const summary = [];
  for (const date of dateRange(args.from, args.to)) {
    const board = buildBoard(date, loadPoll(date));
    writeBoard(board, args.outDir);
    summary.push({
      date,
      count: board.count,
      pinnacleFair: board.pinnacleFair,
      missingSharp: board.missingSharp,
      omitted: board.omitted,
    });
  }
  process.stdout.write(`${JSON.stringify({ outDir: args.outDir, days: summary })}\n`);
}

if (require.main === module) main();

module.exports = { buildBoard, writeBoard, validateRange, dateRange };
