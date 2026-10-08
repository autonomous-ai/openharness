# Engine launch

Batch (c) of [the remaining facets](2026-10-08-engine-remaining-facets.md): launching, discovering and
resuming Claude Code and Codex. Launching an agent is session control, so none of it moves into an engine
worker. As with [hooks](2026-10-08-engine-hooks.md), the engines' code leaves the core and each engine
declares what it needs as data on its launch contract (`Engine.launch`, `engines/{claude,codex}/launch.ts`).
Shared mechanics in `engines/kit` read that data, and core runs them in line.

(c) is too large to land as one change. It is split into five sub-batches, each green on its own. This
document records (c1), which is done, and plans the other four.

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

`core/agents/launch.ts` still imports `engines/codex/portableHistory.ts`. That is (c2).

## The plan for the rest of (c)

The sub-batches are ordered by risk: pure functions first, then async writes, then the hot and synchronous
paths. Each one records today's behavior in a golden spec first, in its own commit.

| | Scope | Why it is in this place | Golden proof |
| --- | --- | --- | --- |
| **(c2) Launch preparation** | Folder trust (`lib/claudeTrust.ts`, 129 lines, and the `engine === 'claude' / 'codex'` branches in `core/agents/create.ts` and `launches.ts`). Codex's rollout repair for resume (`engines/codex/portableHistory.ts`, 220 lines, `core/agents/launch.ts` `prepareSessionResume`). The instruction-file fallback in `dsh/runtime.ts` and `lib/apiInstructions.ts`. | Async callers, before the spawn. These write into the person's engine homes and into rollouts, so their bytes matter, but no hot path depends on them. The order must stay: repair, then `setTail`, then spawn. | Every file's bytes before and after, as the hooks batch did. The trust contract declares the file, the format (a JSON path, or a TOML table) and the rule that trust inherits downward. The resume repair declares which records it drops. |
| **(c3) Discovery and process matching** | `lib/tmux.ts` process signatures and `RESUME_ARGS`, `claudeNativeInstallPath`, `lib/gridAssignment.ts` `MODEL_IN_ARGV`, `lib/codexHomeProbe.ts`, `lib/claudeProject.ts`, `lib/cwdRepair.ts`, and the moved homes in `lib/engineHomes.ts` (with the `CODEX_HOME` env literal at create and relaunch). | This is static data, but it is read for every process row on every discovery pass, and a wrong answer adopts or drops agents. | A recorded classification of a corpus of process rows: executable, argv, environment → engine, session, bypass, model, home. |
| **(c4) Registry load and session identity** | The registry's Codex child-rollout repair (`lib/registry.ts` with `engines/codex/rollout.ts`), `lib/sessionRepair.ts` (about 190 of 716 lines), `lib/captureResumeIdentity.ts`, `lib/handoffDiscovery.ts`. | Synchronous, at load before any worker exists, and on the hook path. A wrong answer loses bindings at every restart. It goes after (c3) because it reuses (c3)'s homes. | Recorded transcripts and pid records → binding, session id and repair, read with the same bounds. |
| **(c5) Adoption readers and shared normalizers** | `lib/sessionSearch/externals/{claude,codex}.ts`, `lib/transcriptPages.ts`, `lib/transcriptReader.ts` and `lib/transcriptActivity.ts`. Also splitting the functions `engines/claude/normalize.ts` and `engines/codex/{normalizer,subagent}.ts` share with other engines into `engines/kit`. | The largest (1,000 to 2,000 lines) but async. Listing and paging sessions for adoption is not session control. Those readers may run in a worker, as long as adoption fails safe when it is down: refused with a reason, never a wrong session. | The adoption and paging specs, unchanged, plus a recorded corpus of transcripts → pages. |

**Out of (c).** These stay as they are, as tables over every engine:

- `lib/engineBin.ts` (`CLAUDE_PATH`, `CODEX_PATH`);
- `lib/engineInstall.ts` (install recipes);
- `lib/gridLaunch.ts` (grid contracts).

Their Claude and Codex rows are data, not code paths. The engine-specific wording in
`lib/messageHolds.ts` and `core/cardText.ts`, and the screen check in `core/main.ts` `activityText`, belong
to (a) and the screen facet.
