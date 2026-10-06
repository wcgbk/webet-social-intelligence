# Omega NFL / NCAAF team identity

NFL and NCAAF resolve a team by ESPN id. The committed tables are `netlify/functions/lib/omega-vnext/sports/data/nfl-team-ids.json` and `ncaaf-team-ids.json`. Matching lowercases, strips accents, deletes okina and apostrophes, and collapses other punctuation, then does an exact lookup. There is no substring, last-word, or mascot fallback. "Georgia State" is not Georgia. "Miami (OH)" is not Miami.

A name with no ESPN id is unknown. Every candidate in that game is rejected with `unknown_team` and the name is logged. A resolved id with no EPA seed row still uses the standings fallback. MLB and NHL still use `fuzzyTeam` and are not on this table.

Regenerate the tables with `node scripts/build-football-team-ids.js` (`ODDS_API_KEY` set; one Odds API credit per sport for `/participants`). Hand aliases live in `scripts/data/football-team-aliases.json`. Runtime does not fetch.

## Unmatched names

Generate writes a private blob `omega-unmatched-{YYYY-MM-DD}` unless `dryRun` is set. The same list is on the stored card as `teamIdentity`. `publicPicksPayload` strips that field, so `/daily-omega` does not show it.

Read it:

- `GET /.netlify/functions/get-omega-unmatched?date=YYYY-MM-DD` (ops only; returns the blob, not the card)
- or `readUnmatchedTeams(dateISO)` from `netlify/functions/lib/omega-vnext/store.js`

The blob is `{ date, generatedAt, bySport: { NFL, NCAAF }, count }`. Names are sorted. An empty list means every odds name on that slate resolved.
