# Harness portability

A harness provides workspace preparation, instructions, skills, toolchain commands, a viewer and
verdicts. An engine provides file/shell tools and a documented way to load project instructions.
The runtime binds those two contracts. Package names never occur in an adapter.

## Session lifecycle

`materializeWorkspace` only prepares files and runs init. `prepareHarnessLaunch` then creates a
bundle under `<workspace>/.harness/runtime/<sha256(session key)>/`:

- `runtime.json`: the selected harness and engine, instructions, expanded environment, legacy
  default-engine argv, and skill source paths. It contains no account credentials.
- `CONTEXT.md`: instructions and a discoverable skill index, usable with ordinary file/shell tools.
- `skills/<name>`: links to installed skill assets, without modifying native discovery directories.

The agent process receives `HARNESS_CONTEXT_FILE` and `HARNESS_SKILLS_DIR` through its own tmux
environment. A generic, idempotent bootstrap in its effective project instruction file loads that
context. It does nothing for Coding when that environment variable is absent. Claude and Pi also
receive their documented append-instruction flag. User project instructions remain in place.
Each launch clears inherited `HARNESS_*` session variables it does not explicitly supply,
including a previous account's private grid. Coding and Terminal therefore cannot inherit an
unrelated session's harness context. Runtime bundles and migration backups are ignored by Git.

Create stores `dshRuntime` beside `engine` and `dsh`. Resume and restart reuse the snapshot; fork
copies the source snapshot under a new key. Legacy rows use their stable agent id. A store update
cannot change a saved engine, argv or instructions. Installed tools and skill assets still follow
package updates. Runtime bundles stay with the workspace, so retained sessions can resume them;
deleting a workspace removes its runtime state. This isolates configuration, not project output:
two sessions pointed at the same project intentionally share its artifacts and verdict file.

Missing instructions, missing skills, duplicate skill names, occupied runtime paths, corrupt
snapshots and engine/identity mismatches fail before the engine is spawned. Symlinked managed
directories and instruction files are not overwritten. A missing installed package refuses resume
instead of silently falling back to Coding.

## Existing projects and packages

The spec-1 manifest is unchanged. `engine` is a default; `agent.args` is a legacy extension applied
only when the chosen engine is that default. The runtime converts old workspace-native skill paths
in environment values to `HARNESS_SKILLS_DIR`, rewrites workspace-relative instruction examples
with a quoted `"$HARNESS_SKILLS_DIR"`, and neutralizes the introductory “You are Claude Code/Codex”
wording in legacy instruction text. It leaves upstream source paths intact.

Older materializers appended package instructions under `<!-- harness:dsh owner/name -->` with no
end marker. Migration removes an exact match to known installed package text, keeping all other
project bytes and a `.harness/legacy-AGENTS.md` backup. It removes only native skill links whose
targets exactly match that package. If the legacy text was edited or its package is missing, it
remains untouched and launch explains which section needs resolution. There is no safe general
way to infer where an edited legacy section ends.

`dsh_list.engines` reflects the daemon's adapters, for installed and uninstalled packages alike.
The desktop trusts the selected machine's answer; old daemons without the field offer the manifest
default. The same Harness → Agent → Model → Machine → Project form handles Coding and store packages.
Agent/Model and Machine/Project/Branch are adjacent groups. Advanced hides worktree, approvals and
profile (Codex subscription launches only); Machine stays visible and Start stays pinned below
the scrolling fields, reachable from any field with ⇧⏎. Preferences stay in the existing app data folder;
`new_harness_preferences_v1` separates agent and harness recents and remembers the last engine for
each harness. Legacy preference keys are read without being deleted.

## Model routing at creation

Harness compatibility and model routing are independent contracts. All integrated process engines
can load a harness; only engines whose existing grid adapter supports a model override offer local
and shared models. The selected machine advertises `localModelEngines` and `supportsModelLaunch`
in `grid_models_list`. The picker includes the matching engine subscription/default login and
running models, grouped by owned/shared grid, with each serving machine visible. Machine is where
the agent and project run; it does not constrain where inference runs.

`agent_create` accepts the semantic pair `gridModel` / `gridName`. Both are required together;
unsupported engines, malformed values, raw grid credentials or a simultaneous Codex subscription
profile are refused. The creation receipt fingerprints the semantic pair, not a rotating credential.
After reserving the receipt and before preparing a project, the daemon refreshes model availability
and resolves the target using the existing grid service. Missing targets return `GRID_UNAVAILABLE`
without launching or silently using an engine subscription. Repeating a receipt never resolves
or starts a second time. Clients predating receipts retain their existing response shape.

Drafts and pending receipts retain the exact model/grid. A machine or agent change preserves an
explicit model and revalidates it; choosing Terminal clears model routing. A fresh session defaults
to the engine login. Manage Models opens
the existing lifecycle panel and preserves the draft. Old daemons keep ordinary launches working;
an explicit model choice requires the capability and explains when an update is needed.

## Adapter evidence

Contracts checked 2026-09-23. The portable baseline needs no private provider APIs or guessed flags.

| Engine | Project instructions / additional context | Primary contract |
| --- | --- | --- |
| Claude Code | `CLAUDE.md`, `--append-system-prompt` | Installed 2.1.281 `--help`; [memory](https://code.claude.com/docs/en/memory) |
| Codex | `AGENTS.override.md`, `AGENTS.md` | [project instructions](https://developers.openai.com/codex/guides/agents-md) |
| Cursor | `AGENTS.md` | [CLI usage](https://docs.cursor.com/en/cli/using) |
| OpenCode | `AGENTS.md`, existing `CLAUDE.md` fallback | [rules](https://opencode.ai/docs/rules/) |
| Pi | `AGENTS.md`, existing `CLAUDE.md`; `--append-system-prompt <file>` | Installed CLI `--help`; [source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) |
| Hermes | `.hermes.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` | Installed `hermes_cli/_parser.py`, `hermes_cli/tips.py`; [source](https://github.com/NousResearch/hermes-agent) |
| Command Code | `AGENTS.md` | [project memory](https://commandcode.ai/docs/import) |
| Devin | `AGENTS.md` | [CLI](https://devin.ai/cli) |
| Muse | `AGENTS.md`, existing `CLAUDE.md` fallback | Public [release metadata](https://api.meta.ai/muse-code/channels/muse-stable), executable 1.3.0-R3401.1 `/init` and `/rules` contracts |
| Amp | `AGENTS.md` | [agent instructions](https://ampcode.com/docs/customize/agents-md) |
| Kilo | `AGENTS.md` | [custom instructions](https://kilo.ai/docs/customize/custom-instructions) |
| Grok | `AGENTS.md` | [skills and instruction compatibility](https://docs.x.ai/build/features/skills-plugins-marketplaces) |
| Antigravity | `AGENTS.md`, existing `GEMINI.md` | [rules](https://antigravity.google/docs/rules/) |
| Copilot | `AGENTS.md` | [custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) |

The Muse artifact was checksum-verified (`20c5eb32f6aea741adac032c14be2f1897432caaf35144c33279a4d2b0bd8840`,
macOS ARM64) and inspected without installing it or using credentials. Vendor model execution is
separate from contract testing; passing fixture tests does not claim that every provider ran a model.

## Validation

`cd cli && npm run test:portability` enforces **100% statements, branches, functions and lines per
file** for the runtime, adapters, compatibility projection, launch environment and workspace
materialization, plus semantic model selection and resolution. It also runs DSH integration,
socket, registry and launch-override regression tests.
The broader CLI and desktop suites check affected entry points, persistence and existing app flows.

The matrix covers all 72 store agent manifests on all 14 engines (1,008 combinations), including
restart and fork after package changes. Local instructions and skills use the repository content;
assets normally downloaded by package setup use small fixtures. A separate subprocess lifecycle
for every engine verifies workspace init, context and skills, tool execution, artifacts, verdicts,
restart and fork. These tests do not call provider models or install every native toolchain.

After `cd desktop && flutter test --coverage`, run
`python3 desktop/tool/check_portability_coverage.py` from the repository root. It requires 100%
coverage of changed executable desktop lines. Pass `--base <merge-base>` when checking committed
changes. The interactive host at `desktop/tool/harness_portability_review.dart` uses production
workspace widgets with an in-memory transport and records launch selections without starting agents.
It requires an isolated native bundle, `FLUTTER_TEST=1`, and `HARNESS_REVIEW_CATALOG` pointing to a
JSON array of `dsh_list` rows. Keep its bundle identity separate from the installed application.

### Review evidence (2026-09-23)

- Shuffled portability suite, seed `20260926`: 975 passed, 9 native-toolchain opt-in tests skipped.
  Core coverage: 217/217 statements, 205/205 branches, 36/36 functions, 172/172 lines, including
  semantic model selection and resolution.
- Desktop, seed `20260928`: 679/679 changed executable lines covered; 3,166 passed, 11 skipped,
  18 failures. All 18 reproduce on unchanged `33380665` in account lifecycle, sign-out, expiry,
  local CLI discovery, environment setup, and the machine/model acknowledgement badge test.
  The changed-file coverage gate passes without exclusions.
- Final CLI full shuffled regression, seed `20260926`, two workers: 4,432 passed, 63 skipped,
  no failures. The desk relay test now resets its shared socket inventory before running; its
  previous shuffle-order failure was independently reproduced on unchanged `33380665`.
- Focused desktop run: all 99 model selection, form, configured keyboard and entry-rule
  tests passed, including a correction that labels an explicit Codex subscription profile by name.
- All 27 store packages with an npm test script passed before the rebase. Model Manager was the
  only store package changed by the rebase; its current suite passed all 43 tests.
- TypeScript type checking, CLI build, isolated native app build, and Dart analysis of changed
  production files and new regression tests passed.
- Computer-use walkthroughs exercised the actual native review app at narrow and wide widths:
  Coding and store harnesses; engine-only Agent choices; a legacy harness's compatibility filter;
  the complete scrollable harness catalog; relevant subscription, owned and shared model choices;
  independent model/agent machines; search and Enter; Advanced; and fixture session creation.
  Manage Models and reopening the launch form preserved the selected agent, model, machine and
  project. Native File > New Harness exercises the same command as Cmd-N; synthetic modifier
  injection did not deliver Cmd-N, so physical shortcut behavior is not claimed by that walkthrough.
  Flutter's configured-key and native-command regression tests cover the command dispatch.
- The native walkthrough found and fixed two layout/accessibility problems: expanding Advanced
  could push Start below the viewport, and its semantics merged with the form after pinning it.
  Start is now pinned and has its own accessible bounds. Wide/compact widget tests assert both;
  a final native accessibility click created the fixture session with the chosen shared model.
- Final review also found and fixed a model-to-Terminal transition that kept a model behind the
  disabled Model row and blocked launch. Both forms now omit model routing for Terminal. All 22
  model/Terminal regressions passed, and the native walkthrough selected a Mac Studio model,
  switched to Terminal, and successfully submitted a fixture launch without model routing.

Coverage percentages above describe their measured scopes, not full CLI/desktop branch coverage.
Real provider model calls and the optional native studio installations were not exercised.
