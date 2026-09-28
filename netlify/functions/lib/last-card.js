// Site rule: a sport's card stays up until that sport's next COMPLETED run replaces it.
// Generators only write today's blob when a run completes (picks, or a
// "No Qualifying Plays Today" card). Failed/feed-down runs write nothing.
// So only a MISSING blob falls back to the most recent card with picks.
function isPlaceholder(card) {
  return !card;
}

async function lastRealCard(getJson, today, maxLookback = 14) {
  let dates = [];
  try { dates = (await getJson("picks-dates")) || []; } catch (e) {}
  dates = (Array.isArray(dates) ? dates : []).filter(d => typeof d === "string" && d < today).sort().reverse();
  for (const d of dates.slice(0, maxLookback)) {
    try {
      const card = await getJson(`picks-${d}`);
      if (card && Array.isArray(card.picks) && card.picks.length) return card;
    } catch (e) {}
  }
  return null;
}

function asPreviousCard(card, today, todayStatus) {
  return {
    ...card,
    previousCard: true,
    cardDate: card.date,
    today,
    todayStatus: todayStatus || "no_card_yet",
    status: "previous",
    cardReady: true,
  };
}

module.exports = { isPlaceholder, lastRealCard, asPreviousCard };
