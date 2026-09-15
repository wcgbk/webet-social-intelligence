// Circa Million VIII standings: discover weekly PDFs, parse compact points bands,
// map our contest points -> place range + full-season prize estimate.
// Pure JS (pdf-parse@1.1.1 classic Node API). No pdftotext binary.
// Lazy-require inside extractPdfText so module load never pulls browser PDF.js.

const WP_MEDIA =
  "https://www.circasports.com/wp-json/wp/v2/media";
const ATTRIBUTION =
  "WeBetAI is not affiliated with Circa Sports. Official standings and prizes are published by Circa Sports.";

const TOP10 = {
  1: 1_000_000,
  2: 500_000,
  3: 400_000,
  4: 350_000,
  5: 300_000,
  6: 250_000,
  7: 200_000,
  8: 150_000,
  9: 100_000,
  10: 90_000,
};
const SHARE_11_100 = 1_310_000 / 90; // equal-share estimate
const LAST_PRIZE = 100_000;
const SECOND_LAST_PRIZE = 50_000;

// pdf-parse@1.1.1 often omits inter-column spaces; match place + optional T,
// then record+points from the right (entry/picks not needed for rank bands).
const ROW_RE =
  /^([0-9,]+)(T?)\s*(.+?)\s*(\d+-\d+-\d+-\d+)\s*(\d+\.\d{2})\s*$/;

const CACHE_KEY = "circa-standings-v1";
const MEM_TTL_MS = 15 * 60 * 1000;

let memCache = null; // { key, expires, payload }

function prizeForPlace(place, fieldSize) {
  if (!Number.isFinite(place) || place < 1) return 0;
  if (TOP10[place]) return TOP10[place];
  if (place >= 11 && place <= 100) return SHARE_11_100;
  if (fieldSize > 0 && place === fieldSize) return LAST_PRIZE;
  if (fieldSize > 1 && place === fieldSize - 1) return SECOND_LAST_PRIZE;
  return 0;
}

function formatUsd(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return "$0";
  return "$" + v.toLocaleString("en-US");
}

function ordinal(n) {
  const x = Math.abs(Math.round(n));
  const mod100 = x % 100;
  if (mod100 >= 11 && mod100 <= 13) return x + "th";
  switch (x % 10) {
    case 1:
      return x + "st";
    case 2:
      return x + "nd";
    case 3:
      return x + "rd";
    default:
      return x + "th";
  }
}

function parseWeekFromTitle(title, url) {
  const s = String(title || "") + " " + String(url || "");
  const m = s.match(/After\s+Week\s+(\d+)/i) || s.match(/Week[_-\s]?(\d+)/i);
  return m ? Number(m[1]) : null;
}

function classifyMedia(item) {
  const title = String((item.title && item.title.rendered) || "");
  const url = String(item.source_url || "");
  const blob = (title + " " + url).toLowerCase();
  const isMillion8 =
    blob.includes("million viii") ||
    blob.includes("million-viii") ||
    blob.includes("million_viii");
  if (!isMillion8) return null;
  const isLast =
    blob.includes("last place") ||
    blob.includes("last-place") ||
    blob.includes("booby");
  const isSeason =
    blob.includes("standings") &&
    (blob.includes("full season") ||
      blob.includes("full-season") ||
      blob.includes("quarter"));
  if (isLast) return "lastPlace";
  if (isSeason || blob.includes("standings")) return "season";
  return null;
}

async function fetchMedia(search) {
  const url =
    WP_MEDIA +
    "?search=" +
    encodeURIComponent(search) +
    "&per_page=20&orderby=date&order=desc";
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "WeBetAI-CircaStandings/1.0" },
  });
  if (!resp.ok) throw new Error("WP media " + resp.status + " for " + search);
  return resp.json();
}

async function discoverLatestPdfs() {
  const [standings, lastPlace] = await Promise.all([
    fetchMedia("Million VIII Standings"),
    fetchMedia("Million VIII Last Place"),
  ]);
  const pool = []
    .concat(Array.isArray(standings) ? standings : [])
    .concat(Array.isArray(lastPlace) ? lastPlace : []);

  let season = null;
  let last = null;
  for (const item of pool) {
    const kind = classifyMedia(item);
    if (!kind || !item.source_url) continue;
    const meta = {
      id: item.id,
      url: item.source_url,
      title: (item.title && item.title.rendered) || "",
      date: item.date || item.modified || null,
      week: parseWeekFromTitle(
        (item.title && item.title.rendered) || "",
        item.source_url
      ),
    };
    if (kind === "season") {
      if (!season || String(meta.date) > String(season.date)) season = meta;
    } else if (kind === "lastPlace") {
      if (!last || String(meta.date) > String(last.date)) last = meta;
    }
  }
  return { season, lastPlace: last };
}

function parseStandingsText(text) {
  const bandsMap = new Map(); // points -> { place, count }
  let fieldSize = 0;
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\t/g, " ").trim();
    if (!line) continue;
    const m = line.match(ROW_RE);
    if (!m) continue;
    const place = parseInt(m[1].replace(/,/g, ""), 10);
    const points = parseFloat(m[5]);
    if (!Number.isFinite(place) || !Number.isFinite(points)) continue;
    fieldSize += 1;
    const prev = bandsMap.get(points);
    if (!prev) {
      bandsMap.set(points, { points, place, count: 1, tiedFlag: m[2] === "T" });
    } else {
      prev.count += 1;
      prev.place = Math.min(prev.place, place);
      prev.tiedFlag = prev.tiedFlag || m[2] === "T";
    }
  }
  const bands = [...bandsMap.values()]
    .map((b) => {
      const placeLo = b.place;
      const placeHi = b.place + b.count - 1;
      return {
        points: b.points,
        place: b.place,
        placeLo,
        placeHi,
        count: b.count,
        tied: b.count > 1 || b.tiedFlag,
      };
    })
    .sort((a, b) => b.points - a.points);

  return { fieldSize, bands };
}

async function extractPdfText(buffer) {
  // Classic pdf-parse@1.1.1: require('pdf-parse')(buffer) -> { text, ... }
  // Keep require inside the function so cold-loading this module never hits DOMMatrix.
  const pdf = require("pdf-parse");
  const result = await pdf(buffer);
  return (result && result.text) || "";
}

async function downloadPdf(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "WeBetAI-CircaStandings/1.0" },
  });
  if (!resp.ok) throw new Error("PDF download " + resp.status);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

function estimatePrize(band, fieldSize) {
  const placeLo = band.placeLo;
  const placeHi = band.placeHi;
  const count = band.count;

  // Huge last-place ties: do not claim the $100k booby until unique.
  if (fieldSize > 0 && placeHi >= fieldSize && count > 1) {
    return {
      prizeEstimateUsd: 0,
      prizeLabel: "$0 full-season (tied for last - booby shared)",
    };
  }

  let sum = 0;
  for (let p = placeLo; p <= placeHi; p++) {
    sum += prizeForPlace(p, fieldSize);
  }
  const slots = placeHi - placeLo + 1;
  const avg = slots > 0 ? sum / slots : 0;
  const rounded = Math.round(avg);

  if (rounded <= 0) {
    if (placeLo > 100) {
      return {
        prizeEstimateUsd: 0,
        prizeLabel: "$0 full-season (outside top 100)",
      };
    }
    return { prizeEstimateUsd: 0, prizeLabel: "$0 full-season" };
  }

  const sole =
    placeLo === placeHi &&
    (TOP10[placeLo] ||
      (placeLo >= 11 && placeLo <= 100) ||
      placeLo === fieldSize ||
      placeLo === fieldSize - 1);

  if (sole && TOP10[placeLo]) {
    return {
      prizeEstimateUsd: rounded,
      prizeLabel:
        formatUsd(rounded) + " full-season (if season ended at " + ordinal(placeLo) + ")",
    };
  }
  if (sole && placeLo === fieldSize) {
    return {
      prizeEstimateUsd: LAST_PRIZE,
      prizeLabel: formatUsd(LAST_PRIZE) + " full-season (last place booby)",
    };
  }
  if (sole && placeLo === fieldSize - 1) {
    return {
      prizeEstimateUsd: SECOND_LAST_PRIZE,
      prizeLabel: formatUsd(SECOND_LAST_PRIZE) + " full-season (2nd-to-last booby)",
    };
  }

  return {
    prizeEstimateUsd: rounded,
    prizeLabel:
      "~" +
      formatUsd(rounded) +
      " full-season estimate (tied " +
      ordinal(placeLo) +
      "-" +
      ordinal(placeHi) +
      " if season ended today)",
  };
}

function lookupPoints(bands, fieldSize, points) {
  const pts = Math.round(Number(points) * 100) / 100;
  if (!Number.isFinite(pts)) return null;
  const band = bands.find((b) => Math.abs(b.points - pts) < 0.001);
  if (!band) {
    // Nearest lower points band (worse place) if exact missing - e.g. mid-week partial.
    const lower = bands.filter((b) => b.points <= pts + 1e-9);
    if (!lower.length) return null;
    lower.sort((a, b) => b.points - a.points);
    return lookupPoints(bands, fieldSize, lower[0].points);
  }
  const prize = estimatePrize(band, fieldSize);
  const percentile =
    fieldSize > 0
      ? Math.round((1 - (band.placeLo - 1) / fieldSize) * 1000) / 10
      : null;
  const placeLabel = band.tied
    ? "~" + ordinal(band.placeLo) + " (tied)"
    : ordinal(band.placeLo);
  return {
    points: band.points,
    place: band.placeLo,
    placeLo: band.placeLo,
    placeHi: band.placeHi,
    placeLabel,
    tied: band.tied,
    count: band.count,
    fieldSize,
    percentile,
    ...prize,
  };
}

function buildPayload(meta, parsed, pointsQuery) {
  const week = (meta.season && meta.season.week) || null;
  const base = {
    ok: true,
    week,
    fieldSize: parsed.fieldSize,
    seasonPdfUrl: (meta.season && meta.season.url) || null,
    lastPlacePdfUrl: (meta.lastPlace && meta.lastPlace.url) || null,
    seasonMediaId: (meta.season && meta.season.id) || null,
    lastPlaceMediaId: (meta.lastPlace && meta.lastPlace.id) || null,
    seasonTitle: (meta.season && meta.season.title) || null,
    updatedAt: (meta.season && meta.season.date) || new Date().toISOString(),
    bands: parsed.bands.map((b) => ({
      points: b.points,
      place: b.place,
      placeLo: b.placeLo,
      placeHi: b.placeHi,
      count: b.count,
      tied: b.tied,
    })),
    displayName: "WeBetAI",
    attribution: ATTRIBUTION,
  };
  if (pointsQuery != null && pointsQuery !== "") {
    const n = Number(pointsQuery);
    base.rank = lookupPoints(parsed.bands, parsed.fieldSize, n);
    base.queriedPoints = Number.isFinite(n) ? n : null;
  }
  return base;
}

async function loadParsedFromPdf(seasonUrl) {
  const buf = await downloadPdf(seasonUrl);
  const text = await extractPdfText(buf);
  return parseStandingsText(text);
}

function cacheIdentity(meta) {
  return [
    (meta.season && meta.season.id) || "s0",
    (meta.season && meta.season.url) || "",
    (meta.lastPlace && meta.lastPlace.id) || "l0",
    (meta.season && meta.season.week) || "w?",
  ].join("|");
}

async function getStandings({ points, readBlob, writeBlob } = {}) {
  const meta = await discoverLatestPdfs();
  if (!meta.season || !meta.season.url) {
    return {
      ok: false,
      error: true,
      message: "No Circa Million VIII standings PDF found yet",
      seasonPdfUrl: null,
      lastPlacePdfUrl: (meta.lastPlace && meta.lastPlace.url) || null,
      attribution: ATTRIBUTION,
      displayName: "WeBetAI",
    };
  }

  const ident = cacheIdentity(meta);
  const now = Date.now();

  if (memCache && memCache.key === ident && memCache.expires > now) {
    return buildPayload(meta, memCache.parsed, points);
  }

  let parsed = null;
  if (typeof readBlob === "function") {
    try {
      const cached = await readBlob(CACHE_KEY);
      if (
        cached &&
        cached.ident === ident &&
        cached.parsed &&
        Array.isArray(cached.parsed.bands)
      ) {
        parsed = cached.parsed;
      }
    } catch (e) {
      console.log("[circa-standings] blob read skip:", e.message);
    }
  }

  if (!parsed) {
    parsed = await loadParsedFromPdf(meta.season.url);
    if (typeof writeBlob === "function") {
      try {
        await writeBlob(CACHE_KEY, {
          ident,
          parsed,
          meta: {
            season: meta.season,
            lastPlace: meta.lastPlace,
          },
          cachedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.log("[circa-standings] blob write skip:", e.message);
      }
    }
  }

  memCache = { key: ident, expires: now + MEM_TTL_MS, parsed };
  return buildPayload(meta, parsed, points);
}

module.exports = {
  ATTRIBUTION,
  CACHE_KEY,
  prizeForPlace,
  estimatePrize,
  lookupPoints,
  parseStandingsText,
  parseWeekFromTitle,
  classifyMedia,
  discoverLatestPdfs,
  extractPdfText,
  getStandings,
  buildPayload,
  formatUsd,
  ordinal,
};
