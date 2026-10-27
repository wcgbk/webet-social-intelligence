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

// media-23778: "Week N Standings Update" has no "Full Season" token. It is the
// main card and must beat a later-dated, higher-week quarter PDF (and a quarter
// sheet that itself says "Standings Update"). Older explicit Full Season stays
// available but loses on week number.
const week7File = "Circa-Sports-Million-VIII-Week-7-Standings-Update.pdf";
const updatePool = [
  media(23542, "Circa Sports Million VIII &#8211; Full Season Standings After Week 5",
    "Circa-Sports-Million-VIII-Full-Season-Standings-After-Week-5.pdf", "2026-10-13T14:50:00"),
  media(23790, "Circa Sports Million VIII &#8211; 2nd Quarter Standings After Week 8",
    "Circa-Sports-Million-VIII-2nd-Quarter-Standings-After-Week-8.pdf", "2026-10-27T18:00:00"),
  media(23793, "Circa Sports Million VIII &#8211; 2nd Quarter Standings Update",
    "Circa-Sports-Million-VIII-2nd-Quarter-Standings-Update.pdf", "2026-10-27T19:00:00"),
  media(23778, "Circa Sports Million VIII &#8211; Week 7 Standings Update",
    week7File, "2026-10-21T16:00:00"),
];
const upd = L.pickLatestPdfs(updatePool);
assert.strictEqual(upd.season.id, 23778);
assert.strictEqual(upd.season.url, B + week7File);
assert.strictEqual(upd.season.week, 7);
assert.ok(/2nd-Quarter-Standings-After-Week-8/.test(upd.quarter.season.url));
assert.ok(!/Quarter/i.test(upd.season.url));

// Bare "Standings Update" (no week, no "Full Season") is still the main card
// when the only other sheet is a quarter PDF.
const bare = L.pickLatestPdfs([
  media(23791, "Circa Sports Million VIII &#8211; 3rd Quarter Standings After Week 6",
    "Circa-Sports-Million-VIII-3rd-Quarter-Standings-After-Week-6.pdf", "2026-10-20T12:00:00"),
  media(23792, "Circa Sports Million VIII &#8211; Standings Update",
    "Circa-Sports-Million-VIII-Standings-Update.pdf", "2026-10-20T11:00:00"),
]);
assert.ok(/Circa-Sports-Million-VIII-Standings-Update\.pdf$/.test(bare.season.url));
assert.strictEqual(bare.season.id, 23792);
assert.ok(/3rd-Quarter/.test(bare.quarter.season.url));

// Stale quarter last-good blob must not win over / substitute for full season.
(async () => {
  const meta = await L.resolveStandingsPdfs({
    readBlob: async () => ({ season: { url: B + "x-2nd-Quarter-Standings-After-Week-5.pdf", title: "2nd Quarter Standings After Week 5", week: 5 } }),
    writeBlob: async () => true,
    discover: async () => got,
    verify: async () => true,
  });
  assert.ok(/Full-Season-Standings-After-Week-5/.test(meta.season.url));

  // Stale quarter last-good with a higher week must not beat media 23778.
  const meta23778 = await L.resolveStandingsPdfs({
    readBlob: async () => ({
      season: {
        id: 23790,
        url: B + "Circa-Sports-Million-VIII-2nd-Quarter-Standings-After-Week-8.pdf",
        title: "Circa Sports Million VIII – 2nd Quarter Standings After Week 8",
        week: 8,
        date: "2026-10-27T18:00:00",
      },
    }),
    writeBlob: async () => true,
    discover: async () => upd,
    verify: async () => true,
  });
  assert.strictEqual(meta23778.season.id, 23778);
  assert.strictEqual(meta23778.season.url, B + week7File);

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
