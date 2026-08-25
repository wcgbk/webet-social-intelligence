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

// ── Parse the members page HTML into structured selections ──
// Card shape (verified 2026-08-25):
// <div class="selection-card medium" data-conf="MEDIUM" data-tsp-ai="11">
//   <div class="selection-team">Hijkata +100</div>
//   <div class="selection-meta">ATP Winston Salem · 8/25/2026 ·
//        <span class="tsp-lt" title="3:30 PM ET · 8/25/2026">3:30 PM</span></div>
//   <div class="confidence-badge MEDIUM">MEDIUM</div>
//   <div class="score-chip-value open">31</div> ... <div class="score-chip-value tier-teal">31</div>
//   <div class="score-delta flat">±0</div>
function parseSelections(html) {
  const selections = [];
  const chunks = html.split('class="selection-card');
  for (let i = 1; i < chunks.length; i++) {
    // Bound each card at the next card (or a generous tail for the last one)
    const raw = chunks[i].slice(0, 6000);
    const sel = {};
    sel.confidence = (raw.match(/data-conf="([A-Z]+)"/) || [])[1] || null;
    const ai = (raw.match(/data-tsp-ai="([\d.]+)"/) || [])[1];
    sel.aiScore = ai !== undefined ? Number(ai) : null;
    sel.pick = stripTags((raw.match(/selection-team">([\s\S]*?)<\/div>/) || [])[1]);
    const metaRaw = (raw.match(/selection-meta">([\s\S]*?)<\/div>/) || [])[1] || "";
    sel.meta = stripTags(metaRaw);
    sel.gameTimeET = (metaRaw.match(/class="tsp-lt"[^>]*title="([^"]+)"/) || [])[1] || null;
    // Open/current chips: collect every score-chip-value; 'open' class marks the opener
    const chips = [...raw.matchAll(/score-chip-value([^"]*)">([^<]+)</g)];
    for (const c of chips) {
      if (/\bopen\b/.test(c[1])) sel.open = c[2].trim();
      else sel.current = c[2].trim();
    }
    sel.delta = stripTags((raw.match(/score-delta[^>]*>([^<]+)</) || [])[1]) || null;
    if (sel.pick) selections.push(sel);
  }
  return selections;
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

  const loggedIn = /MEMBERS/.test(html) || html.includes("selection-card");
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
