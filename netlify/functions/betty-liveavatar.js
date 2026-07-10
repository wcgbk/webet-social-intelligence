// Betty LiveAvatar — proxy for LiveAvatar embed API
// Keeps API key server-side, returns iframe embed URL

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 });
  }

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'LiveAvatar API key not configured' }), { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const BETTY_CONTEXT_ID = process.env.BETTY_CONTEXT_ID || '15b3c729-9a08-4b4e-ba4e-74391d6fa1f5';
  const BETTY_LLM_CONFIG_ID = process.env.BETTY_LLM_CONFIG_ID || '88474133-a0a4-4461-9ac0-1fb5780c78c4'; // Grok-3 via xAI

  // Avatar/voice are env-driven so the real Betty avatar (created in the LiveAvatar
  // dashboard) can go live by setting BETTY_AVATAR_ID in Netlify — no code redeploy.
  // Falls back to the Ann Therapist stock avatar until BETTY_AVATAR_ID is set.
  const BETTY_AVATAR_ID = process.env.BETTY_AVATAR_ID || '513fd1b7-7ef9-466d-9af2-344e51eeb833';
  const BETTY_VOICE_ID = process.env.BETTY_VOICE_ID || 'de5574fc-009e-4a01-a881-9919ef8f5a0c'; // Ann - IA (female)

  const payload = {
    avatar_id: body.avatar_id || BETTY_AVATAR_ID,
    context_id: BETTY_CONTEXT_ID,
    llm_configuration_id: BETTY_LLM_CONFIG_ID,
    voice_id: body.voice_id || BETTY_VOICE_ID,
    is_sandbox: false, // sandbox embeds error on "Chat now" — use live mode (credits consumed)
    default_language: 'en',
    max_session_duration: body.max_duration || 600, // 10 min default to conserve credits
  };

  try {
    const res = await fetch('https://api.liveavatar.com/v2/embeddings', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: '/api/betty-liveavatar',
};
