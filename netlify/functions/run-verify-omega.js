// run-verify-omega.js
// On-demand wrapper for the OMEGA QA. Netlify returns 403 for external HTTP calls to
// scheduled functions, which forced manual QA runs into local harnesses (audit Tier 6).
// This plain function is key-gated and invokes the verify-picks-omega handler in-process:
//   GET /.netlify/functions/run-verify-omega?key=<PICKS_SECRET_KEY>[&date=YYYY-MM-DD]
const verifyOmega = require("./verify-picks-omega.js");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY;
  if (!secret || params.key !== secret) {
    return { statusCode: 401, body: JSON.stringify({ error: true, message: "Unauthorized" }) };
  }
  return verifyOmega.handler({ httpMethod: "GET", queryStringParameters: { date: params.date || null } });
};
