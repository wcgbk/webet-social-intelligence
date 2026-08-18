// create-p2p-bet.js — Creates a P2P bet between two users
// Called from betty-webhook.js when bet intent detected, or via POST /api/create-p2p-bet
// Parses natural language, matches to tonight's games, generates WeBet string,
// stores in Blobs, sends challenge SMS to counterparty.

const crypto = require("crypto");

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = "+18557644821"; // Betty toll-free (1-on-1 SMS)
const TWILIO_GROUP = "+16624395428"; // Betty local (group MMS)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function generateBetId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(5);
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}

// ESPN endpoints for game matching
const ESPN_SPORTS = [
  { key: "nba", sport: "basketball", league: "nba", label: "NBA" },
  { key: "nhl", sport: "hockey", league: "nhl", label: "NHL" },
  { key: "mlb", sport: "baseball", league: "mlb", label: "MLB" },
  { key: "ncaam", sport: "basketball", league: "mens-college-basketball", label: "NCAAM" },
  { key: "nfl", sport: "football", league: "nfl", label: "NFL" },
  { key: "mls", sport: "soccer", league: "usa.1", label: "MLS" },
  { key: "epl", sport: "soccer", league: "eng.1", label: "EPL" },
];

function normalizeTeam(name) {
  return (name || "").toLowerCase().replace(/[^a-z]/g, "");
}

function teamsMatch(a, b) {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

async function fetchTonightGames() {
  const now = new Date();
  // EST offset
  const estOffset = -5;
  const est = new Date(now.getTime() + (estOffset * 60 + now.getTimezoneOffset()) * 60000);
  const dateStr = `${est.getFullYear()}${String(est.getMonth() + 1).padStart(2, "0")}${String(est.getDate()).padStart(2, "0")}`;

  const games = [];
  for (const s of ESPN_SPORTS) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${s.sport}/${s.league}/scoreboard?dates=${dateStr}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const event of data.events || []) {
        const competitors = event.competitions?.[0]?.competitors || [];
        if (competitors.length < 2) continue;
        const home = competitors.find((c) => c.homeAway === "home");
        const away = competitors.find((c) => c.homeAway === "away");
        games.push({
          id: event.id,
          sport: s.label,
          homeTeam: home?.team?.displayName || home?.team?.shortDisplayName || "",
          awayTeam: away?.team?.displayName || away?.team?.shortDisplayName || "",
          homeAbbr: home?.team?.abbreviation || "",
          awayAbbr: away?.team?.abbreviation || "",
          date: event.date,
          status: event.status?.type?.name || "pre",
          homeScore: parseInt(home?.score || "0"),
          awayScore: parseInt(away?.score || "0"),
        });
      }
    } catch (e) {
      console.warn(`[P2P] ESPN fetch failed for ${s.label}:`, e.message);
    }
  }
  return games;
}

function matchGame(teamText, games) {
  const text = normalizeTeam(teamText);
  for (const g of games) {
    if (teamsMatch(teamText, g.homeTeam) || teamsMatch(teamText, g.awayTeam) ||
        teamsMatch(teamText, g.homeAbbr) || teamsMatch(teamText, g.awayAbbr)) {
      return g;
    }
  }
  return null;
}

// Parse natural language bet
// Input: "bet @mike $20 lakers win tonight" or "bet @mike lakers win $20"
function parseBetText(text) {
  const handleMatch = text.match(/@(\w+)/);
  const amountMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
  const handle = handleMatch ? handleMatch[1] : null;
  const amount = amountMatch ? parseFloat(amountMatch[1]) : null;

  // Remove the handle and amount to get the proposition
  let proposition = text
    .replace(/@\w+/g, "")
    .replace(/\$\d+(?:\.\d{2})?/g, "")
    .replace(/^bet\s+/i, "")
    .replace(/\s+tonight$/i, "")
    .replace(/\s+today$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Extract team name (first capitalized word or known team)
  const teamMatch = proposition.match(/^(.+?)\s+(win|beat|cover|over|under|ml|moneyline|spread)/i);
  const team = teamMatch ? teamMatch[1].trim() : proposition.split(" ")[0];
  const betType = teamMatch ? teamMatch[2].toLowerCase() : "win";

  return { handle, amount, team, betType, proposition, raw: text };
}

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
}

function formatDate(d) {
  const date = new Date(d);
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`;
}

async function sendSMS(to, message, mediaUrl) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !to) return false;
  try {
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message });
    if (mediaUrl) params.append("MediaUrl", mediaUrl);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    // Log outbound message to conversation store
    if (res.ok) {
      try {
        const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
        const blobToken = process.env.NETLIFY_AUTH_TOKEN;
        if (blobToken) {
          const convoKey = to.replace(/\D/g, "");
          const convoUrl = "https://api.netlify.com/api/v1/blobs/" + siteId + "/betty-conversations/" + convoKey;
          const headers = { "Authorization": "Bearer " + blobToken };

          // Load existing convo
          var convo = { phone: to, started: new Date().toISOString(), messages: [] };
          try {
            var cResp = await fetch(convoUrl, { headers: headers });
            if (cResp.ok) {
              var saved = await cResp.json();
              if (saved) convo = saved;
            }
          } catch (_) {}

          // Add Betty's outbound message
          convo.messages.push({ role: "assistant", content: message, ts: new Date().toISOString() });
          if (convo.messages.length > 40) convo.messages = convo.messages.slice(-40);

          // Save
          await fetch(convoUrl, {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(convo),
          });
        }
      } catch (_) {}
    }

    return res.ok;
  } catch (e) {
    console.error("[P2P] SMS failed:", e.message);
    return false;
  }
}

// Send Betty intro as two messages: (1) square headshot + intro text, (2) vCard
const BETTY_VCARD_URL = "https://webetsocial.com/betty.vcf?v=20260818";
const BETTY_SMS_PHOTO = "https://webetsocial.com/betty-sms.jpg?v=20260818";

async function sendBettyVCard(to) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !to) return false;
  try {
    var authHeader = "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64");
    var apiUrl = "https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_SID + "/Messages.json";
    var headers = { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" };

    // Message 1: Square headshot + intro text
    var params1 = new URLSearchParams({
      To: to, From: TWILIO_FROM,
      Body: "Hey! I'm Betty from WeBetAI. Save me in your contacts so you know it's me.\n\nwebetsocial.com/dashboard\n\nAsk me anything — sports, news, politics, prediction markets, and entertainment.",
    });
    params1.append("MediaUrl", BETTY_SMS_PHOTO);
    await fetch(apiUrl, { method: "POST", headers: headers, body: params1.toString() });

    // Small delay to ensure ordering
    await new Promise(function(r) { setTimeout(r, 2000); });

    // Message 2: vCard
    var params2 = new URLSearchParams({
      To: to, From: TWILIO_FROM,
      Body: "Save my contact card!",
    });
    params2.append("MediaUrl", BETTY_VCARD_URL);
    var res = await fetch(apiUrl, { method: "POST", headers: headers, body: params2.toString() });

    return res.ok;
  } catch (e) {
    console.error("[P2P] vCard send failed:", e.message);
    return false;
  }
}

// Main handler — can be called from betty-webhook or directly via API
async function createP2PBet({ initiatorPhone, initiatorHandle, counterpartyHandle, counterpartyPhone, betText, amount, team, betType, proposition }) {
  const { getStore } = await import("@netlify/blobs");

  // Fetch tonight's games
  const games = await fetchTonightGames();
  const game = matchGame(team, games);

  if (!game) {
    return { success: false, error: `No game found matching "${team}" tonight. ${games.length} games on the board.` };
  }

  // Determine sides
  const initiatorTeam = teamsMatch(team, game.homeTeam) || teamsMatch(team, game.homeAbbr) ? game.homeTeam : game.awayTeam;
  const counterpartyTeam = initiatorTeam === game.homeTeam ? game.awayTeam : game.homeTeam;

  // Generate bet
  const betId = generateBetId();
  const amountCents = Math.round((amount || 20) * 100);
  const gameDate = formatDate(game.date);
  const webetString = `@${titleCase(counterpartyHandle || "Friend")} WeBet $${amount || 20} ${titleCase(initiatorTeam)} Beats ${titleCase(counterpartyTeam)} On ${gameDate}`;

  const bet = {
    id: betId,
    initiatorPhone: initiatorPhone,
    initiatorHandle: initiatorHandle || "unknown",
    counterpartyPhone: counterpartyPhone || null,
    counterpartyHandle: counterpartyHandle || null,
    sport: game.sport,
    gameId: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    matchup: `${game.awayTeam} vs ${game.homeTeam}`,
    gameDate: game.date,
    betText: betText,
    proposition: proposition || `${initiatorTeam} wins`,
    initiatorSide: initiatorTeam,
    counterpartySide: counterpartyTeam,
    amount: amountCents,
    amountDisplay: amount || 20,
    webetString: webetString,
    category: "sports",
    status: "pending", // pending → active → resolved → settled
    result: null, // initiator_wins / counterparty_wins / push
    winnerPhone: null,
    loserPhone: null,
    finalScore: null,
    resolutionSource: "espn",
    settlementStatus: "unsettled",
    counterAmount: null,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    resolvedAt: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24hr expiry
    events: [{ type: "created", actor: initiatorPhone, ts: new Date().toISOString() }],
  };

  // Store to Blobs
  const betsStore = getStore("p2p-bets");
  await betsStore.setJSON(`bet-${betId}`, bet);

  // Update user index (upsert initiator)
  await upsertUser(initiatorPhone, initiatorHandle);

  // Update pending bets index for the counterparty (for reply routing)
  if (counterpartyPhone) {
    const pendingKey = `pending-${counterpartyPhone.replace(/\D/g, "")}`;
    await betsStore.set(pendingKey, betId);
  }

  // Update recent bets index
  try {
    const recentStore = getStore("p2p-bets");
    let recent = [];
    try {
      const r = await recentStore.get("recent-index", { type: "json" });
      if (r) recent = r;
    } catch (_) {}
    recent.unshift({ id: betId, matchup: bet.matchup, sport: bet.sport, amount: bet.amountDisplay, status: "pending", createdAt: bet.createdAt });
    if (recent.length > 100) recent = recent.slice(0, 100);
    await recentStore.setJSON("recent-index", recent);
  } catch (_) {}

  return { success: true, bet, game };
}

async function upsertUser(phone, handle) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("p2p-users");
    const key = phone.replace(/\D/g, "");
    let user = null;
    try { user = await store.get(`user-${key}`, { type: "json" }); } catch (_) {}
    if (!user) {
      user = {
        phone, handle: handle || null, displayName: handle || null,
        createdAt: new Date().toISOString(),
        wins: 0, losses: 0, pushes: 0,
        totalWagered: 0, totalWon: 0,
        currentStreak: 0, bestStreak: 0, allTimePL: 0,
        bets: [],
      };
    }
    if (handle && !user.handle) user.handle = handle;
    await store.setJSON(`user-${key}`, user);
    // Also index by handle
    if (user.handle) {
      await store.set(`handle-${user.handle.toLowerCase()}`, key);
    }
  } catch (e) {
    console.warn("[P2P] User upsert failed:", e.message);
  }
}

// HTTP handler for direct API calls
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  try {
    const body = JSON.parse(event.body || "{}");
    const result = await createP2PBet(body);

    if (!result.success) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify(result) };
    }

    // Create group chat + send challenge
    if (result.bet.counterpartyPhone) {
      // Try to create group MMS conversation
      const convoSid = await createGroupChat(result.bet);
      if (convoSid) {
        result.bet.conversationSid = convoSid;
        // Send challenge in the group chat
        const msg = `🤝 @${result.bet.initiatorHandle} challenged @${result.bet.counterpartyHandle}!\n\n${result.bet.webetString}\n\n@${result.bet.counterpartyHandle} — you'd take: ${result.bet.counterpartySide}\n\nReply ACCEPT, COUNTER $amt, or PASS\n\nwebetsocial.com/handshake/${result.bet.id}`;
        await sendGroupMessage(convoSid, msg, "betty");
      } else {
        // Fallback to individual SMS
        const msg = `🤝 @${result.bet.initiatorHandle} challenged you!\n\n${result.bet.webetString}\n\nYou'd take: ${result.bet.counterpartySide}\n\nReply ACCEPT, COUNTER $amt, or PASS\n\nwebetsocial.com/handshake/${result.bet.id}`;
        await sendSMS(result.bet.counterpartyPhone, msg);
      }
      result.bet.events.push({ type: "sent", actor: "system", ts: new Date().toISOString() });

      // Update blob with sent event + conversation SID
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("p2p-bets");
      await store.setJSON(`bet-${result.bet.id}`, result.bet);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        betId: result.bet.id,
        webetString: result.bet.webetString,
        matchup: result.bet.matchup,
        sport: result.bet.sport,
        betUrl: `https://webetsocial.com/handshake/${result.bet.id}`,
      }),
    };
  } catch (err) {
    console.error("[P2P] Create bet error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

// ── GROUP MMS via Twilio Conversations API ──
const TWILIO_CONVO_BASE = `https://conversations.twilio.com/v1`;

function twilioFetch(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
}

// Create a group conversation for a bet
async function createGroupChat(bet) {
  if (!TWILIO_SID || !TWILIO_TOKEN) return null;
  if (!bet.initiatorPhone || !bet.counterpartyPhone) return null;

  try {
    // 1. Create conversation
    const convoResp = await twilioFetch(`${TWILIO_CONVO_BASE}/Conversations`, {
      FriendlyName: `WeBet ${bet.id}: ${bet.matchup}`,
      "Attributes": JSON.stringify({ betId: bet.id, matchup: bet.matchup }),
    });
    if (!convoResp.ok) {
      console.error("[P2P] Create conversation failed:", await convoResp.text());
      return null;
    }
    const convo = await convoResp.json();
    const convoSid = convo.sid;

    // 2. Add Betty as chat participant with the group MMS number as projected address
    await twilioFetch(`${TWILIO_CONVO_BASE}/Conversations/${convoSid}/Participants`, {
      Identity: "betty",
      "MessagingBinding.ProjectedAddress": TWILIO_GROUP,
    });

    // 3. Add User A as SMS participant
    await twilioFetch(`${TWILIO_CONVO_BASE}/Conversations/${convoSid}/Participants`, {
      "MessagingBinding.Address": bet.initiatorPhone,
      "MessagingBinding.ProxyAddress": TWILIO_GROUP,
    });

    // 4. Add User B as SMS participant
    await twilioFetch(`${TWILIO_CONVO_BASE}/Conversations/${convoSid}/Participants`, {
      "MessagingBinding.Address": bet.counterpartyPhone,
      "MessagingBinding.ProxyAddress": TWILIO_GROUP,
    });

    console.log(`[P2P] Group chat created: ${convoSid} for bet ${bet.id}`);
    return convoSid;
  } catch (e) {
    console.error("[P2P] Group chat error:", e.message);
    return null;
  }
}

// Send a message to an existing group conversation
async function sendGroupMessage(convoSid, message, author) {
  if (!convoSid || !TWILIO_SID) return false;
  try {
    const resp = await twilioFetch(`${TWILIO_CONVO_BASE}/Conversations/${convoSid}/Messages`, {
      Author: author || "betty",
      Body: message,
    });
    return resp.ok;
  } catch (e) {
    console.error("[P2P] Group message error:", e.message);
    return false;
  }
}

// Send to BOTH users — uses group chat if available, falls back to individual SMS
async function notifyBoth(bet, message) {
  // Try group chat first
  if (bet.conversationSid) {
    const ok = await sendGroupMessage(bet.conversationSid, message);
    if (ok) return;
  }
  // Fallback: individual SMS
  const promises = [];
  if (bet.initiatorPhone) promises.push(sendSMS(bet.initiatorPhone, message));
  if (bet.counterpartyPhone) promises.push(sendSMS(bet.counterpartyPhone, message));
  return Promise.allSettled(promises);
}

// Export for use by betty-webhook
module.exports.createP2PBet = createP2PBet;
module.exports.sendSMS = sendSMS;
module.exports.sendBettyVCard = sendBettyVCard;
module.exports.notifyBoth = notifyBoth;
module.exports.sendGroupMessage = sendGroupMessage;
module.exports.createGroupChat = createGroupChat;
module.exports.upsertUser = upsertUser;
module.exports.parseBetText = parseBetText;
module.exports.fetchTonightGames = fetchTonightGames;
module.exports.handler = exports.handler;
