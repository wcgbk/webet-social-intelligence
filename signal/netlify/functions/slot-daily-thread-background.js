// Daily Thread — ~11:00a ET. 4-6 tweet thread on the day's biggest topic in Ben's lane.
// ALWAYS held for approval (higher reach + higher risk), per the hybrid policy.
const { connectLambda } = require("@netlify/blobs");
const { runSlot } = require("./lib/engine.js");
const { mayPost } = require("./lib/gate.js");

exports.handler = async (event) => {
  try { connectLambda(event); } catch { /* */ }
  const q = (event && event.queryStringParameters) || {};
  const headers = { "Content-Type": "application/json" };
  try {
    const out = await runSlot("daily-thread", { dryRun: !!q.dryRun, force: !!q.force, mayPost: mayPost(event) });
    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e).slice(0, 300) }) };
  }
};
