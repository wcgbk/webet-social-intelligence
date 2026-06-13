// handle-p2p-reply.js — Processes replies to P2P bet challenges
// Handles: ACCEPT, COUNTER $amt, PASS, PAID
// Sends the SAME message to BOTH users (virtual three-way thread).
// Called from betty-webhook.js when a pending bet reply is detected.

const { sendSMS, notifyBoth, upsertUser } = require("./create-p2p-bet");

async function handleP2PReply(fromPhone, messageText, betId) {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("p2p-bets");

  const bet = await store.get(`bet-${betId}`, { type: "json" });
  if (!bet) return { handled: false, reply: "Couldn't find that bet. It may have expired." };

  const msg = messageText.trim().toUpperCase();
  const isInitiator = fromPhone.replace(/\D/g, "") === (bet.initiatorPhone || "").replace(/\D/g, "");

  // Helper: send shared message to the OTHER user (the replying user gets it via TwiML)
  async function notifyOther(message) {
    const otherPhone = isInitiator ? bet.counterpartyPhone : bet.initiatorPhone;
    if (otherPhone) await sendSMS(otherPhone, message);
  }

  // ── ACCEPT ──
  if (msg === "ACCEPT" || msg === "YES" || msg === "LOCK" || msg === "LOCK IT" || msg === "BET") {
    if (bet.status !== "pending") {
      return { handled: true, reply: "This bet is already " + bet.status + "." };
    }

    if (bet.counterAmount && isInitiator) {
      bet.amount = bet.counterAmount;
      bet.amountDisplay = bet.counterAmount / 100;
      bet.counterAmount = null;
    }

    bet.status = "active";
    bet.acceptedAt = new Date().toISOString();
    if (!bet.counterpartyPhone) bet.counterpartyPhone = fromPhone;
    bet.events.push({ type: "accepted", actor: fromPhone, ts: new Date().toISOString() });

    await store.setJSON(`bet-${betId}`, bet);

    const pendingKey = `pending-${fromPhone.replace(/\D/g, "")}`;
    try { await store.delete(pendingKey); } catch (_) {}

    await upsertUser(fromPhone, bet.counterpartyHandle);

    // Same message to both users
    const lockMsg = `🔒 BET LOCKED\n\n@${bet.initiatorHandle} ($${bet.amountDisplay}) ${bet.initiatorSide}\n@${bet.counterpartyHandle || "opponent"} ($${bet.amountDisplay}) ${bet.counterpartySide}\n\n${bet.matchup}\n\nI'll text you both when it's final.\n\nwebetsocial.com/handshake/${betId}`;
    await notifyOther(lockMsg);

    return { handled: true, reply: lockMsg };
  }

  // ── COUNTER ──
  if (msg.startsWith("COUNTER")) {
    if (bet.status !== "pending") {
      return { handled: true, reply: "This bet is already " + bet.status + ". Can't counter." };
    }

    const counterMatch = messageText.match(/\$?(\d+(?:\.\d{2})?)/);
    if (!counterMatch) {
      return { handled: true, reply: "Reply COUNTER $amount (e.g., COUNTER $50)" };
    }

    const counterAmt = parseFloat(counterMatch[1]);
    bet.counterAmount = Math.round(counterAmt * 100);
    bet.events.push({ type: "countered", actor: fromPhone, amount: counterAmt, ts: new Date().toISOString() });

    const pendingKey = `pending-${bet.initiatorPhone.replace(/\D/g, "")}`;
    await store.set(pendingKey, betId);
    const cpKey = `pending-${fromPhone.replace(/\D/g, "")}`;
    try { await store.delete(cpKey); } catch (_) {}

    await store.setJSON(`bet-${betId}`, bet);

    const actorHandle = isInitiator ? bet.initiatorHandle : bet.counterpartyHandle;
    const otherHandle = isInitiator ? bet.counterpartyHandle : bet.initiatorHandle;

    // Same message to both
    const counterMsg = `@${actorHandle} countered: $${counterAmt} instead of $${bet.amountDisplay}.\n\n${bet.webetString}\n\n@${otherHandle} — reply ACCEPT or PASS`;
    await notifyOther(counterMsg);

    return { handled: true, reply: counterMsg };
  }

  // ── PASS / DECLINE ──
  if (msg === "PASS" || msg === "DECLINE" || msg === "NO" || msg === "NAH") {
    if (bet.status !== "pending") {
      return { handled: true, reply: "This bet is already " + bet.status + "." };
    }

    bet.status = "declined";
    bet.events.push({ type: "declined", actor: fromPhone, ts: new Date().toISOString() });
    await store.setJSON(`bet-${betId}`, bet);

    const pendingKey = `pending-${fromPhone.replace(/\D/g, "")}`;
    try { await store.delete(pendingKey); } catch (_) {}

    const actorHandle = isInitiator ? bet.initiatorHandle : bet.counterpartyHandle;

    // Same message to both
    const passMsg = `@${actorHandle} passed on the bet.\n\n${bet.webetString}`;
    await notifyOther(passMsg);

    return { handled: true, reply: passMsg };
  }

  // ── PAID ──
  if (msg === "PAID" || msg === "SENT" || msg === "SETTLED") {
    if (bet.status !== "resolved") {
      return { handled: true, reply: "This bet hasn't been resolved yet." };
    }

    bet.settlementStatus = "paid";
    bet.events.push({ type: "paid", actor: fromPhone, ts: new Date().toISOString() });
    await store.setJSON(`bet-${betId}`, bet);

    const myHandle = isInitiator ? bet.initiatorHandle : bet.counterpartyHandle;

    // Same message to both
    const paidMsg = `@${myHandle} marked as paid. Good game! 🤝\n\n${bet.webetString}`;
    await notifyOther(paidMsg);

    return { handled: true, reply: paidMsg };
  }

  return { handled: false, reply: null };
}

async function findPendingBet(phone) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("p2p-bets");
    const key = `pending-${phone.replace(/\D/g, "")}`;
    const betId = await store.get(key);
    if (betId) return betId.trim();
  } catch (_) {}
  return null;
}

module.exports = { handleP2PReply, findPendingBet };
