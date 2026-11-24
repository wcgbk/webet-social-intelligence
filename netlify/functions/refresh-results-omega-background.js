'use strict';
// Recompute Edge KPIs and PUT results-omega-cache. No schedule.
// *-background runs up to 15 minutes. get-results-omega posts here when a stale
// blob was served under OMEGA_KPI_SERVE_STALE.

const { handler: getResults } = require('./get-results-omega');

exports.handler = async function handler() {
  return getResults({
    httpMethod: 'GET',
    queryStringParameters: { refresh: '1', range: 'all' },
  });
};
