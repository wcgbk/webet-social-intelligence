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
const GOLD = "#e9b949";

// kind: "quote" (large centered serif, quotation marks) | "take" (headline + kicker).
// Conversion-tuned: big readable type, generous whitespace, subtle branding, and the
// @handle emphasized (handle drives profile-visits → follows; no website to leak attention).
function buildCardSVG({ kind = "quote", niche = "quotes", headline = "", sub = "", avatarUri = null }) {
  const W = 1200, H = 675;
  const PAD = 92;                         // generous left/right margin
  const n = NICHE[niche] || NICHE.quotes;
  const isQuote = kind === "quote";

  // Size the headline to its length so short lines read BIG (mobile-legible), long ones still fit.
  const len = String(headline).length;
  const fs2 = len <= 55 ? 60 : len <= 95 ? 52 : len <= 140 ? 45 : len <= 185 ? 39 : 34;
  const cpl = len <= 55 ? 21 : len <= 95 ? 26 : len <= 140 ? 31 : len <= 185 ? 37 : 43;
  const lines = wrapText(headline, cpl, 7);
  const lh = Math.round(fs2 * 1.28);
  const blockH = lines.length * lh;
  // Vertically center the quote block between the header and the byline.
  const areaTop = 168, areaBot = H - 132;
  const startY = Math.round(areaTop + ((areaBot - areaTop) - blockH) / 2) + Math.round(fs2 * 0.78);

  const headlineSvg = lines.map((ln, i) =>
    `<text x="${PAD}" y="${startY + i * lh}" font-family="DejaVu Serif" font-size="${fs2}" font-weight="bold" fill="#f6f3ec">${esc(ln)}</text>`
  ).join("");

  // very faint deterministic dot texture (subtle — no randomness, resume-safe)
  let dots = "";
  for (let i = 0; i < 64; i++) {
    const x = (i * 211 + 30) % W;
    const y = (i * 97 + 40) % H;
    const o = (0.02 + ((i * 17) % 30) / 1000).toFixed(3);
    dots += `<circle cx="${x}" cy="${y}" r="1" fill="#ffffff" opacity="${o}"/>`;
  }

  const cy = H - 60;                      // byline baseline anchor
  const avatar = avatarUri
    ? `<circle cx="${PAD + 22}" cy="${cy}" r="23" fill="#0b0f1c" stroke="${n.c}" stroke-width="1.5"/>
       <image href="${avatarUri}" xlink:href="${avatarUri}" x="${PAD - 1}" y="${cy - 22}" width="46" height="46" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${PAD + 22}" cy="${cy}" r="23" fill="#161b2e" stroke="${n.c}" stroke-width="1.5"/>
       <text x="${PAD + 22}" y="${cy + 7}" font-family="DejaVu Serif" font-size="19" font-weight="bold" fill="${n.c}" text-anchor="middle">BK</text>`;
  const badgeW = n.label.length * 11 + 36;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0c1120"/><stop offset="55%" stop-color="#080b16"/><stop offset="100%" stop-color="#04060d"/>
    </linearGradient>
    <radialGradient id="glow" cx="12%" cy="10%" r="62%">
      <stop offset="0" stop-color="${n.c}" stop-opacity="0.18"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <clipPath id="av"><circle cx="${PAD + 22}" cy="${cy}" r="23"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${dots}

  <!-- left accent rail -->
  <rect x="0" y="0" width="6" height="${H}" fill="${n.c}"/>

  <!-- header: wordmark + niche badge -->
  <text x="${PAD}" y="80" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#f6f3ec" letter-spacing="6">THE SIGNAL</text>
  <rect x="${W - PAD - badgeW}" y="62" width="${badgeW}" height="30" rx="15" fill="none" stroke="${n.c}" stroke-width="1.4"/>
  <circle cx="${W - PAD - badgeW + 18}" cy="77" r="4" fill="${n.c}"/>
  <text x="${W - PAD - 16}" y="82" font-family="DejaVu Sans" font-size="13" font-weight="bold" fill="${n.c}" text-anchor="end" letter-spacing="2">${esc(n.label)}</text>
  <line x1="${PAD}" y1="104" x2="${W - PAD}" y2="104" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>

  ${isQuote ? `<text x="${PAD - 8}" y="${startY - 6}" font-family="DejaVu Serif" font-size="150" font-weight="bold" fill="${n.c}" opacity="0.18">“</text>` : `<rect x="${PAD}" y="${startY - fs2 - 22}" width="58" height="5" rx="2.5" fill="${n.c}"/>`}

  ${headlineSvg}

  ${(sub || "").trim() ? `<text x="${PAD}" y="${startY + lines.length * lh + 26}" font-family="DejaVu Sans" font-size="19" fill="rgba(226,231,244,0.6)">${esc((sub || "").trim().slice(0, 80))}</text>` : ""}

  <!-- byline: avatar + name + emphasized handle (the follow driver) -->
  <line x1="${PAD}" y1="${cy - 44}" x2="${W - PAD}" y2="${cy - 44}" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  ${avatar}
  <text x="${PAD + 60}" y="${cy - 4}" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#f6f3ec">Ben Klein</text>
  <text x="${PAD + 60}" y="${cy + 19}" font-family="DejaVu Sans" font-size="15" font-weight="bold" fill="${GOLD}">@wcgbk</text>
  <text x="${W - PAD}" y="${cy + 8}" font-family="DejaVu Sans" font-size="13" fill="rgba(226,231,244,0.4)" text-anchor="end" letter-spacing="2">FOLLOW FOR DAILY SIGNAL</text>
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
