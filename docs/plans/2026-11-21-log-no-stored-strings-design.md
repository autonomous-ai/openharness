# Daemon logs: no stored strings, process output, peer text, paths or URLs

## Why

AGENTS.md, Code standards, rule 7: no secrets or personal content in logs. #4488 and #4492 made every daemon failure
line name an error by its kind (`errorKind`, `cli/src/lib/log.ts`) and added a guard
(`cli/src/architecture.failureLogs.spec.ts`) that fails on a log call printing an error's words. Since #4447 Export
logs sends the daemon's log off the machine, so whatever a line prints leaves the person's computer.

That work left, by design, a second cause for a follow-up: about 120 lines that print content not read from an error at
the line. A `result.detail` or `.reason` a function stored, a process's stderr, an error string a peer or the backend
sent, a path or URL that names the person's folders (a home folder carries the account name), and error words that
reach a logger through a name or a file the guard does not read. The audit's list (made at 7f648f3a20, re-verified on
9281024a97 in the appendix) is the starting set.

## Goal

Every daemon log line in that list, and every other line the extended guard finds, prints a fixed word, a kind or code,
a count, a length or a hash instead of the content. The guard is extended so the cause cannot grow back by code
(AGENTS.md rule 13): the blind spots the audit found ("outside the scan", "a name it does not read as a logger"), and
name rules for process output, free text and paths/URLs.

- Non-goals: output a CLI command prints to the terminal of the person who ran it (the guard's `TERMINAL` files),
  `e2e/` and `tui/`. Errors and text returned to clients or shown to the person (a reply's `error`/`detail`, a notice,
  a hold reason a window shows) do not change: only what the log prints does. No log line gains a field it did not
  have, beyond the kind, code, count, length or hash that replaces content.
- Anti-goals: a replacement that can still carry free text (a "short" preview, a basename, the first word of a
  message); a second logging path or a console wrapper that rewrites lines; a line that loses what makes it actionable
  (its tag, ids, codes, counts) in the swap; an exemption list that grows per line.

## Decisions

From harness-pm (2026-11-21), for the user:

1. **Guard reach: approach B** (below). The audit's guard changes plus name rules for process output, free text and
   paths/URLs, with the serial port's name and pure pass-through excluded. The ~18 same-cause lines outside the audit
   that the name rules find on `main` are fixed in this branch too.
2. **Tests.** A line the extended guard finds on the old tree has the guard as its red test. A line the guard cannot
   see (a `.reason`, a `why`, a label, a peer's `answer.error`, a whole object) gets a behaviour test of its own that
   fails first: it drives the path with sentinel content and asserts the logged line lacks it and names the kind,
   code, count or hash instead. A change beyond the log's text (the fatal handlers) gets a behaviour test of that
   change.
3. Accepted proposals: `dsh/command.ts` joins `TERMINAL`; kind-only fatal handlers for the processes that lack one;
   the `lib/log.ts` text helper keeping UPPER_SNAKE codes; an 8-hex hash for paths, URLs and labels; counts for process
   output.

4. **`HookPreparationHeld`'s hold sentence stays in the log**, checked by code: the fixed sentence moves to a field
   the rules do not read (`hold`), the two dynamic ones (`engines/kit/notifyHooks.ts` `a hook argument ${reason}`,
   `HookScriptMissing`'s path) become fixed at their source, and a test fails when any `new HookPreparationHeld(` (or a
   subclass's) argument is not a string literal.
5. **One by-hand `cli-e2e.yml` run** on the final head, after the end-to-end expectations and the pending lists' removal
   land; harness-pm is told when it starts (the heavy lane).
6. **Accepted calls:** a method call's receiver counts as printed whole (`stream.stderr.trim()`); the e2e harness's
   hooks-stayed-inside check reads hashes instead of paths; the pull request opens ready, with the local receipts in
   its body (windows-e2e is the PR's own CI, not a dispatch); a peer's `p2p_abort` reason is dropped where it arrives,
   so the backend metric says `peer_aborted`. The temporary pending mechanism is removed whole by the last task.

From the audit (earlier): serial port names may stay (a device's name, not personal content).

## Approaches

- **A, rejected: the audit's guard list only.** Read `.reason`/`.detail`/`.stderr`/`.stdout`/`.path` off an error,
  follow a file's own function's return value, scan `testing/`. Stored strings and paths grow back freely, and the
  same-cause lines the audit missed stay.
- **B, chosen: A plus name rules.** A log call never prints, whole, a value named as process output, free text or a
  path/URL, of any object. Measured on 9281024a97 with a rough scanner: 101 log calls, 65 of them in the audit, ~18 real
  same-cause lines beyond it (`core/agents/create.ts` `detail` ×3, `core/agents/newPane.ts` ×2,
  `core/turns/funnel.ts:230` `preview(message)` of an engine's error, `engines/kit/hookSettings.ts` `settings.file` ×3,
  `engines/kit/hookReview.ts` `record.file` ×2, `engines/kit/transcriptDiscovery.ts:47`, `hookServer.ts:948`,
  `lib/notifyTier.ts:34`, `cable/windowsSerial.ts:171` `lastLine(stderr)`); the rest is the serial port's name and
  forwarders, both excluded by rule. `reason`, `why`, `label` and a string `error` stay out of the name rules: `reason`
  alone has 61 hits, most of them fixed words of a literal union, which a syntactic rule cannot tell from free text.
- **C, rejected: a type-aware allowlist** (a log call prints only numbers, booleans, literal unions and the safe
  helpers' output). It would catch everything, but needs a type-checked program over `cli/src` at every run (the
  guard is syntactic for speed) and flags hundreds more lines (every `string`-typed id and version): not this branch.

## What a line logs instead

One way per kind of content, through `lib/log.ts` (already in the core's process, `architecture.coreFiles.txt`):

- **An error:** `errorKind(error)`, as today.
- **A stored or peer string** (a `result.detail`, a `.reason`, a backend's `error`, a peer's refusal): a new helper
  (proposed `codeOf(value: unknown): string`) returns the value when it is a code by the shape `errorKind` already
  trusts (`/^[A-Z][A-Z0-9_]{1,39}$/`), else `text(<length>)` for a string, else `typeof value`. A lower-case word is
  never trusted (it can be a file's or a person's name, as `errorKind`'s comment says). Where the site's value is a
  literal union of fixed words in its type (an `ended.reason` of `'closed' | 'timeout'`), the line keeps it as it is
  and its behaviour test pins that the words are fixed.
- **A path, URL or a person-chosen label** (a device's name): dropped, or replaced by a fixed word for what it is
  ("the data folder", "the lean bundle"), or by a hash (proposed `hashOf(text: string): string`, the first 8 hex of
  its SHA-256, as `sid` hashes an OpenClaw key) where telling two apart helps debugging. A device keeps its
  fingerprint (`fp`), which lines already carry.
- **Process output:** its byte length or line count and the exit code or signal, never a line of it.
- **A URL whose host matters** (the backend the daemon dials): a fixed word or the hash; never the URL.

Lines other code reads keep their tokens: `[backend] connected` (`lib/daemonLaunch.ts`, the self-update readiness
check), `[hooks] listening on 127.0.0.1:<port>` (`testing/daemonListeningPort.ts`; a port is not a path), and any marker
an e2e test or `harness start` reads. The planner lists each one the changed lines carry and its reader.

## The guard

All in `cli/src/architecture.failureLogs.spec.ts`, syntactic as today, with its header's description and limits kept
true. Each rule is red first: `finds` cases from the real sites, then the tree scan fails until the lines are fixed.

1. **An error's stored fields.** `.reason`, `.detail`, `.stderr`, `.stdout` and `.path` read off an error count as its
   words, like `.message` and `.stack`. The two `passes` cases marked "Not yet" move to `finds`; the header drops them
   from its limits.
2. **Name rules, of any value.** A log call is found when it prints, whole (the guard's existing sense: an argument, a
   template part, a sum or branch operand, an object's value, an array element, an argument handed to a function), a
   name, as an identifier or a property read's last name, that is:
   - process output: `stderr`, `stdout`, `output`, or ending in `Stderr`, `Stdout`, `Output`;
   - free text: `detail`, `details`, `message`, or ending in `Detail`, `Message`;
   - a path or URL: `path`, `cwd`, `dir`, `folder`, `file`, `home`, `url`, or ending in `Path`, `Cwd`, `Dir`,
     `Folder`, `File`, `Home`, `Url`, `URL`.
   Not found: its `.length` or `.size`, a comparison, `typeof`, and a value handed to `errorKind`, the two new helpers,
   `sid`, `Number`, `Boolean` or `Buffer.byteLength`. The exact name lists are the builder's to settle against the
   tree, kept to names that hold content; a name that is a false hit is renamed at its site rather than excused.
3. **The two exclusions, each in one place.** The serial port's name goes through one function the guard reads as safe
   (its comment carries the decision and its date); a name excluded by its spelling (`port.path`) is not. A pure
   forwarder passes: a parameter that is, bare, a whole argument of the log call in its own function
   (`(message) => console.log(message)`, `log: (line) => deps.log(line)`) is no name finding, since what its callers
   hand it is checked where they call it (a logger by its name, or a function of the file's own through the guard's
   forwarding). A parameter used in any other way (a template part, an argument of another function:
   `` (detail) => log(`… ${detail}`) ``, `preview(message)`) is found where it is logged, so `core/turns/funnel.ts:230`
   and `lib/notifyTier.ts:34` are findings. (Our call after the builder check: the narrow reading, as decision 1's
   "pure pass-through" says.)
4. **A file's own function's result.** A log call that prints a property of a local given a file's own function's
   result (directly or awaited) is found when that function returns, at that property, an error's words or a value the
   rules above find; and a property read of a local made from an error (`outcome = { reason: error.message }` then
   `outcome.reason`) is found the same way. The audit names the sites this finds: `lib/hostMove/mover.ts`,
   `lib/deleteAgentFallback.ts`, `lib/gitProject.ts`, `lib/selfUpdate.ts`, `cable/cableHost.ts`,
   `services/agentBrowserProcess.ts`, `harnessd/reexec.ts` `runProbe`, `masterProcess.ts` `probeLean`.
5. **Outside the scan.** `testing/` is scanned like the rest of `cli/src` but its specs: `testing/launchShapes.ts`
   mirrors `core/main.ts`'s wiring and printed what the daemon no longer does. A `testing/` file that only a test runs
   and whose prints only that test reads is fixed or, when its print is the test's own reading, listed beside
   `TERMINAL` with its reason; the builder measures how many before choosing, and the list stays short.
6. **Logger names.** Each section-7 flow still open on 9281024a97 (appendix) is either found by a rule above or by one
   added for it, or, when it crosses files (a reason built in one file and logged in another), fixed at its sink with a
   behaviour test, and listed in the header's limits as a cross-file flow.

The guard's run time is measured before and after on the same machine; it stays in the same range (it reads every
daemon file).

## The fatal handlers

The master on macOS and Linux, the gateway's process and every service process have no handler for an uncaught error
or an unhandled rejection, so Node prints its full report (message, stack, paths) into the daemon's log. Each gets the
Windows master's behaviour (`masterProcess.ts` `writeFatalTo`): one line with the process's name and `errorKind`, then
exit 1, as Node does, so the supervisor restarts it as before. The core keeps its `[fatal-guard]`, which stays up by
design. One handler, reused; where it lives is the builder's call within the harnessd/lib boundaries
(`src/architecture.spec.ts`).

## Constraints

- Coverage: `src/core/`, `src/services/` and `src/harnessd/` stay at 100% per file (`npm run test:core`,
  `npm run test:harnessd`); the other gates `scripts/local-checks.py --run` picks for the paths. Receipts go in the PR
  body before the push.
- `architecture.coreFiles.txt` gains no file: the helpers go in `lib/log.ts`.
- Windows-only code changes (`lib/windows/ptyUpdate.ts`, `lib/windows/dataFolderClaim.ts`, `cable/windowsSerial.ts`):
  its unit tests run on every platform; the Windows workflow runs only after harness-pm's go.
- A test never reads the developer's own machine (cli/AGENTS.md rule 6).
- Comments say why; the guard's header stays the one description of what it finds and its limits.

## Left to the builder

- The helpers' final names and the exact name lists of rule 2, settled against the tree.
- Per line: which replacement (dropped, fixed word, code, count, length, hash) keeps it actionable.
- Whether a value built only for a log line is fixed at its source (drop the words where it is made) or at the line.
- How the return-value rule (4) is built, as long as its `finds` cases are the real sites' shapes.

## Appendix: the starting list, re-verified on 9281024a97

Line numbers are of 9281024a97; the planner re-reads each before assigning it. All under `cli/src/`.

1. **An error's stored field:** `lib/windows/ptyUpdate.ts:219` (`error.reason`), `lib/connectors/renew.ts:33`
   (`ConnectorError.detail`).
2. **Process output:** `services/agentBrowser/streams.ts:151` (stderr); `lib/gitProject.ts:382, 386` (git stderr and
   the folder), `:466` (`stopTree`'s string: `process.kill`'s message at 482, taskkill's at 490);
   `core/agents/newPane.ts:215` (captured pane output); `masterProcess.ts:443, 448` (probe stderr and paths);
   `cable/windowsSerial.ts:171` (new).
3. **A peer's or the backend's error string:** `device/deviceLink.ts:1219`; `gateway/start.ts:341`;
   `core/connectorsLink.ts:27`; `services/agentBrowser.ts:589`; `services/agentBrowserProcess.ts:192`;
   `services/followLink.ts:100`; `services/hachi.ts:123`; `lib/e2ee/deviceLogSyncer.ts:303`;
   `services/devices.ts:2204`; `cable/cableSession.ts:2118`.
4. **A stored string:** `backendSocket.ts:1070`; `hookServer.ts:748, 982`; `masterProcess.ts:418` (and the probe
   detail it logs); `harnessd/reexec.ts:617`; `cable/cableHost.ts:439, 442, 488, 1141`; `core/main.ts:3463`;
   `lib/closeAgentService.ts:277`; `lib/createAgentPane.ts:157`; `lib/deleteAgentFallback.ts:89, 131`;
   `lib/restartAgent.ts:197`; `lib/resumeAgentService.ts:203`; `lib/launchOverrides.ts:317`;
   `lib/restoreAgents.ts:622, 672, 730, 811, 823`; `lib/gridAttach.ts:166, 177`; `lib/gridWindowsPin.ts:40`;
   `lib/nodeReferences.ts:45`; `lib/runtimeInstall.ts:371`; `lib/selfUpdate.ts:810, 838, 845`;
   `lib/tmuxBackend.ts:234, 253`; `lib/registry.ts:1642, 1645`; `lib/hostMove/moveAgent.ts:268, 282, 379, 389`;
   `lib/hostMove/mover.ts:121, 153`; `lib/ptyHostBackend.ts:318`; `core/agents/create.ts:185, 227`;
   `core/agents/fork.ts:176`; `core/agents/hostMove.ts:116, 169`; `core/agents/retarget.ts:277, 319`;
   `core/agents/heldLaunches.ts:126`; `core/agents/discovery.ts:371, 375, 390, 395`; `core/engines/hooks.ts:339`;
   `orchestrator/service.ts:445`; `services/agentCleanup.ts:154`; `services/devices.ts:2224`;
   `services/sharedMachines.ts:260`; `services/devicesListener.ts:644`; `cable/hosts/vscodeTerminals.ts:322`;
   `services/agentBrowser/notices.ts:175`; `services/agentBrowser/streams.ts:138`;
   `lib/e2ee/deviceLogSyncer.ts:999`; `dsh/viewer.ts:207`; `dsh/service.ts:57`; `lib/windows/ptyUpdate.ts:150`.
   `dsh/command.ts:82, 85, 93, 96, 120` (and `:70, 86` below) are `harness dsh`'s own output: the file joins `TERMINAL`.
5. **A path or URL:** `config/env.ts:114, 116`; `core/main.ts:3208`; `dsh/service.ts:60`; `engines/launchPrep.ts:45`;
   `engines/kit/launchExecutable.ts:181`; `engines/kit/hookSettings.ts:74`; `engines/kit/nativeHookSettings.ts:93`;
   `engines/kit/nativePlugin.ts:43`; `engines/kit/nativeHookYaml.ts:388, 422, 433, 447, 453`;
   `gateway/upstream.ts:196`; `harnessd/leanServices.ts:78, 96`; `harnessd/master.ts:322`; `hookServer.ts:883, 1188`;
   `lib/cwdRepair.ts:45, 72, 82, 94`; `lib/nodeReferences.ts:44`; `lib/runtimeInstall.ts:279`;
   `lib/tmuxBackend.ts:239`; `watcher/watcher.ts:165`; `core/agents/create.ts:255`; `core/agents/launch.ts:143`;
   `lib/autonomous-device/dump.ts:56`; `lib/windows/dataFolderClaim.ts:164, 175`; `lib/windows/ptyUpdate.ts:212`.
   Kept (serial port names): `cable/cableFleet.ts` and `cable/cableSession.ts`'s port lines, through the one safe
   function of guard rule 3.
6. **Outside the guard's scan:** `testing/launchShapes.ts:62`.
7. **Error words through a name or file the guard does not read** (still open on 9281024a97):
   `lib/hostMove/mover.ts:111` → logged at 121, 153; `harnessd/reexec.ts:298` → `detail` logged at 617;
   `masterProcess.ts:369` `probeLean`'s detail → 443, 448; `lib/windows/ptyUpdate.ts:179, 224` `error.reason` →
   `refuse` → 150; `lib/selfUpdate.ts:332, 355` → logged at 810/838/845; `core/engines/homeAdoptions.ts:34` →
   `core/engines/hooks.ts:339`; `core/engines/pendingAdmission.ts:95, 114` → `hookServer.ts:748`;
   `lib/terminalStreamManager.ts:899, 948` → the diagnostics `core/main.ts:1264` prints whole;
   `lib/ptyHost/stream.ts:194, 217, 225` → where its close and fatal reasons are logged; `lib/machineMcp.ts:80` →
   `why` logged at its sink; the fatal handlers above.
   Not traced by the audit (likely internal codes, the planner confirms each): `gateway/gateway.ts`,
   `lib/remoteRelay.ts`, `harnessd/supervisor.ts`, `harnessd/serviceSupervisor.ts:234, 241`, `cable/cableHost.ts`
   `open (reason)`, `cable/engineTally.ts`, `lib/notifyTier.ts:34`, `lib/restoreAgents.ts:592`.
8. **Same cause beyond the audit, found by the name rules:** `core/agents/create.ts:216, 283, 345`;
   `core/agents/newPane.ts:183, 212`; `core/turns/funnel.ts:230`; `engines/kit/hookReview.ts:246, 266`;
   `engines/kit/hookSettings.ts:123, 127, 135`; `engines/kit/resumeRepair.ts:276` (check: may be a fixed name);
   `engines/kit/transcriptDiscovery.ts:47`; `hookServer.ts:948`; `lib/notifyTier.ts:34`; `cable/windowsSerial.ts:171`.
   The extended guard's own run on the tree is the full list; this one is the estimate.
