// run-verify-alpha.js
// On-demand wrapper for the ALPHA QA. Netlify returns 403 for external HTTP calls to
// scheduled functions, which forced manual QA runs into local harnesses. This plain
// function is key-gated and invokes the verify-picks handler in-process (mirrors
// run-verify-omega.js):
//   GET /.netlify/functions/run-verify-alpha?key=<PICKS_SECRET_KEY>[&date=YYYY-MM-DD]
const verifyAlpha = require("./verify-picks.js");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY;
  if (!secret || params.key !== secret) {
    return { statusCode: 401, body: JSON.stringify({ error: true, message: "Unauthorized" }) };
  }
  return verifyAlpha.handler({ httpMethod: "GET", queryStringParameters: { date: params.date || null } });
};
