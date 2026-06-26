// Trigger gate — distinguishes Netlify SCHEDULED invocations (allowed to post) from
// arbitrary public HTTP hits (read-only unless they carry the secret key). Mirrors the
// askapai gate so the engine can never be made to post by an anonymous web request.

// Netlify puts { next_run } in the body of scheduled invocations.
function isScheduled(event) {
  try {
    const b = JSON.parse((event && event.body) || "{}");
    return !!b.next_run;
  } catch {
    return false;
  }
}

// Manual override — only the owner (with TRIGGER_SECRET) may force a real run.
function keyOk(event) {
  const q = (event && event.queryStringParameters) || {};
  const h = (event && event.headers) || {};
  const k = q.key || h["x-trigger-key"] || h["X-Trigger-Key"];
  return !!process.env.TRIGGER_SECRET && k === process.env.TRIGGER_SECRET;
}

// May this invocation actually POST to X? Scheduled cron OR an owner-keyed manual call.
function mayPost(event) {
  return isScheduled(event) || keyOk(event);
}

module.exports = { isScheduled, keyOk, mayPost };
