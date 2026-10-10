'use strict';

/**
 * Intended America/New_York wall times for Netlify scheduled functions.
 * Netlify crons are UTC. Each job's cron fires both the EDT hour and the
 * EST hour; etGuard lets a scheduler invocation through only when the ET
 * clock matches one of these times (±10 min) and, when set, the ET weekday.
 *
 * Manual, HTTP, and internal calls do not carry a scheduler body. They
 * bypass the guard and keep the handler's existing behavior.
 *
 * Every-15-min jobs with no ET window are listed in SCHEDULE_NA and are not
 * guarded. capture-candidate-closes is every 15 minutes but DST-guarded to the ET window.
 * US Pacific jobs (Circa) are stored as ET. ET and PT switch DST together,
 * so an ET slot stays the same PT wall time all year.
 */

const TOLERANCE_MIN = 10;

/** Inclusive ET quarter-hours. end may be after midnight (next ET day). */
function quarterHourSlots(startHHMM, endHHMM) {
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMin(startHHMM);
  let end = toMin(endHHMM);
  if (end < start) end += 1440;
  const out = [];
  for (let t = start; t <= end; t += 15) {
    const m = t % 1440;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    out.push(`${hh}:${mm}`);
  }
  return out;
}

/** Inclusive ET half-hours. end may be after midnight (next ET day). */
function halfHourSlots(startHHMM, endHHMM) {
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMin(startHHMM);
  let end = toMin(endHHMM);
  if (end < start) end += 1440;
  const out = [];
  for (let t = start; t <= end; t += 30) {
    const m = t % 1440;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    out.push(`${hh}:${mm}`);
  }
  return out;
}

/** Every ET hour at one minute, 00 through 23. */
function hourlyAt(minute) {
  const mm = String(minute).padStart(2, '0');
  const out = [];
  for (let h = 0; h < 24; h += 1) out.push(`${String(h).padStart(2, '0')}:${mm}`);
  return out;
}

/** @type {Record<string, {etTimes: string[], days?: number[]}>} */
const ET_SCHEDULE = {
  'trigger-picks-alpha': { etTimes: ['09:00'] },
  'trigger-picks-omega': { etTimes: ['09:30'] },
  'verify-picks-omega': { etTimes: ['10:30'] },
  // Every 30 min, 11:00–23:30 ET inclusive. Cron is the UTC union of EDT
  // (UTC-4) and EST (UTC-5): "0,30 15-23,0-4 * * *". etGuard drops the copy
  // that is outside this list (15:00 UTC is 11:00 EDT and 10:00 EST; 04:30 UTC
  // is 00:30 EDT and 23:30 EST). No slot sits in the 01:00 fall-back hour.
  'pregame-check-omega': { etTimes: halfHourSlots('11:00', '23:30') },
  'trigger-picks-nfl': { etTimes: ['09:05'] },
  // Current union cron, expressed as ET = UTC-4. The handler still no-ops
  // outside the real Thu/Fri/Sat/holiday PT windows.
  'trigger-picks-circa': {
    etTimes: [
      '13:00', '13:15', '13:30', '13:45',
      '14:00', '14:15', '14:30', '14:45',
      '16:00', '16:15', '16:30', '16:45',
    ],
    days: [3, 4, 5, 6],
  },
  'check-circa-card-health': {
    etTimes: [
      '13:05', '13:20', '13:35', '13:50',
      '14:05', '14:20', '14:35', '14:50',
      '16:05', '16:20', '16:35', '16:50',
    ],
    days: [3, 4, 5, 6],
  },
  // Circa ops: hourly frozen-card regrade + stuck-game alert (every ET hour at :40,
  // including 01:40 and 02:40). dstFold 'both' runs each copy of a repeated
  // fall-back wall time. Spring-forward has no 02:00 hour, so 02:40 does not
  // occur that morning. Cron stays "40 * * * *".
  'regrade-circa': { etTimes: hourlyAt(40), dstFold: 'both' },
  'trigger-picks-cfb': { etTimes: ['09:10'] },
  'confirm-starters-mlb': { etTimes: ['13:30'] },
  'trigger-clv': { etTimes: ['03:00', '13:00', '19:00'] },
  'capture-omega-lines': { etTimes: ['06:00', '07:30'] },
  'capture-omega-lines-late': { etTimes: ['09:00', '09:15'] },
  'warm-omega-feeds': { etTimes: ['09:00'] },
  'trigger-omega-shadow': { etTimes: ['09:05'] },
  'trigger-omega-nba-shadow': { etTimes: ['17:30'] },
  'trigger-omega-nba-shadow-grade': { etTimes: ['08:00'] },
  'capture-omega-pm-observer-open': { etTimes: ['08:30'] },
  'capture-omega-pm-observer': { etTimes: ['10:15'] },
  'capture-omega-walkforward': { etTimes: ['11:15'] },
  'capture-omega-walkforward-evening': { etTimes: ['19:45'] },
  'capture-opening-lines': { etTimes: ['06:00'] },
  // 11:30 ET through 01:30 ET next day, every 15 min. Cron is the UTC union
  // of EDT (UTC-4) and EST (UTC-5); etGuard drops the hours outside this list.
  // On the fall-back night the 1:00 hour occurs twice. dstFold 'later' keeps
  // the second (EST) occurrence so the slot still fires once.
  'capture-candidate-closes': { etTimes: quarterHourSlots('11:30', '01:30'), dstFold: 'later' },
  'verify-picks': { etTimes: ['10:30'] },
  'self-optimize': { etTimes: ['05:00'], days: [0] },
  'trigger-trend-monitor': { etTimes: ['21:00'] },
  'monitor-tsp-public-records': { etTimes: ['11:00'] },
  'admin-auto-draft': { etTimes: ['08:00'] },
};

/** Active crons that are not DST-sensitive. */
const SCHEDULE_NA = [
  { functionName: 'admin-queue-process', cron: '*/15 * * * *', et: 'N/A' },
];

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const value = headers[key];
    if (Array.isArray(value)) return String(value[0] || '');
    return value == null ? '' : String(value);
  }
  return '';
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try {
    return JSON.parse(event.body);
  } catch (_) {
    return {};
  }
}

/**
 * Scheduler invoke. Netlify posts JSON { next_run }. The NBA shadow wrappers
 * also treat X-NF-Event: schedule and the Netlify Clockwork user-agent as
 * a schedule. Anything else is manual/HTTP/internal and bypasses the guard.
 */
function isSchedulerEvent(event) {
  const body = readBody(event);
  if (body && body.next_run != null && String(body.next_run) !== '') return true;
  const nf = header(event, 'x-nf-event').toLowerCase();
  if (nf === 'schedule' || nf === 'scheduled') return true;
  if (/netlify clockwork/i.test(header(event, 'user-agent'))) return true;
  return false;
}

function etParts(now) {
  const when = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const piece of fmt.formatToParts(when)) {
    if (piece.type !== 'literal') parts[piece.type] = piece.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    weekday: WEEKDAY[parts.weekday],
    et: `${hh}:${mm}`,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function minuteDistance(a, b) {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1440 - raw);
}

function closestEtSlot(etMinutes, etTimes) {
  let best = null;
  let bestDist = TOLERANCE_MIN + 1;
  for (const slot of etTimes || []) {
    const dist = minuteDistance(etMinutes, minutesOf(slot));
    if (dist <= TOLERANCE_MIN && dist < bestDist) {
      best = slot;
      bestDist = dist;
    }
  }
  return best;
}

function offsetMinutes(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
    hour: '2-digit',
  });
  const tz = fmt.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(tz ? tz.value : '');
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * True on the first copy of a repeated ET wall time (US fall-back).
 * The same YYYY-MM-DD HH:MM exists one hour later at the standard offset.
 * Spring-forward and ordinary days are not a fold.
 */
function isEarlierDstFold(now) {
  const when = now instanceof Date ? now : new Date(now);
  const wall = etParts(when);
  const off = offsetMinutes(when);
  if (off == null) return false;
  const other = new Date(when.getTime() + 60 * 60 * 1000);
  const ahead = etParts(other);
  const aheadOff = offsetMinutes(other);
  return ahead.ymd === wall.ymd && ahead.et === wall.et && aheadOff != null && aheadOff !== off;
}

function etGuard(functionName, event, now = new Date()) {
  const parts = etParts(now);
  const scheduler = isSchedulerEvent(event);
  const base = {
    scheduler,
    function: functionName,
    et: parts.et,
    ymd: parts.ymd,
    weekday: parts.weekday,
    matched: null,
  };
  if (!scheduler) return { ...base, run: true, reason: 'not-scheduler' };
  const spec = ET_SCHEDULE[functionName];
  if (!spec) return { ...base, run: false, reason: 'no-et-schedule' };
  if (Array.isArray(spec.days) && spec.days.indexOf(parts.weekday) === -1) {
    return { ...base, run: false, reason: 'outside-et-weekday' };
  }
  const matched = closestEtSlot(parts.hour * 60 + parts.minute, spec.etTimes);
  if (!matched) return { ...base, run: false, reason: 'outside-et-slot' };
  if (spec.dstFold === 'later' && isEarlierDstFold(now)) {
    return { ...base, run: false, reason: 'dst-fold', matched };
  }
  // Explicit: the first copy of a repeated ET wall time still runs.
  // The later copy is an ordinary et-match. 'later' above keeps skipping.
  if (spec.dstFold === 'both' && isEarlierDstFold(now)) {
    return { ...base, run: true, reason: 'dst-fold-both', matched };
  }
  return { ...base, run: true, reason: 'et-match', matched };
}

function rejectUnlessEtSlot(functionName, event, now = new Date()) {
  const guard = etGuard(functionName, event, now);
  if (!guard.scheduler || guard.run) return null;
  console.log(`[et-guard] ${functionName} skip reason=${guard.reason} et=${guard.et} weekday=${guard.weekday}`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      skipped: 'et-guard',
      function: functionName,
      reason: guard.reason,
      et: guard.et,
      weekday: guard.weekday,
    }),
  };
}

function cardGeneratedOnEtDate(card, dateET) {
  if (!card || typeof card !== 'object' || !card.generatedAt) return false;
  const when = new Date(card.generatedAt);
  if (Number.isNaN(when.getTime())) return false;
  return etParts(when).ymd === String(dateET || '');
}

/**
 * ET wall minutes of the morning Omega slot minus the guard tolerance.
 * 09:30 - TOLERANCE_MIN = 09:20. A card written at or after that minute
 * is the 9:30 run (or a later same-day write). Earlier same-day cards
 * are overnight or pre-window and must still be rebuilt.
 */
function morningCardCutoffMin() {
  const slot = ET_SCHEDULE['trigger-picks-omega'].etTimes[0];
  return minutesOf(slot) - TOLERANCE_MIN;
}

function cardFromMorningRun(card, dateET) {
  if (!cardGeneratedOnEtDate(card, dateET)) return false;
  const parts = etParts(new Date(card.generatedAt));
  return parts.hour * 60 + parts.minute >= morningCardCutoffMin();
}

/**
 * Scheduler-only morning idempotency for the Omega card.
 * Skip only when generatedAt falls on today's ET date and the ET wall
 * time is at/after 09:20 (09:30 minus TOLERANCE_MIN): this morning's run
 * already wrote the card. An earlier same-day card does not skip. The
 * 9:30 invoke still force-rebuilds it. A read error does not skip; the
 * ET guard alone is the double-run protection. Manual/HTTP never reads.
 */
async function morningCardIdempotency(event, now, readCard) {
  const guard = etGuard('trigger-picks-omega', event, now);
  if (!guard.scheduler || !guard.run) return { skip: false, guard };
  const dateET = guard.ymd;
  let card;
  try {
    card = await readCard(dateET);
  } catch (_) {
    return { skip: false, guard, readError: true, dateET };
  }
  if (cardFromMorningRun(card, dateET)) {
    return { skip: true, reason: 'already-generated', dateET, guard };
  }
  return { skip: false, guard, dateET };
}

function idempotencySkipResponse(result) {
  console.log(`[et-guard] trigger-picks-omega skip reason=${result.reason} date=${result.dateET}`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      skipped: 'et-guard',
      function: 'trigger-picks-omega',
      reason: result.reason,
      date: result.dateET,
    }),
  };
}

/** EDT hour (UTC-4) and EST hour (UTC-5) for an ET HH:MM. */
function utcHoursForEt(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return { minute: m, hours: [(h + 4) % 24, (h + 5) % 24] };
}

function parseCronField(field, min, max) {
  const set = new Set();
  const text = String(field || '').trim();
  if (text === '*' || text === '?') {
    for (let i = min; i <= max; i += 1) set.add(i);
    return set;
  }
  for (const part of text.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let start;
    let end;
    if (range === '*') {
      start = min;
      end = max;
    } else if (range.indexOf('-') !== -1) {
      const bits = range.split('-').map(Number);
      start = bits[0];
      end = bits[1];
    } else {
      start = Number(range);
      end = Number(range);
    }
    for (let value = start; value <= end; value += step) set.add(value);
  }
  return set;
}

function parseCron(expr) {
  const bits = String(expr || '').trim().split(/\s+/);
  if (bits.length < 5) throw new Error(`bad cron: ${expr}`);
  return {
    expr: bits.slice(0, 5).join(' '),
    minute: parseCronField(bits[0], 0, 59),
    hour: parseCronField(bits[1], 0, 23),
    dom: parseCronField(bits[2], 1, 31),
    month: parseCronField(bits[3], 1, 12),
    dow: parseCronField(bits[4], 0, 7),
  };
}

function cronMatches(cron, date) {
  const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
  const when = date instanceof Date ? date : new Date(date);
  const dow = when.getUTCDay();
  const dowOk = parsed.dow.has(dow) || (dow === 0 && parsed.dow.has(7));
  const domOk = parsed.dom.has(when.getUTCDate());
  const domStar = parsed.dom.size === 31;
  const dowStar = parsed.dow.size >= 7;
  let dayOk = false;
  if (domStar && dowStar) dayOk = true;
  else if (domStar) dayOk = dowOk;
  else if (dowStar) dayOk = domOk;
  else dayOk = domOk || dowOk;
  return dayOk
    && parsed.minute.has(when.getUTCMinutes())
    && parsed.hour.has(when.getUTCHours())
    && parsed.month.has(when.getUTCMonth() + 1);
}

/**
 * Active `schedule = "..."` lines in a netlify.toml text.
 * Commented schedules are ignored. Returns [{functionName, cron}].
 */
function activeTomlSchedules(tomlText) {
  const text = String(tomlText || '');
  const out = [];
  const header = /\[functions\."([^"]+)"\]/g;
  const headers = [];
  let match;
  while ((match = header.exec(text))) {
    headers.push({ name: match[1], index: match.index, end: match.index + match[0].length });
  }
  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i].end;
    const stop = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const block = text.slice(start, stop);
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const found = trimmed.match(/^schedule\s*=\s*"([^"]+)"/);
      if (found) out.push({ functionName: headers[i].name, cron: found[1] });
    }
  }
  return out;
}

module.exports = {
  TOLERANCE_MIN,
  ET_SCHEDULE,
  SCHEDULE_NA,
  isSchedulerEvent,
  etParts,
  etGuard,
  rejectUnlessEtSlot,
  cardGeneratedOnEtDate,
  morningCardIdempotency,
  idempotencySkipResponse,
  utcHoursForEt,
  halfHourSlots,
  parseCron,
  cronMatches,
  activeTomlSchedules,
};
