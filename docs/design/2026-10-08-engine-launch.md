# Engine launch

Batch (c) of [the remaining facets](2026-10-08-engine-remaining-facets.md): launching, discovering and
resuming Claude Code and Codex. Launching an agent is session control, so none of it moves into an engine
worker. As with [hooks](2026-10-08-engine-hooks.md), the engines' code leaves the core and each engine
declares what it needs as data on its launch contract (`Engine.launch`, `engines/{claude,codex}/launch.ts`).
Shared mechanics in `engines/kit` read that data, and core runs them in line.

(c) is too large to land as one change. It is split into five sub-batches, each green on its own. This
document records (c1), (c2) and (c3), which are done, and plans the other two.

## (c1) Launch argv and the pane script: done

| Was | Now |
| --- | --- |
| `lib/engineLaunch.ts`: Codex's `--no-daemon` probe (`codexOwnedLaunchPrelude`), its startup retry (`codexStartupRetryScript`, `CODEX_STARTUP_RUNS`, `codexRetries`), the runs in `engineRunScript`, and the POSIX runner a Codex launch got where the daemon has no login shell | `EngineLaunch.startup`: `ownedFlag` (probe `sharedServer.ownedFlag` before each run, and the message for a probe that fails) and `retry` (the update line and its status, the transient failure's exact line, status, window, attempts and backoff, and the messages). `engines/kit/launchStartup.ts` writes the script from this data, and the engine's id names its functions (`harness_codex_*`). |
| `lib/codexStartupRetry.ts`, the evidence probe the retry runs in the pane | `kit/launchStartup.ts` `startupProbe`, with the two lines and the window taken from `startup.retry` |
| `engines/codex/ownLoginProvider.ts`, `-c model_provider=` from `config.toml` | `EngineLaunch.ownProvider` (the home setting, the file, the top-level key, the fallback and the argv), read by `kit/launchArgs.ts` (`topLevelString`, `ownProviderArgs`). `lib/engineHomes.ts` `launchHome` finds the home for any home setting, and `launchCodexHome` now calls it. |
| `contextArgs` (Claude) and `codexEnvArgs` (Codex), functions in the contracts | `ContextArgsTemplate` and `EnvArgsTemplate`, data, which `kit/launchArgs.ts` turns into the functions the DSH adapters call |

`engines/launches.ts` builds what callers use from each contract: `launchContract`, `launchField`,
`harnessAdapters` and `ownLoginProviderArgs`. No caller changed: create, fork, restart, restore, resume,
retarget and adoption still go through `buildEngineLaunchArgv` and `buildLaunchOverrides`.
`lib/engineLaunch.ts` no longer checks `engine === 'codex'` anywhere. `ENGINE_EXIT_PANE_OPTION` moved to
its own file (`lib/engineExitOption.ts`). Building a launch used to load `lib/tmux.ts` just for that one
constant, and with it the registry.

### The same bytes

**Golden record.** `engines/launchArgv.golden.spec.ts` was recorded from the code as it stood before the
change, in its own commit. It holds:

- **369 launches**, giving the pane's argv, the script sourced from the one-time file and the engine's
  command. They cover:
  - every caller's shape: create; adoption, both resuming and waiting out a turn; fork; restart and its
    fresh fallback; restore; resume; retarget onto a grid;
  - every permission mode, first prompts, and install-when-missing (npm recipes);
  - the npm Codex wrapper and Claude at paths of the person's choosing;
  - a remote server's flag passed through;
  - eight shell families, with tmux absolute, relative and absent;
  - a managed grid binary, the zsh new-user guard, and no data folder.

  Claude Code and Codex are recorded in every shape. The other 13 engines are recorded in the common shapes,
  since they share the wrapper.
- **71 relaunch overrides** (`buildLaunchOverrides`): env, extra argv, cleared variables, hook installs and
  config reads. They cover:
  - own login, a model to return to, grid, a saved API, a harness, and SCM;
  - seven `config.toml` shapes, each read from the default home, a profile, and a profile on a grid;
  - a CODEX_HOME moved by the person's shell (absolute, relative, `~`, a trailing slash);
  - the real file.
- **The DSH adapters' context and env flags** for every engine.

The 170 distinct scripts are stored as runs of their 243 distinct lines.

**Result.** The spec passes unchanged against the new code. These mutations each fail it:

- Codex's backoff, its fallback provider, or its env-name rule;
- Claude's context text;
- the runner fallback, the flag variable's name, the run count, or the TOML header rule.

**The bundle.** The release bundle is minified and has non-Latin-1 characters escaped (`asciiOnly`). Built
that way, a probe of both builders printed the same 71,434 bytes from the base commit and from this change.
That covers Claude and Codex, four shells, tmux present and absent, overrides and adapters. Codex's update
line is a tagged template in the contract, as the probe was before, so the bundle escapes its emoji in the
same place.

**Unchanged suites.** The former `codexStartupRetry.spec.ts` and `ownLoginProvider.spec.ts` run
unchanged against the kit and the composition (`engines/kit/launchStartup.spec.ts`,
`engines/launches.spec.ts`), and new cases cover the kit's own branches. `lib/engineLaunch.spec.ts` and
`lib/launchOverrides.spec.ts` are unchanged.

### Core closure (esbuild, `core/main.ts`, dynamic imports external)

| | Lines | Files |
| --- | --- | --- |
| Before (after #1045) | 73,056 | 388 |
| After | 73,162 | 390 |

**Left:** `engines/codex/ownLoginProvider.ts` (105 lines) and `lib/codexStartupRetry.ts` (41 lines), plus
the Codex branches of `lib/engineLaunch.ts`, which is 108 lines shorter. **Came in:** `kit/launchStartup.ts`
(202 lines, about half of it the comments that moved with the script), `kit/launchArgs.ts` (73),
`lib/engineExitOption.ts` (10) and `lib/shellQuote.ts` (5). The Codex contract grew by 38 lines of data and
comments. Line counts are informational.

`architecture.spec.ts` lists `engines/codex/ownLoginProvider.ts` and `lib/codexStartupRetry.ts` as edge
files. It also checks two sets of closures:

- **The launch builders** (`lib/engineLaunch.ts`, `lib/launchOverrides.ts`, `engines/launches.ts`, the two
  kit modules, `dsh/adapters.ts`) reach no Claude Code or Codex file but the two launch contracts.
- **The launch callers** (create, fork, restart, swap, the resume service) reach only those contracts, the
  hook contracts, and `engines/codex/rollout.ts`. The registry still holds `rollout.ts` until (c4).

`core/agents/launch.ts` still imported `engines/codex/portableHistory.ts`, until (c2) below.

## (c2) Launch preparation: done

| Was | Now |
| --- | --- |
| `lib/claudeTrust.ts`: Claude Code's `.claude.json` and Codex's `config.toml` folder trust, read and recorded | `EngineLaunch.trust`: the home (`LaunchHome`: a daemon setting with an agent's profile, or a variable else the home folder), the file and the format. Claude declares `json` (the projects key, the accepted flag, a new entry's defaults; a yes covers the folders below). Codex declares `toml` (the table, key and value; exact folders only). `engines/kit/folderTrust.ts` reads and writes both, through a symlink, atomically. |
| The `engine === 'claude'` and `engine === 'codex'` trust branches in `core/agents/create.ts` and `launches.ts` | `engines/launchPrep.ts` `folderTrust(engine, profile)`: null for an engine that asks no such question |
| `engines/codex/portableHistory.ts`, Codex's rollout made resumable | `EngineLaunch.resumeRepair`: where histories are and how one is found by id, the record that names the session, the records whose items are replayed, the repair (`portable-reasoning`, the relay's contract), the backup and temporary suffixes, and the names in messages and the log. `engines/kit/resumeRepair.ts` applies it with the same bounded reads, digest, backup and atomic rename. `engines/launchPrep.ts` `prepareResume` is what `core/agents/launch.ts` calls. |
| `engines/codex/rollout.ts`'s rollout lookup | The kit's `findSessionFile` on the same declared rule. The registry still calls `resolveCodexRollout` until (c4), which now delegates. |
| The instruction-file fallbacks in `dsh/runtime.ts` (`CLAUDE.md`, and Claude's `@AGENTS.md` import line) and `lib/apiInstructions.ts` | `EngineLaunch.instructionFile` and `instructionImport` (Claude); others keep AGENTS.md. |

`lib/engineHomes.ts` gains `launchHomeOf` (the declared home, at launch) and `homeRoots` (a setting's own home
and every one the person moved). `launchClaudeConfigDir` is now one case of it. The daemon's resume log line
names what was repaired in the contract's words, unchanged.

### The same bytes

**Golden record.** `engines/launchPrep.golden.spec.ts` was recorded in its own commit, before the change,
through a composition of the former code. It holds:

- **166 folder-trust cases.** Each answers five probe paths before and after, and records twice.
  - Claude Code's `.claude.json` in 40 states: none, empty, malformed, a byte order mark, JSON scalars,
    `projects` of every type, entries of every shape, a parent's trust, a trailing slash, a longer sibling,
    other settings, minified, duplicate keys, unicode, symlinks (kept), dangling, read-only, unreadable, a
    read-only folder, a folder, a private file, a leftover temporary file. Each in a moved and the default home.
  - Codex's `config.toml` in 27 states: none, empty, no final newline, CRLF, trusted, untrusted, quoted,
    single-quoted, spaced and escaped keys, a key JSON cannot read, inline, dotted and bare `projects`,
    other projects, sub-tables, a commented header, a path with a quote, a backslash, DEL and unicode,
    symlinks, permissions. Each in a profile, a moved and the default home.
  - A relative or `~` CLAUDE_CONFIG_DIR, and every engine that asks no such question.
- **36 resume repairs**:
  - repairs, nothing to repair, content into the summary, compaction, encrypted reasoning;
  - CRLF, blank lines, no final newline, past one 64 KiB read with a character across it;
  - every refusal; found by id, stale paths;
  - a symlinked or outside rollout, a folder, a world-readable file.

  They run in the profile's home, and four of them in the daemon's and a moved home as well.
- **96 instruction-file cases:** a harness's bootstrap for every engine and the workspace states that pick
  a file, and the saved APIs' note for every engine plus `terminal` and `gemini`.

Each case keeps what was returned or thrown, and every file: bytes (a hash past 4 KiB), mode, symlinks,
leftover temporary files and backups. The spec passes unchanged against the kit. These mutations each fail it:

- Claude's entry defaults, its import line, its instruction file or its home variable;
- Codex's trust value, its backup suffix, its compaction rule, its session id field or its file name;
- the kit's blank line before an appended table, its trust inheritance, its write mode, or its lookup.

**Seeded differential (not committed).** The former `lib/claudeTrust.ts` and `portableHistory.ts` ran beside
the kit in one process, on generated files, with 500 cases per seed and three seeds:

- **Trust:** 3,000 settings files. 1,233 Claude Code and 631 Codex records were written.
- **Repair as text:** 1,500 rollouts. 277 were repaired and 381 refused.
- **Repair as a file:** 300 files. 59 were rewritten.

Every answer, byte and mode was equal.

**Unchanged suites.** The former `lib/claudeTrust.spec.ts` and `engines/codex/portableHistory{,.real}.spec.ts`
run their cases unchanged against the kit (`engines/kit/folderTrust.spec.ts`,
`engines/kit/resumeRepair{,.real}.spec.ts`). The core specs (`create`, `launches`, `launch`) and
`backendSocket.spec.ts` route the same per-engine spies through `folderTrust`. The resume log case now uses a
Codex session, the only engine that declares a repair.

### Core closure

| | Lines | Files |
| --- | --- | --- |
| Before (#1046 rebased, `519e51fd6`) | 73,231 | 390 |
| After | 73,370 | 391 |

**Left:** `engines/codex/portableHistory.ts` (220 lines) and `lib/claudeTrust.ts` (129). `engines/codex/rollout.ts`
lost its own walk (16 lines). **Came in:** `kit/resumeRepair.ts` (259), `kit/folderTrust.ts` (129),
`engines/launchPrep.ts` (61) and the contracts' data (36 lines).

`architecture.spec.ts` adds the two deleted files as edge files. Its launch closure test now covers:

- **The builders:** the composition, both kit modules, `dsh/runtime.ts` and `lib/apiInstructions.ts`.
- **The callers:** `core/agents/launch.ts` and `launches.ts`.

They reach no Claude Code or Codex file but the declared contracts and `rollout.ts`, the registry's until (c4).

## (c3) Discovery and process matching: done

Discovery runs on every pass, as the registry loads and at start-up. A new facet, `DiscoveryContract`
(`engines/facets/discovery.ts`), declares what core reads off each engine's process and transcripts. Each engine
declares it in `engines/{claude,codex}/discoveryContract.ts`, and `engines/discoveries.ts` composes what callers use.

| Was | Now |
| --- | --- |
| Claude Code's and Codex's rows of `ENGINE_PROCESS_SIGNATURES` in `lib/tmux.ts` | `process.basenames` and `process.entrypoints`, spread into the table for every engine |
| `claudeNativeInstallPath` in `lib/tmux.ts` | `process.versionedInstall` (`.local/share/claude/versions`), compiled once by `kit/processFacts.ts` and looked up as a plain property |
| Claude Code's and Codex's rows of `RESUME_ARGS` in `lib/tmux.ts` | `resumeArgs`: the flags, the id's shape, and the flags under which the id is a parent's |
| `codex` in `lib/gridAssignment.ts` `MODEL_IN_ARGV` | `modelInArgv` |
| `lib/codexHomeProbe.ts` | `profile`: the variable a process carries and the setting naming the default. `kit/processFacts.ts` `profileFromEnv` reads it; `discoveries.ts` `probeProfileHome` is what the pass calls. |
| `lib/claudeProject.ts`, and the `engine === 'claude'` checks in `lib/cwdRepair.ts` and `registry.register` | `projectFolder`: how a folder maps to a directory name, the marker, the field and the scan cap. `kit/projectFolder.ts` applies it; `discoveries.ts` `transcriptProject(engine)` is null for an engine with no such rule. `repairClaudeCwd` became `repairProjectCwds`. |

### The same answers

**Golden record.** `engines/discovery.golden.spec.ts` was recorded in its own commit, through a composition of the
former code. It holds:

- **222 process rows against every engine:** the score and evidence, and whether the row is an unresolved `agent`.
  The rows cover native names, platform builds, npm and bun entrypoints, Claude's versioned native install and
  decoys of it, help and version probes, Windows paths, and every other engine's.
- **43 command lines against every engine:** the session resumed, and the permission mode and approval named.
- **8 grid launches:** the model.
- **13 environments:** the profile home.
- **35 transcript cases:** whether a transcript is in a project directory, which folders it belongs to, the folder
  it names for itself (past one read, with a character across reads, within a limit), and the start-up repair.

Every case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they differ
(none). The spec passes unchanged against the kit, and 12 one-line mutations each fail it:

- Claude's install path, fork flag, resume flags, project marker and folder field;
- Codex's model rule, profile variable and platform builds;
- the kit's length bound, separator handling, real-path check and decoder.

The former `claudeProject` and `codexHomeProbe` specs run their cases unchanged against the composition.

### The discovery pass's time

`discoverTerminalAgentsFromSnapshot` was timed on one fixed process table: 1,941 processes, with 60 panes running
Claude Code (native, npm and the versioned install), Codex (native, npm and a platform build), OpenCode, Cursor, Pi
and Hermes. Each pane runs helpers below it, and 1,400 unrelated processes sit beside them. The table was built
once, with no file-identity evidence. Each run made 400 passes after 50 warm-up ones, and five runs alternated
between the former code and this change on the same machine.

| | Median of run medians | Runs' medians | Runs' minimums |
| --- | --- | --- | --- |
| Before (`f6abddcf6`) | 10.14 ms | 9.90 – 10.73 ms | 9.70 – 10.41 ms |
| After | 10.31 ms | 10.17 – 10.83 ms | 9.91 – 10.50 ms |

The difference, under 2%, is within the runs' spread. A first version that looked the versioned install up in a
`Map` twice per row and engine cost about 4% in the same comparison, and is not what landed.

### Core closure

| | Lines | Files |
| --- | --- | --- |
| Before ((c2)) | 73,370 | 391 |
| After | 73,488 | 394 |

**Left:** `lib/claudeProject.ts` (92 lines) and `lib/codexHomeProbe.ts` (40). `lib/tmux.ts` is 16 lines shorter.
**Came in:**

- the two contracts (51 lines of data);
- `engines/discoveries.ts` (87);
- `kit/processFacts.ts` (36);
- `kit/projectFolder.ts` (86).

`architecture.spec.ts` lists the two removed files as edge files. A new closure test checks that the discovery modules
reach no Claude Code or Codex file except the declared contracts and `rollout.ts`, which the registry holds until (c4):
`tmux.ts`, `terminalAgentDiscovery.ts`, `gridAssignment.ts`, `cwdRepair.ts`, the registry, the composition and both
kit modules.

## The plan for the rest of (c)

The sub-batches are ordered by risk: pure functions first, then async writes, then the hot and synchronous
paths. Each one records today's behavior in a golden spec first, in its own commit.

| | Scope | Why it is in this place | Golden proof |
| --- | --- | --- | --- |
| **(c4) Registry load and session identity** | The registry's Codex child-rollout repair (`lib/registry.ts` with `engines/codex/rollout.ts`), `lib/sessionRepair.ts` (about 190 of 716 lines), `lib/captureResumeIdentity.ts`, `lib/handoffDiscovery.ts`, and the moved engine homes of `lib/engineHomes.ts` (with the `CODEX_HOME` env literal at create and relaunch), which the registry and session repair read. | Synchronous, at load before any worker exists, and on the hook path. A wrong answer loses bindings at every restart. The moved homes go with it, since the registry and session repair are what read them. | Recorded transcripts and pid records → binding, session id and repair, read with the same bounds. |
| **(c5) Adoption readers and shared normalizers** | `lib/sessionSearch/externals/{claude,codex}.ts`, `lib/transcriptPages.ts`, `lib/transcriptReader.ts` and `lib/transcriptActivity.ts`. Also splitting the functions `engines/claude/normalize.ts` and `engines/codex/{normalizer,subagent}.ts` share with other engines into `engines/kit`. | The largest (1,000 to 2,000 lines) but async. Listing and paging sessions for adoption is not session control. Those readers may run in a worker, as long as adoption fails safe when it is down: refused with a reason, never a wrong session. | The adoption and paging specs, unchanged, plus a recorded corpus of transcripts → pages. |

**Out of (c).** These stay as they are, as tables over every engine:

- `lib/engineBin.ts` (`CLAUDE_PATH`, `CODEX_PATH`);
- `lib/engineInstall.ts` (install recipes);
- `lib/gridLaunch.ts` (grid contracts).

Their Claude and Codex rows are data, not code paths. The engine-specific wording in
`lib/messageHolds.ts` and `core/cardText.ts`, and the screen check in `core/main.ts` `activityText`, belong
to (a) and the screen facet.
