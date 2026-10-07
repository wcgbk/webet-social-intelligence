'use strict';

/**
 * Evening post-close walk-forward OBSERVER.
 *
 * 19:45 ET, after the evening CLV pass. Cron fires 23:45 and 00:45 UTC;
 * the ET guard keeps the 19:45 ET run in both EDT and EST.
 * Reads picks-{date} and clv-{date}. Writes omega-walkforward/* only.
 * Does not regenerate the live card, does not call calibrate, does not post.
 * FIT stays off.
 */

const morning = require('./capture-omega-walkforward');
const { rejectUnlessEtSlot } = require('./lib/et-schedule');

exports.handler = async (event, context) => {
  const etSkip = rejectUnlessEtSlot('capture-omega-walkforward-evening', event);
  if (etSkip) return etSkip;
  const out = await morning.handler(event, Object.assign({}, context, { skipEtGuard: true }));
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
