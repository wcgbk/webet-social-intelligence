// Grok (xAI) caller with LIVE X SEARCH — same engine the Daily Dose uses, so the
// content rides what's actually trending in the last ~48h rather than stale model memory.
// Env: XAI_API_KEY
const XAI_RESPONSES = "https://api.x.ai/v1/responses";
const MODEL = "grok-4.3";

// US Eastern helpers — the whole product keys + displays on ET (see project memory).
function etDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function etLongDate() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
// UTC window for x_search — keeps results CURRENT (yesterday + today), not week-old.
function searchWindow(days = 1) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  return { from_date: fmt(new Date(now.getTime() - days * 86400000)), to_date: fmt(now) };
}

// Call Grok. liveSearch=true attaches the x_search tool (trending). For evergreen formats
// (quotes, some lessons) pass liveSearch=false to skip the search and just generate.
async function callGrok(prompt, { liveSearch = true, days = 1 } = {}) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY not configured");
  const body = { model: MODEL, input: prompt };
  if (liveSearch) {
    const win = searchWindow(days);
    body.tools = [{ type: "x_search", from_date: win.from_date, to_date: win.to_date }];
  }
  const r = await fetch(XAI_RESPONSES, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("xAI error " + r.status + " " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const msg = (data.output || []).filter((o) => o.type === "message")[0];
  const text = msg?.content?.[0]?.text || "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

module.exports = { callGrok, etDate, etLongDate, searchWindow, MODEL };
