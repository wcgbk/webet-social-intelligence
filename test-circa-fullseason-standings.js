#!/usr/bin/env node
// Circa standings: main links must be Full Season PDFs; quarter PDFs only as extras.
const assert = require("assert");
const L = require("./netlify/functions/lib/circa-standings");

const B = "https://www.circasports.com/wp-content/uploads/2026/10/";
const media = (id, title, file, date) => ({
  id, title: { rendered: title }, source_url: B + file, mime_type: "application/pdf", date,
});
const pool = [
  media(23544, "Circa Sports Million VIII &#8211; 2nd Quarter Standings After Week 5",
    "Circa-Sports-Million-VIII-2nd-Quarter-Standings-After-Week-5.pdf", "2026-10-13T14:55:57"),
  media(23545, "Circa Sports Million VIII &#8211; 2nd Quarter Last Place Leaders After Week 5",
    "Circa-Sports-Million-VIII-2nd-Quarter-Last-Place-Leaders-After-Week-5.pdf", "2026-10-13T14:55:58"),
  media(23542, "Circa Sports Million VIII &#8211; Full Season Standings After Week 5",
    "Circa-Sports-Million-VIII-Full-Season-Standings-After-Week-5.pdf", "2026-10-13T14:50:00"),
  media(23543, "Circa Sports Million VIII &#8211; Full Season Last Place Leaders After Week 5",
    "Circa-Sports-Million-VIII-Full-Season-Last-Place-Leaders-After-Week-5.pdf", "2026-10-13T14:50:01"),
  media(23400, "Circa Sports Million VIII &#8211; Full Season Standings After Week 4",
    "Circa-Sports-Million-VIII-Full-Season-Standings-After-Week-4.pdf", "2026-10-06T14:00:00"),
];
const got = L.pickLatestPdfs(pool);
assert.strictEqual(got.season.url, B + "Circa-Sports-Million-VIII-Full-Season-Standings-After-Week-5.pdf");
assert.strictEqual(got.lastPlace.url, B + "Circa-Sports-Million-VIII-Full-Season-Last-Place-Leaders-After-Week-5.pdf");
assert.ok(/2nd-Quarter-Standings/.test(got.quarter.season.url));

// Stale quarter last-good blob must not win over / substitute for full season.
(async () => {
  const meta = await L.resolveStandingsPdfs({
    readBlob: async () => ({ season: { url: B + "x-2nd-Quarter-Standings-After-Week-5.pdf", title: "2nd Quarter Standings After Week 5", week: 5 } }),
    writeBlob: async () => true,
    discover: async () => got,
    verify: async () => true,
  });
  assert.ok(/Full-Season-Standings-After-Week-5/.test(meta.season.url));

  // Collapsed Full Season rows (2-digit wins, greedy-regex trap).
  const r = L.parseStandingsRow("4,928TPICKWIZARD32-3209-10-1-09.50");
  assert.deepStrictEqual([r.entry, r.place, r.tiedFlag, r.points, r.record], ["PICKWIZARD32-3", 4928, true, 9.5, "9-10-1-0"]);
  const t = L.parseStandingsRow("1TPARLAYSAM-22520-4-1-020.50");
  assert.deepStrictEqual([t.entry, t.points, t.record], ["PARLAYSAM-2", 20.5, "20-4-1-0"]);
  const parsed = L.parseStandingsText("4,928TPICKWIZARD32-3209-10-1-09.50\n");
  const row = L.lookupAliasEntries(parsed, ["PICKWIZARD32-3"])[0];
  assert.strictEqual(row.placeDisplay, "4,928T");
  assert.strictEqual(row.recordDisplay, "9-10-1");
  console.log("test-circa-fullseason-standings: OK");
})().catch((e) => { console.error(e); process.exit(1); });
