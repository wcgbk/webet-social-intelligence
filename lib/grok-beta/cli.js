"use strict";

// Local / one-shot runner: node lib/grok-beta/cli.js
const { runGrokBeta } = require("./pipeline");

(async () => {
  try {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--date" && args[i + 1]) opts.date = args[++i];
      else if (args[i] === "--dry-run") opts.dryRun = true;
      else if (args[i] === "--skip-validate") opts.skipValidate = true;
      else if (args[i] === "--force") opts.force = true;
    }
    const result = await runGrokBeta(opts);
    const picks = result.picks || [];
    console.log(JSON.stringify({
      date: result.date,
      version: result.modelVersion,
      sportsScanned: result.sportsScanned,
      gamesScanned: result.gamesScanned,
      candidateCount: result.candidateCount,
      published: picks.length,
      noPlays: result.noPlays || null,
      picks: picks.map(p => ({
        sport: p.sport, game: p.matchup, market: p.betType, side: p.side,
        line: p.line, odds: p.odds, units: p.units, edge: p.edge,
      })),
    }, null, 2));
  } catch (e) {
    console.error("[grok-beta-cli]", e);
    process.exit(1);
  }
})();
