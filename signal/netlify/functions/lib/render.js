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
function buildCardSVG({ kind = "take", niche = "quotes", headline = "", sub = "", avatarUri = null }) {
  const W = 1200, H = 675;
  const n = NICHE[niche] || NICHE.quotes;
  const isQuote = kind === "quote";

  // Size the headline to its length so short lines read big, long ones still fit.
  const len = String(headline).length;
  const fs2 = len <= 70 ? 56 : len <= 120 ? 46 : len <= 180 ? 39 : 33;
  const cpl = len <= 70 ? 24 : len <= 120 ? 30 : len <= 180 ? 36 : 42;
  const lines = wrapText(headline, cpl, 7);
  const lh = Math.round(fs2 * 1.22);
  const blockH = lines.length * lh;
  const startY = Math.round((H - blockH) / 2) + fs2 - 6 + (isQuote ? 6 : 0);
  const fontFam = isQuote ? "DejaVu Serif" : "DejaVu Serif";

  const headlineSvg = lines.map((ln, i) =>
    `<text x="84" y="${startY + i * lh}" font-family="${fontFam}" font-size="${fs2}" font-weight="bold" fill="#f4f1ea">${esc(ln)}</text>`
  ).join("");

  // deterministic faint grid of dots for texture (no randomness — resume-safe)
  let dots = "";
  for (let i = 0; i < 90; i++) {
    const x = (i * 211 + 30) % W;
    const y = (i * 97 + 40) % H;
    const o = (0.03 + ((i * 17) % 40) / 1000).toFixed(3);
    dots += `<circle cx="${x}" cy="${y}" r="1.1" fill="#ffffff" opacity="${o}"/>`;
  }

  const sub2 = (sub || "").trim();
  const avatar = avatarUri
    ? `<circle cx="116" cy="${H - 58}" r="22" fill="#0b0f1c" stroke="${GOLD}" stroke-width="1.5"/>
       <image href="${avatarUri}" xlink:href="${avatarUri}" x="94" y="${H - 80}" width="44" height="44" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="116" cy="${H - 58}" r="22" fill="#161b2e" stroke="${GOLD}" stroke-width="1.5"/>
       <text x="116" y="${H - 51}" font-family="DejaVu Serif" font-size="18" font-weight="bold" fill="${GOLD}" text-anchor="middle">BK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0c1120"/><stop offset="55%" stop-color="#080b16"/><stop offset="100%" stop-color="#04060d"/>
    </linearGradient>
    <radialGradient id="glow" cx="14%" cy="12%" r="60%">
      <stop offset="0" stop-color="${n.c}" stop-opacity="0.16"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <clipPath id="av"><circle cx="116" cy="${H - 58}" r="22"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${dots}

  <!-- left accent rail -->
  <rect x="0" y="0" width="6" height="${H}" fill="${n.c}"/>

  <!-- header: wordmark + niche badge -->
  <text x="84" y="78" font-family="DejaVu Sans" font-size="20" font-weight="bold" fill="#f4f1ea" letter-spacing="4">THE SIGNAL</text>
  <text x="84" y="100" font-family="DejaVu Sans" font-size="12" fill="rgba(220,225,240,0.45)" letter-spacing="2">BY BEN KLEIN</text>
  <rect x="${W - 84 - (n.label.length * 11 + 34)}" y="58" width="${n.label.length * 11 + 34}" height="30" rx="15" fill="none" stroke="${n.c}" stroke-width="1.4"/>
  <circle cx="${W - 84 - (n.label.length * 11 + 34) + 18}" cy="73" r="4" fill="${n.c}"/>
  <text x="${W - 84 - 16}" y="78" font-family="DejaVu Sans" font-size="13" font-weight="bold" fill="${n.c}" text-anchor="end" letter-spacing="2">${esc(n.label)}</text>

  ${isQuote ? `<text x="70" y="${startY - lh}" font-family="DejaVu Serif" font-size="120" font-weight="bold" fill="${n.c}" opacity="0.22">“</text>` : `<rect x="84" y="${startY - fs2 - 24}" width="56" height="5" rx="2.5" fill="${n.c}"/>`}

  ${headlineSvg}

  ${sub2 ? `<text x="84" y="${startY + lines.length * lh + 30}" font-family="DejaVu Sans" font-size="19" fill="rgba(220,225,240,0.62)">${esc(sub2.slice(0, 78))}</text>` : ""}

  <!-- byline -->
  ${avatar}
  <text x="150" y="${H - 64}" font-family="DejaVu Sans" font-size="18" font-weight="bold" fill="#f4f1ea">Ben Klein</text>
  <text x="150" y="${H - 44}" font-family="DejaVu Sans" font-size="14" fill="${GOLD}">@wcgbk · worldclassgrowth.com</text>
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
