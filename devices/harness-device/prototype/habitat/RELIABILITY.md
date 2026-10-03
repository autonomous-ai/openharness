# Device release checks

A passing source test is not evidence that the installed app contains that fix.
The missing native activity footer was caused by an installed CLI bundle without
the activity provider, while the development source contained it. The device
received turn liveness but no native status words. The release check now inspects
and exercises the exact built artifact, then replays its framed output through
the firmware's C parser, turn handlers, scene builder, and RGB565 renderer.

## Repeatable software gate

Install the CLI's locked dependencies and set `IDF_PATH` to the firmware's SDK.
Use a host C compiler with working AddressSanitizer and UndefinedBehaviorSanitizer.
The serial regression uses an isolated pseudo-terminal and loopback server; the
environment must permit those. It does not open the connected device.

```sh
python3 devices/harness-device/firmware/test/device_release_check.py \
  --bundle /path/to/the/built/cli.js \
  --firmware-image /path/to/the/built/firmware.bin \
  --out /tmp/device-release-check
```

The output directory must be new or empty. The command returns nonzero on a
failure, missing prerequisite, or changed input during the run. It records hashes
of the bundle, any status helper, firmware image, SDK JSON parser, and tested
sources. Recording an image hash does **not** establish that it was built from
those sources: the build must separately record and verify its source inputs.

The artifact inspector never runs the CLI entry point. It evaluates the actual
built CableSession and wire codec in a fixture, plus its local activity provider.
An unsupported bundle shape is a failed check, not a fallback to source tests.
The inspector supports the minified release shape, the narrow status repair, and
the bundled companion controllers. It loads only definitions and literal constants;
CLI startup and I/O imports never run. Changes to bundling require updating this
adapter explicitly.

## Acceptance matrix

| Boundary | Required cases | How it is checked |
| --- | --- | --- |
| Installed activity wiring | Codex Working, Claude activity, absent footer, capture failure, local-only capture | Actual built class and provider; fixture terminal |
| Delayed work | Completion, summary, error, focus switch, disconnect during status capture | Deferred fixture replies must not revive old work |
| Work/result alternation | Working hides the old recap; completed turn shows it; next turn hides it | Built wire output through production C handlers and raster |
| Protocol | Fragmented frames, CRC, malformed and oversized JSON, reconnect, repeat hello | Built codec comparison and native transport/JSON suites |
| Navigation | Populated/empty tab round trips, stale roster, timeouts, failed queues | Built bridge fixtures plus production UI contact tests |
| Touch and notifications | Tap/drag separation, holds, target changes, raised arc ends, wide count target, read/open/clear | Production gesture/UI replay, including 200,000 mixed pane/inbox events |
| Voice | Start/finish/discard/retry, pinned recipient, buffers, races, backpressure | Host source contracts and native C suites; not real STT or installed voice E2E |
| Memory and display | Bounds, partial/full-frame equivalence, cache limits, allocation failures, sleep/wake | Native ASan/UBSan and targeted fault/concurrency tests |

The initial built-artifact suite has 18 cases. The activity repair passed 18/18;
the previous installed artifact passed only 5/18 and was correctly rejected.
Four actual output sequences are replayed at four fragmentation sizes, giving
16 C render replays. These are defined acceptance cases, **not 100% line or branch
coverage**, and do not prove every possible edge case has been found.

## Native desktop fixtures

Run the six device interaction scenarios together so Flutter launches one native
fixture process:

```sh
cd desktop
FLUTTER_TEST=1 flutter test -d macos --no-pub \
  integration_test/native_device_e2e_test.dart
```

The fixtures use synthetic terminals and in-memory state for Finder, New Harness,
output search, passage selection, reading position and notification visits. They
assert navigation and retained native renderer state, not physical focus or input.
Rebuild the ordinary review artifact afterward, as described in `desktop/CLAUDE.md`.

## Before merge and before installation

1. Run the repository's required CLI and desktop checks for changed packages.
   Run real multiplexer tests when changing terminal discovery or input.
2. Build the candidate firmware and bridge from recorded inputs. Run the gate on
   that bundle; inspect generated device previews at the real 466 px size.
3. Check compatibility with the shipping bridge. Optional device commands must
   use advertised capabilities or existing fallbacks; they must not hang older apps.
4. Install only the validated files. Compare installed hashes after restart.
   Preserve unrelated app changes. An updater replacing a binary invalidates its
   earlier test evidence and requires checking the replacement artifact again.
5. On hardware, verify boot/version, live native footer delivery, memory health,
   touch/animation progress, and no panic/drop markers. Separately record a real
   speak/send/discard/retry, scroll, tab switch, and completion/notification round
   trip when a person can exercise the device. Logs alone are not proof of what
   the physical panel or microphone did.

Physical finger-to-photon latency, microphone quality, transcription service
behavior, native desktop focus, and firmware OTA recovery remain separate checks.
Do not mark unavailable hardware or real-engine rows as passed. Hardware timing
must report the measured interval; render CPU time is not end-to-end latency.
