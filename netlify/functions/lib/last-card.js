// Site rule: a sport's card stays up until that sport's next card replaces it.
// When today has no card (missing, or a "no games" placeholder), serve the most
// recent card that has picks, flagged so pages can label it.
function isPlaceholder(card) {
  if (!card) return true;
  const picks = Array.isArray(card.picks) ? card.picks : [];
  if (picks.length) return false;
  return card.noGames === true || /Games Scheduled/i.test(card.noPlays || "");
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
