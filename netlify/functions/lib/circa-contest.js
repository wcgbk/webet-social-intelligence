// Circa Million VIII — NFL-only contest calendar, card selection, pending payload.
// Official: https://www.circasports.com/circa-million
// 5 NFL ATS picks/week, 1 pt cover / 0.5 push, no juice. Lines Thu ~10:00 AM PT
// (Thanksgiving week Wed Nov 25 10am PT; Christmas week Wed Dec 23 10am PT).
// Picks due Sat 4:00 PM PT, or before the earliest selected kickoff.

const CONTEST = {
  name: "Circa Million VIII",
  seasonYear: 2026,
  totalWeeks: 18,
  modelVersion: "v1.0-circa-million-viii",
  officialUrl: "https://www.circasports.com/circa-million",
  week1Thursday: "2026-09-10",
  week1Open: "2026-09-09",
  registrationDeadline: "Saturday, September 12, 2026 at 2:00 PM PT",
  earlyCoverGap: 0.04,
  storeName: "edge-picks-circa",
};

// PT calendar dates when Circa posts lines on Wednesday instead of Thursday.
const HOLIDAY_LINES_POST = {
  "2026-11-25": { label: "Thanksgiving week" },
  "2026-12-23": { label: "Christmas week" },
};

const DEFAULT_STRATEGY =
  "Contest scoring pays 1 point per cover and 0.5 per push with no juice, so this card ranks NFL spreads by calibrated cover probability rather than dollar EV. Circa Sports' posted number is used when the Odds API carries it; otherwise the card notes a Pinnacle/consensus substitute. Thursday Night and other kickoffs before Saturday 4:00 PM PT are avoided unless the cover-probability gap versus the next-best Sunday/late pick is at least 4 percentage points — an early game locks the entire 5-card before that kickoff and surrenders two days of information. Key numbers 3 and 7 are treated as contest gold. Season target is roughly 66 percent ATS, the pace that has cashed the top prize in prior Circa Million seasons.";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function diffDaysYmd(fromYmd, toYmd) {
  const [y1, m1, d1] = fromYmd.split("-").map(Number);
  const [y2, m2, d2] = toYmd.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

function ymdInTz(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function hmsInTz(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), min: g("minute"), s: g("second") };
}

// Interpret ymd + hour:minute as local civil time in tz → UTC Date.
function instantFromZoned(ymd, hour, minute, tz) {
  const [Y, M, D] = ymd.split("-").map(Number);
  let utc = Date.UTC(Y, M - 1, D, hour + 7, minute, 0);
  for (let i = 0; i < 6; i++) {
    const p = hmsInTz(new Date(utc), tz);
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, 0);
    const want = Date.UTC(Y, M - 1, D, hour, minute, 0);
    const delta = want - got;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

function formatShortDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}

function formatLongWeekday(ymd, weekdayKnown) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  const weekday = weekdayKnown || dt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = dt.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${weekday}, ${month} ${d}`;
}

function weekThursdayYmd(weekNum) {
  return addDaysYmd(CONTEST.week1Thursday, (weekNum - 1) * 7);
}
function weekSaturdayYmd(weekNum) {
  return addDaysYmd(weekThursdayYmd(weekNum), 2);
}
function weekMondayYmd(weekNum) {
  return addDaysYmd(weekThursdayYmd(weekNum), 4);
}

function holidayForWeek(weekNum) {
  const thu = weekThursdayYmd(weekNum);
  const wed = addDaysYmd(thu, -1);
  if (HOLIDAY_LINES_POST[wed]) return { date: wed, ...HOLIDAY_LINES_POST[wed] };
  return null;
}

function isHolidayLinesDay(ymd) {
  return !!HOLIDAY_LINES_POST[ymd];
}

function linesPostYmd(weekNum) {
  const hol = holidayForWeek(weekNum);
  return hol ? hol.date : weekThursdayYmd(weekNum);
}

function padWeek(n) {
  return `W${pad2(n)}`;
}

function weekKey(weekNum, year = CONTEST.seasonYear) {
  return `${year}-${padWeek(weekNum)}`;
}

function weekBlobKey(weekNumOrKey, year = CONTEST.seasonYear) {
  const key = typeof weekNumOrKey === "string" && weekNumOrKey.includes("-W")
    ? weekNumOrKey
    : weekKey(Number(weekNumOrKey), year);
  return `picks-week-${key}`;
}

function parseWeekQuery(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-W(\d{1,2})$/i);
  if (m) {
    const weekNum = Number(m[2]);
    if (weekNum >= 1 && weekNum <= 18) return { year: Number(m[1]), weekNum, week: weekKey(weekNum, Number(m[1])) };
    return null;
  }
  m = s.match(/^W?(\d{1,2})$/i);
  if (m) {
    const weekNum = Number(m[1]);
    if (weekNum >= 1 && weekNum <= 18) return { year: CONTEST.seasonYear, weekNum, week: weekKey(weekNum) };
  }
  return null;
}

function resolveContestWeek(now = new Date()) {
  const ymd = ymdInTz(now, "America/Los_Angeles");
  let weekNum;
  if (HOLIDAY_LINES_POST[ymd]) {
    weekNum = Math.floor(diffDaysYmd(CONTEST.week1Thursday, addDaysYmd(ymd, 1)) / 7) + 1;
  } else if (ymd < CONTEST.week1Open) {
    weekNum = 1;
  } else if (ymd < CONTEST.week1Thursday) {
    weekNum = 1;
  } else {
    weekNum = Math.floor(diffDaysYmd(CONTEST.week1Thursday, ymd) / 7) + 1;
  }
  const inSeason = weekNum >= 1 && weekNum <= CONTEST.totalWeeks && ymd >= CONTEST.week1Open;
  const clamped = Math.min(CONTEST.totalWeeks, Math.max(1, weekNum));
  const preSeason = ymd < CONTEST.week1Open;
  const postSeason = weekNum > CONTEST.totalWeeks;
  return {
    year: CONTEST.seasonYear,
    weekNum: clamped,
    week: weekKey(clamped),
    ymd,
    inSeason: inSeason && !postSeason,
    preSeason,
    postSeason,
    holiday: holidayForWeek(clamped),
  };
}

function saturdayDeadline(weekNum) {
  return instantFromZoned(weekSaturdayYmd(weekNum), 16, 0, "America/Los_Angeles");
}

function isEarlyKickoff(commenceTime, weekNum) {
  if (!commenceTime) return false;
  const kick = new Date(commenceTime);
  if (Number.isNaN(kick.getTime())) return false;
  return kick < saturdayDeadline(weekNum);
}

function gameAlreadyStarted(commenceTime, now = new Date()) {
  if (!commenceTime) return true;
  const kick = new Date(commenceTime);
  if (Number.isNaN(kick.getTime())) return true;
  return kick <= now;
}

function weekLabel(weekNum) {
  const thu = weekThursdayYmd(weekNum);
  const mon = weekMondayYmd(weekNum);
  return `NFL Week ${weekNum}: ${formatShortDate(thu)} to ${formatShortDate(mon)}`;
}

function dateFormatted(weekNum) {
  const sat = weekSaturdayYmd(weekNum);
  return `Week ${weekNum} Card: ${formatLongWeekday(sat)}`;
}

function deadlineText(weekNum) {
  const hol = holidayForWeek(weekNum);
  const linesYmd = linesPostYmd(weekNum);
  const dueYmd = weekSaturdayYmd(weekNum);
  const linesDay = hol ? "Wednesday" : "Thursday";
  const holNote = hol ? ` (${hol.label})` : "";
  return `Week ${weekNum} lines post ${linesDay}, ${formatShortDate(linesYmd)} at 10:00 AM PT${holNote}. Picks due Saturday, ${formatShortDate(dueYmd)} at 4:00 PM PT. Selecting any game that kicks off before the deadline (Thursday Night Football, or Wednesday/Friday holiday games) requires submitting all 5 picks before that kickoff. This card prefers Sunday and late-window games, keeping the full information window open.`;
}

function linesPostShort(weekNum) {
  return holidayForWeek(weekNum) ? "Wed 10am PT" : "Thu 10am PT";
}

function pendingMessage(weekNum) {
  return `Week ${weekNum} card pending — lines post ${linesPostShort(weekNum)}; final card before Sat 4pm PT`;
}

function defaultKpis() {
  return { points: 0, wins: 0, losses: 0, pushes: 0, weeksPlayed: 0, totalWeeks: CONTEST.totalWeeks };
}

function defaultWeeks(currentWeekNum) {
  const out = [];
  for (let n = 1; n <= CONTEST.totalWeeks; n++) {
    const thu = weekThursdayYmd(n);
    const mon = weekMondayYmd(n);
    let status = "upcoming";
    if (n < currentWeekNum) status = "pending";
    else if (n === currentWeekNum) status = "pending";
    const thuS = formatShortDate(thu);
    const monS = formatShortDate(mon);
    const dates = thuS.slice(0, 3) === monS.slice(0, 3)
      ? `${thuS} to ${monS.split(" ")[1]}`
      : `${thuS} to ${monS}`;
    out.push({
      label: `Week ${n}`,
      dates,
      status,
      points: null,
      current: n === currentWeekNum,
    });
  }
  return out;
}

function pendingPayload(weekInfo, extras = {}) {
  const info = weekInfo && weekInfo.weekNum ? weekInfo : resolveContestWeek();
  const weekNum = info.weekNum;
  return {
    preview: false,
    pending: true,
    error: false,
    contest: CONTEST.name,
    weekLabel: weekLabel(weekNum),
    dateFormatted: dateFormatted(weekNum),
    deadline: deadlineText(weekNum),
    strategy: DEFAULT_STRATEGY,
    week: info.week || weekKey(weekNum),
    weekNum,
    picks: [],
    kpis: extras.kpis || defaultKpis(),
    weeks: extras.weeks || defaultWeeks(weekNum),
    modelVersion: CONTEST.modelVersion,
    generatedAt: null,
    pendingMessage: pendingMessage(weekNum),
    noPlays: pendingMessage(weekNum),
  };
}

function gameKeyOf(c) {
  if (c.gameKey) return c.gameKey;
  if (c.awayTeam && c.homeTeam) return `${c.awayTeam}@${c.homeTeam}`;
  return c.matchup || c.pick || "";
}

/**
 * Rank by calibrated cover probability. One pick per game, max 5.
 * Default-avoid kickoffs before Sat 4pm PT unless coverProb gap is large
 * (CONTEST.earlyCoverGap, 4pp). Fill-to-5 from early games if the late pool is short.
 * Never include a game that already started.
 */
function selectCircaCard(cands, opts = {}) {
  const now = opts.now || new Date();
  const weekNum = opts.weekNum || resolveContestWeek(now).weekNum;
  const deadline = opts.deadline || saturdayDeadline(weekNum);
  const gap = opts.earlyGap != null ? opts.earlyGap : CONTEST.earlyCoverGap;
  const maxPicks = opts.maxPicks || 5;

  const byGame = new Map();
  for (const c of cands || []) {
    if (!c) continue;
    if (gameAlreadyStarted(c.commenceTime, now)) continue;
    const key = gameKeyOf(c);
    if (!key) continue;
    const cur = byGame.get(key);
    if (!cur || Number(c.coverProb) > Number(cur.coverProb)) byGame.set(key, { ...c, gameKey: key });
  }

  const early = [];
  const late = [];
  for (const c of byGame.values()) {
    const kick = new Date(c.commenceTime);
    if (deadline && kick < deadline) early.push(c);
    else late.push(c);
  }
  const byCover = (a, b) => Number(b.coverProb) - Number(a.coverProb) || String(a.pick || "").localeCompare(String(b.pick || ""));
  late.sort(byCover);
  early.sort(byCover);

  const picked = late.slice(0, maxPicks);
  const used = new Set(picked.map(gameKeyOf));

  if (picked.length < maxPicks) {
    for (const c of early) {
      if (picked.length >= maxPicks) break;
      const k = gameKeyOf(c);
      if (used.has(k)) continue;
      picked.push({ ...c, earlyKickoff: true });
      used.add(k);
    }
  } else {
    for (const c of early) {
      picked.sort(byCover);
      const weakest = picked[picked.length - 1];
      if (Number(c.coverProb) < Number(weakest.coverProb) + gap) break;
      const k = gameKeyOf(c);
      if (used.has(k)) continue;
      used.delete(gameKeyOf(weakest));
      picked.pop();
      picked.push({ ...c, earlyKickoff: true });
      used.add(k);
    }
  }

  picked.sort(byCover);
  return picked.slice(0, maxPicks);
}

function coverToRating(coverProb) {
  const p = Number(coverProb);
  if (p >= 0.565) return "A+";
  if (p >= 0.55) return "A";
  if (p >= 0.535) return "A-";
  if (p >= 0.52) return "B+";
  return "B";
}

const RATING_TO_CONFIDENCE = { "A+": "aplus", "A": "a", "A-": "aminus", "B+": "bplus", "B": "b", "Lean": "lean" };

function nick(name) {
  if (!name) return "";
  const parts = String(name).trim().split(/\s+/);
  return parts[parts.length - 1];
}

function strategyForCard(picks, weekNum, lineNotes) {
  const early = (picks || []).filter((p) => p.earlyKickoff || isEarlyKickoff(p.commenceTime, weekNum));
  const circaN = (picks || []).filter((p) => p.lineSource === "circasports").length;
  const parts = [DEFAULT_STRATEGY];
  if (early.length) {
    parts.push(`Early-window exception: ${early.map((p) => p.pick).join(", ")} cleared the ${Math.round(CONTEST.earlyCoverGap * 100)}-point cover-probability gap versus the next-best Saturday/Sunday side, so the full card must be in before that kickoff.`);
  } else {
    parts.push("No Thursday Night / early kickoffs on this card — the Saturday 4:00 PM PT window stays open.");
  }
  if (circaN === (picks || []).length && picks.length) {
    parts.push("All five numbers are Circa Sports posted spreads.");
  } else if (circaN) {
    parts.push(`${circaN} of ${picks.length} numbers are Circa Sports posted; the rest use sharp/consensus because Circa was not on the Odds API for those games.`);
  } else if (picks && picks.length) {
    parts.push("Circa Sports was not on the Odds API for this slate — numbers are Pinnacle/consensus with a note on each card. Official contest lines should be confirmed at Circa before submitting.");
  }
  if (lineNotes) parts.push(lineNotes);
  return parts.join(" ");
}

/**
 * Intended Circa cron windows (UTC). Sep = PDT = UTC-7.
 *   Thu 17:15 — first card (10:15 AM PT)
 *   Fri 17:00 — refresh (10:00 AM PT)
 *   Sat 20:00 — final (1:00 PM PT)
 * Holiday: Wed 17:15 UTC on 2026-11-25 and 2026-12-23.
 * After DST (Nov) 17:15 UTC is 9:15 AM PST; Circa still posts ~10:00 AM PT — TODO if a PST-shifted cron is needed.
 */
function circaCronSlot(now = new Date(), slackMin = 12) {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const near = (h, m) => Math.abs(mins - (h * 60 + m)) <= slackMin;
  const ymdPT = ymdInTz(now, "America/Los_Angeles");
  if (day === 4 && near(17, 15)) return "first";
  if (day === 5 && near(17, 0)) return "refresh";
  if (day === 6 && near(20, 0)) return "final";
  if (day === 3 && near(17, 15) && HOLIDAY_LINES_POST[ymdPT]) return "holiday-first";
  return null;
}

module.exports = {
  CONTEST,
  HOLIDAY_LINES_POST,
  DEFAULT_STRATEGY,
  addDaysYmd,
  diffDaysYmd,
  ymdInTz,
  instantFromZoned,
  weekThursdayYmd,
  weekSaturdayYmd,
  weekMondayYmd,
  holidayForWeek,
  isHolidayLinesDay,
  linesPostYmd,
  weekKey,
  weekBlobKey,
  parseWeekQuery,
  resolveContestWeek,
  saturdayDeadline,
  isEarlyKickoff,
  gameAlreadyStarted,
  weekLabel,
  dateFormatted,
  deadlineText,
  linesPostShort,
  pendingMessage,
  defaultKpis,
  defaultWeeks,
  pendingPayload,
  selectCircaCard,
  coverToRating,
  RATING_TO_CONFIDENCE,
  nick,
  strategyForCard,
  circaCronSlot,
};
