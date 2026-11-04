'use strict';
/**
 * NCAAM (basketball_ncaab). No separate Odds pull: the 3 AM / 10 AM
 * odds-master board already stores the games.
 *
 * Fewer than MIN_GP games on either club: pModel is the de-vigged sharp
 * fair (Pinnacle, else Circa, else the other sharp books). A home-court
 * guess is not a bet. Once both clubs have MIN_GP, the margin is the
 * standings point differential plus HFA, blended toward that fair
 * (weight 0.35). v2 shrink runs after this.
 */
const {
  formatMatchup, mapGamesSoft, fuzzyTeam, gamesPlayed, powerFromStandings,
  spreadCoverProb, totalCoverProb, mlFromSpread, blendWithMarket, LEAGUE_PPG,
} = require('./_common');
const { HFA } = require('../config');
const {
  collectMarketOutcomes, collectLinesForEdge, enrichCandidateWithEdge, noVigPinnacleCircaImplied,
} = require('../edge');

const SPORT = 'NCAAM';
const MIN_GP = 5;
const BLEND_W = 0.35;

function teamPower(name, standings) {
  const st = fuzzyTeam(name, standings || {});
  const g = gamesPlayed(st);
  if (!st || g < MIN_GP) return null;
  return { g, margin: powerFromStandings(st, SPORT) };
}

function projectGame(event, standings) {
  const home = event.home_team;
  const away = event.away_team;
  const commenceTime = event.commence_time;
  const hp = teamPower(home, standings);
  const ap = teamPower(away, standings);
  const anchored = !hp || !ap;
  const hfa = Number(HFA.NCAAM);
  const modelMargin = anchored ? (Number.isFinite(hfa) ? hfa : 3.1) : (hp.margin - ap.margin) + hfa;
  const leagueTotal = 2 * (LEAGUE_PPG.NCAAM || 73);
  const modelTotal = leagueTotal;
  const out = [];

  const emit = (bundles, build) => {
    for (const b of bundles) {
      const built = build(b);
      if (!built) continue;
      const fair = noVigPinnacleCircaImplied(bundles, b);
      // Opening-night games have no standings. A home-court guess is not a bet.
      if (anchored && fair == null) continue;
      let p = built.pModel;
      if (fair != null && (anchored || !Number.isFinite(p))) p = fair;
      else if (fair != null) p = blendWithMarket(p, fair, BLEND_W);
      out.push(enrichCandidateWithEdge({
        sport: SPORT,
        homeTeam: home,
        awayTeam: away,
        matchup: formatMatchup(away, home),
        commenceTime,
        market: built.market,
        side: built.side,
        line: built.line,
        modelRawP: p,
        projMethod: anchored ? 'ncaam-sharp-anchor' : 'ncaam-standings',
        uncertainty: anchored ? 0.30 : 0.18,
        modelProjection: +modelMargin.toFixed(2),
        sharpAnchor: anchored,
      }, b, bundles));
    }
  };

  emit(collectMarketOutcomes(event, 'h2h'), (b) => {
    const isHome = b.side === home;
    const p = isHome ? mlFromSpread(modelMargin, SPORT) : 1 - mlFromSpread(modelMargin, SPORT);
    return { market: 'Moneyline', side: b.side, line: null, pModel: p };
  });
  emit(collectLinesForEdge(event, 'spreads'), (b) => {
    if (b.point == null) return null;
    const isHome = b.side === home;
    const p = spreadCoverProb(isHome ? modelMargin : -modelMargin, b.point, SPORT);
    const side = b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`;
    return { market: 'Spread', side, line: b.point, pModel: p };
  });
  emit(collectLinesForEdge(event, 'totals'), (b) => {
    if (b.point == null) return null;
    const p = totalCoverProb(modelTotal, b.point, b.side, SPORT);
    return { market: 'Total', side: `${b.side} ${b.point}`, line: b.point, pModel: p };
  });
  return out;
}

function project({ oddsEvents, standings } = {}) {
  return mapGamesSoft(oddsEvents, (ev) => projectGame(ev, standings || {}));
}

module.exports = { project, SPORT, MIN_GP, BLEND_W };
