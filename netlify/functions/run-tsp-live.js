// run-tsp-live.js
// On-demand wrapper for the TSP.Live fetcher (Netlify 403s external HTTP calls to
// scheduled functions — same pattern as run-verify-alpha/omega).
//   POST /.netlify/functions/run-tsp-live?key=<TSP_PAGE_KEY or PICKS_SECRET_KEY>
const fetcher = require("./fetch-tsp-live.js");

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const ok =
    (process.env.TSP_PAGE_KEY && params.key === process.env.TSP_PAGE_KEY) ||
    (process.env.PICKS_SECRET_KEY && params.key === process.env.PICKS_SECRET_KEY);
  if (!ok) {
    return { statusCode: 401, body: JSON.stringify({ error: true, message: "Unauthorized" }) };
  }
  return fetcher.handler();
};
