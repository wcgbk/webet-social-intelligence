// Aggregate existing track-clv / track-clv-omega blobs. Do NOT invent metrics.
// If a date has no clv-{date} blob, skip it. If none exist, return honest nulls.

function marketFamily(market, source) {
  const m = String(market || '').toLowerCase();
  const src = String(source || '').toLowerCase();
  if (src === 'f5' || m.includes('f5')) return 'F5';
  if (m.includes('total')) return 'Total';
  if (m.includes('moneyline') || m === 'h2h' || m === 'ml') return 'ML';
  if (m.includes('run line') || m.includes('spread') || m.includes('puck')) return 'Spread';
  return 'Other';
}

function emptySummary(note) {
  return {
    available: false,
    n: 0,
    meanCents: null,
    beatClosePct: null,
    byFamily: {},
    note: note || 'no clv blobs in window',
  };
}

function summarizeClvBlobs(blobs) {
  const valid = [];
  for (const blob of blobs || []) {
    if (!blob || typeof blob !== 'object') continue;
    const picks = Array.isArray(blob.picks) ? blob.picks : [];
    for (const p of picks) {
      const cents = (typeof p.clvCents === 'number' && Number.isFinite(p.clvCents))
        ? p.clvCents
        : (typeof p.clv === 'number' && Number.isFinite(p.clv) ? +(p.clv * 100).toFixed(2) : null);
      if (cents == null) continue;
      valid.push({
        cents,
        beat: p.beatClosing === true,
        family: marketFamily(p.market || p.betType, p.source),
      });
    }
  }
  if (!valid.length) return emptySummary('clv blobs present but no numeric clv rows');

  const sum = valid.reduce((s, p) => s + p.cents, 0);
  const beats = valid.filter(p => p.beat).length;
  const byFamily = {};
  for (const p of valid) {
    if (!byFamily[p.family]) byFamily[p.family] = { n: 0, centsSum: 0, beats: 0 };
    byFamily[p.family].n++;
    byFamily[p.family].centsSum += p.cents;
    if (p.beat) byFamily[p.family].beats++;
  }
  const families = {};
  for (const [k, v] of Object.entries(byFamily)) {
    families[k] = {
      n: v.n,
      meanCents: v.n ? +((v.centsSum / v.n).toFixed(2)) : null,
      beatClosePct: v.n ? +((v.beats / v.n) * 100).toFixed(1) : null,
    };
  }
  return {
    available: true,
    n: valid.length,
    meanCents: +(sum / valid.length).toFixed(2),
    beatClosePct: +((beats / valid.length) * 100).toFixed(1),
    byFamily: families,
    note: null,
  };
}

async function summarizeClvFromStore({ storeUrl, authHeaders, dates }) {
  if (!storeUrl || !authHeaders || !Array.isArray(dates) || dates.length === 0) {
    return emptySummary('no dates');
  }
  const blobs = [];
  let fetched = 0;
  await Promise.all(dates.map(async (d) => {
    try {
      const r = await fetch(`${storeUrl}/clv-${d}`, { headers: authHeaders });
      if (!r.ok) return;
      const json = await r.json();
      fetched++;
      blobs.push(json);
    } catch (e) { /* missing blob is expected */ }
  }));
  if (!fetched) return emptySummary('no clv blobs in window');
  const summary = summarizeClvBlobs(blobs);
  summary.daysWithClv = fetched;
  summary.daysRequested = dates.length;
  return summary;
}

module.exports = {
  marketFamily,
  emptySummary,
  summarizeClvBlobs,
  summarizeClvFromStore,
};
