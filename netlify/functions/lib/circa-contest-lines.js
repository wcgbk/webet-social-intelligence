// Circa Million VIII — official weekly Contest Point Spreads.
// The contest grades against a frozen Circa PDF, NOT live sportsbook odds.
// Odds API has no `circasports` book; Pinnacle/DK must never be the contest number.
//
// Official rules: https://www.circasports.com/wp-content/uploads/2026/05/CircaMillionVIIIContest.2026.pdf
// Week N sheet: Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-{N}.pdf
//
// loadContestLines throws ContestLinesError when the board cannot be loaded.
// Generators must refuse to publish a live card in that case (no Pinnacle fallback).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LINE_SOURCE = "circa-contest-pdf";

const RULES_PDF_URL =
  "https://www.circasports.com/wp-content/uploads/2026/05/CircaMillionVIIIContest.2026.pdf";

const WEEK1_SOURCE_URL =
  "https://www.circasports.com/wp-content/uploads/2026/09/Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-1.pdf";

const PDF_NAME = (n) => `Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-${n}.pdf`;

class ContestLinesError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContestLinesError";
    this.code = "contest-pdf-unavailable";
  }
}

// Nickname / sheet token → Odds API / ESPN full name.
const NICK_TO_FULL = {
  Cardinals: "Arizona Cardinals",
  Falcons: "Atlanta Falcons",
  Ravens: "Baltimore Ravens",
  Bills: "Buffalo Bills",
  Panthers: "Carolina Panthers",
  Bears: "Chicago Bears",
  Bengals: "Cincinnati Bengals",
  Browns: "Cleveland Browns",
  Cowboys: "Dallas Cowboys",
  Broncos: "Denver Broncos",
  Lions: "Detroit Lions",
  Packers: "Green Bay Packers",
  Texans: "Houston Texans",
  Colts: "Indianapolis Colts",
  Jaguars: "Jacksonville Jaguars",
  Jags: "Jacksonville Jaguars",
  Chiefs: "Kansas City Chiefs",
  Raiders: "Las Vegas Raiders",
  Chargers: "Los Angeles Chargers",
  Rams: "Los Angeles Rams",
  Dolphins: "Miami Dolphins",
  Vikings: "Minnesota Vikings",
  Patriots: "New England Patriots",
  Saints: "New Orleans Saints",
  Giants: "New York Giants",
  Jets: "New York Jets",
  Eagles: "Philadelphia Eagles",
  Steelers: "Pittsburgh Steelers",
  "49ers": "San Francisco 49ers",
  Niners: "San Francisco 49ers",
  Seahawks: "Seattle Seahawks",
  Buccaneers: "Tampa Bay Buccaneers",
  Bucs: "Tampa Bay Buccaneers",
  Titans: "Tennessee Titans",
  Commanders: "Washington Commanders",
};

function lookupNick(key) {
  if (!key) return null;
  if (NICK_TO_FULL[key]) return NICK_TO_FULL[key];
  const found = Object.keys(NICK_TO_FULL).find((k) => k.toLowerCase() === String(key).toLowerCase());
  return found ? NICK_TO_FULL[found] : null;
}

function fullTeam(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (Object.values(NICK_TO_FULL).includes(s)) return s;
  const nick = s.split(/\s+/).pop();
  return lookupNick(nick) || lookupNick(s) || s;
}

function nickOf(name) {
  const full = fullTeam(name);
  const parts = String(full).trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

function normalizeFractions(text) {
  return String(text || "")
    .replace(/\u00bd/g, ".5")
    .replace(/\u00bc/g, ".25")
    .replace(/\u00be/g, ".75")
    .replace(/(\d+)\s*[-\u2013]?\s*1\/2/g, "$1.5")
    .replace(/(\d+)\s+1\/2/g, "$1.5");
}

function parseSpreadToken(raw) {
  if (raw == null || raw === "") return null;
  const s = normalizeFractions(String(raw).trim()).replace(/^\+/, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function gameRow({
  away, home, commenceHint, commenceTime, awaySpread, homeSpread, contestIds, venueHint,
}) {
  return {
    away: fullTeam(away),
    home: fullTeam(home),
    commenceHint: commenceHint || null,
    commenceTime: commenceTime || null,
    awaySpread: Number(awaySpread),
    homeSpread: Number(homeSpread),
    contestIds: contestIds || null,
    venueHint: venueHint || null,
  };
}

// Verified against the official Week 1 Contest Point Spreads PDF (image render).
// Spreads are ½ → .5. Top team on the sheet is visitor; bottom is home.
const WEEK1_GAMES = [
  gameRow({
    away: "New England Patriots", home: "Seattle Seahawks",
    commenceHint: "Wed Sep 9, 5:20 PM PT", commenceTime: "2026-09-10T00:20:00.000Z",
    awaySpread: 3, homeSpread: -3, contestIds: { away: 2, home: 1 },
  }),
  gameRow({
    away: "San Francisco 49ers", home: "Los Angeles Rams",
    commenceHint: "Thu Sep 10, 5:00 PM PT · Melbourne", commenceTime: "2026-09-11T00:00:00.000Z",
    awaySpread: 4, homeSpread: -4, contestIds: { away: 4, home: 3 },
    venueHint: "Melbourne, Australia",
  }),
  gameRow({
    away: "Cleveland Browns", home: "Jacksonville Jaguars",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: 8.5, homeSpread: -8.5, contestIds: { away: 6, home: 5 },
  }),
  gameRow({
    away: "Tampa Bay Buccaneers", home: "Cincinnati Bengals",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: 3.5, homeSpread: -3.5, contestIds: { away: 8, home: 7 },
  }),
  gameRow({
    away: "Baltimore Ravens", home: "Indianapolis Colts",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: -3.5, homeSpread: 3.5, contestIds: { away: 9, home: 10 },
  }),
  gameRow({
    away: "Atlanta Falcons", home: "Pittsburgh Steelers",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: 3.5, homeSpread: -3.5, contestIds: { away: 12, home: 11 },
  }),
  gameRow({
    away: "Buffalo Bills", home: "Houston Texans",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: -0.5, homeSpread: 0.5, contestIds: { away: 13, home: 14 },
  }),
  gameRow({
    away: "Chicago Bears", home: "Carolina Panthers",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: -3, homeSpread: 3, contestIds: { away: 15, home: 16 },
  }),
  gameRow({
    away: "New York Jets", home: "Tennessee Titans",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: 1.5, homeSpread: -1.5, contestIds: { away: 18, home: 17 },
  }),
  gameRow({
    away: "New Orleans Saints", home: "Detroit Lions",
    commenceHint: "Sun Sep 13, 10:00 AM PT", commenceTime: "2026-09-13T17:00:00.000Z",
    awaySpread: 7, homeSpread: -7, contestIds: { away: 20, home: 19 },
  }),
  gameRow({
    away: "Arizona Cardinals", home: "Los Angeles Chargers",
    commenceHint: "Sun Sep 13, 1:05 PM PT", commenceTime: "2026-09-13T20:05:00.000Z",
    awaySpread: 8.5, homeSpread: -8.5, contestIds: { away: 22, home: 21 },
  }),
  gameRow({
    away: "Miami Dolphins", home: "Las Vegas Raiders",
    commenceHint: "Sun Sep 13, 1:25 PM PT", commenceTime: "2026-09-13T20:25:00.000Z",
    awaySpread: 3.5, homeSpread: -3.5, contestIds: { away: 24, home: 23 },
  }),
  gameRow({
    away: "Washington Commanders", home: "Philadelphia Eagles",
    commenceHint: "Sun Sep 13, 1:25 PM PT", commenceTime: "2026-09-13T20:25:00.000Z",
    awaySpread: 4.5, homeSpread: -4.5, contestIds: { away: 26, home: 25 },
  }),
  gameRow({
    away: "Green Bay Packers", home: "Minnesota Vikings",
    commenceHint: "Sun Sep 13, 1:25 PM PT", commenceTime: "2026-09-13T20:25:00.000Z",
    awaySpread: 1.5, homeSpread: -1.5, contestIds: { away: 28, home: 27 },
  }),
  gameRow({
    away: "Dallas Cowboys", home: "New York Giants",
    commenceHint: "Sun Sep 13, 5:20 PM PT", commenceTime: "2026-09-14T00:20:00.000Z",
    awaySpread: -3, homeSpread: 3, contestIds: { away: 29, home: 30 },
  }),
  gameRow({
    away: "Denver Broncos", home: "Kansas City Chiefs",
    commenceHint: "Mon Sep 14, 5:15 PM PT", commenceTime: "2026-09-15T00:15:00.000Z",
    awaySpread: 3, homeSpread: -3, contestIds: { away: 32, home: 31 },
  }),
];

const WEEK_FIXTURES = {
  1: {
    weekNum: 1,
    sourceUrl: WEEK1_SOURCE_URL,
    fromFixture: true,
    lineSource: LINE_SOURCE,
    games: WEEK1_GAMES,
  },
};

function getWeekFixture(weekNum) {
  const n = Number(weekNum);
  const fx = WEEK_FIXTURES[n];
  if (!fx) return null;
  return {
    weekNum: fx.weekNum,
    sourceUrl: fx.sourceUrl,
    fromFixture: true,
    lineSource: LINE_SOURCE,
    games: fx.games.map((g) => ({ ...g, contestIds: g.contestIds ? { ...g.contestIds } : null })),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function candidateSpreadUrls(weekNum, now = new Date()) {
  const n = Number(weekNum);
  const name = PDF_NAME(n);
  const urls = [];
  const push = (y, m) => {
    urls.push(`https://www.circasports.com/wp-content/uploads/${y}/${pad2(m)}/${name}`);
  };
  // NFL 2026 regular season: W1 Sep 10 → roughly one week per, into Jan 2027.
  const weekMonth = {
    1: [2026, 9], 2: [2026, 9], 3: [2026, 9], 4: [2026, 9],
    5: [2026, 10], 6: [2026, 10], 7: [2026, 10], 8: [2026, 10],
    9: [2026, 11], 10: [2026, 11], 11: [2026, 11], 12: [2026, 11],
    13: [2026, 12], 14: [2026, 12], 15: [2026, 12], 16: [2026, 12],
    17: [2026, 12], 18: [2027, 1],
  };
  const known = { 1: WEEK1_SOURCE_URL };
  if (known[n]) urls.push(known[n]);
  const ym = weekMonth[n];
  if (ym) {
    push(ym[0], ym[1]);
    let y = ym[0];
    let m = ym[1] - 1;
    if (m < 1) { m = 12; y -= 1; }
    push(y, m);
    y = ym[0];
    m = ym[1] + 1;
    if (m > 12) { m = 1; y += 1; }
    push(y, m);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
    }).formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year").value);
    const m = Number(parts.find((p) => p.type === "month").value);
    push(y, m);
  } catch (e) { /* ignore */ }
  return [...new Set(urls)];
}

function nickKeys() {
  return Object.keys(NICK_TO_FULL).sort((a, b) => b.length - a.length);
}

function extractTokensFromText(text) {
  const norm = normalizeFractions(text).replace(/\r/g, "\n");
  const nicks = nickKeys().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`\\b(${nicks})\\b\\s*([+-]\\s*\\d+(?:\\.\\d+)?)`, "gi");
  const tokens = [];
  let m;
  while ((m = re.exec(norm))) {
    const spread = parseSpreadToken(m[2].replace(/\s+/g, ""));
    if (spread == null) continue;
    tokens.push({ nick: nickOf(m[1]), team: fullTeam(m[1]), spread });
  }
  return tokens;
}

function sequentialPair(tokens) {
  const games = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a || !b || a.team === b.team) continue;
    if (Math.abs((a.spread || 0) + (b.spread || 0)) > 0.05) continue;
    games.push(gameRow({
      away: a.team, home: b.team,
      awaySpread: a.spread, homeSpread: b.spread,
    }));
  }
  return games;
}

function pairWithSlate(tokens, slate) {
  if (!Array.isArray(slate) || !slate.length || !tokens.length) return [];
  const byNick = new Map();
  for (const t of tokens) {
    if (!byNick.has(t.nick)) byNick.set(t.nick, t);
  }
  const games = [];
  for (const g of slate) {
    const home = fullTeam(g.homeTeam || g.home);
    const away = fullTeam(g.awayTeam || g.away);
    if (!home || !away) continue;
    const ht = byNick.get(nickOf(home));
    const at = byNick.get(nickOf(away));
    if (!ht || !at) continue;
    games.push(gameRow({
      away, home,
      awaySpread: at.spread, homeSpread: ht.spread,
      commenceHint: g.commenceHint || null,
      commenceTime: g.date || g.commenceTime || null,
      venueHint: g.venue || g.venueHint || null,
    }));
  }
  return games;
}

function parseContestText(text, weekNum, opts = {}) {
  const tokens = extractTokensFromText(text);
  let games = [];
  if (opts.slate) games = pairWithSlate(tokens, opts.slate);
  if (games.length < 8) games = sequentialPair(tokens);
  return {
    weekNum: Number(weekNum),
    lineSource: LINE_SOURCE,
    fromFixture: false,
    tokens,
    games,
  };
}

function extractPdfLiteralStrings(buf) {
  const raw = buf.toString("latin1");
  const chunks = [];
  const re = /\((?:\\.|[^\\)]){2,}\)/g;
  let m;
  while ((m = re.exec(raw))) {
    let s = m[0].slice(1, -1);
    s = s.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, " ").replace(/\\(.)/g, "$1");
    if (/[A-Za-z]/.test(s)) chunks.push(s);
  }
  return chunks.join("\n");
}

function withTempPdf(buf, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "circa-pdf-"));
  const pdf = path.join(dir, "week.pdf");
  fs.writeFileSync(pdf, buf);
  try {
    return fn(pdf, dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

function tryBin(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: opts.timeout || 20000,
      maxBuffer: 12 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout) return r.stdout;
  } catch (e) { /* binary missing */ }
  return null;
}

function ocrPdf(buf) {
  try {
    return withTempPdf(buf, (pdf, dir) => {
      const prefix = path.join(dir, "page");
      spawnSync("pdftoppm", ["-png", "-r", "200", pdf, prefix], { timeout: 25000 });
      const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
      if (!pages.length) return "";
      const texts = [];
      for (const p of pages) {
        const out = tryBin("tesseract", [path.join(dir, p), "stdout"], { timeout: 30000 });
        if (out) texts.push(out);
      }
      return texts.join("\n");
    });
  } catch (e) {
    return "";
  }
}

function parseContestPdf(buf, weekNum, opts = {}) {
  if (!buf || !buf.length) return null;
  const texts = [];
  const literals = extractPdfLiteralStrings(buf);
  if (literals && literals.length > 40) texts.push(literals);
  try {
    const pdftotext = withTempPdf(buf, (pdf) => tryBin("pdftotext", ["-layout", "-q", pdf, "-"]));
    if (pdftotext && pdftotext.trim().length > 40) texts.push(pdftotext);
  } catch (e) { /* ignore */ }
  if (opts.ocr !== false) {
    const ocr = ocrPdf(buf);
    if (ocr && ocr.trim().length > 40) texts.push(ocr);
  }
  let best = null;
  for (const t of texts) {
    const parsed = parseContestText(t, weekNum, opts);
    if (!best || parsed.games.length > best.games.length) best = parsed;
  }
  return best;
}

async function fetchPdfBuffer(url, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  if (!fetchFn) return null;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000) : null;
  try {
    const resp = await fetchFn(url, {
      method: "GET",
      signal: ctrl ? ctrl.signal : undefined,
      headers: { "User-Agent": "WeBetAI-CircaContest/1.2" },
    });
    if (!resp.ok) return null;
    const ctype = String(resp.headers && resp.headers.get && resp.headers.get("content-type") || "");
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) return null;
    if (ctype && !/pdf|octet-stream|application\/download/i.test(ctype) && buf.slice(0, 5).toString() !== "%PDF-") {
      return null;
    }
    return { url, buffer: buf };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boardsAgree(a, b) {
  if (!a || !b || !a.games || !b.games) return false;
  if (a.games.length !== b.games.length) return false;
  const key = (g) => `${nickOf(g.away)}@${nickOf(g.home)}`;
  const map = new Map(b.games.map((g) => [key(g), g]));
  for (const g of a.games) {
    const o = map.get(key(g));
    if (!o) return false;
    if (Math.abs(g.awaySpread - o.awaySpread) > 0.05) return false;
    if (Math.abs(g.homeSpread - o.homeSpread) > 0.05) return false;
  }
  return true;
}

function decorateBoard(board, extra = {}) {
  return {
    weekNum: Number(board.weekNum),
    sourceUrl: extra.sourceUrl || board.sourceUrl || null,
    rulesUrl: RULES_PDF_URL,
    lineSource: LINE_SOURCE,
    fromFixture: !!board.fromFixture,
    games: (board.games || []).map((g) => ({ ...g })),
    parseNote: extra.parseNote || board.parseNote || null,
  };
}

/**
 * Load the official Circa contest board for a week.
 * Never returns Pinnacle/DK/consensus as contest spreads.
 * Throws ContestLinesError when lines cannot be loaded.
 */
async function loadContestLines(weekNum, opts = {}) {
  const n = Number(weekNum);
  if (!Number.isInteger(n) || n < 1 || n > 18) {
    throw new ContestLinesError(`Invalid Circa contest week: ${weekNum}`);
  }

  const fixture = getWeekFixture(n);
  const override = opts.sourceUrl || process.env.CIRCA_SPREADS_URL || "";
  let fetched = null;
  let sourceUrl = override || (fixture && fixture.sourceUrl) || null;
  let parsed = null;

  if (!opts.skipFetch) {
    const urls = override ? [override] : candidateSpreadUrls(n, opts.now);
    for (const url of urls) {
      fetched = await fetchPdfBuffer(url, opts);
      if (fetched) {
        sourceUrl = fetched.url;
        break;
      }
    }
    if (fetched && fetched.buffer) {
      try {
        parsed = parseContestPdf(fetched.buffer, n, opts);
      } catch (e) {
        parsed = null;
      }
    }
  }

  if (parsed && parsed.games && parsed.games.length >= 8) {
    if (fixture && !boardsAgree(parsed, fixture)) {
      return decorateBoard(fixture, {
        sourceUrl: sourceUrl || fixture.sourceUrl,
        parseNote: "PDF/OCR parse disagreed with the verified week fixture — using fixture.",
      });
    }
    return decorateBoard({
      weekNum: n,
      sourceUrl,
      fromFixture: false,
      games: parsed.games,
    }, { sourceUrl });
  }

  if (fixture) {
    return decorateBoard(fixture, { sourceUrl: sourceUrl || fixture.sourceUrl });
  }

  throw new ContestLinesError(
    `Official Circa Million VIII contest point spreads PDF is not available for week ${n}. ` +
    `Refusing to generate a live card (no Pinnacle or sportsbook fallback).`
  );
}

module.exports = {
  LINE_SOURCE,
  RULES_PDF_URL,
  WEEK1_SOURCE_URL,
  NICK_TO_FULL,
  ContestLinesError,
  fullTeam,
  nickOf,
  parseSpreadToken,
  normalizeFractions,
  getWeekFixture,
  candidateSpreadUrls,
  parseContestText,
  parseContestPdf,
  loadContestLines,
  WEEK1_GAMES,
};
