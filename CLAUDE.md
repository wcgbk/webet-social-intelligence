# WeBetAI - Social Intelligence

## Stack
- Pure HTML/CSS/JS — no framework, no build step
- Font: Geist Sans via Fontsource CDN (jsdelivr) — weights 400/500/600/700
- Hosting: Netlify (site ID: `87d7bcd9-e95a-479c-bc44-6432a2ffc606`, URL: https://webetsocial.com)
- Serverless: Netlify Functions in `netlify/functions/`
- Local dev server: `python3 -m http.server 9988`

## Brand
- Always spell as **WeBetAI** (one word, exact caps). Never "WeBet AI", "We Bet AI", etc.
- Title format: `WeBetAI - Social Intelligence | [Page Title]`

## Design System (from index.html)
All new pages MUST use the homepage design system. Do not invent new color schemes.
- CSS vars are defined in `:root` of index.html — green primary `#87fb89`, white text on dark purple-black bg
- Liquid glass: `.liquid-glass` class with backdrop-filter blur, inset box-shadow, gradient border pseudo-element
- Sections: `.section` with border-top, `.section-inner.centered`, `.section-badge`, `.section-h`, `.section-sub-text`
- Cards: `var(--card-bg)` with `var(--border)`, 16px border-radius
- Fade-in: `.fi` class with IntersectionObserver
- Footer: WeBetAI SVG logo, footer-links, footer-copy

## OG Metadata
Every new HTML page MUST include full Open Graph + Twitter Card meta tags:
- Use `og-image.png` for general pages, `edge-og-image.png` for edge/picks/model pages
- Description should be specific to the page (1-2 sentences)

## QA Rule — Chrome User Testing (MANDATORY)
After every UI change or feature build, user-test the full affected workflow in Chrome using the `mcp__Claude_in_Chrome__*` tools before considering anything done:
1. **Screenshot** the live page after deploy — confirm visually
2. **JS audit** — query DOM state (`getBoundingClientRect`, `getComputedStyle`, `textContent`) to verify elements not visible in screenshots
3. **Functional test** — click through every affected flow (guest → interact → nudge → sign in → authed state → profile → sign out)
4. **Console check** — `read_console_messages` with `onlyErrors: true` — zero errors required
5. **Fix all bugs found** before reporting done — self-optimize until every flow works without friction
6. **Re-test after fix** — deploy → reload → re-verify in Chrome
This is not optional. A feature is not done until it is tested and confirmed working in Chrome.

## Deploy Rules
- **/edge is protected** — NEVER modify or deploy /edge without explicit permission in the current conversation
- **Deploy to /edge/beta only** unless explicitly told to push to production /edge
- **Deploy auth** — only webetbk (Ben Klein) can authorize production deploys

## Daily Picks Pipeline (alpha is PRIMARY as of 2026-06)
- `trigger-picks-alpha.js` — cron `0 13 * * *` (9am ET) → `generate-picks-alpha-background.js`
  (model v10.3-alpha-sharp) → `edge-picks-alpha` blobs → `/api/get-picks-alpha` → /alpha + /dashboard
- `trigger-picks-mvp.js` — cron `0 12 * * *` (8am ET) — A/B test pipeline (v11.1-mvp) → `edge-picks-mvp`
- PAUSED: `trigger-picks` (old prod /edge) and `trigger-picks-beta` — /edge + /edge/beta pages are
  frozen at Jun 5; do not revive or "fix" them without Ben asking
- Support crons: capture-opening-lines 6am ET · verify-picks QA 10:30am ET (audits the ALPHA store)
  · track-clv 3am/1pm/7pm ET (CLV capture + settles results into picks blobs) · self-optimize Sun
- Manual runs must NOT overwrite the 9am scheduled alpha picks once generated for the day.
  Sim mode (`snapshotTime` in the POST body) writes isolated `picks-sim-*` keys and is always safe.
- `netlify.toml` is cron ground truth and is hash-protected by the product loop
  (`PRODUCT-LOOP-BASELINE.sha256` — see PRODUCT-STATE.md before touching anything)

## Model Rules
- Run model against ALL sports with lines — pick highest EV across all leagues
- Sort picks by letter grade (A+ first, B last)
- v10.0 architecture is locked — see memory for immutable core components
- Keep /percentile scorecard in sync with model/pipeline changes
