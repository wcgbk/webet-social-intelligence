// Shared live-score helpers for card pages and Netlify graders.
// Browser: <script src="/js/live-score.js"></script> → window.WeBetLive
// Node: require('../js/live-score') or deeper relative path.
//
// Doubleheader: respect commenceTime when it clearly picks one game.
// When the two starts are close in delta, or a timestamp is skewed toward a
// game that has not started, prefer the in/post game inside the 10h window.
// A leg that already has its own commenceTime is never overwritten, so a
// parlay and a straight can grade different games of the same matchup.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WeBetLive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ESPN_WEB_HOST = 'https://site.web.api.espn.com';
  var ESPN_API_HOST = 'https://site.api.espn.com';
  var WINDOW_MS = 10 * 3600 * 1000;
  var CLEAR_MARGIN_MS = 75 * 60 * 1000;
  var SPLIT_MS = 45 * 60 * 1000;
  var FUTURE_GUARD_MS = 15 * 60 * 1000;

  function normPick(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function scoreboardUrl(endpoint, query) {
    var q = '';
    if (query) q = query.charAt(0) === '?' ? query : ('?' + query);
    return ESPN_WEB_HOST + '/apis/site/v2/sports/' + endpoint + '/scoreboard' + q;
  }

  function fetchScoreboardJson(url) {
    var tries = [url];
    if (url && url.indexOf(ESPN_WEB_HOST) !== -1) tries.push(url.split(ESPN_WEB_HOST).join(ESPN_API_HOST));
    var i = 0;
    function next() {
      if (i >= tries.length) return Promise.resolve(null);
      var u = tries[i++];
      return fetch(u).then(function (resp) {
        if (resp && resp.ok) return resp.json();
        return next();
      }).catch(function () { return next(); });
    }
    return next();
  }

  // Prefer the game commenceTime clearly selects. Otherwise prefer in/post
  // over a still-pre nightcap so a skewed timestamp cannot hide a final.
  function disambiguateDoubleheader(matches, pick) {
    if (!matches || !matches.length) return null;
    if (matches.length === 1) return matches[0];
    var ct = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
    var pool = matches.slice();
    if (!isNaN(ct)) {
      var inWindow = pool.filter(function (g) {
        var gt = g && g.startISO ? Date.parse(g.startISO) : NaN;
        return !isNaN(gt) && Math.abs(gt - ct) <= WINDOW_MS;
      });
      if (inWindow.length) pool = inWindow;
    }
    if (pool.length === 1) return pool[0];

    var scored = pool.map(function (g) {
      var gt = g && g.startISO ? Date.parse(g.startISO) : NaN;
      var diff = (isNaN(ct) || isNaN(gt)) ? Infinity : Math.abs(gt - ct);
      var started = !!(g && (g.state === 'in' || g.state === 'post'));
      return { g: g, diff: diff, started: started, gt: isNaN(gt) ? Infinity : gt };
    });
    scored.sort(function (a, b) { return a.diff - b.diff || a.gt - b.gt; });
    var best = scored[0];
    var second = scored[1];
    if (!isFinite(best.diff)) {
      var startedOnly = scored.filter(function (s) { return s.started; }).sort(function (a, b) { return a.gt - b.gt; });
      return (startedOnly[0] || scored[0]).g;
    }
    var margin = (second ? second.diff : Infinity) - best.diff;
    if (margin >= CLEAR_MARGIN_MS) return best.g;
    if (!best.started) {
      var started = scored.filter(function (s) { return s.started; }).sort(function (a, b) {
        return a.diff - b.diff || a.gt - b.gt;
      });
      if (started.length) return started[0].g;
    }
    return best.g;
  }

  // One candidate: do not settle a still-future pick on an already-final game.
  // Two or more: disambiguate (a clear nightcap stays on the pre/in game).
  function resolveDoubleheader(matches, pick, nowMs) {
    if (!matches || !matches.length) return null;
    var now = (nowMs == null) ? Date.now() : nowMs;
    if (matches.length === 1) {
      var g = matches[0];
      var pStart = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
      if (!isNaN(pStart) && pStart > now + FUTURE_GUARD_MS && g && g.state === 'post') return null;
      return g;
    }
    return disambiguateDoubleheader(matches, pick);
  }

  // Keep a leg's own commenceTime. Inherit from a straight only when every
  // candidate time is the same game. Split doubleheader times stay unset.
  function inheritCommenceTime(leg, picks) {
    if (!leg || leg.commenceTime) return leg;
    var sameMatchup = (picks || []).filter(function (p) {
      return normPick(p.matchup) === normPick(leg.matchup) && p.commenceTime;
    });
    var samePick = sameMatchup.filter(function (p) { return normPick(p.pick) === normPick(leg.pick); });
    var pool = samePick.length ? samePick : sameMatchup;
    var times = pool.map(function (p) { return Date.parse(p.commenceTime); }).filter(function (t) { return !isNaN(t); });
    if (!times.length) return leg;
    var span = Math.max.apply(null, times) - Math.min.apply(null, times);
    if (span > SPLIT_MS) return leg;
    var copy = {};
    for (var k in leg) if (Object.prototype.hasOwnProperty.call(leg, k)) copy[k] = leg[k];
    copy.commenceTime = pool[0].commenceTime;
    return copy;
  }

  function sameGradeTarget(a, b) {
    if (!a || !b) return false;
    if (normPick(a.pick) !== normPick(b.pick)) return false;
    if (a.matchup && b.matchup && normPick(a.matchup) !== normPick(b.matchup)) return false;
    var ta = a.commenceTime ? Date.parse(a.commenceTime) : NaN;
    var tb = b.commenceTime ? Date.parse(b.commenceTime) : NaN;
    if (!isNaN(ta) && !isNaN(tb) && Math.abs(ta - tb) > SPLIT_MS) return false;
    return true;
  }

  function wholeUp(n) { return Math.ceil((n || 0) - 1e-9); }

  function parlayWinAmount(risk, oddsList) {
    var decimalProduct = 1;
    for (var i = 0; i < oddsList.length; i++) {
      var odds = parseInt(String(oddsList[i] || '-110').replace(/[^0-9+-]/g, ''), 10);
      if (isNaN(odds)) decimalProduct *= 1.909;
      else decimalProduct *= odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
    }
    return wholeUp(risk * (decimalProduct - 1));
  }

  function parlayOutcome(statuses, risk, oddsList) {
    if (!statuses || statuses.length < 2) return { result: 'skip', profit: 0 };
    if (statuses.indexOf('loss') !== -1) return { result: 'loss', profit: -risk };
    if (statuses.indexOf('pending') !== -1) return { result: 'pending', profit: 0 };
    if (statuses.every(function (s) { return s === 'win'; })) {
      return { result: 'win', profit: parlayWinAmount(risk, oddsList) };
    }
    var kept = [];
    for (var i = 0; i < statuses.length; i++) if (statuses[i] !== 'push') kept.push(i);
    if (!kept.length) return { result: 'push', profit: 0 };
    if (kept.every(function (i) { return statuses[i] === 'win'; })) {
      return { result: 'win', profit: parlayWinAmount(risk, kept.map(function (i) { return oddsList[i]; })) };
    }
    return { result: 'pending', profit: 0 };
  }

  function ledgerTotals(straights, parlay) {
    var wins = 0, losses = 0, pushes = 0, pending = 0, profit = 0, wagered = 0;
    (straights || []).forEach(function (s) {
      if (s.status === 'win') { wins++; profit += s.winAmt; wagered += s.risk; }
      else if (s.status === 'loss') { losses++; profit -= s.risk; wagered += s.risk; }
      else if (s.status === 'push') pushes++;
      else pending++;
    });
    var parlayResult = 'skip';
    var parlayProfit = 0;
    if (parlay && parlay.legs && parlay.legs.length >= 2) {
      var statuses = parlay.legs.map(function (l) { return l.status; });
      var outcome = parlayOutcome(statuses, parlay.risk, parlay.legs.map(function (l) { return l.odds; }));
      parlayResult = outcome.result;
      parlayProfit = outcome.profit;
      if (parlayResult !== 'pending' && parlayResult !== 'skip') {
        profit += parlayProfit;
        wagered += parlay.risk;
      }
    }
    return {
      wins: wins, losses: losses, pushes: pushes, pending: pending,
      profit: Math.round(profit), wagered: Math.round(wagered),
      parlayResult: parlayResult, parlayProfit: parlayProfit,
    };
  }

  // Replace the server's copy of today with the card's graded today.
  // Historical days stay on the snapshot.
  function mergeTodayKpi(snapshot, today) {
    if (!today) return null;
    var straight = (snapshot && snapshot.straight) || { wins: 0, losses: 0 };
    var cum = (snapshot && snapshot.cumulative) || { totalProfit: 0, totalWagered: 0 };
    var day = null;
    if (today.date && snapshot && snapshot.days) {
      for (var i = 0; i < snapshot.days.length; i++) {
        if (snapshot.days[i].date === today.date) { day = snapshot.days[i]; break; }
      }
    }
    var wins = (straight.wins || 0) - (day ? (day.wins || 0) : 0) + (today.wins || 0);
    var losses = (straight.losses || 0) - (day ? (day.losses || 0) : 0) + (today.losses || 0);
    var profit = Math.round((cum.totalProfit || 0) - (day ? (day.profit || 0) : 0) + (today.profit || 0));
    var wagered = Math.round((cum.totalWagered || 0) - (day ? (day.wagered || 0) : 0) + (today.wagered || 0));
    var decided = wins + losses;
    var accuracy = decided > 0 ? ((wins / decided) * 100).toFixed(1) + '%' : '0%';
    var roiNum = wagered > 0 ? (profit / wagered) * 100 : 0;
    var roi = wagered > 0 ? roiNum.toFixed(1) + '%' : '0%';
    var tDecided = (today.wins || 0) + (today.losses || 0);
    return {
      wins: wins, losses: losses, profit: profit, wagered: wagered,
      accuracy: accuracy, roi: roi, roiNum: roiNum,
      todayWins: today.wins || 0, todayLosses: today.losses || 0, todayPushes: today.pushes || 0,
      todayProfit: today.profit || 0,
      todayAcc: tDecided > 0 ? Math.round((today.wins / tDecided) * 100) : 0,
    };
  }

  function paintKpi(view) {
    if (typeof document === 'undefined' || !view) return;
    var rec = document.getElementById('cum-record');
    if (rec) rec.textContent = view.wins + '-' + view.losses;
    var acc = document.getElementById('cum-accuracy');
    if (acc) acc.textContent = view.accuracy;
    var hero = document.getElementById('hero-accuracy');
    if (hero) { hero.textContent = view.accuracy + ' Accuracy'; hero._set = true; }
    var profitEl = document.getElementById('cum-profit');
    if (profitEl) {
      var profit = view.profit || 0;
      profitEl.textContent = (profit >= 0 ? '+$' : '-$') + Math.abs(profit).toLocaleString();
      profitEl.className = 'cum-value ' + (profit >= 0 ? 'positive' : 'negative');
    }
    var roiEl = document.getElementById('cum-roi');
    if (roiEl) {
      roiEl.textContent = view.roi;
      roiEl.className = 'cum-value ' + ((view.roiNum || 0) >= 0 ? 'positive' : 'negative');
    }
    var tRec = document.getElementById('today-kpi-record');
    if (tRec) {
      var pushes = view.todayPushes ? ('-' + view.todayPushes + 'P') : '';
      tRec.textContent = view.todayWins + 'W-' + view.todayLosses + 'L' + pushes;
    }
    var tAcc = document.getElementById('today-kpi-acc');
    if (tAcc) tAcc.textContent = view.todayAcc + '%';
    var tProfit = document.getElementById('today-kpi-profit');
    if (tProfit) {
      var tp = view.todayProfit || 0;
      tProfit.textContent = (tp >= 0 ? '+$' : '-$') + Math.abs(tp).toLocaleString();
      tProfit.className = tp >= 0 ? 'profit-positive' : 'profit-negative';
    }
  }

  return {
    ESPN_WEB_HOST: ESPN_WEB_HOST,
    ESPN_API_HOST: ESPN_API_HOST,
    WINDOW_MS: WINDOW_MS,
    CLEAR_MARGIN_MS: CLEAR_MARGIN_MS,
    scoreboardUrl: scoreboardUrl,
    fetchScoreboardJson: fetchScoreboardJson,
    disambiguateDoubleheader: disambiguateDoubleheader,
    resolveDoubleheader: resolveDoubleheader,
    inheritCommenceTime: inheritCommenceTime,
    sameGradeTarget: sameGradeTarget,
    parlayOutcome: parlayOutcome,
    ledgerTotals: ledgerTotals,
    mergeTodayKpi: mergeTodayKpi,
    paintKpi: paintKpi,
  };
});
