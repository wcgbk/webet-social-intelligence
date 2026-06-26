// THE SIGNAL — content engine for @wcgbk (Ben Klein).
// Generates the day's posts across 7 niches (politics, startups, vc, economy, crypto,
// personal-development, quotes), classifies each for risk, then EITHER auto-posts the
// low-risk formats OR queues sensitive ones for Ben's approval (HYBRID mode).
//
// Slots (ET):
//   morning-take  ~8:30a  single hot take on the day's biggest story in his lane (autopost if low-risk)
//   daily-thread  ~11:00a 4-6 tweet thread on the day's biggest topic (ALWAYS held for approval)
//   midday-lesson ~1:00p  founder/operator lesson (autopost if low-risk)
//   evening-quote ~7:00p  original aphorism rendered as a quote card (autopost if low-risk)
const { getStore, connectLambda } = require("@netlify/blobs");
const { callGrok, etDate, etLongDate } = require("./grok.js");
const { renderCard } = require("./render.js");
const X = require("./x.js");

function blobStore(name) {
  const opts = { name };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID; opts.token = process.env.BLOBS_TOKEN;
  }
  return getStore(opts);
}

// ── shared voice ─────────────────────────────────────────────────────────────
// Baked into every prompt so the output sounds like a sharp human operator, not AI slop.
const VOICE = `VOICE — you are ghost-writing as Ben Klein (@wcgbk): president of World Class Growth,
an operator who helps founders win in the AI era and cuts through propaganda, spin, and hype.
- Write like a sharp, contrarian human who lives on X. Confident, specific, a little provocative.
- Earn the follow: every post must deliver a real insight, a useful frame, or a true contrarian take.
FORMAT (X-native, tuned for reach + replies):
- LINE 1 IS EVERYTHING. It must stop the scroll on its own (X truncates the rest). A bold claim,
  a surprising number, or a sharp contrarian statement. No setup, no "I think", no throat-clearing.
- Use SHORT lines and line breaks (\\n) for white space — make it skim in 2 seconds, not a paragraph block.
- One idea per post. Concrete > abstract. Name names, use real numbers.
- END on reply-bait: a pointed question, a "change my mind" claim, or a reframe that begs a response.
- NO hashtags. NO links in the body. At most one emoji, only if it truly earns its place.
- BANNED: delve, tapestry, "let's unpack", "sparked a firestorm", "game-changer", "in an era of",
  "in today's fast-paced", "the truth is", em-dash overload, generic motivational filler.
- Sound like a person with skin in the game. Never like a brand or a press release.`;

const TODAY = () => `TODAY IS ${etLongDate()} (US Eastern). Use only what's genuinely current.`;

// ── niche rotation — guarantees variety across a week ────────────────────────
const TREND_NICHES = ["startups", "crypto", "economy", "politics", "vc"];
const LESSON_NICHES = ["startups", "vc", "personal-development"];
const QUOTE_NICHES = ["personal-development", "quotes", "startups"];
function dayIndex() {
  const d = new Date(etDate() + "T12:00:00");
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}
function pickNiche(pool, offset = 0) { return pool[(dayIndex() + offset) % pool.length]; }

// ── risk classification (hybrid gate) ────────────────────────────────────────
// Anything politically charged, a market price-call, or a named accusation is "sensitive"
// and gets held for approval even on an autopost-eligible slot. Grok's own read is the
// first signal; this keyword backstop is the safety net.
const SENSITIVE_RE = new RegExp(
  [
    "trump", "biden", "harris", "vance", "election", "fraud", "rigged", "deep state", "psyop",
    "mossad", "cia", "fbi", "genocide", "israel", "palestin", "gaza", "zionis", "ukrain", "putin",
    "abortion", "vaccine", "immigrant", "racis", "nazi", "epstein", "conspiracy",
    "guaranteed", "100x", "going to \\$", "to the moon", "buy now", "sell now", "rug",
    "ponzi", "scam", "fraudster", "pedo", "criminal",
  ].join("|"), "i"
);
// Put a blank line between each thought so the post breathes on X (skimmable whitespace).
function spaceLines(s) {
  return String(s || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).join("\n\n");
}

function classifyRisk(parts, grokSensitivity) {
  const blob = parts.filter(Boolean).join(" \n ");
  if (String(grokSensitivity || "").toLowerCase().startsWith("sens")) return "sensitive";
  if (SENSITIVE_RE.test(blob)) return "sensitive";
  return "low";
}

// ── slot generators ──────────────────────────────────────────────────────────
const COMMON_RULES = `RULES:
- The tweet body must be <= 260 characters and contain NO links and NO hashtags.
- "card" is a SHORT pull-line (<= 100 chars) printed on a branded image — punchy, screenshot-worthy.
- "sensitivity": "low" for evergreen/operator/market-color takes; "sensitive" if it's about a
  named politician, an active culture-war topic, a price prediction, or a personal accusation.
- Return STRICT JSON only, no prose.`;

async function genMorningTake() {
  const want = pickNiche(TREND_NICHES, 0);
  const prompt = `${TODAY()}\n${VOICE}\n\nUsing live X search, find the single biggest, most conversation-driving
story RIGHT NOW across these lanes: startups, venture capital, the economy/markets, crypto, tech/AI, US politics.
Prefer a strong story in the "${want}" lane if one exists; otherwise take the biggest story in any of these lanes.
Write ONE original hot take in Ben's voice — a sharp, contrarian or insightful angle most people are missing.
Return STRICT JSON:
{ "niche": "one of: politics|startups|vc|economy|crypto", "topic": "<=70 chars what it's about",
  "source_url": "the real x.com/news link you based it on, or \\"\\"",
  "text": "the tweet, <=260 chars, no links, no hashtags",
  "card": "<=100 char pull-line for the image",
  "sensitivity": "low|sensitive" }
${COMMON_RULES}`;
  const r = await callGrok(prompt, { liveSearch: true });
  return { kind: "single", niche: r.niche || want, topic: r.topic || "", text: r.text || "", card: r.card || r.topic || "", sourceUrl: r.source_url || "", sensitivity: r.sensitivity };
}

async function genMiddayLesson() {
  const want = pickNiche(LESSON_NICHES, 0);
  const prompt = `${TODAY()}\n${VOICE}\n\nWrite ONE founder/operator lesson in Ben's voice in the "${want}" lane
(building companies, raising/deploying capital, leadership, decision-making, the AI-era operator's edge).
It should feel earned and specific — a real frame or hard-won truth, not a platitude. A 2-4 line micro-list is fine.
You may use live X search to riff on what founders are actually arguing about today, but the lesson must stand alone.
Return STRICT JSON:
{ "niche": "startups|vc|personal-development", "topic": "<=70 chars",
  "text": "the tweet, <=260 chars, no links, no hashtags",
  "card": "<=100 char pull-line for the image", "sensitivity": "low|sensitive" }
${COMMON_RULES}`;
  const r = await callGrok(prompt, { liveSearch: true });
  return { kind: "single", niche: r.niche || want, topic: r.topic || "", text: r.text || "", card: r.card || r.topic || "", sensitivity: r.sensitivity };
}

async function genEveningQuote() {
  const want = pickNiche(QUOTE_NICHES, 0);
  const prompt = `${VOICE}\n\nCreate a QUOTE POST in the "${want}" theme (building, betting on yourself,
seeing through the noise, the AI era, discipline, growth). TWO parts:
1) "quote": ONE original Ben Klein aphorism — tight, memorable, screenshot-worthy, <=130 chars,
   no author tag, no quotation marks. (This goes on a branded image card.)
2) "caption": the TWEET TEXT that sits ABOVE the image. It must EARN the quote — elaborate on WHY
   it's true and what justifies it: the reasoning, the stakes, or a concrete example most people
   miss. World-class, specific, a little contrarian. Do NOT repeat the quote verbatim.
   2-4 short lines with line breaks, <=240 chars, no links, no hashtags, and END on a line that
   invites replies (a pointed question or a "prove me wrong" claim).
Return STRICT JSON:
{ "niche": "personal-development|quotes|startups", "quote": "<=130 chars",
  "caption": "<=240 chars", "sensitivity": "low|sensitive" }
STRICT JSON only, no prose.`;
  const r = await callGrok(prompt, { liveSearch: false });
  const quote = r.quote || "";
  return { kind: "single", niche: r.niche || want, topic: quote, text: (r.caption || quote), card: quote, sub: "", isQuote: true, sensitivity: r.sensitivity };
}

const THREAD_CTA = `If this resonated:\n\n• Follow @wcgbk — I post signal over noise, daily\n• Repost the first tweet to put it in front of a founder who needs it\n\nWhat would you add? 👇`;

async function genDailyThread() {
  const want = pickNiche(TREND_NICHES, 2); // offset so it differs from the morning take's niche
  const prompt = `${TODAY()}\n${VOICE}\n\nUsing live X search, pick the single biggest topic RIGHT NOW in the
"${want}" lane (or the biggest across startups/vc/economy/crypto/tech/politics if that lane is quiet) that Ben
can add a genuinely useful, contrarian perspective to. Write a tight X THREAD.
Return STRICT JSON:
{ "niche": "politics|startups|vc|economy|crypto", "topic": "<=70 chars", "source_url": "real link or \\"\\"",
  "index": "the hook tweet that makes people open the thread, <=260 chars, no links, no hashtags",
  "tweets": ["3 to 5 body tweets, each <=260 chars, each a complete thought, no links, no hashtags"],
  "card": "<=100 char pull-line for the index image", "sensitivity": "low|sensitive" }
RULES:
- The thread must teach or reframe — numbered points or a tight narrative. No fluff tweet.
- 4 to 6 total tweets including the index. STRICT JSON only.`;
  const r = await callGrok(prompt, { liveSearch: true });
  const body = (Array.isArray(r.tweets) ? r.tweets : []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 5);
  const tweets = [String(r.index || "").trim(), ...body, THREAD_CTA].filter(Boolean);
  return { kind: "thread", niche: r.niche || want, topic: r.topic || "", tweets, card: r.card || r.topic || "", sourceUrl: r.source_url || "", sensitivity: r.sensitivity };
}

// ── slot registry ────────────────────────────────────────────────────────────
// image strategy (research-backed): image posts get ~2.8x the engagement of text-only on X, so
// single posts (take/lesson/quote) ship WITH the bright 4:5 card. Threads stay text-only — the
// index tweet should pull people INTO the thread, not give them a card to screenshot and scroll past.
const SLOTS = {
  "morning-take": { gen: genMorningTake, autopostEligible: true, image: true },
  "midday-lesson": { gen: genMiddayLesson, autopostEligible: true, image: true },
  "evening-quote": { gen: genEveningQuote, autopostEligible: true, image: true },
  "daily-thread": { gen: genDailyThread, autopostEligible: false, image: false }, // threads ALWAYS held
};

async function notifyOwner(text) {
  const url = process.env.SIGNAL_DISCORD_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  } catch { /* best-effort */ }
}

// Render the branded card for a draft (best-effort — never block posting on image failure).
async function renderForDraft(slotKey, draft) {
  try {
    return await renderCard({
      kind: draft.isQuote ? "quote" : "take",
      niche: draft.niche,
      headline: draft.card || draft.topic || (draft.tweets && draft.tweets[0]) || "",
      sub: draft.sub || "",
    });
  } catch (e) {
    console.warn(`[signal] render failed for ${slotKey}: ${String(e).slice(0, 120)}`);
    return null;
  }
}

// MAIN — generate one slot, then auto-post (low-risk) or queue for approval.
// opts: { dryRun, mayPost, force }
async function runSlot(slotKey, opts = {}) {
  const slot = SLOTS[slotKey];
  if (!slot) throw new Error("unknown slot " + slotKey);
  const date = etDate();
  const store = blobStore("signal");
  const draftKey = `draft:${date}:${slotKey}`;
  const postedKey = `posted:${date}:${slotKey}`;

  // Idempotence — never double-post or regenerate a slot already handled today.
  if (!opts.force) {
    const already = await store.get(postedKey, { type: "json" }).catch(() => null);
    if (already) return { slot: slotKey, date, skipped: true, reason: "already posted", at: already.at };
    const existing = await store.get(draftKey, { type: "json" }).catch(() => null);
    if (existing && existing.status === "pending" && !opts.dryRun) {
      return { slot: slotKey, date, skipped: true, reason: "pending approval", id: draftKey };
    }
  }

  // 1) generate
  const gen = await slot.gen();
  if (gen.text) gen.text = spaceLines(gen.text); // blank line between thoughts → X whitespace
  const risk = classifyRisk([gen.text, gen.topic, gen.card, ...(gen.tweets || [])], gen.sensitivity);
  const autopost = process.env.SIGNAL_AUTOPOST === "on" && slot.autopostEligible && risk === "low";

  // 2) image
  const png = slot.image ? await renderForDraft(slotKey, gen) : null;

  const draft = {
    slot: slotKey, date, niche: gen.niche, topic: gen.topic, kind: gen.kind,
    text: gen.text || null, tweets: gen.tweets || null, isQuote: !!gen.isQuote,
    card: gen.card, sub: gen.sub || "", sourceUrl: gen.sourceUrl || "",
    risk, autopostPlanned: autopost, image: png ? png.toString("base64") : null,
    status: "draft", createdAt: new Date().toISOString(),
  };

  // 3) preview-only (dryRun or no posting authority) — store as pending, don't post
  if (opts.dryRun || !opts.mayPost) {
    draft.status = "pending";
    await store.setJSON(draftKey, draft);
    return { slot: slotKey, date, niche: gen.niche, risk, autopostPlanned: autopost,
      preview: gen.kind === "thread" ? gen.tweets : gen.text, queued: true, reason: opts.dryRun ? "dryRun" : "no posting authority" };
  }

  // 4) hold for approval (sensitive, or a slot that always holds e.g. thread)
  if (!autopost) {
    draft.status = "pending";
    await store.setJSON(draftKey, draft);
    await notifyOwner(`🟡 Signal draft pending approval — *${slotKey}* (${gen.niche}, risk:${risk})\n${(gen.text || (gen.tweets && gen.tweets[0]) || "").slice(0, 180)}\nReview → ${process.env.SIGNAL_SITE || "https://your-signal-site.netlify.app"}/review`);
    return { slot: slotKey, date, niche: gen.niche, risk, queued: true, reason: slot.autopostEligible ? "sensitive — held" : "slot always held", id: draftKey };
  }

  // 5) autopost (low-risk, eligible slot)
  try {
    let res;
    if (gen.kind === "thread") res = await X.postThread(gen.tweets, png);
    else res = await X.postSingle(gen.text, png);
    draft.status = "posted";
    draft.image = null; // don't keep the base64 around after posting
    await store.setJSON(draftKey, draft);
    await store.setJSON(postedKey, { at: new Date().toISOString(), ...res });
    const id = res.index || res.id;
    return { slot: slotKey, date, niche: gen.niche, risk, posted: true, url: X.tweetUrl(id), id };
  } catch (e) {
    // posting failed (e.g. account guard / no tokens) → keep the draft as pending so nothing is lost
    draft.status = "pending";
    await store.setJSON(draftKey, draft);
    return { slot: slotKey, date, niche: gen.niche, risk, queued: true, error: String(e).slice(0, 200), reason: e.guard ? "account guard" : "post failed — held" };
  }
}

// Post an already-approved draft (called from the review dashboard).
async function postApproved(draftKey) {
  const store = blobStore("signal");
  const d = await store.get(draftKey, { type: "json" }).catch(() => null);
  if (!d) throw new Error("draft not found");
  if (d.status === "posted") return { skipped: true, reason: "already posted" };
  const png = d.image ? Buffer.from(d.image, "base64") : null;
  let res;
  if (d.kind === "thread") res = await X.postThread(d.tweets, png);
  else res = await X.postSingle(d.text, png);
  d.status = "posted"; d.image = null; d.postedAt = new Date().toISOString();
  await store.setJSON(draftKey, d);
  await store.setJSON(`posted:${d.date}:${d.slot}`, { at: d.postedAt, ...res });
  const id = res.index || res.id;
  return { posted: true, url: X.tweetUrl(id), id };
}

module.exports = {
  runSlot, postApproved, blobStore, SLOTS, classifyRisk, pickNiche, dayIndex,
  // exposed for manual/preview testing (generation only — no blob writes, no posting)
  genMorningTake, genMiddayLesson, genEveningQuote, genDailyThread,
};
