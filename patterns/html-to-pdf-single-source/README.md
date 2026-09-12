# HTML → PDF, single source of truth

**Problem.** A web page and its downloadable PDF drift apart. Someone edits the
page, forgets the PDF, and the two versions disagree — in my case, the PDF kept
shipping figures the page had already removed.

**Root cause.** Two copies of the content. The PDF builder carried its own
duplicate of the text.

**Pattern.** Make the HTML the only source. Parse it at build time with a small
`HTMLParser` that keys on semantic class names, and emit the PDF from the parsed
structure. There is nothing to keep in sync because there is only one thing.

## What it handles

- **Block-of-interest stack** in the parser, so inline tags (`<strong>`, `<span>`,
  `<a>`) stay transparent and never truncate their parent block. The first version
  flushed on *every* end tag — a subtle bug that silently cut paragraphs short.
- **Real bullet glyphs.** reportlab's default Helvetica is Latin-1 only; `•` encodes
  as `\177` (DEL). Registering a TTF (Arial here) and using `bulletType`/`start`
  fixes it. Passing a string to `ListItem(value=...)` renders the literal word — that
  one made it into a recruiter-facing PDF.
- **Clickable links** captured from `href` and re-emitted as `<link>`.
- **Page breaks** before named sections via `PAGE_BREAK_BEFORE`.
- **`pageCompression=0`** so the text layer stays greppable. Verify what you shipped,
  not what you think you shipped.

## Usage

    python3 build_pdf.py resume.html resume.pdf --title "Résumé" --author "Your Name"

Requires `reportlab`. Expects the source HTML to use the class names the parser
looks for (`page-hero`, `lead`, `pm`, `resume-sec`, `exp`, `exp-head`, `when`,
`co`, `sk`, `cert`) — rename to taste in one place.

## Verification lesson

Grepping raw PDF bytes proves nothing — content streams are compressed and fonts
are subset. My first "audit" returned zero matches for forbidden terms *and* for
terms I knew were present. Extract the text layer through the ToUnicode CMap, and
always include a positive control: a term you know is there. A negative result
with no positive control is not a result.
