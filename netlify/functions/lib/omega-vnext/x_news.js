'use strict';

/**
 * X (Twitter) recent-search hook for injury and roster news at selection.
 *
 * Token: X_BEARER_TOKEN, else TWITTER_BEARER_TOKEN. The token is sent as a
 * Bearer header and is never logged, never returned, and never written onto
 * the card. Tests inject fetchImpl and env. Do not print either.
 *
 * No token: mode "stub". No HTTP call. items is empty. This is the
 * documented fallback, not a silent price.
 *
 * ASSUMPTION: an X post is not a quantified coefficient. classifyXItems
 * logs the text and does not move a projection. ESPN injury rows are the
 * priced source. A tweet that does not match a quantified status stays a log.
 */

function tokenFrom(env) {
  // An explicit env object is the test injection. It does not fall through
  // to the process, so `{}` stays a stub. Generate omits env and reads the
  // Netlify runtime env here, at call time, not at module load.
  if (env && typeof env === 'object') {
    const injected = env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN || '';
    return String(injected).trim();
  }
  const live = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
  return String(live).trim();
}

function classifyXItems(items) {
  const logs = [];
  for (const item of items || []) {
    if (!item) continue;
    const text = String(item.text || item.full_text || '').slice(0, 240);
    logs.push({
      id: item.id || null,
      text,
      action: 'logged-unquantified',
      note: 'X item is not a priced coefficient',
    });
  }
  return logs;
}

async function fetchXNews({ dateISO, query, env, fetchImpl } = {}) {
  const tok = tokenFrom(env);
  if (!tok) {
    return {
      mode: 'stub',
      count: 0,
      items: [],
      logs: [],
      dateISO: dateISO || null,
      documented: 'No X_BEARER_TOKEN or TWITTER_BEARER_TOKEN. Stub returns no items and does not fetch.',
    };
  }
  const q = query || '(injury OR doubtful OR questionable OR inactive OR deactivated) (NFL OR NBA OR NHL OR MLB OR NCAAF) lang:en';
  const url = `https://api.x.com/2/tweets/search/recent?max_results=10&query=${encodeURIComponent(q)}`;
  const doFetch = fetchImpl || fetch;
  let resp;
  try {
    resp = await doFetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  } catch (e) {
    return { mode: 'http-error', count: 0, items: [], logs: [], dateISO: dateISO || null };
  }
  if (!resp || resp.ok === false) {
    return {
      mode: 'http-error',
      count: 0,
      items: [],
      logs: [],
      status: resp && resp.status != null ? resp.status : null,
      dateISO: dateISO || null,
    };
  }
  const body = typeof resp.json === 'function' ? await resp.json() : resp;
  const items = (body && Array.isArray(body.data)) ? body.data : [];
  const logs = classifyXItems(items);
  for (const row of logs) {
    console.log(`[omega-vnext/x-news] ${row.action} id=${row.id || ''}`);
  }
  return { mode: 'live', count: items.length, items, logs, dateISO: dateISO || null };
}

module.exports = {
  fetchXNews,
  classifyXItems,
  tokenFrom,
};
