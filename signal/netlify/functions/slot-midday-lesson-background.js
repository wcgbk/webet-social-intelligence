// Midday Lesson — ~1:00p ET. A founder/operator lesson in Ben's voice.
// Auto-posts if low-risk (evergreen lessons almost always are); held if sensitive.
const { connectLambda } = require("@netlify/blobs");
const { runSlot } = require("./lib/engine.js");
const { mayPost } = require("./lib/gate.js");

exports.handler = async (event) => {
  try { connectLambda(event); } catch { /* */ }
  const q = (event && event.queryStringParameters) || {};
  const headers = { "Content-Type": "application/json" };
  try {
    const out = await runSlot("midday-lesson", { dryRun: !!q.dryRun, force: !!q.force, mayPost: mayPost(event) });
    return { statusCode: 200, headers, body: JSON.stringify(out, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e).slice(0, 300) }) };
  }
};
