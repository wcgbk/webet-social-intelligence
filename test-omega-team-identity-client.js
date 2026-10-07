'use strict';
// The committed browser asset must match the server tables byte for byte.
const assert = require('assert');
const fs = require('fs');
const { renderClientSource, OUT } = require('./scripts/build-team-identity-client');

const committed = fs.readFileSync(OUT, 'utf8');
const rendered = renderClientSource();
assert.strictEqual(rendered, committed, 'js/omega-team-identity.js drifted from the JSON tables');
const client = require('./js/omega-team-identity');
const server = require('./netlify/functions/lib/omega-vnext/sports/team_identity');
assert.strictEqual(client.IDENTITY_V2_FROM, '2026-10-07');
assert.strictEqual(client.resolveTeamId('MLB', "A's"), server.resolveTeamId('MLB', "A's"));
assert.strictEqual(client.resolveTeamId('MLB', 'Sox'), null);
assert.strictEqual(client.resolveTeamId('NBA', 'LA Clippers'), '12');
assert.strictEqual(client.resolveTeamId('NBA', 'LA Lakers'), '13');
console.log('ok test-omega-team-identity-client');
