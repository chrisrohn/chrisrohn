"""Builds docs/youtube-api-walkthrough.pdf from the shots capture.mjs saved and the request log it exported.
Needs reportlab and pillow (pip install reportlab pillow); DejaVu Sans for the glyphs the site uses (▲ ≠ →)."""
import json
import re
import sys

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

SHOTS = sys.argv[1] if len(sys.argv) > 1 else "docs/walkthrough/shots"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/youtube-api-walkthrough.pdf"
for name, f in [("DV", "DejaVuSans.ttf"), ("DVB", "DejaVuSans-Bold.ttf"), ("DVM", "DejaVuSansMono.ttf")]:
    pdfmetrics.registerFont(TTFont(name, f"/usr/share/fonts/truetype/dejavu/{f}"))
INK, ACCENT, MUTED, RULE = colors.HexColor("#141412"), colors.HexColor("#e8501c"), colors.HexColor("#5c5a55"), colors.HexColor("#c9c5bb")
W, H = landscape(letter)
M = 0.6 * inch
st = dict(
    title=ParagraphStyle("t", fontName="DVB", fontSize=24, leading=28, textColor=INK, spaceAfter=6),
    h=ParagraphStyle("h", fontName="DVB", fontSize=15, leading=19, textColor=INK, spaceAfter=4),
    step=ParagraphStyle("s", fontName="DVB", fontSize=10, leading=12, textColor=ACCENT, spaceAfter=2),
    body=ParagraphStyle("b", fontName="DV", fontSize=10.5, leading=14.5, textColor=INK),
    small=ParagraphStyle("sm", fontName="DV", fontSize=8.5, leading=11, textColor=MUTED),
    cell=ParagraphStyle("c", fontName="DV", fontSize=8.5, leading=11, textColor=INK),
    mono=ParagraphStyle("m", fontName="DVM", fontSize=7.5, leading=10, textColor=INK),
)

def footer(c, doc):
    c.saveState()
    c.setFont("DV", 8)
    c.setFillColor(MUTED)
    c.drawString(M, 0.35 * inch, "chrisrohn.com · YouTube Data API v3 client · how playlists are verified, and how approved tracks are added and removed")
    c.drawRightString(W - M, 0.35 * inch, f"page {doc.page}")
    c.setStrokeColor(ACCENT)
    c.setLineWidth(3)
    c.line(M, H - 0.42 * inch, W - M, H - 0.42 * inch)
    c.restoreState()

def fit(path, maxw, maxh):
    iw, ih = PILImage.open(path).size
    s = min(maxw / iw, maxh / ih)
    return Image(path, iw * s, ih * s)

def shot_page(n, title, caption, image):
    """A step: heading and caption above a page-wide screenshot; a tall dialog capture sits beside its caption."""
    out = [Paragraph(f"STEP {n}", st["step"]), Paragraph(title, st["h"])]
    iw, ih = PILImage.open(image).size
    if ih > iw:
        img = fit(image, W - 2 * M - 3.4 * inch, H - 2 * M - 0.9 * inch)
        t = Table([[Paragraph(caption, st["body"]), img]], colWidths=[3.2 * inch, W - 2 * M - 3.2 * inch])
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 12)]))
        out.append(t)
    else:
        out += [Paragraph(caption, st["body"]), Spacer(1, 6), fit(image, W - 2 * M, H - 2 * M - 1.55 * inch)]
    out.append(PageBreak())
    return out

with open(f"{SHOTS}/apilog.json") as f:
    log = json.load(f)
# the playlist year the walkthrough filed into (the captions name it and the year before)
year = max((int(m.group()) for r in log["requests"] if (m := re.search(r"\b20\d\d\b", r["why"]))), default=2026)
story = [Paragraph("How chrisrohn.com uses the YouTube Data API", st["title"]),
  Paragraph("Verifying playlist contents, adding user-approved tracks and removing them, within the signed-in user's own year-based playlists. A walkthrough in screenshots of the API client, with the client's own request log.", st["body"]), Spacer(1, 10),
  Paragraph("What the API client is", st["h"]),
  Paragraph("chrisrohn.com is a personal new-music discovery site. There is no server: the API client is the web page itself, running in the browser of a user signed in with Google, calling the YouTube Data API v3 directly with the OAuth token Google issued to them. It manages only that user's own playlists — for the curator, one playlist per year named <b>&lt;year&gt; | Indie Discotheque</b> in his YouTube Music library. Nothing runs in the background and nothing writes without a tap; every write shows an Undo. The complete source is public at github.com/chrisrohn/chrisrohn.", st["body"]), Spacer(1, 10),
  Paragraph("The only requests it makes", st["h"])]
rows = [["What", "Endpoint", "Quota", "When"],
  ["Verify playlist contents", "playlistItems.list (playlistId, paged)", "1 / 50 tracks", "On sign-in and every 30 minutes: this year's playlist is read so tracks saved from another device are hidden and Keep never files a second copy"],
  ["Verify one video", "playlistItems.list (playlistId + videoId)", "1", "Right before an add to another year's playlist, and before every removal, to find the exact playlist items holding that video"],
  ["Add the approved track", "playlistItems.insert", "50", "Only when the user presses ▲ Keep on a card: the video goes into the year playlist chosen on the card"],
  ["Remove a track", "playlistItems.delete", "50", "Undo within seconds of a Keep; restoring a skipped track; Cleanup: the extra copy of a song added twice, a copy filed in the wrong year, or a copy that no longer streams (swapped for the upload that does)"],
  ["List the library", "playlists.list (mine=true)", "1 / 50", "Guests only, to find or create their own “&lt;year&gt; Picks from chrisrohn.com” playlist. The curator's year playlists are pinned by id; the client never creates them"]]
t = Table([[Paragraph(c, st["cell"]) for c in r] for r in rows], colWidths=[1.5 * inch, 2.3 * inch, 0.9 * inch, W - 2 * M - 4.7 * inch], repeatRows=1)
t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, 0), "DVB"), ("LINEBELOW", (0, 0), (-1, 0), 1.5, INK), ("LINEBELOW", (0, 1), (-1, -1), 0.5, RULE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
story += [t, Spacer(1, 10),
  Paragraph("Why more quota: filling the earlier years from listening history (the Catalog tab, 48 year playlists from 1979) and cleaning the playlists of duplicates and dead uploads (the Cleanup tab) spend 50 units per add or removal, so the default 10,000 units allow about 200 playlist edits a day. The client paces itself: a visible quota meter, bulk actions limited to what the day's quota covers, and one playlist reading reused for every Keep in the following half hour.", st["body"]), Spacer(1, 8),
  Paragraph("The pages that follow are screenshots of the client, in the order a curator uses it. The client's own <b>API activity</b> view (⚙ → API activity) lists each request as it happens with its endpoint, parameters, HTTP result, quota cost, and what it was for. The full request log from this walkthrough is in the appendix.", st["body"]),
  PageBreak()]

def S(n):
    return f"{SHOTS}/{n}.png"
story += shot_page(1, "The feed, signed in as the curator", "The signed-in curator sees three verdict buttons on every card: ≠ wrong video, ▼ Skip, ▲ Keep. The year select on each card names the playlist a Keep will file into (verified release year from MusicBrainz, Discogs and the other catalogues; the curator can change it). Anyone can listen; only a signed-in account whose playlists these are can write, and only from this browser.", S("01-feed"))
story += shot_page(2, "Settings: the account, the quota meter and the API activity view", "⚙ shows the Google account, the year playlists the build knows by id, the running quota meter for the day (each write 50 units, each read 1), the Drive mirror that keeps ratings in step across devices, and the <b>API activity</b> button that opens the live request log.", S("02-settings"))
story += shot_page(3, "On sign-in: verify what this year's playlist already holds", f"The moment a curator signs in (and again every 30 minutes) the client reads “{year} | Indie Discotheque” with <b>playlistItems.list</b>, one unit per page of 50. Anything the playlist already holds, including tracks saved from a phone, is hidden from the feed, and this reading is what the duplicate guard uses so a Keep never files the same video twice.", S("03-activity-signin"))
story += shot_page(4, "Keep: the curator approves a track", f"Pressing ▲ Keep files the track at once. The toast confirms the playlist it went to — “{year} | Indie Discotheque” — and offers Undo for a few seconds. This tap is the one action that writes to YouTube; there are no scheduled or automatic adds.", S("04-keep"))
story += shot_page(5, "The request behind the Keep", f"API activity shows the write: <b>POST playlistItems</b> with the playlist id and the video id, HTTP 200, 50 units, and the reason in words — <i>Keep: add the approved track to “{year} | Indie Discotheque”</i> — with the track it concerned. Because this year's playlist was verified a moment ago (step 3), no extra read was needed.", S("05-activity-add"))
story += shot_page(6, "A different year: the curator picks the playlist", f"A track from an earlier release year files into that year's playlist. Here the year select is changed to {year - 1} before pressing Keep, so the target is “{year - 1} | Indie Discotheque”.", S("06-year-select"))
story += shot_page(7, "Verify, then add", f"For a playlist that was not read recently the client first calls <b>GET playlistItems</b> with playlistId and videoId — <i>Keep: verify “{year - 1} | Indie Discotheque” does not already hold this video before adding it</i> (1 unit) — and only when nothing comes back does it <b>POST</b> the item (50 units). If the video were already there, the Keep would be recorded as a duplicate and nothing added.", S("07-activity-verify-add"))
story += shot_page(8, "Undo", "Undo (the toast's button, or the z key) takes the last Keep back. The card returns to the feed and the toast says “Undone”.", S("08-undo"))
story += shot_page(9, "The request behind the Undo", f"Undo is one <b>DELETE playlistItems</b> by the playlist item id the insert returned — <i>Undo: remove the track the curator just took back from “{year - 1} | Indie Discotheque”</i> — 204, 50 units. Only that item is touched.", S("09-activity-undo"))
story += shot_page(10, "Cleanup: what the daily build found in the year playlists", "The daily build (a GitHub Actions job that reads the public year playlists with an API key and never writes) reports songs whose video appears twice in a year playlist or in two different years, and tracks that no longer stream in the playlists' region. The Cleanup tab lists them, paced by the day's quota, and every removal is a tap with a confirmation.", S("10-cleanup"))
story += shot_page(11, "Remove the extra copy of a song added twice", "“Remove the extra copy” first calls <b>GET playlistItems</b> with the playlist id and the video id to find exactly which items hold that video (1 unit), then <b>DELETE</b>s every copy but the first (50 units each). One copy of the song stays in the playlist.", S("11-activity-cleanup"))
story += shot_page(12, "A track that no longer streams here, and the upload that does", "For a track YouTube Music greys out in the playlists' region, the build looks for another upload of the same song that streams there (preferring the audio track). Cleanup offers a swap: add the streamable upload, remove the dead copy.", S("12-unavailable"))
story += shot_page(13, "The requests behind a swap", "A swap is verify → add → verify → remove: <b>GET</b> to confirm the playlist does not already hold the streamable upload, <b>POST</b> to add it, <b>GET</b> to find the items holding the dead video, <b>DELETE</b> to remove them. 102 units. Everything the client did in this walkthrough is in the log on the next page.", S("13-activity-swap"))

story += [Paragraph("Appendix · the request log from this walkthrough", st["h"]),
  Paragraph("Exported from the client's API activity view (⚙ → API activity → Download JSON). Oldest first. Units are YouTube Data API quota units; every write is a user action described in the pages above.", st["body"]), Spacer(1, 8)]
hdr = ["#", "Method", "Endpoint", "Parameters", "Status", "Units", "What the client was doing", "Track"]
data = [[Paragraph(h, st["cell"]) for h in hdr]]
for i, r in enumerate(log["requests"], 1):
    params = " ".join(f"{k}={str(v)[:22]}{'…' if len(str(v)) > 22 else ''}" for k, v in (r.get("params") or {}).items() if k not in ("part", "maxResults"))
    data.append([Paragraph(str(i), st["cell"]), Paragraph(r["method"], st["mono"]), Paragraph(r["path"], st["mono"]), Paragraph(params, st["mono"]), Paragraph(str(r["status"]), st["mono"]), Paragraph(str(r["units"]), st["mono"]), Paragraph(r["why"], st["cell"]), Paragraph(r.get("detail") or "", st["cell"])])
t = Table(data, colWidths=[0.3 * inch, 0.65 * inch, 1.0 * inch, 2.0 * inch, 0.5 * inch, 0.45 * inch, 3.2 * inch, W - 2 * M - 8.1 * inch], repeatRows=1)
t.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, 0), "DVB"), ("LINEBELOW", (0, 0), (-1, 0), 1.5, INK), ("LINEBELOW", (0, 1), (-1, -1), 0.4, RULE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]))
story += [t, Spacer(1, 10), Paragraph("Privacy policy: chrisrohn.com/privacy.html · Terms: chrisrohn.com/terms.html · Source: github.com/chrisrohn/chrisrohn (the API client is site/src/youtube.js, rating.js and dupes.js; the activity view is site/src/apilog.js).", st["small"])]

doc = SimpleDocTemplate(OUT, pagesize=landscape(letter), leftMargin=M, rightMargin=M, topMargin=M + 0.1 * inch, bottomMargin=M, title="How chrisrohn.com uses the YouTube Data API", author="Chris Rohn", subject="YouTube API Services compliance review — walkthrough")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
