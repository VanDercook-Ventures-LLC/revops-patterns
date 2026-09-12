# Resumable bulk export inside a serverless time budget

**Problem.** Archive an entire CRM account — tens of thousands of contacts — to
Google Sheets, from inside a Code by Zapier step that gets ~30 seconds and no
persistent state. Zapier's own history only reaches back 29–69 days, so the
CRM is the only complete record, and it has to come out before the connection
is retired.

**Root cause of the naive failures.**
- The step times out mid-export and everything since the last write is lost.
- Google Sheets rejects large appends with a `413`. Row count is a useless proxy
  for payload size — one contact's JSON can be 50× another's.
- Offset pagination degrades and gets rejected past a few thousand rows.

**Pattern.**
1. **Time-budgeted loop, cursor out.** Fetch pages until `timeLeft() < 6s`, then
   return `{ done: false, nextCursor }`. Feed the cursor into the next run. The
   export is a sequence of short, safe runs instead of one long fragile one.
2. **Keyset pagination** via the API's opaque `next` cursor, never offset.
3. **Chunk appends by estimated bytes**, not rows: `JSON.stringify(row).length`
   accumulated against an 800 KB cap. A single oversized row still goes on its own
   rather than being dropped.
4. **Flush every N pages** — fewer round-trips than per-page, but a timeout costs
   at most a few hundred rows.
5. **Carry the raw record.** Every row ends with the untouched JSON, so the archive
   loses nothing the column mapping didn't anticipate.
6. **Input Data wins over constants.** Getting this backwards silently ignores
   whatever a human types into the step UI.

## Gotchas worth the scar tissue

- `zapier.fetch()` only injects a connection's credentials if you pass
  `connection:` in the init object. Omit it and every request is a `401`.
- The SDK costs ~10 s of startup on top of your budget — a 20 s budget measured
  ~24 s of real step time.
- "Extended runtime (seconds)" on the Configure tab raises the ceiling to 300 s;
  it bills more than one task, which is irrelevant for a one-off archive.
- `429` → throw with the same cursor. Autoreplay re-runs from where it stopped.

## Usage

Paste `export.js` into a Code by Zapier **action** (not trigger — triggers have no
Input Data), attach the CRM and Google Sheets connections, set the three constants
in the SETTINGS block, run. While `done` is `false`, paste `nextCursor` back in
and run again.

Written against Follow Up Boss; the pattern is API-agnostic.
