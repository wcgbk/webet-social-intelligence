#!/usr/bin/env node
/**
 * Local recovery helper for Circa Million VIII image-only Contest Point Spreads PDFs.
 *
 * Usage:
 *   node scripts/ocr-circa-week-fixture.js 4
 *   node scripts/ocr-circa-week-fixture.js 4 --url https://www.circasports.com/wp-content/uploads/2026/10/...pdf
 *
 * Prefers Netlify-safe OCR (pdfium wasm + tesseract.js) via
 * netlify/functions/lib/circa-contest-pdf-ocr.js. Falls back to pdftoppm/tesseract.
 * Prints a WEEK{N}_GAMES stub + SOURCE_URL to paste into
 * netlify/functions/lib/circa-contest-lines.js, then ship + let Fri catch-up regen.
 */
const path = require("path");
const ocrLib = require("../netlify/functions/lib/circa-contest-pdf-ocr");
const lines = require("../netlify/functions/lib/circa-contest-lines");

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

  const ocr = await ocrLib.ocrContestPdf(buf);
  const text = ocr.text || "";
  console.error(`OCR engine=${ocr.engine} pages=${ocr.pageCount} chars=${text.length}`);

  const parsed = lines.parseContestText(text, week);
  console.log(`const WEEK${week}_SOURCE_URL =`);
  console.log(`  "${sourceUrl}";`);
  console.log("");
  console.log(`// OCR preview (${ocr.engine}):`);
  console.log("/*");
  console.log((text || "(no OCR text)").slice(0, 4000));
  console.log("*/");
  console.log(`const WEEK${week}_GAMES = [`);
  if (parsed.games && parsed.games.length) {
    for (const g of parsed.games) {
      console.log(
        `  gameRow({ away: ${JSON.stringify(g.away)}, home: ${JSON.stringify(g.home)}, ` +
          `awaySpread: ${g.awaySpread}, homeSpread: ${g.homeSpread} }),`
      );
    }
  } else {
    console.log(
      `  // gameRow({ away: "...", home: "...", commenceHint: "...", commenceTime: "...", awaySpread: 0, homeSpread: 0, contestIds: { away: 2, home: 1 } }),`
    );
  }
  console.log("];");
  console.error(`Parsed ${parsed.games.length} game(s) from OCR — verify against the official sheet before committing.`);
  console.error(`Tip: production generate path OCRs automatically (no hand fixture) when ESPN slate pairing succeeds.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
