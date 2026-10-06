'use strict';

/**
 * Exact football identity key.
 * Lowercase, strip accents, delete okina and apostrophes (so Hawaiʻi = Hawaii
 * and San José = San Jose), turn other punctuation into spaces, collapse spaces.
 * No substring and no mascot rule lives here.
 */
function normalizeTeamName(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\u02bb\u02bc\u02b9\u02be\u02bf\u2018\u2019\u201a\u201b\u2032\u0060\u00b4']/g, '');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

module.exports = { normalizeTeamName };
