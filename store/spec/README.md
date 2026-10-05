# Domain-specific harness contract (spec 1)

Frozen 2026-09-14. Changes go to [CHANGES.md](CHANGES.md), append-only.

A DSH is a git repo, or one folder of one (a registry entry's `path`; see CHANGES.md 2026-09-17).
Harness reads `harness.json` at its root and nothing else about its code.


## `harness.json`

```jsonc
{
  "spec": 1,
  "id": "autonomous/autonomous-circuit", // owner/name; the install dir and the wire id
  "name": "Autonomous Circuit",           // the picker tile
  "description": "Chat with AI → a board you can order",
  "engine": "claude",                     // base engine, one of ENGINES
  "workspace": {
    "template": "template",               // copied into an EMPTY workspace (no marker present)
    "marker": "product.json",             // relative path; present = already materialized
    "init": "toolchain/init-workspace.sh" // optional; run after the template copy, cwd = workspace
  },
  "agent": {
    "instructions": "AGENTS.md",          // copied to <workspace>/AGENTS.md, see below
    "skills": ["skills"],                 // dirs whose SKILL.md-bearing subdirs are linked in
    "env": { "CIRCUIT_TOOLCHAIN": "${dsh}/toolchain" },  // ${dsh} ${workspace} ${home} expand
    "args": []                            // appended to the base engine's argv
  },
  "toolchain": {
    "setup": "toolchain/setup.sh",        // run once at install, cwd = install dir
    "doctor": "toolchain/doctor.sh"       // exit 0 = ready; stdout lines are shown to the user
  },
  "viewer": {                             // optional (tier 2)
    "command": "toolchain/viewer.sh",     // long-running; env HARNESS_VIEWER_PORT, HARNESS_WORKSPACE
    "url": "http://127.0.0.1:${port}/?file=${artifact}",  // ${port} ${artifact} (url-encoded)
    "artifactExtensions": [".step", ".stl"]               // newest such file under the workspace
  },
  "verdict": ".harness/verdict.json"      // relative to the workspace; optional (tier 1+)
}
```

An agent package's `engine` is its default for clients that have not chosen an engine. The
portable runtime binds every spec-1 harness to every integrated process engine. There is no
package allowlist or opt-in flag. Terminal is a plain shell and is offered only with Coding.
Older daemons still read the same manifest and use its default engine. New desktop clients use the
machine's `dsh_list.engines` and fall back to `engine` for older daemons.

Materialization prepares the workspace independently of the engine:

1. If `workspace.marker` is absent: copy `workspace.template/*` without overwriting existing files,
   then run `workspace.init` if declared.
2. Create `<workspace>/.harness/` for verdicts and runtime state.
3. Bind the selected engine to a session-scoped context bundle under `.harness/runtime/`.
   Its instructions and skill index are loaded through the engine adapter. A small, generic
   bootstrap in the engine's project instruction file reads `HARNESS_CONTEXT_FILE`; it contains
   no particular harness's instructions. Existing project text is preserved.

Launch env includes `HARNESS_DSH`, `HARNESS_DSH_DIR`, `HARNESS_WORKSPACE`,
`HARNESS_CONTEXT_FILE`, and `HARNESS_SKILLS_DIR`, plus expanded `agent.env`. Skills are readable
files with shell commands; native skills and MCP are not prerequisites. Old workspace skill paths
in env are translated to the session's skills directory. `agent.args` remains a legacy extension
for the manifest's default engine only; those flags are never handed to another engine.

Create records a runtime key along with the chosen engine and harness. Resume uses that bundle;
fork copies its configuration into a new bundle. Instructions, env and argv remain stable across
package-default changes. Installed skill assets and toolchains follow package updates, as before.
Missing packages or damaged contexts refuse a restart with a specific error.

See [the runtime contract and adapter sources](portability.md) for lifecycle, migration, compatibility,
and the coverage gate.

## Viewer packages (spec 1.1)

A viewer can be a package of its own, pointed at by any number of harnesses:

```jsonc
// harness.json of a viewer package
{ "spec": 1, "kind": "viewer", "id": "autonomous/cad-viewer", "name": "CAD Viewer",
  "toolchain": { "setup": "setup.sh", "doctor": "doctor.sh" },
  "viewer": { "command": "viewer.sh", "url": "http://127.0.0.1:${port}/?file=${artifact}",
              "artifactExtensions": [".step", ".stp", ".glb", ".stl", ".3mf"] } }

// harness.json of an agent that uses it
{ "spec": 1, "id": "autonomous/text-to-cad", "name": "text-to-cad", "engine": "claude",
  "viewer": { "use": "autonomous/cad-viewer" } }
```

A viewer package has no engine, no workspace and no verdict, and is never a tile. `harness dsh
install` of a harness that `use`s a viewer installs the viewer too (by registry id). At launch the
daemon runs the viewer's command in the VIEWER's directory with the usual env plus
`HARNESS_VIEWER=<viewer id>` and `HARNESS_VIEWER_DIR=<its install dir>`; `HARNESS_DSH` and
`HARNESS_DSH_DIR` still name the harness. The harness may narrow `url` and `artifactExtensions`.

## `.harness/verdict.json`

```jsonc
{
  "spec": 1,
  "ready": false,                         // the one machine fact: fab.ready, gates passed, exam passed
  "summary": "3 errors, 2 warnings",      // one line for the pane header
  "findings": [
    { "severity": "error", "kind": "source_trace_not_connected", "message": "…", "ref": "U3.pin7" }
  ],                                      // severity ∈ error | warning | info; kind is open
  "artifact": "boards/main.board.json",   // optional; primary thing to view, workspace-relative
  "phases": [                             // optional; where the work is, in order, for the pane header
    { "id": "build", "name": "Build", "state": "done" },
    { "id": "checks", "name": "Checks", "state": "active" },
    { "id": "fab", "name": "Fab", "state": "pending" }
  ],                                      // state ∈ done | active | pending | failed; ≤ 12 phases
  "updatedAt": "2026-09-14T20:00:00Z"
}
```

The verdict is a feed, not a gate: write it at every phase change and every check, not only at the
end. The pane is the product, and it must move while the agent works — a harness that only writes a
final verdict is not progressive. `phases` is how the header says "you are here"; `ready` stays the
one final truth.

Lifted from Circuit's `.board.json` and TV's `.episode.json` sidecars (same severity gate). Circuit
writes it beside the sidecar in `circuitpy.generation`; Workshop writes it from `verify_project`.

## Orchestrator flows (`.harness/flows/*.yaml`)

A flow pins an orchestrator task graph; the schema is `schema/flow.schema.json`. Each task has exactly one kind:

| Kind | Key | Also allowed | Ends when |
| --- | --- | --- | --- |
| Agent task | `harness` (an installed harness id or `engine:<engine>`) + `prompt` | `outputs`, `timeout`, `idle_timeout`, `retry`, `loop` | the worker calls `finish` or `fail`; with `outputs`, its turn ends and the outputs are there; with `loop`, a check passes |
| Shell step | `run` | `timeout` (default 10m), `retry` | the shell exits: 0 succeeds, anything else fails |
| Approval | `approval` | `timeout` | a person approves or rejects |
| Cancel step | `cancel` | nothing | at once: it cancels the run |

Every kind also takes `id`, `title`, `depends_on`, `when` and `trigger_rule`. The harness names `run`, `approval` and `cancel` are reserved. `$inputs.<name>` is replaced in `prompt`, in the approval message and in the cancel reason. A shell step and a loop check read `HARNESS_INPUT_<NAME>` from their environment instead, together with `HARNESS_PROJECT_DIR`, `HARNESS_FLOW_DIR`, `HARNESS_RUN_ID`, `HARNESS_TASK_ID` and `HARNESS_ATTEMPT`. An agent task with `outputs` finishes when its worker's turn ends and every glob matches a file in its folder (and, with `verdict: ready`, `.harness/verdict.json` says `ready: true`). A shell step's `stdout.log` and `stderr.log` become artifacts when it exits or times out, failed or not. A log found unusable (missing, not readable, not a regular file, too big, changed while it was copied) is left out: the result still applies, and its message names the log (`Logs not kept: stdout.log (missing)`). A failure to store a copy pauses the run, and so does a read error that happens in the middle of a copy; on resume the log is looked at again.

### Conditions

`when` is one comparison against a direct dependency: `<task>.state`, `<task>.decision`, `<task>.verdict.ready`, `<task>.verdict.errors` or `<task>.verdict.warnings`, with `==` or `!=`, and also `<`, `<=`, `>` or `>=` for `errors` and `warnings`. The value is a state (`succeeded`, `failed`, `skipped`, `cancelled`, `blocked`), `true` or `false`, a whole number of any size, or a decision id that the approval declares. There is no `&&` or `||`, no quotes and no reference to outputs. A value that is not a string of 1 to 300 characters fails schema validation. Any other mistake fails the flow with an error that starts with `when:` and points at `when`. Text that is not one comparison gets `Write one comparison, like "review.verdict.errors == 0".`; other mistakes (a task that is not a direct dependency, a state, number or decision that does not fit) get their own message.

The verdict is the copy taken when the dependency's attempt ended, never the live file. When the dependency wrote no verdict, or an approval has no decision (it was rejected, or it was cancelled before it finished with the decision it had recorded), the condition cannot be evaluated: the task fails without running ("review wrote no verdict; the condition review.verdict.errors == 0 cannot be evaluated."), and a manual retry decides again. A false condition makes the task `skipped`.

### Trigger rules and the run outcome

`trigger_rule` decides when a task may start, before `when` is looked at:

- `all_success` (default): every dependency succeeded. The task is blocked as soon as one failed, was blocked or was cancelled, and skipped when one was skipped.
- `none_failed_min_one_success`: blocked in the same cases; starts when at least one dependency succeeded and the others were skipped; skipped when all were skipped.
- `all_done`: every dependency finished, in any state.

A dependency counts as finished only when no automatic retry is pending and nothing of its attempt still runs or is being saved. An uncertain dependency (its process may still run, see Retries) blocks `all_success` and `none_failed_min_one_success` tasks at once. An `all_done` task waits for it, so the run stays in progress. Cancelling the uncertain task does not help, because it stays uncertain. Retry it once its process group is gone, or cancel the `all_done` task or the whole run.

A flow run is `completed` only when every task succeeded or was skipped. Its last message is `Flow <name> completed: N tasks succeeded, M skipped.` (the skipped part only when a task was skipped). A failure handled by an `all_done` task still leaves the run unsuccessful: once nothing can move, the run stays `active` with `Flow stopped: <task> (<state>), ... Retry a task or cancel the project.` A flow run that is cancelled or completed cannot be resumed: `resume` answers `PROJECT_INACTIVE` "This flow run has ended; start the flow again instead." Start the flow again. Director projects can still be resumed.

### Approvals

`approval: "Open the PR?"`, or `approval: { message, decisions: [{ id, label }] }` with 1 to 8 decisions (ids like `ship` or `needs-work`, labels up to 100 characters, the id by default). When the task is ready it goes to `waiting`, and the run gets the message `Task <id> is waiting for approval: <message>`. A waiting approval runs nothing and takes no parallelism slot. A person answers from the CLI:

```
harness orchestrator approve <project> <task> [--attempt N] [--decision ID] [--comment TEXT]
harness orchestrator reject <project> <task> [--attempt N] [--comment TEXT]
```

- The answer is bound to the attempt it answers. Without `--attempt` the CLI uses the current attempt, and only while the task is `waiting`.
- With `decisions`, `approve` needs one of them. Without them it takes none, and `reject` never takes one.
- A comment has up to 4000 characters and also goes into the run's messages.
- The answer is saved first. From then on it decides, also over a timeout that fires later, and it survives a daemon restart.
- Then it is written as `approval.json` (`{ attempt, outcome, decision, label, comment, at }`; `decision`, `label` and `comment` only when present) and kept as the attempt's artifact. Dependents read it from `inputs/<id>/approval.json`.
- Approve makes the task `succeeded`. Reject makes it `failed`, and it is never retried automatically.
- A `timeout` without an answer fails the task with "No decision within X." It is not retried either. A manual retry asks again, on a new attempt.
- Sending the same answer again does nothing; a different one is `DECISION_CONFLICT`.
- A cancel wins over an answer that was saved but not finished; the answer stays on the task as a record.

Wire: `approve { id, taskId, attempt, decision?, comment? }` and `reject { id, taskId, attempt, comment? }`. The request first waits for a reconcile of the run that is in progress. Then its shape is checked, then the decision and the attempt, then the state of the task and the run. Errors: `PROJECT_INACTIVE` (the run is not active, paused included), `STALE_ATTEMPT`, `TASK_INACTIVE` (the task is not waiting), `INVALID_DECISION` (`approve` without a decision the task declares, or with one when it declares none) and `DECISION_CONFLICT`. A request of the wrong shape is `INVALID_REQUEST`: a decision id that is not a valid id, or a `reject` with a decision (the CLI's `reject` has no `--decision`).

### Cancel step

`cancel: <reason>` (up to 2000 characters) cancels the whole run when the task is ready; it usually has a `when`. A ready cancel step runs before any retry or launch, and in a reconcile before a requested loop check starts, timers are armed again or messages are delivered. Tasks that the same change skips, blocks or fails are marked first, because that starts nothing: a branch whose `when` is false ends `skipped`. The step succeeds with "Cancelled the run: <reason>", and the run becomes `cancelled` with the error "Cancelled by step <id>: <reason>". Every open task is cancelled, pending messages are revoked, retries and timers are dropped, processes are stopped and agents cancelled. No dependent is released.

### Retries

`retry.max_attempts` is the number of attempts in all, the first included (1 to 6). `retry.delay` (1s to 60s) is the wait before the second attempt, doubled before each next one. The time of a pending retry is saved, so it survives a daemon restart. While a retry is pending, dependents wait. There is no automatic retry after a launch or configuration error, a cancel, a daemon stop, a reject, an approval timeout, or a loop check that could not start.

A manual `retry` in a flow run re-runs the task and every task that used its old result, directly or not, in one save. A task that had started gets a new attempt; one that never started (blocked or skipped) is decided again. The retry is refused with `TASK_STOPPING` while the task itself is still stopping or being saved, and with `RESULT_IN_USE` ("<id> still uses this result; cancel <id> first.") while a task below it is launching, running, waiting, uncertain or still stopping. Director projects keep the old rule.

When a shell step or a loop check ends but its process group cannot be confirmed gone, or the daemon restarted while it ran, or while it was still stopping after a failure or a cancel, and its process may still be there, its task becomes `blocked` and `uncertain`; a cancelled task stays `cancelled` and becomes `uncertain`. The error says to make sure the process stopped; it names the pid for a loop check and after a daemon restart. An uncertainty the daemon knows of when it stops is saved too. Nothing replaces such a task automatically, and a manual retry is refused with `RETRY_UNSAFE` until the process group is gone.

### Time limits

`timeout` bounds one attempt (`30s`, `45m`, `2h`, up to 24h); for a loop task it covers every turn and check of the attempt. Shell steps default to 10 minutes; agent tasks and approvals have no default.

How automatic results are saved:

- A result the daemon observes by itself (an exit, outputs, a timeout, a check) is saved before anything acts on it.
- While a run is paused nothing launches and no timeout is applied. A step or check that exits meanwhile is kept and applied on resume, and a deadline that passed is enforced then. Declared `outputs` are looked for only when a turn ends on an active run, so a turn that ends while the run is paused does not finish the task.
- When the save of such a result fails, it is kept the same way and the run pauses ("Project paused after a background error: ..."). Nothing is stopped until it is saved.
- A `timeout` is the one exception. When its save fails, the run pauses with the timeout kept, and the timed-out step, its loop check and its agent are stopped at once, so the time limit holds. The timeout is saved on resume. A timeout that only waits for a paused run or a reconcile stops nothing until it is saved.
- Work is also stopped before anything is saved by a cancel, and when the pid of a newly started step or check cannot be saved.

`idle_timeout` (agent tasks, up to 24h, no default):

- It fails the attempt with "No activity for X." when the worker shows no activity for that long. The failure is retried if `retry` allows, and the agent is cancelled once the failure is saved.
- Activity is what the engine reports for real work: a turn starting or ending, text, thinking, a tool call starting or ending, a user message, a context compaction, a subagent finishing. The daemon's own heartbeats do not count.
- The clock also restarts when a loop check ends or loop feedback is sent. It stops while a check runs and while the run is paused, and after a resume or a daemon restart it starts again from then.
- It measures observed activity: an agent waiting at a permission prompt counts as idle, and an engine that sends its events only when the turn ends looks idle until then.

### Loops

`loop: { until_run, max_iterations }` (1 to 20 checks) on an agent task. When a worker's turn ends, the daemon runs `until_run` as a check: a login shell in the task's execution folder, in its own process group, with the shell step environment plus `HARNESS_ITERATION`, and a 2-minute limit. Its logs are `.harness/loop/<n>.stdout.log` and `.harness/loop/<n>.stderr.log` in the task folder.

- Exit 0: declared `outputs` must be there (otherwise the check counts as failed, with "outputs missing"). The task succeeds with its outputs and the files named by the last `finish`. Its summary is that `finish` summary followed by "Check passed (iteration i of N). Log: <log>", or without a `finish` "Check passed: <until_run, first 200 characters> (iteration i of N). Log: <log>". If a file named by `finish` cannot be kept, the attempt fails with "The check passed, but the files named by finish could not be kept: <reason>."
- Any other exit: the worker gets a message that starts "Check failed (exit N), iteration i of N. Fix it and end your turn." and names the full log, followed by the end of the check's output (at most 4000 characters in all). When check number `max_iterations` fails, the task fails with a message that starts "Check still failing after N iteration" ("iterations" when N is more than 1).
- A check that times out fails the attempt (retried if `retry` allows); one that could not start fails it without a retry. A check that could not be prepared (for example `.harness` or `.harness/loop` is a link) or whose logs could not be written fails the attempt. A check whose process group may still run makes the task uncertain. Feedback that cannot be delivered ends the attempt ("The check feedback could not be delivered. Log: ...").

The contract for a loop task:

- A check starts only when a turn ends, never on `finish`. A turn that ends while the run is paused requests the check, and it starts on resume, after any deadline that passed is enforced. With `loop`, `finish` only records the summary and the files (the latest one wins) and answers "Recorded. The check runs when this turn ends."; `fail` ends the attempt at once and stops a running check. `outputs` alone never finish a loop task.
- After a failed check, only the end of a turn that starts after the feedback starts the next check. If the engine never reports the start of that turn (`turn_started`), no further check runs and only `timeout` or `idle_timeout` ends the attempt; a loop without either gets a compile warning.
- `.harness/loop/` is reserved for the check logs. They are never artifacts: the outputs search skips the folder, an `outputs` glob that starts with it is a compile error, and a `finish` path inside it (also through a link) is refused with `INVALID_ARTIFACT`.
- A check may run more than once: after a daemon restart, a check whose process group is gone runs again with the same number, and one that may still run makes the task uncertain. So a check must not change the work.
- A retry starts a new attempt with a new agent, from check 1.

### Script hashes

When a shell step starts, and each time a loop check starts, the daemon records the files the command names literally as `{ path, sha256 }` on the task (`scripts`; for a loop, those of the last check). The command is split into words at whitespace and `; | & ( ) < >`, and quotes are stripped. A leading `$HARNESS_PROJECT_DIR` or `$HARNESS_FLOW_DIR` (also `${...}`) is expanded; a word with any other variable is left out. Relative words are resolved against the execution folder. Only existing regular files of up to 8 MiB count, links are not followed, and at most 16 files are recorded. The hashes are a record for later comparison; nothing is checked against them.

### The `inputs/<task>` check

`inputs/<task>/` holds the artifacts of a direct dependency only. When a flow is compiled, `prompt`, `run`, the approval message and `until_run` are searched for literal paths `inputs/<task>/...`. A task that is not a direct dependency is an error with its position: "inputs/<task>/ is only filled for direct dependencies; add <task> to depends_on." A file the dependency does not declare is a warning. A shell step declares `stdout.log` and `stderr.log`, an approval `approval.json`; an agent task without `outputs` is never warned about. The check is literal: only a word that starts with `inputs/` counts (at the start, or after whitespace, a quote, `=` or `(`); a name with `*`, `?` or `$` is skipped, trailing punctuation is ignored, and a folder that a declared glob starts with counts as declared. A folder under a glob in the middle of a pattern, or a quoted name that ends in punctuation, may give a false warning. Paths built by shell code or prose are not analyzed.

### Starting a flow

`harness orchestrator run <flow>` (and `--dry-run`) checks the file first. A file that does not parse or compile is `INVALID_FLOW`. Otherwise, any harness problem (a harness that is not installed, an engine of an `engine:<name>` task that cannot run here) makes it `HARNESS_UNAVAILABLE`, and an engine problem alone (the run's engine) `ENGINE_UNSUPPORTED`. Every issue carries `file:line:col` where the file names the thing; the run's engine has a position only when the file sets it.

## Wire (daemon ↔ desktop)

- `agent_create` payload gains `dsh?: string`. Refused with `INVALID_DSH` when not installed on
  this machine or when `engine` is not supported by the installed manifest. Saved sessions keep
  their actual `engine` for resume, restart and fork, independently of the manifest's default.
- `AgentFrame` gains `dsh: string | null`, `dshName: string | null`, `viewerUrl: string | null`,
  `verdict: { ready, summary, errors, warnings, artifact, phases, updatedAt } | null`. Null is a real answer
  (see `agentFrame.ts`'s doc on erased fields).
- `dsh_list` → `{ dsh: [{ id, name, description, category, engine, engines, installed, viewer, tier }] }`: installed
  DSHs on this machine merged with the bundled registry (the `store/` folders and `store/registry/`).
  `engines` lists supported engines. Installed metadata wins over catalog metadata; an older
  daemon omitting `engines` supports only its advertised `engine`.
- `dsh_install { id?, url?, ref? }` → runs clone → setup → doctor; pushes
  `dsh_install_status { id, phase: clone|setup|doctor|done|failed, detail? }`; replies `{ ok }` at
  the end (the desktop uses a 10-minute timeout for this one request).
- Discovery reads `HARNESS_DSH` off the live process (`probeDsh`, same cached env read as
  `probeCodexHome`) so a pane the daemon did not create, or re-minted after a restart, is labelled.

### The store's facts

A registry entry may also carry `homepage`, `upstream`, `license`, `screenshots` and `examples` (see
`cli/src/dsh/registry.ts`); a built-in package keeps them in `store.json` beside its manifest. They are
the store page's, not the package's: a manifest never has them,
and `dsh_list` rows forward them from the registry whether or not the package is installed, with
`repo` and `linked` beside them. `dsh_remove { id }` uninstalls from the answering machine.

## On disk

```
~/.harness/dsh/
  installed.json                # [{ id, dir, source, ref, path?, commit, linked, installedAt }]
  autonomous/typst/             # clone (of one folder, for a store package), or a symlink with --link
  autonomous/doc-viewer/
```

CLI: `harness dsh install <id|git-url|path> [--link] [--ref <ref>] [--path <folder>]`, `harness dsh list`,
`harness dsh doctor <id>`, `harness dsh remove <id>`.

## In the monorepo

```
store/
  README.md            what a package is, the tiers, how to build and publish, the shelf's rules
  spec/README.md       this contract, frozen; CHANGES.md is append-only
  spec/schema/         harness.schema.json, verdict.schema.json, flow.schema.json
  starter/             tier 0: manifest + AGENTS.md + one skill; the CLI's test fixture
  agents/<name>/       built-in harnesses: harness.json + store.json, each its own registry entry
  viewers/<name>/      built-in viewer packages, the same way
  registry/<owner>/    entries for packages in repositories of their own
  tools/               daemon-level checks over the loopback socket
cli/src/dsh/           manifest, install, materialize, viewer, verdict, probe, registry
desktop/lib/dsh/       catalog, web pane, verdict chip
```

Normative schemas: [`schema/harness.schema.json`](schema/harness.schema.json), [`schema/verdict.schema.json`](schema/verdict.schema.json), [`schema/flow.schema.json`](schema/flow.schema.json).
