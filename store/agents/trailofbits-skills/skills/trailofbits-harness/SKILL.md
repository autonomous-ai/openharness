---
name: trailofbits-harness
description: Use in every Trail of Bits Skills workspace inside Harness, before any audit skill — the findings.json format the report pane is built from, which Trail of Bits skill serves which audit phase, and how their plugin features (plugin root, named sub-agents, Workflow scripts, fp-check's gates) work when their skills are linked rather than installed as plugins.
---

# A Trail of Bits audit in Harness

Trail of Bits' skills are the method; this skill only says how their work lands in the report pane
and how the plugin features they assume are provided here. It changes none of their instructions.

## findings.json

`security-audit/findings.json` is the one file you edit. `"$TOB_REPORT"` checks it, rebuilds the
pane and the Markdown report from it, and prints every entry it had to leave out and why — fix those
before moving on.

```json
{
  "spec": 1,
  "target": { "name": "shop-api", "path": ".", "commit": "3f2c9a1…", "scope": ["src/", "api/"] },
  "phase": "review",
  "final": false,
  "summary": "Markdown: what was audited, how, and the headline risks.",
  "findings": [
    {
      "id": "F-1",
      "title": "SQL query built from request input",
      "severity": "high",
      "status": "unverified",
      "category": "injection",
      "source": "static-analysis/semgrep",
      "location": [{ "file": "src/db.py", "line": 42 }],
      "description": "Markdown: what is wrong.",
      "evidence": "Markdown: the data flow, the rule that fired, the fp-check verdict and its reasons.",
      "recommendation": "Markdown: how to fix it."
    }
  ]
}
```

- `phase`: `scope` → `context` → `scan` → `review` → `verify` → `report`. The header's strip is this.
- `severity`: `high`, `medium`, `low`, `informational`, `undetermined` — Trail of Bits' own scale.
- `status`: `unverified` when found, then `confirmed` or `false-positive` after `fp-check`. False
  positives stay in the file (the report lists them as dismissed, with their evidence).
- `id`: `F-1`, `F-2`, … in the order found; never reuse one. Paths are relative to the target.
- The Markdown fields render paragraphs, `-` lists, `code`, fenced code, **bold** and *italics* — nothing else.
  Everything is escaped, so quoting hostile strings from the code is safe.
- The report is ready (`ready` in the header) only when `final` is true and nothing is `unverified`.

## Which skill serves which phase

| Phase | Trail of Bits skill (plugin) | When |
|---|---|---|
| context | `audit-context-building` | always first: understand before hunting |
| scan | `semgrep`, `codeql` when installed, `sarif-parsing` (static-analysis) | always |
| scan | `supply-chain-risk-auditor` | a lockfile or manifest is present |
| scan | `sharp-edges` | APIs, configuration and defaults that invite misuse |
| scan | `agentic-actions-auditor` | `.github/workflows/` exists |
| scan | `c-review` / `rust-review` | C/C++ / Rust code in scope |
| review | `vulnerability-triage-brocards` | triage each candidate before deep work |
| review | `variant-analysis` | a confirmed bug suggests siblings elsewhere |
| review | `differential-review` | the person asks about a change, branch or PR |
| verify | `fp-check` | every finding, before it is `confirmed` |

Turn each skill's output — SARIF, ledgers, reports — into findings.json entries, citing it in
`source`.

## Plugin features, provided here

These skills were written as Claude Code plugins. Harness links their skills into every agent, so
the plugin machinery they mention is provided like this:

- **Plugin root.** Where a skill uses `${CLAUDE_PLUGIN_ROOT}`, `${CODEX_PLUGIN_ROOT}` or
  `<plugin_root>`, it is `$TOB_SKILLS/plugins/<plugin>` for the plugin the skill belongs to. Set it
  on the command that needs it — `CLAUDE_PLUGIN_ROOT="$TOB_SKILLS/plugins/c-review" …` — and use
  that path, not a search: a search of `.` would find copies inside the audited repository.
- **Named sub-agents.** When a skill dispatches `<plugin>:<agent>` (`fp-check:poc-builder`,
  `rust-review:rust-review-worker`, `audit-context-building:function-analyzer`), start a sub-agent
  with your own sub-agent tool and give it `$TOB_SKILLS/plugins/<plugin>/agents/<agent>.md` as its
  instructions, plus the task the skill describes. Hold it to the tools that file's front matter
  lists. Where the skill runs several in parallel, run them in parallel.
- **Plugin commands.** A `/<plugin>:<command>` that a skill mentions is a Markdown file,
  `$TOB_SKILLS/plugins/<plugin>/commands/<command>.md` (`/differential-review:diff-review`): read
  it and follow it, with the arguments the person gave.
- **Workflow scripts.** Where a skill calls Claude Code's `Workflow` tool with a
  script under `<plugin_root>/workflows/`, or a command such as `/audit-context-building:audit-context`
  that is backed by one, call `Workflow` with the absolute `scriptPath`
  (`$TOB_SKILLS/plugins/<plugin>/workflows/<name>.js`) and the arguments the skill documents. An
  agent without a `Workflow` tool follows the skill's single-unit mode over each unit in scope and
  says so in the report's summary.
- **fp-check's gates.** Its plugin hooks check, before a verification ends, that every phase and
  gate was done. Here nothing runs them for you: before you set a finding `confirmed` or
  `false-positive`, read the two prompts in `$TOB_SKILLS/plugins/fp-check/hooks/hooks.json` and
  check your own work against them; a gap keeps the finding `unverified`.

## Tools

The Semgrep, pip-audit, uv and Python the skills expect are in `$TOB_BIN`; put it first on each
command's PATH: `PATH="$TOB_BIN:$PATH" semgrep --metrics=off …`. CodeQL and ripgrep are optional
here; when they are missing, the skills' own fallbacks apply (`toolchain/doctor.sh` in the package
says which are present).
