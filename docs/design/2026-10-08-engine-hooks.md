# Engine hooks

Claude Code's and Codex's hook code has left the core. Each engine now declares its hooks as data
(`Engine.hooks`, `engines/{claude,codex}/hookContract.ts`), and shared mechanics in `engines/kit` apply
them. Core still evaluates all of it in line and synchronously, as before. Nothing moved into a worker.
Hooks are how sessions bind and turns close, and the (d) review ruled that session control never
depends on an engine worker.

## What moved

| Was | Now |
| --- | --- |
| `engines/claude/installHooks.ts`, `engines/codex/installHooks.ts` | `HookContract.settings`: the home and file, the events and matchers, the timeout, what an unreadable file means, the write mode, when a block of ours is up to date, and the log lines. One installer applies it: `engines/kit/hookSettings.ts`. |
| `engines/codex/hooks.ts` `admit`, through `readCodexRolloutMeta` | `HookContract.children`: the first record's type (`session_meta`), the field that marks a child (`payload.source.subagent`) and the reason (`codex_subagent`). `kit/hookRules.ts` `isChildSession` reads at most 128 KiB, the rollout reader's bound. |
| `engines/claude/hooks.ts` `transcriptFor` | `HookContract.sessionFile` (`<sessionId>.jsonl`) and `kit/hookRules.ts` `knownTranscript` |
| `engines/claude/hooks.ts` `onStop` | `kit/stopHook.ts` `closeTurnOnStop`, for a contract with `stopClosesTurns`. The `/goal` flag stays `LiveTurn.continued`. |

`engines/hooks.ts` composes what core calls (`EngineHooks`: `install`, `installIn`, `transcriptFor`,
`admit`, `onStop`) from each contract. Its callers are unchanged. Core keeps authoring the command
(`kit/notifyHooks.ts`).

## When each part runs

- **Installation:** at daemon start, for the default homes and every home the person moved
  (`core/engines/hooks.ts`), and before a Codex agent starts in a profile of its own
  (`core/agents/create.ts`, relaunch overrides). It is synchronous: a hook installed late never fires.
- **Admission:** on the hook server, before `onPromptSubmitted` and before registering. So a delegated
  session's prompt is never credited to its parent's pane. `registry.register` asks the same
  `admitHook` again, so the two cannot disagree. A check that throws refuses the hook.
- **Transcript correction:** synchronous on the hook path (`hookServer.ts` `knownTranscriptFor`).
- **Stop:** `core/turns/turnHooks.ts`. Codex declares no Stop rule and closes turns through its transcript.

## The same bytes

The two installers differed in ways that reach a person's own settings. The contract carries each
difference:

| | Claude Code | Codex |
| --- | --- | --- |
| Default home | `~/.claude` | `CODEX_HOME` |
| A file that cannot be read or parsed | starts from empty settings and replaces it | is left alone, with two log lines |
| Write | in place: through a symlink, keeping the mode | atomic: renames a new file over it, which replaces a symlink and takes mode 0644 |
| A block of ours is up to date when | its first notify.mjs hook runs the current command | it is the only one, its first hook runs the current command, and its matcher is the declared one |
| The command names the home | no | yes (`--codex-home`) |

**Proof.** `engines/hookInstallers.golden.spec.ts` was recorded from the former installers, in the commit
before this change. It covers 43 states each file can be in: none, empty, malformed, foreign hooks
only, our old hook, ours current, duplicates, mixed, symlinked, dangling, read-only, unreadable,
private, a folder, and a leftover temporary file. Each installs twice through `installIn`, and 7 of them
through the default home too. It keeps every file's bytes, mode and symlink, the log lines and what
threw. It passes unchanged against the kit. So does a seeded run, not committed, of 500 generated files
per engine through both entry points, recorded from the former installers the same way. Flipping any one
of the differences in the table above fails it.

**Kept as they were, not fixed here:**
- Claude Code replaces a settings file it cannot read or parse, the person's other settings with it.
- A settings file holding JSON `null` or a scalar throws. `installEngineHooks` catches it per engine.
- Codex's atomic write replaces a read-only `hooks.json` and a symlink.

## Core closure (esbuild, `core/main.ts`, dynamic imports external)

| | Lines | Files |
| --- | --- | --- |
| Before (after #1043) | 72,963 | 387 |
| After | 73,056 | 388 |

**Left:** the four hook files of `engines/{claude,codex}`, 212 lines. **Came in:** the two contracts
(72 lines of data) and three kit modules (202 lines). `engines/codex/rollout.ts` stays in the closure
through the registry's load-time repair and session repair, both batch (c).

`architecture.spec.ts` lists `engines/{claude,codex}/{hooks,installHooks}.ts` as edge files. It also
checks the closures of the hook lookup, the three kit modules and `core/turns/turnHooks.ts`: they reach
no Claude Code or Codex file but the two contracts.
