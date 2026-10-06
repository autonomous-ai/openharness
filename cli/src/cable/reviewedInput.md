# Reviewed local Goal and Loop delivery

This is the CLI's private implementation contract for the existing cable voice
draft messages. It adds no message, capability bit, or public payload field.

1. **RI-1 — Scope.** A recording with `cmd: goal` or `cmd: loop` and a reviewed
   `voice.end` uses this path for any cable device, including a round device that
   opts into review. Ordinary Task drafts and unreviewed Goal/Loop keep their
   existing delivery behavior. Reviewed remote or unsupported recipients fail
   closed; they do not enter `sendTurn`, fleet routing, or slash adaptation.

2. **RI-2 — Binding.** At `voice.begin`, before the first asynchronous wait, the
   host snapshots the explicit local agent, engine session, engine, process PID,
   canonical process start marker, executable identity string, and terminal
   placement/generation. Transcription, review edits and queued Send retain that
   binding and the selected intent. A later focus change does not select another
   recipient. Known binding changes reject the instruction. The pin begins when
   the host receives the recording, not when a device first opens its mode sheet.

3. **RI-3 — Availability.** A supported existing Goal/Loop engine and an exact
   process probe are required. Old or missing process markers, unknown process
   probes and terminal backends without reviewed submission are unavailable.
   The engine support sets are the existing CLI sets: Goal for Claude/Codex;
   Loop for Claude. These sets are not per-version command negotiation.

4. **RI-4 — Serialization.** Reviewed sends share the daemon's actual writer
   barrier and the ordinary idle-turn control reservation. They do not acquire
   the question-answer exception, interrupt a turn, steer it, or use the legacy
   Enter retry mechanism. A local queue holds at most eight requests and 24 KiB
   per agent, expires queued work after five seconds, and bounds writer/idle
   acquisition to five seconds. It is an input queue, not a work schedule.

5. **RI-5 — Composer protection.** Before buffer loading and again before paste,
   the host reads the pinned runtime's visible ANSI screen and applies the
   existing conservative `teamWriteHold` inspection. A human draft, question,
   dialog, busy or unrecognized screen refuses input without clearing it.
   Process and registry identity are rechecked after that asynchronous capture.
   Observed turn-open state is rechecked before paste and Enter; after Enter,
   only identity is required because a newly open turn may be this submission.

6. **RI-6 — Terminal boundary.** The exact command is prefixed once and sent to
   the captured locator with one bracketed paste and at most one Enter. Strict
   buffer load, paste and Enter calls have bounded subprocess timeouts. There
   is no fallback locator, slash downgrade, automatic Enter retry or replay.
   Shared prompt-origin bookkeeping records the exact text without a new tab
   origin; it is rolled back only for a definite refusal before input.

7. **RI-7 — Receipts.** The internal receipt is `submitted`, `rejected` before
   input, or `uncertain` once paste may have happened. A successful terminal
   write followed by a known identity change is uncertain. `submitted` means
   the terminal write and its immediate guards succeeded; it does not establish
   engine acceptance, Goal completion, Loop creation, cadence or schedule state.
   Existing `VoiceDraft` caching preserves one receipt for repeated Send. Failed
   and uncertain drafts stay locked, retaining their words until discarded.
   The existing wire uses `sent` or a locked error draft; no new receipt enum
   crosses the cable.

8. **RI-8 — Disconnect.** Clearing a draft cancels its prepared operation.
   Queued work cannot start after cancellation; an operation that may already
   have written remains ambiguous and is not replayed. An old asynchronous
   receipt cannot be written onto a new cable connection. The host can retain
   the words as a bounded, read-only archive under [draftRecovery.md](draftRecovery.md);
   reading that copy never restores Send authority. Device recovery requires
   its original validated draft/device/host identity. A definite busy/refused draft currently requires
   closing and recording again rather than an automatic resubmission.

9. **RI-9 — Limits.** Tmux exposes pane-addressed writes, not an atomic
   process-bound compare-and-write primitive. Human/raw terminal input, a
   process exec or replacement, and UI state can change between the last
   observation and tmux's write. PID/start-marker/executable-string evidence
   also does not prove every same-process internal state change. These checks
   prevent known changes and preserve uncertainty; they do not claim atomic
   external process binding. Older hosts do not advertise this stronger
   behavior, and this phase does not add firmware capability negotiation.

`reviewedInput.spec.ts` beside this document exercises CableSession,
DaemonCableHost, the real reviewed controller and the existing writer/control
composition. `../lib/reviewedInput.spec.ts` covers queue, identity and guard
races; `../lib/tmuxReviewed.spec.ts` covers timeout and ambiguous write receipts.
The opt-in `RUN_REVIEWED_INPUT_TMUX=1` test in
`../lib/reviewedInput.real.spec.ts` compiles an echo-only process on a private
tmux socket, exercises actual process probes and input writes, and checks the
captured bytes. It proves terminal delivery, not vendor command acceptance.
