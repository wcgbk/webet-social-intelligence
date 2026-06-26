// Branded card renderer for "The Signal" — Ben Klein (@wcgbk).
// Hand-coded SVG -> PNG via resvg. Distinct from the AskAPai cosmic card: a premium
// dark "editorial" card with a gold signal accent, niche badge, large serif headline,
// and a Ben Klein / @wcgbk byline. Fonts fetched from jsDelivr (cached in /tmp) because
// Lambda ships no system fonts (otherwise resvg renders tofu).
const { Resvg } = require("@resvg/resvg-js");
const fs = require("fs");

const FONT_URLS = {
  "DejaVuSans.ttf": "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
  "DejaVuSans-Bold.ttf": "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf",
  "DejaVuSerif-Bold.ttf": "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSerif-Bold.ttf",
};
async function ensureFonts() {
  const out = [];
  for (const [name, url] of Object.entries(FONT_URLS)) {
    const p = "/tmp/signal-" + name;
    try {
      if (!fs.existsSync(p)) {
        const r = await fetch(url);
        if (r.ok) fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      }
      if (fs.existsSync(p)) out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Greedy word-wrap to ~maxChars per line. Returns an array of lines (<= maxLines).
function wrapText(text, maxChars, maxLines = 6) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length <= maxChars) {
      line = (line + " " + w).trim();
    } else {
      if (line) lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    // ran out of room — ellipsize the last line
    const rest = words.slice(lines.join(" ").split(/\s+/).length).join(" ");
    if (rest) lines[maxLines - 1] = (lines[maxLines - 1] + " …").slice(0, maxChars);
  }
  return lines;
}

// Niche → accent color + display label for the badge.
const NICHE = {
  politics: { label: "POLITICS", c: "#c98a5a" },
  startups: { label: "STARTUPS", c: "#4fbfa6" },
  vc: { label: "VENTURE", c: "#9a86d6" },
  economy: { label: "ECONOMY", c: "#7fb0d6" },
  crypto: { label: "CRYPTO", c: "#e9b949" },
  "personal-development": { label: "MINDSET", c: "#6fc080" },
  quotes: { label: "SIGNAL", c: "#d8c9a0" },
};
// Brand palette — WeBetAI deep teal/green on white. No gold/yellow.
const TEAL = "#15403d";        // brand bands / accents
const TEAL_INK = "#143b38";    // headline text
const MUTE = "#5f6f6a";        // muted body text
const BANDTX = "#f4f7f4";      // near-white text on teal bands
const MINT = "#bcd9cd";        // soft mint accent on teal bands

// kind: "quote" (centered serif) | "take" (headline + kicker). Clean WHITE card (pops on X's dark
// feed, defined on light), VERTICAL 4:5 (owns mobile screen), deep-teal bands top AND bottom,
// big high-contrast serif headline, @handle emphasized in the bottom band (the follow driver).
function buildCardSVG({ kind = "quote", niche = "quotes", headline = "", sub = "", avatarUri = null }) {
  const W = 1080, H = 1350;               // 4:5 vertical — maximum feed real estate on mobile
  const PAD = 96, BAND = 116, BBAND = 156; // top + bottom band heights
  const n = NICHE[niche] || NICHE.quotes;

  // Size headline to length — vertical card has room to go BIG.
  const len = String(headline).length;
  const fs2 = len <= 55 ? 80 : len <= 95 ? 68 : len <= 140 ? 58 : len <= 185 ? 50 : 43;
  const cpl = len <= 55 ? 16 : len <= 95 ? 21 : len <= 140 ? 26 : len <= 185 ? 31 : 37;
  const lines = wrapText(headline, cpl, 8);
  const lh = Math.round(fs2 * 1.3);
  const blockH = lines.length * lh;
  const areaTop = BAND + 110, areaBot = H - BBAND - 40;
  const startY = Math.round(areaTop + ((areaBot - areaTop) - blockH) / 2) + Math.round(fs2 * 0.76);

  const headlineSvg = lines.map((ln, i) =>
    `<text x="${PAD}" y="${startY + i * lh}" font-family="DejaVu Serif" font-size="${fs2}" font-weight="bold" fill="${TEAL_INK}">${esc(ln)}</text>`
  ).join("");

  const by = H - BBAND / 2;                // byline center inside the bottom band
  const avatar = avatarUri
    ? `<circle cx="${PAD + 26}" cy="${by}" r="28" fill="#fff" stroke="${MINT}" stroke-width="2"/>
       <image href="${avatarUri}" xlink:href="${avatarUri}" x="${PAD - 2}" y="${by - 26}" width="56" height="56" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${PAD + 26}" cy="${by}" r="28" fill="#0f312e" stroke="${MINT}" stroke-width="2"/>
       <text x="${PAD + 26}" y="${by + 8}" font-family="DejaVu Serif" font-size="22" font-weight="bold" fill="${MINT}" text-anchor="middle">BK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="100%" stop-color="#f4f7f5"/>
    </linearGradient>
    <clipPath id="av"><circle cx="${PAD + 26}" cy="${by}" r="28"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- subtle teal frame for edge definition on a light feed -->
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${TEAL}" stroke-opacity="0.12" stroke-width="2"/>

  <!-- top teal band: wordmark + niche -->
  <rect x="0" y="0" width="${W}" height="${BAND}" fill="${TEAL}"/>
  <text x="${PAD}" y="73" font-family="DejaVu Sans" font-size="25" font-weight="bold" fill="${BANDTX}" letter-spacing="7">THE SIGNAL</text>
  <circle cx="${W - PAD - (n.label.length * 14 + 22)}" cy="65" r="5" fill="${MINT}"/>
  <text x="${W - PAD}" y="71" font-family="DejaVu Sans" font-size="17" font-weight="bold" fill="${MINT}" text-anchor="end" letter-spacing="3">${esc(n.label)}</text>

  <!-- short teal kicker above the headline (no quote icon) -->
  <rect x="${PAD}" y="${startY - fs2 - 34}" width="76" height="7" rx="3.5" fill="${TEAL}"/>

  ${headlineSvg}

  ${(sub || "").trim() ? `<text x="${PAD}" y="${startY + lines.length * lh + 34}" font-family="DejaVu Sans" font-size="26" fill="${MUTE}">${esc((sub || "").trim().slice(0, 60))}</text>` : ""}

  <!-- bottom teal band: byline -->
  <rect x="0" y="${H - BBAND}" width="${W}" height="${BBAND}" fill="${TEAL}"/>
  ${avatar}
  <text x="${PAD + 72}" y="${by - 5}" font-family="DejaVu Sans" font-size="25" font-weight="bold" fill="${BANDTX}">Ben Klein</text>
  <text x="${PAD + 72}" y="${by + 26}" font-family="DejaVu Sans" font-size="20" font-weight="bold" fill="${MINT}">@wcgbk</text>
  <text x="${W - PAD}" y="${by + 8}" font-family="DejaVu Sans" font-size="16" font-weight="bold" fill="${MINT}" text-anchor="end" letter-spacing="2">FOLLOW FOR DAILY SIGNAL</text>
</svg>`;
}

let _avatarCache;
async function fetchAvatar() {
  if (_avatarCache !== undefined) return _avatarCache;
  try {
    const r = await fetch("https://pbs.twimg.com/profile_images/941755116540981248/tXl9Co5C_400x400.jpg");
    _avatarCache = r.ok ? "data:image/jpeg;base64," + Buffer.from(await r.arrayBuffer()).toString("base64") : null;
  } catch { _avatarCache = null; }
  return _avatarCache;
}

async function renderCard(opts) {
  const avatarUri = await fetchAvatar();
  const fontFiles = await ensureFonts();
  const svg = buildCardSVG({ ...opts, avatarUri });
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: fontFiles.length === 0, fontFiles, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "width", value: 1200 },
  });
  return Buffer.from(resvg.render().asPng());
}

module.exports = { renderCard, buildCardSVG, wrapText, NICHE };
