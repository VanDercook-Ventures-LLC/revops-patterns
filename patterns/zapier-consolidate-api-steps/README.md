# Collapse N Zap steps into one code step

**Problem.** A lead-summary Zap made four separate API calls — person record,
notes, texts, calls — as four Zapier steps, then fed four raw JSON envelopes to an
AI step. Every run burned four tasks before the summary even started, and the
LLM was summarising API noise (privacy-redaction notices, HTML tags, ID fields).

**Root cause.** Zapier steps are the wrong unit of work for "fetch several
related things about one entity." Each step is a task, a failure point, and a
separate payload the next step has to reconcile.

**Pattern.**
1. **One `Promise.all`** of the four fetches inside a single code step. Four
   tasks become one.
2. **Non-fatal fetches.** Each call returns `{ ok, data | error }` rather than
   throwing, so a flaky secondary endpoint costs a thinner summary, not the run.
   Only the primary record is worth failing over.
3. **Explicit field list** on the primary fetch. `allFields` is enormous;
   asking for what you need keeps the payload small and predictable.
4. **Normalize at the edge.** Strip HTML, drop redacted bodies but keep their
   metadata (that outreach happened, when, by whom, still carries signal), parse
   structured `Key: Value` tags into facts.
5. **Emit one chronological transcript** — oldest first, one line per event —
   for the AI step. A single clean narrative beats four JSON blobs on both token
   cost and summary quality.
6. **Roll up the noise.** Twenty-nine near-zero-second call attempts tell an LLM
   nothing individually; "29 attempts, 2 connected, between Mar 3 and Apr 9"
   tells it everything.
7. **Return one top-level object** so downstream steps run exactly once.
8. **Truncation flags** from `_metadata.total`, so the summary can say "history
   clipped at 40" instead of silently pretending it saw everything.

## Gotchas

- Resolve the connection id explicitly from the `connections` global (guard with
  `typeof` first — a bare undeclared global throws `ReferenceError`). Don't let
  the step silently pick the wrong account if a second connection gets attached.
- Match redaction notices on the stable middle of the phrase — the exact wording
  varies by account and endpoint.
- Throw on bad input rather than returning, so Zapier autoreplay can engage.
- Domain rules don't transfer across verticals. A "Seller tag means seller"
  convention is meaningless in a lending account; detect the context and only
  emit the label when it applies.

## Usage

Paste `consolidate.js` into a Code by Zapier action, attach the CRM connection,
map `personId` from the upstream step, set `CONNECTION_VAR`. Map the returned
`transcript` into your AI step.

Written against Follow Up Boss; the pattern applies to any CRM with per-entity
activity endpoints.
