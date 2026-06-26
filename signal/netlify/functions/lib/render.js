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
// Brand palette — matched to the WeBetAI logo (deep teal) + WeBit coin (gold) on ivory.
const TEAL = "#15403d";        // primary brand ink / header band
const TEAL_INK = "#143b38";    // headline text
const GOLD = "#bf9a45";        // accent (coin / badge gold)
const MUTE = "#5f6f6a";        // muted teal-gray

// kind: "quote" (large centered serif, quotation marks) | "take" (headline + kicker).
// Bright IVORY card (pops on X's dark feed, stays defined on light), VERTICAL 4:5 (owns mobile
// screen space), deep-teal header band + gold accents (on-brand), big high-contrast serif, and
// the @handle emphasized (the follow driver).
function buildCardSVG({ kind = "quote", niche = "quotes", headline = "", sub = "", avatarUri = null }) {
  const W = 1080, H = 1350;               // 4:5 vertical — maximum feed real estate on mobile
  const PAD = 96, BAND = 116;             // header band height
  const n = NICHE[niche] || NICHE.quotes;
  const isQuote = kind === "quote";

  // Size headline to length — vertical card has room to go BIG.
  const len = String(headline).length;
  const fs2 = len <= 55 ? 80 : len <= 95 ? 68 : len <= 140 ? 58 : len <= 185 ? 50 : 43;
  const cpl = len <= 55 ? 16 : len <= 95 ? 21 : len <= 140 ? 26 : len <= 185 ? 31 : 37;
  const lines = wrapText(headline, cpl, 8);
  const lh = Math.round(fs2 * 1.3);
  const blockH = lines.length * lh;
  const areaTop = 360, areaBot = H - 250;
  const startY = Math.round(areaTop + ((areaBot - areaTop) - blockH) / 2) + Math.round(fs2 * 0.76);

  const headlineSvg = lines.map((ln, i) =>
    `<text x="${PAD}" y="${startY + i * lh}" font-family="DejaVu Serif" font-size="${fs2}" font-weight="bold" fill="${TEAL_INK}">${esc(ln)}</text>`
  ).join("");

  // faint gold circuit motif (top-right) — a nod to the coin's engraving, deterministic + subtle.
  let circuit = "";
  for (const [x1, y1, x2, y2] of [
    [760, 170, 760, 320], [760, 320, 900, 320], [900, 320, 900, 250],
    [840, 200, 1000, 200], [1000, 200, 1000, 300], [820, 360, 980, 360], [980, 360, 980, 280],
  ]) circuit += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${GOLD}" stroke-width="2" opacity="0.10"/>`;
  for (const [cx2, cy2] of [[760, 170], [900, 250], [1000, 300], [980, 280]])
    circuit += `<circle cx="${cx2}" cy="${cy2}" r="4" fill="${GOLD}" opacity="0.12"/>`;

  const cy = H - 110;                      // byline anchor
  const avatar = avatarUri
    ? `<circle cx="${PAD + 26}" cy="${cy}" r="28" fill="#fff" stroke="${GOLD}" stroke-width="2"/>
       <image href="${avatarUri}" xlink:href="${avatarUri}" x="${PAD - 2}" y="${cy - 26}" width="56" height="56" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${PAD + 26}" cy="${cy}" r="28" fill="#e7ece8" stroke="${GOLD}" stroke-width="2"/>
       <text x="${PAD + 26}" y="${cy + 8}" font-family="DejaVu Serif" font-size="22" font-weight="bold" fill="${TEAL}" text-anchor="middle">BK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#f7f4ec"/><stop offset="100%" stop-color="#eef0ea"/>
    </linearGradient>
    <clipPath id="av"><circle cx="${PAD + 26}" cy="${cy}" r="28"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${circuit}
  <!-- subtle teal frame for edge definition on a light feed -->
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${TEAL}" stroke-opacity="0.12" stroke-width="2"/>

  <!-- deep-teal header band (brand) + gold rule -->
  <rect x="0" y="0" width="${W}" height="${BAND}" fill="${TEAL}"/>
  <rect x="0" y="${BAND}" width="${W}" height="4" fill="${GOLD}"/>
  <text x="${PAD}" y="73" font-family="DejaVu Sans" font-size="25" font-weight="bold" fill="#f4f1e6" letter-spacing="7">THE SIGNAL</text>
  <circle cx="${W - PAD - (n.label.length * 14 + 22)}" cy="65" r="5" fill="${GOLD}"/>
  <text x="${W - PAD}" y="71" font-family="DejaVu Sans" font-size="17" font-weight="bold" fill="${GOLD}" text-anchor="end" letter-spacing="3">${esc(n.label)}</text>

  ${isQuote
    ? `<text x="${PAD - 12}" y="${startY - 18}" font-family="DejaVu Serif" font-size="190" font-weight="bold" fill="${GOLD}" opacity="0.28">“</text>`
    : `<rect x="${PAD}" y="${startY - fs2 - 30}" width="76" height="7" rx="3.5" fill="${GOLD}"/>`}

  ${headlineSvg}

  ${(sub || "").trim() ? `<text x="${PAD}" y="${startY + lines.length * lh + 34}" font-family="DejaVu Sans" font-size="26" fill="${MUTE}">${esc((sub || "").trim().slice(0, 60))}</text>` : ""}

  <!-- byline: avatar + name + emphasized handle -->
  <line x1="${PAD}" y1="${cy - 56}" x2="${W - PAD}" y2="${cy - 56}" stroke="${TEAL}" stroke-opacity="0.14" stroke-width="1.5"/>
  ${avatar}
  <text x="${PAD + 72}" y="${cy - 5}" font-family="DejaVu Sans" font-size="25" font-weight="bold" fill="${TEAL_INK}">Ben Klein</text>
  <text x="${PAD + 72}" y="${cy + 26}" font-family="DejaVu Sans" font-size="20" font-weight="bold" fill="${GOLD}">@wcgbk</text>
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
