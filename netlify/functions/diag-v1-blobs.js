'use strict';
exports.handler = async () => {
  const token=process.env.NETLIFY_AUTH_TOKEN; const site=process.env.SITE_ID||'87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const H={Authorization:`Bearer ${token}`}; const out={};
  const list=async(store,prefix)=>{ const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/${store}?prefix=${encodeURIComponent(prefix)}`,{headers:H}); const j=await r.json().catch(()=>({})); return (j.blobs||[]).map(b=>b.key+'@'+b.last_modified+'#'+b.size); };
  out.masterDate = await list('odds-master','by-date/2026-10-18');
  out.masterNFL = await list('odds-master','by-date/2026-10-18/event/americanfootball_nfl');
  try { const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/odds-master/by-date/2026-10-18`,{headers:H}); out.masterGet=r.status; const j=await r.json().catch(()=>null); if(j) out.masterSample=JSON.stringify(j).slice(0,2500); } catch(e){ out.masterGet='ERR:'+e.message; }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
