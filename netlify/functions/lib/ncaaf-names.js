// College-football name canonicalization for grading.
// ESPN display names and the card's names disagree on abbreviations
// (UMass / Massachusetts, Southern Miss / Southern Mississippi, McNeese /
// McNeese State) and on accents (San José). Aliases follow the sizing-v2
// NAME_ALIAS list, plus the school-only forms those full names reduce to.
//
// Matching is equality after alias and mascot strip. A shorter school is not
// treated as a prefix of a longer one, so Miami (OH) does not grade as Miami.

const { formatCfbSchoolName } = require('./cfb-school-name');

const NAME_ALIAS = {
  'umass minutemen': 'massachusetts minutemen',
  'umass': 'massachusetts',
  'miami oh redhawks': 'miami ohio redhawks',
  'miami oh': 'miami ohio',
  'southern miss golden eagles': 'southern mississippi golden eagles',
  'southern miss': 'southern mississippi',
  'southern mississippi golden eagles': 'southern mississippi golden eagles',
  'san jose st spartans': 'san jose state spartans',
  'san jose st': 'san jose state',
  'mcneese state cowboys': 'mcneese cowboys',
  'mcneese state': 'mcneese',
  'ole miss rebels': 'mississippi rebels',
  'ole miss': 'mississippi',
  'louisiana ragin cajuns': 'louisiana ragin cajuns',
  'ul monroe warhawks': 'louisiana monroe warhawks',
  'ul monroe': 'louisiana monroe',
  'sam houston st bearkats': 'sam houston bearkats',
  'sam houston state bearkats': 'sam houston bearkats',
  'sam houston st': 'sam houston',
  'sam houston state': 'sam houston',
  'app state mountaineers': 'appalachian state mountaineers',
  'app state': 'appalachian state',
  'fau owls': 'florida atlantic owls',
  'fau': 'florida atlantic',
  'fiu panthers': 'florida international panthers',
  'fiu': 'florida international',
  'utsa roadrunners': 'utsa roadrunners',
  'uconn huskies': 'connecticut huskies',
  'uconn': 'connecticut',
  'state louis blues': 'st louis blues',
  'state louis cardinals': 'st louis cardinals',
  'saint louis blues': 'st louis blues',
  'saint louis cardinals': 'st louis cardinals',
};

function foldTeam(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "st" means State, except the St. Louis clubs.
function expandSt(name) {
  return String(name || '').replace(/\bst\b(?! louis)/g, 'state');
}

function applyAlias(name) {
  const key = expandSt(foldTeam(name));
  return NAME_ALIAS[key] || key;
}

function canonicalTeam(name) {
  return applyAlias(name);
}

function canonicalSchool(name) {
  const full = canonicalTeam(name);
  const stripped = foldTeam(formatCfbSchoolName(full));
  return applyAlias(stripped || full);
}

function schoolsEqual(a, b) {
  const left = canonicalSchool(a);
  const right = canonicalSchool(b);
  return !!(left && right && left === right);
}

module.exports = {
  NAME_ALIAS,
  foldTeam,
  canonicalTeam,
  canonicalSchool,
  schoolsEqual,
};
