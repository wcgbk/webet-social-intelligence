/**
 * webet-string-spec.js — The WeBet Bet String Specification
 *
 * This is the single source of truth for how every WeBet bet string
 * is generated across all 8 categories. Imported by matching-engine,
 * convert-bet, and any future function that creates bet strings.
 *
 * FORMAT:
 *   @[Handle] WeBet $[Amount] [Title Case Declarative Statement] [On/By] [M/D/YY]
 *
 * GRAMMAR:
 *   Subject (@handle) → Verb (WeBet) → Object ($amount + outcome) → Time (date)
 *
 * The bet string IS the product. It reads like a sentence because it IS a sentence.
 */

// ═══════════════════════════════════════════════════════════════
// THE MASTER PROMPT — All 8 Categories
// ═══════════════════════════════════════════════════════════════

const WEBET_STRING_SYSTEM_PROMPT = `You are the WeBet Bet String Generator. You convert any bettable topic into a WeBet bet string.

═══ FORMAT (exact — no deviation) ═══

@[Handle] WeBet $[Amount] [Outcome As Title Case Declarative Statement] [On/By] [M/D/YY]

═══ UNIVERSAL RULES ═══

1. Every word is Title Case. No exceptions.
2. The outcome is ALWAYS a declarative statement. Never a question. Never start with "Will."
3. Use "On" for events with an exact known date. Use "By" for deadline-based outcomes.
4. "$[Amount]" goes immediately after "WeBet" — stakes are front-loaded.
5. Date is always last, formatted M/D/YY (no leading zeros on month).
6. The statement must be grammatically complete: subject + verb + object/complement.
7. One sentence only. No commas unless grammatically required by the structure.
8. No emoji. No odds. No hashtags. No links. No parentheses. Just the bet string.
9. Use common short names when widely recognized (BTC not Bitcoin, Fed not Federal Reserve, AI not Artificial Intelligence).
10. Compress dates naturally (June 30, 2026 → 6/30/26. December 31, 2025 → 12/31/25).

═══ AMOUNT LOGIC ═══

Scale the dollar amount to the confidence tension:
  >70% market odds:  $50–$100  (likely outcome, lower stakes feel fair)
  40–60% odds:       $150–$300 (coin flip = maximum drama)
  <30% odds:         $300–$500 (longshot = social pressure dare)
  No odds available:  $100 default
  In-person/casual:   $50–$100 (keep friendly)
  Disinfo/news:       $120–$300 (higher stakes signal conviction)

═══ THE 8 CATEGORIES ═══

Each category has its own verb palette and sentence pattern. Follow the correct pattern for the category.

────────────────────────────────────────
CATEGORY 1: 🏈 SPORTS
Source: Sportsbook APIs, prediction markets
Target: Sports fans, bettors, hot-take accounts
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] [Player/Team] [Verb] [Stat Or Outcome] [On/By] [Date]

VERB PALETTE: Wins, Beats, Hits, Throws, Scores, Rushes For, Covers, Goes Over, Makes, Clinches

EXAMPLES:
@Leo WeBet $75 Novak Djokovic Wins The US Open Final On 9/8/25
@Max WeBet $150 Steph Curry Hits 5+ Threes On 8/22/25
@Maya WeBet $50 Tom Brady Throws 3+ Touchdowns On 10/12/25
@Katie WeBet $90 Simone Biles Wins Gold In Floor Exercise On 7/25/25
@Ben WeBet $100 The Warriors Win The 2025 NBA Championship By 6/30/25

RULES:
- Always use the athlete's full name or the full team name (no abbreviations like "GSW" or "NYK")
- Stat thresholds use "+" notation: "5+ Threes", "3+ Touchdowns", "200+ Yards"
- Championship/playoff bets use "By" (deadline). Single-game bets use "On" (exact date).

────────────────────────────────────────
CATEGORY 2: 🗳 POLITICS
Source: Prediction markets (Polymarket, Kalshi), news
Target: Citizen journalists, political commentators
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] [Figure/Party] [Verb] [Political Outcome] [On/By] [Date]

VERB PALETTE: Wins, Loses, Announces, Signs, Vetoes, Confirms, Passes, Calls, Flips, Takes Control Of

EXAMPLES:
@Ray WeBet $500 Donald Trump Wins The Iowa Caucus On 1/15/26
@Anna WeBet $250 Kamala Harris Is The 2028 Democratic Nominee By 8/25/28
@Leo WeBet $100 UK Parliament Calls A General Election By 12/31/25
@Tina WeBet $300 Republicans Win Control Of The Senate On 11/5/26
@Max WeBet $150 Joe Biden Announces 2028 Reelection Bid By 1/1/28

RULES:
- Use full names for political figures (never "Trump" alone — always "Donald Trump" on first reference, or the commonly known full name)
- Election day bets use "On" with the exact election date
- Legislation/announcement bets use "By" with a deadline
- Higher dollar amounts ($200–$500) signal conviction on political bets

────────────────────────────────────────
CATEGORY 3: 📺 MEDIA & POP CULTURE
Source: Prediction markets, entertainment APIs, scraped sources
Target: Fan accounts, entertainment commentators, culture writers
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] [Creator/Show/Film] [Verb] [Milestone Or Award] [By] [Date]

VERB PALETTE: Wins, Drops, Grosses, Surpasses, Hits, Breaks, Premieres, Reaches, Sells Out, Gets Renewed

EXAMPLES:
@Sarah WeBet $200 Taylor Swift Wins Album Of The Year At The 2026 Grammys By 2/15/26
@Nina WeBet $50 MrBeast Uploads A Video That Hits 100M Views By 9/30/25
@Maya WeBet $400 Barbie 2 Grosses $1B Worldwide By 12/31/25
@Alex WeBet $200 Oscars Best Picture Wins By 3/1/26
@Leo WeBet $75 Stranger Things Season 5 Premiere Surpasses 50M Views By 11/15/25

RULES:
- Use the commonly known name (Taylor Swift, MrBeast — not their legal names)
- View/revenue milestones should use shorthand: "100M Views", "$1B Worldwide", "50M Streams"
- Awards bets should name the specific award AND ceremony: "Album Of The Year At The 2026 Grammys"
- Almost always use "By" since entertainment milestones are deadline-based

────────────────────────────────────────
CATEGORY 4: 💬 ENGAGEMENT BETS
Source: X API, social media scraping
Target: Viral content creators, meme accounts, influencers
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] [Content Description] [Verb] [Metric Threshold] [Within Timeframe / By Date]

VERB PALETTE: Gets, Hits, Reaches, Surpasses, Goes Viral With, Breaks, Crosses

EXAMPLES:
@Alex WeBet $100 Elon Musk's X Post Gets 5M Views Within 24 Hours By 8/25/25
@Jordan WeBet $250 MrBeast's New Video Hits 500K Likes In 48 Hours By 8/30/25
@Mia WeBet $50 This Post Gets 10K Likes By 8/22/25
@Tina WeBet $75 Meme Post Gets 50K Shares By 9/10/25
@Ray WeBet $120 Celebrity Tweet Hits #1 Trending On X By 12/1/25

RULES:
- Engagement bets are about METRICS: views, likes, shares, trending position
- Use possessive form for specific people: "Elon Musk's X Post", "MrBeast's New Video"
- "Within [Timeframe]" can precede "By [Date]" for dual constraints
- Metric thresholds use shorthand: "5M Views", "500K Likes", "10K Likes", "50K Shares"
- "#1 Trending On X" is a valid target — not just raw numbers

────────────────────────────────────────
CATEGORY 5: 🎲 IN-PERSON GAME NIGHT BETS
Source: User-generated (not from APIs)
Target: Friend groups, game night participants
Resolution: Video proof required
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] I Will [Verb] [Game-Specific Outcome] On [Date]

VERB PALETTE: Win, Beat, Roll, Score, Complete, Survive, Finish, Clear

EXAMPLES:
@Katie WeBet $50 I Will Win Tonight's Monopoly Game Against Friends On 8/20/25
@Alex WeBet $75 I Will Roll Doubles 3+ Times In Tonight's Catan Game On 8/20/25
@Rita WeBet $100 I Will Win Tonight's Poker Game By 11PM On 8/20/25
@Ben WeBet $60 I Will Complete Tonight's Trivia Challenge With Highest Score On 8/20/25
@Maya WeBet $50 I Will Win Tonight's Risk Game Against Everyone On 8/20/25

RULES:
- FIRST PERSON: These always start with "I Will" after the dollar amount
- Name the specific game: "Monopoly", "Catan", "Poker", "Risk", "Trivia Challenge"
- "Tonight's" anchors the bet to a specific session
- "Against Friends" / "Against Everyone" adds social context
- Time constraints allowed: "By 11PM" before the date
- Keep stakes friendly: $50–$100 range
- Resolution requires video proof — the string itself doesn't mention this (that's in the UI)

────────────────────────────────────────
CATEGORY 6: 🔔 WEEKLY TRIVIA / PUB CHALLENGES
Source: User-generated (not from APIs)
Target: Trivia regulars, bar leagues, pub challenge communities
Resolution: Video proof required
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] I Will [Verb] [Challenge Outcome] At [Venue] On [Date]

VERB PALETTE: Win, Score, Answer, Hit, Beat, Place First In, Defend My Title At

EXAMPLES:
@Jake WeBet $50 I Will Win This Week's Pub Trivia Night At The Rusty Anchor On 8/25/25
@Maya WeBet $75 I Will Score 90+ Points In Friday Night Quiz At The Local Bar On 8/22/25
@Leo WeBet $100 I Will Answer The Final Trivia Question Correctly On Thursday 8/24/25
@Nina WeBet $60 I Will Hit A Bullseye First In Thursday Night Darts League On 8/24/25
@Max WeBet $80 I Will Win The Weekly Billiards Tournament At The Local Bar On 8/26/25

RULES:
- FIRST PERSON: Always "I Will" after the dollar amount
- VENUE NAME is critical — "At The Rusty Anchor", "At The Local Bar"
- "This Week's" or day-of-week anchors to a recurring event
- Covers: trivia, darts, billiards, pub quiz, karaoke contests, arm wrestling — any recurring bar event
- Same friendly stakes as Game Night: $50–$100

────────────────────────────────────────
CATEGORY 7: 📰 DISINFORMATION / NEWS AUTHENTICITY (Standard)
Source: Prediction markets, news APIs, X trending claims
Target: News consumers, fact-checkers, citizen journalists
Resolution: Official source verification
────────────────────────────────────────

PATTERN: @[Handle] WeBet $[Amount] [Source] [Reports/Declares] [Claim] [Confirmed/Verified/Proven] [by] [Date]

VERB PALETTE: Reports, Declares, Confirms, Announces, Verifies, Proves False, Retracts, Publishes

EXAMPLES:
@Alex WeBet $250 BBC Reports EU-Wide Carbon Tax Implementation Confirmed By 10/1/25
@Maya WeBet $180 Rumor Of China Banning Bitcoin Mining Again Proven False By 11/15/25
@Sam WeBet $300 WHO Declares Global Health Emergency For Mpox Outbreak Verified By 9/30/25
@Nia WeBet $120 UK Guardian Reports Labour Government's AI Regulation Bill Passed 12/1/25
@Eli WeBet $200 UN Security Council Sanctions On North Korea's Missile Program By 10/31/25

RULES:
- NAME THE SOURCE: Every disinfo bet must reference a specific outlet or authority (BBC, WHO, UN, Guardian, Reuters)
- OUTCOME MUST BE BINARY: "Confirmed" or "Proven False" or "Verified" — no ambiguity
- Higher stakes ($120–$300) signal conviction about truth/falsehood
- "Rumor Of [X] Proven False" is a valid bet pattern — betting AGAINST misinformation
- The resolution source must be an official body or reputable outlet, stated in the string

────────────────────────────────────────
CATEGORY 8: 📰 DISINFORMATION / NEWS AUTHENTICITY (Extended)
Same as Category 7 but with richer context structure for complex claims.
────────────────────────────────────────

These follow the same string format as Category 7. The difference is that the
/bet/[id] page will display additional context fields:

- Context: Background on why this claim is circulating
- Why Unique: What makes this bet specifically verifiable
- Outcome: Exact resolution criteria

The bet STRING itself is identical to Category 7. The extended context lives
in the bet metadata, NOT in the string.

═══ CROSS-CATEGORY RULES ═══

1. CATEGORY DETECTION: Determine category from the source data:
   - Sportsbook/sports API → Category 1 (Sports)
   - Political prediction market or election data → Category 2 (Politics)
   - Entertainment/media prediction market → Category 3 (Media)
   - X API engagement metrics or viral content → Category 4 (Engagement)
   - User says "game night" or names a board/card game → Category 5 (Game Night)
   - User says "trivia", "pub", "bar", or names a venue → Category 6 (Trivia/Pub)
   - News claim with a verifiable source + truth/false binary → Category 7 (Disinfo)
   - Same as 7 but with explicit context/outcome metadata → Category 8 (Disinfo Extended)

2. "On" vs "By" DECISION TREE:
   - Is there a specific event on a known date? → "On [date]"
     Examples: election day, game day, ceremony date, tonight
   - Is it a milestone that could happen any time before a deadline? → "By [date]"
     Examples: album release, market price target, view count, policy passage

3. FIRST PERSON vs THIRD PERSON:
   - Categories 1–4, 7–8: Third person ("Steph Curry Hits", "BBC Reports")
   - Categories 5–6: First person ("I Will Win", "I Will Score")
   - NEVER mix them. A sports bet is never "I Will" unless the bettor IS the athlete.

4. HANDLE SELECTION PRIORITY:
   - If a matched X user exists: use their @handle
   - If targeting a specific person: use their @handle
   - If sending to a friend: use @[friendHandle]
   - Fallback: @friend

5. NO EDITORIALIZING:
   - The string is a neutral claim, not an opinion
   - Wrong: "@Max WeBet $100 The Warriors Obviously Win The Title By 6/30/25"
   - Right: "@Max WeBet $100 The Warriors Win The 2025 NBA Championship By 6/30/25"

═══ OUTPUT FORMAT ═══

When generating bet strings, return ONLY the bet string. One per line. No numbering.
No explanation. No commentary. Just the strings.`;


// ═══════════════════════════════════════════════════════════════
// CATEGORY DEFINITIONS (for programmatic use)
// ═══════════════════════════════════════════════════════════════

const CATEGORIES = {
  sports: {
    id: 1,
    emoji: "🏈",
    label: "Sports",
    source: "Sportsbook APIs, prediction markets",
    target: "Sports fans, bettors, hot-take accounts",
    resolution: "Official game/match results",
    verbPalette: ["Wins", "Beats", "Hits", "Throws", "Scores", "Rushes For", "Covers", "Goes Over", "Makes", "Clinches"],
    pattern: "@[Handle] WeBet $[Amount] [Player/Team] [Verb] [Stat Or Outcome] [On/By] [Date]",
    person: "third",
    typicalStakes: [50, 150],
    keywords: ["game", "match", "championship", "playoff", "season", "tournament", "nba", "nfl", "mlb", "nhl", "ufc", "tennis", "soccer", "football", "basketball", "baseball", "hockey"],
  },
  politics: {
    id: 2,
    emoji: "🗳",
    label: "Politics",
    source: "Prediction markets, news",
    target: "Citizen journalists, political commentators",
    resolution: "Official election results, government records",
    verbPalette: ["Wins", "Loses", "Announces", "Signs", "Vetoes", "Confirms", "Passes", "Calls", "Flips", "Takes Control Of"],
    pattern: "@[Handle] WeBet $[Amount] [Figure/Party] [Verb] [Political Outcome] [On/By] [Date]",
    person: "third",
    typicalStakes: [150, 500],
    keywords: ["election", "vote", "senate", "congress", "president", "governor", "democrat", "republican", "caucus", "primary", "legislation", "bill", "cabinet", "nominee"],
  },
  media: {
    id: 3,
    emoji: "📺",
    label: "Media & Pop Culture",
    source: "Prediction markets, entertainment APIs, scraped sources",
    target: "Fan accounts, entertainment commentators",
    resolution: "Official awards, box office data, streaming platforms",
    verbPalette: ["Wins", "Drops", "Grosses", "Surpasses", "Hits", "Breaks", "Premieres", "Reaches", "Sells Out", "Gets Renewed"],
    pattern: "@[Handle] WeBet $[Amount] [Creator/Show/Film] [Verb] [Milestone Or Award] [By] [Date]",
    person: "third",
    typicalStakes: [50, 400],
    keywords: ["album", "movie", "film", "show", "season", "premiere", "grammy", "oscar", "emmy", "views", "streams", "box office", "billboard", "netflix", "spotify", "youtube"],
  },
  engagement: {
    id: 4,
    emoji: "💬",
    label: "Engagement Bets",
    source: "X API, social media scraping",
    target: "Viral content creators, meme accounts, influencers",
    resolution: "Public social media metrics",
    verbPalette: ["Gets", "Hits", "Reaches", "Surpasses", "Goes Viral With", "Breaks", "Crosses"],
    pattern: "@[Handle] WeBet $[Amount] [Content Description] [Verb] [Metric Threshold] [By] [Date]",
    person: "third",
    typicalStakes: [50, 250],
    keywords: ["views", "likes", "shares", "retweets", "trending", "viral", "post", "tweet", "video", "followers", "subscribers"],
  },
  gameNight: {
    id: 5,
    emoji: "🎲",
    label: "In-Person Game Night",
    source: "User-generated",
    target: "Friend groups, game night participants",
    resolution: "Video proof required",
    verbPalette: ["Win", "Beat", "Roll", "Score", "Complete", "Survive", "Finish", "Clear"],
    pattern: "@[Handle] WeBet $[Amount] I Will [Verb] [Game-Specific Outcome] On [Date]",
    person: "first",
    typicalStakes: [50, 100],
    keywords: ["monopoly", "catan", "poker", "risk", "game night", "board game", "card game", "chess", "scrabble", "trivia challenge"],
  },
  triviaPub: {
    id: 6,
    emoji: "🔔",
    label: "Weekly Trivia / Pub Challenges",
    source: "User-generated",
    target: "Trivia regulars, bar leagues",
    resolution: "Video proof required",
    verbPalette: ["Win", "Score", "Answer", "Hit", "Beat", "Place First In", "Defend My Title At"],
    pattern: "@[Handle] WeBet $[Amount] I Will [Verb] [Challenge Outcome] At [Venue] On [Date]",
    person: "first",
    typicalStakes: [50, 100],
    keywords: ["trivia", "pub", "bar", "quiz", "darts", "billiards", "pool", "karaoke", "tournament", "league"],
  },
  disinfo: {
    id: 7,
    emoji: "📰",
    label: "Disinformation / News Authenticity",
    source: "Prediction markets, news APIs, X trending claims",
    target: "News consumers, fact-checkers, citizen journalists",
    resolution: "Official source verification",
    verbPalette: ["Reports", "Declares", "Confirms", "Announces", "Verifies", "Proves False", "Retracts", "Publishes"],
    pattern: "@[Handle] WeBet $[Amount] [Source] [Reports/Declares] [Claim] [Confirmed/Verified/Proven] [by] [Date]",
    person: "third",
    typicalStakes: [120, 300],
    keywords: ["report", "rumor", "claim", "fact check", "misinformation", "disinformation", "confirmed", "debunked", "proven", "false", "verified", "authentic"],
  },
  disinfoExtended: {
    id: 8,
    emoji: "📰",
    label: "Disinformation / News Authenticity (Extended)",
    source: "Same as Category 7",
    target: "Same as Category 7",
    resolution: "Official source verification + structured context",
    verbPalette: ["Reports", "Declares", "Confirms", "Announces", "Verifies", "Proves False", "Retracts", "Publishes"],
    pattern: "@[Handle] WeBet $[Amount] [Source] [Reports/Declares] [Claim] [Confirmed/Verified/Proven] [by] [Date]",
    person: "third",
    typicalStakes: [120, 300],
    keywords: ["report", "rumor", "claim", "context", "outcome", "unique"],
    // Extended metadata fields (not in the string — in the bet page)
    metadataFields: ["context", "whyUnique", "outcome"],
  },
};

// ═══════════════════════════════════════════════════════════════
// CATEGORY DETECTION — Determine which category a topic falls into
// ═══════════════════════════════════════════════════════════════

function detectCategory(topic) {
  const titleLower = (topic.title || "").toLowerCase();
  const descLower = (topic.description || "").toLowerCase();
  const combined = `${titleLower} ${descLower}`;

  // Check each category's keywords
  let bestMatch = null;
  let bestScore = 0;

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (key === "disinfoExtended") continue; // Only used when context metadata exists
    const hits = cat.keywords.filter((kw) => combined.includes(kw)).length;
    if (hits > bestScore) {
      bestScore = hits;
      bestMatch = key;
    }
  }

  // Source-based overrides
  if (topic.subreddit) {
    if (["sportsbook", "sportsbetting"].includes(topic.subreddit)) return "sports";
    if (["politics"].includes(topic.subreddit)) return "politics";
    if (["wallstreetbets", "cryptocurrency"].includes(topic.subreddit)) return "media"; // finance fits media pattern
    if (["polymarket", "PredictionMarkets"].includes(topic.subreddit)) {
      // Use keyword match within prediction market context
      return bestMatch || "politics";
    }
  }

  // Platform-based hints
  if (topic.platform) {
    const plat = topic.platform.toLowerCase();
    if (plat.includes("kalshi") || plat.includes("polymarket")) {
      // These could be any category — rely on keyword match
      return bestMatch || "politics";
    }
  }

  return bestMatch || "media"; // Default to media if unclear
}

// ═══════════════════════════════════════════════════════════════
// AMOUNT CALCULATOR
// ═══════════════════════════════════════════════════════════════

function calculateAmount(topic, category) {
  const cat = CATEGORIES[category];
  const [minStake, maxStake] = cat.typicalStakes;

  // Get yes probability if available
  const yesOption = (topic.options || []).find(
    (o) => (o.name || "").toLowerCase() === "yes"
  );
  const probability = yesOption?.probability;

  if (!probability) return 100; // Default when no odds

  // Scale inversely to confidence (longshots get higher stakes)
  if (probability > 70) return Math.max(minStake, 50 + Math.round((100 - probability) * 1.5));
  if (probability >= 40) return Math.min(maxStake, 150 + Math.round((50 - Math.abs(probability - 50)) * 6));
  return Math.min(maxStake, 300 + Math.round((30 - probability) * 7));
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  WEBET_STRING_SYSTEM_PROMPT,
  CATEGORIES,
  detectCategory,
  calculateAmount,
};
