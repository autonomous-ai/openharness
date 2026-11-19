# Input during a restored launch

Design before code. Native receipts `20261119T122014.925969Z-78174` and `20261119T122651.474758Z-1975` show both Claude and Codex rejecting a message while the restored engine is still behind its shell startup gate. A live pane is not authority to type into that shell. The controller must wait for the exact restored launch to publish its native process, then take the ordinary runtime, reader and terminal lease checks.

Use the existing lifecycle revision from restart jobs. Only an already-bound conversation with a starting launch and no process enters the new wait. Bound it by the existing 15-second lease budget. Retain the agent, conversation, binding timestamps and terminal placement; require the same native launch token while starting and the same lifecycle revision throughout the input. Stop, restart, retarget, caller cancellation, changed binding or failed launch refuses the pending message. A ready publication may supply its process and evidence revision; take a fresh complete input binding only after these checks. Never relax the existing terminal lease or write into the shell.

- Growth: no persistence or new queue. The existing bounded per-agent input queue and writer own pending content; each active wait ends within 15 seconds.
- Concurrency: existing one input writer per agent; lifecycle revision revokes pending intent before a replacement operation.
- Read cost: only this agent's in-memory row every 250 ms while its restore starts; normal ready input does not enter the wait.
- Scale: bounded by existing input limits. Timeout has a fixed named log and the caller receives a visible error; measure normal input cost and verify no extra runtime probes before readiness.
- Compatibility: no wire or stored-data change. Reuse the existing `message_waiting` event and `waitingFor` frame field. No backend migration.
- Migration and rollback: N/A; reverting changes no persisted data.
- Audience and identity: existing caller authority and native process/lease validation remain required. A revision or binding change never transfers queued input to another launch.
- Failure: timeout, cancellation and launch failure release the waiter and leave the message unwritten; uncertain writes retain existing reporting.
- Platforms: shared TypeScript on macOS/Linux/Windows; real private tmux tests on macOS, Linux native CI; native Windows deferred by the user.

RED: `20261119T123234.399268Z-15500` rejects before waiting and validates a process that has not yet been published. The native regression uses an explicit shell gate and waits for the daemon's waiting/error event, with no timing sleep.

Evidence on the integrated checkout before publication:

- `20261119T123345.111964Z-16590`: 864 passed, two platform skips, TypeScript passed. The caller plan accidentally selected 32 files through an extra `2` selector; all completed successfully, and the narrower later plan corrects the selector.
- `20261119T123627.272904Z-19554`: 266 input/binding checks, TypeScript and seven native cases passed (both gated restore engines, model switching, four OpenCode history/Stop/resume cases).
- `20261119T124051.588184Z-28667`: 26 restored-input cancellation and cost-invariant checks passed after moving the lifecycle revision check to the restored binding alone.
- Normal ready input, eight matched ABBA arms, 30,000 messages each: initial change CPU +1.24%, elapsed +1.63%; restored-only revision guard CPU +1.01%, elapsed -0.33%. Frozen inputs and samples are retained in `/tmp/core-restore-input-cost-v1` and `-v2`. These short samples do not establish the whole refactor's performance acceptance; longer matched measurement remains open.
