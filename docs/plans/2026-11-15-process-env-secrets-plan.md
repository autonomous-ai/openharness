# The daemon never reads another process's environment: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Each task is test-first: a red commit (the
> tests alone), then the code commit. A task marked "none: no behavior" or "none: spike" has no red test and is one
> commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No process of the daemon, and no hook of Harness's, reads another process's environment by any means; each
fact that read gave comes from what Harness wrote, from argv, from a hook's own environment, or from the path of a
file the engine holds open.

**Architecture:** `cli/src/lib/processEnv.ts` and every probe built on it are deleted. The gateway comes from Codex's
argv and, for Claude Code, OpenCode and Hermes, from one header their hook sends; the grid from the launch record and
from argv (Codex, Pi); the DSH from the registry's row. A Codex home comes from its launch, from a header of its hook
(taken only when the session's transcript is under it), or from the rollout the process holds open; a Hermes home from
its hook's store lookup, or from the `state.db` the process holds open. Only the path of an open descriptor is read,
never a file through it. A test reads every file of `cli/src` and `cli/hook` as code and fails on a read of another
process's environment.

**Tech Stack:** TypeScript (daemon), plain Node ESM (`cli/hook/notify.mjs`, the engines' plugin texts), Vitest, the
TypeScript compiler API in the architecture test, `lsof -Fn` (macOS) and `/proc/<pid>/fd` (Linux). No new dependency.

**Spec:** [docs/plans/2026-11-15-process-env-secrets-design.md](2026-11-15-process-env-secrets-design.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md` ("Protect the core", rules 6 and 7), `docs/feature-design-rules.md` and
`docs/validation-and-release.md`. The PM's eleven decisions (2026-11-15) are fixed, and so are the three answers of
the same day, which the spec carries (decision 8, "Hermes home") and the tasks follow: a launcher's one engine child
may be listed and nothing below or beside it (Tasks 9, 11, 14); a Hermes home from a descriptor is marked only in a
sandbox (Task 11); the spike's workflow has fixed limits and one push, the main session's (Task 0). Decision 8 has two
outcomes for each engine, and Tasks 9, 11 and 13 are written for both: Task 0 says which one each takes, and nothing
is planned again. No question is open.

## Spike result

Task 0 writes here, and no later task starts on a guess. One row for each engine and system, then one verdict for
each engine.

| Engine, release | System | Process that holds the file (selected, its one engine child, another) | Held from | Held until | Run |
| --- | --- | --- | --- | --- | --- |
| Hermes | macOS | | | | |
| Hermes | Linux | | | | |
| Hermes, in `unshare` | Linux | | | | |
| Codex | macOS | | | | |
| Codex | Linux | | | | |

- **Hermes: held / lost** (Task 11 and Task 13 take Branch A / Branch B).
- **Codex: held / lost** (Task 9 and Task 13 take Branch A / Branch B).
- A sandboxed process's descriptor path is in **its own view / the daemon's view**.

The verdict's rule. **Held:** on at least one of the two systems the selected process, or its one engine child
(decision 8), holds the file from no later than the end of its first prompt until it exits. Where that is true on one
system only, the engine is still held (the reader answers nothing where no file is held), and the spec's line under
"What changes for users" names the system where the case is lost. **Lost:** on neither system, or the file is held
only by a process that is neither (Hermes's shared gateway): the spec's line names the engine, and its tasks take
Branch B.

## Global Constraints

- No code reads another process's environment, by any means, and nothing replaces `readProcessEnv`: not
  `/proc/<pid>/environ`, not `ps e…`, not macOS `ps -E`, not `KERN_PROCARGS2`.
- A hook reads fixed names from its OWN environment and sends derived facts only, in two headers:
  `X-Harness-Hook-Gateway` is `ori` or `none`, never the URL; `X-Harness-Hook-Codex-Home` is an absolute path,
  percent-encoded. No value of `OPENROUTER_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  nor of any endpoint variable, leaves the hook's process. No hook fact is a body field.
- A Codex home from a hook, once decoded: an absolute path of at most 1,024 characters with no control character
  (`[\u0000-\u001f\u007f]`), taken only when the session's `transcriptPath` lies under `<codexHome>/sessions`.
  Fill-only.
- Decision 8, the files a process holds open. Only the PATH of each descriptor is read (`readlink` of
  `/proc/<pid>/fd/<n>` on Linux, the `n` lines of `lsof -Fn` on macOS): no file is opened, stat'ed or read through a
  descriptor, and no other field of a descriptor is asked for. Only two patterns: `<home>/state.db` (Hermes) and
  `<home>/sessions/**/rollout-*.jsonl` (Codex). A path that matches neither is dropped where it is read: never
  returned, kept or logged. A sandbox's path maps through `lib/processMounts.ts`.
- Decision 8, whose descriptors. The engine process the discovery pass selected, and, when that process is a
  launcher, exactly one more: its one direct child that is the same engine's binary (npm's Node launcher of Codex
  and the native `codex` under it). Never a level further down, never a second child, never any other process: not a
  shell, a tool, an MCP server, a parent or a sibling. A launcher with two children that are the engine's has none
  listed. One listing reads at most those two processes (PM, 2026-11-15).
- Decision 8, the mark. A Hermes home found from a descriptor is marked `hermesHomeDerived` only when its process is
  in a sandbox (another mount namespace, so its path was mapped through `lib/processMounts.ts`): a relaunch is not
  handed the daemon's path of it. Outside a sandbox it is never marked: it is the store the process really uses, a
  relaunch exports it as `HERMES_HOME`, and a Hermes started by hand as `HERMES_HOME=/x hermes` still resumes its
  session after a restart from Harness (PM, 2026-11-15).
- `undefined` means "could not look" and never overwrites what the registry knows. `null` is a finding.
- Rule 7: the core grows no record, rule, list or field for grid or DSH. `cli/src/architecture.coreFiles.txt` loses
  three lines (`lib/processEnv.ts`, `dsh/probe.ts`, `engines/kit/processHome.ts`) and gains at most one,
  `lib/processHeldFiles.ts`, and only when an engine is held; the pull request says why every session needs it (rule
  6: a Codex or a Hermes a person started is bound only once its home is known, and the file takes the place of
  `lib/processEnv.ts`).
- A refused header is dropped, the registration goes on, and one line says so by the header's name alone:
  `[hooks] <sid> <event> header refused · <header name>`. The daemon never logs a header's value: no path, no URL, no
  word of it in any log or error.
- Hot path (code standard 4): the discovery pass keeps a home it found for that process's life, and asks again of a
  process that held no such file 5 s later, then after twice as long each time, up to 60 s. The pull request gives the
  numbers: before, one `ps eww` for each agent each minute on macOS and one read of `/proc/<pid>/environ` on Linux,
  for as long as the agent runs; after, for a Codex or a Hermes process alone, `lsof` (macOS) or a read of
  `/proc/<pid>/fd` (Linux) four times in its first minute and once a minute after, until its file is seen, then never
  (Task 14's spec counts them).
- 100% coverage per file in `src/core/` and `src/services/` (`npm run test:core`).
- Tests use the suite's throwaway home and data folder (`vitest.setup.ts`): never the real `~/.claude`, `~/.codex`,
  `~/.hermes`, the daemon on port 18473 or the person's tmux server. No fixed sleep; a wait has a condition and a bound.
- A golden fixture is recorded again only by the task that names it, one spec at a time with that spec's `RECORD_…`
  variable, and its diff is read before the commit: only the entries the task changes may move.
- Comments say why, in plain sentences. A comment that says a fact is "read off the live process" or "from its
  environment" is rewritten in the task that ends that read (the fields' docs in `lib/registry.ts` and
  `lib/terminalAgentDiscovery.ts`).
- Out of this work (decision 11): `cli/scripts/remote-machine.sh`, `cli/native/`, `store/`, `os/`.
- Tasks run side by side in one checkout: `npx tsc --noEmit` must report nothing in the task's own files, and a commit
  adds only the files its task names. No local full suite while building: a task runs the tests it names.
- This checkout has no `cli/node_modules`: install once first, `cd cli && npm ci --no-audit --no-fund`.
- Platforms: macOS (loses `ps eww`), Linux (loses the `/proc/<pid>/environ` read), Windows (never read; the hook's
  headers are the same, and no descriptor is listed there). One pull request. Its body repeats the spec's "What changes
  for users" as Task 0 leaves it, names the three platforms and the spec's follow-up item
  (decision 11), and carries each task's red and green output, the Verification results and the local check receipts.

## Found while reading the code

Checked at `e93eadfaf1`.

- **A retarget does not write `grid` today.** `retarget.ts:321-329` records `gridLaunch` and leaves `grid` to
  `gridAssignments.refresh`, which reads the new process's environment. The spec says the grid is "set at create and
  at retarget, as today"; Task 7 makes that true (the projection `create.ts:415` writes). Without it a Claude Code
  moved onto a grid would go on showing its own login.
- **The row's `grid.baseUrl` is the launch's form from now on** (`…/relay/v1` as the app sent it), where the process
  read gave the form the engine was handed (`…/relay` for Claude Code). Desktop compares the two with `/v1` stripped
  (`api_connections_controller.dart` `agentOnApiModel`); `serviceProcesses.e2e.ts` asserts the old form (Task 13).
- **Dead once `env` leaves the port, beyond the spec's list:** `readOpencodeGridAssignment` and
  `OPENCODE_CONFIG_VAR`, the environment and Grok branches of `classifyGridAssignment`, `GRID_ENDPOINT_VARS` and
  `GRID_MODEL_VARS` (Task 8); `DiscoveryContract.profile.variable` (Task 9); `registry.setDsh` and
  `openProcessAgent`'s `dsh` input (Task 10); `cli/e2e/harness/hiddenProcessEnv.mjs` (Task 13). Dead today, with no
  caller: `engines/hermes/homeProbe.ts` and its line in `hermes/inProcess.ts` (Task 11). Dead only where an engine is
  lost: `registry.setCodexHome` and `openProcessAgent`'s `codexHome` input (Task 9, Branch B); `setHermesHome`'s
  `derived` argument and `RegisterInput.hermesHomeDerived` (Task 11, Branch B).
- **An older daemon ignores a header it does not read, and refuses a body with a field it does not list.**
  `validHookBody` answers 400 for one unknown field (`hookServer.ts:254`). Headers are read by name alone:
  `req.headers['x-harness-hook-fired-at']` (`:246`), `['x-adapter-local']` (`:545`), `['x-harness-hook-token']`
  (`:551`), `authorization` and `origin` (`:577-578`), `['x-harness-hook-delivery-id']` (`:658`, `:973`),
  `[PIPE_AUTH_HEADER]` on the Windows pipe (`lib/localSocket.ts:206`). Nothing walks `req.headers`, and no server sets
  `maxHeaderSize`. `hookFiredAt`'s own comment says it (`:239-241`: "sends it as a header, which a daemon that does
  not read it ignores, where an unknown body field is refused"), and that header went out to daemons that did not
  read it yet (`ff9dc34ba9`, #970). Task 3 adds the test that keeps it so.
- **A path cannot go into a header as it is.** Node refuses a header value with a character above U+00FF
  (`ERR_INVALID_CHAR`, thrown from `http.request`, which would end the hook), and sends U+0080 to U+00FF as single
  bytes. So `X-Harness-Hook-Codex-Home` carries `encodeURIComponent(path)` and the daemon decodes it before it checks
  it. The longest one, a slash and 1,023 three-byte characters, is 9,210 bytes: under Node's 16 KiB of headers.
- **The spec still says "body" in three places** (Design lines 1 and 3, Testing's first line). Decision 7 is the
  later word and this plan follows it: the body does not grow, so the test of the body's size became a test of the
  header's (Task 3).
- **A hook's process is checked to descend from its engine's** (`core/engines/hooks.ts` `callerBelongsTo`; Cursor
  excepted), so its environment is that engine's. A Hermes 0.22+ hook runs in Hermes's shared gateway process, with
  that process's environment: no special case (PM, 2026-11-15), and only Claude Code and Codex read `gateway` today
  (`engines/runtime.ts`: `supportsControl`, `modelsForSession`).
- **The repo reads open files three ways already,** and none reads paths alone. `nativeOpenFiles`
  (`lib/nativeConversation.ts`, for OpenClaw's store) asks `lsof` for each descriptor's type, device and inode, stats
  each one on Linux, lists twice and throws unless the two lists agree: it is built to authorize control of a session.
  Decision 8 allows the path only, so Task 14 adds a reader of its own, spawned off the core's thread as `ps eww` was
  (`lib/offThreadExec.ts` `probeExecFile`), with the argument list `kit/sessionLocation.ts:198` already uses. Moving
  OpenClaw to it is not this work.
- **`lsof` escapes a name's bytes above ASCII** (`\xc3\xa0`), so a home is named two ways on macOS;
  `kit/nativeDescriptors.ts` `descriptorPaths` gives both, and the one that exists on disk is the home (Task 14).
- **`architecture.spec.ts` fails on a listed file the core does not load,** so the line `lib/processHeldFiles.ts` is
  added in the commit that first imports the file: Task 9 on its Branch A, else Task 11 on its Branch A.
- **`engineProcessMatchScore` builds a PATH snapshot when it is given none** (`lib/processTable.ts:794`), which was
  most of an idle core's CPU (#3880). The pass builds one snapshot, as today, and a launcher's one child (decision 8) is
  looked for with it, and only when no answer is kept.
- **What the mark means from now on.** Today `hermesHomeDerived` says the process's own `HERMES_HOME` did not name
  the home (`identities.ts` `probeHermesHomeDerived`: worked out from its `HOME`, or named at another path in a
  sandbox). No descriptor says which variable named a home. So the mark says one thing only: the home is the
  daemon's path of a sandboxed process's store (PM, 2026-11-15). A Hermes outside a sandbox with only a `HOME` of its
  own was marked and is no longer: a restart now hands it `HERMES_HOME=<HOME>/.hermes`, the store it already uses.
  `hermesTerminalRecord.e2e.ts` `:251-284` asserts the old behavior (Task 13).
- **"In a sandbox" is one answer.** Discovery marks by `probeHermesSandbox` of the selected process (a folder or
  `'unseen'`), the answer that already moves the row's folder and decides the follow and the hold (`bind.ts`), while
  `heldHome` maps each path through the view of the process that holds it. The two are one process unless a launcher
  outside a sandbox starts Hermes's binary inside one: no launch Harness makes or tests does (the fake's wrapper
  `exec`s into its sandbox, so the process found is inside it), and that home would be mapped and left unmarked.
- **The mark cannot be put back.** Today a row that has a home without `hermesHomeDerived` (an older daemon saved
  over the mark) is marked again when the environment says the home was worked out (`core/agents/discovery.ts:217`,
  `registry.setHermesHome`). A descriptor cannot tell that from a home Harness launched by name, in a sandbox that
  sees it at the same path, and marking it would stop a relaunch from exporting a home it must export. That clause
  goes (Task 11, Branch A).
- **Both fakes hold their file open,** as their engines are said to: `e2e/harness/fakeHermes.mjs` never closes its
  `DatabaseSync`, and `fakeEngine.mjs` keeps its rollout open (`held = openSync(transcript, 'r')`). So on Branch A the
  end-to-end cases reach the new source as they are written. A real Codex that did not hold its rollout would also
  break the repair of today (`lib/nativeConversation.ts` `nativeOpenFileSession`): Task 0 reports that, and it is not
  this work.
- **`ps` argument lists in the tree hold format words with an `e`** (`'ppid=,state=,comm=,lstart=,args='`,
  `'pid=,ppid=,rss=,time=,lstart='`). The test's rule is therefore a word of letters alone holding `e`, not the value
  of an option before it (Task 12).
- **A pane Harness launched on a grid, whose engine exits and is typed in again,** keeps the grid's variables in its
  tmux session and now shows its own login (`releaseToShell` sets `grid` to null). It is decision 5's accepted case.
- **Local gates this change needs:** `cli-core` (`src/core/*`, `src/services/*`) and `cli-portability`
  (`src/dsh/*.ts`, `src/lib/registry*.ts`), per `scripts/local-checks.py`.
- **PR CI runs no end-to-end file and no Windows spec.** Five end-to-end files change and one preload of theirs
  goes (Task 13); `daemonPipeClients.windows.real.spec.ts` runs the real `notify.mjs` on Windows (Task 4).

## File map

| File | Change | Task |
| --- | --- | --- |
| `.github/workflows/tmp-process-env-secrets.yml` (temporary), this plan's "Spike result", the spec's "What changes for users" | the spike | 0 |
| `cli/src/lib/processMounts.ts` | its own key | 1 |
| `cli/src/lib/openrouter.ts`, `openrouter.spec.ts` | no `gateway` parameter | 2 |
| `cli/src/hookServer.ts`, `hookServer.spec.ts` | the two headers read, checked, named when refused | 3 |
| `cli/src/lib/registry.ts` | `register()` takes the two facts (3); field docs (6); the Codex home's doc, and on Branch B `setCodexHome` and `openProcessAgent`'s input (9); `setDsh` and the `dsh` input (10); Hermes (11) | 3, 6, 9, 10, 11 |
| `cli/src/lib/registry.spec.ts` | the two facts (3); the removed setters and inputs (9 on Branch B, 10) | 3, 9, 10 |
| `cli/src/engines/discoveries.ts` | `reportedProfileHome` (3); the environment probe goes (9) | 3, 9 |
| `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts`, `cli/src/lib/windows/daemonPipeClients.windows.real.spec.ts` | the hook sends its own facts | 4 |
| `cli/src/engines/opencode/contract.ts`, `pluginPosts.spec.ts`, `__fixtures__/other-hooks.golden.json`, `__fixtures__/native-version.golden.json` | both OpenCode plugins send the gateway header | 5 |
| `cli/src/lib/gatewayRuntime.ts`, `gatewayRuntime.spec.ts` | argv only | 6 |
| `cli/src/lib/terminalAgentDiscovery.ts` | gateway (6), grid (8), Codex home (9), DSH (10), Hermes (11) | 6, 8, 9, 10, 11 |
| `cli/src/lib/terminalAgentDiscovery.gateway.spec.ts`, `.wrapperExec.spec.ts`, `terminalAgentReconciler.wrapperExec.spec.ts`, `cli/src/engines/opencodeLaunch.golden.spec.ts`, `cli/src/core/agents/hostMove.spec.ts` | gateway mocks | 6 (the two `wrapperExec` specs again in 12) |
| `cli/src/lib/terminalAgentDiscovery.grid.spec.ts` | gateway mock (6); argv evidence (8) | 6, 8 |
| `cli/src/lib/terminalAgentDiscovery.codexHome.spec.ts` | gateway mock (6); the held rollout, or deleted on Branch B (9) | 6, 9 |
| `cli/src/lib/terminalAgentDiscovery.hermesHome.spec.ts` | gateway mock (6); the held store and the sandbox (11) | 6, 11 |
| `cli/src/core/agents/restart.ts`, `restart.spec.ts` | no probe | 6 |
| `cli/src/core/agents/retarget.ts`, `retarget.spec.ts` | no probe (6); the grid it launched (7) | 6, 7 |
| `cli/src/engines/README.md` | the gateway sentence | 6 |
| `cli/src/lib/gridAssignmentWire.ts`, `gridAssignment.ts`, their specs, `gridAssignmentShapes.golden.spec.ts`, `__fixtures__/grid-assignment-shapes.golden.json`, `cli/src/testing/gridAssignmentShapes.ts`, `cli/src/lib/apiModels.spec.ts`, `gridLaunch.ts`, `gridLaunch.spec.ts` | argv evidence, no `env` | 8 |
| `cli/src/core/agents/gridAssignments.ts`, `gridAssignments.spec.ts`, `cli/src/core/modelsLink.spec.ts`, `cli/src/services/models.spec.ts` | the port without `env` | 8 |
| `cli/src/engines/discovery.golden.spec.ts`, `__fixtures__/discovery.golden.json` | grid cases (8); profile cases (9) | 8, 9 |
| `cli/src/core/agents/discovery.ts`, `discovery.spec.ts` | a comment (8); the Codex home (9), no DSH (10), the Hermes home (11) | 8, 9, 10, 11 |
| `cli/src/engines/kit/processFacts.ts`, `processFacts.spec.ts`, `facets/discovery.ts`, `codex/discoveryContract.ts` | the reported home's rule; the held rollout's pattern | 9 |
| `cli/src/dsh/probe.ts`, `probe.spec.ts`, `launch.spec.ts` | deleted; the launch's own variable | 10 |
| `cli/src/architecture.coreFiles.txt` | `lib/processHeldFiles.ts` added (9 on Branch A, else 11 on Branch A); lines deleted (10, 11, 12) | 9, 10, 11, 12 |
| `cli/src/engines/identities.ts`, `identities.hermes.spec.ts`, `hermes/homeProbe.ts`, `hermes/inProcess.ts`, `hermes/home.ts`, `hermes/contract.ts`, `kit/processHome.ts`, `kit/processHome.spec.ts`, `otherAdmission.golden.spec.ts`, `__fixtures__/other-admission.golden.json`, `cli/src/core/agents/bind.ts`, `bind.spec.ts`, `hermesTerminal.ts`, `hermesTerminal.spec.ts`, `cli/src/lib/registry.hermesHome.spec.ts` | Hermes | 11 |
| `cli/src/architecture.environment.spec.ts` (new), `cli/src/lib/processEnv.ts`, `processEnv.spec.ts`, `offThreadExec.spec.ts`, `cli/AGENTS.md`, `cli/docker/remote-machine/Dockerfile` | the test; the file goes | 12 |
| `cli/e2e/enginehomes.e2e.ts`, `harness/hiddenProcessEnv.mjs`, `harness/fakeHermes.mjs`, `engineModelControl.e2e.ts`, `modelSwitch.e2e.ts`, `serviceProcesses.e2e.ts`, `hermesTerminalRecord.e2e.ts` | the end-to-end suite | 13 |
| `cli/src/lib/processHeldFiles.ts` (new), `processHeldFiles.spec.ts` (new), `cli/src/lib/processTable.ts`, `processTable.engineChild.spec.ts` (new) | the paths of the files a process holds open | 14 |

**Order.** Tasks 0, 1, 2, 3, 7 and 10 need nothing. 4 and 5 need 3; 6 needs 2; 8 needs 7; 14 needs 0 (and is not done
when both engines are lost); 9 needs 0 and 3, and on its Branch A also 14; 11 needs 0, on its Branch A also 14, and 9
when both engines are held (9 adds the wiring both use); 12 needs 1, 6, 8, 9, 10 and 11; 13 needs 0, 4 and 12. Tasks
that share a file above never run together, in either order: each is written against what the other leaves. Task 14 is
written after Task 13 below and is not last: its number only keeps the numbers of the first draft. Longest chain, both
engines held: 0 → 14 → 9 → 11 → 12 → 13.

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A host that only looks like OpenRouter (`https://openrouter.ai.example.com`, `https://example.com/openrouter.ai`),
  a value that is no URL, an empty variable: the header says `none`, never `ori`. Tasks 4 and 5.
- A hook that says nothing (an older `notify.mjs`, an OpenCode still running the plugin it loaded before the update)
  after one that said `ori`: the row keeps `ori`. And a Codex hook that sends the gateway header: the row keeps what
  its argv said. Task 3.
- A Codex home with characters outside Latin-1 (`/Users/nguyễn/.codex-work`): it reaches the daemon whole, and the
  hook is never ended by Node refusing the header. The hook's `CODEX_HOME` naming the daemon's own default another way
  (a trailing slash, a symlinked home): no home on the row, and no refusal logged. Tasks 3 and 4.
- A process that holds two files of the pattern in two folders (a Hermes with its own `state.db` and a project's, a
  launcher with another profile's rollout): no home, never the first one read. Task 14.
- A launcher with two children that are the engine's, the engine's binary a level further down, a shell or a tool
  that holds a file of the pattern: none of them is listed, and only the selected process and its one engine child
  ever are. Task 14 (and the wiring's case in Task 9).
- A Hermes home found from a descriptor outside a sandbox (`HERMES_HOME=/x hermes` typed by hand, or only a `HOME`
  of its own): no mark, and a restart exports it. In a sandbox: marked, and a restart does not. No home, no mark.
  Task 11, and end to end in Task 13.
- A Codex that has written no rollout yet: not listed again every pass, but 5 s later and then less and less often,
  up to once a minute; and found on a later listing, its home is kept for the life of that process and the listing
  stops. Task 14.

---

### Task 0: Spike: which process holds an engine's store open

**Depends on:** nothing. **Effort:** high. **Test first:** none: spike. A temporary workflow: one commit, removed
before the pull request. No product code is written or kept: nothing under `cli/` changes.

**Limits (PM, 2026-11-15), none of them this task's to loosen:**
- At most one macOS job and one Linux job: two jobs, no matrix. `timeout-minutes: 20` on each.
- `permissions: contents: read`, and no secret.
- No cache and no artifact written outside the run: no `actions/cache`, no `cache:` input on `actions/setup-node`
  (it saves one), no `actions/upload-artifact`. What the script finds is in the job's log.
- One push, and it is the main session's: an early push the PM approved for this spike. This task's agent never
  pushes.
- One run. If it fails for an infrastructure reason, report to the main session and stop: no second push.
- Removed before the pull request: `git diff origin/main...HEAD -- .github/workflows/` shows no `tmp-` file.

**Files:**
- Create (temporary): `.github/workflows/tmp-process-env-secrets.yml`
- Modify: `docs/plans/2026-11-15-process-env-secrets-plan.md` ("Spike result" alone)
- Modify, only for an engine that is lost or held on one system only: `docs/plans/2026-11-15-process-env-secrets-design.md` (the fourth line under "What changes for users")

**What it answers,** for Hermes 0.21.6 or later and for Codex, on macOS and on Linux: which process of the pane's tree
holds `<home>/state.db` (Hermes) or `<home>/sessions/**/rollout-*.jsonl` (Codex) open, from when, and until when.

- [ ] **Step 1: Write the workflow.** `name: tmp process-env-secrets spike (temporary)`;
  `on: push: branches: [fix/process-env-secrets]` and no other trigger; `permissions: contents: read` at the top;
  no `secrets.*` and no `environment`; nothing released, published or deployed. No `actions/checkout` (the script
  is inline and reads nothing of the repo), no `actions/cache`, no `actions/upload-artifact`, and
  `actions/setup-node` at `cli-e2e.yml`'s `CLI_NODE_VERSION` with no `cache` input. Exactly two jobs, no matrix,
  `linux` (`ubuntu-latest`) and `macos` (`macos-15`), each with `timeout-minutes: 20`, with the same inline script
  that prints what it finds to the job's log:
  - A throwaway root under `$RUNNER_TEMP`: `HOME`, `CODEX_HOME=<root>/codex-home`, `HERMES_HOME=<root>/hermes-home`,
    an npm prefix, and a tmux server of its own (`tmux -L spike -f /dev/null`).
  - Install tmux and lsof with the commands `cli-e2e.yml` uses; Codex with
    `npm install --prefix <root>/npm @openai/codex`; Hermes with its own installer under that `HOME` (the command
    `cli/src/lib/engineInstall.ts:86` names, copied into the script). Print both versions; the job fails on a Hermes
    below 0.21.6.
  - No account and no real key: each engine is pointed at a provider on loopback where nothing listens
    (`http://127.0.0.1:9/v1`) with a key that is no key. If an engine writes its store only after an answer, a server
    of the job's own on loopback answers one fixed completion.
  - For each engine, in a pane, in an empty folder: a listing once its prompt is drawn, one after a prompt is typed
    and the store file exists on disk, one 60 s later, and one after it exits. A listing is the pane's process tree
    (`ps -o pid=,ppid=,comm=`) and, for each process in it, the paths of its descriptors that match
    `/state\.db$` or `/sessions/.*rollout-[^/]*\.jsonl$`: on Linux `readlink` of each `/proc/<pid>/fd/<n>`, on macOS
    the `n` lines of `lsof -n -P -w -p <pid> -Fn`. Paths alone: never `environ`, never a file's content.
  - Linux, Hermes once more under `unshare --user --map-root-user --mount --pid --fork` with a tmpfs on `/tmp` and
    its `HOME` at `/tmp/home`, bound from a folder of the root (the `'remapped'` shape of
    `cli/e2e/harness/fakeHermes.mjs`), listed from outside: the path is printed as read. Where the runner refuses
    `unshare`, the row says "not run".
- [ ] **Step 2: Commit, and read the one run.** `tmp: spike, which process holds an engine's store open (temporary)`.
  Before the commit, read the file against the limits above, line by line: a wrong workflow costs the one run. Then
  tell the main session the commit is ready: it pushes the branch, once. Read the run: `gh run watch`, then
  `gh run view --log`.
  A run that fails for an infrastructure reason (no runner assigned, a runner or its image at fault, a download or
  an install mirror that does not answer, the 20 minutes used up by an install): report it to the main session with
  the run's link and the failing step, and stop. No second push, no `gh run rerun`, no empty commit to start it
  again. A run that fails because the script is wrong is reported the same way, with the fix proposed: another
  commit and push are the main session's to decide.
- [ ] **Step 3: Write "Spike result"** in this plan: a row for each engine and system (the release, the process that
  holds the file as the selected one, its one engine child or another, from when, until when, the run's link), the
  line on a sandbox's path, and one verdict for each engine by the rule written there.
- [ ] **Step 4: The spec's line,** only for an engine that is lost or held on one system only. Under "What changes for
  users", the line that starts "A Hermes with no hook and a home of its own" becomes one line for each engine:
  - held: "`<engine case>`: bound from the `<file>` it holds open."
  - held on one system: the same, then "On `<system>` it is no longer bound: `<release>` does not keep that file open
    there."
  - lost: "`<engine case>`: no longer bound. `<release>` does not keep `<file>` open (spike of 2026-11-15)."

  The engine cases are the spec's own words: "A Hermes with no hook and a home of its own" and "A Codex started by
  hand under a `CODEX_HOME` with no Harness hooks".
- [ ] **Step 5: Report** the two verdicts and the run's link. The workflow stays on the branch until diegodev
  removes it before the pull request; then `git diff origin/main...HEAD -- .github/workflows/` shows no `tmp-`
  file (Verification). Stop and report instead of choosing when: an engine
  cannot start a session with no account (that run needs a machine with a login, which is a question for Diego);
  the file is held by a process the rule does not name; a sandbox's path is in the daemon's view, not its own (Task
  14 maps it through `processMounts.ts` and would be wrong); or a Codex holds no rollout at all (the repair of
  today, `nativeOpenFileSession`, rests on it).

---

### Task 1: `processMounts` keys its own views

**Depends on:** nothing. **Effort:** medium. **Test first:** none: no behavior (the key keeps its three parts;
`processMounts.spec.ts` "reads a process once, and another process again" and "keeps at most 256 processes" stay green).

**Files:** Modify `cli/src/lib/processMounts.ts` (`:12`, `:57`).

- [ ] **Step 1.** Delete the import of `processEnvCacheKey`. Beside `views`, add
  `const viewKey = (identity: ProcessIdentity): string`, the same three parts joined by `\u0000` (`pid`,
  `startMarker`, `executable`), with one comment line: a pid is reused, and the start marker and executable make the
  key this process's. `processView` uses it.
- [ ] **Step 2.** `cd cli && npx vitest run src/lib/processMounts.spec.ts && npx tsc --noEmit` (all pass).
- [ ] **Step 3: Commit.** `CLI: the mount view keys its own processes`.

---

### Task 2: `resolveOpenRouterKey()` takes no gateway

**Depends on:** nothing. **Effort:** medium. **Test first:** none: no behavior (both callers, `lib/voiceRouter.ts:453`
and `lib/jev/jevClient.ts:43`, pass nothing).

**Files:** Modify `cli/src/lib/openrouter.ts` (`:18`, `:66-78`), `cli/src/lib/openrouter.spec.ts` (`:36-46`).

**Interfaces:** Produces `resolveOpenRouterKey(): Promise<string | null>`: the daemon's own `OPENROUTER_API_KEY`,
then `ori login`'s file. No import of `./gatewayRuntime.js` is left in `openrouter.ts`.

- [ ] **Step 1.** Remove the parameter, the `fromProcess` lines, the type import and the comment's "then the key the
  AGENT's process was given" sentences. In the spec the first case becomes "prefers the daemon env, then the
  credentials file", without its two `{ kind: 'ori', apiKey: … }` calls.
- [ ] **Step 2.** `npx vitest run src/lib/openrouter.spec.ts src/lib/voiceRouter.spec.ts src/lib/jev/jevClient.spec.ts && npx tsc --noEmit`.
- [ ] **Step 3: Commit.** `CLI: no agent's key reaches the OpenRouter call`.

---

### Task 3: The core takes the gateway and the Codex home from a hook's headers

**Depends on:** nothing. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/hookServer.ts` (beside `hookFiredAt` `:239-248`, the session-start handler `:606-900`)
- Modify: `cli/src/lib/registry.ts` (`RegisterInput` `:380-406`, `register()` `:2093-2330`)
- Modify: `cli/src/engines/discoveries.ts` (beside `profileHomeFromEnv` `:50`)
- Test: `cli/src/hookServer.spec.ts`, `cli/src/lib/registry.spec.ts`

**Interfaces:** Produces:

```ts
// hookServer.ts
/**
 * What a hook says of its own environment, in two headers: a daemon that does not read a header ignores it, where it
 * refuses a body with a field it does not list. Each is judged alone: a refused one is named, never the request.
 */
export function hookFacts(req: Pick<http.IncomingMessage, 'headers'>): { gateway?: 'ori' | null; codexHome?: string; refused: string[] }

// registry.ts, RegisterInput
/** From the hook's own environment: undefined when the hook did not say. Taken for Claude Code, OpenCode and Hermes. */
gateway?: 'ori' | null
/** Codex only, the hook's own CODEX_HOME. Fill-only, and only when this session's transcript is under its sessions folder. */
codexHome?: string
// registry.ts, register()'s result gains
refusedHome?: true

// engines/discoveries.ts
/** The profile home a hook reports for `engine`: null for an engine with no profile, a home over 1,024 characters, and this machine's default. */
export function reportedProfileHome(engine: AgentEngine, home: string | undefined, defaultHome?: string): string | null
```

Rules, all of them:
- `hookFacts`, `x-harness-hook-gateway`: `ori` is `'ori'`, `none` is `null`, absent is `undefined`; anything else
  (two values joined by Node, another word) is refused.
- `hookFacts`, `x-harness-hook-codex-home`: absent is `undefined`. Else `decodeURIComponent`, and the decoded value
  is taken when it is `path.isAbsolute`, at most 1,024 characters, with no `[\u0000-\u001f\u007f]`. A value that does
  not decode, or fails one of the three, is refused.
- `refused` holds header names (`'x-harness-hook-gateway'`, `'x-harness-hook-codex-home'`), never a value.
- `HOOK_BODY_FIELDS` and `validHookBody` do not change: a body that names `gateway` or `codexHome` is still a 400.
  The header is the one door.
- Session-start alone reads them, right after `validHookBody`: each refused name is warned as
  `[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} header refused · ${name}`, and
  `prepare()` spreads what was taken into `prepared`. The body, its fingerprint and its receipt stay as sent. After a
  commit whose result has `refusedHome`, the same line with `x-harness-hook-codex-home`. No other route reads either.
- `register()`, gateway: `HOOK_GATEWAY_ENGINES` is `claude`, `opencode`, `hermes`. For those, an `input.gateway` that
  is not `undefined` is the row's; otherwise `existing?.gateway ?? null`, as today.
- `register()`, home: a row that has a `codexHome` keeps it. Else `reportedProfileHome(engine, input.codexHome)` is
  tried as the profile of `transcriptEvidence`; when that evidence is not valid, the evidence is taken again without
  it, the home is not written, and the result (when the registration succeeds) says `refusedHome: true`.
- `reportedProfileHome`, in this task: `discoveryContract(engine)?.profile` exists and `home` is at most 1,024
  characters, then `profileHomeFromEnv(engine, { [profile.variable]: home }, defaultHome)`; else null. Task 9 gives
  it its own body.

- [ ] **Step 1: Write the failing tests.**

  `hookServer.spec.ts`, a new `describe('what a hook says of its own environment')`:

  ```ts
  const GATEWAY = 'x-harness-hook-gateway', HOME = 'x-harness-hook-codex-home'
  it.each([
    [{ [GATEWAY]: 'ori' }, { gateway: 'ori' }, []],
    [{ [GATEWAY]: 'none' }, { gateway: null }, []],
    [{}, {}, []],
    [{ [GATEWAY]: 'vendor' }, {}, [GATEWAY]],
    [{ [GATEWAY]: 'ori, none' }, {}, [GATEWAY]],
    [{ [HOME]: '/home/u/.codex-work' }, { codexHome: '/home/u/.codex-work' }, []],
    [{ [HOME]: encodeURIComponent('/home/nguyễn/.codex work') }, { codexHome: '/home/nguyễn/.codex work' }, []],
    [{ [HOME]: encodeURIComponent(`/${'あ'.repeat(1023)}`) }, { codexHome: `/${'あ'.repeat(1023)}` }, []],
    [{ [HOME]: 'relative/home' }, {}, [HOME]],
    [{ [HOME]: `/${'x'.repeat(1024)}` }, {}, [HOME]],
    [{ [HOME]: '/bad%0Ahome' }, {}, [HOME]],
    [{ [HOME]: '/cut%E0%A4%A' }, {}, [HOME]],
    [{ [HOME]: '' }, {}, [HOME]],
  ])('%j is taken as %j, refusing %j', (headers, taken, refused) => {
    expect(hookFacts({ headers })).toEqual({ ...taken, refused })
  })
  ```

  Route cases with the spec's `start()` and a spied `registry.register`, as its first case does:
  - "registers with the facts it took, and names a refused header without its value": a session-start with the
    gateway header `vendor` and the home header `secret/place`. The input `register` got has neither property;
    `console.warn` got exactly `… header refused · x-harness-hook-gateway` and
    `… header refused · x-harness-hook-codex-home`; no `console` call holds `vendor` or `secret`.
  - "takes the longest home a hook sends": the 9,210-byte header of the table's eighth row reaches `register` as
    `codexHome` (not a 431).
  - "reads neither on another route": a `turn-stop` and a `session-end` carrying both headers answer as they do
    without them.
  - "a body that names them is refused as before": a session-start body with `gateway: 'ori'`, and one with
    `codexHome: '/x'`, are each a 400.
  - "ignores a header it does not read": a session-start with `X-Harness-Hook-Next: 1` gives `register` the input it
    gets without it. This is the daemon a later hook will meet as the older one.

  `registry.spec.ts`, beside "registers a codex session against the profile it was created with" (`:1736`), with
  its helpers (`loadRegistryModule`, `processIdentity`, a rollout under `<home>/sessions`):

  ```ts
  it('takes the gateway a hook reports for Claude Code, OpenCode and Hermes, keeps it through a hook that says nothing, and leaves Codex\'s to its argv', …)
  //   register({ …claude, gateway: 'ori' }).entry.gateway === 'ori'; the same session again with no gateway: 'ori';
  //   with gateway: null: null. opencode and hermes: 'ori' is taken.
  //   A Codex row opened with openProcessAgent({ gateway: 'ori' }): register({ …codex, gateway: null }) leaves 'ori'.
  it('fills a Codex row\'s home from its hook when the transcript is under it, and from nothing else', …)
  //   A discovered Codex row (openProcessAgent, no home); profile = a temp folder with sessions/rollout-x.jsonl:
  //   register({ …, transcriptPath: that rollout, codexHome: profile }): entry.codexHome === profile, no refusedHome.
  //   A rollout under the daemon's own CODEX_HOME with codexHome: profile: registered, codexHome null, refusedHome true.
  //   The daemon's own CODEX_HOME made first, then named with a trailing slash and through a symlink to it:
  //   codexHome null, refusedHome undefined (real paths are compared, and only a folder that exists has one).
  //   A row that has a home keeps it. A Claude Code session with codexHome: ignored.
  ```

- [ ] **Step 2: Run them, expect red.** `npx vitest run src/hookServer.spec.ts -t "own environment"` and
  `npx vitest run src/lib/registry.spec.ts -t "a hook reports|from its hook"`: `hookFacts` is not exported; `gateway`
  stays null; `codexHome` stays null.
- [ ] **Step 3: Implement** the interfaces and rules above.
- [ ] **Step 4: Green.** `npx vitest run src/hookServer.spec.ts src/hookServer.hermes.spec.ts src/hookAdmission.golden.spec.ts src/lib/registry.spec.ts src/lib/registryAdmission.golden.spec.ts src/architecture.spec.ts && npx tsc --noEmit`.
  The two golden specs pass with their fixtures untouched.
- [ ] **Step 5: Commit.** Red: `CLI: specs for the two facts a hook says of its own environment (red)`. Code:
  `CLI: the core takes the gateway and the Codex home a hook reports in its headers`.

---

### Task 4: `notify.mjs` says its own gateway and Codex home

**Depends on:** Task 3 (the header names, the encoding and the bounds it sends). **Effort:** xhigh.

**Files:**
- Modify: `cli/hook/notify.mjs` (`post()` `:407-456`; after `hostHints()` `:497-507`; the last registration of `main()` `:2201-2226`)
- Test: `cli/src/hookNotify.spec.ts` (`collect()` `:259-282`, and the new cases), `cli/src/lib/windows/daemonPipeClients.windows.real.spec.ts` (`:25-37`, `:50-59`, `:62-68`)

**Interfaces:** Consumes the header names `X-Harness-Hook-Gateway` and `X-Harness-Hook-Codex-Home` (Task 3). Produces,
in `notify.mjs`:

```js
/** The endpoint variables that say an engine is routed through OpenRouter: these names exactly. Their values never leave this process. */
const GATEWAY_URLS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']
function ownGateway()       // 'ori' | 'none'
function ownCodexHome()     // string | undefined
function ownFacts(engine)   // the headers for this engine: {}, { 'X-Harness-Hook-Gateway': … } or { 'X-Harness-Hook-Codex-Home': … }
function post(port, path, body, onResponse, facts = {})
```

- `ownGateway()`: `'ori'` when one of the three, parsed with `new URL`, has a hostname matching
  `/(?:^|\.)openrouter\.ai$/i`; else `'none'` (unset, empty and unparsable included).
- `ownCodexHome()`: `process.env.CODEX_HOME` when it is absolute, at most 1,024 characters, has no `CONTROL`
  character and is not `join(homedir(), '.codex')`; else `undefined`.
- `ownFacts(engine)`: the gateway header when `engine` is `claude` or `hermes`; for `codex` with a home of its own,
  the home header as `encodeURIComponent(home)` (Node refuses a header value above U+00FF, and would end the hook);
  nothing for any other engine.
- `post()` spreads `facts` into its headers, after `route.headers`. Only the last registration of `main()` (the
  SessionStart and UserPromptSubmit one, its Hermes retries too) passes `ownFacts(engine)`. Not `fallbackRegister`,
  not `postObserved`, not Copilot's, agy's, Grok's, Cursor's or Command Code's posts. No body changes.

- [ ] **Step 1: Write the failing tests.** `collect()` also returns `headers`, each request's `req.headers`.
  `hookNotify.spec.ts`, a new `describe('hook notify: what the hook says of its own environment')`, with `collect()`
  and `runHook()` in a pane (`tmuxPane: '%42'`) and the three endpoint variables and `CODEX_HOME` emptied in every
  case's `env`:

  ```ts
  it.each([
    ['claude', { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, 'ori'],
    ['claude', { OPENAI_API_BASE: 'https://eu.openrouter.ai/api/v1' }, 'ori'],
    ['hermes', { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }, 'ori'],
    ['claude', {}, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://grid.example/relay' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://openrouter.ai.example.com/api' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'https://example.com/openrouter.ai' }, 'none'],
    ['claude', { ANTHROPIC_BASE_URL: 'not a url' }, 'none'],
  ])('%s with %j says gateway %s', …)          // headers[0]['x-harness-hook-gateway']
  it('says nothing of the gateway for Codex, whose argv says it', …)   // the header is undefined
  it('sends a Codex home of its own, whole, and none for its default, a relative one, one over 1,024 characters or one with a control character', …)
  //   HOME is a temp folder. CODEX_HOME=<temp>/nhà コード/.codex-work: decodeURIComponent(headers[0]['x-harness-hook-codex-home'])
  //   is that path, and the hook exits 0. <temp>/.codex, 'relative', '/' + 'x'.repeat(1024), '/bad\u0007x' and unset:
  //   no such header. A Claude Code hook with CODEX_HOME set: no such header.
  it('sends no value of a key or an endpoint, and no fact in the body', …)
  //   env adds OPENROUTER_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY = 'sk-or-v1-secret' and
  //   ANTHROPIC_BASE_URL=https://openrouter.ai/api: JSON.stringify([requests, headers]) holds neither 'sk-or-v1-secret'
  //   nor 'openrouter.ai'; requests[0].body has neither a 'gateway' nor a 'codexHome' property.
  it('says them on the registration alone', …)
  //   A Stop of the same session: the turn-stop request carries neither header.
  ```

  In `daemonPipeClients.windows.real.spec.ts`, `seen` also records `gateway: req.headers['x-harness-hook-gateway']`:
  the hook's case expects `'none'`, the CLI's fetch `undefined` (it runs on the Windows runners only).
- [ ] **Step 2: Red.** `npx vitest run src/hookNotify.spec.ts -t "own environment"`: no such header is sent.
- [ ] **Step 3: Implement** the three functions, `post()`'s parameter and the one call that passes it.
- [ ] **Step 4: Green.** `npx vitest run src/hookNotify.spec.ts && npx tsc --noEmit` (the whole file: every other
  case's request is as it was).
- [ ] **Step 5: Commit.** Red: `hook: specs for what the hook says of its own environment (red)`. Code:
  `hook: the session's gateway and Codex home, in headers, from the hook's own environment`.

---

### Task 5: OpenCode's plugins say their own gateway

**Depends on:** Task 3 (the header's name and its two words). **Effort:** high.

**Files:**
- Modify: `cli/src/engines/opencode/contract.ts` (`OPENCODE_LEGACY_PLUGIN.template` `:68-101`, `OPENCODE_TUI_PLUGIN.template` `:137-177`)
- Test: `cli/src/engines/pluginPosts.spec.ts` (`Heard` and `recorder()` `:32-46`, and the new cases)
- Record again: `cli/src/engines/__fixtures__/other-hooks.golden.json`, `cli/src/engines/__fixtures__/native-version.golden.json`
- Modify only if they pin the plugins' text: `cli/src/engines/nativeHookPreparation.spec.ts`, `cli/src/engines/pluginPaneHints.spec.ts`, `cli/src/lib/discoveryScripts.spec.ts`

**Interfaces:** The text both templates gain, a constant of `contract.ts` itself (a new kit file would be a new line
of `architecture.coreFiles.txt`), placed after `...PLUGIN_FETCH`:

```ts
/** Plain text: whether this OpenCode's own endpoint variables name OpenRouter. The URL stays in the engine's process. */
const PLUGIN_GATEWAY = `const harnessGateway = () => {
  for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"]) {
    try { if (/(?:^|\\.)openrouter\\.ai$/i.test(new URL(process.env[name] || "").hostname)) return "ori" } catch {}
  }
  return "none"
}
`
```

Each plugin's request gains the header `"x-harness-hook-gateway": harnessGateway()` beside `"x-harness-hook-token"`.
Its body does not change. Kilo's, Pi's and Amp's requests do not change.

- [ ] **Step 1: Write the failing test** in `pluginPosts.spec.ts`, over the two OpenCode entries of `PLUGINS`, with
  `load()` and `holder()` and no socket; `Heard` gains `gateway?: string`, the request's `x-harness-hook-gateway`:

  ```ts
  it.each([
    [{ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }, 'ori'],
    [{ ANTHROPIC_BASE_URL: 'https://openrouter.ai.example.com' }, 'none'],
    [{}, 'none'],
  ])('%j is said as gateway %s, in a header, and never the address', …)
  //   vi.stubEnv each of the three names ('' when the case has none); heard[0].gateway is the answer;
  //   heard[0].body holds neither 'gateway' nor 'openrouter'.
  it('Kilo\'s, Pi\'s and Amp\'s requests say nothing of the gateway', …)   // heard[0].gateway === undefined
  ```
- [ ] **Step 2: Red.** `npx vitest run src/engines/pluginPosts.spec.ts -t gateway`: the header is undefined.
- [ ] **Step 3: Implement,** then record the two fixtures, each alone:
  `RECORD_OTHER_ENGINES_GOLDEN=1 npx vitest run src/engines/otherHooks.golden.spec.ts` and
  `RECORD_NATIVE_VERSION_GOLDEN=1 npx vitest run src/engines/nativeVersion.golden.spec.ts`. `git diff` shows the two
  OpenCode plugin texts and their keys, nothing of Kilo, Pi or Amp.
- [ ] **Step 4: Green.** `npx vitest run src/engines/pluginPosts.spec.ts src/engines/otherHooks.golden.spec.ts src/engines/nativeVersion.golden.spec.ts src/engines/nativeHookPreparation.spec.ts src/engines/pluginPaneHints.spec.ts src/lib/discoveryScripts.spec.ts src/architecture.spec.ts && npx tsc --noEmit`.
- [ ] **Step 5: Commit.** Red: `CLI: a spec that OpenCode's plugins say their gateway (red)`. Code:
  `CLI: OpenCode's plugins say in a header whether their own endpoint is OpenRouter`.

---

### Task 6: The gateway is read from argv, and a relaunch keeps the row's

**Depends on:** Task 2 (`GatewayRuntime` goes, and `openrouter.ts` imported it). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/lib/gatewayRuntime.ts`, `cli/src/lib/gatewayRuntime.spec.ts`
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`:8`, `:44-52`, `:329-333`), `cli/src/lib/terminalAgentDiscovery.gateway.spec.ts`
- Modify: `cli/src/core/agents/restart.ts` (`:12`, `:57-70`), `cli/src/core/agents/restart.spec.ts` (`:6`, `:22`, `:524-526`, `:565-569`)
- Modify: `cli/src/core/agents/retarget.ts` (`:18`, `:320-325`), `cli/src/core/agents/retarget.spec.ts` (`:9`, `:33`, `:212`, `:486-491`)
- Modify (the `gatewayRuntime.js` mock alone; a spec Task 9 or 11 has deleted or rewritten by then needs nothing): `cli/src/core/agents/hostMove.spec.ts` (`:3`), `cli/src/engines/opencodeLaunch.golden.spec.ts` (`:16`), `cli/src/lib/terminalAgentDiscovery.codexHome.spec.ts`, `.grid.spec.ts`, `.hermesHome.spec.ts`, `.wrapperExec.spec.ts`, `cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts`
- Modify (comments): `cli/src/lib/registry.ts` (`:130-136`, `:1784-1786`, `:2762-2764`), `cli/src/engines/README.md` (`:60-61`)

**Interfaces:** Produces, in `lib/gatewayRuntime.ts`:

```ts
/** What a command line says of the gateway: Codex's routing is its argv, so its absence there is a finding; another engine's is not in its argv to read. */
export function gatewayFromArgv(engine: AgentEngine, args: string): 'ori' | null | undefined
```

`'ori'` for `codex` when `argvNamesOpenRouterProvider(args)`, `null` for any other Codex, `undefined` for every other
engine. `argvNamesOpenRouterProvider` stays. Gone: `GatewayRuntime`, `BASE_URL_VARS`, `KEY_VARS`,
`classifyGatewayRuntime`, `probeGatewayRuntime`, `gatewayRuntimeCacheKey`, `clearGatewayRuntimeCache`, the cache, the
re-export of `parseEnviron` and `parsePsEnviron`, the import of `./processEnv.js`. The file's header says where the
gateway comes from now (argv for Codex; a hook's header for the rest, `hookServer.ts` `hookFacts`).

- Discovery: `agent.gateway = gatewayFromArgv(agent.engine, agent.args)`.
- `commitRelaunchedEngine` (`restart.ts`) and the retarget's commit call `updateProcessIdentity` with no gateway: the
  row keeps what it had, and the relaunched engine's next hook says it again. No `await` is left between the swap's
  answer and `current()`.

- [ ] **Step 1: Write the failing tests.**
  - `gatewayRuntime.spec.ts`, replacing every `describe` but `argvNamesOpenRouterProvider`:

    ```ts
    it('says ori for a Codex whose argv names the provider, null for one whose argv does not, and nothing for another engine', () => {
      expect(gatewayFromArgv('codex', 'codex -c model_provider=openrouter -c model_providers.openrouter.base_url="https://openrouter.ai/api/v1"')).toBe('ori')
      expect(gatewayFromArgv('codex', 'codex -m gpt-5')).toBeNull()
      for (const engine of ['claude', 'opencode', 'hermes', 'grok'] as const) expect(gatewayFromArgv(engine, `${engine} -c model_provider=openrouter`)).toBeUndefined()
    })
    ```
  - `terminalAgentDiscovery.gateway.spec.ts`, with no mock of `./gatewayRuntime.js`: a Codex pane whose argv names the
    provider is `'ori'` in every pane that sees it; a plain Codex is `null`; a Claude Code pane's agent has
    `gateway` `undefined`.
  - `restart.spec.ts`: `expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', newProcess)` in
    place of `:524-526`; the `probed` case (`:565-569`) goes. `retarget.spec.ts`: the same expectation on the gateway
    argument (`mock.calls[0][2]` is `undefined`); the `'gateway'` phase (`:212`) goes; "reports a replacement that
    started before a later non-Error exception" throws from `run.tmux.releaseHold` instead
    (`mockRejectedValueOnce('fixture release unavailable')`, and the detail ends with that text).
- [ ] **Step 2: Red.** `npx vitest run src/lib/gatewayRuntime.spec.ts src/lib/terminalAgentDiscovery.gateway.spec.ts src/core/agents/restart.spec.ts src/core/agents/retarget.spec.ts`.
- [ ] **Step 3: Implement.** In the seven specs that only mock the module, delete the mock (and the `probeGatewayRuntime`
  hoisted stubs and resets); none of them needs a stand-in, as the function reads no process.
- [ ] **Step 4: Green.** `npx vitest run src/lib/gatewayRuntime.spec.ts src/lib/terminalAgentDiscovery src/lib/terminalAgentReconciler.wrapperExec.spec.ts src/core/agents/restart.spec.ts src/core/agents/retarget.spec.ts src/core/agents/hostMove.spec.ts src/engines/opencodeLaunch.golden.spec.ts src/architecture.spec.ts && npx tsc --noEmit`,
  then `restart.ts` and `retarget.ts` at 100 in every column:
  `npx vitest run src/core/agents/restart.spec.ts src/core/agents/retarget.spec.ts src/core/agents/hostMove.spec.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include=src/core/agents/restart.ts --coverage.include=src/core/agents/retarget.ts`.
- [ ] **Step 5: Commit.** Red: `CLI: specs for a gateway read from argv alone (red)`. Code:
  `CLI: the gateway is Codex's argv or a hook's word, never a process's environment`.

---

### Task 7: A retarget records the grid it launched

**Depends on:** nothing. **Effort:** high.

**Files:** Modify `cli/src/core/agents/retarget.ts` (`:321-329`). Test: `cli/src/core/agents/retarget.spec.ts`.

- [ ] **Step 1: Write the failing test.**

  ```ts
  it('writes the grid it launched on the row, and none for a move home', async () => {
    const run = setup()
    await run.retarget({ agentId: 'a1', grid })
    expect(vi.mocked(run.deps.registry.updateProcessIdentity).mock.calls.at(-1)![3]).toEqual({ baseUrl: grid.baseUrl, model: grid.model ?? null })
    const home = setup(/* a row on a grid */)
    await home.retarget({ agentId: 'a1', grid: null })
    expect(vi.mocked(home.deps.registry.updateProcessIdentity).mock.calls.at(-1)![3]).toBeNull()
  })
  ```
- [ ] **Step 2: Red.** `npx vitest run src/core/agents/retarget.spec.ts -t "grid it launched"`: the fourth argument is
  `undefined`.
- [ ] **Step 3: Implement.** At the commit, `updateProcessIdentity`'s grid argument is
  `grid ? { baseUrl: grid.baseUrl, model: grid.model ?? null } : null`, the projection `create.ts:415` writes. One
  comment: the row's grid is the launch Harness wrote, as the process is not read back.
- [ ] **Step 4: Green,** with `retarget.ts` at 100 in every column (Task 6's coverage command, this file).
- [ ] **Step 5: Commit.** Red: `CLI: a spec that a retarget writes its grid on the row (red)`. Code:
  `CLI: a retarget writes the grid it launched on the row`.

---

### Task 8: Grid evidence is argv alone, and no environment crosses the models port

**Depends on:** Task 7 (it writes the grid this task stops reading back after a retarget). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/lib/gridAssignmentWire.ts`, `cli/src/lib/gridAssignment.ts`, `cli/src/testing/gridAssignmentShapes.ts`
- Modify: `cli/src/core/agents/gridAssignments.ts` (`:3-5`, `:80-91`), `cli/src/lib/terminalAgentDiscovery.ts` (`:9`, `:53-59`, `:334-340`)
- Modify (comments): `cli/src/core/agents/discovery.ts` (`:161-162`), `cli/src/lib/gridLaunch.ts` (`:164-170`), `cli/src/lib/gridLaunch.spec.ts` (`:526-529`)
- Test: `cli/src/lib/gridAssignmentWire.spec.ts`, `cli/src/lib/gridAssignment.spec.ts`, `cli/src/lib/terminalAgentDiscovery.grid.spec.ts`, `cli/src/core/agents/gridAssignments.spec.ts`, `cli/src/core/modelsLink.spec.ts` (`:104`), `cli/src/services/models.spec.ts` (`:750-760`), `cli/src/lib/apiModels.spec.ts` (`:117-120`, `:262-264`)
- Record again: `cli/src/lib/__fixtures__/grid-assignment-shapes.golden.json` (with `gridAssignmentShapes.golden.spec.ts`), `cli/src/engines/__fixtures__/discovery.golden.json` (with `discovery.golden.spec.ts` `gridCases`, `:158-180`)

**Interfaces:** Produces:

```ts
// lib/gridAssignmentWire.ts
export interface GridAssignmentProcess { key: string; engine: AgentEngine; args: string }
/** The launch markers a command line holds: a provider block with its `-m`, or Pi's `-e …/grid-provider.ts` with its `--model`. Null when it holds none. */
export function gridAssignmentProcess(key: string, engine: AgentEngine, args: string): GridAssignmentProcess | null
export function gridAssignmentEvidence(key: string, engine: AgentEngine, args: string): GridAssignmentProcess | null | undefined
export function gridAssignmentProcessesIn(value: unknown): GridAssignmentProcess[] | null
// lib/gridAssignment.ts
export function classifyGridAssignment(engine: AgentEngine, args: string): GridAssignment | null
export async function readPiGridAssignment(args: string): Promise<GridAssignment | null>
export async function gridAssignments(processes: readonly GridAssignmentProcess[]): Promise<GridAssignmentAnswer[]>
```

`gridAssignmentEvidence`, the whole rule:

| Engine | argv holds the marker | argv holds none |
| --- | --- | --- |
| `claude`, `hermes`, `grok`, `copilot`, `opencode` | `undefined` | `undefined` |
| `pi` | the process | `undefined` |
| every other engine (`codex` among them) | the process | `null` |

The first row is one set in `gridAssignmentWire.ts`, in place of `GRID_ENDPOINT_VARS` and `GRID_MODEL_VARS`: engines
whose grid is in no command line, so the launch record says it. `gridAssignmentProcess` is null for them whatever
the argv, so models refuses a row for one. `gridAssignmentProcessesIn` refuses a row with any member but `key`,
`engine` and `args`.

Gone from `gridAssignment.ts`: the import of `./processEnv.js`, `PI_CONFIG_DIR_VAR` and the directory branch,
`readOpencodeGridAssignment`, `OPENCODE_CONFIG_VAR`, `probeGridAssignment`, `gridAssignmentFromEnv` (one private
function over `args` takes its place), the environment and Grok branches of `classifyGridAssignment`, `'grok'` in
`MODEL_IN_ARGV`. Its header loses the paragraph that says the answer is read from the process and that a
`ANTHROPIC_BASE_URL=… claude` started by hand "reports the truth"; it says instead what is read (argv, for Codex and
Pi) and what is not.

- `gridAssignments.refresh`: `processLaunchArgs(identity)` alone, then `gridAssignmentEvidence(owner.key, session.engine, args)`.
- Discovery: `gridAssignmentEvidence('', agent.engine, row ? launchArgs(enrichedRows, row) : agent.args)`.

- [ ] **Step 1: Write the failing tests.**
  - `gridAssignmentWire.spec.ts`:

    ```ts
    it('carries argument fragments alone: no environment, no prompt', () => {
      const input = gridAssignmentProcess('a', 'codex', 'codex --prompt private -c model_providers.grid.base_url="https://grid.example/relay/v1" -m m')!
      // Two spaces, as today: the `-m` fragment carries the one before it.
      expect(input).toEqual({ key: 'a', engine: 'codex', args: 'model_providers.grid.base_url="https://grid.example/relay/v1"  -m m' })
      expect(gridAssignmentProcessesIn([input])).toEqual([input])
      expect(gridAssignmentProcessesIn([{ ...input, env: {} }])).toBeNull()
    })
    it('has no evidence for an engine whose grid is in no command line, and a finding for Codex', () => {
      const argv = '-c model_providers.grid.base_url="https://grid.example/relay/v1" -m m'
      for (const engine of ['claude', 'hermes', 'grok', 'copilot', 'opencode'] as const) expect(gridAssignmentEvidence('a', engine, argv)).toBeUndefined()
      expect(gridAssignmentEvidence('a', 'pi', '--model grid/m')).toBeUndefined()
      expect(gridAssignmentEvidence('a', 'pi', '-e /c/grid-provider.ts --model grid/m')).toEqual({ key: 'a', engine: 'pi', args: '-e /c/grid-provider.ts --model grid/m' })
      expect(gridAssignmentEvidence('a', 'codex', 'codex -m gpt-5')).toBeNull()
    })
    ```
  - `terminalAgentDiscovery.grid.spec.ts`, with no mock of `./processEnv.js`: "a Claude Code started by hand has no
    grid to report" (`gridProcess` and `grid` both `undefined`); a Codex whose argv names a provider has
    `gridProcess` `{ key: '', engine: 'codex', args: … }`; a plain Codex has `grid` `null`; the Pi case keeps its two
    answers without its `env: {}`.
  - `gridAssignments.spec.ts`: `refresh` of a Claude Code row asks models nothing and applies nothing; of a Codex row
    whose `processLaunchArgs` names a provider, asks with `{ key, engine: 'codex', args }`; of a plain Codex, clears
    the assignment. Every `gridProcess` fixture loses `env`; the mock of `processEnv.js` goes.
  - `gridAssignment.spec.ts`: the cases over an environment go ("reads back what every supported engine was launched
    with" keeps Codex and Pi; "never carries the credential out", "reads a real macOS `ps eww` line", "still reads a
    Pi launched before the extension", the whole `readOpencodeGridAssignment` block, "a failed read is not a
    finding"); one case is added: `classifyGridAssignment('claude', '')` is null and Pi with no extension is null.
  - `modelsLink.spec.ts`, `models.spec.ts`, `apiModels.spec.ts`: their processes become Codex's, named in argv
    (`-c model_providers.grid.base_url="<url>" -m m`), with the same expectations.
- [ ] **Step 2: Red.** `npx vitest run src/lib/gridAssignmentWire.spec.ts src/lib/terminalAgentDiscovery.grid.spec.ts src/core/agents/gridAssignments.spec.ts`.
- [ ] **Step 3: Implement.** `testing/gridAssignmentShapes.ts` `assignment(engine, args)`; in
  `gridAssignmentShapes.golden.spec.ts` the cases over `vars` and `PI_CODING_AGENT_DIR` go and the rest pass `args`
  alone; in `discovery.golden.spec.ts` `gridCases` calls `classifyGridAssignment(engine, args)` and its `environment`
  shape goes. Record each alone: `RECORD_GRID_ASSIGNMENT_GOLDEN=1 npx vitest run src/lib/gridAssignmentShapes.golden.spec.ts`
  and `RECORD_DISCOVERY_GOLDEN=1 npx vitest run src/engines/discovery.golden.spec.ts`. In the second fixture only the
  grid section moves.
- [ ] **Step 4: Green.** `npx vitest run src/lib/gridAssignment.spec.ts src/lib/gridAssignmentWire.spec.ts src/lib/gridAssignmentShapes.golden.spec.ts src/lib/apiModels.spec.ts src/lib/gridLaunch.spec.ts src/lib/terminalAgentDiscovery.grid.spec.ts src/engines/discovery.golden.spec.ts src/core/agents/gridAssignments.spec.ts src/core/modelsLink.spec.ts src/services src/architecture.spec.ts && npx tsc --noEmit`,
  then `gridAssignments.ts` at 100 in every column (the coverage command of Task 6, this file and its spec).
- [ ] **Step 5: Commit.** Red: `CLI: specs for grid evidence from argv alone (red)`. Code:
  `CLI: the grid is the launch record or argv, and no environment crosses the models port`.

---

### Task 9: A Codex home is never read from the environment

**Depends on:** Task 0 (its verdict for Codex) and Task 3 (`reportedProfileHome`, which this task gives its own
body); on Branch A also Task 14 (`heldHome`, `engineChild`). **Effort:** xhigh.

**Whose descriptors (decision 8; PM, 2026-11-15).** The selected Codex process, and exactly one more when it is a
launcher: its one direct child that is Codex's own binary (`engineChild`). Never a level further down, never a second
child, never any other process. This task passes `heldHome` that one function and no other way to name a process.

**Branch A** when "Spike result" says Codex is held: the home comes from the rollout the process holds open.
**Branch B** when it says lost: discovery reports no Codex home at all, and the hook and the launch are its only
sources. Read the verdict first; a line below with no branch named is for both.

**Files:**
- Modify: `cli/src/engines/discoveries.ts` (`:7-8`, `:45-62`), `cli/src/engines/kit/processFacts.ts` (`:26-36`), `cli/src/engines/facets/discovery.ts` (`:30-32`), `cli/src/engines/codex/discoveryContract.ts` (`:16-22`)
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`:11`, `:69-74`, `:320-323`, `:341-342`), `cli/src/lib/registry.ts` (the field's doc `:204-212`, `setCodexHome`'s doc `:2826-2827`)
- Branch A, modify: `cli/src/architecture.coreFiles.txt` (the line `lib/processHeldFiles.ts`, in order), `cli/src/lib/terminalAgentDiscovery.codexHome.spec.ts`
- Branch B, modify: `cli/src/core/agents/discovery.ts` (`:129`, `:209-213`), `cli/src/lib/registry.ts` (`openProcessAgent`'s `codexHome` input `:1719-1721`, `:1788`, `:1833`; `setCodexHome` `:2826-2834`)
- Branch B, delete: `cli/src/lib/terminalAgentDiscovery.codexHome.spec.ts`
- Test: `cli/src/engines/kit/processFacts.spec.ts`, `cli/src/engines/discovery.golden.spec.ts` (`profileCases`, `:184-212`); Branch A also `cli/src/engines/discoveries.spec.ts` (new); Branch B also `cli/src/core/agents/discovery.spec.ts` (`:136-157`), `cli/src/lib/registry.spec.ts` (`:2370-2386`)
- Record again: `cli/src/engines/__fixtures__/discovery.golden.json`

**Interfaces:** Produces, in the kit, on both branches:

```ts
/** A reported profile home, when it could be one and is not the machine's default: absolute, at most 1,024 characters, no control character, compared through real paths. */
export function profileHome(profile: NonNullable<DiscoveryContract['profile']>, home: string, defaultHome: string): string | null
```

`reportedProfileHome(engine, home, defaultHome?)` calls it (`defaultHome ?? env[profile.setting]`). The daemon no
longer names the variable, the hook does: `DiscoveryContract.profile` loses `variable`. Gone on both branches:
`profileFromEnv`, `profileHomeFromEnv`, the import of `lib/processEnv.js` in `discoveries.ts`.

Branch A:

```ts
// facets/discovery.ts
profile?: { setting: FolderSetting; held: RegExp; trimTrailingSlashes?: boolean }
// codex/discoveryContract.ts: the rollout a Codex holds open for its whole run, its first group the home
profile: { setting: 'CODEX_HOME', held: /^(.+)\/sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/ },
// engines/discoveries.ts
/**
 * The engine home a process runs under, from the rollout it holds open, when it is not this machine's default: a
 * path, `null` for the default (or an engine with no such profile), `undefined` when it holds none yet or its files
 * cannot be listed, which never overwrites what the registry knows.
 */
export async function probeProfileHome(selected: ProcessIdentity, engine: AgentEngine, child?: () => ProcessIdentity | undefined): Promise<string | null | undefined>
```

- `probeProfileHome`: no `profile` is `null`; `heldHome(selected, profile.held, child)` undefined is `undefined`;
  else `profileHome(profile, home, env[profile.setting])`.
- `probeTerminalAgents` builds the pass's ownership snapshot once, where a pane exists
  (`roots.length ? agentCommandOwnershipSnapshot() : undefined`), hands it to
  `discoverTerminalAgentsFromSnapshot` (its sixth parameter, which builds its own only when given none) and to
  `engineChild`. Then
  `agent.codexHome = await probeProfileHome(agent.processIdentity, agent.engine, () => engineChild(enrichedRows, agent.engine, agent.processIdentity, ownership))`.
  The function is given the agent's own engine and its own selected process, so the child it names is that
  launcher's one direct child of the same engine, or nothing.
- Stay as they are: `DiscoveredTerminalAgent.codexHome` (its doc now says "from the rollout it holds open"),
  `registry.setCodexHome`, `openProcessAgent`'s `codexHome` input, and the fill in `core/agents/discovery.ts`.

Branch B: `DiscoveryContract.profile` is `{ setting: FolderSetting; trimTrailingSlashes?: boolean }`. Gone too:
`probeProfileHome`, `DiscoveredTerminalAgent.codexHome`, `registry.setCodexHome`, `openProcessAgent`'s `codexHome`
input, the fill in `core/agents/discovery.ts`.

- [ ] **Step 1: Write the failing tests.**
  - Both: `processFacts.spec.ts`, its three cases against `reportedProfileHome(engine, home, DEFAULT)`: a home that is
    not the default is taken; the default is null "whichever way it is spelled"; `'claude'`, `'relative/dir'`,
    `'/bad\nline'` and `'/' + 'x'.repeat(1024)` are null, and `undefined` is null.
  - Branch A, `discoveries.spec.ts`, with `../lib/processHeldFiles.js` mocked:

    ```ts
    it('names a Codex home from the rollout its process holds open, and never the default', async () => {
      heldHome.mockResolvedValue('/home/u/.codex-work')
      expect(await probeProfileHome(identity, 'codex', child)).toBe('/home/u/.codex-work')
      expect(heldHome).toHaveBeenCalledWith(identity, discoveryContract('codex')!.profile!.held, child)
      heldHome.mockResolvedValue(env.CODEX_HOME); expect(await probeProfileHome(identity, 'codex')).toBeNull()
      heldHome.mockResolvedValue(undefined); expect(await probeProfileHome(identity, 'codex')).toBeUndefined()
      expect(await probeProfileHome(identity, 'claude')).toBeNull()
    })
    it('the pattern takes a rollout under sessions, at any depth, and nothing else', () => {
      const held = discoveryContract('codex')!.profile!.held
      expect(held.exec('/c/sessions/2026/11/15/rollout-2026-11-15T00-00-00-a.jsonl')?.[1]).toBe('/c')
      expect(held.exec('/c/sessions/rollout-a.jsonl')?.[1]).toBe('/c')
      for (const path of ['/c/archived_sessions/rollout-a.jsonl', '/c/sessions/a/history.jsonl', '/c/sessions/rollout-a.jsonl (deleted)', '/c/rollout-a.jsonl'])
        expect(held.test(path)).toBe(false)
    })
    ```

    `terminalAgentDiscovery.codexHome.spec.ts`, its two cases kept with the new call: the probe is called with the
    agent's `processIdentity`, its engine and a function; `agentCommandOwnershipSnapshot` is called once in a pass.
    One new case, "names a launcher's one Codex child, and no other process": with a Node launcher row, one native
    `codex` under it and a shell beside that one, the function returns the native child's identity; with two native
    children under the launcher, and with the native binary under the shell (a level further down), it returns
    `undefined`.
  - Branch B, `discovery.spec.ts`: in "updates the row from the live process", `seen()` carries no `codexHome` and
    the registry stand-in has no `setCodexHome`; a new line: `onDiscovered`'s `openProcessAgent` argument has no
    `codexHome` property. `registry.spec.ts` `:2370-2386`: the case that fills a home through `openProcessAgent` and
    `setCodexHome` goes (Task 3's case is the one way a discovered row learns a home).
- [ ] **Step 2: Red.** `npx vitest run src/engines/kit/processFacts.spec.ts`, and on Branch A
  `src/engines/discoveries.spec.ts src/lib/terminalAgentDiscovery.codexHome.spec.ts`, on Branch B
  `src/core/agents/discovery.spec.ts`.
- [ ] **Step 3: Implement.** `profileCases` in the golden spec calls
  `reportedProfileHome(engine, environment.CODEX_HOME, defaultHome)`, and its "too long" and "just long enough" shapes
  move to 1,025 and 1,024 characters. Record: `RECORD_DISCOVERY_GOLDEN=1 npx vitest run src/engines/discovery.golden.spec.ts`;
  only the profile section moves. Branch A: add the line `lib/processHeldFiles.ts` to `architecture.coreFiles.txt`,
  in order.
- [ ] **Step 4: Green.** `npx vitest run src/engines/kit/processFacts.spec.ts src/engines/discovery.golden.spec.ts src/engines/discoveries.spec.ts src/lib/terminalAgentDiscovery src/lib/registry.spec.ts src/core/agents/discovery.spec.ts src/hookServer.spec.ts src/architecture.spec.ts && npx tsc --noEmit`
  (a spec this branch does not have is left out); on Branch B `core/agents/discovery.ts` at 100 in every column.
- [ ] **Step 5: Commit.** Red: `CLI: specs for a Codex home no environment names (red)`. Code, Branch A:
  `CLI: a Codex home comes from its launch, its hook or the rollout it holds open`. Branch B:
  `CLI: a Codex home comes from its launch or its hook, never from the process`.

---

### Task 10: The DSH is the launch record's

**Depends on:** nothing. **Effort:** high.

**Files:**
- Delete: `cli/src/dsh/probe.ts`, `cli/src/dsh/probe.spec.ts`
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`:13`, `:95-100`, `:354-355`), `cli/src/core/agents/discovery.ts` (`:130`, `:222-224`), `cli/src/lib/registry.ts` (`openProcessAgent`'s `dsh` input `:1725-1726`, `:1791`, `:1836`; `setDsh` `:2860-2872`; the field's doc `:264-270`), `cli/src/architecture.coreFiles.txt` (the `dsh/probe.ts` line)
- Test: `cli/src/core/agents/discovery.spec.ts`, `cli/src/dsh/launch.spec.ts` (`:5`, `:40`, `:91-96`), `cli/src/lib/registry.spec.ts` (a case on `setDsh` or that input, if one exists)

**Interfaces:** Gone: `probeDsh`, `dshFromEnv`, `DSH_ENV_VAR`, `DiscoveredTerminalAgent.dsh`, `registry.setDsh`,
`openProcessAgent`'s `dsh` input. A row's `dsh` is written at create and carried by every relaunch
(`openPendingAgent`, `register()`), as today; a row discovery mints has none. `attachDsh` still runs for a row that
has one.

- [ ] **Step 1: Write the failing test** in `discovery.spec.ts`:

  ```ts
  it('mints a row with no DSH, and fills none from a process', async () => {
    const run = setup()
    await run.handlers.onDiscovered(seen({ dsh: 'blender' } as never))
    expect(vi.mocked(run.deps.registry.openProcessAgent).mock.calls[0]![0]).not.toHaveProperty('dsh')
    await run.handlers.onObserved(seen({ dsh: 'blender' } as never), row())
    expect(run.deps.attachDsh).not.toHaveBeenCalled()
    // A row Harness created as a DSH keeps its viewer.
    run.rows.set('a1', row({ dsh: 'blender' } as Partial<RegisteredSession>))
    await run.handlers.onObserved(seen(), row({ dsh: 'blender' } as Partial<RegisteredSession>))
    expect(run.deps.attachDsh).toHaveBeenCalled()
  })
  ```

  `launch.spec.ts`: `expect(launch.env.HARNESS_DSH).toBe('autonomous/circuit')` in place of `:40`, and the
  `describe('dshFromEnv')` goes.
- [ ] **Step 2: Red.** `npx vitest run src/core/agents/discovery.spec.ts -t "no DSH"`.
- [ ] **Step 3: Implement** the removals; the registry stand-in of `discovery.spec.ts` loses `setDsh`.
- [ ] **Step 4: Green.** `npx vitest run src/dsh src/core/agents/discovery.spec.ts src/lib/terminalAgentDiscovery src/lib/registry.spec.ts src/architecture.spec.ts && npx tsc --noEmit`;
  `core/agents/discovery.ts` at 100 in every column.
- [ ] **Step 5: Commit.** Red: `CLI: a spec that no DSH is read from a process (red)`. Code:
  `CLI: a harness's DSH is its launch record's, never read from its process`.

---

### Task 11: A Hermes's home is never read from its environment

**Depends on:** Task 0 (its verdict for Hermes); on Branch A also Task 14 (`heldHome`, `engineChild`), and Task 9
when Codex is held too (it adds the wiring both use). **Effort:** xhigh.

**Branch A** when "Spike result" says Hermes is held: the home comes from the `state.db` the process holds open.
**Branch B** when it says lost: discovery reports no Hermes home, and a Hermes with no hook is found store by store
in the daemon's default home and its profiles. Read the verdict first; a line below with no branch named is for
both. `engines/kit/processHome.ts` goes on both (decision 10): the descriptor work uses none of it.

**The mark (decision 8; PM, 2026-11-15).** Branch A: a home found from a descriptor is marked `hermesHomeDerived`
only when the process is in a sandbox, where its path was mapped through `lib/processMounts.ts`: a relaunch does not
export the daemon's path of it. Outside a sandbox it is not marked: a relaunch exports it as `HERMES_HOME`, so a
Hermes started by hand as `HERMES_HOME=/x hermes` resumes its session after a restart from Harness. Branch B: no
home comes from a descriptor, so discovery marks nothing; a mark a saved row already has is kept, as written below.

**Whose descriptors (decision 8; PM, 2026-11-15).** Branch A: the selected Hermes process, and exactly one more when
it is a launcher: its one direct child that is Hermes's own binary (`engineChild`). Never a level further down, never
a second child, never any other process: not the shared gateway, which `engineChild` never names
(`processTable.ts:765`: `engineProcessMatch` gives a Hermes gateway a score of 0).

**Files:**
- Modify: `cli/src/engines/identities.ts` (`:10`, `:14`, `:33-84`), `cli/src/engines/hermes/inProcess.ts` (`:12`), `cli/src/engines/hermes/home.ts` (comment `:11-15`), `cli/src/engines/hermes/contract.ts` (`HERMES_HOME_RULE` `:128-132`)
- Delete: `cli/src/engines/hermes/homeProbe.ts`, `cli/src/engines/kit/processHome.ts`, `cli/src/engines/kit/processHome.spec.ts`
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`:12`, `:75-94`, `:343-352`), `cli/src/core/agents/discovery.ts` (`:214-221`), `cli/src/lib/registry.ts` (`setHermesHome` `:2836-2850`, the fields' docs `:218-239`), `cli/src/architecture.coreFiles.txt` (the `engines/kit/processHome.ts` line; on Branch A the `lib/processHeldFiles.ts` line when Task 9 did not add it)
- Branch A, modify: `cli/src/core/agents/bind.ts` (the comment `:590` alone)
- Branch B, modify: `cli/src/core/agents/bind.ts` (`:589-591`), `cli/src/core/agents/hermesTerminal.ts` (`:38`, `:101`), `cli/src/lib/registry.ts` (`RegisterInput.hermesHomeDerived` `:404-405`, `register()` `:2255-2259`)
- Test: `cli/src/engines/identities.hermes.spec.ts` (`:14-15`, `:48-112`), `cli/src/lib/terminalAgentDiscovery.hermesHome.spec.ts`, `cli/src/core/agents/discovery.spec.ts` (`:159-170`), `cli/src/lib/registry.hermesHome.spec.ts`, `cli/src/engines/otherAdmission.golden.spec.ts` (`:28-38`, `:183-213`); Branch B also `cli/src/core/agents/bind.spec.ts` (`:885-912`), `cli/src/core/agents/hermesTerminal.spec.ts`
- Edit by hand: `cli/src/engines/__fixtures__/other-admission.golden.json` (its `home probe` key, deleted)

**Interfaces:** Produces, on both branches:

```ts
/**
 * A Hermes process in another mount namespace: its folder as it names it, and the daemon's path of it. 'unseen' when
 * that folder has no path in the daemon's view. Undefined for a process that sees the daemon's mounts, one whose
 * namespace cannot be read, and another engine. Its home is not asked here: an unknown home holds nothing.
 */
export async function probeHermesSandbox(identity: ProcessIdentity, engine: AgentEngine): Promise<{ cwd: string; hostCwd: string } | 'unseen' | undefined>
```

Gone on both: `probeHermesHomeDerived`, `namedHome`, the import of `lib/processEnv.js`, `kit/processHome.ts` and its
spec, `HERMES_HOME_RULE`, `hermes/homeProbe.ts` and its line in `hermes/inProcess.ts` (nothing calls either), the
golden case "reads a Hermes process's home off its environment" with its `envs` map and its mock of `processEnv.js`.
`bind.ts`'s `'unseen'` hold is unchanged: it now holds only a folder with no path here (decision 9). The repair
(`bind.ts` `findLiveSession`, `hermesHome: agent.hermesHome`) and the hook gate (`inspectHermesKind`) go on finding a
session store by store, in the row's home, else the daemon's default home and its profiles, and filling the row.

Branch A:

```ts
// hermes/contract.ts, in place of HERMES_HOME_RULE
/** The store a Hermes holds open for its whole run (docs/plans/2026-11-15-process-env-secrets-plan.md, "Spike result"): its first group is the home. */
export const HERMES_HELD_STORE = /^(.+)\/state\.db$/
// identities.ts
/**
 * The home a Hermes process works in, from the store it holds open, at the daemon's path of it. Null is the daemon's
 * default home, and another engine; undefined is a process that holds no store yet, one whose files cannot be
 * listed, or a sandbox's home with no path here, and must preserve an existing home.
 */
export async function probeHermesHome(selected: ProcessIdentity, engine: AgentEngine, child?: () => ProcessIdentity | undefined): Promise<string | null | undefined>
// registry: fill-only, whatever `derived` says. A row that has a home returns false. `derived` is true only for
// the daemon's path of a sandboxed process's home.
setHermesHome(agentId: string, hermesHome: string, derived = false): boolean
```

- `probeHermesHome`: another engine is `null`; `heldHome(selected, HERMES_HELD_STORE, child)` undefined is
  `undefined`; a home whose real path is that of `env.HERMES_HOME` (trailing slashes off) is `null`; else the home.
  It no longer asks `processView`: `heldHome` gives the daemon's path.
- Discovery: `agent.hermesHome = await probeHermesHome(agent.processIdentity, agent.engine, child)`, with the `child`
  function and the pass's one ownership snapshot of Task 9's Branch A (when Codex is lost, this task adds those
  lines, as Task 9 words them, with its case "names a launcher's one Hermes child, and no other process" in
  `terminalAgentDiscovery.hermesHome.spec.ts`).
- The mark, in discovery, after the sandbox probe the pass already makes:

  ```ts
  const sandbox = await probeHermesSandbox(agent.processIdentity, agent.engine)
  // Only a sandbox's home is the daemon's own path of it, which a relaunch must not hand back. Outside one the
  // home is the store the process uses, and a relaunch names it (HERMES_HOME=/x hermes, typed by hand, restarted).
  if (agent.hermesHome && sandbox) agent.hermesHomeDerived = true
  ```

  `sandbox` is a folder or `'unseen'` for a process in another mount namespace, and `undefined` for one that sees
  the daemon's mounts: both sandbox answers mark, `undefined` never does. No mark without a home (`null`,
  `undefined`), in a sandbox too. On macOS and Windows no process is in a sandbox (`processView` answers `same`), so
  no home is marked there.
- `core/agents/discovery.ts`: `if (observed.hermesHome && !current.hermesHome) registry.setHermesHome(current.agentId, observed.hermesHome, observed.hermesHomeDerived === true)`.
  The clause that marked again a row that had its home unmarked goes, in the handler and in `setHermesHome`: a
  descriptor cannot tell that row from one Harness launched by name, whose relaunch must export its home.
- The relaunch itself does not change: `nativeLaunch.ts:178` exports a row's home unless it is marked, so an unmarked
  home from a descriptor is exported as `HERMES_HOME` with no new code.
- Stay as they are: `DiscoveredTerminalAgent.hermesHome` and `.hermesHomeDerived`, `RegisterInput.hermesHomeDerived`,
  `bind.ts`'s spread, `HermesObserved.hermesHome`. Their docs change: `hermesHome` is "from the store it holds
  open"; `hermesHomeDerived` (`terminalAgentDiscovery.ts`, `registry.ts` `RegisteredSession`, the comment at
  `bind.ts:590`) is "the daemon's path of a sandboxed process's home", with no word of a home worked out from the
  process's `HOME`.

Branch B:

```ts
setHermesHome(agentId: string, hermesHome: string): boolean
export type HermesObserved = Pick<DiscoveredTerminalAgent, 'processIdentity' | 'runtimes' | 'primaryRuntimeKey'> & { sandboxed: boolean }
```

Gone too: `probeHermesHome`, `DiscoveredTerminalAgent.hermesHome` and `.hermesHomeDerived`, the fill in
`core/agents/discovery.ts`, `setHermesHome`'s `derived` argument, `RegisterInput.hermesHomeDerived` and the clause of
`register()` that reads it, `bind.ts`'s `observed.hermesHomeDerived` spread. Kept: a saved row's `hermesHomeDerived`
is still loaded (`storedHermesHomeDerived`), carried through a bind with the home it was set with (`register()`,
`withHermesHome`) and kept off a relaunch's environment (`nativeLaunch.ts:178`). `hermesTerminal.follow` reads the
record in `agent.hermesHome ?? deps.defaultHome`.

- [ ] **Step 1: Write the failing tests.**
  - Both, `identities.hermes.spec.ts`, with no mock of `../lib/processEnv.js`, in place of `:48-112`:

    ```ts
    it('gives a sandboxed Hermes the daemon\'s path of its folder, with nothing known of its home', async () => {
      processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (path: string) => `/data/agents/a1${path}` })
      expect(await probeHermesSandbox(identity, 'hermes')).toEqual({ cwd: '/work', hostCwd: '/data/agents/a1/work' })
    })
    it('cannot see a sandbox whose folder has no path here', …)        // cwd null, or toHost(cwd) null: 'unseen'
    it('is no sandbox in the daemon\'s namespace, when it cannot tell, or for another engine', …)   // undefined, three times
    ```
  - Both, `otherAdmission.golden.spec.ts`: the case "reads a Hermes process's home off its environment" and the
    `envs` map and mock of `processEnv.js` go, with the fixture's `home probe` key.
  - Branch A, `identities.hermes.spec.ts`, with `../lib/processHeldFiles.js` mocked:

    ```ts
    it('names the home of the store a Hermes holds open, null for the daemon\'s own, and nothing when it holds none', async () => {
      heldHome.mockResolvedValue('/data/agents/a1/.hermes')
      expect(await probeHermesHome(identity, 'hermes', child)).toBe('/data/agents/a1/.hermes')
      expect(heldHome).toHaveBeenCalledWith(identity, HERMES_HELD_STORE, child)
      heldHome.mockResolvedValue(linkToDefault)        // a symbolic link to env.HERMES_HOME
      expect(await probeHermesHome(identity, 'hermes')).toBeNull()
      heldHome.mockResolvedValue(undefined)
      expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
      heldHome.mockClear()
      expect(await probeHermesHome(identity, 'claude')).toBeNull()
      expect(heldHome).not.toHaveBeenCalled()
    })
    it('the pattern takes a file named state.db and nothing else', () => {
      expect(HERMES_HELD_STORE.exec('/h/.hermes/state.db')?.[1]).toBe('/h/.hermes')
      for (const path of ['/h/.hermes/state.db-wal', '/h/.hermes/state.db-shm', '/h/.hermes/state.db (deleted)', '/h/.hermes/mystate.db'])
        expect(HERMES_HELD_STORE.test(path)).toBe(false)
    })
    ```

    `terminalAgentDiscovery.hermesHome.spec.ts`, with `./processHeldFiles.js` mocked (`heldHome`) where
    `./processEnv.js` was, and `processView` mocked as today. The cases that fed an environment are told by
    `heldHome`'s answer instead; `heldHome` gets the agent's `processIdentity`, `HERMES_HELD_STORE` and a function.
    The mark's two cases are written first and are red before the change:

    ```ts
    it('leaves a home found outside a sandbox unmarked, so a relaunch names it', async () => {
      heldHome.mockResolvedValue('/x')                         // HERMES_HOME=/x hermes, typed by hand
      processView.mockResolvedValue({ state: 'same' })
      const { hermes } = await agents()
      expect(hermes.hermesHome).toBe('/x')
      expect(hermes).not.toHaveProperty('hermesHomeDerived')
      expect(hermes).not.toHaveProperty('sandbox')
    })
    it('marks a home found in a sandbox, whether or not its folder has a path here', async () => {
      heldHome.mockResolvedValue('/data/agents/a1/.hermes')    // the daemon's path, as heldHome maps it
      processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace(/^\/work/, '/data/work/p1') })
      expect((await agents()).hermes).toMatchObject({ cwd: '/data/work/p1', sandbox: { cwd: '/work' }, hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
      processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
      expect((await agents()).hermes).toMatchObject({ cwd: '/work', sandbox: 'unseen', hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true })
    })
    it('marks nothing with no home, in a sandbox too', …)
    //   heldHome → the daemon's own home (null on the agent), then undefined; processView → sandbox both times:
    //   neither agent has a hermesHomeDerived property, and a Claude Code beside them never has one.
    ```

    The case "marks a home worked out from HOME, and not a profile the process named" goes: the first case above
    takes its place, and a `HOME` of its own outside a sandbox is no longer marked.
    `discovery.spec.ts`, in place of `:159-170`: "fills a Hermes home it did not have, with the mark discovery gave
    it, and never marks or moves one it has". Over a row with no home: an observed `{ hermesHome: '/x' }` (found
    outside a sandbox) calls `setHermesHome('a1', '/x', false)`, and an observed
    `{ hermesHome: '/x', hermesHomeDerived: true }` (in a sandbox) calls `setHermesHome('a1', '/x', true)`. Over a
    row that has `/x` unmarked, and over one that has `/y`, neither observation calls it.
    `registry.hermesHome.spec.ts`: "marks again a row an older daemon saved over, and never moves a row to another
    home" becomes "never marks a row that has its home unmarked, and never moves a row to another home"
    (`setHermesHome(id, sameHome, true)` is `false` and the saved row has no mark). The other four stay; "leaves a
    home the process named unmarked…" is now named "leaves a home found outside a sandbox unmarked, as a row an
    older release saved is", and it is the row a relaunch exports.
  - Branch B. `terminalAgentDiscovery.hermesHome.spec.ts`: the two sandbox cases stay (the daemon's path of the
    folder; the unseen one leaves the pane's folder), with no environment stand-in; a new one: an agent discovery
    reports has neither a `hermesHome` nor a `hermesHomeDerived` property. The other cases go.
    `bind.spec.ts`: "a sandboxed Hermes with no home on its row is followed, not held" (`follow` is called with
    `sandboxed: true` and `setIdentityHold` is not); no `register` input has `hermesHomeDerived` (`:895`, `:904-910`).
    `hermesTerminal.spec.ts`: the record is read in the row's home, else the default (`stamp` and `read` get
    `deps.defaultHome` for a row with none).
    `discovery.spec.ts`: an observed Hermes fills no home (`setHermesHome` is not called; `:159-170` goes).
    `registry.hermesHome.spec.ts`: "keeps the mark with the home through a save, a load and a rebind" stays;
    "takes the mark with a home a bind brings" and "marks again a row an older daemon saved over" go.
    No case of the mark's two (outside a sandbox, in one) is written on this branch: discovery has no home to mark.
- [ ] **Step 2: Red.** `npx vitest run src/engines/identities.hermes.spec.ts src/core/agents/discovery.spec.ts`, and on
  Branch A `src/lib/terminalAgentDiscovery.hermesHome.spec.ts src/lib/registry.hermesHome.spec.ts`, on Branch B
  `src/core/agents/bind.spec.ts src/core/agents/hermesTerminal.spec.ts`. On Branch A the red output shows both of
  the mark's cases failing: the home found outside a sandbox, and the one found in a sandbox.
- [ ] **Step 3: Implement** the branch's removals and signatures, and the lines of `architecture.coreFiles.txt`.
- [ ] **Step 4: Green.** `npx vitest run src/engines/identities.hermes.spec.ts src/engines/otherAdmission.golden.spec.ts src/lib/terminalAgentDiscovery src/lib/registry.hermesHome.spec.ts src/lib/registry.spec.ts src/lib/nativeLocations.control.spec.ts src/hookServer.hermes.spec.ts src/core/agents src/architecture.spec.ts && npx tsc --noEmit`;
  `discovery.ts`, and on Branch B `bind.ts` and `hermesTerminal.ts`, at 100 in every column.
- [ ] **Step 5: Commit.** Red: `CLI: specs for a Hermes home no environment names (red)`. Code, Branch A:
  `CLI: a Hermes's home is its row's, or the folder of the store its process holds open`. Branch B:
  `CLI: a Hermes's home is its row's or the daemon's, never read from its process`.

---

### Task 12: The architecture test, and `lib/processEnv.ts` goes

**Depends on:** Tasks 1, 6, 8, 9, 10 and 11 (its last importers). **Effort:** xhigh.

**Files:**
- Create: `cli/src/architecture.environment.spec.ts`
- Delete: `cli/src/lib/processEnv.ts`, `cli/src/lib/processEnv.spec.ts`
- Modify: `cli/src/architecture.coreFiles.txt` (the `lib/processEnv.ts` line), `cli/src/lib/offThreadExec.spec.ts` (`:9`, `:134-143`, `:157`), `cli/src/lib/terminalAgentDiscovery.wrapperExec.spec.ts` (`:13`), `cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts` (`:15`)
- Modify: `cli/AGENTS.md` (Protect the core, rule 4), `cli/docker/remote-machine/Dockerfile` (`:49-52`)

**Interfaces:** In the new spec, one function and three cases:

```ts
/** Each read of another process's environment in [code], one line a finding. Read as code: a comment names nothing. */
function environmentReads(code: string, file = 'file.ts'): string[]
```

Parsed with `ts.createSourceFile` (`ScriptKind.JS` for `.mjs` and `.js`). A finding is:
- a string or template literal part with a path segment that is exactly `environ` (split on `/` and `\`): so
  `` `/proc/${pid}/environ` ``, `'/environ'` and `join(proc, String(pid), 'environ')`;
- an identifier or a string that matches `/KERN_PROCARGS2|procargs/i`;
- in a call whose argument is the string `ps` (or a path ending in `/ps`) followed by an array literal: an element
  of letters alone that holds `e` (`/^[A-Za-z]*e[A-Za-z]*$/`) and does not follow an element starting with `-`
  (`eww`, `axe`), or an element matching `/^-[A-Za-z]*E[A-Za-z]*$/` (macOS `-E`).

The scan reads every `.ts`, `.mjs` and `.js` under `cli/src` and `cli/hook`, but `*.spec.ts` and `*.test.ts`. These are
the spec's patterns and no more: an argument list built in a variable, and a shell line (`sh -c 'ps eww …'`), are
not reached, and the pull request says so.

- [ ] **Step 1: Write the spec, whole.**

  ```ts
  it.each([
    "readFile(`/proc/${pid}/environ`, 'utf8')",
    "readFileSync('/proc/' + pid + '/environ')",
    "open(join(proc, String(pid), 'environ'))",
    "execFile('ps', ['eww', '-p', String(pid), '-o', 'command='], done)",
    "run('/bin/ps', ['axe'])",
    "spawn('ps', ['-E', '-p', String(pid)])",
    "spawn('ps', ['-wwE'])",
    'sysctl([CTL_KERN, KERN_PROCARGS2, pid])',
    "const name = 'kern.procargs2'",
  ])('finds %s', (code) => expect(environmentReads(code)).not.toEqual([]))

  it.each([
    '// reads /proc/<pid>/environ, as ps eww does',
    "run('ps', ['-e', '-o', 'pid=,args='])",
    "run('ps', ['-ww', '-p', String(pid), '-o', 'ppid=,state=,comm=,lstart=,args='])",
    "run('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='])",
    "run('ps', ['-o', 'etime', '-p', String(pid)])",
    "podman.run(['ps', '--filter', 'label=x', '--format', 'json'])",
    "function home(environ: { HOME?: string }) { return environ.HOME }",
    "const text = 'the environment of this process'",
    "const own = /os\\.environ\\.pop/.test(code)",
    "readFileSync(`/proc/${pid}/${field}`, 'utf8')",
    "readlink(join(proc, String(pid), 'fd', name))",
    "run('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'])",
  ])('passes %s', (code) => expect(environmentReads(code)).toEqual([]))

  it('no file of the daemon or its hook reads another process\'s environment', () => {
    expect(found, 'The daemon never reads another process\'s environment (cli/AGENTS.md, Protect the core): an API token, a '
      + 'pairing code and every other secret is in one, and no system can read a single variable of it. A hook reads its own and '
      + 'says what it derives (hook/notify.mjs HOST_HINTS, ownGateway); a launch is on the registry\'s row.').toEqual([])
  })
  ```

  `found` is `<file>: <finding>` for each file of the scan.
- [ ] **Step 2: Red.** `npx vitest run src/architecture.environment.spec.ts`: the twenty-one planted cases pass, and
  the last fails with exactly two lines, both `lib/processEnv.ts` (the `/proc/${pid}/environ` template and the
  `eww` list). Any other line is a read a task above missed: stop and report it.
- [ ] **Step 3: The file goes.** Delete `processEnv.ts`, its spec and its coreFiles line. `offThreadExec.spec.ts`:
  the case "reads a process environment through the worker", the import, `clearProcessEnvCache()` and the darwin
  line of the last case go. The two `wrapperExec` specs lose their mock of `./processEnv.js`.
  `cli/AGENTS.md`, at the end of rule 4: "No process of the daemon, and no hook, reads another process's
  environment, by any means (`/proc/<pid>/environ`, `ps e`, `KERN_PROCARGS2`): a hook reads its own and says only
  what it derives (`src/architecture.environment.spec.ts`)." The Dockerfile's `procps` comment: `ps` is how the
  daemon reads the process table (`lib/processTable.ts`), and how a person checks the box by hand.
- [ ] **Step 4: Green.**

  ```bash
  npx vitest run src/architecture.environment.spec.ts src/architecture.spec.ts src/lib/offThreadExec.spec.ts src/lib/terminalAgentDiscovery src/lib/terminalAgentReconciler.wrapperExec.spec.ts
  npx tsc --noEmit
  git grep -n -E "processEnv\.js|readProcessEnv|clearProcessEnvCache|parsePsEnviron|parseEnviron" -- cli/src cli/hook   # nothing
  ```
- [ ] **Step 5: Commit.** Red: `CLI: a test that fails on a read of another process's environment (red)`. Code:
  `CLI: the daemon reads no other process's environment`.

---

### Task 13: The end-to-end suite follows

**Depends on:** Task 0 (which branch each engine's cases take), Tasks 4 and 12 (and through 12, Tasks 6 to 11).
**Effort:** high. **Test first:** none: no behavior (end-to-end cases; each behavior has its red spec in Tasks 3 to
12 and 14).

**Files:** Modify `cli/e2e/enginehomes.e2e.ts`, `cli/e2e/engineModelControl.e2e.ts`, `cli/e2e/modelSwitch.e2e.ts`,
`cli/e2e/serviceProcesses.e2e.ts`, `cli/e2e/hermesTerminalRecord.e2e.ts`, `cli/e2e/harness/fakeHermes.mjs` (its
header's last paragraph). Delete `cli/e2e/harness/hiddenProcessEnv.mjs`.

- [ ] **Step 1: `enginehomes.e2e.ts`.** The three `d.env.NODE_OPTIONS = …hiddenProcessEnv.mjs` lines (`:118`, `:174`,
  `:219`) and the preload file go: nothing reads what it hid. The case at `:172` is named "a moved shared Codex
  server supplies %s"; the comment at `:264` says "a legacy row with no home". One new case, after the typed-engine
  cases (`:452-482`), with their `type()`: "a Codex typed in with a `CODEX_HOME` of its own binds from its hook and
  keeps that home": an agent created with `codexHome: profile` puts Harness's hooks in the profile and is deleted;
  `CODEX_HOME=<profile> codex` is typed into a terminal tile; the tile binds, its row's `codexHome` is the profile and
  `conversationIn('codex', profile)` is its session.
  **Codex held (Branch A),** one more: "a Codex typed in under a `CODEX_HOME` with no hook in it binds from the
  rollout it holds open": the daemon runs with `HOOK_INSTALL_ENGINES: 'claude'`, the profile is a new folder that no
  shell profile names, `CODEX_HOME=<profile> codex` is typed into a terminal tile; the tile binds to
  `conversationIn('codex', profile)`, its row's `codexHome` is the profile, and the log has no `[hooks]` line for
  that session. **Codex lost (Branch B):** no such case.
- [ ] **Step 2: `engineModelControl.e2e.ts`.** One new case: "a Claude Code typed in with an OpenRouter endpoint is
  display-only from its first hook". `ANTHROPIC_BASE_URL=https://openrouter.ai/api claude` typed into a terminal tile:
  once bound, `models_list { agentId }` holds no `runtime-v1:<id>:claude:` entry. A plain `claude` typed into a second
  tile lists its own.
- [ ] **Step 3: `modelSwitch.e2e.ts`.** After each `agent_retarget` the row is read: on the grid its `grid` matches
  `{ baseUrl: GRID.baseUrl, model: GRID.model }`, and after `clearGrid` it is null.
- [ ] **Step 4: `serviceProcesses.e2e.ts`,** "models killed during discovery…" (`:461-512`): `knownAssignment` is
  `{ baseUrl: grid.baseUrl, model: grid.model }` (the launch record), and the wait "to reflect its real endpoint"
  goes. After models returns the Codex started by hand learns its grid from argv as before; the Claude Code started
  with `ANTHROPIC_BASE_URL` keeps `grid ?? null` null, and the case's name says "a Codex's argv" where it said "new
  marked processes".
- [ ] **Step 5: `hermesTerminalRecord.e2e.ts`.** On both branches the last case (`:336-351`, the fake's `'unseen'`:
  only its home is on the sandbox's own filesystem) becomes "leaves alone a Hermes whose home it cannot know, and its
  pane working" (decision 9): once its row is `active`, it has no `identityHold` and no `sessionId`, the log has no
  `binding held`, and the pane shows `fake-hermes-ready`.
  **Hermes held (Branch A):** the sandbox cases "binds and follows…" (`:291-313`) and "binds a Hermes whose home,
  folder and /dev/pts are remapped" (`:315-334`) stay as they are written: the home, its mark and the restart that
  does not name it now come from the store the fake holds open in its sandbox.
  "follows a Hermes that only has a HOME of its own, and starts it again without naming that home" (`:251-284`) is
  in no sandbox, so its home is no longer marked (PM, 2026-11-15). It becomes "follows a Hermes that only has a HOME
  of its own, and starts it again in that home": the wait is for the saved row's `hermesHome` to be `own`, and the
  saved row has no `hermesHomeDerived`; at each restart (through the client, and again after the daemon's own
  restart) `again.given` is `own`, the row binds to `again.session`, and the saved row still has no mark. This is
  the end-to-end form of `HERMES_HOME=/x hermes` typed by hand: the fake's home is found from its store alone, and
  the restart hands it back as `HERMES_HOME`.
  **Hermes lost (Branch B):** those three go. One sandbox case takes their place, in the daemon's own home:
  `r.d.env.HERMES_HOME` is `<folder>/.hermes` before the daemon starts and the fake runs with
  `{ home: folder, sandbox: 'same' }` (the fake drops `HERMES_HOME` and keeps `<HOME>/.hermes`, so its home is the
  daemon's default); it is bound and followed through `/new` from the record there, the row has no `hermesHome`, and
  the log has `hermes runs in a sandbox · followed from its terminal record` once.
- [ ] **Step 6: `fakeHermes.mjs`.** The header's last paragraph ("It keeps its own argv: … the daemon reads a
  Hermes's home from it") is no longer true. Branch A: it says the fake keeps its store open for its whole run, as
  Hermes does, and that the daemon finds its home from that. Branch B: the paragraph goes.
- [ ] **Step 7: Run what changed once, on this Mac,** one file at a time, as Verification's check 2 runs a file:
  `enginehomes`, `engineModelControl` and `modelSwitch` whole; `serviceProcesses` with
  `-t "models killed during discovery"`; `hermesTerminalRecord` whole (its sandbox cases are skipped off Linux and
  run in check 5). Then `git grep -n hiddenProcessEnv -- cli` prints nothing.
- [ ] **Step 8: Commit.** `CLI e2e: the facts a process's environment gave come from hooks, launches and held files`.

---

### Task 14: The paths of the files a process holds open

**Depends on:** Task 0. Not done when both engines are lost: nothing would call it. **Effort:** xhigh.

**Whose descriptors (decision 8; PM, 2026-11-15).** One listing reads the descriptor paths of at most two processes:
the selected one, and exactly one direct child of it that is the same engine's binary, which makes the selected one
that engine's launcher (npm's `node …/@openai/codex/bin/codex.js` and the native `codex` under it). Never more than
one level down, never a second child, never any other process: not a shell, a tool, an MCP server, a parent or a
sibling, whatever it holds open. `heldHome` has no other way to be given a process, and `engineChild` no other way
to name one.

**Files:**
- Create: `cli/src/lib/processHeldFiles.ts`
- Modify: `cli/src/lib/processTable.ts` (beside `hermesGatewaysUnder` `:186-199`)
- Test (new): `cli/src/lib/processHeldFiles.spec.ts`, `cli/src/lib/processTable.engineChild.spec.ts`

Not in this task: the line of `architecture.coreFiles.txt`. The test fails on a listed file the core does not load,
so the line goes in with the first import (Task 9 on its Branch A, else Task 11 on its Branch A).

**Interfaces:** Produces:

```ts
// lib/processHeldFiles.ts
/** How long a process that held no such file is left alone: 5 s after the first listing, then twice as long each
 *  time, up to a minute. An engine opens its store at its start or its first prompt, and one listing a minute is what
 *  reading its environment cost (lib/processEnv.ts, deleted 2026-11). */
export const HELD_RETRY_MS = { first: 5_000, most: 60_000 } as const

/**
 * The folder a file `selected` holds open says it works in, at the daemon's path of it: the first group of `file`,
 * tried against the whole path of each open descriptor of `selected` and of the one process `child()` names (a
 * launcher's one direct child that is the same engine's binary; no other process is ever listed). Undefined when no
 * path matches, when two name different folders, when a process cannot be listed (Windows, another account's process, one
 * that is gone) or when a sandbox's folder has no path in the daemon's view. Only paths are read (`readlink` of
 * `/proc/<pid>/fd/<n>`, the `n` lines of `lsof -Fn`), never a file through its descriptor, and a path that does not
 * match is dropped here: the daemon does not read another process's environment, and reads no more of its files than
 * where two of them are (cli/AGENTS.md, Protect the core).
 */
export async function heldHome(
  selected: ProcessIdentity,
  file: RegExp,
  child: () => ProcessIdentity | undefined = () => undefined,
  options: { platform?: NodeJS.Platform; proc?: string; now?: () => number } = {},
): Promise<string | undefined>
export function clearHeldHomes(): void
/** The paths in `lsof -Fn` output: each `n` line that starts with `/`. Null when the output is cut (no last newline) or has over 4,096 lines. */
export function lsofPaths(output: string): string[] | null

// lib/processTable.ts
/**
 * The one process right under `selected` that is `engine`'s too: npm's Node launcher starts Codex's native binary
 * there, and that child holds the rollout (engines/codex/sessionStore.ts). Undefined with none, and with more than
 * one. A direct child only: a process further down is never named, whatever it is.
 */
export function engineChild(rows: readonly ProcessRow[], engine: AgentEngine, selected: ProcessIdentity, ownership: AgentCommandOwnershipSnapshot): ProcessIdentity | undefined
```

Rules, all of them:
- Listing one process. Linux: the names in `<proc>/<pid>/fd` (over 4,096 is "cannot list"), `readlink` of each (one
  gone between the two reads is skipped), then `processView(identity, platform, proc)`: `same` leaves a folder as
  read, `sandbox` puts it through `toHost` (null: that descriptor says nothing), `unreadable` is "cannot list".
  macOS: `probeExecFile(execFile)('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'], { timeout: 2_000, maxBuffer: 1 << 20, env: psEnv(process.env) }, …)`;
  an error, or `lsofPaths` null, is "cannot list". Any other platform: "cannot list", with no spawn.
- A folder from a path: `file.exec(path)?.[1]`. `file` has no `g` or `y` flag. On macOS each path has the spellings
  `descriptorPaths` gives (`engines/kit/nativeDescriptors.ts`); with two that match, the one whose whole path exists
  (`lstat`) is taken, and with both or neither that descriptor says nothing.
- The answer: `selected` is listed, and the process `child()` names when it names one; `child` is called once for
  a listing, and nothing it does not return is listed: one listing reads one process or two. One that cannot be
  listed: no answer. The distinct folders of both: exactly one is the answer.
- What is kept, by `selected`'s `pid`, `startMarker` and `executable` and `file.source`: an answer, for as long as the
  module lives (a process keeps its home), and for no answer the time it was asked and the wait before the next
  listing: `HELD_RETRY_MS.first`, then doubled each time, never over `HELD_RETRY_MS.most` (listings at 0, 5, 15, 35,
  75 and 135 s, then each minute). At most 256 keys; the 257th drops them all (`processMounts.ts`'s rule). `child` is
  called only when a listing is made.
- `engineChild`: rows whose `parentPid` is `selected.pid` and whose `engineProcessMatchScore(row, engine, ownership)`
  is above 0; exactly one is the answer, as `processIdentityOf` gives it. It looks one level down and no further:
  `parentPid` alone, never `processTreePids`. A child that is another engine's, a shell or a tool scores 0 and is
  never named. `ownership` is never defaulted here: the default walks PATH (#3880).

- [ ] **Step 1: Write the failing tests.** `processHeldFiles.spec.ts` mocks `./processMounts.js` (`processView`
  answers `{ state: 'same' }` unless a case says otherwise) and `node:child_process`, builds a `/proc` of its own
  under a temporary folder as `processMounts.spec.ts` does (`<proc>/4242/fd/<n>` are symbolic links), and gives each
  case its own `now`:

  ```ts
  const STORE = /^(.+)\/state\.db$/, ROLLOUT = /^(.+)\/sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/
  it('names the folder of the one file that matches, on Linux, from the links alone', …)
  //   0 → /dev/pts/3, 3 → /h/.hermes/state.db, 4 → /h/.hermes/state.db-wal, 5 → '/h/old/state.db (deleted)', 6 → socket:[1]
  //   heldHome(id, STORE, undefined, { platform: 'linux', proc }) === '/h/.hermes'. Nothing exists at /h: no file is opened.
  it('answers nothing for two folders, and the folder for one file open twice', …)
  it('asks again of a process that held nothing 5 s later, and never again of one that answered', …)
  //   No match: undefined. The link added; now + 4_999: undefined. now + 5_000: '/h/.hermes'.
  //   The link removed; now + a day: '/h/.hermes'.
  it('gives a sandbox\'s folder at the daemon\'s path, and nothing for one with no path here or a namespace it cannot read', …)
  //   processView → { state: 'sandbox', cwd: '/work', toHost: (p) => p === '/tmp/home/.hermes' ? '/data/agents/a1/.hermes' : null }
  //   3 → /tmp/home/.hermes/state.db: '/data/agents/a1/.hermes'. 3 → /tmp/agent/.hermes/state.db: undefined.
  //   processView → { state: 'unreadable' }: undefined.
  it('lists a process on macOS with lsof -Fn, less and less often until it answers, and never after', …)
  //   execFile answers 'p4242\nfcwd\nn/work\nf3\nn/h/.hermes/state.db\nf4\nn/h/.hermes/state.db-wal\n':
  //   '/h/.hermes'; execFile got ('lsof', ['-n', '-P', '-w', '-p', '4242', '-Fn'], …) and, after three more calls a
  //   day apart, was called once. Another process that answers 'p4243\nfcwd\nn/work\n', asked every second for
  //   200 s of `now`: execFile ran at 0, 5, 15, 35, 75, 135 and 195 s, seven times.
  it('answers nothing when lsof fails or its output is cut', …)   // an error; 'p4242\nf3\nn/h/.hermes/state.db'
  it('takes the spelling that exists when lsof escapes a name', …)
  //   <tmp>/nhà/.hermes/state.db exists; lsof prints 'n<tmp>/nh\\xc3\\xa0/.hermes/state.db': '<tmp>/nhà/.hermes'.
  it('lists nothing on Windows', …)   // undefined, execFile not called
  it('reads the engine\'s one child too, and answers nothing when the two disagree or one cannot be listed', …)
  //   The launcher 4242 holds none, 4243 holds /c/sessions/2026/11/15/rollout-a.jsonl: heldHome(4242, ROLLOUT, () => 4243) === '/c'.
  //   4242 also holds /other/sessions/rollout-b.jsonl: undefined. 4243 has no fd folder: undefined.
  //   While '/c' is kept, child is not called again.
  it('lists the selected process and the one child it is given, and no other process', …)
  //   macOS: lsof for 4242 answers no rollout, for 4243 '/c/sessions/rollout-a.jsonl'. heldHome(4242, ROLLOUT, () => 4243)
  //   === '/c'; execFile ran twice, its '-p' values '4242' and '4243', and child was called once.
  //   Linux: <proc>/4244/fd (a process under 4243) holds /d/sessions/rollout-z.jsonl, and so does <proc>/4245/fd
  //   (a shell beside 4243): heldHome(4242, ROLLOUT, () => 4243) === '/c', and with no child, undefined.
  it('refuses a process with more than 4,096 descriptors, and keeps at most 256 processes', …)
  it('lsofPaths keeps the n lines that are paths', …)
  //   'p1\nf3\nn/a/b\nf4\nnpipe\nf5\nn/c d\n' → ['/a/b', '/c d']; no last newline → null; 4,097 lines → null.
  ```

  `processTable.engineChild.spec.ts`, with rows and an ownership snapshot built as
  `processTable.hermesGateway.spec.ts` builds its own: a Node launcher of Codex with its native child and a shell
  under it gives the native child; two native children, none, and one a level further down (the native binary under
  that shell) give `undefined`; a Claude Code under a Codex launcher gives `undefined`; and a Hermes with its shared
  gateway under it gives `undefined` for `'hermes'`.
- [ ] **Step 2: Red.** `npx vitest run src/lib/processHeldFiles.spec.ts src/lib/processTable.engineChild.spec.ts`:
  neither module export exists.
- [ ] **Step 3: Implement** the interfaces and rules above. The file's header says what is read and what never is,
  with decision 8's date.
- [ ] **Step 4: Green.** `npx vitest run src/lib/processHeldFiles.spec.ts src/lib/processTable.engineChild.spec.ts src/lib/processTable.hermesGateway.spec.ts src/lib/processMounts.spec.ts && npx tsc --noEmit`.
  `src/architecture.spec.ts` is not run here: no file of the core imports the new one yet.
- [ ] **Step 5: Commit.** Red: `CLI: specs for the paths of the files a process holds open (red)`. Code:
  `CLI: where an engine's store is, from the path of the file its process holds open`.


## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): specs run under
the suite's throwaway home, data and runtime folders (`vitest.setup.ts`); each end-to-end file boots its own daemon
under a throwaway root (`e2e/harness/daemon.ts` `IsolatedDaemon`), with a private tmux server, ports of its own and
fake engines that run the real `notify.mjs`, signed out. No sign-in, no account, no backend, no production, nothing of
the developer's daemon (port 18473), `~/.harness`, real engines, a real `ori` or a real grid: both of those need an
account, and the fake engines run the real hook with the same variables and hold their store files open as Task 0
showed the real ones do. None of these checks needs Diego himself.

Local, on this Mac, in `cli/`:

1. **The specs and the leftovers.**

   ```bash
   npm run typecheck
   npx vitest run src/architecture.spec.ts src/architecture.environment.spec.ts src/hookNotify.spec.ts src/hookServer.spec.ts \
     src/hookServer.hermes.spec.ts src/hookAdmission.golden.spec.ts src/lib/registry.spec.ts src/lib/registry.hermesHome.spec.ts \
     src/lib/registryAdmission.golden.spec.ts src/lib/gatewayRuntime.spec.ts src/lib/openrouter.spec.ts src/lib/processMounts.spec.ts \
     src/lib/processHeldFiles.spec.ts src/lib/processTable.engineChild.spec.ts \
     src/lib/gridAssignment.spec.ts src/lib/gridAssignmentWire.spec.ts src/lib/gridAssignmentShapes.golden.spec.ts src/lib/apiModels.spec.ts \
     src/lib/terminalAgentDiscovery src/lib/terminalAgentReconciler.wrapperExec.spec.ts src/lib/offThreadExec.spec.ts \
     src/engines/pluginPosts.spec.ts src/engines/otherHooks.golden.spec.ts src/engines/nativeVersion.golden.spec.ts \
     src/engines/discovery.golden.spec.ts src/engines/discoveries.spec.ts src/engines/otherAdmission.golden.spec.ts \
     src/engines/identities.hermes.spec.ts src/engines/kit/processFacts.spec.ts src/engines/opencodeLaunch.golden.spec.ts \
     src/dsh src/core/agents src/core/modelsLink.spec.ts src/services/models.spec.ts src/services/modelsProcess.spec.ts
   git grep -n -E "processEnv\.js|readProcessEnv|probeGatewayRuntime|probeGridAssignment|profileHomeFromEnv|probeDsh|probeHermesHomeDerived|homeFromEnvironment|hiddenProcessEnv" -- cli/src cli/hook cli/e2e
   ```

   A spec file a lost engine's branch did not make (`processHeldFiles`, `processTable.engineChild`, `discoveries`) is
   left out of the list. To see: every file passes, none of the new cases skipped; the `git grep` prints nothing.

2. **macOS, end to end** (the workflow below runs these on Linux only, and macOS is where `ps eww` ran and where
   `lsof` now runs). One file at a time, with a short TMPDIR of the run's own (an agent's TMPDIR on this Mac is too
   long for the daemon's socket):

   ```bash
   export TMPDIR=/private/tmp/claude-503/pes-v/ && mkdir -p "$TMPDIR"
   for file in enginehomes engineModelControl modelSwitch hermesTerminalRecord; do
     caffeinate -i npx vitest run --config vitest.e2e.config.ts "e2e/$file.e2e.ts"
   done
   ```

   To see: each file passes. In `engineModelControl`, the Claude Code typed in with the OpenRouter endpoint lists no
   model of its own and the plain one does; in `enginehomes`, the typed Codex's row has its own home, from its hook
   and (Codex held) from its rollout with no hook; in `modelSwitch`, the row's grid after each move; in
   `hermesTerminalRecord` (Hermes held), the Hermes with a `HOME` of its own, in no sandbox, is bound, its saved row
   has the home and no mark, and its restart is handed that home as `HERMES_HOME` and resumes there (a
   `HERMES_HOME=/x hermes` typed by hand, restarted from Harness). `serviceProcesses` changes nothing that differs on macOS, and
   runs whole in check 5.

3. **The checks PR CI does not run,** from a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `cli-core` and `cli-portability` passed, 100% in every file each holds; the receipts go in the pull
   request's body.

On GitHub:

4. **Linux, by PR CI, not started by hand:** `cli-typecheck`, `cli-tests` (four shards), and the `companions` and
   `pty-checks` a `cli/` change selects. To see: `ci/required` green.
5. **The end-to-end suite on Linux, by hand, once, on the orchestrator's go:**

   ```bash
   gh workflow run cli-e2e.yml --ref fix/process-env-secrets
   ```

   Why: five end-to-end files change, PR CI runs none, the reader's Linux half (`/proc/<pid>/fd`) runs only there,
   and `hermesTerminalRecord`'s sandbox cases run only where `unshare` works. To see: `e2e (1)` to `e2e (8)`,
   `e2e (macOS, full disk)` and `e2e-summary` green; in the shard that runs `hermesTerminalRecord`, the sandbox cases
   ran (Hermes held: a sandboxed Hermes's saved row has its home and the mark, and its restart is not handed that
   home) or are reported skipped (then Task 0's sandbox row is the evidence for a sandbox's path, and the mark in a
   sandbox rests on Task 11's specs alone, which the pull request says). A red test is
   reported with its link and whether main's last nightly run has it too.
6. **Windows, by hand, once, after check 5, on the orchestrator's go:**

   ```bash
   gh workflow run windows.yml --ref fix/process-env-secrets
   ```

   Why: the hook runs on Windows too, and Hermes keeps its hook there. To see: both `windows-pty` jobs green; in the
   step "Contract suite against the real host, and the Windows CLI specs", `src/lib/windows` with no failure, where
   `daemonPipeClients.windows.real.spec.ts` runs the real `notify.mjs` over the pipe and hears the header
   `x-harness-hook-gateway: none`. Report the run's link.

**Temporary workflow:** one, `.github/workflows/tmp-process-env-secrets.yml` (Task 0: the spike, one macOS job and
one Linux job of at most 20 minutes each, `permissions: contents: read`, no secret, no account, no cache and no
artifact, run once from the main session's one push). It is removed before the pull request, and on the final head

```bash
git diff origin/main...HEAD -- .github/workflows/
```

shows no `tmp-` file (it prints nothing: this work changes no other workflow). Every other long check has a workflow already (`cli-e2e.yml`, `windows.yml`), and the local
ones need this Mac's own process table. **Nothing here runs against production.**
