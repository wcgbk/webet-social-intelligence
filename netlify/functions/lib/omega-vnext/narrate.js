'use strict';

/**
 * Claude as VERIFIER + NARRATOR only. Cannot invent sides.
 * May reject on news; unit cuts ≤50% allowed.
 * Narratives: ESPN-style 4–6 sentence journalistic blurbs (not math templates).
 * Voice: feature-desk matchup storytelling plus a sharp handicapper's price logic.
 */

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const NARRATIVE_MAX_TOKENS = 5800;

function resolveAnthropicKey(explicit) {
  return explicit
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_KEY
    || '';
}

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

/**
 * Sports-desk fallback when Claude is unavailable.
 * 5 sentences, argues for the side, no gate jargon.
 */
function buildFallbackNarrative(p) {
  const pick = p.pick || p.side || 'this side';
  const matchup = p.matchup || "today's game";
  const sport = p.sport || '';
  const betType = p.betType || p.market || '';
  const odds = p.odds != null && p.odds !== '' ? String(p.odds) : '';
  const units = p.units ? String(p.units) : '';
  const shape = sideShape(pick, betType);
  const band = edgeBandFrom(p);
  const steam = steamHintFrom(p);
  const grade = gradeLabel(p);
  const price = odds || 'this price';

  const hook = `${sport ? `${sport}: ` : ''}WeBetAI locked ${pick} in ${matchup}${odds ? ` at ${odds}` : ''}.`;

  let why;
  if (shape === 'under') {
    why = 'The way these teams have been playing points to a slower script than the total assumes, with fewer clean scoring trips than a high number needs.';
  } else if (shape === 'over') {
    why = 'The way these teams have been playing points to a livelier script than the total assumes, with more scoring chances than a low number allows.';
  } else if (shape === 'dog') {
    why = 'WeBetAI reads the favorite as priced for a cleaner win than this matchup figures to produce, which is why the plus points are the side.';
  } else if (shape === 'favorite' || shape === 'spread') {
    why = 'WeBetAI reads this side as the one that should control the game long enough to clear a short number with a normal winning margin.';
  } else {
    why = 'WeBetAI reads this side as the right team in the matchup, and the moneyline is how you get paid for that read.';
  }

  let value;
  if (shape === 'under') {
    value = `The total still looks a little high versus how these offenses have been scoring, and ${price} is still paying on the under.`;
  } else if (shape === 'over') {
    value = `The total still looks a little low versus how these offenses have been scoring, and ${price} has not caught all the way up.`;
  } else if (shape === 'dog') {
    value = `The points are the soft side of the number, and ${price} still leaves ${pick} as a bettable price.`;
  } else if (shape === 'favorite' || shape === 'spread') {
    value = `The spread still looks short for a side WeBetAI expects to win by enough, and ${price} is a fair way to lay it.`;
  } else if (/^\+/.test(odds)) {
    value = `Plus money is the case: WeBetAI wants this side, and ${price} still pays more than a short favorite would.`;
  } else {
    value = `The moneyline at ${price} still offers a better payout than the matchup risk WeBetAI sees.`;
  }

  let compass = '';
  if (band === 'strong') compass = 'WeBetAI sees a strong disagreement with the posted number';
  else if (band === 'solid') compass = 'WeBetAI sees a solid disagreement with the posted number';
  else if (band === 'modest') compass = 'WeBetAI has this as a modest disagreement with the posted number';
  if (steam && /toward/i.test(steam)) {
    compass = compass
      ? `${compass}, and the line is already leaning this way.`
      : 'The line is already leaning this way.';
  } else if (steam && /against/i.test(steam)) {
    compass = compass
      ? `${compass}, even with the line leaning the other way.`
      : 'The read holds even with the line leaning the other way.';
  } else if (compass) {
    compass = `${compass}.`;
  }

  let stake;
  if (grade && units) {
    stake = `WeBetAI has this graded ${grade} and sized at ${units}, enough to matter without making one game the whole day.`;
  } else if (units) {
    stake = `The stake is ${units}, big enough to matter and small enough that one game is not the whole day.`;
  } else if (grade) {
    stake = `WeBetAI has this graded ${grade}, a card play with a measured stake rather than a max swing.`;
  } else {
    stake = 'WeBetAI kept the stake disciplined, enough to matter without making one game the whole day.';
  }

  let close;
  if (shape === 'under') {
    close = 'WeBetAI is on the under because the game should land quieter than the posted total.';
  } else if (shape === 'over') {
    close = 'WeBetAI is on the over because the game should land higher than the posted total.';
  } else if (shape === 'dog') {
    close = `WeBetAI is on ${pick} because the favorite still has to win by more than this matchup should produce.`;
  } else if (shape === 'favorite' || shape === 'spread') {
    close = `WeBetAI is on ${pick} because a normal win should be enough to cover.`;
  } else {
    close = `WeBetAI is on ${pick} because the payout still respects the risk in ${matchup}.`;
  }

  return joinSentences([hook, why, value, compass, stake, close]);
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
    'The numbers on the screen are already close to where they should be, so there is no soft price worth a stake.',
    'An empty Omega card is the call on a day like this.',
    'Forcing a pick would turn a pass into a guess.',
    'When a total, spread, or moneyline is actually off, it will show up here with a real reason.',
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
    'WeBetAI built this as a few straights plus a small parlay, not a pile of leans.',
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

/** Concrete what-loses / closing-line / verification lines when Claude omits them. */
function ensureExtraFields(p) {
  const next = { ...p };
  const pick = next.pick || next.side || 'this side';
  const matchup = next.matchup || 'this matchup';
  const sport = next.sport || 'this slate';
  const shape = sideShape(pick, next.betType || next.market || '');
  const band = edgeBandFrom(next);
  const steam = steamHintFrom(next);

  if (!next.whatLoses || String(next.whatLoses).trim().length < 15) {
    if (shape === 'under') {
      next.whatLoses = `${pick} loses if ${matchup} turns into a track meet and the teams score past the total WeBetAI thinks is too high.`;
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
    } else if (band === 'strong' || band === 'solid') {
      next.clvExpectation = `WeBetAI expects the closing number to drift toward ${pick} as the rest of the market finds the same side.`;
    } else {
      next.clvExpectation = `WeBetAI expects a quiet close around ${pick}, and a number that simply holds is still a fair ticket.`;
    }
  }
  return next;
}

/**
 * Context for Claude. Sport, price, grade, and soft hints are translatable.
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
  return row;
}

const SYSTEM_PROMPT = `You are THE LOCK, WeBetAI's sports betting analyst. You write like an ESPN feature desk that also knows how to handicap a number. You VERIFY and NARRATE pre-locked picks. You do NOT select sides, invent replacements, compute projections, probabilities, or Kelly sizing. The card is already locked.

VOICE:
- Concrete, vivid, complete sentences. Tell the matchup. An average sports reader should finish a blurb and understand the bet.
- Argue FOR the picked side. If the pick is "Team X +17.5", explain why Team X covers.
- Always say "WeBetAI". Never say "the model", "our model", or "the algorithm".
- No em dashes. Use periods and commas.
- No help-desk tone. No filler like "form and injuries line up".
- Translate value into English. Good: "the total still looks a half-point high versus how these offenses have been scoring" or "the price is still paying." Bad: pasting EV%, coverProb, cover probability, CLV cents, Kelly, or an edge percent.
- Never use ORtg, DRtg, DVOA, ATS, FIP, xFIP, WAR, wRC+, or other advanced-stat abbreviations.
- Do not lead with bad news about the side you are picking.
- Do not apply baseball starter logic to football, or football quarterback logic to baseball.

YOUR JOB:
1. When web search is available, use it sparingly to verify injuries, recent news, starting pitchers (MLB), quarterback status (NFL/NCAAF), outdoor weather, and recent form. When tools are disabled, write from the locked table only. Do NOT invent specific injuries, records, scores, or weather.
2. ACCEPT or REJECT each LOCKED STRAIGHT pick. Default is ACCEPT. Reject ONLY for concrete disqualifying news (star out, starter scratch, quarterback out or doubtful, severe weather, material lineup change). You do NOT choose replacements.
3. Write coreReasoning for every ACCEPTED straight (4-6 sentences) and every parlay leg (3-5 sentences).
4. You MAY reduce straight units by up to 50% with a reason. You MUST NOT increase units. Do not change parlay leg units.
5. You MUST NOT invent new picks, swap sides, or override the locked direction.
6. Every specific fact must come from web search this run or the locked table. If you cannot verify a detail, describe the handicap in general terms instead of inventing one.

HOW TO BUILD coreReasoning (straights, 4-6 sentences):
1. Open with a concrete fact. Use verified news when you have it. Otherwise open on the matchup and the number.
2. Explain the matchup or the situation: why this side, in this game, today.
3. Explain the price in plain English. Use edgeBand and steamHint when they are present. A strong or solid band means the number is meaningfully off. A modest band means the price is only a little off, so keep the tone measured.
4. Close on why WeBetAI locked this side.

Parlay legs use the same voice in 3-5 sentences. Do not write a stub. Argue for that leg.

edgeSummary (3-5 sentences): the slate thesis, where the value is concentrated, and why the sizing stays disciplined. Name real matchups from the locked table. This is the Daily Edge the reader sees first.

insights (3-5 sentences): the sport mix, what to watch before lock (starter, quarterback, weather), and how the card is built for a normal fan. Plain English.

whatLoses: one concrete sentence. Name the game script that beats this side. Do not write "the opposite happens."

clvExpectation: one plain-English sentence on where the closing number should land (toward the side, against it, or holding). Do not say "CLV" and do not quote cents.

dataVerified: a short note on what you actually checked (form, injuries, starter, quarterback, weather), or "locked number and price only; no live news on this pass."

CONTEXT FIELDS on each locked row are a compass. They are not copy:
- rating, grade, odds, units, sport, betType: fine to mention in English.
- edgeBand: modest, solid, or strong. Translate it. Do not print a percent.
- steamHint: translate the direction if it is present. If it is missing, do not invent line movement.
- _contextEv and _contextCover: private. Use them only to decide how hard to talk about value. Never print them, and never print EV, expected value, cover probability, or a percent edge.

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

async function callClaudeOnce({ apiKey, lockedStraights, lockedLegs, dateFormatted, useWebSearch }) {
  // Send the full locked row, including _contextEv, _contextCover, edgeBand, and steamHint.
  const userPrompt = `Date: ${dateFormatted}

LOCKED STRAIGHT PICKS (verify and narrate; veto on disqualifying news only):
${JSON.stringify(lockedStraights || [], null, 2)}

LOCKED PARLAY LEGS (narrate only. Do not veto. Sides are fixed for the parlay slip):
${JSON.stringify(lockedLegs || [], null, 2)}

Write the JSON now.
Straights need 4-6 sentence coreReasoning. Parlay legs need 3-5 sentences. edgeSummary and insights need 3-5 sentences each.
Fields named edgeBand, steamHint, _contextEv, and _contextCover are a compass for plain-English value talk. Do not print EV, cover probability, CLV cents, Kelly, or those raw context numbers.
Argue for the picked side. Say WeBetAI. No em dashes.`;

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: NARRATIVE_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(useWebSearch ? 120000 : 60000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${resp.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text' || c.text)
    .map(c => c.text || '')
    .join('\n');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) throw new Error('no JSON in Claude response');
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

/** Prefer no-web_search first (web_search is flaky on Netlify). Retry once without tools. */
async function callClaude(opts) {
  try {
    return await callClaudeOnce({ ...opts, useWebSearch: false });
  } catch (e) {
    console.error(`[omega-vnext/narrate] Anthropic no-tools call failed (${e.message}) — retrying once without tools`);
    try {
      return await callClaudeOnce({ ...opts, useWebSearch: false });
    } catch (e2) {
      console.error(`[omega-vnext/narrate] Anthropic retry failed: ${e2.message}`);
      throw e2;
    }
  }
}

function applyStraightRows(templated, parsed) {
  const rejections = [];
  const outPicks = [];
  for (const row of parsed.picks || []) {
    const base = templated[row.idx];
    if (!base) continue;
    if (row.veto) {
      rejections.push({
        matchup: base.matchup,
        side: base.pick,
        reason: row.coreReasoning || 'Claude news veto',
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
      coreReasoning: prose.length > 40 ? prose : base.coreReasoning,
    };
    const wl = (row.whatLoses || '').trim();
    const dv = (row.dataVerified || '').trim();
    const clv = (row.clvExpectation || '').trim();
    if (wl.length > 10) next.whatLoses = wl;
    if (dv.length > 5) next.dataVerified = dv;
    if (clv.length > 5) next.clvExpectation = clv;
    outPicks.push(next);
  }
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
    const base = (prose && prose.length > 30) ? { ...leg, coreReasoning: prose } : ensureNarrative(leg);
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
  const key = resolveAnthropicKey(apiKey);

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
    console.error('[omega-vnext/narrate] ANTHROPIC_API_KEY missing — using sports-desk fallbacks');
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
    const parsed = await callClaude({
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
      rejections: [{ matchup: 'Claude', side: 'verifier', reason: `Narrate failed: ${e.message}` }],
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
  const key = resolveAnthropicKey(apiKey);
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
    const parsed = await callClaude({
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
  narrateAndVerify,
  narrateParlayLegsOnly,
  buildFallbackNarrative,
  buildCardFallbackCopy,
  ensureNarrative,
  ensureExtraFields,
  lockedRow,
  edgeBandFrom,
  steamHintFrom,
  resolveAnthropicKey,
};
