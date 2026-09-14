#!/usr/bin/env python3
"""
Audit a Zap from its draft definition (ZDL), as exported by extract-zdl.js.

    python3 audit.py zap-<id>-draft-zdl.json            # report to stdout
    python3 audit.py zap-<id>-draft-zdl.json --dump     # + every step's params

What it prints
  1. the step tree, with Paths branches indented
  2. counts by app and by action, and which of them bill a task
  3. one row per branch: steps, tasks per run, and what the branch does
  4. smells — the cheap mistakes a 14-branch copy-paste Zap accumulates

Task accounting follows Zapier's rule: triggers, Filters, and Paths are free;
every other step is one task when it runs. A branch's cost is its own action
steps plus every action step above the Paths split.
"""
import json
import re
import sys
from collections import Counter, defaultdict

FREE_TYPES = {"read", "filter"}           # trigger, filter/path condition
ENGINE = "EngineAPI"                      # series / parallel containers
BRANCH_APP = "BranchingAPI"

TOKEN = re.compile(r"\{\{[^}]*\}\}")


def app_name(app):
    """'GoogleSheetsV2CLIAPI@2.17.0' -> 'GoogleSheetsV2'"""
    return re.sub(r"CLIAPI(@[\d.]+)?$", "", app or "")


def is_task(step):
    return step.get("app") != ENGINE and step.get("type") not in FREE_TYPES


def walk(node, depth=0, out=None):
    out = [] if out is None else out
    out.append((depth, node))
    for s in node.get("steps", []):
        walk(s, depth + 1, out)
    return out


def print_tree(root):
    print("## Step tree\n")
    for depth, n in walk(root):
        if n.get("app") == ENGINE:
            continue
        kind = n.get("type")
        tag = "  " if is_task(n) else "· "
        title = n.get("title") or ""
        print(f"{'    ' * (depth - 1)}{tag}{app_name(n.get('app'))} :: {n.get('action')}"
              f"{'  — ' + title if title else ''}"
              f"{'  [branch]' if n.get('app') == BRANCH_APP else ''}")
    print()


def counts(root):
    by_app, by_action = Counter(), Counter()
    tasks = 0
    for _, n in walk(root):
        if n.get("app") == ENGINE:
            continue
        by_app[app_name(n["app"])] += 1
        by_action[f"{app_name(n['app'])}::{n.get('action')}"] += 1
        tasks += is_task(n)
    total = sum(by_app.values())
    print(f"## Counts — {total} steps, {tasks} of them bill a task\n")
    print("| App | Steps |\n|---|---|")
    for a, c in by_app.most_common():
        print(f"| {a} | {c} |")
    print("\n| Action | Steps |\n|---|---|")
    for a, c in by_action.most_common():
        print(f"| {a} | {c} |")
    print()


def branches(root):
    """Yield (label, [action steps]) for every leaf branch, carrying the shared prefix."""
    def rec(node, prefix, label):
        if node.get("action") == "parallel_paths":
            for br in node.get("steps", []):
                yield from rec(br, prefix, label)
            return
        own = [s for s in node.get("steps", []) if s.get("app") != ENGINE and s.get("app") != BRANCH_APP]
        cond = next((s for s in node.get("steps", []) if s.get("app") == BRANCH_APP), None)
        here = label if cond is None else (cond.get("title") or cond.get("id"))
        nested = [s for s in node.get("steps", []) if s.get("action") == "parallel_paths"]
        if nested:
            for p in nested:
                yield from rec(p, prefix + own, f"{here} → ")
        else:
            yield here, prefix + own
    yield from rec(root, [], "")


def print_branches(root):
    print("## Branches\n")
    print("| Branch | Steps | Tasks / run | Does |\n|---|---|---|---|")
    for label, steps in branches(root):
        tasks = sum(is_task(s) for s in steps)
        does = Counter(f"{app_name(s['app'])}::{s.get('action')}" for s in steps if is_task(s))
        summary = ", ".join(f"{k}×{v}" if v > 1 else k for k, v in does.items())
        print(f"| {label} | {len(steps)} | {tasks} | {summary} |")
    print()


def smells(root):
    print("## Smells\n")
    found = 0
    steps = [n for _, n in walk(root) if n.get("app") != ENGINE]

    # 1. Untitled action steps
    untitled = [s for s in steps if is_task(s) and not s.get("title")]
    if untitled:
        found += 1
        print(f"- **{len(untitled)} of {sum(is_task(s) for s in steps)} action steps have no title.** "
              "Name them; a wide Zap with default titles is where the next bug hides.")

    # 2. Formatter steps whose locale/currency disagree with the majority
    fmt = [s for s in steps if app_name(s["app"]).lower().startswith("zapierformatter")]
    keys = ("currency", "currency_locale", "currency_format")
    for k in keys:
        vals = Counter(s["params"].get(k) for s in fmt if s.get("params", {}).get(k))
        if len(vals) > 1:
            found += 1
            majority, _ = vals.most_common(1)[0]
            odd = [s for s in fmt if s["params"].get(k) and s["params"][k] != majority]
            print(f"- **Formatter `{k}` disagrees across steps** — majority `{majority}`, "
                  f"outliers: " + ", ".join(f"`{s.get('title') or s['id']}`=`{s['params'][k]}`" for s in odd))

    # 3. Copies left with the editor's "Copy:" prefix
    copies = [s for s in steps if (s.get("title") or "").startswith("Copy:")]
    if copies:
        found += 1
        print(f"- **{len(copies)} step(s) still titled `Copy: …`** — decide whether each is a deliberate duplicate.")

    # 4. Tokens glued directly onto a URL, or line breaks in an email subject
    for s in steps:
        p = s.get("params", {})
        for k, v in p.items():
            if not isinstance(v, str):
                continue
            if re.search(r"https?://\S*\}\}\{\{", v):
                found += 1
                print(f"- **Token glued onto a URL** in `{app_name(s['app'])}::{s.get('action')}` field `{k}` "
                      f"(step {s['id']}) — the link is broken.")
            if k == "subject" and "\n" in v:
                found += 1
                print(f"- **Line break in an email subject** (step {s['id']}) — usually body text pasted in the wrong field.")

    # 5. Formatter output consumed by exactly one step that is a spreadsheet write
    consumers = defaultdict(set)
    for s in steps:
        for v in json.dumps(s.get("params", {})).split("{{"):
            m = re.match(r"=gives\['(\d+)'\]|(\d+)__", v)
            if m:
                consumers[m.group(1) or m.group(2)].add(s["id"])
    sheet_only = []
    for s in fmt:
        c = consumers.get(str(s["id"]), set())
        if c and all(any(t["id"] == cid and "sheet" in app_name(t["app"]).lower() for t in steps) for cid in c):
            sheet_only.append(s)
    if sheet_only:
        found += 1
        print(f"- **{len(sheet_only)} Formatter step(s) feed only a spreadsheet write** — "
              "the sheet can format the column itself; write the raw value and drop the task: "
              + ", ".join(f"`{s.get('title') or s['id']}`" for s in sheet_only))

    # 6. Trigger fires on updates too
    trig = steps[0]
    if "updated" in (trig.get("action") or ""):
        found += 1
        print(f"- **Trigger is `{trig['action']}`** — edits to an existing record re-run the whole Zap. "
              "Confirm that is wanted.")

    if not found:
        print("- none of the checked smells present")
    print()


def dump(root):
    print("## Step parameters\n")
    for depth, n in walk(root):
        if n.get("app") == ENGINE:
            continue
        print(f"### {n['id']} · {app_name(n['app'])} :: {n.get('action')}  {n.get('title') or ''}")
        for k, v in n.get("params", {}).items():
            vs = json.dumps(v, ensure_ascii=False)
            print(f"- `{k}`: {vs[:400]}{'…' if len(vs) > 400 else ''}")
        print()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    doc = json.load(open(sys.argv[1]))
    root = doc["draft"]["zdl"] if "draft" in doc else doc  # accept the raw zdl too
    print(f"# Zap audit — {root.get('title')}\n")
    print_tree(root)
    counts(root)
    print_branches(root)
    smells(root)
    if "--dump" in sys.argv:
        dump(root)


if __name__ == "__main__":
    main()
