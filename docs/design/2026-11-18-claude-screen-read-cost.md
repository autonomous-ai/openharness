# Claude screen read cost

## Design

The shared-input comparison still reports more process CPU than `11bca810e4`. The original
`/tmp/shared-input-profile-v1-results` diagnostic attributes about 5.7 ms to Claude's takeover
reader and 2.2 ms to its rewind reader across 2,000 ordinary writes. Those sampled intervals are
attribution, not a process CPU comparison or a claim that this unchanged reader caused the regression.
Ordinary and tracked input still capture and validate 4,000 times per 2,000 writes on both sides.

Each full Claude screen read currently asks the same synchronous takeover reader twice: once for
the pane inspection and once for its modal. Each takeover read strips and splits the full capture,
then its private rewind helper strips and splits it again. Compute the takeover once for a full
screen read and pass that result through a local callback to the existing pane and modal readers.
Pass the already normalized lines to the private rewind reader. Its trimming and matching stay the
same. Standalone pane and modal readers continue to compute their own current takeover.

The coordinator approved this scope before implementation. No normalization is shared with other
screen readers: raw ANSI carries draft and composer meaning. No value survives a synchronous read;
there is no cache across captures, new module, core map, timer, IPC call, stored record, public format
or migration. The engine worker and explicit inline compatibility use the same reader. Input's
writer, binding checks, caller revocation, composer recapture and uncertain-effect handling do not
change. Rollback restores the reader alone. This affects common TypeScript on macOS, Linux and
Windows; host-mocked tests do not establish native Windows acceptance.

## Selected validation

- RED public full-screen and standalone-reader calls count complete capture normalization while
  executing the real parser; the unchanged implementation repeats it four or two times.
- Existing pane, runtime-profile, composer and message-hold cases retain ANSI, Windows prompt,
  rewind/history, trust, boxed composer and historical-dialog behavior. Shared-input caller tests
  retain binding, connection, uncertainty and writer fences. No count, bound or deadline is loosened.
- Typecheck and architecture checks. This slice changes no core or service file, so it does not
  replace the integration's required per-file core/service coverage gate.
- Root schedules the unchanged frozen input cost fixture only after review and an explicit quiet
  marker. Report CPU, latency, traffic, retention and cleanup against the recorded baseline. Fewer
  normalization calls alone are not performance acceptance. Legacy Wi-Fi traffic removal remains
  held until the separate immutable worker-cohort proof is reviewed.

## Author evidence

Pinned Node 24.22.2 and the unchanged dependency tree: the four new cases fail first, with full
screen reads normalizing four times and standalone reads twice (`/tmp/shared-input-reader-red.log`,
actual exit 1). After the change, all 319 selected cases pass across the new reader, kit pane,
composer, message hold, runtime-profile controller, core input, session input and architecture
specs at one worker (`/tmp/shared-input-reader-green.log`, actual exit 0). Typechecking also exits
0 (`/tmp/shared-input-reader-types.log`). No performance or native workload has run for this change.
