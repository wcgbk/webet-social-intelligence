'use strict';
let reqPkg=null, reqErr=null;
try { reqPkg = require('@netlify/blobs'); } catch(e){ reqErr=e.message; }
exports.handler = async () => {
  const out = { requireErr: reqErr, requireOk: !!reqPkg, sdk:{}, rest:{} };
  const pkg = reqPkg;
  if (pkg) for (const name of ['edge-picks-omega','edge-picks-v1lock']) {
    try {
      const s = pkg.getStore(name);
      const list = await s.list({ limit: 200 });
      out.sdk[name] = { keys:(list.blobs||[]).map(b=>b.key).slice(0,150), dirs:list.directories||[] };
      for (const k of ['picks-2026-10-18','omega-line-path/2026-10-18']) {
        try { const v=await s.get(k); out.sdk[name]['get:'+k]= v==null?null:String(v).slice(0,60); } catch(e){ out.sdk[name]['get:'+k]='ERR:'+e.message; }
      }
    } catch(e){ out.sdk[name]='ERR:'+e.message; }
  }
  const token=process.env.NETLIFY_AUTH_TOKEN; const site=process.env.SITE_ID||'87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  if (token) {
    try { const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/edge-picks-omega`, {headers:{Authorization:`Bearer ${token}`}}); out.rest.listStatus=r.status; out.rest.listBody=(await r.text()).slice(0,1500); } catch(e){ out.rest.list='ERR:'+e.message; }
    try { const r=await fetch(`https://api.netlify.com/api/v1/sites/${site}`, {headers:{Authorization:`Bearer ${token}`}}); out.rest.siteStatus=r.status; const j=await r.json().catch(()=>({})); out.rest.siteName=j.name; out.rest.account=j.account_id; } catch(e){}
  }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
