// confirm-starters-mlb.js
// 1:30pm ET re-check of ESPN probable starters against today's Alpha + Omega cards.
// Flags SP changes; KILLS SP-dependent picks (MLB Total / Moneyline / F5 / Run Line)
// when the starter used at generation time no longer matches ESPN.
// Does not recompute edges. Writes the updated blob back to the same store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORES = ["edge-picks-alpha", "edge-picks-omega"];

function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function normalizeTeam(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function matchupParts(matchup) {
  return String(matchup || "").split(/\s+(?:@|vs\.?|at)\s+/i).map(s => s.trim()).filter(Boolean);
}

function isSpDependent(pick) {
  const bt = String(pick.betType || pick.market || "").toLowerCase();
  const side = String(pick.pick || pick.side || "");
  if (/\bf5\b/i.test(bt) || /\bf5\b/i.test(side)) return true;
  if (bt.includes("total")) return true;
  if (bt.includes("moneyline")) return true;
  if (bt.includes("run line") || bt.includes("spread")) return true;
  return false;
}

async function fetchCurrentStarters(dateISO) {
  try {
    const dateParam = dateISO.replace(/-/g, "");
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const data = await resp.json();
    const map = {};
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const away = comp.competitors?.find(c => c.homeAway === "away");
      const home = comp.competitors?.find(c => c.homeAway === "home");
      if (!away || !home) continue;
      const awayProb = away.probables?.[0] || {};
      const homeProb = home.probables?.[0] || {};
      const key = [away.team?.displayName, home.team?.displayName]
        .map(t => normalizeTeam(t).split(" ").pop()).join("_");
      map[key] = {
        awayTeam: away.team?.displayName || "",
        homeTeam: home.team?.displayName || "",
        awaySP: awayProb.athlete?.displayName || awayProb.displayName || "TBD",
        homeSP: homeProb.athlete?.displayName || homeProb.displayName || "TBD",
        status: ev.status?.type?.state || "pre",
      };
    }
    return map;
  } catch (e) {
    console.log(`[confirm-starters] ESPN error: ${e.message}`);
    return {};
  }
}

async function blobGet(store, key, token) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const s = getStore(store);
    const v = await s.get(key, { type: "json" });
    if (v) return v;
  } catch (e) { /* fall through */ }
  try {
    const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) return await r.json();
  } catch (e) { /* fall through */ }
  return null;
}

async function blobPut(store, key, value, token) {
  const body = JSON.stringify(value);
  try {
    const { getStore } = await import("@netlify/blobs");
    const s = getStore(store);
    await s.set(key, body);
  } catch (e) { /* fall through */ }
  try {
    await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
  } catch (e) { /* fall through */ }
}

function lookupEspn(currentStarters, pick) {
  const parts = matchupParts(pick.matchup);
  if (parts.length < 2) return null;
  const awayKey = normalizeTeam(parts[0]).split(" ").pop();
  const homeKey = normalizeTeam(parts[1]).split(" ").pop();
  return currentStarters[`${awayKey}_${homeKey}`] || currentStarters[`${homeKey}_${awayKey}`] || null;
}

function processPicks(picksData, currentStarters) {
  const picks = picksData.picks || [];
  let scratches = 0;
  let killed = 0;
  const kept = [];
  const killedPicks = picksData.killedPicks || [];

  for (const pick of picks) {
    if (String(pick.sport || "") !== "MLB") {
      kept.push(pick);
      continue;
    }
    const current = lookupEspn(currentStarters, pick);
    if (!current) {
      kept.push(pick);
      continue;
    }
    if (current.status === "in" || current.status === "post") {
      pick.gameStarted = true;
      kept.push(pick);
      continue;
    }

    const origAway = normalizeTeam(pick.awaySP || "");
    const origHome = normalizeTeam(pick.homeSP || "");
    const curAway = normalizeTeam(current.awaySP);
    const curHome = normalizeTeam(current.homeSP);

    const awayScratch = origAway && curAway && origAway !== curAway && curAway !== "tbd";
    const homeScratch = origHome && curHome && origHome !== curHome && curHome !== "tbd";

    if (awayScratch || homeScratch) {
      scratches++;
      pick.starterScratch = true;
      pick.scratchDetails = [];
      if (awayScratch) {
        pick.scratchDetails.push(`${current.awayTeam} SP changed: ${pick.awaySP} → ${current.awaySP}`);
        pick.awaySP = current.awaySP;
      }
      if (homeScratch) {
        pick.scratchDetails.push(`${current.homeTeam} SP changed: ${pick.homeSP} → ${current.homeSP}`);
        pick.homeSP = current.homeSP;
      }
      pick.scratchWarning = `Starter change detected: ${pick.scratchDetails.join("; ")}.`;
      console.log(`[confirm-starters] SCRATCH: ${pick.matchup} — ${pick.scratchDetails.join(", ")}`);

      if (isSpDependent(pick)) {
        killed++;
        pick.killed = true;
        pick.killReason = `SP-dependent ${pick.betType || pick.market || "pick"} voided after starter change`;
        killedPicks.push(pick);
        continue;
      }
    } else if (origAway || origHome) {
      pick.starterConfirmed = true;
    } else {
      // No original SP stored (pre-v10.6 cards). Snapshot current names; do not kill.
      pick.awaySP = pick.awaySP || current.awaySP;
      pick.homeSP = pick.homeSP || current.homeSP;
      pick.starterSnapshotOnly = true;
    }
    kept.push(pick);
  }

  picksData.picks = kept;
  picksData.killedPicks = killedPicks;
  if (picksData.summary) {
    const totalUnits = kept.reduce((s, p) => s + (parseFloat(p.units) || 0), 0);
    picksData.summary.totalPicks = kept.length;
    picksData.summary.totalStraightBets = kept.length;
    picksData.summary.totalUnits = `${totalUnits.toFixed(2)}u`;
    picksData.summary.sportsCovered = [...new Set(kept.map(p => p.sport))];
  }
  if (kept.length < 2 && Array.isArray(picksData.parlayLegs)) {
    picksData.parlayLegs = [];
    picksData.parlayKilledReason = "Parlay dropped — fewer than 2 live legs after SP kill";
  }
  return { scratches, killed, remaining: kept.length };
}

exports.handler = async () => {
  try {
    const todayISO = todayET();
    console.log(`[confirm-starters] Running starter check for ${todayISO} (ET) on Alpha+Omega`);

    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      console.log("[confirm-starters] No NETLIFY_AUTH_TOKEN — skipping");
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "no token" }) };
    }

    const currentStarters = await fetchCurrentStarters(todayISO);
    const perStore = [];

    for (const store of STORES) {
      const picksData = await blobGet(store, `picks-${todayISO}`, token);
      if (!picksData || !Array.isArray(picksData.picks) || picksData.picks.length === 0) {
        perStore.push({ store, skipped: true, reason: "no picks today" });
        continue;
      }
      const stats = processPicks(picksData, currentStarters);
      picksData.starterCheckAt = new Date().toISOString();
      picksData.starterScratchCount = stats.scratches;
      picksData.starterKilledCount = stats.killed;
      await blobPut(store, `picks-${todayISO}`, picksData, token);
      perStore.push({ store, date: todayISO, ...stats });
      console.log(`[confirm-starters] ${store}: remaining=${stats.remaining} scratches=${stats.scratches} killed=${stats.killed}`);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, date: todayISO, stores: perStore }) };
  } catch (e) {
    console.error(`[confirm-starters] Error: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
