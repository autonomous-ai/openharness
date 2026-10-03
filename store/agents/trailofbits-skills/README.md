# Trail of Bits Skills, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[Trail of Bits Skills](https://github.com/trailofbits/skills): open it on a codebase, ask for a
security audit, and watch the report fill in beside the terminal — scope, context, static analysis,
supply chain, variants, and every finding put through `fp-check` before it counts. Runs on Claude
Code by default and on every agent Harness integrates: the skills of eleven Trail of Bits
code-audit plugins are linked into the session, pinned and unedited.

- `harness.json` — the manifest: Claude Code by default, the template, the toolchain, the shared web
  viewer, and `agent.skills`: one skill of ours and each plugin's `skills/` folder under `upstream/`.
  Nothing is installed into the person's Claude Code or Codex configuration.
- `AGENTS.md` — what the agent is told: read, do not run; touch only `security-audit/`; nothing
  leaves the machine; verify every finding; rebuild the report after every change.
- `skills/trailofbits-harness/` — the one skill of ours: the `findings.json` format, which skill
  serves which phase, the tools on `$TOB_BIN`, and how the plugin features the skills assume are
  provided when they are linked: the plugin root, named sub-agents (a sub-agent given the plugin's
  own `agents/<name>.md`), `Workflow` scripts by absolute path, and fp-check's hook gates as a
  checklist.
- `upstream/` — the eleven plugins, fetched by setup at the commit in `VERSIONS` (not in git).
- `template/security-audit/findings.json` — the only thing this package adds to the audited
  repository, with the report generated beside it; it is also the workspace marker. Harness itself
  adds `.harness/` and a short session bootstrap in `CLAUDE.md`, as it does for every Claude Code
  harness. A repository that already had files is not trusted on the person's behalf: Claude Code
  asks, which is what an audit of someone else's code should do.
- `toolchain/` — `setup.sh` (the plugins at the pin; Semgrep and pip-audit at the versions upstream's
  scripts were verified with, in a Python 3.12 venv uv brings when the machine has none; `bin/` with
  them, uv and python3; playwright-core for the PDF), `doctor.sh`, `init-workspace.sh`, and
  `report.sh`/`report.mjs` (`$TOB_REPORT`: check findings.json, write `index.html`, `report.md`,
  optionally `report.pdf`, and the verdict).

The phases in the pane header are Scope, Context, Scan, Review, Verify and Report. The header is
ready only when the report is final and no finding is still unverified; confirmed high findings
count as errors and medium ones as warnings.

The Store example (`store/showcase/trailofbits-skills/nodegoat-audit.jpg`) is this harness's real
report on [OWASP NodeGoat](https://github.com/OWASP/NodeGoat) (Apache-2.0) at `c5cb68a`, a
deliberately vulnerable training app, from the example's prompt on Claude Code. It is shown as the
run left it: 5 findings confirmed, 5 dismissed, and 17 still unverified, because the model's safety
checks stopped their exploit write-ups — the report says so rather than confirming them.

## What the agent needs

Sub-agents: Claude Code and Codex both have them, so the plugins' named reviewers run as sub-agents
given the plugin's own prompt files. `c-review` and `audit-context-building`'s codebase mode run a
`Workflow` script, which needs Claude Code; elsewhere they fall back to per-unit review and the
report says so. `insecure-defaults` is not included: it is a `Workflow`-only command with no skill.
Plugin hooks do not run when skills are linked; fp-check's completeness gates are a checklist in the
bridging skill instead. CodeQL and ripgrep are optional; the skills fall back to Semgrep and
`grep -E`. If the person also installed the trailofbits marketplace in Claude Code, its copies of
these skills appear twice; disable the marketplace plugins for this workspace.

## Credit and stewardship

Trail of Bits Skills is Trail of Bits' work: [trailofbits/skills](https://github.com/trailofbits/skills),
Creative Commons Attribution-ShareAlike 4.0 (`LICENSE-trailofbits`), each plugin by the authors its
manifest names. The plugins are fetched at the commit in `VERSIONS` and loaded byte for byte
(`THIRD_PARTY_NOTICES.md`). Nothing of it is changed here.
This folder is the Harness wrapper — the manifest, the agent guide, the bridging skill, the
workspace template and the report writer — written by Autonomous to bring Trail of Bits' plugins into
Harness. We did that work on the project's behalf, to bootstrap the catalogue; the credit for what
the agent can do belongs upstream.

If you maintain Trail of Bits Skills and want to own its Harness package, it is yours: open an issue
on [OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in the plugins belong
upstream, bugs in the wrapper belong here, and a newer release is a bump of `UPSTREAM_COMMIT` in
`VERSIONS`.

```sh
harness dsh check .                    # conformance
toolchain/setup.sh                     # upstream/, .venv/, bin/, node_modules/
harness dsh install "$PWD" --link      # this checkout as the installed agent
node --test test/*.test.mjs            # findings, report, verdict, and the plugin skills it links
```
