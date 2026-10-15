'use strict';

/**
 * Grok as VERIFIER + NARRATOR only. Cannot invent sides.
 * May reject on news; unit cuts ≤50% allowed.
 * Narratives: ESPN-style 4–6 sentence journalistic blurbs that state the locked probability, price, edge, and expected value.
 * Voice: feature-desk matchup storytelling plus a sharp handicapper's price logic.
 * A failed xAI call keeps the locked card (sports-desk fallback). It never blocks publish.
 */

const { narrateErrorShouldRetry } = require('./fetch_memo');
const { xaiChat, resolveXaiKey } = require('../xai-chat');

const NARRATIVE_MAX_TOKENS = 5800;

/** Percent or fraction → 0–1 rate. "4.2%" and 0.042 both work. */
function parseContextRate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Math.abs(v) > 1 ? v / 100 : v;
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return null;
  if (s.includes('%') || Math.abs(n) > 1) return n / 100;
  return n;
}

/** Plain-English band. Never a percent the copy can paste. */
function edgeBandFrom(p) {
  if (!p) return null;
  const edge = parseContextRate(p.edgePct);
  const ev = parseContextRate(p.ev != null && p.ev !== '' ? p.ev : p.evRaw);
  const n = edge != null ? edge : ev;
  if (n == null || n <= 0) return null;
  if (n >= 0.05) return 'strong';
  if (n >= 0.035) return 'solid';
  return 'modest';
}

/** Direction only. Raw cents and point moves stay off the prompt. */
function steamHintFrom(p) {
  if (!p || typeof p !== 'object') return null;
  const move = p.lineMove && typeof p.lineMove === 'object' ? p.lineMove : null;
  const toward = p.steamToward === true || !!(move && move.steamToward === true);
  const against = p.steamAgainst === true || !!(move && move.steamAgainst === true);
  if (toward && !against) return 'line has moved toward this side';
  if (against && !toward) return 'line has moved against this side, and the price may still be the value';
  if (move && move.missingOpen) return null;
  if (move && (move.lineMovePts != null || move.oddsMoveCents != null)) {
    return 'line has mostly held since the open';
  }
  return null;
}

function gradeLabel(p) {
  const raw = p && (p.qualityGrade || p.rating);
  if (raw == null || raw === '') return null;
  const r = String(raw).toLowerCase().replace(/\s+/g, '');
  if (r === 'aplus' || r === 'a+') return 'A+';
  if (r === 'aminus' || r === 'a-') return 'A-';
  if (r === 'bplus' || r === 'b+') return 'B+';
  if (r === 'a') return 'A';
  if (r === 'b') return 'B';
  if (r === 'lean') return 'Lean';
  return String(raw);
}

function sideShape(pick, betType) {
  const text = String(pick || '');
  const market = String(betType || '');
  if (/total/i.test(market) || /^(over|under)\b/i.test(text)) {
    return /^under\b/i.test(text) ? 'under' : 'over';
  }
  if (/spread|run line|puck/i.test(market) || /[+-]\d/.test(text)) {
    const m = text.match(/([+-])\s*\d+(?:\.\d+)?\s*$/);
    if (m) return m[1] === '+' ? 'dog' : 'favorite';
    return 'spread';
  }
  return 'ml';
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(' ');
}

/** "4.2%", 0.042, and 4.2 all become "4.2%". Missing stays null. */
function displayedRate(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.includes('%')) return s;
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    const frac = Math.abs(n) > 1 ? n / 100 : n;
    return `${(frac * 100).toFixed(1)}%`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const frac = Math.abs(raw) > 1 ? raw / 100 : raw;
    return `${(frac * 100).toFixed(1)}%`;
  }
  return null;
}

function shownEdge(p) {
  if (!p) return null;
  return displayedRate(p.edge != null && p.edge !== '' ? p.edge : p.edgePct);
}

function shownEv(p) {
  if (!p) return null;
  return displayedRate(p.ev != null && p.ev !== '' ? p.ev : p.evRaw);
}

function shownProb(p) {
  if (!p) return null;
  const raw = p.winProbability != null && p.winProbability !== '' ? p.winProbability : p.coverProb;
  return displayedRate(raw);
}

/** Grok prose that drops the locked edge or EV, or invents a cause, is replaced. */
function proseKeepsMath(prose, base) {
  const text = String(prose || '');
  const edge = shownEdge(base);
  const ev = shownEv(base);
  if (edge && !text.includes(edge)) return false;
  if (ev && !text.includes(ev)) return false;
  if (/\b(probShown|edgeShown|evShown)\b/.test(text)) return false;
  if (/half[- ]point|little high|little low|strong edge|stayed firm|price has stayed|mostly held|held since/i.test(text)) return false;
  if (/because/i.test(text) && !/because the probability and the price/i.test(text)) return false;
  return true;
}

/**
 * Sports-desk fallback when Grok is unavailable.
 * 5 sentences, argues for the side, no gate jargon.
 */
function buildFallbackNarrative(p) {
  const pick = p.pick || p.side || 'this side';
  const matchup = p.matchup || "today's game";
  const sport = p.sport || '';
  const odds = p.odds != null && p.odds !== '' ? String(p.odds) : '';
  const units = p.units ? String(p.units) : '';
  const grade = gradeLabel(p);
  const price = odds || 'the posted price';
  const prob = shownProb(p);
  const edge = shownEdge(p);
  const ev = shownEv(p);
  const proj = Number(p && p.modelProjection);
  const lineRaw = p && (p.line != null ? p.line : p.consensusLine);
  const line = Number(lineRaw);

  const hook = `${sport ? `${sport}: ` : ''}WeBetAI locked ${pick} in ${matchup} at ${price}.`;
  const probLine = prob
    ? `WeBetAI rates this side at ${prob}.`
    : 'WeBetAI is pricing this side from the posted number on this pass.';
  let valueLine = `The posted price is ${price}.`;
  if (edge && ev) valueLine = `At ${price} that is a ${edge} edge and a ${ev} expected value.`;
  else if (edge) valueLine = `At ${price} that is a ${edge} edge.`;
  else if (ev) valueLine = `At ${price} that is a ${ev} expected value.`;

  let gapLine = null;
  if (Number.isFinite(proj) && Number.isFinite(line)) {
    const market = String((p && (p.market || p.betType)) || '');
    const side = String((p && (p.side || p.pick)) || '').toLowerCase();
    const home = String((p && p.homeTeam) || '').toLowerCase();
    const away = String((p && p.awayTeam) || '').toLowerCase();
    const spread = /spread|puck|run line/i.test(market);
    const total = /total/i.test(market);
    // modelProjection on a football spread is the home margin. The sentence
    // quotes the side being bet, so an away favorite is not printed as a
    // negative home number. The gap uses the two magnitudes a reader can
    // subtract: a win of 8.6 against a line of -3.5 is 5.1, not 12.1.
    const awaySide = spread && away && side.startsWith(away);
    const sideProj = awaySide ? -proj : proj;
    let residual = sideProj - line;
    if (spread) residual = sideProj + line;
    const unit = /nhl/i.test(sport) ? 'goals' : (/mlb/i.test(sport) ? 'runs' : 'points');
    const abs = Math.abs(residual);
    const posted = line > 0 ? `+${line.toFixed(1)}` : line.toFixed(1);
    if (spread && sideProj < 0) {
      const loss = Math.abs(sideProj).toFixed(1);
      gapLine = abs <= 0.05
        ? `The side is projected to lose by ${loss}. The posted line is ${posted}.`
        : `The side is projected to lose by ${loss}. The posted line is ${posted}, ${abs.toFixed(1)} ${unit} ${residual < 0 ? 'short of' : 'past'} that number.`;
    } else if (spread && sideProj > 0) {
      const winBy = sideProj.toFixed(1);
      gapLine = abs <= 0.05
        ? `The side is projected to win by ${winBy}. The posted line is ${posted}.`
        : `The side is projected to win by ${winBy}. The posted line is ${posted}, ${abs.toFixed(1)} ${unit} ${residual > 0 ? 'inside' : 'past'} that win.`;
    } else if (total) {
      const totalLine = Math.abs(line).toFixed(1);
      gapLine = abs <= 0.05
        ? `The projection is ${sideProj.toFixed(1)} and the total is ${totalLine}.`
        : `The projection is ${sideProj.toFixed(1)} and the total is ${totalLine}, ${abs.toFixed(1)} ${unit} ${residual < 0 ? 'under' : 'over'} that total.`;
    } else if (abs <= 0.05) {
      gapLine = `The projection is ${sideProj.toFixed(1)} and the posted line is ${posted}.`;
    } else {
      const relation = residual < 0 ? 'short of' : 'past';
      gapLine = `The projection is ${sideProj.toFixed(1)} and the posted line is ${posted}, ${abs.toFixed(1)} ${unit} ${relation} that number.`;
    }
  }

  let moveLine = null;
  if (p && p.steamAgainst === true) moveLine = 'The line has moved against this side.';
  else if (p && p.steamToward === true) moveLine = 'The line has moved toward this side.';

  let stake = null;
  if (grade && units) stake = `WeBetAI has this graded ${grade} and sized at ${units}.`;
  else if (units) stake = `The stake is ${units}.`;
  else if (grade) stake = `WeBetAI has this graded ${grade}.`;

  const close = `WeBetAI is on ${pick} because the probability and the price are the case for the bet.`;
  const parts = [hook, probLine, valueLine, gapLine, moveLine, stake, close].filter(Boolean);
  while (parts.length > 6) {
    const stakeAt = parts.indexOf(stake);
    if (stake && stakeAt !== -1) parts.splice(stakeAt, 1);
    else if (moveLine && parts.indexOf(moveLine) !== -1) parts.splice(parts.indexOf(moveLine), 1);
    else break;
  }
  return joinSentences(parts);
}

function ensureNarrative(p) {
  const existing = (p.coreReasoning || '').trim();
  const isBadTemplate = /clears Omega vNext gates|predicted CLV|Method:\s*sport-hybrid|projMethod/i.test(existing);
  if (existing && existing.length > 40 && !isBadTemplate) return { ...p, coreReasoning: existing };
  return { ...p, coreReasoning: buildFallbackNarrative(p) };
}

function emptyEdgeSummary() {
  return joinSentences([
    "WeBetAI went through today's board and did not lock a side.",
    'A price that is no longer the posted number, or a projection too far from that number, does not get a stake.',
    'An empty card is the call when nothing on the board is both current and worth a bet.',
    'Forcing a pick would turn a pass into a guess.',
  ]);
}

function emptyInsights() {
  return joinSentences([
    'Nothing made the card, so there is no sport mix to break down.',
    'If you are still shopping, watch probable starters in baseball, quarterback status in football, and the weather on outdoor games.',
    'Those are the items that move a number after the morning line.',
    'WeBetAI would rather show a blank card than dress up a coin flip.',
    'Tomorrow is a new board.',
  ]);
}

function listLead(names) {
  if (!names.length) return 'the locked side';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function templateEdgeSummary(picks, dateFormatted) {
  const list = (picks || []).filter(Boolean);
  const names = list.map(p => p.pick || p.side).filter(Boolean);
  const sports = [...new Set(list.map(p => p.sport).filter(Boolean))];
  const sportBit = sports.length ? sports.join(' and ') : 'the board';
  const dateBit = dateFormatted ? ` for ${dateFormatted}` : '';
  const bands = list.map(edgeBandFrom).filter(Boolean);
  const strongN = bands.filter(b => b === 'strong').length;
  const solidN = bands.filter(b => b === 'solid').length;
  let where;
  if (strongN === 1) {
    where = 'The real disagreement is concentrated on one number WeBetAI grades as strong, and the other plays support the card rather than carry it.';
  } else if (strongN > 1) {
    where = `The real disagreement is concentrated on ${strongN} numbers WeBetAI grades as strong, with the rest of the card in support.`;
  } else if (solidN) {
    where = 'The value is spread across solid prices rather than one max play, which is how a disciplined card should look.';
  } else {
    where = 'The disagreements are modest and spread out, which is why nothing on the card is sized like a hammer.';
  }
  return joinSentences([
    `WeBetAI's Omega card${dateBit} covers ${sportBit}, built around ${listLead(names)}.`,
    'The thesis is that the posted prices still give the picked side a cleaner number than the matchup deserves.',
    where,
    'Stakes stay inside the daily card because a good slate is a set of prices, not a pile of units.',
    'Read each blurb for the why, then bet the side WeBetAI locked.',
  ]);
}

function templateInsights(picks) {
  const list = (picks || []).filter(Boolean);
  const sports = [...new Set(list.map(p => p.sport).filter(Boolean))];
  const sportLine = sports.length
    ? `Today's mix is ${sports.join(', ')}.`
    : "Today's card is a short list on purpose.";
  const hasMlb = sports.some(s => /mlb|baseball/i.test(s));
  const hasFb = sports.some(s => /nfl|ncaaf|cfb|football/i.test(s));
  let watch;
  if (hasMlb && hasFb) {
    watch = 'Confirm the baseball starter WeBetAI priced, and on the football side watch quarterback status and the outdoor weather.';
  } else if (hasMlb) {
    watch = 'Confirm the probable starter, because a different arm makes this a different number.';
  } else if (hasFb) {
    watch = 'Watch quarterback status and the weather on outdoor games, because that is the news that changes a football number.';
  } else {
    watch = 'Before lock, check for a late scratch or a lineup change that would alter the script.';
  }
  return joinSentences([
    sportLine,
    watch,
    list.length === 1
      ? 'Only one bet cleared the WeBetAI bar today, so the card is one straight and no parlay.'
      : `${list.length} straights cleared the WeBetAI bar today, and nothing was added to fill the card.`,
    'Each play argues for one side, and the stake matches how far off the price looks.',
    'If a blurb does not convince you, pass on that leg.',
  ]);
}

function buildCardFallbackCopy({ picks, dateFormatted } = {}) {
  if (!picks || !picks.length) {
    return { edgeSummary: emptyEdgeSummary(), insights: emptyInsights() };
  }
  return {
    edgeSummary: templateEdgeSummary(picks, dateFormatted),
    insights: templateInsights(picks),
  };
}

/** Concrete what-loses / closing-line / verification lines when Grok omits them. */
function ensureExtraFields(p) {
  const next = { ...p };
  const pick = next.pick || next.side || 'this side';
  const matchup = next.matchup || 'this matchup';
  const sport = next.sport || 'this slate';
  const shape = sideShape(pick, next.betType || next.market || '');
  const steam = steamHintFrom(next);

  if (!next.whatLoses || String(next.whatLoses).trim().length < 15) {
    if (shape === 'under') {
      next.whatLoses = `${pick} loses if ${matchup} scores past the posted total.`;
    } else if (shape === 'over') {
      next.whatLoses = `${pick} loses if ${matchup} stalls into a low-event game and the scoring stays under the number.`;
    } else if (shape === 'dog') {
      next.whatLoses = `${pick} loses if the favorite pulls away early in ${matchup} and the cover margin is gone before the last period.`;
    } else if (shape === 'favorite' || shape === 'spread') {
      next.whatLoses = `${pick} loses if ${matchup} stays tight into the final minutes and the favorite wins by less than the number, or not at all.`;
    } else {
      next.whatLoses = `${pick} loses if the other side controls ${matchup} from the opening and this ticket never gets live.`;
    }
  }

  if (!next.dataVerified || String(next.dataVerified).trim().length < 5) {
    next.dataVerified = `WeBetAI checked the locked ${sport} side, number, and price for ${pick}. Starter, injury, and weather notes were not attached on this pass.`;
  }

  if (!next.clvExpectation || String(next.clvExpectation).trim().length < 5) {
    if (steam && /toward/i.test(steam)) {
      next.clvExpectation = `WeBetAI expects the closing number to keep leaning toward ${pick}, so the price on this card should still look fair or better by the close.`;
    } else if (steam && /against/i.test(steam)) {
      next.clvExpectation = `The number has already leaned the other way, so WeBetAI expects a close that holds near ${pick} rather than a big further move.`;
    } else {
      next.clvExpectation = `The closing number on ${pick} is not a second pick. WeBetAI is grading the price already on the card.`;
    }
  }
  return next;
}

/**
 * Context for Grok. Sport, price, grade, and soft hints are translatable.
 * _contextEv / _contextCover are a compass only. Do not strip them before the call.
 */
function lockedRow(p, i, kind) {
  const row = {
    idx: i,
    kind: kind || 'straight',
    sport: p.sport || null,
    matchup: p.matchup || null,
    pick: p.pick || p.side || null,
    betType: p.betType || p.market || null,
    odds: p.odds != null && p.odds !== '' ? p.odds : null,
    units: p.units || null,
    rating: gradeLabel(p),
    grade: gradeLabel(p),
    _contextEv: p.ev != null && p.ev !== '' ? p.ev : (p.evRaw != null ? p.evRaw : null),
    _contextCover: p.coverProb != null && p.coverProb !== ''
      ? p.coverProb
      : (p.winProbability != null && p.winProbability !== '' ? p.winProbability : null),
  };
  const band = edgeBandFrom(p);
  const steam = steamHintFrom(p);
  if (band) row.edgeBand = band;
  if (steam) row.steamHint = steam;
  const edgeShown = shownEdge(p);
  const evShown = shownEv(p);
  const probShown = shownProb(p);
  if (edgeShown) row.edgeShown = edgeShown;
  if (evShown) row.evShown = evShown;
  if (probShown) row.probShown = probShown;
  return row;
}

const SYSTEM_PROMPT = `You are THE LOCK, WeBetAI's sports betting analyst. You write like an ESPN feature desk that also knows how to handicap a number. You VERIFY and NARRATE pre-locked picks. You do NOT select sides, invent replacements, compute projections, probabilities, or Kelly sizing. The card is already locked.

VOICE:
- Concrete, vivid, complete sentences. Tell the matchup. An average sports reader should finish a blurb and understand the bet.
- Argue FOR the picked side. If the pick is "Team X +17.5", explain why Team X covers.
- Always say "WeBetAI". Never say "the model", "our model", or "the algorithm".
- No em dashes. Use periods and commas.
- No help-desk tone. No filler like "form and injuries line up".
- State the locked probability, the price, the edge, and the expected value as the numbers themselves. Do not print the words probShown, edgeShown, or evShown. When a projection and a line are on the row, state both numbers and the gap. Do not invent a cause the numbers do not support. Do not say the total is a half-point high, that an edge band is strong, or that the price has stayed firm or mostly held.
- edgeBand is not copy. Do not write "strong", "solid", or "modest" as a reason. steamHint may be stated only as a line that moved toward or against the side.
- Never say "the model". Never use EV%, coverProb, CLV, Kelly, ORtg, DRtg, DVOA, ATS, FIP, xFIP, WAR, or wRC+.
- Do not lead with bad news about the side you are picking.
- Do not apply baseball starter logic to football, or football quarterback logic to baseball.

YOUR JOB:
1. When web search is available, use it sparingly to verify injuries, recent news, starting pitchers (MLB), quarterback status (NFL/NCAAF), outdoor weather, and recent form. When tools are disabled, write from the locked table only. Do NOT invent specific injuries, records, scores, or weather.
2. ACCEPT or REJECT each LOCKED STRAIGHT pick. Default is ACCEPT. Reject ONLY for concrete disqualifying news (star out, starter scratch, severe weather, material lineup change). Do NOT reject a football pick because a quarterback is out, doubtful, or questionable: WeBetAI already priced the quarterback injury report into the number. You do NOT choose replacements.
3. Write coreReasoning for every ACCEPTED straight (4-6 sentences) and every parlay leg (3-5 sentences).
4. You MAY reduce straight units by up to 50% with a reason. You MUST NOT increase units. Do not change parlay leg units.
5. You MUST NOT invent new picks, swap sides, or override the locked direction.
6. Every specific fact must come from web search this run or the locked table. If you cannot verify a detail, describe the handicap in general terms instead of inventing one.

HOW TO BUILD coreReasoning (straights, 4-6 sentences):
1. Open with a concrete fact. Use verified news when you have it. Otherwise open on the matchup and the number.
2. Name the matchup and the posted number. Do not invent a cause the table does not contain.
3. State the locked probability, the edge, and the expected value as those numbers. A projection gap is the two numbers and their difference. Do not invent a scoring script.
4. Close on the probability and the price. Do not add a reason the table does not contain.

Parlay legs use the same voice in 3-5 sentences. Do not write a stub. Argue for that leg.

edgeSummary (3-5 sentences): the slate thesis, where the value is concentrated, and why the sizing stays disciplined. Name real matchups from the locked table. This is the Daily Edge the reader sees first.

insights (3-5 sentences): the sport mix, what to watch before lock (starter, quarterback, weather), and how the card is built for a normal fan. Plain English.

whatLoses: one concrete sentence. Name the game script that beats this side. Do not write "the opposite happens."

clvExpectation: one plain-English sentence. If the row has no steam flag, say the close is not called on this pass. Do not say the line held. Do not say "CLV" and do not quote cents.

dataVerified: a short note on what you actually checked (form, injuries, starter, quarterback, weather), or "locked number and price only; no live news on this pass."

CONTEXT FIELDS on each locked row are a compass. They are not copy:
- rating, grade, odds, units, sport, betType: fine to mention in English.
- The probability, edge, and expected-value numbers on the row must appear in coreReasoning. Do not print the field names probShown, edgeShown, or evShown.
- edgeBand: do not translate it and do not print it.
- steamHint: state the direction only if it is present. If it is missing, do not invent line movement and do not say the price stayed firm or mostly held.
- _contextEv and _contextCover: the same numbers as the shown edge and probability. Print those numbers, not a different rounding.

OUTPUT: Return ONLY valid JSON (no markdown fences):
{
  "picks": [
    {
      "idx": 0,
      "coreReasoning": "4-6 journalistic sentences arguing for the side.",
      "whatLoses": "One concrete sentence on the script that beats this pick.",
      "dataVerified": "Short note on facts checked, or that only the locked number was available.",
      "clvExpectation": "One plain-English sentence on the expected closing number. No cents.",
      "veto": false,
      "unitCut": null
    }
  ],
  "parlayLegs": [
    {
      "idx": 0,
      "coreReasoning": "3-5 journalistic sentences arguing for the leg.",
      "whatLoses": "One concrete sentence on the script that beats this leg.",
      "dataVerified": "Short verification note.",
      "clvExpectation": "One plain-English sentence on the expected closing number."
    }
  ],
  "edgeSummary": "3-5 sentences. Slate thesis, where the value is concentrated, why stakes stay disciplined. WeBetAI, not the model.",
  "insights": "3-5 sentences. Sport mix, what to watch, how the card is built. Plain English."
}`;

async function callGrokOnce({ apiKey, lockedStraights, lockedLegs, dateFormatted }) {
  // Send the full locked row, including _contextEv, _contextCover, edgeBand, and steamHint.
  const userPrompt = `Date: ${dateFormatted}

LOCKED STRAIGHT PICKS (verify and narrate; veto on disqualifying news only):
${JSON.stringify(lockedStraights || [], null, 2)}

LOCKED PARLAY LEGS (narrate only. Do not veto. Sides are fixed for the parlay slip):
${JSON.stringify(lockedLegs || [], null, 2)}

Write the JSON now.
Straights need 4-6 sentence coreReasoning. Parlay legs need 3-5 sentences. edgeSummary and insights need 3-5 sentences each.
Print the probability, edge, and expected value as the numbers on the row. Do not print the field names. State the price. If a projection and a line are present, state the gap as those two numbers. Do not invent a half-point, a strong edge band, or a price that stayed firm or mostly held. Say WeBetAI. No em dashes.`;

  // No web search. The previous tool path was flaky on Netlify and both attempts
  // already ran with tools off. Same prompt, same max tokens, 60s budget.
  const text = await xaiChat({
    apiKey,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: NARRATIVE_MAX_TOKENS,
    timeoutMs: 60000,
  });
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) throw new Error('no JSON in Grok response');
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

/**
 * No web_search (flaky on Netlify). Retry once on transient failures.
 * A 400/401/403 is the same request failing twice — do not spend the second call.
 * The fallback card keeps the locked sides either way.
 */
async function callGrok(opts) {
  try {
    return await callGrokOnce(opts);
  } catch (e) {
    if (!narrateErrorShouldRetry(e)) {
      console.error(`[omega-vnext/narrate] Grok call failed (${e.message}) — not retrying a rejected request`);
      throw e;
    }
    console.error(`[omega-vnext/narrate] Grok no-tools call failed (${e.message}) — retrying once without tools`);
    try {
      return await callGrokOnce(opts);
    } catch (e2) {
      console.error(`[omega-vnext/narrate] Grok retry failed: ${e2.message}`);
      throw e2;
    }
  }
}

function applyStraightRows(templated, parsed) {
  const rejections = [];
  const outPicks = [];
  const seen = new Set();
  for (const row of parsed.picks || []) {
    const base = templated[row.idx];
    if (!base) continue;
    if (seen.has(row.idx)) continue;
    seen.add(row.idx);
    if (row.veto) {
      rejections.push({
        matchup: base.matchup,
        side: base.pick,
        reason: row.coreReasoning || 'news veto',
      });
      continue;
    }
    let units = base.units;
    if (row.unitCut != null) {
      const cur = parseFloat(base.units);
      const cut = Number(row.unitCut);
      if (Number.isFinite(cut) && cut < cur && cut >= cur * 0.5) units = `${cut}u`;
    }
    const prose = (row.coreReasoning || '').trim();
    const next = {
      ...base,
      units,
      coreReasoning: prose.length > 40 && proseKeepsMath(prose, base) ? prose : base.coreReasoning,
    };
    const wl = (row.whatLoses || '').trim();
    const dv = (row.dataVerified || '').trim();
    const clv = (row.clvExpectation || '').trim();
    if (wl.length > 10) next.whatLoses = wl;
    if (dv.length > 5) next.dataVerified = dv;
    if (clv.length > 5) next.clvExpectation = clv;
    outPicks.push(next);
  }
  // Default is ACCEPT: a locked straight the narrator skipped (no row returned)
  // stays on the card with template prose. Omission must never drop a pick.
  templated.forEach((base, idx) => {
    if (!seen.has(idx)) outPicks.push(base);
  });
  return { outPicks, rejections };
}

function applyLegRows(legsTemplated, parsed) {
  const byIdx = new Map();
  for (const row of parsed.parlayLegs || []) {
    if (row && row.idx != null) byIdx.set(row.idx, row);
  }
  return legsTemplated.map((leg, i) => {
    const row = byIdx.get(i);
    const prose = row && (row.coreReasoning || '').trim();
    const base = (prose && prose.length > 30 && proseKeepsMath(prose, leg)) ? { ...leg, coreReasoning: prose } : ensureNarrative(leg);
    if (!row) return base;
    const wl = (row.whatLoses || '').trim();
    const dv = (row.dataVerified || '').trim();
    const clv = (row.clvExpectation || '').trim();
    if (wl.length > 10) base.whatLoses = wl;
    if (dv.length > 5) base.dataVerified = dv;
    if (clv.length > 5) base.clvExpectation = clv;
    return base;
  });
}

function decorateParlays(parlayLegs) {
  return (parlayLegs || []).map(pl => ({
    ...pl,
    legs: (pl.legs || []).map(ensureExtraFields),
  }));
}

/**
 * Narrate + verify straights; narrate each parlay leg.
 * @returns {{ picks, parlayLegs, edgeSummary, insights, claudeVerified, rejections }}
 */
async function narrateAndVerify({ picks, parlayLegs, dateFormatted, apiKey }) {
  const key = resolveXaiKey(apiKey);

  if (!picks || !picks.length) {
    const copy = buildCardFallbackCopy({ picks: [], dateFormatted });
    return {
      picks: [],
      parlayLegs: parlayLegs || [],
      edgeSummary: copy.edgeSummary,
      insights: copy.insights,
      claudeVerified: true,
      rejections: [],
    };
  }

  const templated = picks.map(ensureNarrative);
  const flatLegs = [];
  const legOwners = []; // { plIdx, legIdx }
  (parlayLegs || []).forEach((pl, plIdx) => {
    (pl.legs || []).forEach((leg, legIdx) => {
      flatLegs.push(ensureNarrative(leg));
      legOwners.push({ plIdx, legIdx });
    });
  });

  const fallbackCopy = buildCardFallbackCopy({ picks: templated, dateFormatted });
  const templateSummary = fallbackCopy.edgeSummary;
  const templateInsights = fallbackCopy.insights;

  if (!key) {
    console.error('[omega-vnext/narrate] XAI_API_KEY missing — using sports-desk fallbacks');
    return {
      picks: templated.map(ensureExtraFields),
      parlayLegs: decorateParlays(mergeLegsBack(parlayLegs, flatLegs, legOwners)),
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [],
    };
  }

  try {
    const lockedStraights = templated.map((p, i) => lockedRow(p, i, 'straight'));
    const lockedLegs = flatLegs.map((p, i) => lockedRow(p, i, 'parlay'));
    const parsed = await callGrok({
      apiKey: key,
      lockedStraights,
      lockedLegs,
      dateFormatted,
    });

    const { outPicks, rejections } = applyStraightRows(templated, parsed);
    const narratedLegs = applyLegRows(flatLegs, parsed);

    if (!outPicks.length && !rejections.length) {
      return {
        picks: templated.map(ensureExtraFields),
        parlayLegs: decorateParlays(mergeLegsBack(parlayLegs, narratedLegs, legOwners)),
        edgeSummary: parsed.edgeSummary || templateSummary,
        insights: parsed.insights || templateInsights,
        claudeVerified: false,
        rejections: [],
      };
    }

    const finals = (outPicks.length ? outPicks : templated).map(ensureExtraFields);
    const finalsLegs = narratedLegs.map(ensureExtraFields);
    return {
      picks: finals,
      parlayLegs: mergeLegsBack(parlayLegs, finalsLegs, legOwners),
      edgeSummary: parsed.edgeSummary || templateSummary,
      insights: parsed.insights || templateInsights,
      claudeVerified: true,
      rejections,
    };
  } catch (e) {
    console.error(`[omega-vnext/narrate] ${e.message}`);
    return {
      picks: templated.map(ensureExtraFields),
      parlayLegs: decorateParlays(mergeLegsBack(parlayLegs, flatLegs, legOwners)),
      edgeSummary: templateSummary,
      insights: templateInsights,
      claudeVerified: false,
      rejections: [{ matchup: 'narrator', side: 'verifier', reason: `Narrate failed: ${e.message}` }],
    };
  }
}

function mergeLegsBack(parlayLegs, flatLegs, legOwners) {
  if (!parlayLegs || !parlayLegs.length) return [];
  const clone = parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }));
  legOwners.forEach((owner, i) => {
    if (clone[owner.plIdx] && clone[owner.plIdx].legs[owner.legIdx] != null) {
      clone[owner.plIdx].legs[owner.legIdx] = {
        ...clone[owner.plIdx].legs[owner.legIdx],
        ...flatLegs[i],
      };
    }
  });
  return clone;
}

/** Re-narrate only parlay legs (after veto-driven re-optimize). Same prompt, row, and token path. */
async function narrateParlayLegsOnly({ parlayLegs, dateFormatted, apiKey, straightPicks }) {
  const key = resolveXaiKey(apiKey);
  if (!parlayLegs || !parlayLegs.length) return parlayLegs || [];

  const flatLegs = [];
  const legOwners = [];
  parlayLegs.forEach((pl, plIdx) => {
    (pl.legs || []).forEach((leg, legIdx) => {
      // Prefer matching straight narrative when same pick
      const match = (straightPicks || []).find(p => p.pick === leg.pick && p.matchup === leg.matchup);
      const seeded = match && match.coreReasoning
        ? { ...leg, coreReasoning: match.coreReasoning }
        : ensureNarrative(leg);
      flatLegs.push(seeded);
      legOwners.push({ plIdx, legIdx });
    });
  });

  if (!key) return mergeLegsBack(parlayLegs, flatLegs.map(ensureExtraFields), legOwners);

  try {
    const parsed = await callGrok({
      apiKey: key,
      lockedStraights: [],
      lockedLegs: flatLegs.map((p, i) => lockedRow(p, i, 'parlay')),
      dateFormatted: dateFormatted || '',
    });
    const narrated = applyLegRows(flatLegs, parsed).map(ensureExtraFields);
    return mergeLegsBack(parlayLegs, narrated, legOwners);
  } catch (e) {
    console.error(`[omega-vnext/narrate] parlay-only failed: ${e.message}`);
    return mergeLegsBack(parlayLegs, flatLegs.map(ensureExtraFields), legOwners);
  }
}

module.exports = {
  applyStraightRows,
  narrateAndVerify,
  narrateParlayLegsOnly,
  buildFallbackNarrative,
  buildCardFallbackCopy,
  ensureNarrative,
  ensureExtraFields,
  lockedRow,
  edgeBandFrom,
  steamHintFrom,
  resolveXaiKey,
};
