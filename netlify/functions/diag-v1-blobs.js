'use strict';
/** TEMP V1 diagnostic: what can the SDK actually see? Lists keys + probes. */
exports.handler = async () => {
  const out = { sdk: {}, rest: {} };
  try {
    const { getStore } = await import('@netlify/blobs');
    for (const name of ['edge-picks-omega','edge-picks-v1lock']) {
      try {
        const s = getStore(name);
        const list = await s.list({ limit: 200 });
        out.sdk[name] = { keys: (list.blobs||[]).map(b=>b.key).slice(0,120), dirs: list.directories||[] };
        for (const k of ['picks-2026-10-18','latest-date','omega-line-path/2026-10-18','omega-line-snap-2026-10-18-1000','omega-line-snap-2026-10-18-0900']) {
          try { const v = await s.get(k); out.sdk[name][`get:${k}`] = v==null?null:String(v).slice(0,80); } catch(e){ out.sdk[name][`get:${k}`]='ERR:'+e.message; }
        }
      } catch(e){ out.sdk[name]='ERR:'+e.message; }
    }
  } catch(e){ out.sdkError=e.message; }
  const token = process.env.NETLIFY_AUTH_TOKEN; const site = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  out.rest.siteIdUsed = site; out.rest.hasToken = !!token;
  if (token) for (const k of ['picks-2026-10-18','omega-line-path/2026-10-18','omega-line-path%2F2026-10-18']) {
    try { const r = await fetch(`https://api.netlify.com/api/v1/blobs/${site}/edge-picks-omega/${k}`, { headers:{Authorization:`Bearer ${token}`} }); out.rest[k]=r.status; } catch(e){ out.rest[k]='ERR:'+e.message; }
  }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
