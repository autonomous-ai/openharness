# Engines behind one interface

> Process pilot: Claude Code and Codex history/last-turn reads now run in supervised workers. Other
> facets remain in core. See [the reader contract](2026-10-07-engine-readers.md) for scope, limits,
> failure behavior and compatibility. This is not complete engine isolation.


> **Status, 2026-10-07: resumed by the owner, a few engines per batch.** The first batch moves Claude
> Code and Codex launch contracts, paged history and last-turn reads behind an `Engine` interface. It
> preserves their existing argv and transcript behavior. The second batch moves their hook installation,
> Claude Code's resume-path correction and Stop handling, and Codex's subagent admission behind a hooks
> facet. Launch metadata and hooks load separately from history readers. Core retains authenticated
> transport, process binding, prompt timestamps and event delivery. Discovery/resume, live ingestion,
> screen/input, models and one-shot handling remain to migrate.
> Since then, Claude Code's and Codex's transcript readers (#1015), live parsing (#1017, #1019), runtime
> profiles (#1022), screen interpretation (#1027), model controls (#1038) and question navigation run in
> their supervised engine workers. Still in core for them: submission verification, hook admission and
> installers, engine-specific launch, discovery and resume, and native control connections.
> The older all-engine branches (`engine-interface-1..5`, `engine-lane-*`, draft PR #842) are retained as
> reference work; they are not the implementation currently landing. The phased plan below is the
> target architecture, not a claim that all facets or engine isolation are already complete.



Status: plan, approved for implementation on 2026-10-05. Scope: `cli/` (the daemon, harnessd).

**In short.**

- **What is there now.** Shared code decides per engine in **365 branch lines across 62 files** (the
  brief's grep finds 405; 40 are not engine behaviour). Counted with a parser, **113 of the 310 files**
  in `src/core`, `src/lib`, `cli.ts` and `backendSocket.ts` name an engine: 698 string literals, 273 table
  keys, 182 imports from engine folders. The core's own transcript modules hold 69 of the branch lines.
  The one engine interface, `EngineAdapter`, has no implementation.
- **The interface.** One `Engine` per engine, made of a manifest and eight optional facets: launch,
  transcript, sessions, screen, input, hooks, models, one-shot. 132 members in all (74 methods,
  58 data fields), about 20 of them required; shared code uses a fallback for every optional member that
  is missing, and the same fallback when it throws.
- **Placement.** Each engine's folder holds all of its behaviour, Claude Code's included (it has none
  today); shared pieces go to `src/engines/kit/`, named by the engines that use them. Shared code asks
  `src/engines/registry.ts`.
- **Loading and isolation.** Manifests load with the daemon; Claude Code and Codex are built in; the
  other twelve load on first use. Every call goes through one guard, so a throw degrades that agent's
  feature and nothing else. In a single-file bundle lazy loading saves about a megabyte, not tens; its
  main value is that a broken engine can no longer stop the daemon from starting.
- **The rule.** `src/engineNames.spec.ts` parses shared code and fails on any engine name, as a
  ratchet from today's counts down to zero.
- **Migration.** 31 steps in four phases, each green on its own with the e2e suite as proof for Claude
  Code and Codex and pinned unit tests for the rest. Steps 6 to 20 run as nine parallel lanes. Nothing
  before step 21 touches the files other branches are changing now. About 42 agent-days, 4-5 weeks of
  calendar with the lanes in parallel.
- **Found on the way.** Fifteen things that are wrong today (section 9.4), among them a terminal row
  that disables the hook script's registry read, a restart that records the grid from the wrong
  argument, and Codex model switching closed above 0.145.


## 1. Why

Harness drives fourteen agent CLIs in tmux panes: Claude Code, Codex, Cursor, OpenCode, pi, Hermes,
Kilo, Devin, Amp, agy, Grok, Copilot, Command Code and Muse. The code calls each one an engine.

The only engine interface in the tree is `EngineAdapter` in `src/engines/types.ts`. It has one method,
`createNormalizer`, and nothing implements it: no engine object exists, and no caller asks for one.
Everything an engine does differently is decided by a branch on its name in shared code: which binary to
run, the flags to launch and resume it, how to read its screen, its hooks, its models, where its
transcripts live, how to repair a session after a restart, and how to search its history. The engines
README says so plainly ("This is not a plugin API") and lists the twenty-odd shared files a new engine
has to touch.

That costs three things.

1. **The core is not engine-agnostic.** The core's own transcript modules (`core/transcripts/history.ts`,
   `attach.ts`, `lastTurn.ts`, `ingest.ts`, `normalizers.ts`, `databaseHistory.ts`) import from all thirteen
   engine folders and branch on the name 69 times between them (the core as a whole: 103). A change to one engine's reading is a change to the core, held to
   the core's bar and reviewed as one.
2. **One engine can take every agent down.** An engine's code runs in the core's process with no wall
   around it. A throw in a pane parser runs on the core's event loop. A module that throws while it is
   being loaded stops the daemon from starting at all, for every agent of every engine, because every
   engine is imported at start.
3. **Claude Code is the silent default.** It has no folder. Its reader, normalizer, question parser and
   paths are the `else` branch in shared code, so an engine that is not named in a branch gets Claude
   Code's behaviour. That has shipped as bugs twice already: Muse and Amp history panes opened empty,
   because the history request fell through to Claude Code's line cursor and normalizer
   (`core/transcripts/history.ts`, the comment above the Muse case).

The owner wants the core lean, small and engine-agnostic, and the refactor itself is approved. This plan
is how to get there in steps that each land green on their own.

## 2. How the branches were counted

The brief's own grep, over `cli/src` without specs:

```
grep -rnE "engine === '|engine !== '|case '(claude|codex|cursor|opencode|pi|hermes|kilo|devin|amp|agy|grok|copilot|commandcode|muse)'" src | grep -v '\.spec\.ts'
```

finds **405 lines in 76 files** on `main` at `31b4a0c27`. Read line by line, 40 of them are not per-engine behaviour:

| Kind | Lines | Files | Example |
|---|---:|---:|---|
| Per-engine behaviour | 365 | 62 | `if (s.engine === 'kilo') return lastKiloTurnText(…)` |
| `terminal` checks (the plain shell, a core concept) | 15 | 11 | `if (engine === 'terminal') throw …` |
| Local-model runtimes, not agent engines (`ollama`, `grid`, `lm-studio`, `llama.cpp`) | 14 | 2 | `lib/appModels.ts`, `lib/localModels.ts` |
| Type guards (`typeof engine !== 'string'`) | 10 | 8 | `core/agents/launches.ts:95` |
| A comment | 1 | 1 | `lib/terminalAgentReconciler.ts:382` |

The grep misses most of what shared code knows about engines, because most of it is not written as
`engine === '…'`. Counted with the TypeScript compiler's parser over the files the rule in section 7
covers (`src/core`, `src/lib`, `src/cli.ts`, `src/backendSocket.ts`; 310 files without specs), **113 of
the 310 files name an engine**:

| What | Count | Notes |
|---|---:|---|
| String literals equal to an engine name | 698 | every comparison, `case`, list member and map key written as a string |
| Keys of tables keyed by engine, and reads of them | 273 | `BYPASS_PERMISSION_FLAGS = { claude: …, codex: … }`, `dbs.opencode`; 17 tables are typed `Record<AgentEngine, …>` |
| Imports from an engine's folder | 182 | `core/transcripts/history.ts` alone imports from all thirteen engine folders |
| Engine-named identifiers, distinct per file | 876 | `preTrustCodexProject`, `CLAUDE_PROJECTS_DIR`, `codexHome`; `cursor`, `pi` and `amp` are left out because they are ordinary words in this code (a terminal cursor, a page cursor) |

Outside that scope another 12 files name an engine (`config/env.ts`, `hookServer.ts`, `watcher/`,
`cable/`, `teams/`, `dsh/`, `testing/`): 39 literals, 17 table keys, 4 imports, 58 identifiers.

Engine knowledge also sits in shared folders as whole modules: 22 engine-named files outside
`src/engines`, about 4,000 lines (`lib/claudeTrust.ts`, `lib/codexProfiles.ts`, `core/turns/agyBackstop.ts`,
`core/engines/cursorTasks.ts`, the twelve search adapters in `lib/sessionSearch/externals/`, and others),
and in two engine-specific fields of the persisted session row, `codexHome` and `hermesHome`, which about
30 shared files read.

Which engines the 365 behaviour lines name: Codex 68, Claude Code 55, Cursor 45, OpenCode 31, Grok 31,
Command Code 30, pi 26, agy 23, Copilot 23, Hermes 22, Kilo 19, Devin 19, Amp 16, Muse 14. Claude Code's
count understates its share, because its behaviour is mostly the unnamed `else`.

The scripts that produced these numbers are in the appendix; the rule test in section 7 is the same
scan, kept in the suite.

## 3. Inventory, by what is decided

Twelve groups. Each row is one decision: what it decides, where (the file and line on `main` at
`31b4a0c27`), which engines it names and what each gets, and what an engine not named gets. "Lines" counts
explicit branch lines (comparisons and `case` labels); "hits" counts the implicit forms (table entries,
list members, engine-named helpers, engine env vars, imports from an engine's folder). The two overlap
in a few places, and a row's numbers are about its own sites, so the groups do not add up to section
2's totals exactly; the rule test's per-file baseline is the exact measure.

### 3.1 Identity, binary and install (lines 36, hits about 90)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| The command a person types | `lib/engineBin.ts:21` `ENGINE_CLI_COMMANDS` | cursor `cursor-agent`, commandcode `cmd`, the rest their own name | terminal `''` |
| The env var that overrides the path | `engineBin.ts:394` `enginePathOverride`, 14 cases | `CLAUDE_PATH` … `COPILOT_PATH`; codex reads `process.env.CODEX_PATH`, which is not in the env schema | none |
| The launch binary | `engineBin.ts:414` `engineBin`, 14 cases | override, else the command | — |
| Names discovery accepts | `engineBin.ts:71` `ENGINE_CLI_ALIASES` | cursor and grok both `agent`; hermes `hermes-agent`; commandcode `cmd`, `command-code`, `commandcode`; kilo `kilocode` | own name |
| Extra fallback executables | `engineBin.ts:188` | cursor `~/.local/bin/agent`; grok `$GROK_HOME/bin/grok` first | the install paths |
| Who owns the shared `agent` file | `engineBin.ts:224-326` (ownership snapshot, `agentAliasOwner`, `cursorRuntimeBin`) | cursor or grok, by install layout | — |
| One-shot binaries | `engineBin.ts:342` `opencodeBin`; `lib/oneshot.ts` `claudeBin`, `piBin`, `commandCodeBin`, `kiloBin` | each its own resolver; Command Code's defaults to `commandcode` while everything else runs `cmd` | — |
| Install recipe | `lib/engineInstall.ts:38` `ENGINE_INSTALL`, 14 entries | npm, curl, brew recipes | terminal none |
| Skip the install when a path is set | `core/agents/create.ts:238`, `fork.ts:92`, `restart.ts:42`, `lib/resumeAgentService.ts:253`, `cli.ts:3334`, `lib/engineProbe.ts:96` | the same expression six times | — |
| Display label | `lib/agentNames.ts:15` `ENGINE_LABELS` | `Claude`, `Antigravity` (agy), `Command Code` … | the raw name |
| Engine env vars and their defaults | `config/env.ts` 145-310: 21 home and data folders, 13 path overrides | per engine | — |

### 3.2 Recognising an engine in a pane (lines 13, hits about 50)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Process name and entrypoint | `lib/tmux.ts:600` `ENGINE_PROCESS_SIGNATURES` | 22 basename and 14 entrypoint patterns | terminal empty |
| Engine-specific evidence | `tmux.ts:662-704` `heuristicEngineProcessMatchScore` | agy: the IDE's `.app` binary is vetoed; commandcode `⌘` title; cursor package entrypoint; hermes inline launcher; claude native install path | the signature alone |
| An unresolved `agent` blocks the pane | `tmux.ts:764` `ambiguousAgentProcess`, `tmux.ts:193` | cursor, grok | — |
| A hook hint settles the alias | `lib/terminalAgentDiscovery.ts:141` | cursor, grok | — |
| The session id in a resume argv | `tmux.ts:825` `RESUME_ARGS`, 14 entries | `--resume`, `resume`, `--session`, `--conversation`, `threads continue` | null |
| The permission mode in a live argv | `tmux.ts:867-904`, reading `engineLaunch.ts`'s tables | claude, codex, cursor, opencode | — |
| A per-agent home read off the process | `lib/codexHomeProbe.ts:27`; `engines/hermes/homeProbe.ts:19` | codex `CODEX_HOME`, hermes `HERMES_HOME` | none |
| The TUI owns its scrollback | `lib/terminalStreamManager.ts:1132` | grok | false |

### 3.3 Homes and profiles (lines 6, hits about 60)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| A home moved by the user's shell | `lib/engineHomes.ts` (whole file); `core/engines/hooks.ts:188-199`; `lib/registry.ts:792-793` | claude `CLAUDE_CONFIG_DIR`, codex `CODEX_HOME` | not adopted |
| Codex profiles: list and link | `lib/codexProfiles.ts`, `lib/codexProfileDiscovery.ts` (517 lines); `backendSocket.ts:2197-2218`, `:1962` `supportsCodexHome` | codex | — |
| Hermes home per session and per profile | `lib/hermesHome.ts`; `engines/hermes/home.ts`; read by `hookServer.ts`, `sessionCheckpoint.ts`, `purgeAgentService.ts`, `sessionRepair.ts`, `hooks.ts` | hermes | the default home |
| Engine-specific fields on the session row | `RegisteredSession.codexHome`, `.hermesHome`; `registry.ts:1962-1981` setters; about 30 files read them | codex, hermes | — |
| A shared server's CPU and memory | `lib/harnessResources.ts:66-87` | codex `app-server-daemon` | none |

### 3.4 Launching, resuming and forking (lines 30, hits about 300)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Permission modes and their flags | `lib/engineLaunch.ts:56` `PERMISSION_MODES`; the legacy yes/no flag `BYPASS_PERMISSION_FLAGS` `:23` equals each `auto` entry | claude (`auto`, `acceptEdits`, `plan`, `ask`, `full`), codex (`auto`, `readOnly`, `ask`, `full`), cursor and opencode (`auto`, `ask`) | no modes; any mode refused |
| Opening with a first prompt | `engineLaunch.ts:94` `FIRST_PROMPT_ARGS` | opencode `--prompt`, claude and codex positional, hermes `chat -q` | `PROMPT_UNSUPPORTED` |
| A named agent | `engineLaunch.ts:156`, `:194`; `core/agents/launches.ts:183` | opencode v1 `--agent` | `AGENT_UNSUPPORTED` |
| Resume | `engineLaunch.ts:313` `LAUNCH_RESUME_FLAG`, 14 entries | flag or subcommand per engine | a fresh start (never happens today: all 14 have one) |
| Native fork | `engineLaunch.ts:341` | claude `--resume id --fork-session`, codex `fork id` | a handoff fork if it takes a first prompt, else refused |
| The launch script | `engineLaunch.ts:482`, `:555-561`, `:578-620` | codex: `/bin/sh` fallback, `--no-daemon` probe, startup retries | the generic wrapper |
| Project pre-trust | `core/agents/launches.ts:258-262`, `:283-284`; `core/agents/create.ts:175-176`; `lib/claudeTrust.ts` | claude `~/.claude.json`, codex `config.toml` | nothing |
| Instruction files | `dsh/adapters.ts:34-49`; `dsh/runtime.ts:100`, `:105`; `lib/apiInstructions.ts:23` | claude `CLAUDE.md`; codex `AGENTS.override.md`; hermes `.hermes.md`; agy `GEMINI.md`; … | `AGENTS.md` |
| Harness context argv | `dsh/adapters.ts:35-39` | claude and pi `--append-system-prompt`; codex `-c shell_environment_policy.set` | none |
| Subscription model on relaunch | `lib/subscriptionModel.ts:49` | claude `ANTHROPIC_MODEL`, codex and hermes `-m`, opencode `-m` on v1 | none |
| House model and permission env | `lib/harnessDefaults.ts:15-43` | opencode `OPENCODE_CONFIG_CONTENT` | unchanged env |
| Grid (local models) launch | `lib/gridLaunch.ts:650` `GRID_ENGINE_CONTRACTS`, `:1001` refusals, `:1062` web search | claude, codex, opencode, hermes, grok, pi, copilot; refused for the rest | `GRID_ENGINE_UNSUPPORTED` |
| Grid read back from a process | `lib/gridAssignment.ts:37-61`, `:134`, `:269-270` | base-URL and model vars per engine; codex's argv parser is the fallback for all | null |
| Codex profile home, own login, resume repair, stop | `launches.ts:133`, `create.ts:231`, `:289`, `fork.ts:126`, `launchOverrides.ts:211`, `:249`; `core/agents/launch.ts:93`; `lib/codexSessionLifecycle.ts:96` | codex | — |
| A resumed session's model | `core/agents/retarget.ts:126-135`, `:201-215` | opencode (writes its store) | — |
| Plugin reinstall before a create | `core/agents/create.ts:234` | opencode | — |
| Machine facts for one engine | `cli.ts:3225-3226`; `opencodeMajorVersion()` at `launches.ts:183`, `create.ts:248`, `fork.ts:95`, `retarget.ts:128` | opencode major version, hermes system-managed | — |

### 3.5 Hooks (lines 32, hits about 70, plus about 1,100 engine lines in `lib/hooks.ts`)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Which hooks to install | `core/engines/hooks.ts:202-216`; `lib/hooks.ts` 13 installers and the plugin sources | 13 engines; plugins for opencode, kilo, pi, amp | muse: none |
| Install in a moved or per-profile home | `core/engines/hooks.ts:189-201`; `create.ts:231`; `launchOverrides.ts:252` | claude, codex | ignored |
| The hook command line | `lib/hooks.ts:62-93`, `:423`, `:738` | `--engine` omitted for claude; every engine's home baked into every command | — |
| Accept a hook on pane evidence without process ancestry | `hookServer.ts:48` | cursor | ancestry only |
| Correct the transcript announced after a cross-folder resume | `hookServer.ts:317-324` | claude | as posted |
| Reject or hold a SessionStart | `hookServer.ts:527-540`, `:357-386` | codex sub-agent rollouts rejected; hermes held until its store names the session | register at once |
| A turn-start hook opens the turn | `core/turns/turnHooks.ts:50-56` | commandcode | ignored |
| A tool-start hook is a sub-agent | `turnHooks.ts:57-59`; `core/engines/cursorTasks.ts` | cursor `Task` | ignored |
| What a Stop hook does | `turnHooks.ts:60-216`, seven branches | claude, cursor, commandcode, devin, copilot, agy (`waiting` arms a backstop), grok (errors only) | ignored |
| The agy idle backstop | `core/turns/agyBackstop.ts` | agy | — |
| Clean-up on forget and cancel | `core/agents/forget.ts:84-87`; `core/turns/cancel.ts:48` | agy, cursor; run for every engine | — |
| Cursor transcript discovery and task replay | `cli.ts:2075-2100`, `:3387-3393`, shutdown at `:3745-3758` and `:3862-3871` | cursor | — |
| Claude cwd repair at boot | `cli.ts:3269` | claude | — |
| An engine with no `engine` in its hook body | `hookServer.ts:319`, `:336`, `:508`; `funnel.ts:132`; `cli.ts:4046`; `backendSocket.ts:2242`; `notify.mjs:85` | assumed claude | — |
| The hook script itself | `hook/notify.mjs`, about 65 branch lines | per-engine payloads, endpoints, filters, transcript paths, a second copy of process matching | — |

### 3.6 Binding a pane to a conversation (lines 20, hits about 20)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| A repeated SessionStart re-folds the transcript | `core/agents/bind.ts:123-125` | not for cursor, agy, copilot | yes |
| Replay the transcript from its start at bind | `bind.ts:158`; `cli.ts:2093` | cursor | no |
| The conversation changed inside one process | `bind.ts:204-248` | copilot `/resume`; claude `continued-in` | — |
| The transcript of a session named on the command line | `bind.ts:264-274`; `lib/sessionRepair.ts:566-602`; `registry.ts:1560-1572` | three places covering different engines (section 9) | null |
| A resume with no transcript is dropped | `bind.ts:277` | cursor, grok, claude, codex | kept |
| May bind with no transcript path | `registry.ts:1018` (load), `:1494` (register) | two lists that disagree | a path is required |
| Session-id shape | `registry.ts:1489-1493` | grok, agy, copilot: UUID | any |
| A Codex sub-agent rollout is never a session | `registry.ts:992-1013`, `:1499`; `hookServer.ts:527`; `notify.mjs:1346` | codex, three times | — |
| Claude's transcript folder decides the cwd | `registry.ts:1578`; `lib/cwdRepair.ts:39`, `:57` | claude | the hook's cwd |
| How `projectDir` is named | `registry.ts:1608` | grok, agy, copilot: from the cwd | the transcript's folder |
| An unknown persisted engine | `registry.ts:351-355` | becomes claude | — |

### 3.7 Reading the transcript in the core (lines 72, hits about 80)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| How a session is attached | `core/transcripts/attach.ts:179-373`, 13 branches | claude, codex fold from the end; opencode, kilo, hermes, devin start a database reader; the rest fold a capped tail | Claude Code's normalizer |
| Read the footer once at attach | `attach.ts:254`, `:270`, `:298`, `:306`, `:362` | cursor, opencode 100 lines; grok, agy, devin 60 | no |
| Settle a folded turn that has no end record | `attach.ts:311-326` | agy from the pane, copilot from the records | the fold's answer |
| Which normalizer a live line goes through | `core/transcripts/ingest.ts:64-119` | ten branches | Claude Code's |
| A line that announces a failed turn | `ingest.ts:71`, `:111` | codex `task_complete` error, commandcode run error | none |
| One map of state per engine | `core/transcripts/normalizers.ts`: 14 maps, five fan-out functions | — | — |
| The last turn, for the recap | `core/transcripts/lastTurn.ts:43-63` | four database reads, codex rollout, claude backward, eight capped tails | Claude Code's raw lines |
| History pages (`session_get`) | `core/transcripts/history.ts:194-339`, 24 lines | claude, codex paged; four databases windowed; cursor, pi, commandcode windowed; muse, amp, grok, agy, copilot whole | Claude Code's raw window |
| Sub-agent totals and liveness | `history.ts:109`; `core/turns/recaps.ts:89-96` | Claude's `subagents/` folder, applied to every engine | — |
| A database conversation, whole | `core/transcripts/databaseHistory.ts:22-26` | opencode, kilo, devin, hermes | none |
| The live tail's mode | `watcher/watcher.ts:140`, `:341`, `:428-456` | cursor re-reads and diffs (it rewrites in place) | append |
| Paging rules and cursors | `lib/transcriptPages.ts:358-419` | claude record id, codex line index | — |
| Attach rules from the end | `lib/attachTranscript.ts:291`, `:308` | claude, codex | — |
| Claude Code's normalizer | `lib/normalize.ts` (977 lines) | claude, as the shared default | — |

### 3.8 Where conversations live: repair, checkpoint, purge, titles, search (lines 78, hits about 120, plus 2,876 lines of search adapters)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Transcript roots | `registry.ts:758` `TRANSCRIPT_ROOT`, `:791` moved homes | ten folders; null for the four database engines | — |
| A path shape a transcript must have | `registry.ts:806` | cursor | none |
| A transcript path to expect from an id | `registry.ts:1560-1572` | commandcode, grok, agy, copilot | null |
| Find a live process's session after a restart | `lib/sessionRepair.ts:275-429`, 13 cases | pid records (claude, codex, copilot, agy), folder scans, SQL on four stores | cursor: null |
| A transcript continued in a new session | `sessionRepair.ts:524-560` | claude | — |
| Export a database conversation for a checkpoint | `lib/sessionCheckpoint.ts:19-47`, `:109-114` | the four databases; pi writes lazily | — |
| Plan deleting a conversation | `lib/purgeAgentService.ts:40-78` | the four databases (opencode `session_v2` too); file-name shapes per engine | — |
| Data that must never be inside a deletable worktree | `lib/worktreeDeletion.ts:89-92` | 14 homes | — |
| An empty new chat, and busy footers, at close | `lib/closeAgentService.ts:26`, `:40` | claude, codex | unknown |
| Database engines are not found for a handoff | `lib/handoffDiscovery.ts:26`, `:39-51` | four databases; claude uses its pid record only | — |
| Cleaning a terminal title, product names, the engine's own title | `lib/sessionTitle.ts:23-110` | codex index and status; opencode and kilo prefixes | trim |
| Tool calls, work and output stats from rows | `lib/sessionWork.ts:336-362`; `lib/agentOutputStats.ts:186-206` | claude, codex, twice | nothing |
| Records that count as activity | `lib/transcriptActivity.ts:31`, `:97` | claude, codex | null |
| Search: the line normalizer per engine | `lib/sessionSearch/transcript.ts:33-63` | ten engines | header only |
| Search: conversations Harness did not start | `lib/sessionSearch/externals/` (12 files, 2,876 lines, 13 providers; opencode's serves kilo) | every engine but amp | — |

### 3.9 Reading the screen (lines 34, hits about 40)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Which reader reads a dialog | `lib/askQuestion.ts:182-229` `parseEngineQuestionPane` | eleven readers | the numbered-row reader (claude, commandcode, and pi and terminal when asked) |
| Whether a pane is polled for questions | `askQuestion.ts:1063` | 13 engines | pi not |
| The key that submits a multi-select | `askQuestion.ts:295` | devin `Enter` | `Tab` |
| Keys that select a row | `askQuestion.ts:673-676` | amp, codex, kilo (redundant with row data) | the digit |
| The composer's prompt marker | `lib/runtimeProfileController.ts:287-292` | cursor `→`, devin `❭›❯`, opencode `┃` (never reached) | `[›❯]` |
| Which reader inspects the pane | `runtimeProfileController.ts:294-320` | pi, opencode and copilot (gutter box), grok | the marker reader |
| Plan mode on screen | `runtimeProfileController.ts:311` | codex `plan mode` | `plan mode on` |
| The dial's busy label | `cable/terminalActivity.ts:9-29`; the same gate at `cli.ts:3938` | claude, codex | none |
| Is the agent working | `lib/runtimeActivity.ts:16-77` (`CodexActivityReader`) | codex app-server; claude and codex pane | unknown |
| Team writes wait for a multi-line draft | `teams/preflight.ts:17`, `:24` | claude, codex, cursor, hermes | no |

### 3.10 Typing into the pane (lines 30, hits about 25)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| How long to wait before checking a submit | `lib/sessionInput.ts:568-592`, 13 constants | claude 3000 ms; five engines 2500; five 6000; agy 8000 | 1500 |
| Typing while a turn runs | `sessionInput.ts:67` | claude, codex | held in the daemon's queue |
| How a submit is confirmed | `sessionInput.ts:595-726` | cursor reads its composer; nine engines trust the transcript; commandcode reads `esc to interrupt` | the composer (devin lands here, though its comment says otherwise) |
| Clear the composer, settle after a turn | `sessionInput.ts:337`, `:362`, `:431`, `:495` | cursor `C-u`, 750 ms | nothing |
| Claude's pasted-content wrapper | `sessionInput.ts:299`; `teams/promptScope.ts:9`, `:71` | claude | the exact text |
| Harness's paste opens the turn | `core/input.ts:93` | commandcode | — |
| `/goal` and `/loop` | `lib/goalCommand.ts:22`, `:29` | claude both; codex `/goal` | neither |
| Device input route and busy mode | `lib/autonomous-device/input.ts:7`, `:109`, `:187` | claude native queue; codex steering from 0.106 | the legacy route |
| Device error wording | `lib/deviceErrors.ts:26` | claude; codex's usage-limit rewrite applied to every engine | generic |

### 3.11 Models and effort (lines 45, hits about 60, plus about 3,000 engine lines)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| Engines a profile id may name | `lib/runtimeProfile.ts:133` `PROFILE_RE` | 14 names in a regex | fails to parse |
| Valid effort words | `runtimeProfile.ts:134-140` | the union of seven engines' sets | — |
| May the model be switched | `runtimeProfile.ts:255-270` | claude from 2.1.153; codex 0.144 and 0.145 only | view-only |
| The model catalog | `runtimeProfile.ts:1150-1157` | claude aliases, codex `models_cache.json` (seven other builders are never called) | none |
| Model, effort, mode from a transcript record | `runtimeProfile.ts:712-764` | codex, cursor, commandcode, grok readers | Claude Code's reader, run on every other engine's records |
| From config files | `runtimeProfile.ts:772-861` | hermes, muse, amp, commandcode, claude; catalog warm-up for opencode, kilo, devin | none |
| From the pane | `runtimeProfile.ts:863-1034` | ten readers | Claude Code's header regexes, run on copilot, muse, amp |
| Which engines are polled | `cli.ts:3429` (commandcode config, 10 s), `:3450` (six engines' panes, 15 s) | — | reconcile every 5 min |
| Reported model normalised | `runtimeProfile.ts:1049-1050` | claude aliases | as read |
| Refusals before a switch | `runtimeProfileController.ts:658-676` | codex effort and plan mode | — |
| The keys that apply a switch | `runtimeProfileController.ts:680-709` | claude and codex live; six more drivers kept on purpose but unreachable (owner, 2026-07-31) | cursor's driver |
| Account rate limits | `lib/accountUsage.ts` | claude, codex | — |

### 3.12 One-shots, voice routing and token usage (lines 17, hits about 60)

| Decision | Where | Engines → value | Default |
|---|---|---|---|
| How a one-shot prompt runs | `lib/oneshot.ts:860-880`, seven worker classes; `runGrokOneShot` | claude, codex, cursor, opencode, kilo, pi, commandcode; grok on argv | none |
| Which engines are pre-warmed | `lib/disposableOneShotPool.ts:1-189` (seven keys in four places); `oneshot.ts:995` (kilo missing) | seven | — |
| The voice router's engine and model | `lib/voiceRouter.ts:60`, `:93`, `:108-134`, `:480` | priority claude > codex > … > grok; claude `VOICE_ROUTE_MODEL` | not chosen |
| Token usage | `lib/agentTokenUsage.ts:44-132`, `:283`; `core/turns/funnel.ts:102` | claude, codex from the transcript; opencode from its store | none |
| Device result evidence | `lib/autonomous-device/resultEvidence.ts:25-98`; `service.ts:109`, `:616` | claude, codex | not evidence-managed |

### 3.13 Not engine behaviour, and left alone

`'terminal'` checks (the plain shell is a core concept: about 40 sites across the reports), `typeof engine`
guards and `ENGINES.includes` validation (about 15), and the local-model runtimes `ollama`, `grid`,
`lm-studio` and `llama.cpp` in `lib/appModels.ts` and `lib/localModels.ts` (14 lines), which are not agent
engines at all. Shared vocabulary that is deliberately merged across engines also stays shared: the
dialog footers in `lib/dialogEnd.ts`, the approval and row wording in `askQuestion.ts`, and the prompt
wrappers search strips; they recognise any engine's text because the dialog above the live one can be
any engine's.

## 4. The interface

One `Engine` object per engine, made of small facets. A facet is one job (launching, reading the
transcript, reading the screen, …), so a caller depends on the one facet it uses, and an engine that
lacks a whole job (no hooks, no database, no model picker) leaves the facet out instead of answering
`null` from twenty methods. Every facet is optional except the manifest; every member of a facet is
optional unless marked required. What shared code does when a member is missing is written beside it,
and is the same fallback the guard in section 6 uses when the member throws.

Two rules shaped every signature:

- **Written against the code as it is.** Each member replaces branches listed in section 3, with the
  types those branches use today (`RegisteredSession`, `LiveEvent`, `QuestionView`, `RuntimeState`,
  `EngineInstallRecipe`, `GridEngineLaunch`, …). Where the same decision is made in several places that
  disagree (section 9), the member is defined once and the disagreement is listed as a fix for after the
  moves, not resolved silently during one.
- **Data where the code is a table, a method where it is behaviour.** Commands, aliases, flags, install
  recipes, labels, timings and capability flags are fields; tests can enumerate them, and the manifest
  can be loaded without loading behaviour.

```ts
// src/engines/engine.ts
export interface Engine {
  readonly name: ProcessEngine
  readonly manifest: EngineManifest   // required: loaded with the daemon (section 6)
  readonly launch?: EngineLaunch       // starting, resuming and forking the CLI
  readonly transcript?: EngineTranscript // reading what it writes: live, at attach, history, last turn
  readonly sessions?: EngineSessions   // where conversations live; binding, repair, purge, search
  readonly screen?: EngineScreen       // reading the pane: dialogs, footers, activity
  readonly input?: EngineInput         // typing into the pane
  readonly hooks?: EngineHooks         // hooks and plugins, and what each hook event means
  readonly models?: EngineModels       // model and effort: read, list, switch
  readonly oneShot?: EngineOneShot     // a prompt outside a session: recaps, voice routing
}
```

### 4.1 The manifest (required, loaded with the daemon)

```ts
export interface EngineManifest {
  readonly label: string                         // 'Claude', 'Antigravity'          (agentNames.ts ENGINE_LABELS)
  readonly command: string                       // 'claude', 'cursor-agent', 'cmd'  (engineBin.ts ENGINE_CLI_COMMANDS)
  readonly pathEnv: string                       // 'CLAUDE_PATH'; the launch binary is process.env[pathEnv] || command
  readonly aliases: readonly string[]            // names discovery accepts         (ENGINE_CLI_ALIASES)
  readonly sharedAliases?: readonly string[]     // cursor and grok: ['agent']; drives the alias-ownership rules
  fallbackExecutables?(): readonly string[]      // cursor: ~/.local/bin/agent; grok: $GROK_HOME/bin/grok first
  claimsAliasTarget?(realPath: string): boolean  // cursor: the versions/<v>/cursor-agent layout
  readonly install: EngineInstallRecipe          // (engineInstall.ts ENGINE_INSTALL)
  readonly process: {                            // recognising it in a pane       (tmux.ts)
    readonly signature: { basenames: readonly RegExp[]; entrypoints: readonly RegExp[] }
    veto?(row: ProcessMatchRow, at: ProcessMatchContext): boolean        // agy: the IDE's .app binary is not agy
    evidence?(row: ProcessMatchRow, at: ProcessMatchContext): 0 | 2 | 3  // claude, cursor, hermes, commandcode
    readonly resumeInArgv?: { flags: readonly string[]; id: RegExp; unless?: readonly string[] } // (tmux.ts RESUME_ARGS)
  }
  readonly home?: {                              // a non-default home for this engine (codex, hermes, claude)
    readonly env: string                         // 'CODEX_HOME'
    default(): string
    readonly perAgent?: boolean                  // read off the process and kept on the row (codex, hermes)
    readonly adoptsMovedHome?: boolean           // a home moved by the user's shell (claude, codex)
  }
  readonly history: 'file' | 'database'          // opencode, kilo, hermes, devin keep a database
  readonly transcriptRequired: boolean           // may it bind with no transcript path; replaces four lists (section 9)
  readonly sessionIdPattern?: RegExp             // grok, agy, copilot: a UUID
  readonly hookStyle: 'shell' | 'plugin' | 'none'
  readonly tuiOwnsScrollback?: boolean           // grok
  readonly search?: () => Promise<SearchProvider> // the search process's reader, loaded only there
}
```

`transcriptRequired` and `sessionIdPattern` are in the manifest, not in the sessions facet, because the
registry checks them in `load()`, at boot, before any engine has been loaded.

Shared code builds from the manifests what it builds from twelve-way tables today: the launch binary
(`engineBin`), the alias-ownership snapshot, the process match, the install recipe unless a path
override is set (one helper instead of six copies), the hook validator's engine list, and the label.

### 4.2 Launch

```ts
export interface EngineLaunch {
  readonly permissionModes?: Readonly<Record<string, readonly string[]>> // claude, codex, cursor, opencode; the
                                                 // legacy yes/no flag is permissionModes.auto (they are equal today)
  readonly firstPromptArgs?: readonly string[]   // opencode ['--prompt'], claude [], codex [], hermes ['chat','-q'];
                                                 // absent: PROMPT_UNSUPPORTED
  namedAgentArgs?(agent: string, machine: EngineMachine): readonly string[] | null  // opencode v1; null: unsupported here
  readonly resumeArgs?: { args: readonly string[]; position: 'flag' | 'subcommand' } // all 14 today
  readonly forkArgs?: { lead: readonly string[]; after?: readonly string[] }        // claude, codex; absent: handoff fork
  readonly launchScript?: { requiresShell?: boolean; functions(): string; invoke(tmuxBinary: string | null): string } // codex
  readonly instructions: { files: readonly string[]; createAs: string; importsAgentsMd?: boolean } // required
  contextArgs?(contextFile: string): string[]    // claude, pi (dsh/adapters.ts)
  envArgs?(env: Record<string, string>): string[] // codex
  readonly projectTrust?: { trusts(path: string, home?: string): boolean; record(cwd: string, home?: string): 'trusted' | 'already' | 'skipped' } // claude, codex
  subscriptionModel?(model: string, machine: EngineMachine): SubscriptionModelLaunch | null // claude, codex, hermes, opencode
  readonly grid?: { build(o: GridLaunchOverride, m: EngineMachine): GridEngineLaunch; requiresModel?: boolean;
                    webSearchUnsupportedReason?(m: EngineMachine): string | null; conflictingEnv?: readonly string[] }
                  | { refused: string }      // absent: GRID_ENGINE_UNSUPPORTED with the default reason
  readGridAssignment?(env: Record<string, string>, args: string): Promise<GridAssignment | null>
  readonly profileHome?: { installHooks(port: number, home: string): void } // codex: CODEX_HOME per agent; absent: refuse codexHome
  ownLoginArgs?(home: string | null | undefined): string[]   // codex -c model_provider=…
  freshLaunchEnv?(env: Record<string, string>, permissionMode: string): Record<string, string> // opencode house model
  permissionEnv?(env: Record<string, string>, permissionMode: string): Record<string, string>
  beforeCreate?(ctx: { hookPort: number }): void            // opencode reinstalls its plugin
  machineFacts?(): Partial<EngineMachine>                    // opencode major version, hermes system-managed
  prepareResume?(row: RegisteredSession): { repairedItems: number; repairedBytes?: number; backupPath?: string } // codex rollout repair
  beforeStop?(row: RegisteredSession, current: () => boolean): Promise<void> // codex shared app-server unload
  readonly resumedSessionModel?: {               // opencode: set a resumed session's model in its store
    preflight(m: EngineMachine): { error: string; detail: string } | null
    apply(i: { sessionId: string; model: string; cwd?: string; checkCatalog: boolean; machine: EngineMachine }): Promise<{ ok: true } | { ok: false; code: string; detail: string }>
  }
}
/** Facts about this machine that some engine's launch needs; composed from every loaded engine's machineFacts. */
export type EngineMachine = Readonly<Record<string, unknown>>
```

### 4.3 Transcript

```ts
export interface EngineTranscript {
  /** The per-session state that folds lines into events (today's normalizers and database readers). */
  createSession(session: RegisteredSession, ctx: TranscriptContext): EngineSession
  readonly attach: {
    readonly from: 'end' | 'start' | 'store'   // claude, codex read from the end; database engines poll
    rules?(fields: (line: string) => readonly RuntimeField[]): AttachRules // 'end' only
    readonly paneLinesAtAttach?: number        // cursor, opencode 100; grok, agy, devin 60: chips from the footer
    settleFoldedTurn?(at: { lines: readonly string[]; pane: string | null }): boolean // agy (pane idle), copilot (records)
  }
  readonly tail?: 'append' | 'rewrite'         // cursor rewrites its transcript in place
  turnAbortedBy?(line: string): { message: string; deviceMessage?: string } | null // codex, commandcode
  lastTurnText?(session: RegisteredSession): Promise<LastTurnText | null>          // all 14; absent: null
  historyPage?(session: RegisteredSession, ask: { limit?: number; before?: string }, ctx: HistoryContext): Promise<HistoryAnswer>
  storedConversation?(session: RegisteredSession): Promise<readonly LiveEvent[]>   // the 4 database engines
  submittedPrompt?(text: string): string       // claude: strip the <pasted_content> wrapper
  subagentActive?(transcriptPath: string, agentId: string): boolean               // claude's subagents/ folder
  readonly usage?: TokenUsageReader            // claude, codex (transcript); opencode (store)
  toolEvents?(row: Record<string, unknown>): Iterable<ToolEvent> // claude, codex: work and output stats
  activityAt?(row: Record<string, unknown>): number | null      // claude, codex: records that count as activity
  deviceEvidence?(io: DeviceEvidenceIO): { ingest(row: Record<string, unknown>): void } // claude, codex
}

export interface EngineSession {
  ingest(line: string): LiveEvent[]            // file engines; a database reader polls instead
  readonly turnOpen: boolean
  closeTurn(): LiveEvent[] | void
  abortTurn?(): LiveEvent[]                    // copilot, agy, grok on a failed Stop
  openTurn?(userMessage?: string): LiveEvent[] // commandcode: Harness's own paste opens the turn
  start?(): Promise<void>                      // database readers begin polling
  stop?(): void
  readonly thinkingPrefix?: string             // set by a fold from the end (claude, codex)
}

export interface HistoryAnswer {
  events: SessionEvent[]; timestamp: string; hasMore?: boolean; oldestCursor?: string | null
  staleCursor?: true; truncated?: true
}
```

`TranscriptContext` is what the core lends a session: `emit`, `announceTurnAborted`, the data folder.
`HistoryContext` lends the one `TranscriptPager` the core owns, so its line indexes stay shared.

### 4.4 Sessions

```ts
export interface EngineSessions {
  readonly store: FileStore | DatabaseStore
  readonly resetOnSessionStart?: boolean       // a repeated SessionStart re-folds; default true; cursor, agy, copilot false
  readonly replayTranscriptOnBind?: boolean    // cursor
  isSubagent?(transcriptPath: string): boolean // codex: a sub-agent rollout is never a session (three copies today)
  repairOnLoad?(sessionId: string, transcriptPath: string, home?: string | null): string | null | undefined // codex parent rollout
  findLive?(q: { cwd: string; startedAtMs: number; bornOnly?: boolean; pid?: number; home?: string }): Promise<RepairedSession | null>
                                               // rebinding after a restart: 12 engines; cursor has none
  sessionForPid?(pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null> // claude's pid record
  locate?(sessionId: string, at: { cwd?: string | null; home?: string | null }): Promise<string | null>
                                               // the transcript of a known id: one member for three places that disagree
  followSessionSwitch?(agent: RegisteredSession, observed: DiscoveredTerminalAgent): Promise<SessionSwitch | null>
                                               // copilot /resume in process; claude continued-in
  provenCwd?(transcriptPath: string, cwd: string): string | null // claude: the transcript's folder decides
  readonly projectDirFromCwd?: boolean         // grok, agy, copilot
  readonly titles?: { clean?(title: string, cwd?: string | null): string; productNames?: readonly string[];
                      ownTitle?(sessionId: string, home?: string | null): string | null } // codex index and status line
  readonly close?: { emptyUntilBound?: boolean; busyFooter?: RegExp } // claude, codex
  dataRoots?(): string[]                       // folders a worktree deletion must never contain
}

export interface FileStore {
  readonly kind: 'file'
  roots(home?: string | null): string[]        // TRANSCRIPT_ROOT, and a moved or per-agent home
  acceptsPath?(realPath: string): boolean      // cursor's agent-transcripts/<id>/<id>.jsonl
  expectedPath?(sessionId: string, cwd: string | null): string | null // commandcode, grok, agy, copilot
  fileMatchesSession?(path: string, sessionId: string): boolean      // purge
  readonly writesLazily?: boolean              // pi announces its id before it writes the file
}

export interface DatabaseStore {
  readonly kind: 'database'
  databasePath(session: SessionRef): string | Promise<string> // hermes: per profile home
  readonly exportSelections: readonly (readonly [table: string, where: string])[] // checkpoint
  deletionPlan(query: (sql: string) => Promise<SqliteRow[]>, idLiteral: string): Promise<{ sessionTable: string; children: [string, string][] }>
}
```

Session search keeps its own contract (`ExternalProvider` in `lib/sessionSearch/externals/types.ts`, which
is already engine-agnostic in its consumers) and reaches each engine's adapter through
`manifest.search`. Each process builds its own providers from the factory, because they hold caches. An
engine's search module may import its normalizer and its store reader, never `src/core`: the search
process today loads 98 modules (about 25,000 lines); importing every module under `src/engines` would add
32 files and about 3,900 lines, none of them core, which is acceptable, and per-engine search modules keep
it lower still.

### 4.5 Screen and input

```ts
export interface EngineScreen {
  readonly paintsDialogs: boolean              // polled for questions: 13 engines, not pi
  readDialog?(capture: string): PaneView       // absent: the numbered-row reader from kit/ (claude, commandcode)
  inspect?(capture: string): PaneInspection    // idle, draft, dialog, plan; absent: the marker reader from kit/
  readonly promptMarker?: RegExp               // cursor →, devin ❭›❯; default [›❯]
  readonly planMode?: RegExp                   // codex 'plan mode'; default 'plan mode on'
  activity?(screen: string): { label: string; indicator: string } | null // the dial's busy label: claude, codex
  probeActivity?(session: RegisteredSession): Promise<ActivityState>    // codex app-server thread/read
  stoppedGoal?(screen: string | null): boolean // codex
  composerHolds?(capture: string, content: string): boolean
  workingOnScreen?(capture: string, content: string): boolean           // commandcode, cursor
  readonly composer?: { marker: RegExp; multilineDraft?: boolean; firstLineTextIsPlaceholder?: boolean } // team drafts
}

export interface EngineInput {
  readonly submitVerifyMs?: number             // claude 3000; opencode, kilo, pi, hermes, devin 2500;
                                               // commandcode, muse, amp, grok, copilot 6000; agy 8000; default 1500
  readonly typesWhileBusy?: boolean            // claude, codex
  readonly submitEvidence?: 'pane' | 'transcript' | 'composer-echo' // default 'pane'; cursor 'composer-echo'
  readonly clearComposerKey?: string           // cursor 'C-u', before a paste and after its echo
  readonly turnEndSettleMs?: number            // cursor 750
  readonly commands?: { goal?: boolean; loop?: boolean } // /goal: claude, codex; /loop: claude
  deviceBusyMode?(cliVersion: string | undefined): 'native_queue' | 'steering' | 'native_input' // claude, codex
  errorText?(message: string): string | null   // device error wording
}
```

### 4.6 Hooks

```ts
export interface EngineHooks {
  install(port: number): void                  // 13 engines; muse has none
  installIn?(port: number, home: string): void // claude, codex: a moved or per-profile home
  readonly trustPaneWithoutAncestry?: boolean  // cursor
  admit?(body: HookBody): Promise<HookAdmission> // codex rejects sub-agents; hermes holds until its store says
  transcriptFor?(body: HookBody, agent: RegisteredSession | undefined): string | undefined // claude after a cross-folder resume
  onTurnStart?(ctx: HookTurnContext, sessionId: string): void          // commandcode
  onToolStart?(ctx: HookTurnContext, body: ToolStartBody): void        // cursor Task sub-agents
  onStop?(ctx: HookTurnContext, body: { sessionId: string; status?: string }): Promise<void> // claude, cursor,
                                               // commandcode, devin, copilot, agy, grok; absent: ignored
  start?(ctx: EngineRuntimeContext): void      // cursor transcript discovery and task replay; claude cwd repair
  stop?(): void
  forgetSession?(sessionId: string): void      // agy idle watch, cursor sub-agents and pending tasks
  cancelTurn?(sessionId: string): void         // cursor
}
```

`HookTurnContext` is the core's side: the session's `EngineSession`, `drain`, `emit`,
`announceTurnAborted`, `noteEngineStopped`, `captureTerminal`, the grace period. The four Stop handlers
that repeat "drain, wait, drain, close" use one helper from `kit/`.

### 4.7 Models

```ts
export interface EngineModels {
  readonly efforts: ReadonlySet<string>        // required when present; validates a profile against its own engine
  readTranscript?(raw: Record<string, unknown>, state: RuntimeState, ctx: RuntimeReadContext): void
  readonly readsTranscriptFromEnd?: boolean    // claude, codex
  readConfig?(session: RegisteredSession, state: Readonly<RuntimeState>): Promise<Partial<Pick<RuntimeState, 'model' | 'effort'>> | null>
  warmCatalog?(session: RegisteredSession): Promise<void>
  readPane?(pane: string, ctx: PaneReadContext): PaneObservation | null
  readonly pollPaneMs?: number                 // devin, cursor, grok, agy, opencode, kilo: 15000
  readonly pollConfigMs?: number               // commandcode: 10000
  canonicalModel?(model: string): string       // claude: claude-opus-5… → opus
  fallbackEffort?(model: string, cliVersion: string | null): string | null
  forget?(sessionId: string): void
  readonly switching?: {                       // claude and codex only (owner, 2026-07-31)
    supports(session: RegisteredSession): boolean
    models(session: RegisteredSession, state: Readonly<RuntimeState>): Promise<RuntimeModelOption[]>
    effortAllowed?(model: string, effort: string): boolean
    readonly refuseInPlanMode?: boolean
    readonly opensPicker: boolean
    apply(session: RegisteredSession, target: RuntimeProfile, current: RuntimeProfile | null, options: RuntimeModelOption[], io: RuntimeControlIO): Promise<void>
  }
  readonly accountUsage?: { provider: UsageProviderId; read(deps: AccountUsageDeps): Promise<AccountUsageReading> } // claude, codex
}
```

### 4.8 One-shot

```ts
export interface EngineOneShot {
  readonly prewarm: boolean                    // claude, codex, cursor, opencode, pi, commandcode, kilo; grok false
  createWorker?(o: { cwd: string; model?: string; effort?: OneShotOptions['effort'] }): Promise<DisposableWorker<OneShotOptions, OneShotResult>>
  run?(o: OneShotOptions): Promise<OneShotResult> // grok: argv, not a worker
  readonly routerRank?: number                 // voice router priority: claude 1 … grok 8
  routerModel?(): string                       // claude: VOICE_ROUTE_MODEL
}
```

### 4.9 Size, and what each engine fills in

Counted from the blocks above: **132 top-level members in 13 interfaces (nine facets, the manifest, the
session object and the two stores), 74 methods and 58 data fields**, plus a few nested members (the
process match, the attach strategy, model switching). About 20 are required: `name`, the manifest's
identity fields (`label`, `command`, `pathEnv`, `aliases`, `install`, the process signature, `history`,
`transcriptRequired`, `hookStyle`), and inside a facet that is present, its core (`createSession` and
`attach`, `store`, `paintsDialogs`, `efforts`, `prewarm`, `install`, the session's `ingest`, `turnOpen` and
`closeTurn`). The rest are optional, because for each of them at least one engine has nothing to say.

That is larger than "a few small interfaces", and it is the honest size: it is what the code decides
per engine today, minus the decisions that turned out to be duplicates. Most engines fill far fewer
members than that. What each engine fills, in short:

| Engine | Launch | Transcript (attach; history) | Store | Screen and input | Hooks | Models | One-shot |
|---|---|---|---|---|---|---|---|
| claude | modes, first prompt, fork, trust, `CLAUDE.md`, grid, subscription | from the end; pages | file; pid record; continuation; cwd proof | kit dialog reader; types while busy; 3000 ms; `/goal`, `/loop`; busy label | install, `installIn`, `onStop`, `transcriptFor` | switching from 2.1.153; transcript, config and pane readers | yes, rank 1 |
| codex | modes, first prompt, fork, launch script, profile home, own login, resume repair, stop unload, grid | from the end; pages; failed-turn lines | file; sub-agent check; rollout repair on load | dialog labels; types while busy; plan mode; activity probe; stopped goal | install, `installIn`, `admit` | switching on 0.144 and 0.145; catalog cache | yes, rank 2 |
| cursor | modes (`auto`, `ask`) | capped tail; rewritten in place; footer at attach; windowed | file, path shape | permission rows; composer echo, `C-u`, 750 ms settle | install, `onStop`, `onToolStart`, pane trust, start, forget, cancel | pane reader, polled | yes |
| opencode | modes, first prompt, named agent (v1), house env, plugin reinstall, grid, subscription, session model | database reader; footer at attach; windowed | database (with `session_v2`) | review and question readers; transcript-confirmed submit | plugin | pane reader, polled; catalog | yes |
| pi | context argv, grid | capped tail; windowed | file, written lazily | not polled for dialogs; gutter-free footer reader | extension | pane reader | yes |
| hermes | first prompt, grid, subscription | database reader (per profile home); windowed | database | framed dialog reader | install, `admit` (holds) | config and pane readers | no |
| commandcode | — | capped tail; failed-turn lines; windowed | file, expected path | kit dialog reader; `esc to interrupt`; 6000 ms | install, `onTurnStart`, `onStop` | config polled every 10 s; pane reader | yes |
| devin | — | database reader with turn abort; footer at attach; windowed | database | its own rows, `Enter` submits | install, `onStop` | pane reader, polled | no |
| muse | — | capped tail; whole page | file | its own dialog reader; 6000 ms | none | config reader | no |
| amp | — | capped tail of the plugin's file; history from Amp's export | file (plugin-written) | unnumbered rows walked with `Down`; 6000 ms | plugin | mode reported as the model | no |
| kilo | — | database reader; windowed | database | horizontal rows walked with `Right` | plugin | pane reader, polled | yes |
| grok | grid | capped tail; footer at attach; whole page | file, UUID ids, expected path | `(●)` rows; owns its scrollback | install, `onStop` (errors) | transcript and pane readers, polled | argv, rank 8 |
| agy | `GEMINI.md` | capped tail; footer at attach; settled from the pane; whole page | file, UUID ids, expected path | its own dialog reader; 8000 ms | install, `onStop` (`waiting` backstop) | pane reader, polled | no |
| copilot | grid (model required) | capped tail; settled from the records; whole page | file, UUID ids, session switch in process | dialog with its subject folded in; 6000 ms | install, `onStop` | — | no |

Every engine also fills the manifest and `resumeArgs` (all fourteen resume today).

## 5. Where the code goes

```
src/engines/
  engine.ts            the Engine interface and its facets (types only)
  facets/              one file of types per facet, so parallel steps edit different files
  registry.ts          MANIFESTS (eager) · engineFor · loadEngine
  guard.ts             engineOf: every call wrapped, with its fallback; onDegraded
  kit/                 engine-agnostic pieces engines compose: history windowing for files and
                       databases, the numbered-row dialog reader, "drain, wait, close" for Stop hooks,
                       the gutter-box pane reader. Never names an engine.
  types.ts             ENGINES, AgentEngine, ProcessEngine, isTerminalEngine (as today)
  claude/  codex/      built in
  cursor/ opencode/ pi/ hermes/ kilo/ devin/ amp/ agy/ grok/ copilot/ commandcode/ muse/
    manifest.ts        loaded with the daemon
    index.ts           the Engine: imports its facet files
    transcript.ts  sessions.ts  screen.ts  input.ts  launch.ts  hooks.ts  models.ts  oneShot.ts
    search.ts          imported only by the search process
    normalizer.ts reader.ts askQuestion.ts runtimeProfile.ts …   (the files each folder has today)
```

This is the layout at the end. While the moves run, `index.ts` does not exist yet and each facet has a
table file in `src/engines/` instead (section 8.1, rule 5), so that parallel lanes do not all edit the
same fourteen files.

**One file per facet in each engine folder.** Each migration step adds one facet to every engine. If
the facets lived in one `index.ts` per engine, every parallel step would edit the same fourteen files.
With a file per facet, a step adds `screen.ts` to each folder and one line to each `index.ts`; the first
step writes every `index.ts` with all facet lines present and commented out, one blank line apart, so
two steps that each uncomment one line never touch adjacent lines and git merges them cleanly.

**The kit is not a default.** When two or more engines share a piece today (the numbered-row dialog
reader serves Claude Code, Command Code, Codex and Hermes; OpenCode and Copilot share the gutter-box
footer reader; four Stop hooks repeat "drain, wait, drain, close"), that piece goes to `kit/` and each
engine that uses it says so in its own folder. No engine gets anything it does not name. That replaces
the `else` branch that gives an unnamed engine Claude Code's behaviour.

**Claude Code's folder, `src/engines/claude/`.** Claude Code has no folder today. Its behaviour is the
default in shared code, so its folder is assembled from pieces that are spread out:

| Piece | Today | Goes to |
|---|---|---|
| The transcript normalizer: `transformLine`, `messagesToEvents`, `lineToEvents`, `TurnState`, `windowRawLines`, `claudePageLine`, `startsClaudeTurn`, `claudeToolLinks`, `selectClaudeRecapLine`, `lastTurnTextFromRawLines`, `SubagentStats` | `lib/normalize.ts` (977 lines, imported by 44 files) | `claude/normalizer.ts`; the event types (`LiveEvent`, `SessionEvent`, `LastTurnText`) and `foldTranscript`/`TranscriptFold` stay in `lib/normalize.ts`, which shrinks to the shared part |
| Attach rules read from the end | `claudeAttachRules` in `lib/attachTranscript.ts` | `claude/transcript.ts` (the attach machinery stays in lib) |
| History pages | `TranscriptPager.claude` in `lib/transcriptPages.ts` | the pager takes `PageRules` from the engine; the rules go to `claude/transcript.ts` |
| Sub-agent transcripts (`<session>/subagents/agent-<id>.jsonl`) | `enrichSubagentStats` in `core/transcripts/history.ts`, `subagentActive` in `core/turns/recaps.ts` | `claude/transcript.ts` |
| Last turn for the recap | `core/transcripts/lastTurn.ts`, the `claude` line | `claude/transcript.ts` |
| Project pre-trust | `lib/claudeTrust.ts`, `lib/claudeProject.ts` | `claude/launch.ts` |
| Transcript roots, resume lookup, continuation, cwd repair | `lib/registry.ts`, `lib/sessionRepair.ts`, `lib/cwdRepair.ts`, `lib/captureResumeIdentity.ts` | `claude/sessions.ts` |
| Hooks: settings.json events, the Stop handling | `lib/hooks.ts` `installSessionHooks`, `core/turns/turnHooks.ts` the default branch, `hookServer.ts` `knownTranscriptFor` | `claude/hooks.ts` |
| The question dialog | the default branch of `parseEngineQuestionPane` (`parseQuestionPane`) | `kit/` (it is shared with three engines); `claude/screen.ts` names it |
| Pasted-content wrapper, busy footer, native queue | `lib/sessionInput.ts`, `teams/promptScope.ts`, `cable/terminalActivity.ts`, `lib/autonomous-device/*` | `claude/input.ts`, `claude/screen.ts` |
| Models and effort | `RuntimeProfileManager.claudeModels`, `claudeAliasForModel`, `claudeEfforts` in `lib/runtimeProfile.ts` | `claude/models.ts` |
| Recap one-shot, `/goal` and `/loop`, instruction file name | `lib/oneshot.ts`, `lib/goalCommand.ts`, `dsh/runtime.ts`, `lib/apiInstructions.ts` | `claude/oneShot.ts`, `claude/launch.ts` |
| Account usage | `lib/accountUsage.ts` `readClaude` | `claude/models.ts` |
| Search adapter | `lib/sessionSearch/externals/claude.ts` | `claude/search.ts` |

Codex already has a folder; its pieces in shared code (`lib/codexProfiles.ts`, `codexProfileDiscovery.ts`,
`codexHomeProbe.ts`, `codexSessionLifecycle.ts`, `codexStartupRetry.ts`, `codexTurnRecovery.ts`,
`CodexActivityReader` in `lib/runtimeActivity.ts`, `codexAttachRules`, `TranscriptPager.codex`) move into
it the same way.

**What stays in lib.** The machinery that is generic today and only takes engine rules as arguments:
`attachTranscript.ts` (`AttachRules`), `transcriptPages.ts` (`PageRules`), `transcriptTail.ts`,
`tmuxCapture.ts`, the watcher's two tail modes. These already have the right shape; the rules move, the
machinery stays.

**What stays a field of the session row.** `codexHome` and `hermesHome` are engine-specific fields of
the persisted registry, on the wire (`agent_create.codexHome`, `engines_probe.supportsCodexHome`) and in
about 30 shared files. During the moves they stay, read only by the engine that owns each. Renaming them
to one generic `engineHome` is a data migration of `registry.json` and of the wire, so it is its own late
step, done additively (read both, write both, then drop the old) and never inside a move.

## 6. Loading and isolation

### 6.1 Two halves: a manifest loaded with the daemon, the engine loaded on first use

Some questions have to be answered for every engine before any agent of it exists. Discovery scans
every pane for every engine's process. The hook server checks that a posted engine name is one it
knows. The New Harness picker lists every engine, with its install recipe. None of that can wait for an
import. So each engine is split in two:

- **`manifest.ts`**, loaded with the daemon: the `EngineManifest` of section 4.1. Data and a few small
  pure functions (the process score). It imports nothing but types and `config/env.ts`.
- **`index.ts`**, loaded on first use: the `Engine` with every facet.

`src/engines/registry.ts` holds both:

```ts
export const MANIFESTS: Readonly<Record<ProcessEngine, EngineManifest>>   // eager, every engine

/** The engine, if it is loaded. Synchronous, for the call sites that are (a pane parse, a key table). */
export function engineFor(name: string | null | undefined): Engine | undefined
/** Load it. Claude Code and Codex resolve at once; the rest import their folder the first time. */
export function loadEngine(name: ProcessEngine): Promise<Engine | undefined>
```

Claude Code and Codex are imported statically: they are what almost every machine runs, the e2e suite
drives them, and their absence would be a bug, not a choice. The other twelve are
`() => import('./cursor/index.js')` and so on.

**Where loading happens.** An engine is loaded at the four places an agent of it first becomes known,
all of which are already asynchronous: a hook's registration (`hookServer.ts`), discovery identifying a
pane (`core/agents/discovery.ts`), a create or resume request (`core/agents/launches.ts`), and the boot
restore of saved agents (before their attaches run). `attachSession` also awaits `loadEngine` first, as
a backstop. After that every synchronous call site finds the engine loaded. If one does not (a race
not foreseen here), `engineFor` returns undefined and the call takes its fallback from section 6.3, the
same as an engine without that facet, and logs it: never a throw.

### 6.2 What lazy loading buys, measured

The release is one esbuild ESM file with no code splitting (`build-bundle.mjs`). Built with a metafile
on 2026-10-05, the thirteen engine folders are 139 KB of the 3.34 MB bundle (4.2%), and the search
adapters another 56 KB (1.7%). Engine code still in `lib/` (the twelve-way tables, the hook installers
and their embedded plugin sources, the pane readers) is perhaps as much again.

Inside one bundle, a dynamic `import()` does not keep code out of the file. esbuild wraps the module in
an initialiser that runs on first import, so what is saved is the module's evaluation: its top-level
tables, regular expressions and classes, and the bytecode V8 would compile for them. For twelve engines
that is on the order of a megabyte of heap, not tens. To keep the code out of memory entirely the
bundle would need `splitting: true`, which ships chunk files beside `cli.js`; `upload-cli.sh` ships
`cli.js` and `notify.mjs` and nothing else, and the self-updater swaps one file. That is a release
format change and is not part of this plan.

So lazy loading is worth doing for a smaller memory gain than the name suggests, and for two better
reasons:

1. **Isolation at load.** Today a module that throws while it is evaluated stops the daemon from
   starting, for every agent. A lazily loaded engine that throws fails `loadEngine` for that engine
   only: its agents are degraded (section 6.3), and every other agent runs.
2. **A smaller start.** The core evaluates two engines at start instead of fourteen, and the step that
   introduces lazy loading measures the difference (heap after start, with and without, in the e2e
   harness) so the number in this section is replaced by a measured one.

The search service runs in its own process, and imports only what it needs: each engine's search
adapter is its own module (`engines/<x>/search.ts`), reached through the manifest
(`manifest.search?: () => Promise<SearchProvider>`), so the search process never loads an engine's
pane readers or launch code.

### 6.3 The guard: a throw degrades one agent, never the core

Every call from shared code into an engine goes through one wrapper, `src/engines/guard.ts`, applied
where the engine is looked up. Call sites never hold an unguarded engine, so they need no try/catch of
their own, and a new call site cannot forget one.

```ts
/** The engine for this agent, with every method wrapped. Never throws; a throw inside is reported and
 *  answered with the method's fallback. */
export function engineOf(agent: { agentId: string; engine: string }): GuardedEngine
export function onDegraded(listener: (d: Degraded) => void): () => void

interface Degraded { agentId: string; engine: ProcessEngine; facet: string; method: string; message: string; at: number }
```

The wrapper catches synchronous throws and rejected promises, logs them once per agent and method per
minute (a parser that throws on every poll would otherwise fill the log), counts them, and emits
`Degraded`. The core turns that into an additive event on the agent (`agent_degraded`, with the facet),
so a window can say "Harness can't read this agent's questions" instead of failing silently. The
fallbacks are declared once, beside the interface, the way `core/api.ts` declares each port's fallback
beside the port.

What degraded means, method by method:

| Facet, method | Fallback when the engine lacks it or throws | What the person sees |
|---|---|---|
| `transcript.createSession` | none: the agent is not followed | the pane works; no live stream, no turns, a degraded badge |
| `transcript` session `ingest(line)` | `[]` for that line (today's per-line catch in `ingest.ts`, kept) | a gap in the stream; turns may stay open until the next boundary |
| `transcript.lastTurnText` | `null` | no recap text for that turn |
| `transcript.historyPage` | the request fails with `ENGINE_FAILED`, as a failed store read does today | the history pane shows an error and can retry |
| `transcript.settleFoldedTurn` | the fold's own answer | a finished turn may show as working after a restart |
| `screen.readDialog` | `null` (no dialog) | no question card; the dialog is still answerable in the pane |
| `screen.inspect` | `null` | empty chips; a model switch is refused with a reason |
| `screen.activity` | `null` | no busy label on the dial |
| `input.*` (data) | the shared default | today's default behaviour |
| `launch.argv` | the create fails with `ENGINE_FAILED` and the message | the request is refused with a reason; no pane is opened |
| `hooks.install` | skipped | the agent is found by discovery instead of by its hook |
| `hooks.admit` | admit as posted | as today for an engine with no check |
| `turnHooks.onStop` and `onToolStart` | the hook is ignored | the turn closes from the transcript, or stays open (as without hooks) |
| `sessions.find*`, `sessions.repair` | `null` | the agent stays unbound; the reconciler tries again |
| `sessions.purge`, `sessions.checkpoint` | `{ bytes: 0 }` / no checkpoint | the purge reports nothing freed |
| `models.catalog` | `[]` | no model picker |
| `models.set` | the request fails with `ENGINE_FAILED` | the switch is refused with the reason |
| `oneShot.run` | skipped | no recap for that turn |
| `search` adapter | that engine's results are missing; the reply says `partial: true` | search finds the other engines |
| `manifest.process.score` | `0` | a pane of that engine is not recognised until the next scan |
| `loadEngine` | `undefined` for that engine | every agent of that engine is degraded; others run |

Stateful pieces (the per-session normalizer, the database readers' pollers) are wrapped the same way:
the object an engine returns is wrapped method by method. A reader whose poll throws three times in a
row is stopped and its agent degraded, instead of throwing every second for ever.

## 7. The rule test

`src/engineNames.spec.ts`, beside `architecture.spec.ts` and written the same way: it parses each file
with the TypeScript compiler and fails with a message that says where the code belongs.

**What it checks.** In shared code (`src/core`, `src/lib`, `src/cli.ts`, `src/backendSocket.ts`; the
step after the last move adds `src/watcher`, `src/hookServer.ts`, `src/cable`, `src/teams`, `src/dsh`,
`src/services` and `src/device`), without specs:

1. no string literal equal to an engine name (`'codex'`), which catches comparisons, `case` labels,
   lists, sets and quoted keys;
2. no object key or property read named after an engine (`{ claude: … }`, `dbs.opencode`); for
   `cursor`, `pi` and `amp`, which are ordinary words here, only inside an object that has another
   engine's key;
3. no import from `src/engines/<engine>/`; shared code imports `src/engines/registry.ts`,
   `engine.ts`, `guard.ts` and `types.ts` only;
4. no identifier named after an engine (`preTrustCodexProject`, `CODEX_HOME`, `codexHome`), except
   `cursor`, `pi` and `amp` for the same reason.

`'terminal'` is not an engine for this rule: the plain shell is a core concept, and the rule asks for
`isTerminalEngine()` instead of the literal.

**How it lands before the code is clean.** As a ratchet. The first step writes today's count per file
into `src/engineNames.baseline.json`, and the test fails when a file's count goes up or a file not in the baseline names an
engine. Steps do not edit the baseline, so parallel branches never conflict in it; after a batch of steps
merges, one commit regenerates it (`ENGINE_NAMES_BASELINE=write npx vitest run src/engineNames.spec.ts`)
and a reviewer sees the numbers fall. When every
count is zero the baseline file is deleted and the test becomes the plain rule. The test also fails if
the baseline names a file that no longer exists, the way `architecture.spec.ts` fails on an exception
that is no longer needed.

**What it counts, measured.** The committed rule (step 1) counts 2,073 engine names in 115 files on
`main` at `3e67738fe`, summing per file the literals, keys and imports and the distinct engine-named
identifiers. Section 2's figures (2,029 in 113 files) came from a prototype of the same scan on the
older `31b4a0c27`, with a slightly looser identifier pattern; the baseline file is the measure. After
step 1 the count is 1,996 in 113 files (`core/transcripts/lastTurn.ts` 50 and `databaseHistory.ts` 24 go
to zero, `cli.ts` 58 to 55); after step 2, 1,898 in 112 (`core/transcripts/history.ts` 95 to zero,
`cli.ts` to 52).

**Why a parser and not a grep.** The grep in section 2 finds 405 lines, 40 of which are not engine
behaviour, and misses tables, keys, imports and engine-named helpers entirely; a wider grep cannot tell
`'cursor'` the engine from a pagination cursor, or code from a comment. The parser sees literals, keys,
imports and identifiers as what they are.


## 8. Migration

### 8.1 Rules for every step

1. **A step moves code; it does not change behaviour.** Each step moves one group of decisions behind
   the interface, for every engine at once, verbatim where it can be. A bug found while moving is
   written down (section 9) and fixed in its own change after the move, never inside it. The two steps
   that do change behaviour (the guard, step 5, and lazy loading, step 26) are steps of their own.
2. **Pin before moving.** For every engine without a fake in the e2e suite, the step's first commit
   adds or confirms unit tests that pin today's answer through the shared entry point (the history
   request, the last-turn reader, the dialog parser, …). The move must pass them unchanged, apart from
   wiring (a store path that used to be passed in and is now resolved by the engine). Several shared
   specs already pin every engine this way through module mocks (`core/transcripts/history.spec.ts`,
   `lastTurn.spec.ts`); since the engine files import the same engine modules, those mocks keep pinning
   across the move.
3. **The bar for each step:** `tsc`; `npm run test:core` and `npm run test:harnessd` at 100% per file;
   the full unit suite; the e2e files that exercise the moved code, from the bundle
   (`E2E_BUNDLE=1 E2E_WORKERS=2`); the rule test's counts do not rise.
4. **A few popular engines per batch (owner direction, 2026-10-07).** Start with Claude Code and Codex
   and move coherent facets with their existing behavior pinned. Shared callers retain explicit legacy
   paths for engines outside the current batch. This supersedes the original all-fourteen-at-once
   migration rule; it does not relax the boundary, fallback or validation requirements. Add subsequent
   engines in small reviewed batches rather than carrying every recovered lane into one change.
5. **While the moves run, facets are tables.** Each facet has a table file in `src/engines/`
   (`transcripts.ts`, `screens.ts`, …) mapping every engine to its facet object, and `registry.ts`
   assembles an `Engine` from the tables. A lane adds its own table file, its facet files in each engine
   folder, and one line each in `engine.ts` and `registry.ts`; those two lines are the only lines
   parallel lanes share, and a lane that merges second keeps both. The per-engine `index.ts` of section 5
   arrives with lazy loading (step 26), which has to assemble each engine as one module anyway.
6. **Files other branches are changing now are left to the end:** `lib/engineLaunch.ts` (the launch
   script), `teams/preflight.ts` (screen footers), `lib/hooks.ts`, `hook/notify.mjs` and
   `e2e/harness/fakeEngine.mjs`, `lib/tmux.ts` and `lib/tmuxBackend.ts`, the registry's title code, and
   `lib/selfUpdate.ts`. Steps 1 to 20 touch none of them. Where a decision lives in one of those files, its
   callers keep calling the old function, now a one-line wrapper over the registry, until the file is
   free (for example `parseEngineQuestionPane(engine, capture)` and `inspectRuntimePane(engine, capture)`,
   which `teams/preflight.ts` calls).

### 8.2 The steps

Sizes are lines touched, roughly, including specs. Risk is the chance the move changes something a
person sees, given the proof listed.

**Phase A: the core's transcripts (sequential; each needs the one before).**

| # | Step | Files | Size | Risk | Proof |
|---|---|---|---|---|---|
| 1 | The registry, the transcript facet and the rule test; the last turn and the database conversation behind the facet | new: `src/engines/{engine.ts, registry.ts, transcripts.ts, facets/transcript.ts, kit/lastTurn.ts}`, `src/engines/<14>/transcript.ts` (Claude Code's folder is created), `src/engineNames.spec.ts` and its baseline; changed: `core/transcripts/lastTurn.ts`, `databaseHistory.ts`, their specs, `cli.ts` (3 lines of wiring), `engines/README.md` | +700 / −80 | low | `lastTurn.spec.ts` and `databaseHistory.spec.ts` assertions unchanged but for store paths; per-engine pins for the four stores' paths; e2e `fleet` (a dial makes recaps read the last turn), `services`, `serviceProcesses` (the search process reads stored conversations through the registry), `core` |
| 2 | History pages (`session_get`) behind `transcript.historyPage` | `core/transcripts/history.ts` and spec, `src/engines/<14>/transcript.ts`, new `kit/history.ts` (database, windowed-file and whole-file pages), `cli.ts` (deps of `createHistory`) | +550 / −320 | medium: reply shapes | `history.spec.ts` assertions unchanged; e2e `history`, `bounded`, `compaction`, `compat`, `windows`, `rotation`, `forks`, `paused`, `races`, `clockjump` |
| 3 | One table of engine sessions instead of fourteen maps; live ingest behind `createSession` and `turnAbortedBy` | `core/transcripts/normalizers.ts`, `ingest.ts` and specs; the map readers: `core/turns/turnHooks.ts`, `core/turns/funnel.ts` (a type), `core/input.ts`, `core/turns/agyBackstop.ts`, `core/engines/cursorTasks.ts`, `cli.ts` (`:2047-2049`, `:2153`, `:2162`, `:2370`); `src/engines/<14>/transcript.ts` | +450 / −380 | medium: the live path | specs of each; e2e `turns`, `core`, `lifecycle`, `content`, `questions`, `ends`, `chaos` |
| 4 | Attach behind `transcript.attach` | `core/transcripts/attach.ts` and spec; `lib/attachTranscript.ts` (Claude Code's and Codex's rules move out, the machinery stays), `testing/transcriptOracle.ts`; `src/engines/<14>/transcript.ts`; `cli.ts` (attach deps) | +500 / −400 | high: attach is where most races were found | `attach.spec.ts`; `attachTranscript.real.spec.ts` (opt-in, real transcripts); e2e `bounded`, `compaction`, `machine`, `terminal`, `recovery`, `frozen`, `clockjump`, `migration`, `startup` |
| 5 | The guard: every call through `engineOf`, fallbacks, `agent_degraded` | new `src/engines/guard.ts`; `registry.ts`; the call sites of steps 1-4; `core/agents/events.ts` (the additive event); `cli.ts` | +350 / −60 | low; a behaviour change by design (a throw is contained) | unit tests that make each facet method throw and check the fallback and the event; e2e `core`, `robustness` |

**Phase B: everything else that avoids the busy files (parallel lanes; start after step 5).**

The nine lanes (S, I, M, O, U, H, B, Q, L) can run at the same time on separate branches: within a lane the steps
are in order, and between lanes the files are disjoint except for one line each in `engine.ts`,
`registry.ts` and, where noted, a few wiring lines in `cli.ts` in regions no other lane touches. Lane M's
second step waits for lane S's step 7 (both edit `lib/runtimeProfileController.ts`); lane Q waits for lane
B's step 14 (`lib/sessionRepair.ts` imports the pi search adapter).

| # | Lane | Step | Files | Size | Risk | Proof |
|---|---|---|---|---|---|---|
| 6 | S | Dialogs: which reader, polling, multi-select key, row keys | `lib/askQuestion.ts` (dispatch; `parseEngineQuestionPane` stays as a wrapper), new `kit/dialogs.ts` (the numbered-row reader and its helpers, out of `askQuestion.ts` so engines can import them without a cycle), `src/engines/<14>/screen.ts`, `core/transcripts/attach.ts` (`pollsQuestions`) | +500 / −250 | medium | `askQuestion*.spec.ts` with every engine's fixture in `lib/__fixtures__/question-*.txt` and `permission-*.txt`, unchanged; e2e `questions`, `questions-edges`, `compat` |
| 7 | S | Pane inspection, plan mode, the dial's busy label, the activity probe | `lib/runtimeProfileController.ts` (the `inspect*` readers only; `inspectRuntimePane` stays as a wrapper), new `kit/gutterBox.ts`, `cable/terminalActivity.ts`, `lib/runtimeActivity.ts`, `lib/codexTurnRecovery.ts` → `engines/codex/`, `core/turns/activity.ts`, `cli.ts:3938` | +450 / −350 | medium | `runtimeProfileController.spec.ts` (inspection), `terminalActivity`, `runtimeActivity` specs; e2e `turns`, `stall`, `fleet` |
| 8 | I | Typing: submit windows and confirmation, typing while busy, composer clearing, the pasted-content wrapper, Command Code's paste-opened turn, `/goal` and `/loop`, device input modes and error wording | `lib/sessionInput.ts`, `core/input.ts`, `lib/goalCommand.ts`, `teams/promptScope.ts`, `lib/autonomous-device/{input,service,resultEvidence}.ts`, `lib/deviceErrors.ts`, `src/engines/<14>/input.ts` | +450 / −300 | medium | `sessionInput*.spec.ts`, device specs; e2e `content`, `input-safety`, `races`, `fleet`, `teamsProcess` |
| 9 | M | Reading model and effort: profile ids, effort sets, transcript, config and pane readers, polling intervals, normalising | `lib/runtimeProfile.ts` (the readers; the manager stays), `src/engines/<14>/models.ts`, `cli.ts:3426-3458` (pollers driven by the facet) | +1,300 / −1,100 | medium | `runtimeProfile*.spec.ts`, `commandcodeModel.spec.ts`; e2e `compat` (model chips), `services` |
| 10 | M (after 7) | Switching: the gate, catalogs, refusals, the key sequences (the unreachable drivers move with their engines unchanged), account usage | `lib/runtimeProfileController.ts`, `lib/runtimeProfile.ts` (catalogs), `lib/accountUsage.ts`, `src/engines/<14>/models.ts` | +900 / −800 | medium | `runtimeProfileController.spec.ts`; e2e `compat`, `services` |
| 11 | O | One-shots and the voice router | `lib/oneshot.ts` (workers move; the pool and `runDirect` stay), `lib/disposableOneShotPool.ts` (a `Map` keyed by engine), `lib/voiceRouter.ts`, `src/engines/<8>/oneShot.ts` | +900 / −850 | low | `oneshot`, `voiceRouter`, `grokOneShot`, `kiloOneShot` specs |
| 12 | U | Rows read from transcripts: token usage, work, output stats, activity | `lib/agentTokenUsage.ts`, `lib/sessionWork.ts`, `lib/agentOutputStats.ts`, `lib/transcriptActivity.ts`, `core/turns/funnel.ts:102`, `src/engines/{claude,codex,opencode}/transcript.ts` | +250 / −200 | low | their specs; e2e `windows`, `history` (last activity) |
| 13a | H | Turn hooks: Stop, turn start, tool start; the agy backstop and Cursor's tasks become the engines' own | `core/turns/turnHooks.ts`, `core/turns/agyBackstop.ts` → `engines/agy/`, `core/engines/cursorTasks.ts` → `engines/cursor/`, `core/agents/forget.ts`, `core/turns/cancel.ts`, new `kit/stop.ts`, `cli.ts` (`:2161-2169`, `:2370-2386`, `:2644-2649`), `src/engines/<7>/hooks.ts` | +450 / −400 | medium | `turnHooks.spec.ts`; e2e `turns`, `ends`, `compaction`, `stall` |
| 13b | H | The hook server's engine decisions and the install dispatch (installers imported from `lib/hooks.ts`, which is not edited) | `hookServer.ts`, `core/engines/hooks.ts`, `src/engines/<13>/hooks.ts` | +300 / −200 | medium | `hookServer.spec.ts`, `core/engines/hooks.spec.ts`; e2e `core`, `robustness`, `startup` |
| 13c | H | Cursor's discovery and replay as `hooks.start`, `stop`, `forgetSession`; the watcher's tail mode from the facet | `cli.ts` (`:2075-2100`, `:3387-3393`, the two shutdowns), `watcher/watcher.ts`, `src/engines/cursor/` | +200 / −180 | medium (no e2e for Cursor) | watcher and Cursor specs; `localE2e.spec.ts` (opt-in, real Cursor) |
| 14 | B | Binding and repair: the live-session finders, the transcript of a known id (three places become one member), session switches, continuation, cwd proof, resume identity, handoff discovery, close | `core/agents/bind.ts`, `lib/sessionRepair.ts`, `lib/captureResumeIdentity.ts`, `lib/cwdRepair.ts`, `lib/handoffDiscovery.ts`, `lib/closeAgentService.ts`, `core/agents/discovery.ts`, `src/engines/<14>/sessions.ts` | +700 / −600 | high: restart and resume | `sessionRepair`, `captureResumeIdentity`, `bind` specs, `npm run test:resume`; e2e `recovery`, `machine`, `migration`, `orphan`, `forks`, `ends` |
| 15 | B | Database stores: checkpoint, purge, worktree safety, handoff | `lib/sessionCheckpoint.ts`, `lib/purgeAgentService.ts`, `lib/worktreeDeletion.ts`, `lib/sqliteAvailability.ts`, `lib/agentHandoff.ts:67`, `src/engines/{opencode,kilo,hermes,devin}/sessions.ts` | +250 / −200 | medium | their specs, with pins for each store's tables; e2e `ends`, `folders` |
| 16 | B (after the title branch lands) | Titles: cleaning, product names, Codex's own title | `lib/sessionTitle.ts`, `src/engines/{codex,opencode,kilo}/sessions.ts` | +100 / −80 | low | `sessionTitle.spec.ts`; e2e `windows`, `hostname` |
| 17 | Q (after 14) | Search: line normalizers and the 13 providers move to `engines/<x>/search.ts`, reached through `manifest.search` | `lib/sessionSearch/{transcript,indexer,sessionTurns}.ts`, `lib/sessionSearch/externals/*` (moves; `support.ts`, `types.ts`, `external.ts` stay), `services/searchProcess.ts`, `cli.ts:1815-1817` | +3,000 / −2,950, nearly all `git mv` | low | the externals specs move with their files; e2e `services`, `serviceProcesses` |
| 18 | L | Workspace: pre-trust, instruction files, harness context argv | `lib/claudeTrust.ts`, `lib/claudeProject.ts` → `engines/claude/`, `core/agents/launches.ts`, `core/agents/create.ts:175`, `dsh/adapters.ts`, `dsh/runtime.ts`, `lib/apiInstructions.ts`, `src/engines/<14>/launch.ts` | +350 / −250 | medium | `claudeTrust`, `dsh` specs; e2e `folders`, `dotfiles`, `shells` |
| 19 | L | Grid, subscription model, house env, Codex profile home and own login, resume repair, stop unload, a resumed session's model | `lib/gridLaunch.ts`, `lib/gridWebMcp.ts`, `lib/gridAssignment.ts`, `lib/subscriptionModel.ts`, `lib/harnessDefaults.ts`, `lib/launchOverrides.ts`, `lib/codexSessionLifecycle.ts` → `engines/codex/`, `core/agents/{launch,create,fork,retarget}.ts`, `lib/stopAgentService.ts` | +1,000 / −900 | medium | grid and launch specs; e2e `enginehomes`, `updates`, `forks` |
| 20 | L | The manifest: binary, aliases, install, labels, homes, Codex profiles, shared-server attribution | `lib/engineBin.ts`, `lib/engineInstall.ts`, `lib/agentNames.ts`, `lib/engineHomes.ts`, `lib/codexHomeProbe.ts`, `lib/hermesHome.ts`, `lib/codexProfiles.ts` and `codexProfileDiscovery.ts` → `engines/codex/`, `lib/harnessResources.ts`, `lib/terminalStreamManager.ts:1132`, `lib/terminalAgentDiscovery.ts:141`, `backendSocket.ts:1962`, `:2197-2218` | +900 / −800 | medium | `engineBin`, `engineInstall`, `engineHomes`, discovery specs; e2e `enginehomes`, `cli`, `updates`, `startup` |

**Phase C: the busy files, once their branches have landed (parallel with each other).**

| # | Step | Files | Size | Risk | Proof |
|---|---|---|---|---|---|
| 21 | Launch argv: permission modes, first prompt, named agent, resume, fork, the Codex launch script | `lib/engineLaunch.ts`, `src/engines/<14>/launch.ts` | +450 / −350 | high | `engineLaunch.spec.ts`, `engineShellStartup.spec.ts`; e2e `updates`, `updateHostile`, `shells`, `dotfiles`, `lifecycle` |
| 22 | Process recognition and the argv read-backs | `lib/tmux.ts` (`ENGINE_PROCESS_SIGNATURES`, evidence, `RESUME_ARGS`, permission read-back), manifests | +350 / −300 | high: discovery | tmux specs; `test:tmux-real` on a machine with the engines; e2e `tmuxmoves`, `orphan`, `startup`, `twodaemons` |
| 23 | Hook installers and plugin sources | `lib/hooks.ts` (about 1,100 lines move), `src/engines/<13>/hooks.ts` | +1,200 / −1,150 | medium | `hooks.spec.ts`; e2e (the fakes install real hooks) |
| 24 | Transcript roots, accept-lists, session-id shapes, expected paths, load repair | `lib/registry.ts` (away from the title code), manifests and stores | +250 / −200 | high: what loads at boot | `registry.spec.ts`; e2e `migration`, `machine`, `recovery` |
| 25 | Team drafts | `teams/preflight.ts` (`screen.composer`) | +60 / −40 | low | preflight specs; e2e `teamsProcess` |

`hook/notify.mjs` is not in the plan's moves: it is a standalone script copied beside the bundle, it
cannot import TypeScript, and it is the engines' hook client rather than shared daemon code. Its
engine knowledge (about 700 lines) drifts from the daemon's (section 9). The fix is a later, separate
decision: build it from TypeScript so it imports the manifests.

**Phase D: finishing (sequential).**

| # | Step | Files | Size | Risk | Proof |
|---|---|---|---|---|---|
| 26 | Lazy loading: each engine's `manifest.ts` and `index.ts`; the tables become loaders; load points; a heap measurement | `src/engines/**` (index files, tables removed), `registry.ts`, the four load points (`hookServer.ts`, `core/agents/discovery.ts`, `core/agents/launches.ts`, boot restore in `cli.ts`), `core/transcripts/attach.ts` | +400 / −300 | medium: a missed load point degrades an agent instead of failing | a spec that a non-built-in engine is not evaluated at start; an e2e that starts a daemon and checks heap and module evaluation; the full e2e suite |
| 27 | The rule becomes absolute and covers every shared folder | `src/engineNames.spec.ts`; the baseline file deleted | +40 / −150 | none | the spec |
| 28 | The fixes found by the inventory, one change each (section 9) | per fix | small each | per fix | a test that fails without each fix |
| 29 | One `engineHome` on the row instead of `codexHome` and `hermesHome` | `lib/registry.ts`, the wire (additive: read both, write both, then drop the old), about 30 readers | +300 / −250 | medium: persisted data | registry migration specs; e2e `migration` |

### 8.3 What step 1 is, exactly

Step 1 is the smallest change that puts the registry in the tree and proves the pattern end to end.

- `src/engines/engine.ts`: `Engine` with `name` and `transcript`; `facets/transcript.ts` with the two
  members step 1 fills, `lastTurnText` and `storedConversation`.
- `src/engines/registry.ts`: `engineFor(name)`, built from `transcripts.ts`, the table of every engine's
  transcript facet.
- `src/engines/claude/transcript.ts`: Claude Code's folder, starting with its last turn (read backward
  from the end, as `core/transcripts/lastTurn.ts` does today).
- `src/engines/<13 others>/transcript.ts`: each engine's last turn, and for OpenCode, Kilo, Hermes and
  Devin their stored conversation, each resolving its own store (the same `env` paths `cli.ts` passes
  today).
- `core/transcripts/lastTurn.ts` asks the engine; `core/transcripts/databaseHistory.ts` asks the
  engine. Neither names an engine any more.
- `src/engineNames.spec.ts` and its baseline.

One case changes on paper and not in practice: today an engine the reader does not name falls back to
Claude Code's raw-line reader. The only such engine is `terminal`, and a terminal row never has a session
id or a transcript (`registry.releaseBinding` clears both), so the reader never reaches it. After step 1
an engine without the facet has no last turn, which is the rule for every facet.

## 9. Effort and risks

### 9.1 Effort

About 17,000 lines touched across 31 steps (29 numbered; step 13 is three), of which about 3,000 are
file moves (search) and about 9,500 are code moved from shared files into engine folders. Shared code
loses roughly 8,000 lines net; the engine folders gain them.

| Phase | Steps | Agent-days | Calendar |
|---|---|---|---|
| A, the core's transcripts | 1-5 | 6 | 6 days, sequential |
| B, everything that avoids busy files | 6-20 | 19 | 6-7 days with three or four lanes at once |
| C, the busy files | 21-25 | 8 | 3 days, once those branches land |
| D, lazy loading, the absolute rule, fixes, the home rename | 26-29 | 9 | 5 days |
| **Total** | **31** | **about 42** | **about 4-5 weeks** |

An agent-day here includes the bar: the targeted e2e files from the bundle take 15-40 minutes per run,
and a high-risk step will run them more than once. The real limit is review: 31 pull requests plus the
fixes, each of which someone has to read. Phase B's lanes are what make the calendar short; run
sequentially the same work is about eight weeks.

### 9.2 What the e2e suite cannot prove

The e2e suite has fakes for Claude Code and Codex only. For the other twelve engines a move is proven
by unit tests that pin today's answers on recorded fixtures, and that has limits:

- **Discovery and hooks against real binaries.** Process signatures, the `agent` alias between Cursor
  and Grok, hook payloads and plugin behaviour are only proven by `npm run test:tmux-real` and by hand
  on a machine with the engines installed. Steps 22 and 23 should each end with that run, and with a
  turn on every installed engine (the tile goes processing, done, summary), as the engines README asks.
- **Database engines.** OpenCode, Kilo, Hermes and Devin are read through SQLite schemas the fixtures
  freeze. A schema an engine changed since its fixture was recorded passes every test. Steps 2, 4 and 15
  rely on the fixtures; a real-store opt-in spec (like `attachTranscript.real.spec.ts`) would close
  part of it.
- **Timing.** Submit windows, pane polls and footer reads are data after the moves, so a move cannot
  change them by accident, but nothing proves the values are still right for each engine's current
  release.
- **Mocks pin routing, not behaviour.** Several pinning specs mock the engine modules they route to,
  so they prove each engine is asked the same question with the same arguments, not that the answer is
  still right. Each engine's own normalizer and parser specs, replaying its recorded session, prove the
  rest.

Worth considering before Phase C: a third fake engine that replays a recorded session of any file engine
(its transcript fixture into its transcript folder, its captured pane into the pane), so attach, ingest,
history and turn lifecycle are proven end to end for the file engines too. About two to three days.

### 9.3 Risks

- **The interface is wide.** 132 members is what the code decides today. Some will turn out to be the
  same decision twice, and some engines' members will change shape as their code moves; the types in
  section 4 are the target each lane starts from, not frozen. Each lane's review should check its facet
  against what the code actually needed.
- **Attach and binding are where the races were.** Steps 4 and 14 move the code most of the e2e rounds
  fixed. They are verbatim moves for that reason, and their proof is the full set of e2e files that
  found those races, run from the bundle, more than once.
- **Import cycles.** Engine code must import only `src/engines` and leaf `lib` modules, never
  `src/core`. One cycle exists already: `engines/cursor/discovery.ts` imports `validTranscriptPath` from
  `lib/registry.ts`, and `lib/registry.ts` imports engine modules. ESM cycles fail quietly (a binding is
  undefined during evaluation), and the rule test cannot see them; step 1 adds a check that the registry
  module evaluates without a cycle, and step 24 removes the existing one.
- **A missed load point** after step 26 degrades an agent instead of failing loudly. The degraded event
  makes it visible; the step's e2e checks every load point.
- **The facet tables are temporary.** Step 26 replaces them with per-engine modules. Until then the
  registry statically imports every engine, as the daemon does today, so nothing is lost meanwhile.
- **Kept dead code.** About 485 lines of model-switch drivers for six engines are unreachable but kept
  on purpose (the owner's switching policy has changed twice, `runtimeProfileController.spec.ts`). They
  move with their engines unchanged. Whether to delete them is the owner's call, not this plan's.
- **The ratchet meets other branches.** Until the rule test is on `main`, a rebase can bring in engine
  names other changes added (#816 added two to `lib/runtimeProfileController.ts` while step 1 was
  waiting), and the rebase refreshes the baseline. Once it is on `main`, any branch in flight that adds
  an engine name to shared code fails it, which is the point; say so to whoever has branches open when
  step 1 merges, and point them at the engine's folder.
- **Wire names stay.** `codex_profiles_list`, `supportsCodexHome`, the `codexHome` field of
  `agent_create`, and the refusal code `CODEX_CLI_TOO_OLD` (sent for every engine) are part of the
  protocol the apps speak. The moves keep them; only step 29 renames anything, additively.

### 9.4 What the inventory found that is wrong today

These are fixes for step 28, each its own change with its own test, never folded into a move. The ones
marked "checked" I confirmed in the code myself; the rest come from the inventory's reading and need the
same check before they are fixed.

1. **One terminal row disables the hook script's reading of the registry** (checked).
   `hook/notify.mjs:1123` `REGISTRY_ENGINES` lists the fourteen engines and not `terminal`;
   `validV2Registry` (`:1150`) rejects the whole registry when any row fails, and terminal rows are
   written with `schemaVersion: 2`.
2. **A restart records the grid wrongly** (checked). `core/agents/restart.ts:182` passes
   `processIdentity.executable` as the `args` of `probeGridAssignment`, and Codex and pi read the grid
   from argv; `retarget.ts:236` reportedly does the same.
3. **Command Code's recap worker runs a binary that may not exist** (checked). `lib/oneshot.ts:781`
   defaults to `commandcode`; the launch command and the install recipe use `cmd`.
4. **Codex model switching is closed above 0.145** (checked). `lib/runtimeProfile.ts:269` allows exactly
   0.144 and 0.145, and the line before it is duplicated; Claude Code's gate is open upward. Current Codex
   is 0.160, so switching is refused for it today. Opening the gate alone would not be enough: 0.160's
   picker labels its model rows differently, and the controller would refuse every model (section 9.5).
   Left as it is until the owner decides.
5. **"May this engine bind without a transcript" is answered four ways:** `registry.ts:1018` (load),
   `:1494` (register), `core/agents/bind.ts:277`, `notify.mjs:1216`. Grok, agy and Copilot may bind with
   no path at register and are unbound at the next load.
6. **"The transcript of a known session id" is answered in three places with different engines**
   (`bind.ts:264-274`, `sessionRepair.ts:566-602`, `registry.ts:1560-1572`); a pi resume binds with no
   path, and `captureResumeIdentity` finds nothing for seven engines.
7. **Devin's submit is confirmed the wrong way.** Its comment (`sessionInput.ts:30-32`) says it is
   confirmed from its store like OpenCode; the list at `:630` leaves it out, so it reads a composer whose
   marker `❭` the regex does not contain.
8. **Claude Code's readers run on other engines.** `runtimeProfile.ts:740` sends pi, Copilot, Muse, agy
   records through Claude Code's transcript reader (its `Set model to` pattern runs on their text), and
   `:1007` runs Claude Code's header patterns on Copilot, Muse and Amp panes.
9. **Instruction files are chosen in three places:** `lib/apiInstructions.ts:23` branches on `gemini`,
   which is not an engine, and ignores agy's `GEMINI.md` and Hermes's `.hermes.md` that `dsh/adapters.ts`
   knows.
10. **Codex's trust ignores its home:** `lib/claudeTrust.ts:87`, `:111` write `~/.codex/config.toml`
    whatever `CODEX_HOME` or the agent's profile says.
11. **A fork skips the relaunch overrides** (`core/agents/fork.ts`): no own-login provider for Codex, and
    OpenCode's house environment is lost on fork, resume and restore.
12. **Database knowledge exists five times and disagrees:** OpenCode's `session_v2` is purged but not
    checkpointed; Hermes's store is found three different ways.
13. **Search finds conversations that resume then refuses:** moved homes, Pi's configurable session
    folder and Codex's `archived_sessions` are searched but not accepted by `validTranscriptPath`.
14. **Defaults disagree:** `harness new` defaults to Claude Code, `DEFAULT_HARNESS_ENGINE` is OpenCode,
    and an unknown engine in a saved registry loads as Claude Code (`registry.ts:354`).
15. **Dead code** that the moves should not carry: `tmuxAgentDiscovery.ts`'s reconciler (about 320
    lines), `lib/sessions.ts` (about 125), `installedEngineBin`, `INSTALLABLE_ENGINES`,
    `readStartupProfile`, seven never-called catalog builders, the Muse hook path in `notify.mjs`, the
    unreachable OpenCode prompt marker, and `EngineAdapter` itself. Deleting them is a step-28 change
    each, before or after the move of their group, never during it.

### 9.5 Codex 0.160's model picker against what the controller types

Read from the Codex source at `rust-v0.160.0`, against `rust-v0.145.0`, the last release the gate allows
(`codex-rs/tui/src/chatwidget/model_popups.rs`, `bottom_pane/list_selection_view.rs`, the picker
snapshots in `chatwidget/snapshots/`, and `protocol/src/protocol.rs`). The controller's side is
`setCodex` and the four `parseCodex*` readers in `lib/runtimeProfileController.ts`.

| Step | What the controller relies on | 0.160 | Holds? |
|---|---|---|---|
| Open | `/model` opens "Pick a quick auto mode or browse all models" or "Select Model and Effort" | both titles unchanged | yes |
| Quick menu | rows keyed by their first slug-like token; an `All models` row | rows are now display names (`Auto Fast`); `All models` unchanged | the `All models` route only |
| Model rows | `parseCodexModelRows` keys each row by its first token and looks up the target's slug (`gpt-5.6-sol`) | rows are the catalog's display names: `GPT-6.1-Sol (default)`, `GPT-5.6 Luna (current)`; 0.145 showed slugs | **no**: every lookup misses (a name with a space does not even parse), so the switch is refused with `MODEL_UNAVAILABLE`. It fails closed: no wrong model is picked |
| Effort rows | title "Select Reasoning Level for"; `Low`, `Medium`, `High`, `Extra high`, `More reasoning…`; `(default)` | title now ends in the display name; rows unchanged; a new `Persistent` row | yes (the new row is ignored) |
| Advanced | "Advanced Reasoning"; `Max`, `Ultra` | unchanged | yes |
| Keys | a digit selects the row and accepts it | a digit still selects and accepts the primary action, which applies the choice and saves it as the default, as 0.145's did; 0.160 adds `s` for "this session only" | yes |
| Confirm | `event_msg` `thread_settings_applied` with `model`, `reasoning_effort`, `collaboration_mode` | the same fields, two added (`thread_id`, `runtime_workspace_roots`) | yes, except that a `persistent` effort is not in `CODEX_EFFORTS`, so its chip would not show |

Two more things change under the controller. The picker now shows its cached models at once and
refreshes them in place when the server answers (`AppEvent::FetchModels`), so the rows read from the pane
can be renumbered before the digit lands; the controller should re-read the pane after the refresh, or
match by name rather than by number. And an account restricted to the reserve model (`gpt-reserve`, shown
as "Luna Reserve") gets a different picker altogether.

So for 0.160 the controller has to match model rows by display name. Harness already reads each model's
`display_name` from `models_cache.json` for the picker it offers (`runtimeProfile.ts` `codexModels`), so
the fix is contained: look rows up by the target's display name, and open the gate. It is a behaviour
change and belongs after the models lane (step 10), with a captured 0.160 pane as its fixture. The e2e
fake Codex reports 0.159.0, which the gate refuses, so no e2e run exercises a Codex model switch today.

## Appendix: reproducing the counts

All counts are on `main` at `31b4a0c27`, run from `cli/`, without spec files.

- The brief's grep, and its split (section 2): the command in section 2; the 40 lines that are not engine
  behaviour are listed by kind in the table there.
- The parser counts (section 2 and the rule's baseline): `src/engineNames.spec.ts` (step 1) is the scan.
  It walks the scoped folders, parses each file with `typescript`, and counts string literals equal to an
  engine name, object keys and property reads named after an engine (`cursor`, `pi` and `amp` only inside
  an object with another engine's key), imports whose path enters `src/engines/<engine>/`, and distinct
  identifiers that start or contain a capitalised engine name or start `CODEX_`, `CLAUDE_` and so on
  (excluding `cursor`, `pi` and `amp`).
- The bundle shares (section 6.2): `build-bundle.mjs`'s esbuild settings with `metafile: true`, summing
  `bytesInOutput` per input path: 3,338,145 bytes in all, `src/engines/*` 138,924 bytes,
  `src/lib/sessionSearch/externals` 55,983 bytes.
- The inventory tables (section 3): read from the code by file, with each decision's lines; the lines
  are on `31b4a0c27` and will move.
