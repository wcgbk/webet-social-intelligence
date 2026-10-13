'use strict';
// scoreCandidate must match the HEAD body copied below. The only ranking
// change is compareByEdge's exact edge + stake-EV tie, which breaks on the
// capped nudge. That tie does not change the score.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const select = require(path.join(root, 'select'));
const { qualityScore } = require(path.join(root, 'odds_math'));
const { SELECT_WEIGHTS, PM_SOFT } = require(path.join(root, 'config'));

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

const SCORE_NUDGE_CAP = 0.002;

// HEAD scoreCandidate. Do not "simplify" this into selectionNudge.
function scoreCandidateHead(c) {
  const w = SELECT_WEIGHTS;
  const ev = c.ev || 0;
  const clvRaw = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  let s = qualityScore(c.edgePct, clvRaw, c.uncertainty);
  let nudge = 0;
  if (typeof c._steamScoreAdj === 'number' && Number.isFinite(c._steamScoreAdj)) nudge += c._steamScoreAdj;
  nudge += clampPmScoreAdj(c._pmScoreAdj);
  if (c.steamToward && ev > 0) nudge += (w.softSportMixBonus || 0.02);
  if (c.dkLagsSharp === true && ev > 0) nudge += 0.001;
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return s + nudge;
}

function finiteEvHead(c) {
  const n = Number(c && c.ev);
  return Number.isFinite(n) ? n : -Infinity;
}

// HEAD compareByEdge: edge, then stake EV inside 0.2pp, then stable.
function compareByEdgeHead(a, b) {
  const ea = select.edgeRank(a);
  const eb = select.edgeRank(b);
  if (Number.isFinite(ea) && Number.isFinite(eb) && Math.abs(ea - eb) <= select.EDGE_EV_BAND) {
    const evd = finiteEvHead(b) - finiteEvHead(a);
    if (Math.abs(evd) > 1e-12) return evd;
  }
  const d = eb - ea;
  if (Math.abs(d) > 1e-12) return d;
  return 0;
}

function sameScore(candidate) {
  let live;
  let head;
  let liveErr = null;
  let headErr = null;
  try { live = select.scoreCandidate(candidate); } catch (err) { liveErr = err; }
  try { head = scoreCandidateHead(candidate); } catch (err) { headErr = err; }
  if (liveErr || headErr) {
    assert.ok(liveErr && headErr, 'null candidate must throw on both sides');
    assert.strictEqual(liveErr.message, headErr.message);
    return;
  }
  assert.strictEqual(Object.is(live, head), true, JSON.stringify(candidate));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, values) => values[Math.floor(rng() * values.length)];

const steamValues = [null, undefined, NaN, Infinity, -Infinity, -1, -0.05, -0.002, 0, 0.001, 0.03, 0.2, '0.01'];
const pmValues = [null, undefined, NaN, -5, -0.03, -0.012, 0, 0.012, 0.03, 0.04, 5];
const evValues = [null, undefined, NaN, -0.04, 0, 0.0000001, 0.02, 0.2];
const edgeValues = [null, undefined, 0, -0.01, 0.015, 0.03, 0.08, '3%', 'nope'];
const clvValues = [null, undefined, NaN, -10, -3, 0, 1.2, 5];
const uncValues = [null, undefined, NaN, 0, 0.05, 0.12, 0.18, 0.5];
const flags = [true, false, null, 0, 1, 'yes'];

const edges = [];
for (const _steamScoreAdj of [0, 0.03, -0.04, null, NaN]) {
  for (const _pmScoreAdj of [0, 0.012, -0.012, 5, -5, null]) {
    for (const steamToward of [true, false, null]) {
      for (const dkLagsSharp of [true, false, null]) {
        for (const ev of [0.04, 0, -0.01, null]) {
          edges.push({
            edgePct: 0.03,
            ev,
            predictedClv: 1.2,
            predictedResidualClv: ev === 0 ? null : 0.4,
            uncertainty: 0.12,
            _steamScoreAdj,
            _pmScoreAdj,
            steamToward,
            dkLagsSharp,
          });
        }
      }
    }
  }
}

const rng = mulberry32(0x03a01000);
for (let i = 0; i < 400; i += 1) {
  const row = {
    edgePct: pick(rng, edgeValues),
    ev: pick(rng, evValues),
    predictedClv: pick(rng, clvValues),
    uncertainty: pick(rng, uncValues),
    _steamScoreAdj: pick(rng, steamValues),
    _pmScoreAdj: pick(rng, pmValues),
    steamToward: pick(rng, flags),
    dkLagsSharp: pick(rng, flags),
  };
  if (rng() < 0.5) row.predictedResidualClv = pick(rng, clvValues);
  else row.predictedResidualClv = null;
  edges.push(row);
}

for (const candidate of edges) sameScore(candidate);
sameScore(null);
sameScore(undefined);
assert.ok(edges.length > 500);

function exactTie(live, head) {
  return Number.isFinite(select.edgeRank(live))
    && Number.isFinite(select.edgeRank(head))
    && Math.abs(select.edgeRank(live) - select.edgeRank(head)) <= 1e-12
    && Math.abs(finiteEvHead(live) - finiteEvHead(head)) <= 1e-12;
}

for (let i = 0; i < edges.length; i += 40) {
  for (let j = i + 1; j < edges.length; j += 40) {
    const a = edges[i];
    const b = edges[j];
    const live = select.compareByEdge(a, b);
    const head = compareByEdgeHead(a, b);
    if (exactTie(a, b)) {
      // Allowed difference: HEAD stays on the original order. Live may
      // break the tie on the capped nudge. Quality (CLV, uncertainty)
      // is not part of that key, so the score sign is not the rank.
      assert.strictEqual(head, 0);
      assert.ok(Number.isFinite(live));
    } else {
      assert.strictEqual(Math.sign(live), Math.sign(head), `${i} vs ${j}`);
      if (head !== 0) assert.strictEqual(live, head);
    }
  }
}

const tied = {
  edgePct: 0.03, ev: 0.04, predictedClv: 1.2, uncertainty: 0.12, coverProb: 0.55, odds: -110,
};
const low = { ...tied, _pmScoreAdj: 0, matchup: 'A @ B' };
const high = { ...tied, _pmScoreAdj: 0.02, matchup: 'C @ D' };
assert.ok(select.scoreCandidate(high) > select.scoreCandidate(low));
assert.strictEqual(compareByEdgeHead(low, high), 0);
assert.ok(select.compareByEdge(low, high) > 0);
const betterEdge = { ...low, edgePct: 0.05, _pmScoreAdj: 0 };
assert.ok(select.compareByEdge(betterEdge, high) < 0);
assert.strictEqual(select.compareByEdge(betterEdge, high), compareByEdgeHead(betterEdge, high));

console.log('PASS test-omega-select-score-identity');
