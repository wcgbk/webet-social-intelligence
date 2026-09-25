"use strict";

/**
 * GET /.netlify/functions/get-circa-card-health
 * READ ONLY ops snapshot of last Circa card-health (circa-ops/*).
 * Optional ?date=YYYY-MM-DD. Circa-only.
 */

const {
  readCircaCardHealthLatest,
  readCircaCardHealthDate,
  readCircaCardHealthAlert,
} = require("./lib/circa-card-health");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event && event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  const wantAlert = qs.alert === "1" || qs.alert === "true";
  try {
    let snap = null;
    let key = "circa-ops/card-health-latest";
    if (wantAlert) {
      snap = await readCircaCardHealthAlert();
      key = "circa-ops/card-health-alert";
    } else if (dateISO) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ ok: false, error: "bad date (YYYY-MM-DD)" }),
        };
      }
      snap = await readCircaCardHealthDate(dateISO);
      key = `circa-ops/card-health-${dateISO}`;
    } else {
      snap = await readCircaCardHealthLatest();
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        opsOnly: true,
        key,
        snapshot: snap,
        note: "Ops signal only — does not change Circa pick math. Alerts when card pending/empty/error or <5 picks after cron.",
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message, snapshot: null }),
    };
  }
};
