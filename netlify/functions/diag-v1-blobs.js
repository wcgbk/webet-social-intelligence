'use strict';
exports.handler = async () => {
  const token=process.env.NETLIFY_AUTH_TOKEN; const site=process.env.SITE_ID||'87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const out={};
  const H={Authorization:`Bearer ${token}`};
  for (const store of ['edge-picks-omega','edge-picks-v1lock']) {
    out[store]={};
    for (const prefix of ['omega-line-path/2026-10','omega-line-snap-2026-10-18','omega-line-path/2026-10-18','picks-2026-10-18']) {
      try { const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/${store}?prefix=${encodeURIComponent(prefix)}`, {headers:H}); const t=await r.text(); out[store][prefix]=r.status+':'+t.slice(0,1200); } catch(e){ out[store][prefix]='ERR:'+e.message; }
    }
    // directories form
    try { const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/${store}/omega-line-path/2026-10-18`, {headers:H}); out[store].pathGet=r.status+':'+(await r.text()).slice(0,300); } catch(e){}
  }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
