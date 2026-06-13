// voicebet-tts.js — xAI Grok TTS proxy for VoiceBet
// POST /api/voicebet-tts { text, voice }
// Returns audio/wav stream from xAI TTS API

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  const XAI_API_KEY = process.env.XAI_API_KEY;
  if (!XAI_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'XAI_API_KEY not configured' }) };
  }

  try {
    const { text, voice = 'eve' } = JSON.parse(event.body || '{}');
    if (!text || text.length > 2000) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text required (max 2000 chars)' }) };
    }

    const res = await fetch('https://api.x.ai/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3-tts',
        input: text,
        voice: voice,
        response_format: 'wav',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('xAI TTS error:', res.status, err);
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'TTS failed' }) };
    }

    const audioBuffer = await res.arrayBuffer();

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-cache',
      },
      body: Buffer.from(audioBuffer).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('voicebet-tts error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
