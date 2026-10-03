# Terminal byte decoding: fewer temporary buffers

A fresh daemon CPU profile on October 1 still showed terminal streaming among
the larger application paths. Its tmux decoder copied the incoming bytes, made
a separate one-byte Buffer for every octal escape, kept views for the intervening
text, and concatenated them into another allocation.

The decoder now compacts one owned copy in place. A native byte search skips
ordinary text and literal backslashes before the first complete escape. When
escape-heavy input shrinks below half its wire size, a final compact copy avoids
retaining the larger allocation. Consumers still own their result independently
of the input; Unicode is never decoded as text along this path.

## Measurements against CLI 0.3.45

The [raw samples](2026-10-01-terminal-decode-data/native-macos.json) compare the
exact decoder from commit `bb0cf693a829d2cebb4b8be285c59582a969d8df` with the changed
decoder on macOS ARM64, using the shipped Node 22.23.2 runtime. Each input has 100
warmups and 30 alternating rounds of 200 decodes. The question input comes from
recorded terminal paint; the other inputs are synthetic.

| Input | Encoded bytes | Previous Node CPU | Changed Node CPU | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Plain text | 4,370 | 52.699 ms | 5.755 ms | 89.1% |
| One leading escape | 32,772 | 426.059 ms | 285.323 ms | 33.0% |
| One trailing escape | 32,772 | 222.731 ms | 11.235 ms | 95.0% |
| Literal backslashes | 4,115 | 33.488 ms | 3.053 ms | 90.9% |
| Recorded question | 4,626 | 134.282 ms | 40.746 ms | 69.7% |
| Styled Unicode | 42,000 | 2,970.352 ms | 300.599 ms | 89.9% |
| Escape-heavy control bytes | 32,000 | 4,325.111 ms | 154.324 ms | 96.4% |

These are totals over 6,000 decodes per mode. They measure only this function,
including its allocations and garbage collection during the measurement. They
exclude tmux, transport encryption, rendering, and other app work. The host had
other development processes running. They do not establish whole-app CPU,
physical-memory, battery, or a 100-fold improvement.

## Correctness and reproduction

From `cli/`:

```sh
node --import tsx scripts/tmux-decode-bench.ts /tmp/tmux-decode.json
npx vitest run src/lib/tmuxStream.decode.spec.ts src/lib/tmuxStream.spec.ts src/lib/terminalStreamManager.spec.ts
RUN_REAL_TMUX_STREAM=1 npx vitest run src/lib/tmuxStream.real.spec.ts
```

The focused suite covers all 512 three-digit octal values with the existing
byte-truncation behavior, incomplete and invalid escapes, ordinary backslashes,
nonzero-offset inputs, independent buffer ownership, bounded retention of large
escape-heavy frames, Unicode split at every byte, and 1,000 deterministic
differential cases against a separate byte-oriented reference.

All 106 focused tests and seven real macOS tmux tests passed after integration
with the current main branch. The real suite
streams a large styled Unicode payload containing literal backslashes and NUL
bytes, then checks it byte-for-byte. It also checks paste, snapshots, resize,
handshake races, and the common stream-manager path for each engine label. The
focused manager suite checks backpressure. Engine labels are test inputs, not
separate authenticated model runs. The native suite uses a
private tmux socket and ignores user tmux configuration. Both Linux CI jobs now
run the same native suite.
