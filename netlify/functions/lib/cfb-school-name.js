// CFB display names: school only, no mascot.
// Stored blob pick/matchup and ESPN scoreboard names stay full ("UNLV Rebels")
// so live-score matching still works. Cards render the school ("UNLV").
//
// NFL/MLB are unchanged — do not run these helpers on non-CFB sports.

const CFB_MULTI_WORD_MASCOTS = [
  'Rainbow Warriors',
  'Thundering Herd',
  'Fighting Irish',
  'Fighting Illini',
  'Fighting Hawks',
  'Fighting Camels',
  'Golden Hurricane',
  'Golden Flashes',
  'Golden Gophers',
  'Golden Eagles',
  'Golden Bears',
  'Golden Lions',
  'Golden Knights',
  'Golden Panthers',
  'Nittany Lions',
  'Yellow Jackets',
  'Demon Deacons',
  'Scarlet Knights',
  'Black Knights',
  'Horned Frogs',
  'Crimson Tide',
  'Delta Devils',
  'Blue Devils',
  'Sun Devils',
  'Blue Raiders',
  'Red Raiders',
  'Red Wolves',
  'Red Storm',
  'Red Flash',
  'Red Hawks',
  'Blue Hens',
  'Blue Hose',
  'Mean Green',
  'Green Wave',
  'Tar Heels',
  'Wolf Pack',
  'Black Bears',
  'Big Green',
  'Purple Aces',
  "Ragin' Cajuns",
  'Ragin Cajuns',
  "Runnin' Rebels",
  'Running Rebels',
  'Trail Blazers',
];

function isCfbSport(sport) {
  const s = String(sport || '').toUpperCase().trim();
  return s === 'NCAAF' || s === 'CFB' || s === 'NCAAFB' || s === 'COLLEGE FOOTBALL';
}

function foldCfbName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[''`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCfbSchoolName(fullName) {
  if (!fullName || typeof fullName !== 'string') return '';
  const name = fullName.trim().replace(/\s+/g, ' ');
  if (!name) return '';

  const folded = foldCfbName(name);
  const mascots = CFB_MULTI_WORD_MASCOTS
    .map((m) => ({ fold: foldCfbName(m), tokens: foldCfbName(m).split(' ').filter(Boolean) }))
    .sort((a, b) => b.fold.length - a.fold.length);

  for (const { fold, tokens } of mascots) {
    if (!fold) continue;
    if (folded === fold) return name;
    if (folded.endsWith(' ' + fold)) {
      const nameTokens = name.split(/\s+/);
      if (nameTokens.length > tokens.length) {
        return nameTokens.slice(0, nameTokens.length - tokens.length).join(' ');
      }
    }
  }

  const parts = name.split(/\s+/);
  if (parts.length === 1) return name;
  return parts.slice(0, -1).join(' ');
}

function formatCfbMatchupDisplay(matchup) {
  if (!matchup || typeof matchup !== 'string') return matchup || '';
  const sep = matchup.match(/\s+(vs\.?|@|at|v)\s+/i);
  if (!sep) return matchup;
  const parts = matchup.split(sep[0]);
  return formatCfbSchoolName(parts[0]) + ' vs ' + formatCfbSchoolName(parts[1]);
}

function formatCfbPickDisplay(pick) {
  if (!pick || typeof pick !== 'string') return pick || '';
  const s = pick.trim();
  if (!s) return s;
  if (/^(?:F5\s+)?(?:Over|Under)\b/i.test(s)) return s;
  const m = s.match(/^(.*?)(\s+(?:F5\s+)?(?:[+-]\d+(?:\.\d+)?|ML)(?:\s*\([^)]*\))?)\s*$/i);
  if (m && m[1].trim()) {
    return (formatCfbSchoolName(m[1]) + m[2]).replace(/\s+/g, ' ').trim();
  }
  return formatCfbSchoolName(s);
}

module.exports = {
  CFB_MULTI_WORD_MASCOTS,
  isCfbSport,
  formatCfbSchoolName,
  formatCfbMatchupDisplay,
  formatCfbPickDisplay,
};
