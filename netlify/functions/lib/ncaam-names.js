// Men's college basketball names for grading.
// ESPN's location for Central Connecticut is "Central Connecticut". The card
// says "Central Connecticut St". Those are the same school. "State" is not
// optional in general: Kansas and Kansas State are different schools, and
// Miami is not Miami (OH).
//
// Match is equality after mascot strip and a short alias list. A shorter
// school is not a prefix of a longer one.

const { ncaamGradeEnabled } = require('./default_on_flag');

// ESPN drops "State" from these locations. Do not add a school that has a
// different "X" and "X State" program.
const STATE_OPTIONAL = new Set([
  'central connecticut',
]);

const SCHOOL_ALIAS = {
  'miami ohio': 'miami oh',
  'miami of ohio': 'miami oh',
};

// Longer phrases first. A single-word mascot is stripped only after these.
const MULTI_MASCOTS = [
  'screaming eagles',
  'rainbow warriors',
  'running rebels',
  'runnin rebels',
  'thundering herd',
  'golden hurricane',
  'golden griffins',
  'golden panthers',
  'golden gophers',
  'golden flashes',
  'golden eagles',
  'golden knights',
  'golden bears',
  'golden lions',
  'fighting illini',
  'fighting irish',
  'fighting hawks',
  'demon deacons',
  'yellow jackets',
  'scarlet knights',
  'crimson tide',
  'nittany lions',
  'mountain hawks',
  'horned frogs',
  'purple eagles',
  'delta devils',
  'trail blazers',
  'ragin cajuns',
  'black knights',
  'blue devils',
  'sun devils',
  'blue demons',
  'blue raiders',
  'great danes',
  'river hawks',
  'red raiders',
  'mean green',
  'green wave',
  'wolf pack',
  'tar heels',
  'red storm',
  'red flash',
  'red hawks',
  'red foxes',
  'blue hens',
  'big green',
].sort((a, b) => b.length - a.length);

const SINGLE_MASCOTS = new Set((
  'aggies aztecs badgers bearcats bears bengals billikens bison bluejays bobcats ' +
  'boilermakers broncos bruins buckeyes bulldogs bulls cardinals catamounts ' +
  'cavaliers chanticleers chargers colonials commodores cornhuskers cougars ' +
  'cowboys coyotes crimson crusaders cyclones demons devils dolphins dons ducks ' +
  'dukes eagles explorers falcons flames friars gaels gauchos gators governors ' +
  'grizzlies hawkeyes hawks hilltoppers hokies hoosiers hornets hoyas hurricanes ' +
  'huskies jaguars jayhawks lakers lions lobos longhorns mastodons miners ' +
  'minutemen mountaineers musketeers mustangs orange ospreys owls paladins ' +
  'panthers phoenix pirates raiders rams razorbacks rebels redhawks retrievers ' +
  'roadrunners rockets royals saints seawolves seminoles sharks skyhawks ' +
  'spartans stallions terps terrapins terriers tigers tribe trojans vikings ' +
  'volunteers waves wildcats wolfpack wolverines zips'
).split(' '));

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

function stripMascot(folded) {
  let name = folded;
  for (let i = 0; i < MULTI_MASCOTS.length; i++) {
    const mascot = MULTI_MASCOTS[i];
    const tail = ' ' + mascot;
    if (name.endsWith(tail) && name.length > tail.length) {
      name = name.slice(0, -tail.length).trim();
      break;
    }
  }
  const parts = name.split(' ').filter(Boolean);
  if (parts.length > 1 && SINGLE_MASCOTS.has(parts[parts.length - 1])) {
    parts.pop();
    name = parts.join(' ');
  }
  return name;
}

// Trailing "St" is State (Central Connecticut St, Kansas St). A leading "St"
// is Saint (St. John's). "Cal St Fullerton" is State. Other internal "St"
// is Saint (Mount St. Mary's).
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
  let s = SCHOOL_ALIAS[school] || school;
  if (s.endsWith(' state')) {
    const base = s.slice(0, -' state'.length);
    if (STATE_OPTIONAL.has(base)) s = base;
  }
  return SCHOOL_ALIAS[s] || s;
}

function canonicalSchool(name) {
  const folded = foldTeam(name);
  if (!folded) return '';
  return applyAlias(expandSt(stripMascot(folded)));
}

function abbrHit(pickTeam, espnAbbr) {
  const abbr = String(espnAbbr || '').toLowerCase();
  if (abbr.length < 2) return false;
  const folded = foldTeam(pickTeam);
  if (!folded) return false;
  if (folded === abbr) return true;
  if (abbr.length < 3) return false;
  return folded.split(' ').includes(abbr);
}

function ncaamTeamsMatch(pickTeam, espnTeam, espnAbbr) {
  const left = canonicalSchool(pickTeam);
  const right = canonicalSchool(espnTeam);
  if (left && right && left === right) return true;
  if (abbrHit(pickTeam, espnAbbr)) return true;
  return false;
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
  collegeHoopsMatchEnabled,
};
