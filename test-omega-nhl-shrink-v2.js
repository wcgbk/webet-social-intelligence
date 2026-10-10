'use strict';
// Golden NHL probabilities are the normal CDF. The 60-minute joint is off.
process.env.OMEGA_NHL_PERIOD = '0';
/** NHL empirical-Bayes goal-rate shrink, with call-time variant toggles. No network. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const nhl = require(path.join(root, 'sports/nhl'));
const { buildHealthRecord } = require(path.join(root, 'health'));

const K = nhl.NHL_GPG_PRIOR_GAMES;
const LG = 3.1;
assert.strictEqual(K, 34, 'prior games stay at the a-priori Poisson/talent value');
assert.strictEqual(nhl.NHL_GPG_IMPLAUSIBLE, 10);
assert.strictEqual(nhl.NHL_GPG_FLOOR, 1.5);
assert.strictEqual(nhl.NHL_GPG_CAP, 5.2);

function shrunk(sum, gp, k) {
  const prior = k == null ? K : k;
  return (sum + prior * LG) / (gp + prior);
}

function inBand(x) {
  return x >= nhl.NHL_GPG_FLOOR && x <= nhl.NHL_GPG_CAP;
}

function withEnv(extra, fn) {
  const prev = {};
  for (const key of Object.keys(extra)) {
    prev[key] = process.env[key];
    if (extra[key] == null) delete process.env[key];
    else process.env[key] = extra[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(extra)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

delete process.env.OMEGA_NHL_SHRINK_MODE;
delete process.env.OMEGA_NHL_SHRINK_K;

// Default is all. Every club with a known gp shrinks to the league mean.
// (a) Rangers GF 16 / GA 8 at gp 5. Raw 3.2 and 1.6 are inside the band.
const rangers = { wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8, nhlSeasonGoals: true };
const rangersGpg = nhl.teamGpg(rangers);
assert.ok(rangersGpg, 'explicit Goals For is not standings points');
assert.ok(Math.abs(rangersGpg.gf - shrunk(16, 5)) < 1e-9, rangersGpg.gf);
assert.ok(Math.abs(rangersGpg.ga - shrunk(8, 5)) < 1e-9, rangersGpg.ga);
assert.strictEqual(rangersGpg.gp, 5);
assert.ok(Math.abs(rangersGpg.gfRaw - 16 / 5) < 1e-9);
assert.ok(Math.abs(rangersGpg.shrinkWeight - K / (5 + K)) < 1e-9);

// (b) Early extremes are out of band, so the default still shrinks them off the flat 6.2.
const avsRow = { pf: 14, pa: 5, games: 2, nhlSeasonGoals: true };
const flamesRow = { pf: 3, pa: 16, games: 3, nhlSeasonGoals: true };
const avs = nhl.teamGpg(avsRow);
const flames = nhl.teamGpg(flamesRow);
assert.ok(avs && flames);
assert.ok(inBand(avs.gf) && inBand(avs.ga) && inBand(flames.gf) && inBand(flames.ga));
assert.ok(avs.gf > LG && avs.gf < 14 / 2, avs.gf);
assert.ok(avs.ga > 5 / 2 && avs.ga < LG, avs.ga);
assert.ok(flames.gf > 3 / 3 && flames.gf < LG, flames.gf);
assert.ok(flames.ga > LG && flames.ga < 16 / 3, flames.ga);
assert.ok(Math.abs(avs.gf - shrunk(14, 2)) < 1e-9, avs.gf);
assert.ok(Math.abs(flames.ga - shrunk(16, 3)) < 1e-9, flames.ga);
const early = nhl.nhlStandingsEnv(avsRow, flamesRow);
assert.strictEqual(early.usedStandings, true);
assert.notStrictEqual(early.modelTotal, 6.2);
assert.ok(Math.abs(early.homeGfRaw - 14 / 2) < 1e-9);
assert.strictEqual(early.homeGp, 2);
assert.ok(Math.abs(early.homeShrinkWeight - K / (2 + K)) < 1e-9);
assert.strictEqual(early.homeBaseline, null);
assert.strictEqual(early.awayBaseline, null);
assert.ok(Math.abs(early.awayGaRaw - 16 / 3) < 1e-9);

// (c) Default all shrinks a rate inside the cap and a rate just over it.
const rateLo = nhl.teamGpg({ pf: 5.1, pa: 3.0, games: 30 });
const rateHi = nhl.teamGpg({ pf: 5.3, pa: 3.0, games: 30 });
assert.ok(rateLo && rateHi, 'a 5.3 rate is shrunk, not discarded');
assert.ok(Math.abs(rateLo.gf - shrunk(5.1 * 30, 30)) < 1e-9, rateLo.gf);
assert.ok(rateLo.shrinkWeight > 0);
assert.ok(Math.abs(rateHi.gf - shrunk(5.3 * 30, 30)) < 1e-9, rateHi.gf);
assert.ok(inBand(rateHi.gf));
assert.ok(rateHi.gf > rateLo.gf, 'all keeps order across the old cap');
assert.ok(Math.abs(rateLo.gfRaw - 5.1) < 1e-9);
assert.ok(Math.abs(rateHi.gfRaw - 5.3) < 1e-9);

// (d) One game of a season sum stays on the seed.
assert.strictEqual(nhl.teamGpg({ pf: 8, pa: 6, games: 1, nhlSeasonGoals: true }), null);
const one = nhl.nhlStandingsEnv(
  { pf: 8, pa: 6, games: 1, nhlSeasonGoals: true },
  { pf: 9, pa: 4, games: 1, nhlSeasonGoals: true }
);
assert.strictEqual(one.usedStandings, false);
assert.strictEqual(one.modelTotal, 6.2);
assert.strictEqual(one.homeBaseline, 'gp<2');
assert.strictEqual(one.homeGfRaw, null);

// (e) Without the goals flag, pf equal to 2W+OTL is still standings points.
const pointsRow = { wins: 4, losses: 1, otLosses: 0, games: 5, pf: 8, pa: 20 };
assert.strictEqual(nhl.teamGpg(pointsRow), null);
const pointsEnv = nhl.nhlStandingsEnv(pointsRow, avsRow);
assert.strictEqual(pointsEnv.awayBaseline, null);
assert.strictEqual(pointsEnv.homeBaseline, 'standings-points guard');
assert.strictEqual(pointsEnv.usedStandings, false);
assert.strictEqual(
  nhl.teamGpg({ wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8 }),
  null
);

// (f) In-band per-game rate with a known gp shrinks under the all default.
const rate = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
assert.ok(rate);
assert.ok(Math.abs(rate.gf - shrunk(3.2 * 40, 40)) < 1e-9, rate.gf);
assert.ok(Math.abs(rate.ga - shrunk(2.8 * 40, 40)) < 1e-9, rate.ga);
assert.ok(rate.shrinkWeight > 0);
assert.ok(Math.abs(rate.gfRaw - 3.2) < 1e-9);

// Unknown gp still passes a rate through only inside the band. Zero after 2+ games shrinks.
const pass = nhl.teamGpg({ pf: 3.2, pa: 2.8 });
assert.ok(Math.abs(pass.gf - 3.2) < 1e-9 && Math.abs(pass.ga - 2.8) < 1e-9);
assert.strictEqual(pass.shrinkWeight, 0);
assert.strictEqual(pass.gp, null);
assert.strictEqual(nhl.teamGpg({ pf: 5.5, pa: 2.8 }), null);
assert.strictEqual(nhl.teamGpgDetail({ pf: 5.5, pa: 2.8 }).baseline, 'out of band');
const shutout = nhl.teamGpg({ pf: 0, pa: 8, games: 3, nhlSeasonGoals: true });
assert.ok(shutout, '0 goals with gp>=2 is valid');
assert.ok(Math.abs(shutout.gf - shrunk(0, 3)) < 1e-9, shutout.gf);
assert.ok(inBand(shutout.gf) && inBand(shutout.ga));
assert.strictEqual(nhl.teamGpg({ pf: -1, pa: 8, games: 5, nhlSeasonGoals: true }), null);
assert.strictEqual(nhl.teamGpgDetail({ pf: -1, pa: 8, games: 5, nhlSeasonGoals: true }).baseline, 'implausible rate');

// (g) Corrupt rates are rejected. A real early extreme still shrinks.
const poisonedGf = { pf: 9000, pa: 30, games: 10, nhlSeasonGoals: true };
assert.strictEqual(nhl.teamGpg(poisonedGf), null);
const poisonedEnv = nhl.nhlStandingsEnv(poisonedGf, avsRow);
assert.strictEqual(poisonedEnv.homeBaseline, 'implausible rate');
assert.strictEqual(poisonedEnv.usedStandings, false);
assert.strictEqual(poisonedEnv.modelTotal, 6.2);
const avalancheGp2 = nhl.teamGpg({ pf: 14, pa: 5, games: 2, nhlSeasonGoals: true });
assert.ok(avalancheGp2, 'Avalanche gp 2, 14/5 (raw 7.0) is not implausible');
assert.ok(Math.abs(avalancheGp2.gfRaw - 7) < 1e-9, avalancheGp2 && avalancheGp2.gfRaw);

// (h) K is read at call time. Under the all default it moves every club.
// 0 / "off" is no shrink: in-band stays raw, out-of-band clamps.
withEnv({ OMEGA_NHL_SHRINK_K: '10' }, () => {
  const kept = nhl.teamGpg(rangers);
  assert.ok(Math.abs(kept.gf - shrunk(16, 5, 10)) < 1e-9, kept.gf);
  assert.ok(Math.abs(kept.shrinkWeight - 10 / 15) < 1e-9);
  const hot = nhl.teamGpg(avsRow);
  assert.ok(Math.abs(hot.gf - shrunk(14, 2, 10)) < 1e-9, hot.gf);
  assert.ok(Math.abs(hot.shrinkWeight - 10 / 12) < 1e-9);
});
withEnv({ OMEGA_NHL_SHRINK_K: '0' }, () => {
  const raw = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
  assert.ok(Math.abs(raw.gf - 3.2) < 1e-9, raw.gf);
  assert.strictEqual(raw.shrinkWeight, 0);
  const hot = nhl.teamGpg(avsRow);
  assert.ok(hot, 'K=0 clamps a hot start instead of nulling it');
  assert.ok(Math.abs(hot.gf - nhl.NHL_GPG_CAP) < 1e-9, hot.gf);
  assert.ok(Math.abs(hot.gfRaw - 7) < 1e-9);
});
withEnv({ OMEGA_NHL_SHRINK_K: 'off' }, () => {
  const raw = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
  assert.ok(Math.abs(raw.gf - 3.2) < 1e-9, raw.gf);
  const hot = nhl.teamGpg(avsRow);
  assert.ok(Math.abs(hot.gf - nhl.NHL_GPG_CAP) < 1e-9, hot.gf);
});

// (i) Explicit mode oob: in-band stays raw, Avalanche is rescued. Not the unset default.
withEnv({ OMEGA_NHL_SHRINK_MODE: 'oob' }, () => {
  const kept = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
  assert.ok(Math.abs(kept.gf - 3.2) < 1e-9, kept.gf);
  assert.ok(Math.abs(kept.ga - 2.8) < 1e-9, kept.ga);
  assert.strictEqual(kept.shrinkWeight, 0);
  assert.ok(Math.abs(kept.gfRaw - 3.2) < 1e-9);
  const rescued = nhl.teamGpg(avsRow);
  assert.ok(rescued, 'oob shrinks the club the old band would have nulled');
  assert.ok(Math.abs(rescued.gf - shrunk(14, 2)) < 1e-9, rescued.gf);
  assert.ok(Math.abs(rescued.ga - shrunk(5, 2)) < 1e-9, rescued.ga);
  assert.ok(inBand(rescued.gf) && inBand(rescued.ga));
  const inside = nhl.teamGpg({ pf: 5.1, pa: 3.0, games: 30 });
  assert.ok(Math.abs(inside.gf - 5.1) < 1e-9, inside.gf);
  assert.strictEqual(inside.shrinkWeight, 0);
  const hi = nhl.teamGpg({ pf: 5.3, pa: 3.0, games: 30 });
  assert.ok(hi, 'oob rescues a rate just above the old cap');
  assert.ok(Math.abs(hi.gf - shrunk(5.3 * 30, 30)) < 1e-9, hi.gf);
  assert.ok(inBand(hi.gf));
  const rescuedOnly = nhl.teamGpg(rangers);
  assert.ok(Math.abs(rescuedOnly.gf - 16 / 5) < 1e-9);
  assert.strictEqual(rescuedOnly.shrinkWeight, 0);
  assert.ok(Math.abs(rescuedOnly.gf - rangersGpg.gf) > 1e-6);
});

// (i2) mode all shrinks every club, including one already inside the band.
// More goals at the same gp never lowers the rate, including across the old 5.2 null.
withEnv({ OMEGA_NHL_SHRINK_MODE: 'all' }, () => {
  const got = nhl.teamGpg(rangers);
  assert.ok(Math.abs(got.gf - shrunk(16, 5)) < 1e-9, got.gf);
  assert.ok(Math.abs(got.ga - shrunk(8, 5)) < 1e-9, got.ga);
  assert.strictEqual(got.gp, 5);
  assert.ok(Math.abs(got.gfRaw - 16 / 5) < 1e-9);
  assert.ok(Math.abs(got.shrinkWeight - K / (5 + K)) < 1e-9);
  assert.ok(Math.abs(got.gf - (16 + 34 * 3.1) / 39) < 1e-9);
  const fewer = nhl.teamGpg({ pf: 10, pa: 12, games: 8, nhlSeasonGoals: true });
  const more = nhl.teamGpg({ pf: 22, pa: 12, games: 8, nhlSeasonGoals: true });
  assert.ok(more.gf > fewer.gf);
  const lo = nhl.teamGpg({ pf: 5.1, pa: 3.0, games: 30 });
  const hi = nhl.teamGpg({ pf: 5.3, pa: 3.0, games: 30 });
  assert.ok(lo && hi);
  assert.ok(hi.gf > lo.gf, 'all keeps order across the old cap');
  assert.ok(Math.abs(lo.gf - shrunk(5.1 * 30, 30)) < 1e-9, lo.gf);
  assert.ok(Math.abs(hi.gf - shrunk(5.3 * 30, 30)) < 1e-9, hi.gf);
  const shrunkRate = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
  assert.ok(Math.abs(shrunkRate.gf - shrunk(3.2 * 40, 40)) < 1e-9, shrunkRate.gf);
  assert.ok(Math.abs(shrunkRate.ga - shrunk(2.8 * 40, 40)) < 1e-9, shrunkRate.ga);
  assert.ok(shrunkRate.shrinkWeight > 0);
});
withEnv({ OMEGA_NHL_SHRINK_MODE: 'all', OMEGA_NHL_SHRINK_K: '10' }, () => {
  const got = nhl.teamGpg(rangers);
  assert.ok(Math.abs(got.gf - shrunk(16, 5, 10)) < 1e-9, got.gf);
  assert.ok(Math.abs(got.shrinkWeight - 10 / 15) < 1e-9);
});

// (j) mode off (and "0") is the pre-shrink main output.
function mainTeamGpg(st) {
  if (!st || typeof st !== 'object') return null;
  const pf = Number(st.pf != null ? st.pf : st.gf);
  const pa = Number(st.pa != null ? st.pa : st.ga);
  if (!Number.isFinite(pf) || !Number.isFinite(pa) || pf <= 0 || pa <= 0) return null;
  const wins = Number(st.wins);
  const otlRaw = st.otLosses != null ? st.otLosses : st.otl;
  const otl = Number(otlRaw);
  const guess = 2 * wins + (Number.isFinite(otl) ? otl : 0);
  const g = Number(st.games) > 0
    ? Number(st.games)
    : (Number.isFinite(wins) && Number.isFinite(Number(st.losses))
      ? wins + Number(st.losses) + (Number.isFinite(otl) ? otl : 0)
      : 0);
  function pointsLike(pfv) {
    if (!(pfv > 6)) return false;
    if (g > 0 && pfv / g > 2) return false;
    if (!Number.isFinite(wins) || wins < 0) return false;
    if (guess < 8) return false;
    return Math.abs(pfv - guess) <= Math.max(3, guess * 0.12);
  }
  if (st.nhlSeasonGoals !== true && (pointsLike(pf) || pointsLike(pa))) return null;
  let gf = pf;
  let ga = pa;
  const seasonSum = st.nhlSeasonGoals === true || pf > LG * 1.8 || pa > LG * 1.8;
  if (seasonSum) {
    if (g < 2) return null;
    gf = pf / g;
    ga = pa / g;
  }
  if (!(gf >= 1.5 && gf <= 5.2 && ga >= 1.5 && ga <= 5.2)) return null;
  return { gf, ga };
}

const offCases = [
  rangers,
  avsRow,
  flamesRow,
  { pf: 3.2, pa: 2.8, games: 40 },
  { pf: 3.2, pa: 2.8 },
  { pf: 5.1, pa: 3.0, games: 30 },
  { pf: 5.3, pa: 3.0, games: 30 },
  { pf: 8, pa: 6, games: 1 },
  { pf: 8, pa: 6, games: 2 },
  { pf: 12, pa: 8, games: 4 },
  { pf: 11, pa: 6, games: 4, nhlSeasonGoals: true },
  { pf: 3, pa: 4, games: 2, nhlSeasonGoals: true },
  { pf: 2, pa: 5, games: 2, nhlSeasonGoals: true },
  { pf: 0, pa: 8, games: 3, nhlSeasonGoals: true },
  { pf: -1, pa: 8, games: 5, nhlSeasonGoals: true },
  poisonedGf,
  pointsRow,
  { wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8 },
  { pf: 5.5, pa: 2.8 },
];

function assertModeOff() {
  for (const st of offCases) {
    const got = nhl.teamGpg(st);
    const exp = mainTeamGpg(st);
    if (exp == null) {
      assert.strictEqual(got, null, JSON.stringify(st));
    } else {
      assert.deepStrictEqual(Object.keys(got).sort(), ['ga', 'gf']);
      assert.ok(Math.abs(got.gf - exp.gf) < 1e-12, `${got.gf} vs ${exp.gf}`);
      assert.ok(Math.abs(got.ga - exp.ga) < 1e-12, `${got.ga} vs ${exp.ga}`);
    }
  }
  const priced = nhl.nhlStandingsEnv(
    { pf: 3.4, pa: 2.6, wins: 40, losses: 20, otLosses: 5 },
    { pf: 3.1, pa: 2.9, wins: 35, losses: 25, otLosses: 4 }
  );
  assert.strictEqual(priced.usedStandings, true);
  assert.ok(Math.abs(priced.modelMargin - 0.45) < 1e-12, priced.modelMargin);
  assert.ok(Math.abs(priced.modelTotal - 6) < 1e-12, priced.modelTotal);
  const dropped = nhl.nhlStandingsEnv(avsRow, flamesRow);
  assert.strictEqual(dropped.usedStandings, false);
  assert.strictEqual(dropped.modelTotal, 6.2);
  assert.strictEqual(dropped.homeBaseline, 'out of band');
}

withEnv({ OMEGA_NHL_SHRINK_MODE: 'off' }, assertModeOff);
withEnv({ OMEGA_NHL_SHRINK_MODE: '0' }, assertModeOff);

function synthNhl(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-06T23:10:00Z',
    bookmakers: ['pinnacle', 'circa', 'draftkings', 'fanduel'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [
          { name: home, price: key === 'pinnacle' ? -130 : -125 },
          { name: away, price: key === 'pinnacle' ? 110 : 105 },
        ] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 6.0 },
          { name: 'Under', price: -110, point: 6.0 },
        ] },
      ],
    })),
  };
}

function slim(rows) {
  return rows.map((c) => ({
    sport: c.sport,
    market: c.market,
    side: c.side,
    line: c.line,
    modelRawP: c.modelRawP,
    modelProjection: c.modelProjection,
    fair_sharp_p: c.fair_sharp_p,
    odds: c.odds,
    projMethod: c.projMethod,
  }));
}

const mainNhlFixture = [
  { sport: 'NHL', market: 'Moneyline', side: 'Colorado Avalanche', line: null, modelRawP: 0.554514682531127, modelProjection: 0.45, fair_sharp_p: 0.5427435387673957, odds: -125, projMethod: 'nhl-standings-hfa' },
  { sport: 'NHL', market: 'Moneyline', side: 'Dallas Stars', line: null, modelRawP: 0.445485317468873, modelProjection: 0.45, fair_sharp_p: 0.4572564612326044, odds: 105, projMethod: 'nhl-standings-hfa' },
  { sport: 'NHL', market: 'Spread', side: 'Colorado Avalanche -1.5', line: -1.5, modelRawP: 0.4186213384597734, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
  { sport: 'NHL', market: 'Spread', side: 'Dallas Stars +1.5', line: 1.5, modelRawP: 0.5813786615402265, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
  { sport: 'NHL', market: 'Total', side: 'Over 6', line: 6, modelRawP: 0.4999999325447795, modelProjection: 6, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
  { sport: 'NHL', market: 'Total', side: 'Under 6', line: 6, modelRawP: 0.4999999325447795, modelProjection: 6, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
];

const inBandStandings = {
  'Colorado Avalanche': { pf: 3.4, pa: 2.6, wins: 40, losses: 20, otLosses: 5 },
  'Dallas Stars': { pf: 3.1, pa: 2.9, wins: 35, losses: 25, otLosses: 4 },
};
function projectInBand() {
  return nhl.project({
    oddsEvents: [synthNhl('Colorado Avalanche', 'Dallas Stars')],
    standings: inBandStandings,
  });
}
withEnv({ OMEGA_NHL_SHRINK_MODE: 'oob' }, () => {
  assert.deepStrictEqual(slim(projectInBand()), mainNhlFixture);
});
withEnv({ OMEGA_NHL_SHRINK_MODE: 'off' }, () => {
  assert.deepStrictEqual(slim(projectInBand()), mainNhlFixture);
});
const allNhlFixture = [
  { sport: 'NHL', market: 'Moneyline', side: 'Colorado Avalanche', line: null, modelRawP: 0.546426095390771, modelProjection: 0.35, fair_sharp_p: 0.5427435387673957, odds: -125, projMethod: 'nhl-standings-hfa' },
  { sport: 'NHL', market: 'Moneyline', side: 'Dallas Stars', line: null, modelRawP: 0.453573904609229, modelProjection: 0.35, fair_sharp_p: 0.4572564612326044, odds: 105, projMethod: 'nhl-standings-hfa' },
  { sport: 'NHL', market: 'Spread', side: 'Colorado Avalanche -1.5', line: -1.5, modelRawP: 0.4111867145429522, modelProjection: 0.35, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
  { sport: 'NHL', market: 'Spread', side: 'Dallas Stars +1.5', line: 1.5, modelRawP: 0.5888132854570478, modelProjection: 0.35, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
  { sport: 'NHL', market: 'Total', side: 'Over 6', line: 6, modelRawP: 0.5068838798182105, modelProjection: 6.07, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
  { sport: 'NHL', market: 'Total', side: 'Under 6', line: 6, modelRawP: 0.4931161201817895, modelProjection: 6.07, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
];
withEnv({ OMEGA_NHL_SHRINK_MODE: 'all' }, () => {
  assert.deepStrictEqual(slim(projectInBand()), allNhlFixture);
});
// Unset default is all, so this in-band slate matches the full shrink board.
assert.deepStrictEqual(slim(projectInBand()), allNhlFixture);

const logs = [];
const origLog = console.log;
console.log = (...args) => logs.push(args.join(' '));
let cands;
try {
  cands = nhl.project({
    oddsEvents: [
      {
        home_team: 'Winnipeg Jets',
        away_team: 'Colorado Avalanche',
        commence_time: '2026-10-07T23:00:00Z',
        bookmakers: ['pinnacle'].map((key) => ({
          key,
          markets: [
            { key: 'h2h', outcomes: [{ name: 'Winnipeg Jets', price: -120 }, { name: 'Colorado Avalanche', price: 100 }] },
            { key: 'spreads', outcomes: [{ name: 'Winnipeg Jets', price: -110, point: -1.5 }, { name: 'Colorado Avalanche', price: -110, point: 1.5 }] },
            { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 6.5 }, { name: 'Under', price: -110, point: 6.5 }] },
          ],
        })),
      },
      {
        home_team: 'Anaheim Ducks',
        away_team: 'Edmonton Oilers',
        commence_time: '2026-10-07T23:30:00Z',
        bookmakers: [],
      },
      {
        home_team: 'San Jose Sharks',
        away_team: 'Boston Bruins',
        commence_time: '2026-10-08T00:00:00Z',
        bookmakers: [],
      },
    ],
    standings: {
      'Winnipeg Jets': { pf: 6, pa: 4, games: 1, nhlSeasonGoals: true },
      'Colorado Avalanche': avsRow,
      'Anaheim Ducks': pointsRow,
      'San Jose Sharks': poisonedGf,
    },
  });
} finally {
  console.log = origLog;
}
const lines = logs.filter((l) => l.startsWith('[omega-nhl] baseline teams:'));
assert.strictEqual(lines.length, 1, lines.join('\n'));
assert.ok(lines[0].includes('Winnipeg Jets (gp<2)'), lines[0]);
assert.ok(lines[0].includes('Anaheim Ducks (standings-points guard)'), lines[0]);
assert.ok(lines[0].includes('Edmonton Oilers (no goals data)'), lines[0]);
assert.ok(lines[0].includes('San Jose Sharks (implausible rate)'), lines[0]);
assert.ok(!lines[0].includes('Colorado Avalanche'), lines[0]);
assert.ok(cands.length >= 6);
for (const c of cands) {
  assert.strictEqual(c.gfRaw, undefined);
  assert.strictEqual(c.gaRaw, undefined);
  assert.strictEqual(c.shrinkWeight, undefined);
  assert.strictEqual(c.homeGfRaw, undefined);
  assert.strictEqual(c.homeBaseline, undefined);
  assert.strictEqual(c.gp, undefined);
}

// Health: shrunk Avalanche / Flames are in band, so out-of-band is 0.
function nhlHealth(table, candidates) {
  return buildHealthRecord({
    dateISO: '2026-10-08',
    snap: {
      standingsBySport: { NHL: table },
      espnBySport: {},
      oddsBySport: {},
      mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
    },
    rawBySport: {},
    candidates: candidates || [],
    yesPool: [],
    oddsErrors: [],
  });
}

const earlyTable = {
  'Colorado Avalanche': avsRow,
  'Calgary Flames': flamesRow,
};
const earlyHealth = nhlHealth(earlyTable);
assert.strictEqual(earlyHealth.bySport.NHL.stats.outOfBand, 0);
assert.strictEqual(earlyHealth.bySport.NHL.stats.baselineTeams, 0);
assert.ok(!earlyHealth.alerts.some((a) => a.sport === 'NHL' && a.code === 'rate_out_of_band'));

const mixed = nhlHealth({
  ...earlyTable,
  'Winnipeg Jets': { pf: 6, pa: 4, games: 1, nhlSeasonGoals: true },
  'San Jose Sharks': poisonedGf,
});
assert.strictEqual(mixed.bySport.NHL.stats.outOfBand, 1, 'implausible still counts');
assert.strictEqual(mixed.bySport.NHL.stats.baselineTeams, 2, 'gp<2 and implausible are on the baseline');

withEnv({ OMEGA_NHL_SHRINK_MODE: 'off' }, () => {
  const offHealth = nhlHealth(earlyTable);
  assert.strictEqual(offHealth.bySport.NHL.stats.outOfBand, 2);
  assert.strictEqual(offHealth.bySport.NHL.stats.baselineTeams, 2);
  assert.ok(offHealth.alerts.some((a) => a.sport === 'NHL' && a.code === 'rate_out_of_band'));
});

// constant_total still flags a slate stuck on 6.2. Shrink does not remove the detector.
const flat = nhlHealth({}, [
  { sport: 'NHL', matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C', market: 'Total', side: 'Over 6.2', modelProjection: 6.2, line: 6.2 },
  { sport: 'NHL', matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E', market: 'Total', side: 'Under 6.2', modelProjection: 6.2, line: 6.2 },
]);
assert.ok(flat.alerts.some((a) => a.sport === 'NHL' && a.code === 'constant_total'));

console.log('test-omega-nhl-shrink-v2: ok');
