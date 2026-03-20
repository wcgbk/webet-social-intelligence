import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { messages, apiKey } = await req.json();

  const grokKey = apiKey || process.env.GROK_API_KEY;
  if (!grokKey) {
    return Response.json({ error: "Grok API key not configured" }, { status: 400 });
  }

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${grokKey}`,
    },
    body: JSON.stringify({
      model: "grok-3",
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    return Response.json({ error: `Grok API error: ${error}` }, { status: response.status });
  }

  // Stream the response back
  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
