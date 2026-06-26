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
// Saturated accents that POP on a light card against X's dark feed (warm hues catch the eye).
const LIGHT_ACCENT = {
  politics: "#b5471f", startups: "#0f8a78", vc: "#6a4fb0", economy: "#2f6fa0",
  crypto: "#bf8418", "personal-development": "#2e8a4f", quotes: "#b07d2e",
};

// kind: "quote" (large centered serif, quotation marks) | "take" (headline + kicker).
// Research-tuned for X reach: BRIGHT warm-cream card (stands out vs X's black feed — dark cards
// blend in), VERTICAL 4:5 (owns more mobile screen space), huge high-contrast type, bold warm
// accent, and the @handle emphasized (the follow driver).
function buildCardSVG({ kind = "quote", niche = "quotes", headline = "", sub = "", avatarUri = null }) {
  const W = 1080, H = 1350;               // 4:5 vertical — maximum feed real estate on mobile
  const PAD = 96;
  const n = NICHE[niche] || NICHE.quotes;
  const accent = LIGHT_ACCENT[niche] || LIGHT_ACCENT.quotes;
  const INK = "#17130c", MUTE = "#7a7060";
  const isQuote = kind === "quote";

  // Size headline to length — vertical card has room to go BIG.
  const len = String(headline).length;
  const fs2 = len <= 55 ? 80 : len <= 95 ? 68 : len <= 140 ? 58 : len <= 185 ? 50 : 43;
  const cpl = len <= 55 ? 18 : len <= 95 ? 23 : len <= 140 ? 28 : len <= 185 ? 33 : 39;
  const lines = wrapText(headline, cpl, 8);
  const lh = Math.round(fs2 * 1.3);
  const blockH = lines.length * lh;
  const areaTop = 320, areaBot = H - 250;
  const startY = Math.round(areaTop + ((areaBot - areaTop) - blockH) / 2) + Math.round(fs2 * 0.76);

  const headlineSvg = lines.map((ln, i) =>
    `<text x="${PAD}" y="${startY + i * lh}" font-family="DejaVu Serif" font-size="${fs2}" font-weight="bold" fill="${INK}">${esc(ln)}</text>`
  ).join("");

  const cy = H - 110;                      // byline anchor
  const avatar = avatarUri
    ? `<circle cx="${PAD + 26}" cy="${cy}" r="28" fill="#fff" stroke="${accent}" stroke-width="2"/>
       <image href="${avatarUri}" xlink:href="${avatarUri}" x="${PAD - 2}" y="${cy - 26}" width="56" height="56" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${PAD + 26}" cy="${cy}" r="28" fill="#efe7d6" stroke="${accent}" stroke-width="2"/>
       <text x="${PAD + 26}" y="${cy + 8}" font-family="DejaVu Serif" font-size="22" font-weight="bold" fill="${accent}" text-anchor="middle">BK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#faf6ec"/><stop offset="100%" stop-color="#f1e8d6"/>
    </linearGradient>
    <radialGradient id="glow" cx="88%" cy="6%" r="55%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.10"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <clipPath id="av"><circle cx="${PAD + 26}" cy="${cy}" r="28"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- bold accent bar across the top -->
  <rect x="0" y="0" width="${W}" height="12" fill="${accent}"/>
  <!-- thin inner border for edge definition on a bright feed -->
  <rect x="6" y="18" width="${W - 12}" height="${H - 24}" fill="none" stroke="#000000" stroke-opacity="0.06" stroke-width="2"/>

  <!-- header: wordmark + niche label -->
  <text x="${PAD}" y="118" font-family="DejaVu Sans" font-size="24" font-weight="bold" fill="${INK}" letter-spacing="7">THE SIGNAL</text>
  <circle cx="${W - PAD - (n.label.length * 14 + 22)}" cy="110" r="5" fill="${accent}"/>
  <text x="${W - PAD}" y="116" font-family="DejaVu Sans" font-size="17" font-weight="bold" fill="${accent}" text-anchor="end" letter-spacing="3">${esc(n.label)}</text>
  <line x1="${PAD}" y1="150" x2="${W - PAD}" y2="150" stroke="${INK}" stroke-opacity="0.12" stroke-width="1.5"/>

  ${isQuote
    ? `<text x="${PAD - 12}" y="${startY - 18}" font-family="DejaVu Serif" font-size="190" font-weight="bold" fill="${accent}" opacity="0.22">“</text>`
    : `<rect x="${PAD}" y="${startY - fs2 - 30}" width="76" height="7" rx="3.5" fill="${accent}"/>`}

  ${headlineSvg}

  ${(sub || "").trim() ? `<text x="${PAD}" y="${startY + lines.length * lh + 34}" font-family="DejaVu Sans" font-size="26" fill="${MUTE}">${esc((sub || "").trim().slice(0, 60))}</text>` : ""}

  <!-- byline: avatar + name + emphasized handle -->
  <line x1="${PAD}" y1="${cy - 56}" x2="${W - PAD}" y2="${cy - 56}" stroke="${INK}" stroke-opacity="0.12" stroke-width="1.5"/>
  ${avatar}
  <text x="${PAD + 72}" y="${cy - 5}" font-family="DejaVu Sans" font-size="25" font-weight="bold" fill="${INK}">Ben Klein</text>
  <text x="${PAD + 72}" y="${cy + 26}" font-family="DejaVu Sans" font-size="20" font-weight="bold" fill="${accent}">@wcgbk</text>
  <text x="${W - PAD}" y="${cy + 12}" font-family="DejaVu Sans" font-size="16" font-weight="bold" fill="${MUTE}" text-anchor="end" letter-spacing="2">FOLLOW FOR DAILY SIGNAL</text>
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
