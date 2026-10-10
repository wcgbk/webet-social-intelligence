'use strict';

/**
 * Write js/omega-team-identity.js from the server tables and the exact
 * normalize / sameTeam / resolveEspnSide / matchSides source.
 *
 *   node scripts/build-team-identity-client.js
 *
 * Netlify publishes the working tree with no build step, so the file is
 * committed. test-omega-team-identity-client.js fails if it drifts.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTeamName } = require('../netlify/functions/lib/omega-vnext/sports/team_normalize');
const id = require('../netlify/functions/lib/omega-vnext/sports/team_identity');
const { IDENTITY_V2_FROM } = require('../netlify/functions/lib/omega-grading-rules');
const explicitAliases = require('../netlify/functions/lib/omega-vnext/sports/data/football-explicit-aliases.json');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'netlify/functions/lib/omega-vnext/sports/data');
const OUT = path.join(ROOT, 'js/omega-team-identity.js');

const SPORTS = ['NFL', 'NCAAF', 'NBA', 'MLB', 'NHL'];

function lookupFor(file, sport) {
  const table = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  const lookup = Object.assign({}, table.lookup || {});
  const raw = (explicitAliases && explicitAliases[sport]) || {};
  const extra = Object.keys(raw).sort();
  for (const name of extra) {
    const idValue = raw[name];
    const norm = normalizeTeamName(name);
    if (!norm || idValue == null || idValue === '') continue;
    if (lookup[norm]) continue;
    lookup[norm] = String(idValue);
  }
  return lookup;
}

function renderClientSource() {
  const lookup = {
    NFL: lookupFor('nfl-team-ids.json', 'NFL'),
    NCAAF: lookupFor('ncaaf-team-ids.json', 'NCAAF'),
    NBA: lookupFor('nba-team-ids.json', 'NBA'),
    MLB: lookupFor('mlb-team-ids.json', 'MLB'),
    NHL: lookupFor('nhl-team-ids.json', 'NHL'),
  };
  const normSrc = normalizeTeamName.toString();
  const sameSrc = id.sameTeam.toString();
  const sideSrc = id.resolveEspnSide.toString();
  const matchSrc = id.matchSides.toString();
  const body = `(function (root, factory) {
  var api = factory();
  if (root) root.OmegaTeamIdentity = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var IDENTITY_V2_FROM = ${JSON.stringify(IDENTITY_V2_FROM)};
  var LOOKUP = ${JSON.stringify(lookup)};
  ${normSrc}
  function tableFor(sport) {
    if (sport === 'CFB') return LOOKUP.NCAAF;
    return LOOKUP[sport] || null;
  }
  function resolveTeamId(sport, name) {
    var table = tableFor(sport);
    if (!table) return null;
    var key = normalizeTeamName(name);
    if (!key) return null;
    var id = table[key];
    return id ? String(id) : null;
  }
  ${sameSrc}
  ${sideSrc}
  ${matchSrc}
  return {
    IDENTITY_V2_FROM: IDENTITY_V2_FROM,
    resolveTeamId: resolveTeamId,
    sameTeam: sameTeam,
    resolveEspnSide: resolveEspnSide,
    matchSides: matchSides,
    normalizeTeamName: normalizeTeamName,
  };
});
`;
  return body;
}

function main() {
  const text = renderClientSource();
  if (process.argv.indexOf('--check') >= 0) {
    const disk = fs.readFileSync(OUT, 'utf8');
    if (disk !== text) {
      console.error('DRIFT js/omega-team-identity.js');
      process.exit(1);
    }
    console.log('ok ' + OUT);
    return;
  }
  fs.writeFileSync(OUT, text);
  console.log('wrote ' + OUT + ' (' + text.length + ' bytes)');
}

module.exports = { renderClientSource, OUT, SPORTS };

if (require.main === module) main();
