# Read-only reviewed-message recovery

This is a private host implementation of the existing `draft.command` and
`draft.state` messages. It adds no public field, message or capability. Device
bookmark persistence and rendering are separate firmware responsibilities.

1. **DR-1 — Authority ends at detach.** Disconnect, replacement opening, changed
   greeting identity or host identity cancels the active reviewed sender before
   any asynchronous wait. Ordinary live Task behavior is unchanged. Every
   detached Task, Goal, Loop or Carry draft is permanently read only, including
   a message known not to have entered the terminal. Recovery never routes,
   adapts a slash command, retries input or recreates a submission closure.

2. **DR-2 — Lifetime and bounds.** The fleet owns data archives above disposable
   cable sessions. USB disappearance and path replacement stop a session while
   preserving its archive. There is one latest archive per complete device MAC
   and local host id, at most four owners, 16,000 UTF-8 text bytes per owner
   (64,000 total), and 2,048 bytes of bounded metadata per owner. Oldest detach
   is evicted first. Reads never refresh order or the fixed 30-minute monotonic
   deadline. Access enforces expiry immediately; idle fleet/session ticks clear
   expired memory. Whole-fleet shutdown clears all archives; a daemon restart
   cannot recover them. A standalone session clears its own store on stop.

3. **DR-3 — Data only.** Retention copies exact reviewed words, original draft
   UUID, recipient id/name, intent, context/Carry id, cursor and revision. It
   stores no PCM, undo history, sender, cancellation closure, queue or promise.
   A pending operation may share only a tiny private outcome cell. Its late
   receipt cannot recreate an expired/discarded/evicted record or alter a new
   owner's active draft. A new recording is never blocked by an archive.

4. **DR-4 — Ownership.** Recovery requires the original unguessable draft UUID,
   a fresh greeting with the exact complete six-octet MAC, and the exact complete
   original `welcome.machine.id` (1–47 printable non-space ASCII bytes). Missing,
   malformed or oversized identity disables retention/recovery; no truncation,
   device model inference, USB-path ownership or current focus/tray fallback is
   used. MAC is a self-reported local cable identifier, not cryptographic device
   authentication. Before its first draft UUID arrives, a disconnected device
   has no discovery mechanism for the message.

5. **DR-5 — Existing commands.** Detach increments revision once. `state` accepts
   a stale revision hint and returns the current page. `move` requires the exact
   revision and delta -1 or +1, clamps its cursor and increments revision once,
   including at a boundary, as live review already does. A stale mutation
   returns the owned archive with an error and no second move. `discard` deletes
   it, including while an old receipt is pending. Send, undo and spoken edits
   are unavailable. Explicit live discard/creation abort are not detach and
   do not create an archive.

6. **DR-6 — Readable does not mean sendable.** Archived pages use existing
   fields: `active:true`, `locked:true`, `canSend:false`, `canUndo:false`, original
   `id`/`agentId`, and `text`/`position`/`total`. Each part is at most 480 UTF-8
   bytes; joining all parts preserves the exact stored text and whitespace.
   Known historical `sent:true` does not hide those pages. Missing, wrong-owner
   or expired ids return generic inactive state with no text and never expose
   a different live draft. Native recovery must maintain its own irreversible
   read-only latch, including against older hosts returning `canSend:true`.

7. **DR-7 — Delivery truth.** Strict Goal/Loop receipts remain privately distinct:
   rejected before input, submitted to the guarded terminal, or uncertain after
   possible input. Pending receipts remain uncertain. Legacy Task success only
   confirms its existing Harness handoff; it does not gain terminal proof.
   Existing short `error` text communicates that distinction on a successful
   read. Receipt settlement does not change words, cursor or revision. Neither
   historical `sent` nor recovery proves engine acceptance, Goal completion or
   a Loop schedule. There is no automatic replay, even for definite no-input.

8. **DR-8 — Async provenance.** Port-open tokens reject late data/close callbacks
   from abandoned readers. A bounded pre-open buffer preserves a legitimate
   first greeting. Link and hello-owner epochs guard voice transcription/edit
   replies and draft receipts after asynchronous waits. Replacing a port revokes
   authority before opening, even if the old close callback is delayed or the
   new opener fails. A late write failure closes its captured port only.

9. **DR-9 — Compatibility and limits.** An older device may ignore recovery and
   immediately record a fresh draft. A new device receiving inactive state from
   an older host retains whatever local copy it has; it must not infer delivery
   or rebind to a new draft. Current glyph/send gates are unchanged. Recovery
   concerns user words; a full Carry quotation or selected-text attachment is
   not exposed by the existing draft pages. Its original source preview remains
   a separate native snapshot. Host memory and device bookmarks are not a
   durable message history, and tmux's external input/process race remains as
   documented in [reviewedInput.md](reviewedInput.md).

`voiceDraftRecovery.spec.ts` covers byte bounds, lifetime, owner isolation,
outcome truth and non-resurrection. `cableSession.spec.ts` covers greetings,
async replies and port provenance. `cableFleet.spec.ts` exercises actual fleet
removal/re-enumeration/path replacement and can export real host frames to
`HARNESS_DRAFT_RECOVERY_FIXTURE` for the firmware cJSON/UI replay. The reviewed
production composition test also holds a replacement opener while releasing
the actual writer queue, proving cancellation before a new hello.
