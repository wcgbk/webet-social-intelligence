// resolve-p2p-bet.js — Auto-resolves active P2P bets using ESPN final scores
// Scheduled function or manual trigger via POST /api/resolve-p2p-bet

const { sendSMS, notifyBoth } = require("./create-p2p-bet");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const ESPN_SPORTS = [
  { key: "nba", sport: "basketball", league: "nba" },
  { key: "nhl", sport: "hockey", league: "nhl" },
  { key: "mlb", sport: "baseball", league: "mlb" },
  { key: "ncaam", sport: "basketball", league: "mens-college-basketball" },
  { key: "nfl", sport: "football", league: "nfl" },
  { key: "mls", sport: "soccer", league: "usa.1" },
  { key: "epl", sport: "soccer", league: "eng.1" },
];

function normalizeTeam(name) {
  return (name || "").toLowerCase().replace(/[^a-z]/g, "");
}

// sendSMS and notifyBoth imported from create-p2p-bet.js

exports.handler = async (event) => {
  console.log("[P2P-RESOLVE] Starting resolution check...");

  try {
    const { getStore } = await import("@netlify/blobs");
    const betsStore = getStore("p2p-bets");
    const usersStore = getStore("p2p-users");

    // Get recent bets index
    let recent = [];
    try {
      const r = await betsStore.get("recent-index", { type: "json" });
      if (r) recent = r;
    } catch (_) {}

    // Filter to active bets
    const activeBetIds = recent.filter((r) => r.status === "active" || r.status === "pending").map((r) => r.id);
    console.log(`[P2P-RESOLVE] ${activeBetIds.length} active/pending bets to check`);

    let resolved = 0;
    let expired = 0;

    for (const betId of activeBetIds) {
      const bet = await betsStore.get(`bet-${betId}`, { type: "json" });
      if (!bet) continue;

      // Expire pending bets older than 24h
      if (bet.status === "pending" && bet.expiresAt && new Date(bet.expiresAt) < new Date()) {
        bet.status = "expired";
        bet.events.push({ type: "expired", ts: new Date().toISOString() });
        await betsStore.setJSON(`bet-${betId}`, bet);
        // Clear pending index
        if (bet.counterpartyPhone) {
          try { await betsStore.delete(`pending-${bet.counterpartyPhone.replace(/\D/g, "")}`); } catch (_) {}
        }
        expired++;
        continue;
      }

      if (bet.status !== "active") continue;

      // Find the sport config
      const sportKey = (bet.sport || "").toLowerCase();
      const espnSport = ESPN_SPORTS.find((s) => s.key === sportKey || sportKey.includes(s.key));
      if (!espnSport) continue;

      // Fetch ESPN scoreboard for the game date
      const gameDate = new Date(bet.gameDate);
      const dateStr = `${gameDate.getFullYear()}${String(gameDate.getMonth() + 1).padStart(2, "0")}${String(gameDate.getDate()).padStart(2, "0")}`;

      try {
        const url = `https://site.api.espn.com/apis/site/v2/sports/${espnSport.sport}/${espnSport.league}/scoreboard?dates=${dateStr}`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();

        // Find the matching game
        for (const evt of data.events || []) {
          const competitors = evt.competitions?.[0]?.competitors || [];
          if (competitors.length < 2) continue;

          const home = competitors.find((c) => c.homeAway === "home");
          const away = competitors.find((c) => c.homeAway === "away");
          const homeName = home?.team?.displayName || "";
          const awayName = away?.team?.displayName || "";

          // Match by team names
          const homeN = normalizeTeam(homeName);
          const awayN = normalizeTeam(awayName);
          const betHomeN = normalizeTeam(bet.homeTeam);
          const betAwayN = normalizeTeam(bet.awayTeam);

          if (!((homeN.includes(betHomeN) || betHomeN.includes(homeN)) &&
                (awayN.includes(betAwayN) || betAwayN.includes(awayN)))) continue;

          // Check if game is final
          const status = evt.status?.type?.name;
          if (status !== "STATUS_FINAL") continue;

          const homeScore = parseInt(home?.score || "0");
          const awayScore = parseInt(away?.score || "0");
          const finalScore = `${awayName} ${awayScore}, ${homeName} ${homeScore}`;

          // Determine winner
          let winnerTeam;
          if (homeScore > awayScore) winnerTeam = homeName;
          else if (awayScore > homeScore) winnerTeam = awayName;
          else winnerTeam = null; // tie/push

          let result, winnerPhone, loserPhone;
          if (!winnerTeam) {
            result = "push";
            winnerPhone = null;
            loserPhone = null;
          } else if (normalizeTeam(winnerTeam).includes(normalizeTeam(bet.initiatorSide)) ||
                     normalizeTeam(bet.initiatorSide).includes(normalizeTeam(winnerTeam))) {
            result = "initiator_wins";
            winnerPhone = bet.initiatorPhone;
            loserPhone = bet.counterpartyPhone;
          } else {
            result = "counterparty_wins";
            winnerPhone = bet.counterpartyPhone;
            loserPhone = bet.initiatorPhone;
          }

          // Update bet
          bet.status = "resolved";
          bet.result = result;
          bet.winnerPhone = winnerPhone;
          bet.loserPhone = loserPhone;
          bet.finalScore = finalScore;
          bet.resolvedAt = new Date().toISOString();
          bet.events.push({ type: "resolved", result, finalScore, ts: new Date().toISOString() });

          await betsStore.setJSON(`bet-${betId}`, bet);

          // Update user stats
          const amountCents = bet.amount || 0;
          if (result === "push") {
            await updateUserStat(usersStore, bet.initiatorPhone, "push", 0);
            await updateUserStat(usersStore, bet.counterpartyPhone, "push", 0);
          } else {
            await updateUserStat(usersStore, winnerPhone, "win", amountCents);
            await updateUserStat(usersStore, loserPhone, "loss", amountCents);
          }

          // Send result SMS
          const sportEmoji = { NBA: "🏀", NHL: "🏒", MLB: "⚾", NCAAM: "🏀", NFL: "🏈", MLS: "⚽", EPL: "⚽" }[bet.sport] || "🏆";
          const winnerHandle = result === "initiator_wins" ? bet.initiatorHandle : bet.counterpartyHandle;
          const loserHandle = result === "initiator_wins" ? bet.counterpartyHandle : bet.initiatorHandle;

          if (result === "push") {
            const pushMsg = `${sportEmoji} FINAL: ${finalScore}\n\nPush! Bet is void — no one pays.\n\n${bet.webetString}`;
            await notifyBoth(bet, pushMsg);
          } else {
            // Same message to both users (three-way thread)
            const resultMsg = `${sportEmoji} FINAL: ${finalScore}\n\n@${winnerHandle} wins $${bet.amountDisplay} from @${loserHandle}!\n\n@${loserHandle} — reply PAID when settled.\n\nwebetsocial.com/handshake/${betId}`;
            await notifyBoth(bet, resultMsg);

            // Set pending for PAID reply
            if (loserPhone) {
              await betsStore.set(`pending-${loserPhone.replace(/\D/g, "")}`, betId);
            }
          }

          resolved++;
          break; // Found the game, move to next bet
        }
      } catch (e) {
        console.warn(`[P2P-RESOLVE] ESPN check failed for ${betId}:`, e.message);
      }
    }

    // Update recent index statuses
    for (const r of recent) {
      const bet = await betsStore.get(`bet-${r.id}`, { type: "json" });
      if (bet) r.status = bet.status;
    }
    await betsStore.setJSON("recent-index", recent);

    console.log(`[P2P-RESOLVE] Done. Resolved: ${resolved}, Expired: ${expired}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ resolved, expired, checked: activeBetIds.length }),
    };
  } catch (err) {
    console.error("[P2P-RESOLVE] Error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

async function updateUserStat(store, phone, outcome, amountCents) {
  if (!phone) return;
  const key = `user-${phone.replace(/\D/g, "")}`;
  let user;
  try { user = await store.get(key, { type: "json" }); } catch (_) {}
  if (!user) return;

  if (outcome === "win") {
    user.wins++;
    user.totalWon += amountCents;
    user.allTimePL += amountCents;
    user.totalWagered += amountCents;
    user.currentStreak = user.currentStreak >= 0 ? user.currentStreak + 1 : 1;
    if (user.currentStreak > user.bestStreak) user.bestStreak = user.currentStreak;
  } else if (outcome === "loss") {
    user.losses++;
    user.allTimePL -= amountCents;
    user.totalWagered += amountCents;
    user.currentStreak = user.currentStreak <= 0 ? user.currentStreak - 1 : -1;
  } else {
    user.pushes++;
  }

  await store.setJSON(key, user);
}
