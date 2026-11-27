# Small fixes, 2026-11-27: design

One pull request, seven fixes (item 8 moved to its own pull request), approved as a batch by the maintainer ("ok lam di"). Each item was
checked on `main` at d776283ec2 first; none was already fixed. Every behavior change gets a test that fails first, at
the layer where the behavior lives.

Platforms: macOS, Linux, Windows. Windows CI runs by path (`windows-e2e`); the Windows VM or the Dell x64 only after
the orchestrator hands it out.

## 1. `harness device notify` prints `no dial` after the devices said `shown` (Windows)

**Evidence.** `dialWindows.e2e.ts` "harness device notify says no dial before the dial greets, and shown after"
(windows-e2e x64, run 45948212750, 2026-11-27). The daemon log has `[device] notify · agent · shown · plain` at
06:06:58.843; the test failed at about 06:07:04.0 (test 8386 ms from about 06:06:55.6), so the CLI process lived about
5 s after the devices answered, then printed `no dial`. `runNotice` (`cli/src/devices/notice.ts`) prints `no dial` for
anything but a `{ result }` it knows or a 429, so `askDevices` (`cli/src/devices/listenerClient.ts`) returned null (or
a status other than 200 and 429). `notify` on the devices side is synchronous (`cable/notices.ts`), so the listener
answered at once. The test is recorded flaky in `docs/validation-and-release.md` ("Recorded flaky tests").

**Why null is possible today.** `askDevices` catches every throw as null: no target, `PipeUnproven` (an answer
without the token's proof), the 2 s `AbortSignal.timeout` firing while the headers or body are read, a body over
1 KiB, JSON that does not parse, or JSON that is not an object. Nothing says which.

**Leading hypothesis (to prove, not assume).** The CLI's event loop (or the daemon's, which on Windows runs the devices
in the core's process) is held for more than 2 s after the request is written. When it runs again, Node fires the
expired timer before it reads the answer already waiting on the pipe, so the abort wins over an answer that arrived in
time. Other candidates: the answer fails its proof, or the listener answers with a status other than 200.

**Change.**
1. `askDevices` tells its caller why it returns null, in fixed words only, never the message, the answer or a path:
   `no listener`, `unproven`, `timeout`, `status <n>`, `too big`, `not json`, `not an object`, `error <code>`, and for
   a timeout whether headers had arrived. Only `harness device notify` writes it, one line on stderr, and not for
   `no listener` (the everyday case with no devices running, which an agent's shell would otherwise see each time).
   The shared client prints nothing itself: `dial-watch`'s stderr is the Device app's log and `attach` promises no
   stderr (builder check; my call). The test prints the CLI's stderr when it fails. A unit test per reason, red
   first.
2. Prove the cause on Windows: the pull request's own CI runs `windows-e2e` by path once the line lands (the
   orchestrator's word: CI by path, never a rerun to get it green); the Windows VM, asked of the orchestrator first,
   when that run does not show it. Where no run shows the failure, the cause is argued from the code and a unit test
   that reproduces it. The cause and its evidence go in the pull request.
3. On the client side, in every client of the devices that has the same bound (`askDevices`, `tellDevices`,
   `streamDevices`): the bound never drops an answer that arrived inside it, even when the loop runs again only after
   the bound: when the bound's timer fires, the abort waits one loop turn, so an answer already waiting is read first;
   and a timer that fires more than half the bound late (the loop was held, perhaps before the request was even
   written) waits the bound once more instead of aborting (final review). Unit tests hold the loop past the bound
   after the answer lands and before the request is on the wire, red first. If the evidence shows the daemon's loop
   held: fixed here when the cause is small and outside the core; inside the core or large, it goes to the
   orchestrator as its own item (orchestrator's answer).
4. Remove the test's row from "Recorded flaky tests".

## 2. A process an end-to-end run starts outlives `IsolatedDaemon.close()`

**Evidence (from the orchestrator).** A real `codex app-server --managed-daemon` started by an end-to-end run
survived `IsolatedDaemon.close()`, reparented to launchd; earlier fake `codex app-server` processes from end-to-end runs
lived on for two weeks.

**Why the sweep misses it.** `close()` ends the daemon's process groups, then `endRootProcesses`
(`cli/src/testing/rootProcesses.ts`) ends what of the test's tree names the root on its command line or works in it.
Codex's managed daemon detaches itself (its own session, parent launchd), names no root in its argv (its home comes
from `CODEX_HOME`), and need not work in the root, so neither rule sees it. Codex records it in
`<CODEX_HOME>/app-server-daemon/daemon.pid` (`engines/codex/launch.ts` `sharedServer.pidFile`).

**Change.**
The leak came from the tester of #4660 and #4668, which ran the real Codex through `IsolatedDaemon` (the opt-in
`E2E_REAL_CODEX` path or the tester's own harness) (orchestrator's answer). The opt-in real-Codex test stays; only the
cleanup changes: its own kill of Codex's processes goes, so the sweep below is its only cleanup and the test proves
it (orchestrator's answer). No red test for `codexFound` unless a real hole turns up.

The sweep (`close()` and the worker's reaper, `cli/e2e/harness/reaperProcess.mjs`) also ends each Codex managed
daemon a Codex home inside the root records: it reads every `app-server-daemon/daemon.pid` under the root (bounded
depth and count), and ends that pid only when it is this account's, its command is a Codex app server, and it started
after the root was made. Nothing else is ended by this rule: only a process a pid file inside the test's root names
(the orchestrator's word). Unit-tested in `rootProcesses.spec.ts` with a stand-in that detaches, red first.

No change to the fake engine (builder check; my call): its plain `codex app-server` for rate-limit reads already
exits when its stdin ends and the root sweep covers the rest, and a pid file from it would make every daemon under
test see a shared Codex server (`core/engines/nativeControls.ts`). `cli/e2e/harness/sharedCodex.ts` already writes
that pid file on purpose; the sweep must end what it names only when the process matches the rule above.

## 3. dialAppEval tier A pins `Math.random`

PR 4650 pinned `Math.random` (`cli/src/testing/dialAppEval/dialAppEval.spec.ts:44`, and the test at about line 810)
because `AppFilter.fallback` drew lots for a tie; PR 4655 made the tie a fixed rule. Remove the pin and its test when
nothing else in tier A draws from `Math.random`: the existing "a scenario run twice makes the same frames" test must
stay green with the pin gone. If something else still draws, keep the pin and say what in the comment. No behavior
change, so no red test.

## 4. A hanging `codex --version` holds the Codex plugin setup pass

`supportedRun` (`cli/src/devices/codexPlugin.ts`) asks `--version` with a 15 s bound for each home
(`cable/dialCodexPluginSetup.ts` runs every due home in one pass), so a hanging Codex holds a pass up to 15 s per home,
16 minutes with 64 homes. Change: the version is asked once per binary path and modification time. A supported answer
is kept until the binary changes; a too-old one for the hour the setup already waits before asking again; a
`--version` that failed, hung or was refused for one bound (15 s), so the pass asks it at most once per binary and
the next pass asks again (final review: kept until the process ended, a transient hang failed every home for good,
and a version manager's shim kept "too old" after an upgrade). Red test: 64 homes with a `--version` that never answers end the pass after one bound,
not 64.

## 5. Windows: deleting the held temporary file replaces the original error

`replaceConfigText` (`cli/src/devices/codexPluginTrust.ts`, about line 246) runs `rmSync(temporary, { force: true })`
in its `catch`; on Windows a temporary still held throws `EBUSY` or `EPERM` there, and that error replaces the one
that failed the write. Change: the cleanup's own failure is dropped, the original error is thrown. The same cause
anywhere else (a temporary removed in a `catch` or `finally` while an error is on its way: `messages/inbox.ts`,
`homeMove/bridge.ts`, `dsh/preparation.ts`, `engines/resumeTranscript.ts`, `engines/kit/resumeRepair.ts` and any
other the implementer finds) is fixed the same way, through one helper, `removeQuietly` (`lib/removePath.ts`). In a
`finally` the removal's failure is dropped on every path, the work's success included, leaving the stray temporary as
`harnessd` does (orchestrator's answer). Red test: the cleanup throws, the caller sees the original error (and, for a
`finally`, the success).

One way to do a thing (orchestrator's answer): every site that already ignores a failed removal inline or through a
local helper moves to `removeQuietly` too, among them `lib/selfUpdate.ts:457`, `lib/engineLaunch.ts:630`,
`lib/windows/pipeAuth.ts:211`, `lib/localSocket.ts:211/216`. No behavior change there, so no red test. A site whose
removal differs (an `rmdirSync` of an empty folder, a retry, a `catch` that does or rethrows something) stays as it is.

The master keeps its import rule (`harnessd/` imports only Node, its own folder and `../lib/log.js`; orchestrator's
answer): its one copy is `harnessd/leanBundle.ts`'s existing `removeQuietly`, which `harnessd/master.ts` and
`harnessd/reexec.ts` use in place of their inline forms; everything else uses `lib/removePath.ts`'s.

The 13 async removals that end in `.catch(() => {})` (`lib/sessionCheckpoint.ts`, `lib/oneshot.ts`,
`lib/gitProjectFolder.ts`, `orchestrator/service.ts`, `sharing/viewer.ts`, `lib/gridConfigDir.ts`,
`lib/terminalStreamManager.ts`, `lib/nativeProcessImages.ts`) stay as they are (orchestrator's answer).

## 6. An empty `CODEX_HOME` is `~/.codex`

Measured on this Mac with codex-cli 0.172.0: `CODEX_HOME= codex login status` says "Logged in using ChatGPT", and with
an empty folder it says "Not logged in", so Codex takes `''` as `~/.codex`. `config/env.ts`'s `CODEX_HOME` field
(`text(join(homedir(), '.codex'))`) keeps `''`, which only kept parity with the old zod `.default()` (#829), for no
reason of Codex's own, and every reader uses `env.CODEX_HOME` as a home: the devices (`services/devices.ts`
`skillHomes.codex`, `codexHomeRoots(env.CODEX_HOME)`, the `codexHome` it hands on), `lib/worktreeDeletion.ts:106` (it
skips `''`, so `~/.codex` is not protected), `lib/engineHomes.ts` `homeRoots` (`''` gives a relative `sessions`
folder, in the core's process), the Codex hooks and discoveries, and `cli.ts:3123`, which handles it inline.

Change, at the root (orchestrator's answer): that one field reads unset or `''` as `~/.codex`, and anything else as
written, as today. `text()` and every other field stay as they are. Then every reader is right on its own: no helper,
no per-site fix; `cli.ts`'s inline `env.CODEX_HOME || join(homedir(), '.codex')` becomes `env.CODEX_HOME`, and what
the change makes dead goes. The builder checks that no reader relies on `''` meaning "not set" and says so in the pull
request. `config/env.ts` is a file of the core's process: the change is a bug fix, not a feature; `npm run test:core`
stays at 100%, and the pull request says a core file changed and why. Red test, at the env layer: with
`CODEX_HOME=''`, `env.CODEX_HOME` is `~/.codex`. A test at a reader the bug hurt only if cheap: the readers' specs set
`env.CODEX_HOME` past the field, so one proves the fix only when it loads `config/env.ts` with `CODEX_HOME=''`.

## 7. `plugins/harness-device/README.md`: measured hook times

A short section with what was measured, from the pull request bodies of #4660 and #4668: Codex hook start to exit
(Harness CLI start-up included, median of 5) 238-269 ms on macOS and 1.49-1.54 s on a Windows 11 ARM64 VM (about
860 ms of it Windows PowerShell starting), and Claude Code's numbers the README and those bodies already give. Docs
only, no test. The README is carried in cli.js, so the plugin's hash changes and every computer updates the plugin
once; the pull request says so. For Codex, the daemon's pass writes the trust records again for the new copy without
asking the person to review the hooks again (Part 7's rule): proven by the existing
`cable/dialCodexPluginSetup.spec.ts` "trust is written after the install and again after an update" and
`devices/codexPlugin.spec.ts` "codexUpdate … trusts the new copy", both a changed README; the pull request names them.

## 8. Naming: `device_bindings.firmwareVersion` (proposal only)

Moved to its own pull request (`fix/cli-version-field`). Nothing of it is in this one.

## Approaches considered

- One pull request for all items (chosen, as asked) against one per item: the items are small and share no file
  except the CLI's `devices/` folder.
- Item 1, fix by raising the 2 s bound: rejected, it hides the cause and the task asks for the cause.
- Item 2, kill every `codex app-server --managed-daemon` on the machine after a run: rejected, it would end the
  person's own Codex (the sweep judges only the test's own processes).
- Item 4, one bound for the whole pass instead of a cache: the cache also saves the call on every later pass, and a
  pass still asks at most once per binary.

## Left to the builder

The exact reason words and log format of item 1 (fixed words, no content); how the item 2 pid file is found under the
root (bounded). The plan places item 5's helper in `lib/removePath.ts`, a file the core's process already loads, so
none joins it; item 6 changes `config/env.ts`, already one of the core's.

## Verification

- Item 1: `windows-e2e` (x64) on GitHub by hand, the notify test green, and the new line's reason in the evidence.
- Item 2: the opt-in real-Codex case (`e2e/deviceDialSkill.e2e.ts`, `E2E_REAL_CODEX`), run locally on macOS with its
  own kill of Codex's processes gone, so the sweep is the only cleanup; the tester takes `ps` before and after, and no
  `codex app-server` naming the test's home survives.
- The rest: unit tests; `npm run test:core` (core-process files change, items 5 and 6) and `npm run test:harnessd`
  (item 5's move in `harnessd/`), both at 100%.
