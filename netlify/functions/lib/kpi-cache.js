// Adaptive KPI cache: settle as soon as games go final, stay cheap when the
// slate is fully decided. America/New_York is the day boundary.

function getEasternDateToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function resultHasPending(cached) {
  if (!cached) return true;
  if ((cached.cumulative || {}).pending > 0) return true;
  const days = cached.days || [];
  return days.some(d => d.pending > 0 || d.parlayResult === 'pending');
}

function cacheTtlMs(cached) {
  return resultHasPending(cached) ? 30000 : 300000;
}

function swrSeconds(env) {
  const { kpiSwrShortEnabled } = require('./default_on_flag');
  return kpiSwrShortEnabled(env) ? 60 : 86400;
}

function cacheControlFor(cached, env) {
  const sec = resultHasPending(cached) ? 30 : 300;
  // OMEGA_KPI_SWR_SHORT default on: 60s. =off restores a one-day stale window.
  return `public, max-age=${sec}, s-maxage=${sec}, stale-while-revalidate=${swrSeconds(env)}`;
}

function wantFresh(event) {
  const p = event.queryStringParameters || {};
  // `t` is a CDN cache-bust only. It must not bypass the blob cache.
  return p.refresh === '1' || p.bust === '1';
}

function cacheIsFresh(cached, event) {
  if (wantFresh(event)) return false;
  if (!cached || !cached.cachedAt) return false;
  return (Date.now() - cached.cachedAt) < cacheTtlMs(cached);
}

module.exports = {
  getEasternDateToday,
  resultHasPending,
  cacheTtlMs,
  cacheControlFor,
  swrSeconds,
  wantFresh,
  cacheIsFresh,
};
