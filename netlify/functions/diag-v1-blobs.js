'use strict';
exports.handler = async () => {
  const token=process.env.NETLIFY_AUTH_TOKEN; const site=process.env.SITE_ID||'87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const H={Authorization:`Bearer ${token}`}; const out={};
  const get=async(store,key)=>{ const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/${store}/${key.split('/').map(encodeURIComponent).join('/')}`,{headers:H}); return {status:r.status, body:(await r.text()).slice(0,4000)}; };
  out.eaglesIndex = await get('odds-master','index/NFL/caca2d752fe1a1779029082e95332fcc');
  const list=async(store,prefix)=>{ const r=await fetch(`https://api.netlify.com/api/v1/blobs/${site}/${store}?prefix=${encodeURIComponent(prefix)}`,{headers:H}); const j=await r.json().catch(()=>({})); return (j.blobs||[]).map(b=>b.key+'#'+b.size); };
  out.eaglesPrices = await list('odds-master','NFL/caca2d752fe1a1779029082e95332fcc/');
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify(out,null,2) };
};
