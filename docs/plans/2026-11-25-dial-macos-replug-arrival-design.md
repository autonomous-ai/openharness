# Dial: a replugged dial is found at once on macOS

Status: approved by the PM (2026-11-25): option B, in C, size full.
Platforms: macOS only. Linux and Windows are unchanged (#4588 already gives them an arrival signal).

## Goal

After a replug, the daemon finds the dial when its `/dev/cu.*` node appears, not at the next 2 s scan tick. Today a
replug on macOS waits 0 to 2 s (mean about 1 s) for the tick, then about 70 ms for `ioreg`. With an arrival signal it
waits 250 ms (`ARRIVAL_SETTLE_MS`), then the same `ioreg`.

Done when:
- `watchDialArrivals` on darwin returns an unsubscribe and calls `signal` when a `/dev` node is made or removed;
- a node made in `/dev` reaches `signal` in under 5 ms (measured on this Mac, with pseudo-terminals, no dial);
- when the signal cannot be had (no helper in this build, the helper fails to start or exits), one log line says so
  and the 2 s tick finds the dial, as today.

## What the code does today

- `CableFleet` (`cli/src/cable/cableFleet.ts`, run by the devices process `cli/src/services/devices.ts`, not the core)
  scans every 2 s and, since #4588, also 250 ms after the last OS arrival signal it gets from `watchDialArrivals`
  (`cli/src/cable/serial.ts`). An arrival during a scan runs one more scan after it; scans stay serialized.
- On darwin `watchDialArrivals` returns `undefined`, so only the tick runs.
- Each darwin scan (`createDarwinDialFinder`) fingerprints `/dev/cu.*` (name, inode, rdev; about 0.3 ms) and runs
  `ioreg -r -c IOSerialBSDClient` (about 70 ms) only when the fingerprint moved or 5 min passed. So a spurious arrival
  signal costs one fingerprint, not an `ioreg`.

## Measured on this Mac (2026-11-25, macOS 26 / Darwin 25.6, no serial port opened)

New devfs nodes were made by opening pseudo-terminals (`pty.openpty()` 60 times; macOS makes a `/dev/ttysNNN` node for
each pty beyond the free ones, and removes it on close). No dial, no serial port.

| Watch on `/dev` | Events for 60 nodes made + 60 removed |
|---|---|
| Node `fs.watch('/dev')` | 0 |
| kqueue `EVFILT_VNODE` + `NOTE_WRITE` on the `/dev` directory | 70 (`NOTE_WRITE`; `EV_CLEAR` merges events that come together) |

kqueue latency, node made to event: 20 of 20 heard, 248 / 303 / 421 µs (min / median / max), including the
`openpty` call itself.

Why `fs.watch` is deaf: libuv watches a directory on macOS through FSEvents, and devfs feeds no FSEvents. libuv falls
back to kqueue only in a forked child of a process that had a CoreFoundation run loop, which the daemon is not. Node
has no kqueue API. So every working macOS signal needs a native helper.

## Options

| | A. `fs.watch('/dev')` | B. kqueue on `/dev` in a small helper | C. IOKit notification in a small helper | D. Rust `harness-serial watch` on macOS |
|---|---|---|---|---|
| Works | No: 0 events (above) | Yes, measured | Yes (not measured here; needs a real serial device to see it fire) | Yes, as B or C inside it |
| Latency to signal | never | under 0.5 ms | about the same; fires on `IOSerialBSDClient` registration, after its `/dev` node is made | as B or C |
| CPU idle | 0 | 0: blocks in `kevent()` | 0: blocks in `CFRunLoopRun()` | 0 |
| CPU on noise | none | every pty opened or closed by any terminal on the Mac is a signal: one 0.3 ms fingerprint after the 250 ms settle, no `ioreg` | none: only serial ports | as B or C |
| Code | none | about 50 lines of C, libc only | about 70 lines of C, links IOKit and CoreFoundation | Rust crate gains a macOS half, `io-kit-sys` or `libc` |
| Ship | nothing | the CLI's existing macOS helper path (below) | the same | new: build harness-serial for darwin in `release.yml`, publish and install it on macOS, which ships none today |
| Signing / notarization | none | ad-hoc signed, like `darwin-process-images`; written to disk by the daemon from bytes pinned in `cli.js`, so it carries no quarantine flag and Gatekeeper does not assess it; no notarization, no Developer ID | the same; IOKit matching needs no entitlement outside a sandbox | a downloaded binary: same as B if the CLI writes it, else Developer ID + notarization |
| Fallback | n/a | the tick | the tick | the tick |

Matching the Espressif VID (`0x303a`) in the helper under C is not worth it: an `IOUSBHostDevice` match fires before
the CDC driver has made `/dev/cu.*`, so the scan would need a retry. Matching `IOSerialBSDClient` is expected to fire
once the node is there; the daemon's `ioreg` scan still does the VID match, as today. Under B the same holds: the helper says only
"`/dev` changed" and the daemon's fingerprint and `ioreg` decide, the same split as Linux's `/dev` watch.

## Recommendation: B, kqueue on `/dev`, in its own small C helper

It is the Linux design on macOS: watch `/dev`, let the existing scan filter. Measured to work, no frameworks, no new
release job, no notarization. Its noise (pty churn) costs a 0.3 ms fingerprint per burst, and the fleet's 250 ms settle
already bounds it to at most 4 fingerprints a second.

### The helper: `cli/native/darwin-dev-watch.c`

- `darwin-dev-watch --watch` opens `/dev` (`O_RDONLY | O_EVTONLY`), adds `EVFILT_VNODE` (`NOTE_WRITE`, `EV_CLEAR`) on
  it and `EVFILT_READ` on stdin to one kqueue.
- Prints `{"schema":1,"mode":"watch"}` once armed, then `dev\n` once per `kevent()` wake that holds a `/dev` event:
  one line per burst, never one per node.
- stdin at EOF (the daemon closed it or died): exits 0. So the helper never outlives the devices process.
- Any failure (open, kqueue, write): exits non-zero with no output. Wrong arguments: exit 64.
- Reads no names, no ids, no content: nothing it prints is personal.

Its own file, not a third mode of `darwin-process-images`: that helper is the core's process-evidence probe
(`nativeProcessControl.ts`, `processTable.ts`), and a device feature must not change the bytes the core executes
(AGENTS.md, the daemon core).

### Building and shipping it

The `darwin-process-images` path, reused, not copied:
- `cli/scripts/build-process-images.py` builds both helpers (arm64 + x86_64, `lipo`, ad-hoc `codesign`, a host-slice
  smoke run) into the one artifact JSON it already writes: today's fields stay for the process helper, a new
  `devWatch` entry holds the second binary's `sha256`, `size` and `base64`. Same `release.yml` job, same upload.
- `cli/build-bundle.mjs` defines `__DARWIN_DEV_WATCH__` from that entry beside `__DARWIN_PROCESS_IMAGES__`.
- `cli/src/lib/nativeProcessImages.ts`'s `prepareProcessImageHelper` takes the folder name as a parameter
  (`process-images` stays the default), so the dev-watch helper is extracted, hash-checked and kept the same way, in
  `<runtime>/dev-watch/<sha256>`. No other change to that file.
- A dev build without the artifact has no helper: `watchDialArrivals` returns `undefined`, the tick runs, as today.

Why C and not Rust (PM, 2026-11-25): AGENTS.md rule 9 lists no C, but the CLI already ships one macOS helper in C,
`darwin-process-images.c` (#670), and the build, signing, bundling and extraction path above exists only for it. A Rust
helper (option D, or a new crate) would need its own darwin build in `release.yml`, a `lipo` and signing step, and a
publish and install path for a macOS binary, none of which exists today: several times this change, for a 50-line
program that only blocks in `kevent()`. So this helper is C on that precedent, and adds no new language to the repo.

### In the daemon: `watchDialArrivals` on darwin (`cli/src/cable/serial.ts`)

- New dep `spawnDevWatch: () => ChildProcess | null` (null: no helper in this build). The real one awaits nothing
  itself: it starts `bundledDevWatchHelper()` and spawns `--watch` when the path resolves, as the Windows branch does
  with its import.
- Each `dev` line calls `signal()`. The header line and anything else are ignored.
- The helper's exit or spawn error: one line, `cable: /dev watch ended (<kind>) — a new dial is found by the next scan`
  (the Linux wording), no respawn. The tick keeps working; a daemon restart arms the watch again.
- The unsubscribe ends stdin and kills the child; `CableFleet.stop()` already calls it.
- `CableFleet` is unchanged: its settle, its scan-again and its "a discovery given in arms no OS watch" already hold.

Bounds: one helper per devices process; output is a few bytes per burst and the parser keeps no more than one partial
line (`dev` is 3 bytes; a line over 64 bytes is dropped).

## Tests

Red first, at the layer where the behavior lives:

1. `cli/src/cable/serial.spec.ts`: the existing case "on macOS is not watched" becomes
   "on macOS, each line from the /dev watch helper is an arrival", with a fake `spawnDevWatch` (an `EventEmitter` with
   `stdout`, `stdin`, `kill`). Fails today: darwin returns `undefined`. Plus, in the same file:
   - no helper in this build: `undefined`, nothing spawned;
   - the helper exits or fails to spawn: said once, nothing more signals;
   - the unsubscribe ends stdin and kills the helper.
2. `cli/native/test_dev_watch.py`, beside `test_process_images.py`, real kqueue on real devfs, no dial: builds the
   helper with `xcrun clang`, starts it, waits for the header, opens 60 ptys with `pty.openpty()`, expects at least
   one `dev` line within 1 s; closes stdin, expects exit 0 within 1 s; bad arguments exit 64. Red: the file does not
   exist yet.
3. The bundle: the existing `cli/scripts/test-process-images-bundled.mjs` check extended so the bundled dev-watch
   helper is extracted, verified and answers its header.

## Verify without Diego's dial

- Tests 1 to 3 above run on this Mac: none opens a serial port; the only devices they make are pseudo-terminals,
  which they close.
- Latency: test 2 records node-to-line time (expected under 5 ms; measured 0.3 ms in the kqueue probe above).
- The fleet path from signal to scan is already covered by #4588's `cableFleet.spec.ts` cases (settle, scan again,
  no watch for a discovery given in); no new case needed there.
- No e2e: the e2e suite gives the fleet its own pseudo-terminal discovery, which arms no OS watch by design.
- No real replug of a dial: dropped by the PM (2026-11-25).

Local gates: no core file changes, so `npm run test:core` is not needed. The native test, any bundle or e2e check and
any heavy suite run only in a Mac slot the PM grants.

## Size

Full: five to seven files across the C helper, its builder, the bundle define, the helper extraction and the cable
code, plus a shipped native binary. About 200 changed lines, tests not counted.

## Out of scope

- Linux and Windows signals (done in #4588).
- Removing or slowing the 2 s tick: it stays the fallback on every OS.
- A respawn loop for the helper.
