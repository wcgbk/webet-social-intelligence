// Morning Take — ~8:30a ET. Single contrarian hot take on the day's biggest story in
// Ben's lane. Auto-posts if low-risk; held for approval if sensitive (politics/PsyOp/etc).
const { connectLambda } = require("@netlify/blobs");
const { runSlot } = require("./lib/engine.js");
const { mayPost } = require("./lib/gate.js");

exports.handler = async (event) => {
  try { connectLambda(event); } catch { /* */ }
  const q = (event && event.queryStringParameters) || {};
  const headers = { "Content-Type": "application/json" };
  try {
    const out = await runSlot("morning-take", { dryRun: !!q.dryRun, force: !!q.force, mayPost: mayPost(event) });
    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e).slice(0, 300) }) };
  }
};
