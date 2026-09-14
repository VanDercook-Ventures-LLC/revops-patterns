# Audit a big Zap from its draft definition, not its canvas

**Problem.** A 78-step Zap — one form, fourteen Paths branches, each a
copy-pasted email / note / spreadsheet / attachment template — needed a task
audit. The editor canvas is virtualized: it will not screenshot, collapses when
you expand it, and shows one branch at a time. The public Workflow API wants an
OAuth app with the `zap` scope. The internal `/api/v4/zaps/<id>/` returns the
node list with no titles and no field mappings. Reading 78 steps by clicking
into each one is a day of work and still misses the cross-step mistakes.

**Root cause.** The wrong surface. The editor is a Next.js page, and Next ships
its server-rendered props to the browser in a `__NEXT_DATA__` script tag. The
*whole* draft — every step, title, filter rule and field mapping, the same ZDL
document the editor itself renders from — is already in the page before a
single step is clicked.

**Pattern.**

1. **Extract, don't scrape.** `extract-zdl.js` in the browser console on
   `/editor/<id>/draft` downloads the definition as JSON. Read-only, one paste,
   ~150 KB for 78 steps. It works because you are already logged in; no token,
   no app, nothing leaves the browser.
2. **Flatten the tree.** ZDL nests `EngineAPI` containers (`series_*`,
   `parallel_paths`) around real steps; Paths conditions are `BranchingAPI`
   filters. `audit.py` walks it and prints the tree with the containers hidden.
3. **Count what bills.** Triggers, Filters and Paths conditions are free; every
   other step is a task when it runs. Count steps by app and by action, then
   **per branch**: a branch's cost is its own action steps plus everything above
   the split (the lookup every run pays for). That table is the audit — it shows
   at a glance which branch is 11 tasks and which is 2.
4. **Check the smells mechanically.** In a copy-pasted Zap the bugs are
   *inconsistencies*, and inconsistencies are countable:
   - Formatter steps whose `currency` / `locale` / `format` disagree with the
     majority (found two branches quietly emitting Australian dollars with
     Indian digit grouping into a US deal board).
   - A `{{token}}` glued straight onto the end of a URL — a broken link in
     every email that branch sends.
   - Line breaks in an email `subject` — body text pasted into the wrong field.
   - Steps still titled `Copy: …`.
   - Formatter steps whose only consumer is a spreadsheet write. The sheet can
     format the column; the task is pure waste.
   - A trigger on *new or updated* records when only new was meant.
   - Action steps with no title at all (38 of 60 in the case that prompted this).
5. **Then decide where the money is.** Per-run cost of a Paths-based Zap is
   usually already near the floor — filters are free and each branch runs only
   what it needs. Collapsing it into one linear flow with a Code-step lookup
   table is a *maintainability* move (78 steps → ~22) that adds a task to every
   run; net it is roughly task-neutral. The savings live in the questions the
   table makes obvious: does every branch need both the email *and* the CRM
   note; do the four Formatters feeding one sheet need to exist; should the
   trigger fire on edits.

## Usage

```
# 1. in the browser console on https://zapier.com/editor/<id>/draft
#    paste extract-zdl.js  →  zap-<id>-draft-zdl.json in Downloads

# 2. locally
python3 audit.py zap-<id>-draft-zdl.json           # tree, counts, branch table, smells
python3 audit.py zap-<id>-draft-zdl.json --dump    # + every step's parameters
```

## Gotchas

- Zapier's own step counter includes the Paths steps themselves; `audit.py`
  counts real steps and conditions, so expect its total to be lower by the
  number of Paths blocks.
- Steps in a copied Zap carry `meta.$editor.missing_field_mapping` entries
  pointing at the *source* Zap's step ids. They are informational, not live
  references — the `params` are what runs.
- Two mapping syntaxes coexist: `{{=gives['<step>']["<key>"]}}` and the older
  `{{<step>__<key>}}`. The consumer check in `audit.py` matches both.
- Nested Paths (a "Fallback" branch holding a second Paths block) is how authors
  get past the per-block branch cap. The branch walker follows the nesting and
  carries the shared prefix into every leaf.
- Open the editor read-only and close the tab. Zapier lets two tabs edit one
  draft and they overwrite each other; the extract needs zero clicks, so give it
  zero.

Written against a Google Forms → Sheets → CRM Zap; nothing in the extractor or
the auditor is specific to those apps.
