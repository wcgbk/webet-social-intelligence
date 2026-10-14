'use strict';

/**
 * In-process twin of clv.game_aliases / clv.canonical_game_id.
 * aliases maps alias_game_id -> canonical_game_id. A game is never its own alias.
 * attachCloses prefers the game's own close (pref 0) over a family close (pref 1).
 */

function canonicalGameId(gameId, aliases) {
  if (gameId == null) return null;
  const id = String(gameId);
  const mapped = aliases && aliases[id];
  if (mapped && mapped !== id) return String(mapped);
  return id;
}

function familyIds(gameId, aliases) {
  const canon = canonicalGameId(gameId, aliases);
  const ids = new Set();
  if (canon) ids.add(canon);
  const map = aliases || {};
  for (const [alias, target] of Object.entries(map)) {
    if (target === canon) ids.add(alias);
  }
  return [...ids];
}

/**
 * @param {string} gameId
 * @param {Record<string, object[]>} closesByGameId
 * @param {Record<string, string>} aliases
 * @returns {object[]} own closes, or family closes when this game has none
 */
function attachCloses(gameId, closesByGameId, aliases) {
  const byGame = closesByGameId || {};
  const own = byGame[gameId] || byGame[String(gameId)] || [];
  if (own.length) {
    return own.map((row) => ({ ...row, pref: 0, close_game_id: String(gameId) }));
  }
  const out = [];
  for (const id of familyIds(gameId, aliases)) {
    if (id === String(gameId)) continue;
    for (const row of byGame[id] || []) {
      out.push({ ...row, pref: 1, close_game_id: id });
    }
  }
  return out;
}

module.exports = {
  canonicalGameId,
  familyIds,
  attachCloses,
};
