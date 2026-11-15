# macOS process scan reads the whole program path, not its first 16 characters

## The problem

`readProcessRows` (`cli/src/lib/processTable.ts`) runs `ps -axo pid=,ppid=,comm=,lstart=,args=`. On macOS, `ps` cuts
`comm` to 16 characters when it is not the last column. Measured on this Mac, 2026-11-15: 667 of 789 rows come back cut
(`/Applications/Cl`, `/Users/duynguyen`), 127 of them from a path with a space in it.

A cut `comm` is harmless when argv[0] in `args` carries the same path, since the matcher also reads the entrypoint from
`args`. It is not when the path holds a space: `args` is split on whitespace, so argv[0] reads as the folder before
the space. The Claude desktop app runs Claude Code from
`~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`; both fields
read as `/Users/<name>` and `/Users/<name>/Library/Application`, and `engineProcessMatch(row, 'claude')` scores 0. With
the whole path it scores 3 (`claude` basename).

Effect, seen on Diego's Mac: `OpenSessions.owners()` (`lib/sessionSearch/external.ts`) finds none of the three running
Claude app sessions. After a daemon restart (every CLI update) they are gone from the dial until each sends a hook.
The same answer feeds Cmd-P: `indexer.ts` marks a hit `open`/`openIn: 'app'` from `OpenSessions.known()`, so a running
app session shows as not open and can be resumed a second time, two processes writing one conversation. Same cause,
same fix.

## The fix

On macOS only, `readProcessRows` runs a second `ps -axo pid=,lstart=,comm=` beside the first one (in parallel, same
`psEnv()`, same 3 s timeout). `comm` last is not cut.

Each row of the first table gets a new, ephemeral field `commandPath` (like `imagePath`: never persisted, never sent)
only when all of these hold:
- the second table has the same pid with the same `lstart` (a pid reused between the two reads is not joined);
- the second table's `comm` is longer than the row's `executable`, and `executable` is exactly its cut: the longest
  prefix of it, ending on a character boundary, that fits in 16 bytes (macOS cuts at 16 bytes, so
  `/Users/josé/Library/…` reads `/Users/josé/Lib`, 15 characters).

`executable` itself does not change. It is the stored process identity (`processIdentityOf`, registry), compared with
`===` in `nativeControls.ts`, `stoppedAgents.ts`, `forget.ts`, `deleteAgentFallback.ts` and `processEvidence.ts`
(which reads the cut `comm` again on purpose). Changing it would make every running session's saved identity stop
matching after the update.

The matcher reads `commandPath ?? executable` wherever it reads the program from `executable`
(`heuristicEngineProcessMatchScore`, `ambiguousAgentProcess`, `agentAliasCandidate`). The session-search process list
(`listProcesses`, `RunningProcess`) carries `commandPath` through, so the external providers' owners see it.

The second read failing (an error, a timeout, a row that does not parse) leaves every row as it is today: no
`commandPath`, nothing else lost. Linux and Windows are unchanged (Linux `comm` is a 15-byte name, never a path;
Windows has its own table).

Nothing reads another process's environment: `comm` is argv[0], the same `KERN_PROCARGS2` text `args` already prints.

## Cost

The scan runs on every hook (`core/engines/hooks.ts`) and on discovery passes; concurrent callers share one read.
Measured on this Mac, 789 processes, 10 runs each:
- today's `ps -axo pid=,ppid=,comm=,lstart=,args=`: 63 ms
- the added `ps -axo pid=,lstart=,comm=`: 44 ms (about 0.03 s system CPU)

Run in parallel, wall time stays near the first read's. The PR records before/after wall time of `processRows()`.

## Tests

Red first, in `cli/src/lib/processRows.spec.ts` style (a fake `ps` on PATH, darwin only):
- a row with a 16-character `comm` whose full path has a space (the Claude app's) gets `commandPath`, and
  `engineProcessMatch(row, 'claude').score` is 3 (0 before);
- a pid whose `lstart` differs in the second read, a `comm` that is not a 16-character prefix, and a failed second
  read leave `commandPath` unset and the rows otherwise unchanged;
- `executable` is unchanged in every case.

`listProcesses` passes `commandPath` through (`externals/support.spec.ts`).

Cmd-P (PM, 2026-11-15): a running Claude app session must not be resumed a second time. Desktop already refuses a hit
that is `open` with `openIn: 'app'` (`desktop/lib/state/swarm_search.dart` `sessionUnavailable`), so the test lives in
the daemon: a search hit for a session owned by a Claude app process (16-character `executable`, `commandPath` with a
space) comes back `open: true, openIn: 'app'` from `indexer.ts` through `OpenSessions` and the Claude adoption
provider (`engines/kit/adoption.ts`). Red before the fix.

`npm run test:core` runs once in phase 4 (processTable.ts is a core file). The PR records the before/after wall time of
`processRows()` on this Mac.

## Decisions

- PM, 2026-11-15: a separate ephemeral `commandPath`; `executable` stays the cut `comm` (stored identity).
- PM, 2026-11-15: the cut is compared in bytes, not characters: a row joins when
  `Buffer.from(comm).subarray(0, 16).toString().trimEnd() === executable` (and the full comm is longer). That also
  covers a cut inside a character (read back as U+FFFD) and a cut that ends in a space (dropped by the parse).
- PM, 2026-11-15: `servesOthers` also reads the subcommand after the whole command path, so
  `…/Application Support/X/codex app-server` is a server, not a terminal session (red test, in Task 3).
- PM, 2026-11-15: the four provider helpers above are in scope (a third task); the hook's matcher is a follow-up.

## Other readers of the cut name

Four provider helpers read the program from `executable` too, each with `args` as a fallback that misses a program
under a path with a space: `grok.ts` `isGrok`, `copilot.ts` `copilotProcess`, `cursor.ts` `persistent`, and
`engines/kit/adoption.ts` `servesOthers`. Each reads `commandPath ?? executable` (PM, 2026-11-15), each with a red test.

## Out of scope

`processEvidence.ts` keeps reading the cut `comm`; it compares against the stored identity, which stays cut.

Follow-up: the hook's own table and matcher (`cli/hook/notify.mjs`) read the same cut name. It is a standalone script
in the engine's hook process, and the evidence shows it already finds the Claude app's sessions (a hook brings them
back), so it is left for its own item.
