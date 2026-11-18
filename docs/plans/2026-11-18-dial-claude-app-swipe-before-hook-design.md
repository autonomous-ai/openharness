# A Claude app session the scan found switches on a swipe before its first hook

Branch: `fix/dial-claude-app-swipe-before-hook`. Component: `cli/` (the devices process). Platforms: macOS (the Claude
app's link is macOS only); nothing changes on Linux or Windows.

## The bug

Diego (2026-11-18, CLI 0.6.65-dev.3e88129332): the dial lists the Claude app's 3 Claude Code sessions with their names
and recaps (#4391), but a swipe or a tap on one does not show it in the Claude app. Once he sends a message in a
session, swipe and tap work for that session. The daemon log has only `[device] swipe · ok`, no switch.

## Why (read from the code and the log)

- A session the open scan finds is listed with no hook hints (`observed.ts` `entry()`: `hints: {}`, `panes: []`).
- The Claude app's adapter takes a pane only from the hook's hints: `__CFBundleIdentifier` the Claude app's and
  `CLAUDE_CODE_HOST_SESSION_ID` a `local_…` id (`claudeApp.ts` `paneOf`). So the scanned session has no Claude pane:
  `hasPane` is false and a rest shows nothing. A tap does nothing either: `target()` has no pane and no bundle
  (`entry.bundle` comes from a hook, and the Claude adapter has no `bundle`), so the opener cannot open it.
- The first hook (a prompt) brings those hints, `locate()` finds the pane, and from then on the swipe works.
- The scan already reads the session's own process record, `<sessions>/<pid>.json`, for its name (`recordName.ts`).
  Checked on this machine, keys and forms only (no value printed): each of the Claude app's records
  (`entrypoint: 'claude-desktop'`) carries `hostSessionId` in the `local_…` form the link takes; the CLI's records carry
  none. Claude Code 2.1.325 writes that field from the very `CLAUDE_CODE_HOST_SESSION_ID` the hook sends (read in its
  own code: `hostSessionId: UWo()`, `UWo() = …(env.CLAUDE_CODE_HOST_SESSION_ID)`).
- The log agrees: `[observed] scan · 6 found · 4 app known · 3 named · 6 answered`, then `[device] swipe · ok` lines and
  no switch.

## The fix

The Claude app's adapter places a session the scan found as the Codex app's already does (`codexApp.ts`: the app the
scan gave it decides, and the id comes from the session's own file):

1. **The record gives the app's session id.** `recordName.ts` becomes the record's one reader for the scan:
   `readRecordName` becomes `readRecord(owner, opts)` (file renamed `record.ts`), answering `{ name?, hostSession? }`.
   `hostSession` is the record's `hostSessionId` when it is a string, `entrypoint` is `'claude-desktop'` and the
   record's `sessionId` is the listed session's (decision 6 of the session-name spec, as for the name). Every other
   check stands: the record's path, the 16 KiB bound, JSON. It keeps nothing and logs nothing. Its doc comment lists
   the fields it reads.
2. **The scan keeps it on the entry until the first hook.** `ObservedDeps.recordName` becomes `record`; `namesOf`
   becomes `recordsOf`, one pass, answering both; the scan's `named` count still counts names only, so its log line is
   unchanged. In the scan loop, before `pair()` and `learnTty()` (both call `locate()`), the entry takes
   `hostSession`. The first hook clears it, beside `entry.paired = undefined`, before its `locate()`: from then on the
   hook's hints place the session, as today.
3. **`Place` gains `hostSession?`**, set by `locate()` from the entry. The Claude adapter's `paneOf` takes a pane from
   either the hook's hints (unchanged) or, when `place.app === 'claude'` and `place.hostSession` passes
   `CLAUDE_SESSION`, from that. `place.app` is the app the scan read from the session's parent processes
   (`scannedApp.ts`, a bundle id from the app's own Info.plist), so both the parents and the record must say the Claude
   app: a record alone, or the app alone, places nothing. A session paired with an hc terminal has `app: 'herdr'`, so
   the pairing wins with no rule of its own. A session whose app the scan did not learn (the 16-bundles-a-pass bound, a
   bundle with no id) stays unplaced until its first hook, as its name's app does today.
4. **A tap whose link fails brings the Claude app forward** by the adapter's bundle: the Claude adapter gains
   `bundle: APP_BUNDLES.claude` (`HostAdapter.bundle`), and `target()` takes it when no hook gave `entry.bundle`. The
   opener's own fallback then brings the app with its one line, `[device] open · claude · fallback`, as for every pane:
   no forward of the adapter's own, so `open -b` runs once even when the link and the app both fail. The comment in
   `claudeApp.ts` says why it has no forward.
5. **Then everything works as after a hook.** `hasPane` is true while the Claude app is in front, a rest runs one
   `claude://code/continue?session=<local_…>` link to the Claude app alone (`appLink.ts`), a tap runs the same link.
   The safety rules stand unchanged: a rest shows the session only while the Claude app is in front, nothing is ever
   typed into it (the Claude adapter has no `type`), and an id that fails the form never reaches a command (checked in
   `paneOf` and again in each verb).

`devices.ts` wires `readRecord`. Tests that pass `recordName` (`observed.spec.ts`, `devices.spec.ts`) move to `record`.

Nothing in the core changes: every file is in `cli/src/cable/hosts/` and `cli/src/services/devices.ts`, the devices
process.

## Out of scope

- Codex app sessions found by the scan: Diego reported the Claude app; the Codex app's link takes the thread id, which
  the scan already has, and is not part of this report.
- Any new log line: the scan's line keeps its counts.

## Design (docs/feature-design-rules.md)

1. Growth: nothing is stored. The `local_…` id lives on the entry in memory and leaves with it (session end, process
   gone, eviction past 50, 12 h of silence).
2. Concurrency: unchanged. The scan reads every record before its loop and sets the place with no await between, as it
   sets the name.
3. Read cost: none added. The same one record read of at most 16 KiB per session first listed; one more field taken
   from the parsed JSON.
4. Exposure: the `local_…` id goes only into the link to the Claude app (`open -b com.anthropic.claudefordesktop`),
   exactly where a hook's goes today. Never logged, sent to a dial, stored or synced. No process environment is read:
   the record is a file the session writes itself, already read by the scan.
5. Compatibility: a record with no `hostSessionId` (an older Claude Code) places nothing, as today.
6. The session-name spec's decision 5 lists the record's fields the devices read; it gains `hostSessionId` (and
   `recordName.ts` becomes `record.ts` there), and points here.

## Tests (red first)

- `recordName.spec.ts`: a Claude app record gives its name and `hostSession`; a CLI record gives no `hostSession`; a
  record for another `sessionId` gives neither; a non-string `hostSessionId` gives none.
- `claudeApp.spec.ts`: `paneOf` takes `{ app: 'claude', hostSession: local_… }`; refuses it under any other app, with no
  `hostSession`, and for each malformed id; the hook's hints still work. Its `bundle` is the Claude app's; a tap whose
  link failed answers false and runs nothing more.
- `open.spec.ts`: a scanned session's target, its pane and the adapter's bundle, opens by its link; a failed link
  brings the app once with one `[device] open · claude · fallback`; a link and an app that both fail run `open -b`
  once, in one line.
- `observed.spec.ts`: a session the scan found, with the Claude app's parents and a record's `local_…` id, has a Claude
  pane before any hook: `hasPane` while the app is in front, `showPane` shows that id, a tap opens it; with only one of
  the two (the record's id under a Ghostty parent, or the Claude app's parent and no id) it has none; the first hook
  places it by its own hints (another `local_…` id wins); a Herdr pairing wins.
- `devices.spec.ts`: with the Claude app in front, a rest on a scanned Claude app agent runs one continue link to the
  Claude app and no `open -b` of its own, with no hook sent.

## Verification

No end-to-end check: no end-to-end test may reach `/usr/bin/open` (the Claude app follow plan), and the link is covered
by unit tests with a recording runner. Diego checks it on his machine after the merge (he waived the pre-merge checks
for today's dial work): restart the daemon, swipe to a Claude app session he has not typed in since, and it shows.
