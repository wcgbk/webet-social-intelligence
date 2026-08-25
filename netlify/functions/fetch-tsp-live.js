// fetch-tsp-live.js
// Scheduled fetcher for the PRIVATE "Live AI Picks" page (/live-ai).
// Pulls Ben's subscribed TSP.Live Hermes A.I. selections page (tsp.live/analytics-1/)
// using his member session cookie (env TSP_SESSION_COOKIE), parses the selection
// cards, and stores structured JSON in the isolated "tsp-live" blob store.
//
// PRIVATE-USE ONLY: this powers a passcode-gated internal page for Ben's own
// consumption of content he pays for. It must never feed a public page — TSP.Live
// is a paid membership product and republishing its selections would be
// redistribution of premium content.
//
// Statuses written to the blob:
//   ok            — parsed selections successfully
//   NO_COOKIE     — TSP_SESSION_COOKIE env var not set (page shows setup steps)
//   AUTH_EXPIRED  — cookie no longer logged in (page shows refresh steps)
//   FETCH_ERROR   — network/Cloudflare failure (page shows last-good + error)
//   PARSE_EMPTY   — logged in but no cards found (markup change or empty slate)

const SOURCE_URL = "https://tsp.live/analytics-1/";

// Scheduled functions don't receive the automatic Netlify Blobs context — pass it
// explicitly (same reason the alpha/omega generators hit the Blobs REST API directly).
const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
async function tspStore() {
  const { getStore } = await import("@netlify/blobs");
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return token ? getStore({ name: "tsp-live", siteID: SITE_ID, token }) : getStore("tsp-live");
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ── Parse the members page into structured selections ──
// The visible .selection-card DOM is rendered CLIENT-SIDE by JS, so the raw HTML has
// only 1 card. The full slate is embedded as a json_encode'd JS array:
//   var allSelections = [ { selection, confidence, openScore, currentScore, date,
//       time, league, pros:[], cons:[], neutral:[], notes, tagColor, tagLabel,
//       rotation, _ai }, ... ];
// We extract that array (string-aware bracket matching) and JSON.parse it.
function extractArrayLiteral(html, varName) {
  const mi = html.indexOf("var " + varName);
  if (mi === -1) return null;
  const start = html.indexOf("[", mi);
  if (start === -1) return null;
  let depth = 0, inStr = false, quote = "", esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; }
    else if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

function parseSelections(html) {
  const literal = extractArrayLiteral(html, "allSelections");
  if (!literal) return [];
  let arr;
  try { arr = JSON.parse(literal); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => {
    const open = s.openScore, cur = s.currentScore;
    let delta = null;
    if (typeof open === "number" && typeof cur === "number") {
      const d = cur - open;
      delta = d === 0 ? "±0" : (d > 0 ? "+" + d : String(d));
    }
    return {
      pick: (s.selection || "").trim(),
      confidence: s.confidence || null,
      aiScore: s._ai !== undefined && s._ai !== null ? s._ai : null,
      open: open != null ? String(open) : null,
      current: cur != null ? String(cur) : null,
      delta,
      league: s.league || null,
      gameTimeET: [s.date, s.time].filter(Boolean).join(" · ") || null,
      pros: Array.isArray(s.pros) ? s.pros : [],
      cons: Array.isArray(s.cons) ? s.cons : [],
      neutral: Array.isArray(s.neutral) ? s.neutral : [],
      tagLabel: s.tagLabel || null,
      notes: s.notes || null,
      rotation: s.rotation || null,
      meta: [s.league, s.date, s.time].filter(Boolean).join(" · "),
    };
  }).filter((s) => s.pick);
}

async function runFetch() {
  const cookie = process.env.TSP_SESSION_COOKIE;
  const fetchedAt = new Date().toISOString();
  const base = { fetchedAt, sourceUrl: SOURCE_URL, source: "TSP.Live — Hermes A.I. (private member feed)" };

  if (!cookie) {
    return { ...base, status: "NO_COOKIE", selections: [], count: 0 };
  }

  let html;
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      return { ...base, status: "FETCH_ERROR", httpStatus: resp.status, selections: [], count: 0 };
    }
    html = await resp.text();
  } catch (e) {
    return { ...base, status: "FETCH_ERROR", error: e.message, selections: [], count: 0 };
  }

  const loggedIn = html.includes("allSelections") || /MEMBERS/.test(html) || html.includes("selection-card");
  if (!loggedIn) {
    return { ...base, status: "AUTH_EXPIRED", selections: [], count: 0 };
  }

  const selections = parseSelections(html);
  const version = (html.match(/Hermes v[\d.]+/) || [null])[0];
  if (selections.length === 0) {
    return { ...base, status: "PARSE_EMPTY", version, selections: [], count: 0 };
  }
  return { ...base, status: "ok", version, selections, count: selections.length };
}

async function handler() {
  const payload = await runFetch();
  try {
    const store = await tspStore();
    // Never clobber a good card with a transient failure — keep last-good visible,
    // but surface the failure alongside it so the page can show a warning banner.
    if (payload.status !== "ok") {
      const prev = await store.get("latest", { type: "json" }).catch(() => null);
      if (prev && prev.status === "ok") {
        await store.setJSON("latest", { ...prev, lastError: { status: payload.status, at: payload.fetchedAt, httpStatus: payload.httpStatus || null } });
        console.log(`[tsp-live] ${payload.status} — kept last-good card from ${prev.fetchedAt}`);
        return { statusCode: 200, body: JSON.stringify({ kept: true, error: payload.status }) };
      }
    }
    await store.setJSON("latest", payload);
    await store.setJSON(`day-${todayET()}`, payload);
    console.log(`[tsp-live] status=${payload.status} count=${payload.count}`);
  } catch (e) {
    console.error(`[tsp-live] blob write failed: ${e.message}`);
    return { statusCode: 500, body: e.message };
  }
  return { statusCode: 200, body: JSON.stringify({ status: payload.status, count: payload.count }) };
}

exports.handler = handler;
exports.runFetch = runFetch; // for run-tsp-live.js in-process invocation
