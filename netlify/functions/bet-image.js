/**
 * bet-image.js — Generate OG preview image for a bet as PNG
 *
 * GET /api/bet-image?id=XXXXX
 *
 * Uses Satori (font-bundled SVG renderer) + Sharp (SVG→PNG).
 * Satori converts text to paths — no system fonts needed.
 * Returns a 640x848 PNG matching the mobile bet card layout.
 */

const sharp = require('sharp');
const INTER_BOLD = require('./inter-bold-font');

const PNG_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=3600',
};

async function generateBetImage(bet) {
  const satori = (await import('satori')).default;

  const title = bet.title || 'Untitled Bet';
  const category = (bet.category || 'media').toUpperCase();
  const status = (bet.status || 'open').toUpperCase();
  const amount = bet.amount || 1;
  const betString = bet.betString || `@AP WeBet $${amount} ${title}`;
  const createdBy = bet.createdBy || '@AP';
  const yesProb = bet.options?.[0]?.probability || 50;
  const noProb = bet.options?.[1]?.probability || (100 - yesProb);
  const pool = bet.totalPool || 0;
  const participants = bet.participantCount || 0;
  const yesPct = `${Math.round((yesProb / 100) * 100)}%`;
  const noPct = `${Math.round((noProb / 100) * 100)}%`;

  const W = 640, H = 848;

  // Satori uses a React-like element tree: { type, props, children }
  const h = (type, props, ...children) => ({
    type,
    props: { ...props, children: children.length === 1 ? children[0] : children.length ? children : undefined },
  });

  const tree = h('div', { style: { display: 'flex', flexDirection: 'column', width: W, height: H, background: '#f8f9fa', fontFamily: 'Inter' } },
    // Header
    h('div', { style: { display: 'flex', alignItems: 'center', height: 65, background: '#fff', padding: '0 28px', gap: 12 } },
      h('span', { style: { fontSize: 28, fontWeight: 700, color: '#1a2e1a' } }, 'WeBetAI'),
      h('span', { style: { fontSize: 12, fontWeight: 700, color: '#004C54', background: '#e6f4f1', border: '1px solid #b8ddd6', borderRadius: 14, padding: '4px 14px' } }, 'BET'),
    ),
    // Card
    h('div', { style: { display: 'flex', flexDirection: 'column', margin: '17px 20px', background: '#fff', borderRadius: 16, border: '1.5px solid #e0e3e8', flex: 1, padding: '22px 25px' } },
      // Category + OPEN
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
        h('span', { style: { fontSize: 16, fontWeight: 700, color: '#8b95a3' } }, category),
        h('span', { style: { fontSize: 13, fontWeight: 700, color: '#10b981', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 16, padding: '5px 18px' } }, status),
      ),
      // Divider
      h('div', { style: { display: 'flex', width: '100%', height: 1, background: '#e8eae9', marginBottom: 18 } }),
      // Title
      h('div', { style: { fontSize: 32, fontWeight: 700, color: '#1a2e1a', lineHeight: 1.2, marginBottom: 10 } }, title),
      // Subtitle
      h('div', { style: { fontSize: 16, color: '#8b95a3', marginBottom: 24 } }, 'Peer-to-peer bet'),
      // Odds bar
      h('div', { style: { display: 'flex', width: '100%', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 10 } },
        h('div', { style: { width: yesPct, height: '100%', background: '#10b981' } }),
        h('div', { style: { width: noPct, height: '100%', background: '#fecaca' } }),
      ),
      // Odds labels
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 18 } },
        h('span', { style: { fontSize: 20, fontWeight: 700, color: '#10b981' } }, `YES ${yesProb}%`),
        h('span', { style: { fontSize: 20, fontWeight: 700, color: '#ef4444' } }, `NO ${noProb}%`),
      ),
      // YES / NO buttons
      h('div', { style: { display: 'flex', gap: 15, marginBottom: 20 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, height: 90, borderRadius: 14, border: '1.5px solid #e0e3e8' } },
          h('span', { style: { fontSize: 28, fontWeight: 700, color: '#10b981' } }, 'YES'),
          h('span', { style: { fontSize: 15, color: '#8b95a3' } }, `$${amount}`),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, height: 90, borderRadius: 14, border: '1.5px solid #e0e3e8' } },
          h('span', { style: { fontSize: 28, fontWeight: 700, color: '#ef4444' } }, 'NO'),
          h('span', { style: { fontSize: 15, color: '#8b95a3' } }, `$${amount}`),
        ),
      ),
      // Divider
      h('div', { style: { display: 'flex', width: '100%', height: 1, background: '#e8eae9', marginBottom: 16 } }),
      // BET STRING
      h('div', { style: { fontSize: 12, fontWeight: 700, color: '#8b95a3', letterSpacing: 1.5, marginBottom: 10 } }, 'BET STRING'),
      h('div', { style: { display: 'flex', background: '#f8f9fa', border: '1px solid #e0e3e8', borderRadius: 12, padding: '14px 16px', marginBottom: 16 } },
        h('span', { style: { fontSize: 18, fontWeight: 700, color: '#1a2e1a', lineHeight: 1.4 } }, betString),
      ),
      // Divider
      h('div', { style: { display: 'flex', width: '100%', height: 1, background: '#e8eae9', marginBottom: 16 } }),
      // Footer stats
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('span', { style: { fontSize: 16 } },
            h('span', { style: { fontWeight: 700, color: '#1a2e1a' } }, `$${pool}`),
            h('span', { style: { color: '#8b95a3' } }, ' in the'),
          ),
          h('span', { style: { fontSize: 16, color: '#8b95a3' } }, 'pot'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('span', { style: { fontSize: 16 } },
            h('span', { style: { fontWeight: 700, color: '#1a2e1a' } }, `${participants}`),
            h('span', { style: { color: '#8b95a3' } }, ' people'),
          ),
          h('span', { style: { fontSize: 16, color: '#8b95a3' } }, 'betting'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('span', { style: { fontSize: 16, color: '#8b95a3' } }, 'Started by'),
          h('span', { style: { fontSize: 16, fontWeight: 700, color: '#1a2e1a' } }, createdBy),
        ),
      ),
    ),
  );

  const svg = await satori(tree, {
    width: W,
    height: H,
    fonts: [{
      name: 'Inter',
      data: INTER_BOLD,
      weight: 700,
      style: 'normal',
    }],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const betId = (event.queryStringParameters || {}).id;
  if (!betId) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Bet ID required' };
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-bets', siteID, token });
    const bet = await store.get(`bet-${betId}`, { type: 'json' });

    if (!bet) {
      return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Bet not found' };
    }

    const pngBuffer = await generateBetImage(bet);

    return {
      statusCode: 200,
      headers: PNG_HEADERS,
      body: pngBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[bet-image] Error:', err.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Error: ' + err.message };
  }
};
