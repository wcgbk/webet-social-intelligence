// grok-beta-run-background.js
// Isolated Grok Beta generator. Writes ONLY to the grok-beta blob store.
// Does not read or write edge-picks-alpha.

const { runGrokBeta } = require("../../lib/grok-beta/pipeline");

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  try {
    const result = await runGrokBeta({
      date: body.date,
      force: !!body.force,
      dryRun: !!body.dryRun,
      skipValidate: !!body.skipValidate,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        date: result.date,
        version: result.modelVersion,
        picks: (result.picks || []).length,
        candidates: result.candidateCount,
        gamesScanned: result.gamesScanned,
        noPlays: result.noPlays || null,
      }),
    };
  } catch (err) {
    console.error("[grok-beta-run-background]", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
