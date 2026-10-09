# Daemon separation: handoff, 2026-10-08

This note hands the daemon-separation work from Claude Code to the next session (Codex). It covers
what merged, what is left, the decisions already made, and how the work is done here. No PR from this
work is open. Nothing was released.

## The bar

- **Architecture is the goal, not lines of code.** The owner wants it "safe, reliable, dependable".
  The core's closure size (`cli/src/architecture.spec.ts` logs it) is a reference only. Never trade
  safety for a smaller number.
- **Session control never depends on a worker or on code loaded later.** That covers stop, binding,
  hook admission, turn closing, launch, discovery and resume. Each is declared data in
  `engines/*/contract.ts` that the core applies with `engines/kit`.
- **Readiness never waits on a service.** An unavailable service holds what needs it, with the reason
  shown. It never fails it, archives it or writes half of it.
- **Small stable core, experimental services around it.** Each service can be built on or killed at
  any time.

## The order the owner set, and where it stands

| # | Work | State |
|---|---|---|
| 1 | Land #1040 (question navigation) | Merged |
| 2 | Claude Code / Codex leftovers: submission, hook admission and installers, launch, discovery, resume, native control | Merged: #1041, #1043, #1045, #1046, #1049, #1051, #1057, #1063 |
| 3 | The other 12 engines out of the core's closure (lazy load) | Merged: o1–o6 (#1053, #1055, #1056, #1059, #1065, #1066). Section-4 leftovers below |
| 4 | Launch-time features behind one launch port: Grid, saved APIs, DSH | L1 merged (#1068, with held launches). L2 and L3 not started (decisions below) |
| 5 | External sessions → the search process; usage stats → the usage service | Not started |
| 6 | Delete the legacy `runtimeProfileManager` | Not started. Unblocked now that 3 is merged |

The plans are in `docs/design/2026-10-08-other-engines-out-of-core.md` and
`docs/design/2026-10-08-launch-port.md`, plus the
`2026-10-08-engine-*.md` facet docs.

## Merged today

- **Claude Code and Codex:**
  - question navigation (#1040);
  - submission readings (#1041);
  - Codex's shared app-server (#1043);
  - hooks (#1045);
  - launch specifics and preparation (#1046, #1049);
  - discovery (#1051);
  - session stores (#1057);
  - adoption, activity and paging (#1063).
- **Other engines:**
  - screens (#1053), hook installers (#1055), transcripts (#1056), runtime profiles (#1059);
  - identity, homes and launch data (#1065). An OpenCode fork or relaunch now refuses before writing
    anything.
  - session-search adoption readers (#1066). The core's static closure no longer reaches any other
    engine's code, and both `CORE_MAY_REACH` lists are empty.
- **The launch port, L1 (#1068):** grid and saved-API launches are built by the models service, and
  launches that need a service are held until it is ready.
- **Fixes:**
  - **#1064:** a turn written right after a transcript rewrite reaches clients again. This is a
    regression from #1019, **shipped in 0.3.67**; whether to release the fix is the owner's call.
  - **#1062:** the registry save is linear.
  - **#1058:** the resume-native script no longer writes the real `~/.zsh_history`.
  - **#1060:** the migration e2e.
- **CI and goldens:**
  - the Go toolchain pin (#1048);
  - goldens made independent of the host, with fixes in #1046, #1051 and #1057.

## The last two PRs, both merged

### #1066: o5 (merged), other engines' session-search readers load lazily

- **What it does:**
  - Each other engine's adoption reader loads on its first scan, owners or busy call, and is then
    built once and kept.
  - Without an engine's code, that engine lists nothing, owns nothing, and its busy is `null`, which
    `OpenSessions.busy` treats as busy.
  - A failing build is logged once.
  - Both `CORE_MAY_REACH` lists are empty.
- **Golden:** `otherAdoption` was recorded first, and the independent review found no blocking
  issues.
- **Merged** as 989872077, with unit and e2e receipts and the review in the PR body.

### #1068: launch port L1 (merged), grid and saved-API launches built by the models service

- **What it does:**
  - The core asks `ModelsPort.gridLaunch` and `ModelsPort.apiTarget`, and keeps only
    `lib/gridLaunchWire.ts`, the declared lists.
  - A launch on the engine's own login never asks models.
  - The 162-case launch golden was recorded first.
- **The review found two reliability regressions, fixed on the PR (217691833, 3c98bcb72):**
  - **(a) Readiness never waits on models.** Own-login agents restore during boot. Grid and saved-API
    agents restore in a second pass after ready, outside any registry transaction.
  - **(b) An unavailable models holds an agent; it never fails it.** The agent stays stopped with the
    reason. It is never marked `launch: failed`, never skipped next boot, and never archived. It is
    restored once models is ready, unless the user stopped or closed it. One mechanism, generic, so
    L3 reuses it for the Store.
  - **(c) One deadline per restore pass.** After the first unavailable answer, the rest of the pass
    is held.
- **Smaller fixes:**
  - a DSH+grid create asks models before writing anything;
  - a spec for the socket's saved-API selection;
  - `GRID_CONFLICTING_ENV_VARS` is pinned to the contracts.

- **How "held" works** (`core/agents/heldLaunches.ts`, `lib/restoreAgents.ts`):
  - A held agent gets a pane of its own that shows what it waits for, and its row's launch is
    `{ state: 'held', service, detail }`.
  - The registry refuses rows without a pane, and an older release reads the same file after a
    rollback, so a held agent always has a live pane.
  - Passes run one at a time: at ready, each time the service connects, and on a person's restart.
- **Test-only hook:** `HARNESSD_TEST_HOLD_CONNECT=<service>:<file>` in `services/process.ts` holds a
  service off the core for the e2e.
- **Receipt** on 3c98bcb72 (worktree `eng-launch-port`):
  - test:core 1,631 at 100%;
  - the goldens under `TZ=UTC TMPDIR=/tmp`;
  - the whole unit suite, 12,038;
  - e2e: 107 tests in 14 files.

- **Merged** as 0c2ec6a06. Linux CI first failed on the launch-shapes golden, which quoted the
  Mac's tmux path; the golden now uses a placeholder for it (9915bd50a).

## What is left, with the decisions made

### L3: DSH runtime behind the launch port

- **Golden:** the DSH launch-shapes golden is recorded from the former code, on branch
  `claude-recovery/launch-port-dsh` (commit `a5b169d80`, 61 cases). It is pushed, with no PR.
  **Rebase it on #1068 and re-record it before L3's move,** because #1068 changed create's order and
  restore's deferral. The plan doc says how.
- **An uncommitted draft of L3's move** (a store port, `dshThrough`, store waits) was left in the
  previous session's scratch worktree and is on no branch. `docs/design/2026-10-08-launch-port.md`
  has its design in full; start from the doc.
- **Decision on restore:** a restore waits up to 30 s for the Store when Harness agents are due.
  An agent the Store cannot prepare is **never launched unprepared**. It stays stopped with the
  reason, using #1068's hold mechanism, and is restored once the Store is ready. Pin that with a spec,
  plus an e2e with the Store killed.

### L2: grid assignment and saved APIs

- **No cache.** Recognition stays exactly as today. Ask models only for processes that carry what a
  grid launch writes. If models is down or slow, discovery and binding go ahead without waiting; the
  assignment shows as unknown, or keeps its last value, and is never cleared.
- **The saved-API instructions stay in the core,** which reads the saved list without keys, so a
  launch never depends on models for them.

### Item 5: search and usage out of the core

- **Search:** when search runs in the core's process (`services/search.ts`), its first discovery
  loads all eleven other engines' code. #1066 makes the static closure clean, but not the loaded set.
  Moving external sessions into the search process fixes that.
- **Usage:** usage stats in agent frames move to the usage service.
- Both follow the same rule as the rest: record the golden first, and the core never waits on either
  service.

### Item 6: delete the legacy `runtimeProfileManager`

Item 3 is merged (#1066), so this can start. Record a golden of what it answers first.

### Small follow-ups

- **Kilo and OpenCode share a code chunk:** `engines/kilo/inProcess.ts` re-exports OpenCode's
  externals, so one broken chunk takes out both. Either give Kilo's adoption reader its own entry, or
  load OpenCode's module for Kilo's store.
- **A cheaper interim for search:** until item 5, a declared "store exists" check could run before an
  engine's search reader loads. Owners must stay exact, because owners can claim a session from
  process arguments even when there is no store.
- **Per-engine code still in shared core files** (section 4 of
  `docs/design/2026-10-08-other-engines-out-of-core.md`):
  - Stop handling in `turnHooks.ts`;
  - Cursor's catalog and footer, and other engines' targets and catalogs, in
    `runtimeProfileManager.ts` (goes with item 6);
  - per-engine verify windows in `sessionInput.ts`.
- **Golden gaps:**
  - Hermes's id rule is pinned by the Hermes specs, not by a golden.
  - The admission golden has no "unreadable store" case.
  - `otherLaunch` covers only the `agent_create` wire. Create, fork and retarget argv rest on their
    specs and on the `launchArgv` golden.
- **Behaviour changes, named in the PRs:**
  - Launches of engines other than OpenCode no longer run `opencode --version`. None of them used
    the answer.
  - An OpenCode launch whose code can't load is refused with `ENGINE_UNAVAILABLE`.
- **A failing e2e case on main:** `e2e/machine.e2e.ts` "codex: the tmux server dies mid-turn" fails
  on main at 8b1417520: the resumed Codex replays `!slow 8000`. It is not from the launch port.
  Investigate it first: it is session control (resume after a tmux crash).
- **Two specs failed once under full-suite load and passed 3 of 3 alone:**
  `src/lib/e2ee/relayLink.spec.ts` ("invalidate() drops a pooled entry") and
  `src/backendSocket.gridReads.spec.ts`.
- **Pane drivers in `runtimeControl.ts`:** the six unreachable ones are left in place (owner
  decision).

## Left on branches and in the repo

- **`claude-recovery/launch-port-l3-wip`** (7078138bf), an unfinished draft of L3's move.
  - **It does not build,** and it is not for merging as is.
  - **Its base** is L1's pre-review head, before #1068's held launches, which L3 must reuse.
  - **Under it,** 699e252e8 is the L3 golden as first recorded. Re-record that from main before the move.
  - **The draft holds:** a Store port (`services/storeLaunch.ts`, `dsh/launchWire.ts`),
    `core/agents/dshThrough.ts`, and the Store waits at restore (`core/agents/storeWaits.ts`).
  - **Use it** as a reference, or start fresh from `docs/design/2026-10-08-launch-port.md`.
- **`claude-recovery/launch-port-dsh`** (a5b169d80): the same golden, recorded on main before #1068.
- **`cli/scripts/handoff-2026-10-08/`** holds this work's scripts:
  - the closure measure;
  - the importer finder;
  - the per-step mutation checks for the goldens;
  - the landing script;
  - the main-health watch.

  Its README says how to run each.
- **Not kept:** the validation receipts (`.harness/validation/`, git-ignored). Each PR body carries its
  receipt's results.

## How the work is done here

- **Golden first.**
  - Record a golden from the former code in its own commit, then make the move, and the golden must
    pass unchanged.
  - Deliberately broken wiring must fail it.
  - Goldens must not depend on the host: pin `process.platform`, run under `TZ=UTC TMPDIR=/tmp`, pin
    `process.env.TZ` where local time matters, keep no lengths or caps that depend on the temp root,
    and replace host binaries a script quotes (Node, tmux) with placeholders. CI runs on Linux, and
    #1068's golden first failed there on `/opt/homebrew/bin/tmux`.
- **The gates:** tsc; `architecture.spec.ts` (the ratchet: core must not statically reach engine
  code; only `engines/inProcess.ts` may `import()` it); `test:core` at 100% statements and branches;
  `test:harnessd`; the touched specs; and the e2e lanes the change touches. `make validate` writes a
  receipt under `.harness/validation/`.
- **An independent review of every PR** before it lands, written into the PR body.
- **Test isolation:**
  - Never touch the real daemon (port 18473), the real tmux server, or the real `~/.claude`,
    `~/.codex` or `~/.harness`.
  - Unset `TMUX` and `TMUX_PANE`, and make sure `TMUX_TMPDIR` exists.
  - Never type synthetic input through a client that can open the owner's real harnesses.

### How to land

- **Merge finished, green, reviewed work without asking.** Never release: `make release-cli` is the
  owner's.
- **Steps:**
  - Mark the PR ready.
  - Wait for every check on the head, `ci/required` included. Draft PRs get process-only CI, with
    `ci/required` blocked; a draft run's failed `ci/required` can sit beside the ready run's, so wait
    for all checks.
  - Then run `make merge-pr ARGS="<N> --reviewed-head <sha> --reviewed-base <origin/main sha> --merge"`.
  - If main moved past the head's base, merge main in, wait for CI again, and retry.
- **GitHub:** only as `deehw` (check `gh auth status`).
- **The public repo:** no personal paths, user names or emails.
- **Other repos:** never push to autonomous-circuit or autonomous-workshop.

## The core's closure, for reference

72,479 lines in 376 files this morning; 65,933 in 367 after #1065; about 59,500 in 342 after #1066;
#1068 moved out about another 900.
