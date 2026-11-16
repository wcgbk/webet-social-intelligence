// Men's college basketball names for grading.
//
// A school matches another school when the names are equal after the mascot is
// removed, "St" is expanded, and a short Odds-API → ESPN alias list is applied.
// Trailing "St" is State for every school (Kansas St, Sam Houston St). A leading
// "St" is Saint (St. John's). "Cal St" is State. Any other internal "St" is
// Saint (Mount St. Mary's).
//
// ESPN sometimes prints a shorter location than the card: "Sam Houston" for
// Sam Houston State, "Nicholls" for Nicholls State, "Central Connecticut" for
// Central Connecticut State. Dropping "State" is not free. Kansas is not Kansas
// State. That shorter location counts only inside one ESPN event, and only when
// the mascots agree, so the other team in the same game can confirm the pair.
// The same pair rule covers an extra word ("American" / "American University",
// "Fort Wayne" / "Purdue Fort Wayne", "Little Rock" / "Arkansas-Little Rock").
//
// A game matches when both teams match by school, or one team matches by school
// and the other matches by mascot because the school strings are the same
// program with a word added or removed. A mascot alone never matches a team.
// Duke does not match Central Connecticut, and Quinnipiac Bobcats do not match
// Texas State Bobcats, even when the opponent is the same.

const { ncaamGradeEnabled } = require('./default_on_flag');

// ESPN drops "State" from this location and the card still says "St".
// Single-team equality stays on for this one school so the 11/15 grade and
// the existing Central Connecticut tests keep working. Every other school
// drops "State" only through the pair rule below.
const STATE_OPTIONAL = new Set([
  'central connecticut',
]);

// Full-string aliases after mascot strip and St expansion. Values are the
// canonical school. Do not alias a pair that has two real programs
// (Kansas / Kansas State, Miami / Miami (OH)).
const SCHOOL_ALIAS = {
  'miami ohio': 'miami oh',
  'miami of ohio': 'miami oh',
  'iupui': 'iu indy',
  'iu indianapolis': 'iu indy',
  'iu indy': 'iu indy',
  'fort wayne': 'purdue fort wayne',
  'gw': 'george washington',
  'g washington': 'george washington',
  'cal baptist': 'california baptist',
  'ca baptist': 'california baptist',
  'app state': 'appalachian state',
  'loyola chi': 'loyola chicago',
  'loyola md': 'loyola maryland',
  'american': 'american university',
  'saint thomas mn': 'saint thomas',
  'n colorado': 'northern colorado',
  'arkansas little rock': 'little rock',
  'ualbany': 'albany',
  'umkc': 'kansas city',
  'florida int l': 'florida international',
  'florida intl': 'florida international',
  'fiu': 'florida international',
};

const RAW_MASCOTS = `
Big Green
Big Red
Black Bears
Black Knights
Blue Bears
Blue Demons
Blue Devils
Blue Hens
Blue Hose
Blue Raiders
Crimson Tide
Delta Devils
Demon Deacons
Fighting Camels
Fighting Hawks
Fighting Illini
Fighting Irish
Fighting Squirrels
Flying Fleet
Golden Bears
Golden Eagles
Golden Flashes
Golden Gophers
Golden Griffins
Golden Grizzlies
Golden Hurricane
Golden Knights
Golden Lions
Golden Panthers
Great Danes
Green Wave
Horned Frogs
Mean Green
Mountain Hawks
Nittany Lions
Purple Aces
Purple Eagles
Ragin Cajuns
Ragin' Cajuns
Rainbow Warriors
Red Flash
Red Foxes
Red Hawks
Red Raiders
Red Storm
Red Wolves
River Hawks
Runnin Rebels
Runnin' Bulldogs
Running Rebels
Scarlet Knights
Screaming Eagles
Sun Devils
Tar Heels
Thundering Herd
Trail Blazers
Wolf Pack
Yellow Jackets
49ers
Aggies
Ambassadors
Anteaters
Argonauts
Aztecs
Badgers
Beach
Beacons
Bearcats
Bearkats
Bears
Beavers
Bengals
Billikens
Bison
Bisons
Blazers
Bluejays
Bobcats
Boilermakers
Bonnies
Braves
Broncos
Broncs
Bruins
Buccaneers
Buckeyes
Buffaloes
Builders
Bulldogs
Bulls
Cardinal
Cardinals
Catamounts
Cavaliers
Chanticleers
Chargers
Chippewas
Colonels
Colonials
Comets
Commodores
Cornhuskers
Cougars
Cowboys
Coyotes
Crimson
Crusaders
Cyclones
Demons
Devils
Dolphins
Dons
Dragons
Ducks
Dukes
Eagles
Explorers
Falcons
Flames
Flyers
Friars
Gaels
Gamecocks
Gators
Gauchos
Governors
Greyhounds
Griffins
Grizzlies
Hatters
Hawkeyes
Hawks
Highlanders
Hilltoppers
Hokies
Hoosiers
Hornets
Hoyas
Hurricanes
Huskies
Islanders
Jackrabbits
Jaguars
Jaspers
Jayhawks
Jets
Kangaroos
Keydets
Knights
Lakers
Lancers
Leathernecks
Leopards
Lions
Lobos
Longhorns
Lopes
Lumberjacks
Majors
Mariner
Mastodons
Matadors
Mavericks
Midshipmen
Miners
Minutemen
Mocs
Monarchs
Mountaineers
Musketeers
Mustangs
Norse
Oaklanders
Okies
Orange
Ospreys
Owls
Paladins
Panthers
Patriots
Peacocks
Penguins
Phoenix
Pilots
Pioneers
Pirates
Pride
Privateers
Quakers
Racers
Raiders
Ramblers
Rams
Rattlers
Razorbacks
Rebels
Redbirds
RedHawks
Redhawks
Retrievers
Revolutionaries
Roadrunners
Rockets
Roos
Royals
Saints
Salukis
Scots
Seahawks
Seawolves
Seminoles
Sharks
Shockers
Skyhawks
Sooners
Spartans
Spiders
Stags
Stallions
Sycamores
Talons
Terps
Terrapins
Terriers
Texans
Thorobreds
Thunderbirds
Tigers
Titans
Tommies
Toreros
Trailblazers
Tribe
Tritons
Trojans
Utes
V-Hawks
Vandals
Vaqueros
Vikings
Volunteers
Warhawks
Warriors
Waves
Wildcats
Wolfpack
Wolverines
Wolves
Zips
`;

function foldTeam(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FOLDED_MASCOTS = [...new Set(
  RAW_MASCOTS.split('\n').map((s) => foldTeam(s)).filter(Boolean),
)];
const MULTI_MASCOTS = FOLDED_MASCOTS.filter((m) => m.includes(' ')).sort((a, b) => b.length - a.length);
const SINGLE_MASCOTS = new Set(FOLDED_MASCOTS.filter((m) => !m.includes(' ')));

function peelMascot(folded) {
  let name = folded;
  for (let i = 0; i < MULTI_MASCOTS.length; i++) {
    const mascot = MULTI_MASCOTS[i];
    const tail = ' ' + mascot;
    if (name.endsWith(tail) && name.length > tail.length) {
      return { school: name.slice(0, -tail.length).trim(), mascot };
    }
  }
  const parts = name.split(' ').filter(Boolean);
  if (parts.length > 1 && SINGLE_MASCOTS.has(parts[parts.length - 1])) {
    const mascot = parts.pop();
    return { school: parts.join(' '), mascot };
  }
  return { school: name, mascot: '' };
}

// Trailing "St" is State. A leading "St" is Saint. "Cal St ..." is State.
// Other internal "St" is Saint. Mascot words are already peeled, so "Sam
// Houston St Bearkats" is "sam houston st" here and the trailing token is State.
function expandSt(school) {
  const parts = String(school || '').split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (tok !== 'st') {
      out.push(tok);
      continue;
    }
    if (i === parts.length - 1 || parts[i - 1] === 'cal') out.push('state');
    else out.push('saint');
  }
  return out.join(' ');
}

function applyAlias(school) {
  let s = school;
  if (s.startsWith('csu ')) s = 'cal state ' + s.slice(4);
  if (s === 'se missouri' || s.startsWith('se missouri ')) {
    s = 'southeast missouri' + s.slice('se missouri'.length);
  }
  if (SCHOOL_ALIAS[s]) s = SCHOOL_ALIAS[s];
  if (s.endsWith(' state')) {
    const base = s.slice(0, -' state'.length);
    if (STATE_OPTIONAL.has(base)) s = base;
  }
  if (SCHOOL_ALIAS[s]) s = SCHOOL_ALIAS[s];
  return s;
}

function canonicalSchool(name) {
  const folded = foldTeam(name);
  if (!folded) return '';
  return applyAlias(expandSt(peelMascot(folded).school));
}

function mascotOf(name) {
  const folded = foldTeam(name);
  if (!folded) return '';
  return peelMascot(folded).mascot;
}

function mascotsAgree(a, b) {
  const ma = mascotOf(a);
  const mb = mascotOf(b);
  if (!ma || !mb) return false;
  if (ma === mb) return true;
  // "Knights" and "Black Knights" are the same nickname when the schools
  // already line up. Equal-length different nicknames stay different.
  const ta = ma.split(' ');
  const tb = mb.split(' ');
  if (ta.length === tb.length) return false;
  const subset = (small, big) => small.every((t) => big.includes(t));
  return subset(ta, tb) || subset(tb, ta);
}

function abbrHit(pickTeam, espnAbbr) {
  const abbr = String(espnAbbr || '').toLowerCase();
  if (abbr.length < 2) return false;
  const school = canonicalSchool(pickTeam);
  if (school && school === abbr) return true;
  const folded = foldTeam(pickTeam);
  if (!folded) return false;
  if (folded === abbr) return true;
  if (abbr.length < 3) return false;
  return folded.split(' ').includes(abbr);
}

// ESPN omitted a word, or the card added one. "State" counts only when the
// card has it and ESPN does not. The reverse would make Kansas match Kansas
// State. Mascots have to agree, so Michigan State does not match Michigan.
function qualifiedSchool(pickName, espnName) {
  const a = canonicalSchool(pickName);
  const b = canonicalSchool(espnName);
  if (!a || !b || a === b) return false;
  if (!mascotsAgree(pickName, espnName)) return false;
  if (a.endsWith(' state') && a.slice(0, -' state'.length) === b) return true;
  if (b.endsWith(' state') && b.slice(0, -' state'.length) === a) return false;
  if (a.startsWith(b + ' ') || b.startsWith(a + ' ')) return true;
  if (a.endsWith(' ' + b) || b.endsWith(' ' + a)) return true;
  return false;
}

function schoolHit(pickName, espnName, espnAbbr) {
  const left = canonicalSchool(pickName);
  const right = canonicalSchool(espnName);
  if (left && right && left === right) return true;
  if (abbrHit(pickName, espnAbbr)) return true;
  return false;
}

function ncaamTeamsMatch(pickTeam, espnTeam, espnAbbr) {
  return schoolHit(pickTeam, espnTeam, espnAbbr);
}

// school: strict name or abbreviation.
// qualified: same program, ESPN added or dropped a word, mascots agree.
// An unrelated shared mascot is not a match. Duke Blue Devils are not Central
// Connecticut, and Quinnipiac Bobcats are not Texas State, even when the other
// team in the event is the same school. The mascot only confirms that a
// shorter or longer location is still that program.
function sideKind(pickName, espnName, espnAbbr) {
  if (schoolHit(pickName, espnName, espnAbbr)) return 'school';
  if (qualifiedSchool(pickName, espnName)) return 'qualified';
  return '';
}

function pairRank(kAway, kHome) {
  if (!kAway || !kHome) return 0;
  const w = { school: 4, qualified: 3 };
  if (!w[kAway] || !w[kHome]) return 0;
  return w[kAway] + w[kHome];
}

function splitMatchup(matchup) {
  const parts = String(matchup || '')
    .split(/\s+(?:@|vs\.?|at|v)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 2) return parts;
  return [parts[0], parts[parts.length - 1]];
}

function bestOrientation(parts, game) {
  if (!parts || parts.length < 2 || !game) return null;
  const options = [
    { awayPart: parts[0], homePart: parts[1] },
    { awayPart: parts[1], homePart: parts[0] },
  ];
  let best = null;
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const kAway = sideKind(o.awayPart, game.awayTeam, game.awayAbbr);
    const kHome = sideKind(o.homePart, game.homeTeam, game.homeAbbr);
    const rank = pairRank(kAway, kHome);
    if (!rank) continue;
    if (!best || rank > best.rank) {
      best = {
        rank,
        awayPart: o.awayPart,
        homePart: o.homePart,
        kAway,
        kHome,
      };
    }
  }
  return best;
}

function ncaamEventRank(matchup, game) {
  const found = bestOrientation(splitMatchup(matchup), game);
  return found ? found.rank : 0;
}

function ncaamMatchingGames(matchup, games) {
  const ranked = [];
  for (const g of games || []) {
    const rank = ncaamEventRank(matchup, g);
    if (rank > 0) ranked.push({ g, rank });
  }
  if (!ranked.length) return [];
  let best = 0;
  for (let i = 0; i < ranked.length; i++) if (ranked[i].rank > best) best = ranked[i].rank;
  return ranked.filter((r) => r.rank === best).map((r) => r.g);
}

function partAligns(pickTeam, part) {
  if (!pickTeam || !part) return false;
  if (foldTeam(pickTeam) === foldTeam(part)) return true;
  if (schoolHit(pickTeam, part, '')) return true;
  if (qualifiedSchool(pickTeam, part)) return true;
  return false;
}

// Which side of an already chosen game the pick text is. Strict school wins.
// A mascot or a shortened ESPN location counts only when this game's matchup
// pair already matched, and only for the matchup part that lines up with the pick.
function ncaamPickedSide(pickTeam, matchup, game) {
  if (!pickTeam || !game) return '';
  const awaySchool = schoolHit(pickTeam, game.awayTeam, game.awayAbbr);
  const homeSchool = schoolHit(pickTeam, game.homeTeam, game.homeAbbr);
  if (awaySchool && !homeSchool) return 'away';
  if (homeSchool && !awaySchool) return 'home';
  const found = bestOrientation(splitMatchup(matchup), game);
  if (!found) return '';
  if (partAligns(pickTeam, found.awayPart) && !partAligns(pickTeam, found.homePart)) return 'away';
  if (partAligns(pickTeam, found.homePart) && !partAligns(pickTeam, found.awayPart)) return 'home';
  return '';
}

function collegeHoopsMatchEnabled(sport, env) {
  const s = String(sport || '').toUpperCase();
  if (s !== 'NCAAM' && s !== 'NCAAB') return false;
  return ncaamGradeEnabled(env);
}

module.exports = {
  STATE_OPTIONAL,
  canonicalSchool,
  ncaamTeamsMatch,
  ncaamEventRank,
  ncaamMatchingGames,
  ncaamPickedSide,
  collegeHoopsMatchEnabled,
};
