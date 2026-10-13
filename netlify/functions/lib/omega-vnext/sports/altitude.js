'use strict';

/**
 * Venue altitude on top of the flat home-field constant.
 * Stadium files store lat/lon and roof, not elevation, so this is a
 * name match. Neutral sites stay 0. The add is capped.
 * Team xG-style extras are not part of this term.
 */

const ALTITUDE_HFA_CAP = 1;
const ALTITUDE_FLOOR_FT = 2500;
const ALTITUDE_BASE_FT = 2000;
const ALTITUDE_PER_1000 = 0.18;

/** Distinctive stadium names. Generic names such as "University Stadium" are omitted. */
const FEET_BY_NAME = Object.freeze({
  'empower field at mile high': 5280,
  'empower field': 5280,
  'mile high': 5280,
  'folsom field': 5430,
  'falcon stadium': 6621,
  'canvas stadium': 5003,
  'rice-eccles stadium': 4657,
  'lavell edwards stadium': 4649,
  'sun bowl': 3943,
  'albertsons stadium': 2720,
  'mackay stadium': 4505,
});

/** Home club when the venue name is not on the row. */
const FEET_BY_TEAM = Object.freeze({
  'denver broncos': 5280,
  'colorado buffaloes': 5430,
  'air force falcons': 6621,
  'wyoming cowboys': 7220,
  'new mexico lobos': 5100,
  'colorado state rams': 5003,
  'utah utes': 4657,
  'byu cougars': 4649,
  'brigham young cougars': 4649,
  'utep miners': 3943,
  'boise state broncos': 2720,
  'nevada wolf pack': 4505,
});

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function feetFor(name, table) {
  const key = norm(name);
  if (!key || table[key] == null) return null;
  return table[key];
}

function venueNameOf(espnGame) {
  if (!espnGame || typeof espnGame !== 'object') return null;
  if (espnGame.venueName) return espnGame.venueName;
  const venue = espnGame.venue || espnGame.competitionVenue;
  if (!venue || typeof venue !== 'object') return null;
  return venue.displayName || venue.fullName || venue.name || null;
}

function altitudeFeet({ venueName, home } = {}) {
  const byVenue = feetFor(venueName, FEET_BY_NAME);
  if (byVenue != null) return byVenue;
  return feetFor(home, FEET_BY_TEAM);
}

function altitudeHfaPoints({ venueName, home, neutral } = {}) {
  if (neutral) return 0;
  const ft = altitudeFeet({ venueName, home });
  if (!ft || ft < ALTITUDE_FLOOR_FT) return 0;
  const raw = ALTITUDE_PER_1000 * Math.max(0, (ft - ALTITUDE_BASE_FT) / 1000);
  if (!(raw > 0)) return 0;
  return Math.min(ALTITUDE_HFA_CAP, Math.round(raw * 1000) / 1000);
}

/**
 * Flat HFA plus the altitude term. A neutral site is 0 for both.
 */
function homeFieldPoints(base, opts) {
  const src = opts || {};
  const neutral = src.neutral === true;
  const flat = neutral ? 0 : (Number(base) || 0);
  const altitude = altitudeHfaPoints({
    venueName: src.venueName || venueNameOf(src.espnGame),
    home: src.home,
    neutral,
  });
  return { hfa: flat + altitude, altitude, flat };
}

module.exports = {
  ALTITUDE_HFA_CAP,
  ALTITUDE_FLOOR_FT,
  altitudeFeet,
  altitudeHfaPoints,
  homeFieldPoints,
  venueNameOf,
};
