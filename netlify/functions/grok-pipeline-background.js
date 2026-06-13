// grok-pipeline-background.js
// Cloud pipeline: Grok Voice transcript → Claude distills → Claude generates code → deploys to Netlify
// "-background" suffix = Netlify background function (returns 202 immediately, runs up to 15min)
//
// POST /api/grok-pipeline-background
// Headers: Authorization: Bearer <PIPELINE_SECRET>
// Body: { "transcript": "full conversation text..." }
//   or: { "url": "https://grok.com/share/..." }

const crypto = require("crypto");

const SITE_ID = "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// Project design system — embedded so Claude generates on-brand code
const PROJECT_CONTEXT = `
You are building for the WeBetAI Social Intelligence platform at webetsocial.com.

DESIGN SYSTEM (use these EXACTLY):
- Font: Geist Sans via CDN: <link href="https://cdn.jsdelivr.net/fontsource/fonts/geist-sans@latest/latin.css" rel="stylesheet">
- Background: hsl(260, 87%, 3%) — near-black purple
- Foreground text: hsl(40, 6%, 95%)
- Primary accent: hsl(121, 95%, 76%) — bright green #87FB89
- Primary foreground (text on green): hsl(0, 0%, 5%)
- Muted: hsl(240, 4%, 16%)
- Border: hsl(240, 4%, 20%)

LIQUID GLASS PATTERN (use for cards/panels):
.liquid-glass {
  background: rgba(255,255,255,0.01);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border-radius: 16px;
  box-shadow: inset 0 1px 1px rgba(255,255,255,0.1);
  position: relative;
}
.liquid-glass::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1.4px;
  background: linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.02) 100%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

STACK: Pure HTML + CSS + vanilla JS. No frameworks, no build step. Each page is a standalone .html file.
Responsive: mobile-first, works on all screen sizes.
All pages should include a link back to the main site (/) in the nav.

BACKGROUND VIDEO (optional, for hero sections):
<video autoplay loop muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.15;pointer-events:none;">
  <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260309_042944_4a2205b7-b061-490a-852b-92d9e9955ce9.mp4" type="video/mp4">
</video>
`;

// ── Fetch Grok transcript from a share URL ──
async function fetchGrokTranscript(url) {
  console.log("[pipeline] Fetching Grok share page:", url);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // Try to extract conversation from embedded JSON (Next.js __NEXT_DATA__ or similar)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const messages = findMessages(data);
        if (messages && messages.length > 0) {
          return messages.map(m => `${m.role || "unknown"}: ${m.content || m.text || ""}`).join("\n\n");
        }
      } catch (e) { /* continue to other methods */ }
    }

    // Try to extract from any JSON blob in script tags
    const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
    for (const match of scriptMatches) {
      const content = match[1];
      if (content.includes('"messages"') || content.includes('"conversation"')) {
        try {
          // Look for JSON objects with messages
          const jsonMatch = content.match(/\{[\s\S]*"messages"[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            const messages = findMessages(data);
            if (messages && messages.length > 0) {
              return messages.map(m => `${m.role || "unknown"}: ${m.content || m.text || ""}`).join("\n\n");
            }
          }
        } catch (e) { /* continue */ }
      }
    }

    // Fallback: extract visible text content (strip HTML tags)
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (textContent.length > 200) {
      return textContent;
    }

    throw new Error("Could not extract conversation from page");
  } catch (err) {
    console.error("[pipeline] Grok fetch error:", err.message);
    throw err;
  }
}

// Recursively find a "messages" array in nested data
function findMessages(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.messages) && obj.messages.length > 0) return obj.messages;
  if (Array.isArray(obj.conversation) && obj.conversation.length > 0) return obj.conversation;
  for (const key of Object.keys(obj)) {
    const result = findMessages(obj[key]);
    if (result) return result;
  }
  return null;
}

// ── Call Claude API ──
async function callClaude(systemPrompt, userMessage, apiKey) {
  console.log("[pipeline] Calling Claude API...");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API ${response.status}: ${errText.substring(0, 500)}`);
  }

  const result = await response.json();
  let text = "";
  for (const block of result.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

// ── Get current deployed files from Netlify ──
async function getCurrentDeployFiles(netlifyToken) {
  console.log("[pipeline] Fetching current deploy files...");
  // Get site info to find the published deploy
  const siteResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}`, {
    headers: { Authorization: `Bearer ${netlifyToken}` },
  });
  if (!siteResp.ok) throw new Error(`Netlify site fetch failed: ${siteResp.status}`);
  const siteData = await siteResp.json();

  const deployId = siteData.published_deploy?.id;
  if (!deployId) throw new Error("No published deploy found");

  // Get file list from current deploy
  const filesResp = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/files`, {
    headers: { Authorization: `Bearer ${netlifyToken}` },
  });
  if (!filesResp.ok) throw new Error(`Netlify files fetch failed: ${filesResp.status}`);
  const fileList = await filesResp.json();

  // Build map of path → sha1
  const files = {};
  for (const f of fileList) {
    files[f.path] = f.sha;
  }
  console.log(`[pipeline] Current deploy has ${Object.keys(files).length} files`);
  return files;
}

// ── Deploy to Netlify ──
async function deployToNetlify(existingFiles, newFiles, netlifyToken) {
  console.log(`[pipeline] Deploying ${Object.keys(newFiles).length} new/updated files...`);

  // Merge existing files with new files (new files override existing)
  const mergedFiles = { ...existingFiles };
  const newFileContents = {};

  for (const [path, content] of Object.entries(newFiles)) {
    const normalizedPath = path.startsWith("/") ? path : "/" + path;
    const sha = crypto.createHash("sha1").update(content).digest("hex");
    mergedFiles[normalizedPath] = sha;
    newFileContents[normalizedPath] = content;
  }

  // Create the deploy
  const deployResp = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${netlifyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: mergedFiles,
      draft: false,
    }),
  });

  if (!deployResp.ok) {
    const errText = await deployResp.text();
    throw new Error(`Deploy create failed ${deployResp.status}: ${errText.substring(0, 500)}`);
  }

  const deployData = await deployResp.json();
  const deployId = deployData.id;
  const required = deployData.required || [];

  console.log(`[pipeline] Deploy ${deployId} created. ${required.length} files need uploading.`);

  // Upload required files
  for (const sha of required) {
    // Find which file has this SHA
    const filePath = Object.keys(newFileContents).find(
      (p) => crypto.createHash("sha1").update(newFileContents[p]).digest("hex") === sha
    );

    if (filePath) {
      console.log(`[pipeline] Uploading ${filePath}...`);
      const uploadResp = await fetch(
        `https://api.netlify.com/api/v1/deploys/${deployId}/files${filePath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${netlifyToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: newFileContents[filePath],
        }
      );
      if (!uploadResp.ok) {
        console.error(`[pipeline] Upload failed for ${filePath}: ${uploadResp.status}`);
      }
    }
  }

  console.log(`[pipeline] Deploy ${deployId} complete.`);
  return {
    deployId,
    url: deployData.ssl_url || deployData.url || `https://webetsocial.com`,
    adminUrl: deployData.admin_url,
  };
}

// ── Main handler ──
exports.handler = async (event) => {
  console.log("[pipeline] Background function started");

  // ── Auth ──
  const secret = process.env.PIPELINE_SECRET;
  if (secret) {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token !== secret) {
      console.error("[pipeline] Unauthorized request");
      return { statusCode: 401, body: "Unauthorized" };
    }
  }

  // ── Required env vars ──
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, body: "Missing ANTHROPIC_API_KEY" };
  if (!NETLIFY_AUTH_TOKEN) return { statusCode: 500, body: "Missing NETLIFY_AUTH_TOKEN" };

  // ── Parse input ──
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  let transcript = body.transcript || "";
  const grokUrl = body.url || "";

  // If URL provided but no transcript, try to fetch it
  if (!transcript && grokUrl) {
    try {
      transcript = await fetchGrokTranscript(grokUrl);
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Could not fetch Grok transcript from URL. Send the transcript text directly instead.",
          detail: err.message,
        }),
      };
    }
  }

  if (!transcript || transcript.length < 50) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Transcript too short or missing. Send { transcript: '...' } or { url: '...' }" }),
    };
  }

  console.log(`[pipeline] Transcript received: ${transcript.length} chars`);

  try {
    // ── Step 1: Distill transcript → structured requirements + generate code ──
    const systemPrompt = `You are a senior full-stack developer and technical architect.

You will receive a conversation transcript between a user and an AI (Grok). Your job:
1. Identify the FINAL agreed-upon plan from the conversation. Ignore earlier drafts — look for phrases like "actually let's", "scratch that", "no instead", "final version".
2. Generate complete, production-ready code files that implement the plan.

${PROJECT_CONTEXT}

OUTPUT FORMAT — respond with ONLY valid JSON (no markdown fences, no extra text):
{
  "summary": "One-line description of what was built",
  "base_path": "/feature-name",
  "files": {
    "/feature-name/index.html": "<!DOCTYPE html>\\n<html>... complete file content ...",
    "/feature-name/other.js": "// complete file content..."
  },
  "redirect_from": "/feature-name",
  "redirect_to": "/feature-name/index.html"
}

RULES:
- Every HTML file must be COMPLETE and standalone (full <!DOCTYPE html>, <head> with fonts, <body>)
- Use the design system colors and liquid glass pattern from the project context
- Mobile-responsive by default
- Include a nav link back to "/" (main site)
- The base_path should be a clean URL slug derived from the feature name
- Generate ALL necessary files (HTML, CSS if separate, JS if needed)
- If the conversation mentions specific copy, headlines, or content — use it EXACTLY
- If the conversation references images, use placeholder divs with descriptive text
- If the conversation mentions API integrations, stub them with clear TODO comments`;

    const userMessage = `Here is the Grok Voice conversation transcript. Analyze it, extract the final technical plan, and generate the complete code files:

---TRANSCRIPT START---
${transcript}
---TRANSCRIPT END---

Generate the complete implementation as JSON with file contents.`;

    const claudeResponse = await callClaude(systemPrompt, userMessage, ANTHROPIC_API_KEY);

    // Parse the generated files
    let generated;
    try {
      let jsonStr = claudeResponse.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      }
      generated = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Try to extract JSON from response
      const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        generated = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Claude did not return valid JSON. Response: " + claudeResponse.substring(0, 500));
      }
    }

    if (!generated.files || Object.keys(generated.files).length === 0) {
      throw new Error("Claude generated no files");
    }

    console.log(`[pipeline] Generated ${Object.keys(generated.files).length} files: ${Object.keys(generated.files).join(", ")}`);
    console.log(`[pipeline] Summary: ${generated.summary}`);

    // ── Step 2: Deploy to Netlify ──
    const existingFiles = await getCurrentDeployFiles(NETLIFY_AUTH_TOKEN);
    const deployResult = await deployToNetlify(existingFiles, generated.files, NETLIFY_AUTH_TOKEN);

    console.log(`[pipeline] Deployed successfully: ${deployResult.url}`);

    // ── Step 3: Update netlify.toml redirect if needed ──
    // (The redirect is baked into the deploy — new pages are accessible at their paths)

    // ── Step 4: Store build log via Netlify Blobs ──
    const buildLog = {
      timestamp: new Date().toISOString(),
      grokUrl: grokUrl || null,
      transcriptLength: transcript.length,
      summary: generated.summary,
      basePath: generated.base_path,
      filesGenerated: Object.keys(generated.files),
      deployId: deployResult.deployId,
      deployUrl: deployResult.url,
      status: "success",
    };

    try {
      await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/grok-pipeline/build-${Date.now()}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${NETLIFY_AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildLog),
      });

      // Also store as "latest" for easy lookup
      await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/grok-pipeline/latest`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${NETLIFY_AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildLog),
      });
    } catch (blobErr) {
      console.error("[pipeline] Build log storage failed (non-fatal):", blobErr.message);
    }

    console.log("[pipeline] Pipeline complete!");
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "deployed",
        summary: generated.summary,
        url: deployResult.url,
        path: generated.base_path,
        files: Object.keys(generated.files),
      }),
    };
  } catch (err) {
    console.error("[pipeline] Fatal error:", err.message);

    // Log failure
    try {
      await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/grok-pipeline/latest-error`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${NETLIFY_AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          error: err.message,
          grokUrl: grokUrl || null,
          transcriptLength: transcript?.length || 0,
        }),
      });
    } catch (logErr) { /* ignore */ }

    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
