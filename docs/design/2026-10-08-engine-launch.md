# Engine launch

Batch (c) of [the remaining facets](2026-10-08-engine-remaining-facets.md): launching, discovering and
resuming Claude Code and Codex. Launching an agent is session control, so none of it moves into an engine
worker. As with [hooks](2026-10-08-engine-hooks.md), the engines' code leaves the core and each engine
declares what it needs as data on its launch contract (`Engine.launch`, `engines/{claude,codex}/launch.ts`).
Shared mechanics in `engines/kit` read that data, and core runs them in line.

(c) is too large to land as one change. It is split into five sub-batches, each green on its own. This
document records all five, which are done.

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

## (c4) Registry load and session identity: done

Where Claude Code and Codex keep their sessions is read as the registry loads, on the hook path, by session repair,
by Stop's capture and by the handoff. A new facet, `SessionStoreContract` (`engines/facets/sessionStore.ts`),
declares it. Each engine declares it in `engines/{claude,codex}/sessionStore.ts`, listed in
`engines/sessionStoreContracts.ts`; Codex's reuses its launch contract's rollout layout and its hook contract's child
rule. Two kit modules apply it: `kit/sessionRecords.ts` (a file found by its id, and its first record) and
`kit/continuation.ts`. `engines/sessionFiles.ts` holds the file reads, which the registry calls without reaching
session repair, and `engines/sessionStores.ts` is the one place callers take the finders from.

| Was | Now |
| --- | --- |
| `engines/codex/rollout.ts` `readCodexRolloutMeta` and `resolveCodexRollout`, called by the registry and session repair | `first` (the record's type, where its id, folder, child marker and parent are, the read bound) and `byId` (`walk`: the suffix, the id's shape, the entries looked at). `sessionMetaOf` and `findSessionFileOf`. `rollout.ts` is a 20-line wrapper for Codex's own sub-agent reader. |
| The registry's Codex child-rollout repair at load, with its `engine === 'codex'` check and log line | `repairsOverwrittenParent`, and the parent found in the same home (`sessionFolderOf`) or the row's profile. The log line names the engine by the contract's `label`, unchanged. |
| The `claude` and `codex` rows of the registry's `TRANSCRIPT_ROOT` and `transcriptRoots` | `'store'`: the folders `engineHomes.sessionRoots` names. `setCodexHome` takes an engine whose sessions follow a profile (`sessions.profile`). |
| The `claude` and `codex` cases of `lib/sessionRepair.ts` `findLiveSession` and `findResumedTranscript`, `readClaudeTranscriptMeta` | `scan` (`head`: the child folder and sidechain flag; `first`: the first record) and `byId` (`projects`: one folder below each sessions folder). One `storeSession` for both. |
| `claudeProcessSession` and its record reader | `live.record` (the folder and suffix beside each sessions folder, the pid, start, folder and id fields). `processSessionOf`. |
| `codexProcessSession` and `codexProcessFiles` | `live.open` (the session file's name, the launcher whose one native child holds it). `openFileSessionOf` and `processFilesOf`. |
| `claudeContinuation`, and the `engine === 'claude'` check in `core/agents/bind.ts` | `continuation` (the marker's type and field, the next file's suffix, the tail and head bounds, the turn types). `continuationOf`. The registration's source and hook event are built from the engine and its `label`, unchanged. |
| The `engine === 'claude'` checks in `lib/captureResumeIdentity.ts` and `lib/handoffDiscovery.ts` | `processSessionOf` for any engine (null without a record); the handoff asks the record for an engine that declares `live.record` |
| `lib/engineHomes.ts`: the `claude` and `codex` arrays, `adoptEngineHomes`' two variables, the `archived_sessions` literal; `core/engines/hooks.ts`' adoption and its log line | `sessions` (the setting naming the daemon's own folder, the folder below it, the profile, the variable that moves the home and the folder below a moved one, the archive folder). `adoptHomes`, `movedHomes`, `sessionRoots`, `sessionHomeOf`, `ownHomeOf`. The former names are wrappers. The log line names the engine by `product`, unchanged. |
| `{ CODEX_HOME: … }` at create (`core/agents/create.ts`) and relaunch (`lib/launchOverrides.ts`) | `profileEnvironment(engine, home)`: the variable that moves the home, for an engine whose sessions follow a profile |

The kit's lookup by id (`findSessionFile`) moved from `kit/resumeRepair.ts` to `kit/sessionRecords.ts` unchanged,
and the resume repair imports it.

### The same answers

**Golden record.** `engines/sessionStore.golden.spec.ts` was recorded in its own commit, from the former code through
a composition (`engines/sessionStores.ts`), with throwaway homes under a temporary folder. It holds 226 cases:

- **9 home states:** adopted, adopted again, the defaults, relative, `~` and padded paths, remembered across a
  restart, and the homes a launch uses in four environments.
- **18 transcript checks:** which paths the registry accepts for six engines, with and without a profile, missing
  files allowed or not, through symlinks either way, and which engines keep a file.
- **112 lookups:** a session found by its id (Claude's projects, Codex's rollouts, a profile, moved homes, ids of
  the wrong shape), by a scan of the store (one, two or no candidates, a linked folder, a profile, born after the
  process or not, a subagent refused by its folder or by its first flag, a moved home below a folder named
  `subagents`), by a process's own record (UTC and local starts, wrong pid, folder, id or start, unreadable), by
  the rollout a process holds open (a sub-agent's, two, the same twice, outside the sessions, another file shaped
  like a session), and by the files behind npm's Node launcher.
- **15 continuations:** with a turn, a background session's, the next file missing or a folder, large with and
  without a turn, the marker not last, malformed.
- **26 first records and lookups by id:** sub-agents with and without a parent, malformed records, a first line
  past the 128 KiB bound, nested and dotted folders.
- **30 registry loads:** a parent overwritten by its sub-agent (put back, or released when its own rollout is gone
  or another parent's), profiles, moved homes, Claude rows inside and outside their projects, unbound rows. The
  saved file and the log line are recorded too.
- **16 captures and handoffs:** what Stop captures for each kind of row, and which finder the handoff asks for
  each engine.

Every case runs with `process.platform` pinned to darwin and to linux, and linux's are stored where they differ
(none). The spec also passes with `TMPDIR=/tmp`; no recorded size depends on the temporary folder's length. It
passes unchanged against the kit, and 24 of 25 one-line mutations fail it:

- Claude's record fields and folder, child folder, sidechain flag, continuation type, tail, head and turns, moved
  folder, own folder and file suffix;
- Codex's archive folder, read bound, launcher, file name, parent and folder paths, own folder, profile, scan,
  repair flag and label;
- the kit's head-length check, and the archive folder in `sessionHomeOf`.

The one that passes is the walk's entry limit off by one in `findSessionFile`, which moved unchanged. Pinning it
would need a folder of 5,000 entries read in an order the filesystem chooses.

### The registry's load time

`registry.load()` was timed on one fixed registry: 2,000 rows (Claude Code in the daemon's projects and a moved
home, Codex in its own home, a moved home and a profile, a Codex parent its sub-agent overwrote, Cursor and
OpenCode), every transcript on disk. The first load migrates the legacy rows and saves them. Each run then timed
40 loads of the saved file, as a daemon start reads it, after 3 warm-up loads. Twelve runs, six of each, alternated
between the former code (the record commit) and this change on the same machine, on main.

| | Median of run medians | Runs' medians | Runs' minimums |
| --- | --- | --- | --- |
| Before | 116.3 ms | 114.6 – 125.4 ms | 106.8 – 116.3 ms |
| After | 115.4 ms | 112.9 – 119.9 ms | 105.3 – 112.3 ms |

Every row stays bound. On the branch's earlier base, twenty runs (25 or 40 loads each) gave 116.8 ms before and
120.6 ms after, with the same fastest loads. Either way the difference is within the runs' spread.

Found while measuring, and unchanged here: the FIRST load of a registry whose rows all change (the migration of a
legacy file) took 15.6 s for the same 2,000 rows. `save()` merges every changed row against every row on disk, so
it is quadratic in the rows changed. A start with a few changed rows does not see it.

### Core closure

| | Lines | Files |
| --- | --- | --- |
| Before (the record commit, on main) | 71,654 | 386 |
| After | 71,865 | 392 |

**Left:** the Claude Code and Codex cases of `lib/sessionRepair.ts` (82 lines shorter), Codex's own reader in
`engines/codex/rollout.ts` (49 lines shorter) and the walk in `kit/resumeRepair.ts` (25). **Came in:** the two
stores (85 lines of data and comments), `sessionStoreContracts.ts` (23), `sessionFiles.ts` (41),
`kit/sessionRecords.ts` (94), `kit/continuation.ts` (100), and the generic homes in `lib/engineHomes.ts` (57).

`rollout.ts` is still in the core's process: the Codex transcript normalizer reaches it through its sub-agent
reader, which (c5) takes up. The session-control modules no longer do. `architecture.spec.ts` drops `rollout.ts`
from the declared files and adds a closure test:

- **Strict:** the registry, the handoff, `engineHomes.ts`, `sessionFiles.ts`, the store list and both kit modules
  reach no Claude Code or Codex file but the declared contracts. The store list reaches exactly the two stores and
  what Codex's shares with its launch and hook contracts. The kit modules reach none at all.
- **With one exception:** session repair, Stop's capture, the composition and `core/agents/bind.ts` reach the
  readers of Claude Code's and Codex's transcripts only through Pi's session reader
  (`lib/sessionSearch/externals/pi.ts`, through `lib/transcriptReader.ts`). Session repair names Pi's folders with
  it. The test walks their closures without that one file, and fails once it is no longer reached, so the
  exception is dropped with the change that takes it out.

The launch builders' closure test now admits the session stores too, since `lib/engineHomes.ts` reads them.

## (c5) Adoption, activity, pages and the normalizers: done

What core reads of Claude Code's and Codex's conversations, besides binding them: which ones are on this machine
and which process holds one (adoption: Cmd-P, opening one here, and stopping its owner first), an agent's latest
activity, and a thread's pages and line count. Taking a conversation over stops a process, so adoption stays in
core, declared: a new facet, `AdoptionContract` (`engines/facets/adoption.ts`), declared in
`engines/{claude,codex}/adoption.ts`, which reuse their session stores' layout, process record, first record and
archive, and applied by `engines/kit/adoption.ts`. The replays stay their readers', in their workers.

| Was | Now |
| --- | --- |
| `lib/sessionSearch/externals/claude.ts`: projects scanned, heads read in widening windows for the first line naming `"entrypoint"`, sub-agents and programs left out; owners from `<home>/sessions/<pid>.json`, checked against the process table and their start; busy from the record's `status` | `files` (`projects`), `head` (windows, `marked`, the sidechain flag, id, folder, origin by `entrypoint`), `owners.records` (the store's record, `startedAt` and its slack) and `busy.record`. The file is a wrapper its spec still uses; core builds the provider from the declaration (`engines/adoptions.ts`). |
| `lib/sessionSearch/externals/codex.ts`: rollouts walked four folders down in `sessions` and `archived_sessions`, the first line read in two windows, thread names from `session_index.jsonl`; owners from the rollouts `codex` holds open, a server's an app's; busy from the last turn event near the end | `files` (`walk`: prefix, suffix, depth, the store's folders), `head` (`first`, the store's first record, origin by `source` and `originator`), `titles`, `owners.open` (commands, the id in the name, servers by executable, arguments and subcommand) and `busy.tail`. A wrapper as above. |
| `lib/transcriptActivity.ts`: the record types each of the two counts as work, by name | `activity` on the session store: the time field, the item paths, and the kinds of record, each field compared as text (`in`) or as it is (`is`), exactly as the former code compared it. |
| `lib/transcriptPages.ts` `claude()` and `codex()`, with Claude Code's `claudePageLine` and Codex's `codexPageStart` and `windowCodexLines` imported | `page(path, rules, ask)`: the rules are the reader's (`ThreadPages`: a record's cursor, or a `<prefix>:<n>` line cursor). Claude Code's and Codex's readers hand theirs in (`engines/{claude,codex}/transcript.ts`). An unreadable file still answers as an empty one. |
| `engines/kit/history.ts` `enrichSubagentStats` (Claude Code's background agents' totals, with its `SubagentStats`) | `engines/claude/subagentStats.ts`, which Claude Code's reader passes to `pagedHistory`. Codex's never needed it: its cards carry their totals. |
| `core/transcripts/{history,lastTurn}.ts`: Claude Code's replay, window and recap as the fallback for an engine with no reader | An empty page and no recap, as for an engine whose code could not load. No engine reaches it: Claude Code and Codex always have a reader (`core/engines/readers.ts`), and a shell keeps no transcript (`registry.engineKeepsTranscriptFile`). Core reads no engine's lines itself. |
| `lib/transcriptReader.ts` `forEachLine`, which four other engines' adoption readers stream lines with | `lib/transcriptLines.ts`, which `transcriptReader.ts` re-exports for search. Search's table of every engine's normalizer stays where it was, out of core. |
| `core/**` imports of `lib/normalize.ts` | `engines/kit/events.ts`. `lib/normalize.ts` remains for the engines that write Claude Code's message format (Devin, Command Code). |

The functions Claude Code's normalizer shares with other engines are that message format, and Codex's share
nothing. Neither moved into `engines/kit`: moving them would only have relabelled 978 lines as core's. They leave
the core instead, with what read them.

### The same answers

**Golden record.** `engines/transcriptReads.golden.spec.ts` was recorded in its own commit, from the former code. It
reads the pager through `engines/transcripts.ts` `pageOf`, the call each reader makes, and everything else through
the public entries: the providers `externals/index.ts` builds, `transcriptActivityAt`, the readers, and core's
`session_get`, `sessions_list` and recap reader. It holds 210 cases:

- **33 for adoption.** Each provider's scan in its own and moved homes, scanned again from what the first scan kept.
  The heads cover widening windows, a pasted image, a first line past every window, and files still being written
  and then written. They also cover what is left out: sub-agents, programs, relative folders, bad ids, Harness's
  own folder, links and folders that are not files, archived rollouts, and thread names. Owners cover reused pids,
  late and early starts within and past the slack, servers by executable, arguments and subcommand, and ids in
  file names. Busy covers each record status and each turn event near and past the windows.
- **71 for activity.** Each counted and uncounted record of both engines, a zone-less time (local time is pinned),
  bad times, records that are not objects, values that read as counted ones, large last records, activity past
  the bound, missing, empty and folder paths, other engines, and a file that grew.
- **58 pages.** A 30-turn corpus per engine, followed cursor by cursor at three page sizes. It includes a turn too
  long for a page (clipped), lines too long for any, CR endings and blank lines. Cursors cover a prompt, a tool
  call, the huge line, quoted, empty, leading-zero, unsafe and out-of-range cursors, a missing file and a folder,
  and a file that grew while its pager remembered cursors.
- **48 for history.** Both readers on the recorded fixtures and on the corpora, with Claude Code's background
  agents' totals joined from their files. Core's `session_get` (whole, latest, older, stale), `sessions_list` and
  last turn for each.

Every case runs on darwin and on linux (no differences), and it also passes with `TZ=UTC TMPDIR=/tmp`. It passes
unchanged against the declarations and the kit. Of 41 one-line mutations, 38 fail it:

- adoption: windows, marker, sidechain flag, id shape, folder, origins, the record's start field and slack, busy,
  prefix, depth, archive, titles, commands, the id in a name, servers, the tail's windows, marker and events;
- activity: each list, an item path, `is` against `in`, and each kind;
- pages: the line cursor's prefix, and the unreadable file's answer;
- the kit: a whole file is still being written, the first line is never a whole one, and Claude Code's agents' totals.

The three that pass change nothing anyone can observe:

- the size of Claude Code's first head window, while the last one is unchanged;
- dropping a window's partial last line, which never parses;
- skipping a file where a project folder should be, which lists nothing either way.

### Time

Each measure is the median of six runs of each side, alternated on the same machine, over fixed inputs built
once per run. The normalizers' code did not change; they were timed because they run per line.

| | Before (the record commit) | After |
| --- | --- | --- |
| Claude Code's normalizer, lines a millisecond (28,000 lines) | 591 (565 – 655) | 592 (550 – 605) |
| Codex's normalizer, lines a millisecond (28,000 lines) | 1,072 (1,043 – 1,156) | 1,075 (1,038 – 1,131) |
| A whole Claude Code thread, 50 lines a page | 168 ms (142 – 194) | 162 ms (148 – 171) |
| A whole Codex thread, 50 lines a page | 995 ms (918 – 1,043) | 961 ms (909 – 1,036) |
| Activity, one uncached tail read | 0.25 ms (0.24 – 0.28) | 0.25 ms (0.23 – 0.36) |
| Adoption scan, 1,500 Claude Code conversations | 127 ms (110 – 142) | 128 ms (106 – 144) |
| Adoption scan, 1,500 Codex rollouts | 308 ms (282 – 339) | 326 ms (307 – 343) |

Every difference is within the runs' spread.

### Core closure

| | Lines | Files |
| --- | --- | --- |
| Before (the record commit, on main with (o4)) | 70,288 | 378 |
| After | 66,955 | 370 |

**Left, 3,801 lines in all:**

- Codex's normalizer, sub-agent reader and rollout wrapper (1,062);
- `lib/transcriptReader.ts` (257), and with it the six other engines' normalizers reached only through it (2,171);
- the two adoption providers (267);
- `kit/history.ts` (44).

**Came in, 422 lines:** the kit's adoption (248), the two declarations and their composition (86), and the line
streamer (88). The pager grew by 23 lines and the stores by 22, and `history.ts` lost 7.

Claude Code's normalizer (978) and `lib/normalize.ts` remain, reached only through Devin's adoption reader. Devin
replays its store with Claude Code's message format. `architecture.spec.ts` now treats the two engines' normalizers,
readers, `lib/normalize.ts` and `lib/transcriptReader.ts` as edge files. It lists Claude Code's normalizer and
`lib/normalize.ts` in `CORE_MAY_REACH` for (o5), and drops the six normalizer entries (o5) no longer needs. A new
closure test checks adoption, activity, the pager, the line streamer, history, the last turn, the agent frame and
`external.ts`: they reach none of the two engines' code but their declarations. The pager, the line streamer and
the paged history know no engine at all. Session repair's exception for Pi's reader is gone: Pi's reader streams
lines and loads no normalizer.

### For (o5)

- **`lib/transcriptReader.ts` is out of the core.** The adoption readers of Pi, Copilot, Muse and Grok stream lines
  with `lib/transcriptLines.ts`, and search keeps its table.
- **`externals/index.ts` builds Claude Code's and Codex's providers from their declarations** (`engines/adoptions.ts`),
  statically: those stay. The other ten are (o5)'s to load lazily.
- **Devin's reader is the last road to Claude Code's normalizer.** Making it lazy ends the two `CORE_MAY_REACH`
  entries, which the ratchet then asks to remove.
- **`external.ts` is unchanged.**

**Out of (c).** These stay as they are, as tables over every engine:

- `lib/engineBin.ts` (`CLAUDE_PATH`, `CODEX_PATH`);
- `lib/engineInstall.ts` (install recipes);
- `lib/gridLaunch.ts` (grid contracts).

Their Claude and Codex rows are data, not code paths. The engine-specific wording in
`lib/messageHolds.ts` and `core/cardText.ts`, and the screen check in `core/main.ts` `activityText`, belong
to (a) and the screen facet.
