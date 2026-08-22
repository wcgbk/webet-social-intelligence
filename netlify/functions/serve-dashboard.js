/**
 * serve-dashboard.js — Serve the dashboard with per-panel OG / title meta tags.
 *
 * GET /dashboard?view=<slug>
 *
 * Link-preview crawlers (iMessage, Slack, X, Facebook…) do NOT run JavaScript and
 * never see a URL's #fragment, so a shared /dashboard#nfl link can't unfurl with the
 * panel's name on its own. The deep-link URL therefore carries the panel as a query
 * param (?view=nfl); netlify.toml routes ONLY those requests here (plain /dashboard
 * stays a static file), and this function injects the matching <title> + OG/Twitter
 * tags so the shared card shows the menu item's name. The returned page IS the full
 * dashboard — the client reads ?view and opens that panel.
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://webetsocial.com';

// Shareable slug (and raw panel key, for back-compat) → the menu item's display name.
const VIEW_TITLES = {
  picks: 'Daily Edge Picks',
  nfl: 'NFL Model',
  omega: 'Omega Model',
  gamecast: 'Picks Gamecast',
  'track-record': 'Percentile Rankings', percentile: 'Percentile Rankings',
  pick3: 'Pick 3 PVP', p2p: 'Pick 3 PVP',
  markets: 'Sports Markets', 'p2p-sports': 'Sports Markets',
  challenges: 'Trending Challenges', 'p2p-trending': 'Trending Challenges',
  webit: 'WeBit',
  press: 'Authentic Press', feed: 'Authentic Press',
  leaderboard: 'Pick3 Leaderboard', rankings: 'Pick3 Leaderboard',
  mlb: 'MLB First 5 Picks',
  architecture: 'Track Record & Architecture', arch: 'Track Record & Architecture',
};

// Tailored preview blurbs; anything unlisted falls back to the base dashboard description.
const VIEW_DESC = {
  'NFL Model': 'WeBetAI’s dedicated NFL model — calibrated edges on every NFL game day.',
  'Picks Gamecast': 'Every game on today’s WeBetAI card with its own live ESPN Gamecast.',
  'Daily Edge Picks': 'Today’s WeBetAI edge picks across every league, ranked by expected value.',
  'Percentile Rankings': 'See how WeBetAI ranks against elite betting models.',
  'Pick 3 PVP': 'Pick 3 head-to-head challenges on WeBetAI.',
  'Sports Markets': 'Live sports markets and prices on WeBetAI.',
  'Trending Challenges': 'Trending prediction-market challenges on WeBetAI.',
};

const BASE_DESC = 'WeBetAI Dashboard — Chat with Betty AI, view edge picks, track model performance, and manage your betting intelligence.';

function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const rawView = (q.view || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const menuName = VIEW_TITLES[rawView] || '';

  // 1) Load the dashboard HTML. readFileSync (bundled via included_files) is primary;
  //    the CDN fallback fetches /dashboard/index.html — the RAW file path, which does
  //    NOT match the ?view rewrite, so there's no server-side fetch loop.
  let html = '';
  try { html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf8'); } catch (_) {}
  if (!html || !/<html/i.test(html)) {
    try { html = await (await fetch(`${SITE_URL}/dashboard/index.html`)).text(); } catch (_) { html = ''; }
  }
  if (!html || !/<html/i.test(html)) {
    // Couldn't get the page — bounce to the static dashboard with the panel in the hash
    // so the client still opens the right panel (no blank error for the visitor).
    return { statusCode: 302, headers: { Location: '/dashboard' + (rawView ? '#' + rawView : '') }, body: '' };
  }

  // 2) If it's a known panel, swap in its title/description/url. Unknown view → serve the
  //    default page unchanged (the client ignores an unrecognized view).
  if (menuName) {
    const title = `WeBetAI - Social Intelligence | ${menuName}`;
    const desc = VIEW_DESC[menuName] || BASE_DESC;
    const url = `${SITE_URL}/dashboard?view=${rawView}`;
    html = html
      .split('WeBetAI - Social Intelligence | Dashboard').join(escHtml(title))
      .split(`content="${BASE_DESC}"`).join(`content="${escAttr(desc)}"`)
      .split('content="https://webetsocial.com/dashboard"').join(`content="${escAttr(url)}"`);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    body: html,
  };
};
