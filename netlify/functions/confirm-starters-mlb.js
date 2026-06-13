// confirm-starters-mlb.js
// Runs at 1:30pm EDT (5 hours after picks generate). Reads today's picks from the blob,
// re-checks ESPN for current starters, and flags any scratches with a scratchWarning.
// No new edges are computed — only starter identity is verified.
// Background function.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchCurrentStarters(dateISO) {
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const data = await resp.json();
    const map = {};
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) continue;
      const awayProb = away.probables?.[0] || {};
      const homeProb = home.probables?.[0] || {};
      const key = [away.team?.displayName, home.team?.displayName]
        .map(t => normalizeTeam(t).split(' ').pop()).join('_');
      map[key] = {
        awayTeam: away.team?.displayName || '',
        homeTeam: home.team?.displayName || '',
        awaySP: awayProb.athlete?.displayName || awayProb.displayName || 'TBD',
        homeSP: homeProb.athlete?.displayName || homeProb.displayName || 'TBD',
        status: ev.status?.type?.state || 'pre',
      };
    }
    return map;
  } catch (e) {
    console.log(`[confirm-starters] ESPN error: ${e.message}`);
    return {};
  }
}

async function storeBlob(key, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("edge-picks-mlb");
    await store.set(key, body);
  } catch (e) { /* fall through */ }
  try {
    await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mlb/${key}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
  } catch (e) { /* fall through */ }
}

exports.handler = async (event) => {
  try {
    const now = new Date();
    const dateISO = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now).split('/').reverse().map((p, i) => i === 0 ? p : p.padStart(2, '0')).join('-')
      .replace(/(\d{4})-(\d{2})-(\d{2})/, (_, y, m, d) => `${y}-${m}-${d}`);

    // Actually just use YYYY-MM-DD directly
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const todayISO = `${y}-${m}-${d}`;

    console.log(`[confirm-starters] Running starter check for ${todayISO}`);

    // Read today's picks
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      console.log('[confirm-starters] No NETLIFY_AUTH_TOKEN — skipping');
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'no token' }) };
    }

    const picksResp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mlb/picks-${todayISO}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!picksResp.ok) {
      console.log(`[confirm-starters] No picks found for ${todayISO}`);
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'no picks today' }) };
    }
    const picksData = await picksResp.json();
    const picks = picksData.picks || [];
    if (picks.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'empty picks' }) };
    }

    // Fetch current starters from ESPN
    const currentStarters = await fetchCurrentStarters(todayISO);
    let scratches = 0;

    for (const pick of picks) {
      // Find the matching game in current ESPN data
      const [awayName, homeName] = (pick.matchup || '').split(' @ ');
      if (!awayName || !homeName) continue;
      const awayKey = normalizeTeam(awayName).split(' ').pop();
      const homeKey = normalizeTeam(homeName).split(' ').pop();
      const espnKey = `${awayKey}_${homeKey}`;
      const current = currentStarters[espnKey];
      if (!current) continue;

      // Check if game already started
      if (current.status === 'in' || current.status === 'post') {
        pick.gameStarted = true;
        continue;
      }

      // Compare starters
      const origAway = normalizeTeam(pick.awaySP || '');
      const origHome = normalizeTeam(pick.homeSP || '');
      const curAway = normalizeTeam(current.awaySP);
      const curHome = normalizeTeam(current.homeSP);

      const awayScratch = origAway && curAway && origAway !== curAway && curAway !== 'tbd';
      const homeScratch = origHome && curHome && origHome !== curHome && curHome !== 'tbd';

      if (awayScratch || homeScratch) {
        scratches++;
        pick.starterScratch = true;
        pick.scratchDetails = [];
        if (awayScratch) {
          pick.scratchDetails.push(`${awayName} SP changed: ${pick.awaySP} → ${current.awaySP}`);
          pick.awaySP = current.awaySP; // update to current
        }
        if (homeScratch) {
          pick.scratchDetails.push(`${homeName} SP changed: ${pick.homeSP} → ${current.homeSP}`);
          pick.homeSP = current.homeSP;
        }
        pick.scratchWarning = `⚠️ Starter change detected. Original pick was based on: ${pick.scratchDetails.join('; ')}. Verify before betting.`;
        console.log(`[confirm-starters] SCRATCH: ${pick.matchup} — ${pick.scratchDetails.join(', ')}`);
      } else {
        pick.starterConfirmed = true;
      }
    }

    // Write updated picks back (preserves all other fields)
    picksData.starterCheckAt = new Date().toISOString();
    picksData.starterScratchCount = scratches;
    await storeBlob(`picks-${todayISO}`, picksData);

    console.log(`[confirm-starters] Done: ${picks.length} picks checked, ${scratches} scratches`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, date: todayISO, picksChecked: picks.length, scratches }),
    };
  } catch (e) {
    console.error(`[confirm-starters] Error: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
