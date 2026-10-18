'use strict';
exports.handler = async () => {
  const token=process.env.NETLIFY_AUTH_TOKEN; const site=process.env.SITE_ID||'87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const H={Authorization:`Bearer ${token}`}; const out={};
  for (const prefix of ['omega-line-path/2026-10-1','omega-line-path/2026-10-18','omega-line-snap-2026-10-1']) {
    const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/edge-picks-omega?prefix=${encodeURIComponent(prefix)}`, {headers:H});
    const j=await r.json().catch(()=>({})); out[prefix]=(j.blobs||[]).map(b=>b.key+'@'+b.last_modified);
  }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
