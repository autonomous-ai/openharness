# Dial: the focus echo guard only for firmware that echoes (eval C11 on Linux)

Date: 2026-11-22. Branch `fix/dial-focus-guard-echo`. Dial eval hill-climb #3: the Claude app, D7, scenario C11.

## Problem

`a/linux/C11/focusKept` is 0 after #4539 (darwin and win32 are 1). The person turns the dial to b, unplugs it, plugs it
back in, and the dial comes back on a.

What tier A shows on Linux (a scratch run with the devices' log printed, not committed):

```
+1000 ms  agents → 2 of 2              caps sf   (re-asserts the record: focus a, opens the 750 ms window)
+2000 ms  agents → 2 of 2              caps svf  (the same ring, now with voice: re-asserts a again)
+2400 ms  swipe to b → dropped dial focus b — waiting for a
+3000 ms  unplugged: the record is a, the fleet keeps a; the replug restores a
```

On macOS and Windows the first push already carries `svf`, so there is no second push and the swipe lands.

### Why Linux pushes twice

A Claude app session is offered voice (`v`) only once its link is known to open
(`cable/hosts/appLink.ts` `canLink`). On Linux that is an `xdg-mime query default x-scheme-handler/claude` run, started
at the first look and answered later; a look before the answer says no. So the first ring after the first attach goes
out as `sf`, the answer lands, and the next tick pushes the same ring as `svf`. On macOS and Windows the link opens by
the app's bundle and `canLink` answers yes at once. On a replug the answer is kept from the first attach, so the second
attach pushes `svf` straight away.

The code path: `appLink.ts` `canOpen(session, unread)` answers `appOf(scheme).app ?? unread` on Linux, and `canLink`
asks it with `unread = false` ("Voice is not offered before the scheme is known to have an app"); the first call starts
the `xdg-mime` read. The caps letters are part of the ring's key (`cableSession.ts` `agentsKey`, `${a.caps}`), so the
ring whose rows went from `sf` to `svf` differs from the one the dial holds, and `syncAgentsNow` pushes it at the next
tick, then re-asserts the record. Confirmed in a scratch tier A run that logged the key of each push: on Linux the first
push's rows end `claude:sf` and the second's `claude:svf`; on macOS and Windows the first push already ends `claude:svf`
and there is no second.

**It should push.** The ring did change: the dial must learn that voice now works on these rows. What should not happen
is what the push sets off: every ring push re-asserts the record (`syncAgentsNow`, "say again which agent both screens
are on") and opens the 750 ms window, and a real turn inside that window is dropped.

### Why a real turn is dropped

`APP_FOCUS_SETTLE_MS` (`cli/src/cable/cableSession.ts`) is set whenever the daemon commands a focus: the re-assert after
a ring push, the landing of a machine list that follows none, and `follow()`. Until the commanded agent comes back from
the dial (or 750 ms pass), every other `focus` from the dial is dropped as a redraw.

That guards one thing: old firmware that reported a move the daemon made, a carousel re-anchor, as though a hand made
it. Its own comment says the echo is "gone at the source now". In the firmware sources:

- **Round dial.** The fix that stops a code-made move from reporting (`carousel_goto`, muted) landed in the firmware on
  2026-09-08 (commit `7348a91187` names it), before the firmware moved into this repo. The first firmware in this repo,
  **0.0.59** (`80f4bc84c4`, 2026-09-14, `device/esp32-circle/main/ui/ui_screens.c` lines 571-575 and 678), already has
  it ("muted: code moved it, not a hand"). Which of the versions before it got the fix is in the retired repo, so every
  one of them counts as echoing. The current firmware (habitat UI, 0.0.94) sends `focus` only from `A_AGENT`, which only a touch, a
  swipe or a tap on a notice raises (`ui_habitat.c`); a daemon `focus` goes to `ui_focus_project`, which sets the tile
  and sends nothing.
- **Harness Pro.** Its own firmware (`devices/harness-pro/firmware`, since 2026-10-11) never sends `focus` at all; a
  daemon `focus` goes to `pod_ui_focus`, which sends nothing.
- Every firmware greets with `fw` (`send_hello`, in 0.0.59 as today, and the Pro's `pro_cable.c`; the daemon logged a 0.0.37 install by it on
  2026-08-24). A greeting with no `fw` is from no shipped firmware: today only test fakes, the eval's loopback dial
  among them, send one.

So only a round dial on firmware **older than 0.0.59** can echo. Firmware updates itself from the public manifest at boot
and every 6 h (`RELEASE.md`), so such a dial is one that has stayed offline since mid-September; it is kept safe all the
same.

## Design

### 1. The echo guard only for firmware that echoes

The session reads `hello.fw` already (`greetedFw`). A dial **echoes code-made moves** when its `fw` parses as
`X.Y.Z` (a suffix such as `-dev` or `-pod` ignored) and is below `0.0.59`, read with the parser the daemon already has
(`semverGt` in `cli/src/lib/selfUpdate.ts`: `semverGt('0.0.59', fw)`). Everything else does not: a later version, a
greeting with no `fw` (`'?'`) or one that does not parse (no shipped firmware sends one), and no greeting yet
(`greetedFw` null: no dial on the port sends no `focus`).

**The Harness Pro is decided by its own firmware, not by the round dial's numbering** (PM, 2026-11-22). Its own
firmware (`devices/harness-pro/firmware`, numbered on its own: 0.0.99-pod dev builds, 0.1.x published) greets with
`board: "pro"` in every version since it began (`d93bf11386`, 2026-10-11, `pro_cable.c` `send_hello`), and no version
of it has ever sent a `focus` frame: `git log -S'"focus"' -- devices/harness-pro` finds only that first commit, which
added the receiving side (`pro_cable.c` → `pro_app_focus` → `pod_ui_focus`, which sends nothing). So a greeting with
`board: "pro"` never echoes, whatever its `fw`. A Pro unit that still runs the shared round firmware (the Player-1
build, which says no `board`) is a round dial to this rule and follows its threshold.

- For a dial that echoes: the 750 ms window works exactly as today.
- For one that does not: a `focus` from the dial is always the person's, so it is taken: the record, `host.focus` (or
  `markSeen`), `turned`, the rest, as for any turn. The window's fields are not set for such a dial at all, so nothing
  is left waiting for an echo.

One named threshold, with a comment naming the firmware and the commit that made it so.

### 2. Left as they are

- **The Linux second push.** It carries the voice rows the dial needs (above). With 1, the re-assert it makes is
  silent on current firmware and swallows nothing.
- **A turn that crosses a daemon focus on the cable.** The daemon sends focus a (a re-assert or a follow) in the same
  few milliseconds the person turns to b: the dial applies a after the turn while the daemon takes b. The guard used to
  keep the two screens on one agent there by dropping the turn, at the cost of every turn in the 750 ms that followed.
  A fix that sends the turn's agent back to the dial was weighed and left out: a quick swipe through several tiles would
  have the dial jump back along its own path, cancelling a touch each time (`ui_focus_project` runs `input_cancel`).
  The window that remains is the cable's round trip, not 750 ms; the next ring push re-asserts the record and corrects
  it.
- **The switch repaint guard** (`APP_SWITCH_REPAINT_MS`, 1 s while `follow()` drives the dial). The same old-firmware
  cause, but taking a turn there while a follow is still in flight would let the follow's own focus, sent after it,
  turn the dial away from the hand while the window stays on it. Fixing that needs the follow to yield to a turn: a
  change of its own, not in this branch.
- **The time from replug to ring**, measured below: reported as a separate item.

## Replug to ring, measured (tier A, Linux, C11)

| From | To | Time | Why |
|---|---|---|---|
| replug | port open, +2 s | up to 2 s | the fleet looks for the dial every 2 s (`cableFleet.ts` scan) |
| port open | ring with the Claude app's rows, +3 s | 1 s | the attach's forced push goes before the Claude app source has listed (its watch starts with the attach); the list then waits `AGENTS_PUSH_GAP_MS` (1 s) after that push |

About 3 s in all. Neither part is a one-line change:

- The scan: replacing the 2 s poll with the OS's own USB events is push-not-poll work on three platforms.
- The 1 s: letting a dial that holds no agent skip the 1 s gap changes the push pacing every dial and every app sees,
  and the eval's other scenarios with it.

So it goes to the maintainers as its own item ("Dial: ring within 1 s of a replug"), not in this branch.

## Tests

Red first, at the layer where the behavior lives (`cli/src/cable/cableSession.spec.ts`):

1. **From the scenario (fails today):** a dial greeting with current firmware (`fw: '0.0.94'`) on a machine ring; a
   ring push re-asserts a; the same ring pushed again with new caps re-asserts a again; a turn to b 400 ms later is
   taken: `host.focus('b')`, `turned`, and a later push re-asserts b, not a.
2. **The same for a greeting with no `fw`** (as the eval's loopback dial greets), **and for a Pro** greeting with
   `board: "pro"` and an old-looking `fw: '0.0.1'` (as the spec's Pro fixtures do): the Pro is never guarded.
3. **Old firmware stays safe:** with `fw: '0.0.58'` the echo is still dropped and a stale tile inside 750 ms is still
   dropped. The existing tests that rely on the guard greet with `fw: '0.0.58'` from now on, so they keep testing the
   firmware they are about; at the time of writing (`cableSession.spec.ts`, by their lines on `52f0dd69f5`): 1659
   (a stale tile after a remote switch), 2971, 5742, 6931, 7753, 7769, 7799 and 8013, through the `HELLO` constants
   (5497, 8172) or the `greet` helpers (5801, 6213) where those are what they use. The plan lists them exactly; any
   other test that fails because the guard is gone for its greeting is read before it is changed, and changed only when
   it tests the old firmware's echo.
4. **The threshold:** with no `board`, `0.0.58` echoes; `0.0.59`, `0.0.94`, `0.1.0-dev`, `1.0.0`, `'?'` and null do
   not. With `board: "pro"`, none does (`0.0.1`, `0.0.99-pod`, `0.1.16`).

The eval: `a/linux/C11/focusKept` turns 1 with no change to the eval or its checks. Both tiers rerun under
`caffeinate -i`; the Claude app's score rises, the ChatGPT app's does not drop, wrong-session sends stay 0, and
`baseline.json` is updated in the same pull request.

## Platforms

The change is in the devices process's cable session, the same code on macOS, Linux and Windows. Tier A runs C11 on all
three; tier B on macOS (and Linux where a Linux host runs it).

## Not in scope

The firmware (no firmware change), the eval and its checks, the switch repaint guard, a turn that crosses a daemon
focus on the cable, the replug timing.
