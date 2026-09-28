'use strict';
// Tolerant player-name match for starter-change checks. Feeds disagree on
// accents, suffixes, and middle initials ("José Berríos" vs "Jose Berrios",
// "Luis L. Ortiz" vs "Luis Ortiz", "Bobby Witt Jr." vs "Bobby Witt"). A format
// difference must never read as a scratch and void a pick.
function nameTokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ')
    .split(/\s+/).filter(Boolean)
    .filter((t) => !/^(jr|sr|ii|iii|iv|v)$/.test(t))
    .filter((t, i, arr) => !(t.length === 1 && i > 0 && i < arr.length - 1)); // middle initials
}

function samePlayerName(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return true; // unknown on either side is not a change
  if (ta.join(' ') === tb.join(' ')) return true;
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  if (lastA !== lastB) return false;
  return ta[0][0] === tb[0][0]; // same surname + same first initial
}

module.exports = { samePlayerName, nameTokens };
