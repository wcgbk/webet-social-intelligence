// betty-webhook.js — Netlify Function
// Twilio webhook for incoming SMS. Receives user replies, calls Grok API
// as Betty, and responds via TwiML. Maintains conversation history in Blobs.

const { getStore } = require('@netlify/blobs');

const BETTY_SYSTEM_PROMPT = `You are Betty, WeBetAI's AI. Friendly, knowledgeable, and helpful via text message.

VOICE: Warm, sharp, confident, and fun — like the person at the bar who knows more about sports than everyone. Engaging, direct, compliment good questions, keep it energetic. Do NOT flirt, use pet names ("handsome", "babe", etc.), or be romantically suggestive. EXCEPTION: If a user clearly flirts first, you can lightly and humorously play along once — then steer back to the topic. You can talk about anything.
NEVER say "haha", "lol", or any laughing. No laughing emojis. Hard rule. Dry wit only.
No markdown. Plain text. Under 400 chars default, up to 800 if they want detail.

PICKS: Only endorse picks from LIVE DATA. Never make your own. Game not in picks = "That one didn't make the cut today."
RESPONSE: Never direct people to URLs, pages, or dashboards. You have all the data — just answer the question directly. You ARE the interface. Only give a URL if they explicitly ask for the link.
P2P BETS: bet @handle $amount team wins | ACCEPT | COUNTER $amt | PASS`;

// Build live context from ALL WeBetAI data sources
async function buildBettyContext(fromPhone) {
  const parts = [];
  const phoneKey = fromPhone.replace(/\D/g, "");
  const siteUrl = process.env.URL || "https://webetsocial.com";

  try {
    const results = await Promise.allSettled([
      // 1. Today's picks (ALL picks, not just top 3)
      (async () => {
        const store = getStore("edge-picks-alpha");
        const latestDate = await store.get("latest-date");
        if (!latestDate) return null;
        const picks = await store.get("picks-" + latestDate.trim(), { type: "json" });
        if (!picks || !picks.picks || !picks.picks.length) return null;
        let s = "Date: " + (picks.dateFormatted || picks.date) + " | " + picks.summary.totalPicks + " picks, " + picks.summary.totalUnits + " units\n";
        s += "Sports: " + (picks.summary.sportsCovered || []).join(", ") + "\n";
        picks.picks.forEach(function(p, i) {
          s += "\n#" + (i + 1) + " [" + p.rating + "] " + p.sport + ": " + p.matchup;
          s += "\n  " + p.pick + " | " + p.betType + " | Odds: " + p.odds + " | " + p.units + "u";
          s += "\n  Why: " + p.coreReasoning;
          s += "\n  Risk: " + p.whatLoses;
        });
        if (picks.rejections && picks.rejections.length > 0) {
          s += "\n\nRejected: " + picks.rejections.slice(0, 5).map(function(r) { return r.matchup + " (" + r.reason + ")"; }).join("; ");
        }
        return s;
      })(),

      // 2. User's P2P record
      (async () => {
        const store = getStore("p2p-users");
        const user = await store.get("user-" + phoneKey, { type: "json" });
        if (!user) return null;
        const total = user.wins + user.losses + user.pushes;
        if (total === 0) return "New user — no bets yet";
        const wr = user.wins + user.losses > 0 ? Math.round(user.wins / (user.wins + user.losses) * 100) : 0;
        var streak = "—";
        if (user.currentStreak > 0) streak = "W" + user.currentStreak;
        else if (user.currentStreak < 0) streak = "L" + Math.abs(user.currentStreak);
        return "@" + (user.handle || "user") + ": " + user.wins + "-" + user.losses + " (" + wr + "%) | P/L: $" + (user.allTimePL / 100).toFixed(0) + " | Streak: " + streak;
      })(),

      // 3. Active bets
      (async () => {
        const store = getStore("p2p-bets");
        const recent = await store.get("recent-index", { type: "json" });
        if (!recent) return null;
        const myBets = [];
        for (const r of recent.slice(0, 20)) {
          if (r.status !== "pending" && r.status !== "active") continue;
          const bet = await store.get("bet-" + r.id, { type: "json" });
          if (!bet) continue;
          var myPhone = phoneKey;
          if ((bet.initiatorPhone || "").replace(/\D/g, "") === myPhone || (bet.counterpartyPhone || "").replace(/\D/g, "") === myPhone) {
            myBets.push(bet.webetString + " [" + bet.status + "]");
          }
          if (myBets.length >= 3) break;
        }
        return myBets.length > 0 ? myBets.join("\n") : null;
      })(),

      // 4. Tonight's games from ESPN
      (async () => {
        const { fetchTonightGames } = require("./create-p2p-bet");
        const games = await fetchTonightGames();
        if (!games.length) return "No games tonight";
        return games.slice(0, 8).map(function(g) {
          var time = new Date(g.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
          return g.sport + ": " + g.awayTeam + " @ " + g.homeTeam + " " + time;
        }).join("\n");
      })(),

      // 5. Track record (cumulative + recent days)
      (async () => {
        const res = await fetch(siteUrl + "/.netlify/functions/get-results");
        if (!res.ok) return null;
        const data = await res.json();
        const c = data.cumulative;
        if (!c) return null;
        let s = c.wins + "W-" + c.losses + "L | " + c.accuracy + " accuracy | " + c.roi + " ROI | " + (c.totalProfit > 0 ? "+" : "") + c.totalProfit + "u profit";
        if (data.days && data.days.length > 0) {
          s += "\nRecent: " + data.days.slice(0, 3).map(function(d) { return d.dateFormatted + ": " + d.wins + "W-" + d.losses + "L (" + d.accuracy + ")"; }).join(" | ");
        }
        return s;
      })(),

      // 6. Team ratings (top teams per league)
      (async () => {
        const res = await fetch(siteUrl + "/.netlify/functions/get-ratings");
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.leagues) return null;
        return Object.entries(data.leagues).map(function(entry) {
          const league = entry[0], info = entry[1];
          const top = (info.top5 || []).slice(0, 3).map(function(t) { return t.name + " (" + t.elo + ")"; }).join(", ");
          return league + " top 3: " + top;
        }).join("\n");
      })(),

      // 7. Guardian digest
      (async () => {
        const res = await fetch(siteUrl + "/.netlify/functions/get-guardian");
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.digest) return null;
        let s = "Date: " + data.date;
        if (data.stats) s += " | Verified: " + data.stats.verified + " | Developing: " + data.stats.developing + " | Avg Score: " + data.stats.avgAuthenticityScore;
        const items = Array.isArray(data.digest) ? data.digest.slice(0, 5) : [];
        if (items.length > 0) {
          s += "\n" + items.map(function(item) { return "- " + (item.title || item.claim || JSON.stringify(item).slice(0, 80)); }).join("\n");
        }
        return s;
      })(),

      // 8. Live markets (upcoming games with odds)
      (async () => {
        const res = await fetch(siteUrl + "/.netlify/functions/get-bettoredge");
        if (!res.ok) return null;
        const data = await res.json();
        const events = (data.events || []).filter(function(e) {
          return new Date(e.scheduledDatetime) > new Date();
        }).slice(0, 10);
        if (events.length === 0) return null;
        return events.map(function(e) {
          var time = new Date(e.scheduledDatetime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
          return (e.leagueName || "").toUpperCase() + ": " + (e.away ? e.away.name : "?") + " @ " + (e.home ? e.home.name : "?") + " " + time;
        }).join("\n");
      })(),

      // 9. P2P leaderboard
      (async () => {
        const res = await fetch(siteUrl + "/.netlify/functions/get-p2p-leaderboard");
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.leaderboard || !data.leaderboard.length) return null;
        return data.leaderboard.slice(0, 5).map(function(u, i) {
          return "#" + (i + 1) + " " + (u.handle || u.name) + ": " + u.wins + "W-" + u.losses + "L | " + (u.profit > 0 ? "+" : "") + "$" + u.profit;
        }).join("\n");
      })(),
    ]);

    const labels = [
      "TODAY'S WEBETAI PICKS", "USER RECORD", "ACTIVE BETS", "TONIGHT'S GAMES",
      "TRACK RECORD", "TEAM RATINGS", "GUARDIAN DIGEST", "LIVE MARKETS", "P2P LEADERBOARD"
    ];
    results.forEach(function(r, i) {
      const val = r.status === "fulfilled" ? r.value : null;
      if (val) parts.push(labels[i] + ":\n" + val);
    });
  } catch (e) {
    console.warn("[betty-webhook] Context build error:", e.message);
  }

  if (parts.length === 0) return "";
  return "[LIVE DATA — " + new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + "]\n\n" + parts.join("\n\n");
}

exports.handler = async (event) => {
  // Twilio sends POST with form-encoded data
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // Parse webhook payload — handle both standard SMS (form-encoded) and Conversations API (JSON)
    const params = new URLSearchParams(event.body || '');
    let fromNumber = params.get('From') || '';
    let userMessage = params.get('Body') || '';
    const toNumber = params.get('To') || '';

    // Check for Conversations API webhook (onMessageAdded)
    const eventType = params.get('EventType') || '';
    const convoSid = params.get('ConversationSid') || '';
    const convoAuthor = params.get('Author') || '';
    const convoBody = params.get('Body') || '';

    if (eventType === 'onMessageAdded' && convoSid) {
      // This is a group chat message — someone texted in the group thread
      // Skip messages from Betty herself
      if (convoAuthor === 'betty') {
        return { statusCode: 200, body: '' };
      }

      // The author is the phone number of the SMS participant
      fromNumber = convoAuthor;
      userMessage = convoBody;

      if (!userMessage) return { statusCode: 200, body: '' };

      console.log(`[betty-webhook] Group chat message from ${fromNumber} in ${convoSid}: ${userMessage.substring(0, 50)}`);

      // Check if this is a bet reply (ACCEPT/COUNTER/PASS/PAID)
      const upperMsg = userMessage.trim().toUpperCase();
      if (/^(ACCEPT|COUNTER|PASS|DECLINE|PAID|SENT|SETTLED|YES|NO|NAH|LOCK|BET)\b/i.test(upperMsg)) {
        const { handleP2PReply, findPendingBet } = require("./handle-p2p-reply");
        const pendingBetId = await findPendingBet(fromNumber);
        if (pendingBetId) {
          const result = await handleP2PReply(fromNumber, userMessage.trim(), pendingBetId);
          if (result.handled) {
            // Reply in the group chat
            const { sendGroupMessage } = require("./create-p2p-bet");
            await sendGroupMessage(convoSid, result.reply, "betty");
            return { statusCode: 200, body: '' };
          }
        }
      }

      // Route group chat through betty-chat-beta (same brain as web + SMS)
      const groupSiteUrl = process.env.URL || "https://webetsocial.com";
      try {
        const betaRes = await fetch(groupSiteUrl + "/.netlify/functions/betty-chat-beta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: userMessage }],
            sources: ["picks", "results", "ratings", "guardian", "markets", "p2p", "espn", "polymarket", "kalshi"],
          }),
        });
        if (betaRes.ok) {
          const betaData = await betaRes.json();
          let reply = (betaData.content || "Let me think on that one...")
            .replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/^#+\s+/gm, "");
          if (reply.length > 320) { const c = reply.lastIndexOf('.', 317); reply = c > 160 ? reply.slice(0, c + 1) : reply.slice(0, 317) + "..."; }
          const { sendGroupMessage } = require("./create-p2p-bet");
          await sendGroupMessage(convoSid, reply, "betty");
        }
      } catch (e) { console.error("[betty-webhook] Group chat beta call failed:", e.message); }
      return { statusCode: 200, body: '' };
    }

    if (!fromNumber || !userMessage) {
      return twimlResponse('Sorry, something went wrong. Text me again!');
    }

    // ── P2P BET ROUTING (before Grok) ──
    const upperMsg = userMessage.trim().toUpperCase();

    // 1. Check for bet creation intent: "bet @handle ..."
    if (/^bet\s+@\w+/i.test(userMessage.trim())) {
      try {
        const { createP2PBet, parseBetText, sendSMS, upsertUser } = require("./create-p2p-bet");
        const parsed = parseBetText(userMessage.trim());

        if (!parsed.handle) {
          return twimlResponse("Who are you betting? Text: bet @theirname $amount team wins");
        }

        // Look up counterparty phone by handle
        let counterpartyPhone = null;
        try {
          const { getStore } = await import("@netlify/blobs");
          const userStore = getStore("p2p-users");
          const cpKey = await userStore.get(`handle-${parsed.handle.toLowerCase()}`);
          if (cpKey) {
            const cpUser = await userStore.get(`user-${cpKey}`, { type: "json" });
            if (cpUser) counterpartyPhone = cpUser.phone;
          }
        } catch (_) {}

        // Build initiator handle from their phone (check if we know them)
        let initiatorHandle = null;
        try {
          const { getStore } = await import("@netlify/blobs");
          const userStore = getStore("p2p-users");
          const iKey = fromNumber.replace(/\D/g, "");
          const iUser = await userStore.get(`user-${iKey}`, { type: "json" });
          if (iUser?.handle) initiatorHandle = iUser.handle;
        } catch (_) {}

        const result = await createP2PBet({
          initiatorPhone: fromNumber,
          initiatorHandle: initiatorHandle || fromNumber.slice(-4),
          counterpartyHandle: parsed.handle,
          counterpartyPhone,
          betText: userMessage.trim(),
          amount: parsed.amount || 20,
          team: parsed.team,
          betType: parsed.betType,
          proposition: parsed.proposition,
        });

        if (!result.success) {
          return twimlResponse(result.error || "Couldn't create that bet. Try again with a team playing tonight.");
        }

        // Send challenge SMS if we have the counterparty phone
        if (result.bet.counterpartyPhone) {
          const challengeMsg = `🤝 @${result.bet.initiatorHandle} challenged you!\n\n${result.bet.webetString}\n\nYou'd take: ${result.bet.counterpartySide}\n\nReply ACCEPT, COUNTER $amt, or PASS\n\nwebetsocial.com/handshake/${result.bet.id}`;
          await sendSMS(result.bet.counterpartyPhone, challengeMsg);
        }

        let reply = `Found it: ${result.bet.matchup} (${result.bet.sport})\n\n${result.bet.webetString}\n\n`;
        if (result.bet.counterpartyPhone) {
          reply += `Sent to @${parsed.handle}!`;
        } else {
          reply += `I don't have @${parsed.handle}'s number yet. Have them text me first, or reply with their phone number.`;
        }
        return twimlResponse(reply);
      } catch (betErr) {
        console.error("[betty-webhook] P2P bet creation error:", betErr);
        return twimlResponse("Something went wrong creating that bet. Try again!");
      }
    }

    // 2. Check for pending bet reply: ACCEPT, COUNTER, PASS, PAID
    if (/^(ACCEPT|COUNTER|PASS|DECLINE|PAID|SENT|SETTLED|YES|NO|NAH|LOCK|BET)\b/i.test(upperMsg)) {
      try {
        const { handleP2PReply, findPendingBet } = require("./handle-p2p-reply");
        const pendingBetId = await findPendingBet(fromNumber);
        if (pendingBetId) {
          const result = await handleP2PReply(fromNumber, userMessage.trim(), pendingBetId);
          if (result.handled) {
            return twimlResponse(result.reply);
          }
        }
      } catch (replyErr) {
        console.error("[betty-webhook] P2P reply error:", replyErr);
      }
    }

    // 3. Check if someone is sending a phone number for an unknown counterparty
    // (10-digit number pattern, and they have a recent bet with no counterparty phone)
    const phonePattern = userMessage.trim().replace(/\D/g, "");
    if (phonePattern.length === 10 || phonePattern.length === 11) {
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("p2p-bets");
        // Check recent index for bets by this initiator with no counterparty phone
        const recent = await store.get("recent-index", { type: "json" });
        if (recent && recent.length > 0) {
          const myBets = recent.filter(r => r.status === "pending");
          for (const rb of myBets.slice(0, 3)) {
            const bet = await store.get(`bet-${rb.id}`, { type: "json" });
            if (bet && bet.initiatorPhone === fromNumber && !bet.counterpartyPhone) {
              const cpPhone = phonePattern.length === 10 ? `+1${phonePattern}` : `+${phonePattern}`;
              bet.counterpartyPhone = cpPhone;
              const pendingKey = `pending-${cpPhone.replace(/\D/g, "")}`;
              await store.set(pendingKey, rb.id);
              bet.events.push({ type: "counterparty_phone_set", phone: cpPhone, ts: new Date().toISOString() });
              await store.setJSON(`bet-${rb.id}`, bet);

              // Send the challenge
              const { sendSMS } = require("./create-p2p-bet");
              const challengeMsg = `🤝 @${bet.initiatorHandle} challenged you!\n\n${bet.webetString}\n\nYou'd take: ${bet.counterpartySide}\n\nReply ACCEPT, COUNTER $amt, or PASS\n\nwebetsocial.com/handshake/${bet.id}`;
              await sendSMS(cpPhone, challengeMsg);

              return twimlResponse(`Got it! Sent the challenge to ${cpPhone}.\n\n${bet.webetString}`);
            }
          }
        }
      } catch (_) {}
    }

    // ── END P2P ROUTING — fall through to normal Betty conversation ──

    // Handle opt-out
    if (['STOP', 'QUIT', 'CANCEL', 'UNSUBSCRIBE'].includes(userMessage.trim().toUpperCase())) {
      try {
        const store = getStore('betty-conversations');
        await store.delete(fromNumber.replace('+', '')).catch(() => {});
      } catch (_) {}
      return twimlResponse('');
    }

    // Load conversation history via Netlify REST API
    let convo = { phone: fromNumber, started: new Date().toISOString(), messages: [] };
    const convoKey = fromNumber.replace('+', '');
    const _siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const _blobToken = process.env.NETLIFY_AUTH_TOKEN;
    const _convoUrl = "https://api.netlify.com/api/v1/blobs/" + _siteId + "/betty-conversations/" + convoKey;
    const _blobHeaders = { "Authorization": "Bearer " + _blobToken };
    try {
      const cResp = await fetch(_convoUrl, { headers: _blobHeaders });
      if (cResp.ok) {
        const saved = await cResp.json();
        if (saved) convo = saved;
      }
    } catch (e) {
      console.warn('Convo read failed:', e.message);
    }

    // Send vCard on first contact only (use Netlify REST API for flag)
    try {
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
      const blobToken = process.env.NETLIFY_AUTH_TOKEN;
      const vcFlagUrl = "https://api.netlify.com/api/v1/blobs/" + siteId + "/betty-vcard-sent/" + convoKey;
      const vcHeaders = { "Authorization": "Bearer " + blobToken };

      let alreadySent = false;
      try {
        const check = await fetch(vcFlagUrl, { headers: vcHeaders });
        if (check.ok) alreadySent = true;
      } catch (_) {}

      if (!alreadySent) {
        const { sendBettyVCard } = require("./create-p2p-bet");
        await sendBettyVCard(fromNumber);
        try {
          await fetch(vcFlagUrl, { method: "PUT", headers: { ...vcHeaders, "Content-Type": "text/plain" }, body: "true" });
        } catch (_) {}
      }
    } catch (_) {}

    // Add user message to history
    convo.messages.push({ role: 'user', content: userMessage, ts: new Date().toISOString() });

    // Keep only last 20 messages for context window
    const recentMessages = convo.messages.slice(-20);

    // ── Call betty-chat-beta (same brain as web chat) ──
    // This ensures SMS and web give identical responses from the same backend.
    const siteUrl = process.env.URL || "https://webetsocial.com";
    let bettyReply;
    try {
      const betaRes = await fetch(siteUrl + "/.netlify/functions/betty-chat-beta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: recentMessages.map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          sources: ["picks", "results", "ratings", "guardian", "markets", "p2p", "espn", "polymarket", "kalshi"],
        }),
      });
      if (!betaRes.ok) {
        throw new Error("betty-chat-beta returned " + betaRes.status);
      }
      const betaData = await betaRes.json();
      bettyReply = betaData.content || betaData.synthesis || "Let me think on that one...";

      // Strip markdown for SMS (no bold, no headers)
      bettyReply = bettyReply
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/^#+\s+/gm, "")
        .replace(/^- /gm, "• ");

      // Trim for SMS — default under 400, max 800 for breakdowns
      if (bettyReply.length > 800) {
        const cut = bettyReply.lastIndexOf('.', 797);
        bettyReply = cut > 300 ? bettyReply.slice(0, cut + 1) : bettyReply.slice(0, 797) + "...";
      }
    } catch (betaErr) {
      console.error("[betty-webhook] betty-chat-beta call failed:", betaErr.message);
      // Fallback: direct Claude call with minimal context
      const claudeKey = process.env.ANTHROPIC_API_KEY;
      if (!claudeKey) {
        bettyReply = "Hey! Betty's brain is warming up. Try again in a sec!";
      } else {
        try {
          const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": claudeKey,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "prompt-caching-2024-07-31",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              system: [{ type: "text", text: BETTY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: recentMessages.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
            }),
          });
          if (claudeRes.ok) {
            const claudeData = await claudeRes.json();
            bettyReply = claudeData.content?.[0]?.text || "Text me again in a moment!";
          } else {
            bettyReply = "Hmm, my brain glitched. Try asking me again!";
          }
        } catch (_) {
          bettyReply = "Hmm, my brain glitched. Try asking me again!";
        }
      }
    }

    // Store Betty's reply in conversation history via REST API
    convo.messages.push({ role: 'assistant', content: bettyReply, ts: new Date().toISOString() });
    if (convo.messages.length > 40) convo.messages = convo.messages.slice(-40);
    try {
      await fetch(_convoUrl, {
        method: "PUT",
        headers: { ..._blobHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(convo),
      });
    } catch (_) {}

    return twimlResponse(bettyReply);
  } catch (err) {
    console.error('betty-webhook error:', err);
    return twimlResponse("Oops! Betty hit a snag. Text me again and I'll be right back! 💪");
  }
};

function twimlResponse(message) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: twiml,
  };
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
