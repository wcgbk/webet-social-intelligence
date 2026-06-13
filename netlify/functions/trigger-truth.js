/**
 * trigger-truth.js — Scheduled trigger for Authentic Press content generation
 *
 * Runs every 2 hours (defined in netlify.toml).
 * Invokes the background worker to generate stories + reply drafts.
 */

exports.handler = async (event) => {
  console.log('=== Authentic Press scheduled trigger ===');

  try {
    const siteUrl = process.env.URL || 'https://webetsocial.com';
    const res = await fetch(`${siteUrl}/.netlify/functions/generate-truth-content-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'scheduled', ts: Date.now() }),
    });

    console.log('Background function invoked, status:', res.status);
    return { statusCode: 200, body: JSON.stringify({ triggered: true }) };
  } catch (err) {
    console.error('Trigger failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
