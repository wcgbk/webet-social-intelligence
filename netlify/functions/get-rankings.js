// Fetch live rankings from PickHoops using stored session cookie
const https = require('https');

function fetchPage(url, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };
    https.get(url, opts, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.pickhoops.com${res.headers.location}`;
        return fetchPage(redirectUrl, cookie).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseRankings(html) {
  // Look for "Ben Klein" entries in the standings/brackets table
  // PickHoops server-renders tables with rank, name, points, etc.
  const results = {};

  // Match table rows containing "Ben Klein"
  // Pattern: look for rows with rank, name, points data
  const rowRegex = /<tr[^>]*>[\s\S]*?Ben Klein[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    // Extract all cell contents
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = cellRegex.exec(row)) !== null) {
      cells.push(match[1].replace(/<[^>]+>/g, '').trim());
    }

    // Determine if this is Michigan or Florida bracket
    const rowText = row.toLowerCase();
    let bracketKey = null;
    if (rowText.includes('michigan')) bracketKey = 'michigan';
    else if (rowText.includes('florida')) bracketKey = 'florida';

    if (bracketKey && cells.length >= 2) {
      // Try to extract rank and points from cells
      // Typical order: rank, name, points, possible_points, correct, possible_games
      const numbers = cells.map(c => parseInt(c.replace(/,/g, ''), 10)).filter(n => !isNaN(n));

      if (numbers.length >= 1) {
        results[bracketKey] = {
          name: cells.find(c => c.includes('Ben Klein')) || `Ben Klein - ${bracketKey}`,
          rank: numbers[0],  // First number is usually rank
          points: numbers.length > 1 ? numbers[1] : 0,
          possiblePoints: numbers.length > 2 ? numbers[2] : 0,
          correct: numbers.length > 3 ? numbers[3] : numbers.length > 1 ? numbers[1] : 0,
          possibleGames: numbers.length > 4 ? numbers[4] : 0,
        };
      }
    }
  }

  return results;
}

// Also try a more flexible pattern matching approach
function parseRankingsFlexible(html) {
  const results = {};

  // Look for "Ranked Xth with Y points" pattern near "Ben Klein"
  // From the screenshot: "Ben Klein - Michigan    Ranked 43rd with 28 points"
  const patterns = [
    /Ben Klein\s*-\s*Michigan[\s\S]*?Ranked\s+(\d+)\w*\s+with\s+(\d+)\s+point/i,
    /Ben Klein\s*-\s*Florida[\s\S]*?Ranked\s+(\d+)\w*\s+with\s+(\d+)\s+point/i,
  ];

  const miMatch = html.match(patterns[0]);
  if (miMatch) {
    results.michigan = {
      name: 'Ben Klein - Michigan',
      rank: parseInt(miMatch[1], 10),
      points: parseInt(miMatch[2], 10),
      correct: parseInt(miMatch[2], 10),
    };
  }

  const flMatch = html.match(patterns[1]);
  if (flMatch) {
    results.florida = {
      name: 'Ben Klein - Florida',
      rank: parseInt(flMatch[1], 10),
      points: parseInt(flMatch[2], 10),
      correct: parseInt(flMatch[2], 10),
    };
  }

  // Try to get total entries count
  const totalMatch = html.match(/of\s+(\d[\d,]*)\s+bracket/i) ||
                     html.match(/(\d[\d,]*)\s+total\s+bracket/i) ||
                     html.match(/(\d[\d,]*)\s+entries/i);
  if (totalMatch) {
    results.totalEntries = parseInt(totalMatch[1].replace(/,/g, ''), 10);
  }

  return results;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, max-age=0',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const cookie = process.env.PICKHOOPS_COOKIE;
  if (!cookie) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: 'No PICKHOOPS_COOKIE env var set', fallback: true })
    };
  }

  try {
    const html = await fetchPage('https://www.pickhoops.com/pete/group', cookie);

    // Check if we got redirected to login
    if (html.includes('Login') && !html.includes('Ben Klein') && html.length < 20000) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          error: 'Session expired — cookie needs refresh',
          htmlLength: html.length,
          fallback: true,
        })
      };
    }

    // Try both parsing approaches
    let rankings = parseRankings(html);
    if (!rankings.michigan && !rankings.florida) {
      rankings = parseRankingsFlexible(html);
    }

    if (!rankings.michigan && !rankings.florida) {
      // Debug: return a snippet of the HTML to help diagnose
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          error: 'Could not parse rankings from page',
          htmlLength: html.length,
          // Return a sanitized snippet around "Ben Klein" if found
          snippet: html.includes('Ben Klein')
            ? html.substring(html.indexOf('Ben Klein') - 200, html.indexOf('Ben Klein') + 400).replace(/</g, '&lt;')
            : 'Ben Klein not found in page',
          fallback: true,
        })
      };
    }

    const result = {
      ...rankings,
      totalEntries: rankings.totalEntries || 3214,
      updatedAt: new Date().toISOString(),
      source: 'pickhoops-live',
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: err.message, fallback: true })
    };
  }
};
