# Question polling: fewer tmux processes, fresh terminal reads

The daemon profile identified repeated `QuestionWatcher` → `captureTerminal` →
`captureTmuxPane` calls as its largest application call path. Each watched session
had a separate 1.5-second timer and spawned a tmux client for every read. A slow
read could overlap the next tick; a late result could announce a question after
the watcher stopped. Failed reads also counted as an empty screen.

The watcher now shares one 1.5-second clock. Concurrent captures share a tmux
invocation, in groups of at most 32. The capture queue lasts one microtask and
does not cache screen contents. A single read uses the direct capture command.
Input-driving and Resume reads still obtain a fresh screen.

Each capture has independent framing. When tmux stops a compound command at a
missing pane, complete results are retained and unfinished reads retry separately.
Batch output is capped at 4 MiB and individual results at 1 MiB. Each returned
string owns its storage so a retained question cannot retain the other panes'
output. There is no background timer in the capture queue.

The watcher allows one pending poll per session. Stops, new turns, changed
processes, changed terminal routes, and loss of an audience invalidate late
results. It rechecks whether an answer is being entered before announcing a
capture. A failed read breaks the consecutive-empty-read count; only two valid
empty reads close a question. Shutdown clears the polling clock and saved
baseline/diagnostic state.

## Local measurements

The committed [raw samples](2026-10-01-question-poll-data/native-macos.json) come
from a private macOS ARM64 tmux server with recorded dialog paint, Node 22.23.2,
five warmups, and 30 measured rounds per mode. Direct and batched modes alternate
order. Every result is checked byte-for-byte against direct capture output.

| Concurrent pane reads | tmux processes per round, direct → batched | Median wall time, direct → batched | Node CPU over 30 rounds, direct → batched |
| --- | --- | --- | --- |
| 1 | 1 → 1 | 3.514 → 3.547 ms | 12.621 → 14.188 ms |
| 8 | 8 → 1 | 5.986 → 5.001 ms | 108.187 → 19.095 ms |
| 32 | 32 → 1 | 18.894 → 9.893 ms | 441.398 → 41.187 ms |

Node CPU for these reads fell about 82% with eight panes and 91% with 32 panes.
The single-pane case has small queue overhead and essentially unchanged latency.
The fixture measures reads that reach tmux together. In the daemon, reads that
first await control-lease validation may reach tmux in different event-loop turns
and therefore may not batch. Those input-safety checks are unchanged.
These measurements exclude tmux client/server CPU, GPU work, and the desktop UI.
Other development processes were running on the host. They do not establish a
whole-app energy reduction or the requested 100-fold resource target.

## Validation and reproduction

From `cli/`:

```sh
node --import tsx scripts/question-poll-native.ts /tmp/question-poll.json
```

The native fixture creates a private tmux socket and 32 synthetic panes. It
verifies question identity, deduplication, answer routing through the real
controller, two-read close confirmation, stale-answer refusal, reopening,
missing-pane isolation, failed-read preservation, and timer teardown. Its first
shared tick used one capture process and announced all 32 questions in 1.554 s.
It kills only its private server, verifies its remaining 31 pane processes exit
(one was deliberately removed earlier), and removes its temporary files.
The dialog fixture clears both screen and history when dismissing a question;
it uses recorded terminal paint, not a live model or an authenticated engine.

The manual CI workflow runs this native fixture on Linux x64 and ARM64 as well.
Unit regressions cover slow and overlapping reads, stop/restart races, stale
turn-start baselines, process/PID replacement, changed routes, audience changes,
answer-in-flight changes, unavailable captures, bounded output, and malformed
targets. Actual Claude/Codex lifecycle checks run separately through
`scripts/resume-native-e2e.ts`; no installed app or user session is replaced by
these fixtures.
