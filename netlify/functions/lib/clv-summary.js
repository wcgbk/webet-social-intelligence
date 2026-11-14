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

function blankPickClv() {
  return { n: 0, meanClvPp: null, beatClosePct: null };
}

/**
 * Mean and beat rate for per-pick rows. clvPp is percentage points.
 * Positive beat the close. Rows without a number are left out of n.
 */
function summarizePickClv(rows) {
  const list = [];
  for (const row of rows || []) {
    if (!row || row.clvPp == null || row.clvPp === '') continue;
    const pp = Number(row.clvPp);
    if (!Number.isFinite(pp)) continue;
    list.push(row);
  }
  if (!list.length) return blankPickClv();
  let sum = 0;
  let beats = 0;
  for (const row of list) {
    const pp = Number(row.clvPp);
    sum += pp;
    if (row.beatClose === true || (row.beatClose == null && pp > 0)) beats += 1;
  }
  const n = list.length;
  return {
    n,
    meanClvPp: +((sum / n).toFixed(2)),
    beatClosePct: +(((beats / n) * 100).toFixed(1)),
  };
}

function pickClvFromBlobs(blobs) {
  const rows = [];
  for (const blob of blobs || []) {
    if (blob && Array.isArray(blob.pickClv)) {
      for (const row of blob.pickClv) rows.push(row);
    }
  }
  return summarizePickClv(rows);
}

function emptySummary(note) {
  return {
    available: false,
    n: 0,
    meanCents: null,
    beatClosePct: null,
    byFamily: {},
    note: note || 'no clv blobs in window',
    pickClv: blankPickClv(),
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
        beat: p.beatClosing === true || p.beatClose === true,
        family: marketFamily(p.market || p.betType, p.source),
      });
    }
  }
  if (!valid.length) {
    const summary = emptySummary('clv blobs present but no numeric clv rows');
    summary.pickClv = pickClvFromBlobs(blobs);
    return summary;
  }

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
    pickClv: pickClvFromBlobs(blobs),
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
  summarizePickClv,
  blankPickClv,
};
