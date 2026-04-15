"""Build the 2-page bulleted PDF summarizing the X user bet-matching process."""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    KeepTogether,
)

OUT = "/home/user/webet-social-intelligence/research/bet-matching-summary.pdf"

# ---------- Styles ----------
styles = getSampleStyleSheet()

INK = colors.HexColor("#0D0F12")
MUTED = colors.HexColor("#52606D")
ACCENT = colors.HexColor("#1A8754")
RULE = colors.HexColor("#D8DEE4")
BG_TINT = colors.HexColor("#F3F7F4")

title_style = ParagraphStyle(
    name="Title",
    parent=styles["Heading1"],
    fontName="Helvetica-Bold",
    fontSize=20,
    leading=24,
    textColor=INK,
    spaceAfter=4,
)

eyebrow_style = ParagraphStyle(
    name="Eyebrow",
    parent=styles["BodyText"],
    fontName="Helvetica-Bold",
    fontSize=8.5,
    leading=10,
    textColor=ACCENT,
    spaceAfter=6,
)

lede_style = ParagraphStyle(
    name="Lede",
    parent=styles["BodyText"],
    fontName="Helvetica-Oblique",
    fontSize=11,
    leading=15,
    textColor=INK,
    spaceAfter=10,
    leftIndent=10,
    rightIndent=10,
    borderPadding=10,
    backColor=BG_TINT,
    borderColor=RULE,
    borderWidth=0.5,
)

lede_tight_style = ParagraphStyle(
    name="LedeTight",
    parent=lede_style,
    fontSize=10,
    leading=13,
    spaceAfter=4,
    borderPadding=8,
)

h2_style = ParagraphStyle(
    name="H2",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=12.5,
    leading=15,
    textColor=INK,
    spaceBefore=8,
    spaceAfter=3,
)

h3_style = ParagraphStyle(
    name="H3",
    parent=styles["Heading3"],
    fontName="Helvetica-Bold",
    fontSize=10.5,
    leading=13,
    textColor=INK,
    spaceBefore=6,
    spaceAfter=2,
)

body_style = ParagraphStyle(
    name="Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9.5,
    leading=13,
    textColor=INK,
    spaceAfter=3,
)

bullet_style = ParagraphStyle(
    name="Bullet",
    parent=body_style,
    leftIndent=14,
    bulletIndent=4,
    spaceAfter=2,
)

sub_bullet_style = ParagraphStyle(
    name="SubBullet",
    parent=body_style,
    leftIndent=30,
    bulletIndent=18,
    spaceAfter=1,
    fontSize=9,
    textColor=MUTED,
)

foot_style = ParagraphStyle(
    name="Foot",
    parent=styles["BodyText"],
    fontName="Helvetica-Oblique",
    fontSize=8.5,
    leading=11,
    textColor=MUTED,
    spaceBefore=6,
)

# ---------- Helpers ----------
def bullet(text, style=bullet_style):
    return Paragraph(text, style, bulletText="\u2022")

def sub(text):
    return Paragraph(text, sub_bullet_style, bulletText="\u2013")

def rule_line():
    t = Table([[""]], colWidths=[6.6 * inch], rowHeights=[1])
    t.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, RULE),
    ]))
    return t

# ---------- Page 1 ----------
story = []

story.append(Paragraph("WEBETAI \u00b7 /TRUTH CONTENT MACHINE \u00b7 RESEARCH NOTE", eyebrow_style))
story.append(Paragraph("How the Machine Picks the Two Users Per Topic", title_style))
story.append(Spacer(1, 6))
story.append(rule_line())
story.append(Spacer(1, 10))

story.append(Paragraph(
    "The topic\u2019s own viral posts tell the machine who the Champions are. It picks the two "
    "highest-engagement voices already publicly committed to opposite sides, then filters them "
    "down to one pair using a math-based scoring function \u2014 not an LLM guess.",
    lede_style,
))

story.append(Paragraph("The 4-step selection logic", h2_style))

story.append(Paragraph("1 \u00b7 The topic delivers the candidates", h3_style))
story.append(bullet("Stage 1\u2019s Grok <b>x_search</b> already returned the top ratio\u2019d and top opposing posts on the exact claim."))
story.append(bullet("Every <b>author</b> of those posts becomes a pre-qualified candidate \u2014 they already publicly staked a position, in the last 7 days, with real engagement attached."))
story.append(bullet("The machine doesn\u2019t hunt users; users self-identified by posting."))

story.append(Paragraph("2 \u00b7 Stance classifier splits them", h3_style))
story.append(bullet("A small LLM call labels each post: <b>Side A</b>, <b>Side B</b>, or <b>noise</b>."))
story.append(bullet("Noise = jokes, off-topic, ambiguous, meta-commentary \u2192 dropped immediately."))
story.append(bullet("Result: two buckets of roughly 6\u20138 candidates each."))

story.append(Paragraph("3 \u00b7 Nine features extracted per survivor (in parallel)", h3_style))
story.append(bullet("<b>Conviction</b> (0\u20131) \u00b7 <b>Reach index</b> (followers \u00d7 median engagement) \u00b7 <b>Reply-openness</b> (replies to strangers ratio)"))
story.append(bullet("<b>Topic fluency</b> (adjacent posts in last 90d) \u00b7 <b>Active timezone</b> \u00b7 <b>Graph distance</b> to every other candidate"))
story.append(bullet("<b>Flame tolerance</b> (sniper / debater / preacher / troll / dry) \u00b7 <b>Account health</b> (bot filter) \u00b7 <b>Tag receptivity</b>"))
story.append(sub("Hard gates: no past reply to a stranger \u2192 drop. Bot pattern \u2192 drop. Drive-by poster \u2192 demote."))

story.append(Paragraph("4 \u00b7 Pair-scoring picks THE two, not the top two", h3_style))
story.append(bullet("A weighted rule engine (not an LLM) scores every <b>Side-A \u00d7 Side-B</b> combination."))
story.append(bullet("Target ranges: reach ratio 0.5\u20132.0 \u00b7 graph distance \u22652 (not mutuals) \u00b7 audience overlap 0.05\u20130.25"))
story.append(bullet("\u22654 waking hours of timezone overlap \u00b7 style-compatible pairing (sniper/sniper, preacher/preacher)"))
story.append(bullet("Both conviction \u22650.7 \u00b7 both reply-openness \u22650.15"))
story.append(sub("Top pair = this topic\u2019s Champions. Pair #2 and #3 held on the bench for auto-rotation."))

story.append(Paragraph("Why this works", h2_style))
story.append(bullet("<b>The topic chose the users.</b> You\u2019re not cold-tagging \u2014 you\u2019re calling out people who already publicly staked a position. That\u2019s why they can\u2019t ignore it without looking weak."))
story.append(bullet("<b>Rules beat LLMs for pairing.</b> LLMs bias toward famous handles. The rule engine optimizes for engagement probability (weight class + style + timezone + openness)."))
story.append(bullet("<b>The match is bespoke to each piece of content.</b> Every Regenerate produces up to 8 cards; each card gets its own pair. No global user list, no favorites."))

story.append(PageBreak())

# ---------- Page 2 ----------
story.append(Paragraph("WEBETAI \u00b7 /TRUTH CONTENT MACHINE \u00b7 RESEARCH NOTE", eyebrow_style))
story.append(Paragraph("Per-Content Mapping & Engagement Flow", title_style))
story.append(Spacer(1, 6))
story.append(rule_line())
story.append(Spacer(1, 10))

story.append(Paragraph("Which user lands on which artifact", h2_style))

tbl_data = [
    ["Artifact", "Tags / references"],
    ["Main X post", "No tags (algorithm prefers untagged top-level posts)"],
    ["X reply #1", "@Champion A \u2014 with their own verbatim quote"],
    ["X reply #2", "@Champion B \u2014 with their own verbatim quote"],
    ["X reply #3 (optional)", "Polymarket chart \u00b7 no user tag"],
    ["Truth Social post", "No tags \u2014 amplifies to 42k, drives scoreboard traffic"],
    ["Blog article (Betty)", "Embeds both Champions\u2019 posts \u00b7 no direct tags"],
    ["Scoreboard page", "Side A reserved for @Champion A, Side B for @Champion B"],
    ["T+45m fallback reply", "Direct reply on each Champion\u2019s own qualifying post (if no bite)"],
]

tbl = Table(tbl_data, colWidths=[1.9 * inch, 4.7 * inch])
tbl.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), INK),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9.5),
    ("ALIGN", (0, 0), (-1, -1), "LEFT"),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BG_TINT]),
    ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
    ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
]))
story.append(tbl)

story.append(Paragraph("The engagement sequence for that pair", h2_style))
story.append(bullet("<b>T = 0</b> \u00b7 Main X post drops via scheduler at an irregular time (e.g., 7:42am). Untagged, 1600\u00d7900 native image showing both quotes, scoreboard link."))
story.append(bullet("<b>T + 5 min</b> \u00b7 Self-reply tagging <b>@Champion A</b> with their verbatim quote + \u201cstill standing behind this?\u201d"))
story.append(bullet("<b>T + 7 min</b> \u00b7 Self-reply tagging <b>@Champion B</b> \u2014 same structure, mirror framing."))
story.append(bullet("<b>T + 12 min</b> \u00b7 Optional Polymarket chart reply \u00b7 <b>T + 15 min</b> \u00b7 Truth Social amplification drives spectator traffic to scoreboard."))
story.append(bullet("<b>T + 45 min</b> \u00b7 Conditional: direct reply on each Champion\u2019s <i>original</i> qualifying post \u2014 only if neither has bitten."))
story.append(bullet("<b>Every 30 min</b> \u00b7 Agitation loop: odds-shift replies, tribe-summons, auto-rotate to bench Champion at T+3h if one side ghosts."))

story.append(Paragraph("Through-line across every surface", h2_style))
story.append(bullet("<b>One topic \u2192 one pair \u2192 same pair referenced everywhere.</b>"))
story.append(bullet("The Champions are the through-line across all five artifacts."))
story.append(bullet("Every surface points back to the <b>same scoreboard, the same two handles, the same one bet</b>."))
story.append(bullet("Spectator counter on the scoreboard aggregates Truth Social + X traffic \u2014 social proof is cumulative, not per-channel."))

story.append(Paragraph("In one line", h2_style))
story.append(Paragraph(
    "The Champions are not persuaded \u2014 they are trapped into a public choice between "
    "defending their stated position or folding in front of their own audience. "
    "Clicking <b>Accept</b> becomes the least-expensive option available.",
    lede_tight_style,
))

story.append(Paragraph(
    "Research note \u00b7 webet-social-intelligence \u00b7 branch: claude/research-content-machine-KnnHO \u00b7 no deployment.",
    foot_style,
))

# ---------- Build ----------
doc = SimpleDocTemplate(
    OUT,
    pagesize=LETTER,
    leftMargin=0.9 * inch,
    rightMargin=0.9 * inch,
    topMargin=0.7 * inch,
    bottomMargin=0.7 * inch,
    title="WeBetAI /truth \u2014 Bet-Matching Research Note",
    author="webetsocial.com",
)

doc.build(story)
print(f"built {OUT}")
