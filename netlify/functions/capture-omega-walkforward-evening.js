'use strict';

/**
 * Evening post-close walk-forward OBSERVER.
 *
 * 23:45 UTC = 7:45pm ET during EDT, after trigger-clv's 23:00 UTC pass.
 * Reads picks-{date} and clv-{date}. Writes omega-walkforward/* only.
 * Does not regenerate the live card, does not call calibrate, does not post.
 * FIT stays off. On 2026-11-01 (EDT→EST) the live cron is one hour early;
 * the prepared replacement is 00:45 UTC and must not be activated before that date.
 */

const morning = require('./capture-omega-walkforward');

exports.handler = async (event) => {
  const out = await morning.handler(event);
  if (!out || typeof out.body !== 'string') return out;
  try {
    const body = JSON.parse(out.body);
    body.slot = 'post-close';
    body.mutatesLiveCard = false;
    body.observerOnly = true;
    body.fitEnabled = false;
    body.fitApplied = false;
    return { ...out, body: JSON.stringify(body) };
  } catch (_) {
    return out;
  }
};

exports.runCapture = morning.runCapture;
exports.captureOne = morning.captureOne;
