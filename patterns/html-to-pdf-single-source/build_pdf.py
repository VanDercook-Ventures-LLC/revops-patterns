#!/usr/bin/env python3
"""Render a structured HTML page to PDF with reportlab, using the HTML as the
single source of truth.

Pattern: the web page IS the document. The PDF is derived from it at build time,
so the two can never drift apart. Pure-Python — no pango/cairo/weasyprint needed.

Usage:
    python3 build_pdf.py SRC.html OUT.pdf [--title "..."] [--author "..."]
"""
import argparse
import os
import re
from html.parser import HTMLParser

from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, ListFlowable, ListItem,
    HRFlowable, PageBreak,
)

ARGS = argparse.ArgumentParser(description=__doc__.split("\n")[0])
ARGS.add_argument("src", help="source HTML file")
ARGS.add_argument("out", help="output PDF path")
ARGS.add_argument("--title", default="", help="PDF metadata title")
ARGS.add_argument("--author", default="", help="PDF metadata author")
_a = ARGS.parse_args()
SRC, OUT, TITLE, AUTHOR = _a.src, _a.out, _a.title, _a.author

INK = "#1c1c24"
HEAD = "#14110E"
CLAY = "#C44A1E"
MUTED = "#5a5a66"
RULE = "#dcdce4"

TAGLINE = "REVENUE OPERATIONS &bull; AI-NATIVE PROCESS &amp; AUTOMATION &bull; GTM SYSTEMS"

# --- Fonts -----------------------------------------------------------------
# The built-in Type1 Helvetica is Latin-1 only: a bullet (U+2022) comes out as
# \177 (DEL), which is why list bullets and separators rendered as nothing.
# Arial is metrically identical to Helvetica and ships with macOS, so register
# it as a TrueType face to get real Unicode. Fall back to Helvetica + a Latin-1
# middle dot if it is not present.
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_ARIAL = "/System/Library/Fonts/Supplemental/"
UNICODE_OK = False
BODY, BODY_BOLD, BODY_ITALIC = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"
try:
    pdfmetrics.registerFont(TTFont("Body", _ARIAL + "Arial.ttf"))
    pdfmetrics.registerFont(TTFont("Body-Bold", _ARIAL + "Arial Bold.ttf"))
    pdfmetrics.registerFont(TTFont("Body-Italic", _ARIAL + "Arial Italic.ttf"))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold",
                                  italic="Body-Italic")
    BODY, BODY_BOLD, BODY_ITALIC = "Body", "Body-Bold", "Body-Italic"
    UNICODE_OK = True
except Exception as exc:                                    # pragma: no cover
    print("Arial unavailable (%s); falling back to Helvetica" % exc)

BULLET = "•" if UNICODE_OK else "·"
SEP = " &nbsp;&#8226;&nbsp; " if UNICODE_OK else " &nbsp;&#183;&nbsp; "

# Sections that should start on a fresh page.
PAGE_BREAK_BEFORE = {"AI & AUTOMATION PROJECTS"}

# Helvetica covers Latin-1 only; anything outside it renders as a tofu box.
GLYPH_FIXES = {
    "↗": "",        # ↗ external-link arrow
    "→": "",        # →
    "←": "",        # ←
    "–": "-",       # en dash
    "—": "-",       # em dash
    "‘": "'", "’": "'",
    "“": '"', "”": '"',
    "…": "...",
    # "³" kept when a Unicode font is active; mapped below otherwise
}


def sanitize(t):
    for a, b in GLYPH_FIXES.items():
        t = t.replace(a, b)
    if not UNICODE_OK:
        # Helvetica fallback: drop anything outside Latin-1 rather than emit a box
        t = "".join(ch if ord(ch) < 256 else "" for ch in t)
    return t.strip()


def esc(t):
    """Escape for reportlab's mini-HTML paragraph parser."""
    return sanitize(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def link(text, href):
    """Wrap text in a clickable reportlab link."""
    if not href:
        return text
    href = href.replace("&", "&amp;").replace('"', "%22")
    return '<link href="%s" color="%s">%s</link>' % (href, CLAY, text)


class ResumeParser(HTMLParser):
    """Pull structured resume content out of the rendered page.

    Only "block of interest" tags reset and flush the text buffer; inline tags
    (strong, em, a, decorative spans) are transparent, so markup inside a
    bullet or heading does not truncate it. Any href seen while a block is open
    is captured so links survive into the PDF.
    """

    SKIP = ("nav", "footer", "script", "style", "svg", "button", "form")

    def __init__(self):
        super().__init__()
        self.blocks = []          # (kind, text, href|None)
        self.buf = []
        self.href = None
        self.open_kind = []
        self.in_main = False
        self.in_hero = False
        self.skip_depth = 0

    def _kind(self, tag, c):
        cl = c.split()
        if tag == "h1" and self.in_hero:
            return "name"
        if tag == "p" and "lead" in cl and self.in_hero:
            return "summary"
        if tag == "span" and "pm" in cl:
            return "pm"
        if tag == "h2" and self.in_main:
            return "h2"
        if tag == "h3" and self.in_main:
            return "role"
        if tag == "span" and "when" in cl:
            return "when"
        if tag == "div" and "co" in cl:
            return "co"
        if tag == "li" and self.in_main:
            return "li"
        if tag == "span" and "sk" in cl:
            return "sk"
        if tag == "div" and "cert" in cl:
            return "cert"
        return None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        c = a.get("class", "")
        if tag in self.SKIP:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "header" and "page-hero" in c:
            self.in_hero = True
        if tag == "main":
            self.in_main = True
        if tag == "a" and self.open_kind and a.get("href") and not self.href:
            self.href = a["href"]
        k = self._kind(tag, c)
        if k:
            self.buf = []
            self.href = None
            self.open_kind.append((tag, k))

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if self.open_kind and self.open_kind[-1][0] == tag:
            _, k = self.open_kind.pop()
            txt = re.sub(r"\s+", " ", "".join(self.buf)).strip()
            href = self.href
            self.buf, self.href = [], None
            if txt:
                self.blocks.append((k, txt, href))
        if tag == "header":
            self.in_hero = False
        if tag == "main":
            self.in_main = False

    def handle_data(self, d):
        if not self.skip_depth:
            self.buf.append(d)

    def handle_entityref(self, name):
        import html as _h
        if not self.skip_depth:
            self.buf.append(_h.unescape("&%s;" % name))

    def handle_charref(self, name):
        try:
            cp = int(name[1:], 16) if name[:1].lower() == "x" else int(name)
        except ValueError:
            return
        if not self.skip_depth:
            self.buf.append(chr(cp))


def build():
    p = ResumeParser()
    p.feed(open(SRC, encoding="utf-8").read())
    blocks = p.blocks

    S = {
        "name": ParagraphStyle("name", fontName=BODY_BOLD, fontSize=22,
                               leading=24, textColor=HEAD, spaceAfter=3),
        "tag": ParagraphStyle("tag", fontName=BODY_BOLD, fontSize=8.4,
                              leading=11, textColor=CLAY, spaceAfter=7),
        "contact": ParagraphStyle("contact", fontName=BODY, fontSize=8.9,
                                  leading=11.5, textColor=MUTED),
        "summary": ParagraphStyle("summary", fontName=BODY, fontSize=9.3,
                                  leading=13, textColor=INK, spaceAfter=2),
        "h2": ParagraphStyle("h2", fontName=BODY_BOLD, fontSize=9.2,
                             leading=11, textColor=HEAD, spaceBefore=12,
                             spaceAfter=3),
        "role": ParagraphStyle("role", fontName=BODY_BOLD, fontSize=10.2,
                               leading=13, textColor=HEAD, spaceBefore=6),
        "co": ParagraphStyle("co", fontName=BODY_ITALIC, fontSize=8.9,
                             leading=11, textColor=CLAY, spaceAfter=3),
        "li": ParagraphStyle("li", fontName=BODY, fontSize=9.3,
                             leading=12.6, textColor=INK, alignment=TA_LEFT,
                             spaceAfter=1.5),
        "tags": ParagraphStyle("tags", fontName=BODY, fontSize=9.2,
                               leading=13.4, textColor=INK, spaceAfter=1),
    }

    story, bullets, tags, certs, contacts = [], [], [], [], []

    def flush_bullets():
        if not bullets:
            return
        story.append(ListFlowable(
            [ListItem(Paragraph(esc(b), S["li"]), leftIndent=13, spaceBefore=0)
             for b in bullets],
            bulletType="bullet",
            start=BULLET,
            bulletFontName=BODY,
            bulletFontSize=6.5,
            bulletOffsetY=-1.2,
            leftIndent=13,
            bulletDedent=13,
            spaceBefore=1,
            spaceAfter=4,
        ))
        bullets.clear()

    def flush_tags():
        if tags:
            story.append(Paragraph(
                SEP.join(esc(t) for t in tags), S["tags"]))
            tags.clear()
        if certs:
            story.append(ListFlowable(
                [ListItem(Paragraph(esc(c), S["li"]), leftIndent=13,
                          spaceBefore=0) for c in certs],
                bulletType="bullet",
                start=BULLET,
                bulletFontName=BODY,
                bulletFontSize=6.5,
                bulletOffsetY=-1.2,
                leftIndent=13,
                bulletDedent=13,
                spaceBefore=1,
                spaceAfter=4,
            ))
            certs.clear()

    i = 0
    while i < len(blocks):
        kind, val, href = blocks[i]

        if kind == "name":
            story.append(Paragraph(esc(val), S["name"]))
            story.append(Paragraph(TAGLINE, S["tag"]))

        elif kind == "pm":
            contacts.append((val, href))
            if i + 1 >= len(blocks) or blocks[i + 1][0] != "pm":
                parts = []
                for txt, h in contacts:
                    e = esc(txt)
                    if e:
                        parts.append(link(e, h))
                story.append(Paragraph(SEP.join(parts), S["contact"]))
                story.append(HRFlowable(width="100%", thickness=2.2, color=CLAY,
                                        spaceBefore=8, spaceAfter=9))
                contacts.clear()

        elif kind == "summary":
            story.append(Paragraph(esc(val), S["summary"]))

        elif kind == "h2":
            flush_bullets(); flush_tags()
            title = esc(val).upper()
            if title in PAGE_BREAK_BEFORE:
                story.append(PageBreak())
            story.append(Paragraph(title, S["h2"]))
            story.append(HRFlowable(width="100%", thickness=0.8, color=RULE,
                                    spaceBefore=0, spaceAfter=5))

        elif kind == "role":
            flush_bullets()
            when = ""
            if i + 1 < len(blocks) and blocks[i + 1][0] == "when":
                when = blocks[i + 1][1]
                i += 1
            head = esc(val)
            if when:
                head += "  <font size=8.5 color='%s'>%s</font>" % (MUTED, esc(when))
            story.append(Paragraph(head, S["role"]))

        elif kind == "co":
            story.append(Paragraph(link(esc(val), href), S["co"]))

        elif kind == "li":
            bullets.append(val)
        elif kind == "sk":
            tags.append(val)
        elif kind == "cert":
            certs.append(val.lstrip("·→• ").strip())

        i += 1

    flush_bullets(); flush_tags()

    doc = BaseDocTemplate(
        OUT, pagesize=LETTER,
        leftMargin=0.68 * inch, rightMargin=0.68 * inch,
        topMargin=0.58 * inch, bottomMargin=0.55 * inch,
        title=TITLE,
        author=AUTHOR,
        # uncompressed so the text layer stays greppable for compliance review
        pageCompression=0, invariant=1,
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="body", showBoundary=0)
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame])])
    doc.build(story)
    print("Wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    build()
