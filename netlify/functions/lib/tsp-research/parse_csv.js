'use strict';

/** Minimal CSV parser (handles quotes). Returns { headers, rows }. */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.trim()) return { headers: [], rows: [] };

  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    // skip fully-empty rows
    if (row.some((c) => String(c).trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\n') { pushField(); pushRow(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    field += c; i += 1;
  }
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h || '').trim());
  const data = rows.slice(1).map((cells) => {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j] || `col_${j}`] = cells[j] != null ? String(cells[j]).trim() : '';
    }
    return obj;
  });
  return { headers, rows: data };
}

function summarizeWagerLog(rows) {
  let wins = 0, losses = 0, pushes = 0, units = 0;
  for (const r of rows) {
    const result = String(r.Result || r.result || '').toLowerCase();
    const retRaw = r['Units W/L'] || r['Base Ret'] || r['% Return'] || r['ROI (Units)'] || r.Units || '';
    const ret = parseFloat(String(retRaw).replace('%', ''));
    if (/win|won|w\b/.test(result)) wins += 1;
    else if (/loss|lost|l\b/.test(result)) losses += 1;
    else if (/push|void|cancel/.test(result)) pushes += 1;
    if (Number.isFinite(ret)) {
      // Heuristic: values like 1.00 / -1.10 are units; 1.00% style already stripped
      units += Math.abs(ret) > 5 && String(retRaw).includes('%') ? ret / 100 : ret;
    }
  }
  const decided = wins + losses;
  return {
    rows: rows.length,
    wins,
    losses,
    pushes,
    winPct: decided ? +(100 * wins / decided).toFixed(2) : null,
    unitsApprox: +units.toFixed(2),
  };
}

function summarizeSummarySheet(rows) {
  return {
    rows: rows.length,
    lines: rows
      .filter((r) => Object.values(r).some((v) => String(v || '').trim()))
      .slice(0, 40)
      .map((r) => ({ ...r })),
  };
}

module.exports = {
  parseCsv,
  summarizeWagerLog,
  summarizeSummarySheet,
};
