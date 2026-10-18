// Circa Contest Point Spreads — Netlify-safe PDF→image→OCR.
// Circa sheets are often Microsoft Print-to-PDF with outlined (vector) text and
// no text layer. System pdftoppm/tesseract are NOT on Netlify functions.
//
// Pipeline: @hyzyla/pdfium (wasm) rasterize → PNG → tesseract.js (wasm) OCR.
// Optional local fast path: pdftoppm + tesseract binaries when present.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

let _pdfiumLibrary = null;
let _pdfiumInitPromise = null;

function normalizeOcrQuirks(text) {
  return String(text || "")
    // Circa ½ often OCRs as % or ) after the integer (e.g. +4% → +4.5)
    .replace(/([+-]\d+)\s*[%)](?!\d)/g, "$1.5")
    .replace(/([+-]?\d+)\s*[½]/g, "$1.5")
    .replace(/(\d+)\s*[-\u2013]?\s*1\/2/g, "$1.5")
    .replace(/\u00bd/g, ".5")
    .replace(/\u00bc/g, ".25")
    .replace(/\u00be/g, ".75");
}

function rgbaToPng(width, height, rgba) {
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
  function chunk(tag, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    const buf = Buffer.concat([tag, data]);
    crc.writeUInt32BE(zlib.crc32(buf) >>> 0);
    return Buffer.concat([len, buf, crc]);
  }
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0;
    src.copy(rows, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk(
      Buffer.from("IHDR"),
      (() => {
        const b = Buffer.alloc(13);
        b.writeUInt32BE(width, 0);
        b.writeUInt32BE(height, 4);
        b[8] = 8;
        b[9] = 6;
        return b;
      })()
    ),
    chunk(Buffer.from("IDAT"), zlib.deflateSync(rows, { level: 6 })),
    chunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
}

function tryBin(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: opts.encoding || "buffer",
      timeout: opts.timeout || 25000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status === 0) return r.stdout;
  } catch (e) {
    /* binary missing */
  }
  return null;
}

function hasSystemOcr() {
  const a = tryBin("pdftoppm", ["-v"], { encoding: "utf8", timeout: 3000 });
  const b = tryBin("tesseract", ["--version"], { encoding: "utf8", timeout: 3000 });
  // pdftoppm -v writes to stderr; status may still be 0 with empty stdout — probe via spawn
  try {
    const p = spawnSync("pdftoppm", ["-v"], { encoding: "utf8", timeout: 3000 });
    const t = spawnSync("tesseract", ["--version"], { encoding: "utf8", timeout: 3000 });
    return (p.status === 0 || /pdftoppm/i.test(String(p.stderr || ""))) &&
      (t.status === 0 || /tesseract/i.test(String(t.stdout || t.stderr || "")));
  } catch (e) {
    return !!(a || b);
  }
}

function renderPdfSystem(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "circa-ocr-sys-"));
  try {
    const pdf = path.join(dir, "week.pdf");
    fs.writeFileSync(pdf, buf);
    const prefix = path.join(dir, "page");
    spawnSync("pdftoppm", ["-png", "-r", 150, pdf, prefix], { timeout: 30000 });
    const pages = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f)));
    return pages;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

async function getPdfiumLibrary() {
  if (_pdfiumLibrary) return _pdfiumLibrary;
  if (_pdfiumInitPromise) return _pdfiumInitPromise;
  _pdfiumInitPromise = (async () => {
    const { PDFiumLibrary } = require("@hyzyla/pdfium");
    const wasmPath = require.resolve("@hyzyla/pdfium/dist/pdfium.wasm");
    _pdfiumLibrary = await PDFiumLibrary.init({
      wasmBinary: fs.readFileSync(wasmPath),
    });
    return _pdfiumLibrary;
  })();
  return _pdfiumInitPromise;
}

async function renderPdfWasm(buf, scale = 2) {
  const library = await getPdfiumLibrary();
  const document = await library.loadDocument(buf);
  try {
    const pages = [];
    for (const page of document.pages()) {
      let bitmap = null;
      let width = 0;
      let height = 0;
      await page.render({
        scale,
        render: (opts) => {
          width = opts.width;
          height = opts.height;
          bitmap = Buffer.from(opts.data);
          return { ok: true };
        },
      });
      if (!bitmap || !width || !height) continue;
      pages.push(rgbaToPng(width, height, bitmap));
    }
    return pages;
  } finally {
    try {
      document.destroy();
    } catch (e) {
      /* ignore */
    }
  }
}

async function renderPdfPages(buf, opts = {}) {
  if (!buf || !buf.length) return [];
  if (opts.preferSystem !== false) {
    try {
      if (hasSystemOcr()) {
        const pages = renderPdfSystem(buf);
        if (pages && pages.length) return pages;
      }
    } catch (e) {
      /* fall through to wasm */
    }
  }
  return renderPdfWasm(buf, opts.scale || 2);
}

async function ocrPngBuffers(pngs, opts = {}) {
  if (!pngs || !pngs.length) return "";
  // Prefer system tesseract when available (faster local/dev).
  if (opts.preferSystem !== false) {
    try {
      const parts = [];
      for (const png of pngs) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "circa-tess-"));
        try {
          const img = path.join(dir, "page.png");
          fs.writeFileSync(img, png);
          const out = tryBin("tesseract", [img, "stdout"], {
            encoding: "utf8",
            timeout: 45000,
          });
          if (out && String(out).trim()) parts.push(String(out));
        } finally {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch (e) {
            /* ignore */
          }
        }
      }
      if (parts.join("\n").trim().length > 40) return parts.join("\n");
    } catch (e) {
      /* wasm fallback */
    }
  }

  const Tesseract = require("tesseract.js");
  const parts = [];
  for (const png of pngs) {
    const result = await Tesseract.recognize(png, "eng", {
      logger: () => {},
    });
    const text = result && result.data && result.data.text;
    if (text && String(text).trim()) parts.push(String(text));
  }
  return parts.join("\n");
}

/**
 * Rasterize + OCR a Circa contest PDF buffer.
 * @returns {{ text: string, pageCount: number, engine: string }}
 */
async function ocrContestPdf(buf, opts = {}) {
  if (!buf || !buf.length) {
    return { text: "", pageCount: 0, engine: "none" };
  }
  let pages = [];
  let engine = "none";
  try {
    pages = await renderPdfPages(buf, opts);
    engine = pages.length ? (hasSystemOcr() && opts.preferSystem !== false ? "pdftoppm+tesseract|wasm" : "pdfium+tesseract.js") : "none";
  } catch (e) {
    return { text: "", pageCount: 0, engine: "render-failed", error: e.message };
  }
  if (!pages.length) {
    return { text: "", pageCount: 0, engine: "no-pages" };
  }
  let text = "";
  try {
    text = await ocrPngBuffers(pages, opts);
  } catch (e) {
    return { text: "", pageCount: pages.length, engine, error: e.message };
  }
  text = normalizeOcrQuirks(text);
  return { text, pageCount: pages.length, engine };
}

module.exports = {
  normalizeOcrQuirks,
  rgbaToPng,
  renderPdfPages,
  ocrPngBuffers,
  ocrContestPdf,
  hasSystemOcr,
};
