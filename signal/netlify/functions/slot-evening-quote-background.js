// Evening Quote — ~7:00p ET. An ORIGINAL Ben Klein aphorism rendered as a branded quote
// card. Auto-posts if low-risk. Media posts fix the "almost no original visuals" problem.
const { connectLambda } = require("@netlify/blobs");
const { runSlot } = require("./lib/engine.js");
const { mayPost } = require("./lib/gate.js");

exports.handler = async (event) => {
  try { connectLambda(event); } catch { /* */ }
  const q = (event && event.queryStringParameters) || {};
  const headers = { "Content-Type": "application/json" };
  try {
    const out = await runSlot("evening-quote", { dryRun: !!q.dryRun, force: !!q.force, mayPost: mayPost(event) });
    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e).slice(0, 300) }) };
  }
};
