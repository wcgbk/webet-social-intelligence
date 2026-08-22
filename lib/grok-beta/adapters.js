"use strict";

const { ODDS_SPORTS } = require("./sports");

function easternDateISO(d) {
  const et = new Date((d || new Date()).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const day = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateLong(dateISO) {
  return new Date(dateISO + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function addDaysISO(dateISO, n) {
  const d = new Date(dateISO + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function gameEasternDate(isoTime) {
  return easternDateISO(new Date(isoTime));
}

async function fetchOddsForSport(apiKey, sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const t = await resp.text();
    console.log(`[grok-beta] odds ${sportKey} ${resp.status}: ${t.slice(0, 120)}`);
    return { sport: sportKey, games: [], error: resp.status };
  }
  const games = await resp.json();
  return { sport: sportKey, games: Array.isArray(games) ? games : [], remaining: resp.headers.get("x-requests-remaining") };
}

async function fetchAllOdds(apiKey) {
  const out = [];
  for (const s of ODDS_SPORTS) {
    try {
      const r = await fetchOddsForSport(apiKey, s.key);
      out.push({ ...r, meta: s });
    } catch (e) {
      console.log(`[grok-beta] odds ${s.key} threw: ${e.message}`);
      out.push({ sport: s.key, games: [], error: e.message, meta: s });
    }
  }
  return out;
}

function extractProbable(competitor) {
  const p = competitor?.probables?.[0] || competitor?.probable || null;
  if (!p) return null;
  return p.athlete?.displayName || p.displayName || p.name || null;
}

function mapEspnInjuries(items) {
  return (items || []).slice(0, 12).map(i => ({
    name: i.athlete?.displayName || "Unknown",
    status: i.status || i.type || "Unknown",
    detail: i.details?.detail || i.shortComment || i.longComment || "",
    position: i.athlete?.position?.abbreviation || "",
  }));
}

async function fetchEspnLeague(meta, dateISO) {
  const dateParam = dateISO.replace(/-/g, "");
  const scoreUrl = `https://site.api.espn.com/apis/site/v2/sports/${meta.espnSport}/${meta.espnLeague}/scoreboard?dates=${dateParam}`;
  const resp = await fetch(scoreUrl);
  if (!resp.ok) return { games: [], yesterdayTeams: new Set() };
  const data = await resp.json();
  const games = [];
  for (const event of (data.events || [])) {
    const competition = event.competitions?.[0];
    if (!competition) continue;
    const state = (event.status?.type?.state || "").toLowerCase();
    const desc = (event.status?.type?.description || "").toLowerCase();
    const home = competition.competitors?.find(c => c.homeAway === "home");
    const away = competition.competitors?.find(c => c.homeAway === "away");
    games.push({
      id: event.id,
      name: event.name || event.shortName,
      date: event.date,
      state,
      status: event.status?.type?.description || "Scheduled",
      postponed: /postpon|cancel|delay|suspend/.test(desc) || state === "postponed",
      homeTeam: home?.team?.displayName || "",
      awayTeam: away?.team?.displayName || "",
      homeAbbr: home?.team?.abbreviation || "",
      awayAbbr: away?.team?.abbreviation || "",
      homeId: home?.team?.id,
      awayId: away?.team?.id,
      homeStarter: extractProbable(home),
      awayStarter: extractProbable(away),
      venue: competition.venue?.fullName || "",
    });
  }
  return { games };
}

async function fetchYesterdayTeams(meta, dateISO) {
  const y = addDaysISO(dateISO, -1);
  try {
    const { games } = await fetchEspnLeague(meta, y);
    const names = new Set();
    for (const g of games) {
      if (g.homeTeam) names.add(normName(g.homeTeam));
      if (g.awayTeam) names.add(normName(g.awayTeam));
    }
    return names;
  } catch (e) {
    return new Set();
  }
}

async function fetchInjuries(meta, teamId) {
  if (!teamId) return [];
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${meta.espnSport}/${meta.espnLeague}/teams/${teamId}/injuries`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return mapEspnInjuries(data.items || data.injuries || []);
  } catch (e) {
    return [];
  }
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function namesMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = na.split(" ").pop();
  const lb = nb.split(" ").pop();
  if (la.length > 3 && la === lb) return true;
  return na.includes(nb) || nb.includes(na);
}

async function attachEspn(oddsBySport, dateISO) {
  const espnByLabel = {};
  const yestByLabel = {};
  const uniqueMeta = [];
  const seen = new Set();
  for (const s of ODDS_SPORTS) {
    const k = `${s.espnSport}/${s.espnLeague}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueMeta.push(s);
  }
  await Promise.all(uniqueMeta.map(async (meta) => {
    try {
      const [today, yest] = await Promise.all([
        fetchEspnLeague(meta, dateISO),
        fetchYesterdayTeams(meta, dateISO),
      ]);
      espnByLabel[meta.label] = today.games;
      yestByLabel[meta.label] = yest;
    } catch (e) {
      espnByLabel[meta.label] = [];
      yestByLabel[meta.label] = new Set();
    }
  }));

  const enriched = [];
  for (const bundle of oddsBySport) {
    const meta = bundle.meta;
    const espnGames = espnByLabel[meta.label] || [];
    const yest = yestByLabel[meta.label] || new Set();
    for (const og of bundle.games || []) {
      const espn = espnGames.find(g =>
        namesMatch(g.homeTeam, og.home_team) && namesMatch(g.awayTeam, og.away_team)
      ) || espnGames.find(g =>
        namesMatch(g.homeTeam, og.home_team) || namesMatch(g.awayTeam, og.away_team)
      ) || null;

      let homeInjuries = [], awayInjuries = [];
      if (espn?.homeId || espn?.awayId) {
        [homeInjuries, awayInjuries] = await Promise.all([
          fetchInjuries(meta, espn?.homeId),
          fetchInjuries(meta, espn?.awayId),
        ]);
      }

      enriched.push({
        label: meta.label,
        family: meta.family,
        sportKey: meta.key,
        homeTeam: og.home_team,
        awayTeam: og.away_team,
        commenceTime: og.commence_time,
        oddsGame: og,
        espnState: espn?.state || null,
        espnStatus: espn?.status || null,
        postponed: !!(espn && espn.postponed),
        homeStarter: espn?.homeStarter || null,
        awayStarter: espn?.awayStarter || null,
        homeInjuries,
        awayInjuries,
        homePlayedYesterday: yest.has(normName(og.home_team)) || (espn && yest.has(normName(espn.homeTeam))),
        awayPlayedYesterday: yest.has(normName(og.away_team)) || (espn && yest.has(normName(espn.awayTeam))),
        venue: espn?.venue || "",
      });
    }
  }
  return { enriched, espnByLabel };
}

async function fetchKalshiBrief() {
  const series = ["KXMLBGAME", "KXNBAGAME", "KXNHLGAME", "KXNFLGAME"];
  const markets = [];
  for (const ticker of series) {
    try {
      const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${ticker}&with_nested_markets=true&status=open`);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const event of (data.events || []).slice(0, 40)) {
        for (const m of (event.markets || []).slice(0, 8)) {
          const last = m.last_price_dollars || m.last_price || 0;
          const yesBid = m.yes_bid_dollars || m.yes_bid || 0;
          const yesAsk = m.yes_ask_dollars || m.yes_ask || 0;
          const yes = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : last || null;
          markets.push({
            source: "kalshi",
            title: m.title || m.subtitle || event.title || "",
            ticker: m.ticker || "",
            yesPrice: yes,
          });
        }
      }
    } catch (e) {
      console.log(`[grok-beta] kalshi ${ticker}: ${e.message}`);
    }
  }
  return markets;
}

async function fetchPolymarketBrief() {
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=80");
    if (!resp.ok) return [];
    const data = await resp.json();
    const events = Array.isArray(data) ? data : (data.events || []);
    const out = [];
    for (const ev of events.slice(0, 80)) {
      const title = ev.title || ev.question || "";
      const mkts = ev.markets || [];
      for (const m of mkts.slice(0, 4)) {
        let price = null;
        try {
          const raw = m.outcomePrices || m.outcome_prices;
          const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (Array.isArray(arr) && arr.length) price = parseFloat(arr[0]);
        } catch (e) {}
        out.push({ source: "polymarket", title: m.question || title, yesPrice: price });
      }
    }
    return out;
  } catch (e) {
    console.log(`[grok-beta] polymarket: ${e.message}`);
    return [];
  }
}

function matchPredPrice(homeTeam, awayTeam, markets) {
  if (!markets || !markets.length) return null;
  const h = normName(homeTeam).split(" ").pop();
  const a = normName(awayTeam).split(" ").pop();
  if (!h || !a) return null;
  for (const m of markets) {
    const t = normName(m.title);
    if (t.includes(h) && t.includes(a) && m.yesPrice > 0.05 && m.yesPrice < 0.95) {
      const homeMentionedFirst = t.indexOf(h) < t.indexOf(a);
      return {
        priceHome: homeMentionedFirst ? m.yesPrice : (1 - m.yesPrice),
        source: m.source,
        title: m.title,
      };
    }
  }
  return null;
}

module.exports = {
  easternDateISO, formatDateLong, addDaysISO, gameEasternDate,
  fetchAllOdds, attachEspn, fetchKalshiBrief, fetchPolymarketBrief, matchPredPrice,
  namesMatch, normName,
};
