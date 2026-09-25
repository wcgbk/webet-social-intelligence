#!/usr/bin/env node
/**
 * Local recovery helper for Circa Million VIII image-only Contest Point Spreads PDFs.
 *
 * Usage:
 *   node scripts/ocr-circa-week-fixture.js 4
 *   node scripts/ocr-circa-week-fixture.js 4 --url https://www.circasports.com/wp-content/uploads/2026/10/...pdf
 *
 * Requires pdftoppm (poppler-utils). Optional: tesseract for OCR text.
 * Prints a WEEK{N}_GAMES stub + SOURCE_URL to paste into
 * netlify/functions/lib/circa-contest-lines.js, then ship + let Fri catch-up regen.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const week = Number(process.argv[2]);
if (!Number.isInteger(week) || week < 1 || week > 18) {
  console.error("Usage: node scripts/ocr-circa-week-fixture.js <weekNum> [--url <pdfUrl>]");
  process.exit(1);
}

const urlFlag = process.argv.indexOf("--url");
const overrideUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : null;
const name = `Circa-Sports-Million-VIII-Contest-Point-Spreads-Week-${week}.pdf`;
const candidates = overrideUrl
  ? [overrideUrl]
  : [
      `https://www.circasports.com/wp-content/uploads/2026/09/${name}`,
      `https://www.circasports.com/wp-content/uploads/2026/10/${name}`,
      `https://www.circasports.com/wp-content/uploads/2026/11/${name}`,
      `https://www.circasports.com/wp-content/uploads/2026/12/${name}`,
    ];

async function main() {
  let buf = null;
  let sourceUrl = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "WeBetAI-CircaFixtureHelper/1.0" } });
      if (!resp.ok) continue;
      const ab = await resp.arrayBuffer();
      if (ab.byteLength < 1000) continue;
      buf = Buffer.from(ab);
      sourceUrl = url;
      console.error(`Downloaded ${url} (${buf.length} bytes)`);
      break;
    } catch (e) {
      /* try next */
    }
  }
  if (!buf) {
    console.error("Could not download Week", week, "PDF from known URL patterns. Pass --url.");
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "circa-fixture-"));
  const pdf = path.join(dir, "week.pdf");
  fs.writeFileSync(pdf, buf);
  spawnSync("pdftoppm", ["-png", "-r", "200", pdf, path.join(dir, "page")], { stdio: "inherit" });
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  let ocr = "";
  for (const page of pages) {
    const r = spawnSync("tesseract", [path.join(dir, page), "stdout"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) ocr += r.stdout + "\n";
  }

  console.log(`const WEEK${week}_SOURCE_URL =`);
  console.log(`  "${sourceUrl}";`);
  console.log("");
  console.log(`// TODO: verify spreads against ${path.join(dir, pages[0] || "page-1.png")}`);
  console.log(`// OCR text preview (may be empty if tesseract missing):`);
  console.log("/*");
  console.log((ocr || "(no OCR — open the PNG and fill gameRow entries by hand)").slice(0, 4000));
  console.log("*/");
  console.log(`const WEEK${week}_GAMES = [`);
  console.log(`  // gameRow({ away: "...", home: "...", commenceHint: "...", commenceTime: "...", awaySpread: 0, homeSpread: 0, contestIds: { away: 2, home: 1 } }),`);
  console.log("];");
  console.error(`PNG(s) at ${dir} — visually confirm before committing.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
