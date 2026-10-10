'use strict';

const crypto = require('crypto');
const config = require('./config');
const {
  auditCardEnabled, keyMassEnabled, pushEvEnabled, nhlPeriodEnabled,
  gameExposureEnabled, parlayCorrEnabled, GAME_EXPOSURE_CAP, PARLAY_TOTAL_RHO,
  GAPS_BUILD,
} = require('./gaps_flags');
const { NFL_MARGIN_TARGETS, NCAAF_MARGIN_TARGETS, NFL_TOTAL_MULT } = require('./key_mass');
const { OT_GOALS_PER_GAME, OT_GOAL_GIVEN_TIE, LAMBDA_FLOOR } = require('./nhl_period');

function stable(value) {
  if (value == null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return 'null';
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function configPayload() {
  return {
    modelVersion: config.MODEL_VERSION,
    spreadStd: config.SPORT_SPREAD_STD,
    totalStd: config.SPORT_TOTAL_STD,
    nflKeyNumbers: config.NFL_KEY_NUMBERS,
    parlayHaircut: config.PARLAY_TOTAL_HAIRCUT,
    kelly: config.KELLY_FRACTION,
    gates: config.GATES,
    dailyUnitCap: config.DAILY_UNIT_CAP,
    maxStraightUnits: config.MAX_STRAIGHT_UNITS_PER_PICK,
    hfa: config.HFA,
    gapsBuild: GAPS_BUILD,
    nflMarginTargets: NFL_MARGIN_TARGETS,
    ncaafMarginTargets: NCAAF_MARGIN_TARGETS,
    nflTotalMult: NFL_TOTAL_MULT,
    gameExposureCap: GAME_EXPOSURE_CAP,
    parlayRho: PARLAY_TOTAL_RHO,
    nhlOtGoalsPerGame: OT_GOALS_PER_GAME,
    nhlOtGoalGivenTie: OT_GOAL_GIVEN_TIE,
    nhlLambdaFloor: LAMBDA_FLOOR,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function outcomeRow(o) {
  const price = o && o.price != null ? o.price : (o && o.american != null ? o.american : null);
  return {
    name: o && o.name != null ? String(o.name) : '',
    price: numOrNull(price),
    point: o && o.point != null && Number.isFinite(Number(o.point)) ? Number(o.point) : null,
  };
}

function snapshotPayload(snap) {
  const odds = {};
  const by = (snap && snap.oddsBySport) || {};
  for (const sport of Object.keys(by).sort()) {
    const events = (Array.isArray(by[sport]) ? by[sport] : []).map((ev) => {
      const books = (ev && ev.bookmakers ? ev.bookmakers : []).map((bk) => ({
        key: bk && bk.key != null ? String(bk.key) : '',
        markets: (bk && bk.markets ? bk.markets : []).map((m) => ({
          key: m && m.key != null ? String(m.key) : '',
          outcomes: (m && m.outcomes ? m.outcomes : []).map(outcomeRow).sort((a, b) => {
            const name = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            if (name) return name;
            return (a.point == null ? 0 : a.point) - (b.point == null ? 0 : b.point);
          }),
        })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return {
        home: ev && ev.home_team != null ? String(ev.home_team) : '',
        away: ev && ev.away_team != null ? String(ev.away_team) : '',
        commence: ev && (ev.commence_time || ev.commenceTime) ? String(ev.commence_time || ev.commenceTime) : '',
        books,
      };
    }).sort((a, b) => {
      if (a.commence !== b.commence) return a.commence < b.commence ? -1 : 1;
      if (a.away !== b.away) return a.away < b.away ? -1 : 1;
      if (a.home !== b.home) return a.home < b.home ? -1 : 1;
      return 0;
    });
    odds[sport] = events;
  }
  const standings = {};
  const tables = (snap && snap.standingsBySport) || {};
  for (const sport of Object.keys(tables).sort()) {
    const table = tables[sport] && typeof tables[sport] === 'object' ? tables[sport] : {};
    standings[sport] = Object.keys(table).sort().map((team) => {
      const row = table[team] || {};
      const pf = row.pf != null ? row.pf : row.pointsFor;
      const pa = row.pa != null ? row.pa : row.pointsAgainst;
      return {
        team: String(team),
        wins: numOrNull(row.wins),
        losses: numOrNull(row.losses),
        pf: numOrNull(pf),
        pa: numOrNull(pa),
      };
    });
  }
  return {
    date: snap && snap.dateISO ? String(snap.dateISO) : '',
    odds,
    standings,
  };
}

/**
 * Private card audit. OMEGA_CARD_AUDIT=0 returns null and the caller
 * omits the field, which is the 2e0a803 card. Hashes exclude fetchedAt
 * and generatedAt so a frozen replay is stable.
 */
function buildCardAudit({ snap, modelVersion } = {}) {
  if (!auditCardEnabled()) return null;
  try {
    return {
      modelVersion: modelVersion || config.MODEL_VERSION,
      gapsBuild: GAPS_BUILD,
      configHash: sha256(stable(configPayload())),
      inputSnapshotHash: sha256(stable(snapshotPayload(snap))),
      toggles: {
        OMEGA_KEY_MASS: keyMassEnabled(),
        OMEGA_PUSH_EV: pushEvEnabled(),
        OMEGA_NHL_PERIOD: nhlPeriodEnabled(),
        OMEGA_GAME_EXPOSURE: gameExposureEnabled(),
        OMEGA_PARLAY_CORR: parlayCorrEnabled(),
        OMEGA_CARD_AUDIT: true,
      },
    };
  } catch (err) {
    console.error(`[omega-vnext] card audit soft-fail: ${err && err.message}`);
    return null;
  }
}

module.exports = { buildCardAudit, stable, sha256 };
