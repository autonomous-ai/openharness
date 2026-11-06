# Shell guard for Swarm agents: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A Swarm agent's session (Claude Code and Codex) runs a pre-command hook that refuses, with a one-line reason each,
kill by name or pattern (pkill, killall, `kill $(pgrep …)`), sudo and system-wide installs, fixed names in /tmp, and
removing a worktree a live process uses (task #3596, inventory Table A #5, requested by Dee through Harness).

**Architecture:** The rules are one pure function over a command's words (`superTabs/shellGuard.ts`), with the machine's
facts (private folders, linked worktrees, live processes' working folders) as seams. A small hook entry
(`superTabs/shellGuardHook.ts`) reads the engine's `PreToolUse` JSON on stdin and prints a `deny` with the reason, or
nothing. Only Swarm sessions get it, through the existing `SwarmLaunch.args(engine)` seam (`lib/swarmEngineArgs.ts`):
Claude Code by `--settings '{"hooks":{"PreToolUse":…}}'`, Codex by `-c hooks.PreToolUse=[…]`. Codex runs a session
flag's hook only once its hash is recorded as trusted in the home's `config.toml` (measured with `codex app-server`
`hooks/list`, codex-cli 0.166.0: `/<session-flags>/config.toml:pre_tool_use:0:0`, `untrusted` until recorded, `trusted`
after; a `hooks.state` given by `-c` is ignored), so Harness's Codex hook installer records it beside its own hooks'
records, in every home it prepares.

**Tech Stack:** TypeScript CLI, vitest; Claude Code 2.1.318 and codex-cli 0.166.0 hook contracts.

**Spec:** task #3596's brief; the Swarm's rules "Stop only processes you started, by id", "Install nothing system-wide",
"Temporary files only in a mktemp -d folder", "Never remove a worktree a live process still uses".

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Swarm code stays out of `cli/src/core`; nothing in core changes.
- A person's own sessions get no guard: only `SwarmLaunch.args`, which runs for sessions with a Swarm role.
- Each refusal is one line starting `Harness shell guard:` saying why and what to do instead.
- Two security reviews before merge (a guard).
- Windows: no new process is started on Windows (lsof is not run there; Windows itself refuses to delete a folder a
  process works in). Claude's hook uses exec form there (`command` + `args`), Codex's a PowerShell line, as Harness's own.

## Design

- growth: N/A because nothing is stored but one trust record per Codex home, replaced in place when the hook's line changes.
- concurrency: the trust record is written inside the Codex hook installation's own reservation (`runHookPreparation`).
- read cost: the hook reads only the command; live processes are read only for a removal of a linked worktree.
- scale: one Node start per tool call (~40 ms); `lsof -d cwd` only on a worktree removal, 5 s timeout.
- compatibility: an engine without `PreToolUse` ignores the setting; a Codex without the trust record would ask, so the
  record is written before any Swarm Codex launch reads it (default home at the daemon's hook refresh, a profile at create).
- migration + rollback: none; reverting removes the args, and the trust record trusts only that exact line.
- audience, identity: N/A because nothing is exposed and nothing acts as a person.
- failure: a refusal says why; a hook that cannot start (a moved script) exits non-zero but not 2, which both engines
  treat as a non-blocking error, so a guard fault never stops an agent's work silently or wholly.
- platforms: Mac and Linux read live working folders (lsof, /proc); Windows refuses such removals by itself.

## Review Focus

- A heredoc body or a quoted message holding a refused word (`git commit -m "no sudo"`, `<<'EOF' … sudo … EOF`) must pass.
- `${TMPDIR:-/tmp}` in a `mktemp` template must pass; the same root without `mktemp` falls back to a fixed /tmp name on
  Linux and is not read (a variable is not expanded): recorded, not refused.
- `kill $(cat pidfile)` and `ps -p ID && kill ID` (a recorded id) must pass; `kill` fed by pgrep/pidof/lsof/ps aux refused.
- A path inside Claude Code's own `/private/tmp/claude-<uid>` (mode 700, this account's) passes; another uid's is refused.
- `rm -rf` of a worktree reached through `cd` earlier in the same line resolves against that folder.

---

### Task 1: The rules

**Files:**
- Create: `cli/src/superTabs/shellGuard.ts`
- Test: `cli/src/superTabs/shellGuard.spec.ts`

**Interfaces:**
- Produces: `shellRefusal(command: string, facts: GuardFacts): string | null`, `fileRefusal(path, facts)`,
  `GUARD_REASONS` (`killByName`, `systemWide`, `fixedTmp`, `liveWorktree(path, pid)`, `worktreeUnknown(path)`),
  `GuardFacts { cwd, platform, privateFolder, linkedWorktree, liveCwds, realpath? }`, `machineFacts(cwd)`,
  `privateFolderOf`, `linkedWorktreeOf`, `liveCwdsOf`.

- [ ] Write the failing spec: each refused pattern returns its reason, each ordinary command null (pkill/killall/
  `kill $(pgrep)`/`lsof -ti | xargs kill`/taskkill /IM/Stop-Process -Name; sudo/doas/su, `npm -g`, brew install,
  apt/dnf/port, `pip --break-system-packages`, winget/choco/msiexec, `with administrator privileges`, `-Verb RunAs`;
  `> /tmp/x`, `tee /private/tmp/x`, `-o /tmp/x`, `cd /tmp`, `sh /tmp/x.sh`; `git worktree remove` and `rm -rf` of a
  worktree a process works in, and `worktreeUnknown` when processes cannot be read).
- [ ] Run `npx vitest run src/superTabs/shellGuard.spec.ts`: fails (module missing).
- [ ] Implement the tokenizer (quotes, operators, `$(…)`, backticks, `<(…)`, `sh -c`, `eval`, heredocs, comments,
  wrappers `env`/`xargs`/`nohup`/`timeout`/…) and the four rules.
- [ ] Run the spec: passes. Commit test, then code.

### Task 2: The hook entry

**Files:**
- Create: `cli/src/superTabs/shellGuardHook.ts`
- Test: `cli/src/superTabs/shellGuardHook.spec.ts`

**Interfaces:**
- Consumes: `shellRefusal`, `fileRefusal`, `machineFacts`.
- Produces: `hookAnswer(stdin: string, factsFor?): string` (a `PreToolUse` deny line or ''), run as a script.

- [ ] Failing spec: Claude `Bash` `pkill -f node` → deny JSON with `GUARD_REASONS.killByName`; `Write` to `/tmp/x` →
  `fixedTmp`; Codex argv `["bash","-lc","sudo ls"]` → `systemWide`; `git status` → ''; not JSON → ''; `apply_patch` → ''.
- [ ] Implement; spec passes. Commit test, then code.

### Task 3: Swarm sessions run it

**Files:**
- Create: `cli/src/lib/agentShellGuard.ts`
- Modify: `cli/src/lib/swarmEngineArgs.ts`
- Test: `cli/src/lib/swarmEngineArgs.spec.ts`

**Interfaces:**
- Produces: `shellGuardHook(platform)` → the hook as each engine's runner takes it; `claudeShellGuardArgs(platform)` →
  `['--settings', json]`; `codexShellGuardArgs(platform)` → `['-c', 'hooks.PreToolUse=[…]']`;
  `CODEX_SHELL_GUARD` → `{ event: 'PreToolUse', matcher: '*', timeout: 30, command(platform) }`.

- [ ] Failing spec: `swarmEngineArgs('claude')` holds `--settings` whose JSON has one `PreToolUse` block, matcher
  `Bash|Write|Edit|MultiEdit|NotebookEdit`, running Node on `superTabs/shellGuardHook.js`; `swarmEngineArgs('codex')` keeps
  `check_for_update_on_startup=false` and adds the `-c hooks.PreToolUse` line; `swarmEngineArgs('gemini')` unchanged.
- [ ] Implement; run the spec plus `src/core/agents/create.spec.ts` and `src/lib/launchOverrides.spec.ts` (a person's own
  session gets none). Commit test, then code.

### Task 4: Codex trusts it

**Files:**
- Modify: `cli/src/engines/facets/hooks.ts` (`HookReviewRecord.sessionHooks`), `cli/src/engines/kit/hookReview.ts`
  (`reviewRecords`), `cli/src/engines/codex/hookContract.ts`
- Test: `cli/src/engines/kit/hookReview.spec.ts`

**Interfaces:**
- Consumes: `CODEX_SHELL_GUARD`.

- [ ] Failing spec: `reviewHash` of a `pre_tool_use` hook with matcher `*`, command `/opt/node /x/deny.mjs`, timeout 30
  equals the hash codex-cli 0.166.0 reported for it (measured); `reviewRecords` of Codex's record holds
  `/<session-flags>/config.toml:pre_tool_use:0:0` with the guard's hash, beside Harness's own records.
- [ ] Implement; run the spec, `src/engines/codex/hooksReview.spec.ts` and `src/engines/hookInstallers.golden.spec.ts`.
  Commit test, then code.

### Task 5: Run the guard from the shipped CLI (takeover verification)

**Files:** `cli/src/lib/agentShellGuard.ts`, `cli/src/superTabs/shellGuardHook.ts`, `cli/src/entry.ts`,
`cli/src/architecture.spec.ts`, `cli/src/lib/swarmEngineArgs.spec.ts`,
`cli/src/superTabs/shellGuardBundle.spec.ts`, hook installer golden fixture when its trusted command changes.

**Interfaces:** Keep `hookAnswer` and the engine settings shapes. `shellGuardArgv` names the CLI entry plus
`__swarm-shell-guard`; the entry loads only the guard for that command. The source checkout uses its entry and tsx
loader, while a bundled/lean core names the CLI script it already uses for daemon commands. This replaces the
per-file hook path: a release ships cli.js and notify.mjs, without superTabs/shellGuardHook.js.

- [ ] Commit and run a failing release-bundle test: build the real package in a private folder, obtain the launch
  command from the compiled helper as the core does, and send Claude/Codex hook JSON to it. It must deny each rule
  with JSON, allow an ordinary command with no output, and never initialize the daemon or touch real account data.
- [ ] Route the internal command in the lightweight bundle entry; keep the Swarm import dynamic and name this
  command-only door in the architecture test. Remove the standalone-script autorun from the imported hook module.
- [ ] Verify compiled, source and Windows argv quoting; update only the intentional trust-record fixture change.
- [ ] Run the new test, affected launch/hook tests, architecture test and typecheck. Record red/green evidence and
  measured hook latency before Ready.

### Task 6: Close direct command gaps found during takeover

**Files:** `cli/src/superTabs/shellGuard.ts`, `cli/src/superTabs/shellGuard.spec.ts`,
`cli/src/superTabs/shellGuardHook.ts`, `cli/src/superTabs/shellGuardHook.spec.ts`.

**Interfaces:** Existing `shellRefusal`, `fileRefusal` and `hookAnswer`; no broader sandbox promise.

- [ ] Add failing cases for package-manager flags with case-sensitive meanings (`pacman -S` versus `-Q`), fixed
  temporary paths reached by a relative path/cwd, and command-specific Codex workdir overriding session cwd.
- [ ] Correct only those interpretations, preserving ordinary commands and quoted/heredoc text. Verify a real
  disposable worktree held by a child process is denied before any removal runs and allowed once that child exits.
- [ ] Commit each failing test before its fix; run affected rules/hook specs and record the results.
