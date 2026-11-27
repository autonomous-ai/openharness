# A held agent says why: named states for holds only the person can clear

Date: 2026-11-19. Branch: `fix/identity-hold-visible`. Size: full (core log line, frame, agentClient).

## Intent

An agent whose conversation identity is held because the native process helper is missing sits forever with no
visible state. Found on main by the agentclient-trust-macos session:

- On macOS every native process read goes through `nativeProcessControl` (`cli/src/lib/nativeProcessControl.ts`). A
  build without the helper (a dev build, or a broken bundle whose `__DARWIN_PROCESS_IMAGES__` is missing or
  unparsable) fails each read with `the native control helper is unavailable`.
- The hold that read sets is released only by a later pass whose native reads all completed (#4325), so it never
  clears until the daemon restarts.
- `bind.ts` logs `binding held · …` on every 5 s pass: 24 lines in 2 minutes, for a hold that never changed.
- `harness wait` and `harness show` read no `namedState`: they say "still working" until `--timeout`.
- Desktop and mobile show only `namedState`, and `NAMED_STATES` (`cli/src/lib/agentFrame.ts`) holds only the
  OpenClaw and other-engine states, so no screen shows this hold.

AGENTS rule 6: a failure has a name, a log line and a state someone can act on.

## Goals

1. A hold only the person can clear is a named state with a sentence that says what to do:
   - the build has no native helper;
   - the agent's program was replaced on disk while it ran (`REPLACED_PROGRAM`), which has the same cause: held until
     the agent restarts, shown nowhere.
2. `bind.ts` logs a hold once, when it is set or its reason changes, not on every pass.
3. `harness wait`, `show`, `watch` and `ps` read `namedState`. A state only the person can fix ends `wait` with exit
   3, as a question does. A state that recovers by itself does not end `wait`; the verbs print its sentence.
4. Desktop and mobile show the new states through what already shows `namedState`.

## Non-goals

- No change to when a hold is set or released, or to how identity is checked. A missing helper stays a hold.
- No new Dart code: Desktop's `PaneNote` and mobile's status line already show any `namedState`.
- No reinstall or restart button, no download link.
- The transient helper failures (preparing the helper timed out or could not write its file) keep their current
  reason and stay unnamed: they clear on a later pass.
- No change to the other-engine reader states' copy or behavior in the daemon.

## Anti-goals

- A named state for a hold that clears by itself (a person told to reinstall when nothing is wrong).
- `wait` ending with "needs the person" while the agent works and will finish on its own.
- Releasing a hold, or reading identity with weaker evidence, because the helper is missing.

## Constraints

- The core stays small (AGENTS "The daemon core"): its only change is the log line in `cli/src/core/agents/bind.ts`.
  The new states live beside `REPLACED_PROGRAM` in `cli/src/engines/kit/identityScan.ts` and in `agentFrame.ts`.
- Copy follows `docs/naming-system.md` and AGENTS: short, plain.
- A named state is the hold's own words: `namedState` is `identityHold` when that string is a named state, as today.
- Holds are in memory only: a reinstall restarts the daemon and clears them.
- Retries stay bounded as today: a pass every 5 s; with no helper in the build the read fails at once, with no spawn.

## Approaches

- **A (picked): the hold's reason is the person's sentence.** When the build carries no helper, `nativeProcessControl`
  throws an `IdentityReadUnavailable` whose message is the named-state sentence; the replaced-program hold does the
  same. Both sentences join `NAMED_STATES`. One string, set at the cause, shown everywhere.
- B: `agentFrame` maps the technical hold reason to a sentence (`namedState` ≠ `identityHold`). Two strings to keep in
  step, and the log keeps the technical one. Dropped.
- C: release the hold, or read identity from `ps`, when the helper is missing. Weakens identity authority. Dropped.

The orchestrator chose A.

## Design (decided)

### Copy and codes (approved by the orchestrator)

| Where | Exact text |
|---|---|
| Named state, no helper in the build | `This Harness install is incomplete. Reinstall Harness.` |
| Named state, program replaced | `This agent's program was updated while it ran. Restart the agent.` |
| `harness wait` line, held | `<name>: held · <sentence> Only the person can fix this.` |
| `harness wait` help, exit 3 | `3 one needs the person (a question, a permission, or a problem only they can fix)` |
| `harness wait` timeout line, recovering state | `<name>: timeout · <sentence> Wait again or read it: <show step>` in place of `still working; …` |

- `harness wait` exits 3 when one target settles held (same precedence as needs-input). JSON: `state: "held"`,
  `namedState: "<sentence>"`, `needsPerson: true`, `next: [{ tell: "tell the person: <sentence>" }]`.
- `harness show`: state `held`, a line `held: <sentence>`, next step "tell the person: <sentence>", exit 0. JSON as
  wait's. A recovering state: the state the screen gives, plus the line `<sentence>` and `namedState` in JSON.
- `harness watch`: a `held` event line (with the sentence) when a harness becomes held; exit codes unchanged.
- `harness ps`: state `held`.

(The approval message named the JSON field `held`; the spec uses `namedState`, the frame's own name, for both kinds,
so a program reads one field.)

### Which named states hold

- Held, ends `wait` with exit 3: the OpenClaw states (`OPENCLAW_STATES`), OpenClaw's local stop, the two new states.
- Recovering, does not end `wait`: the `OTHER_ENGINE_STATES` sentences (`cli/src/engines/otherEngines.ts`), and any
  sentence the client does not know (see call 3 below). `wait` keeps reading the screen.
- Held takes precedence over what the screen shows: a held agent may still draw a working screen, but Harness cannot
  follow its conversation.
- Only a harness on this machine or another machine's daemon; a cloud harness has no `namedState`.

### Daemon

- `cli/src/lib/nativeProcessImages.ts`: a way to tell "this build carries no usable helper" (no
  `__DARWIN_PROCESS_IMAGES__`, unparsable, or no `sha256`) apart from "the helper could not be prepared now".
- `cli/src/lib/nativeProcessControl.ts`: no helper in the build → throw the helper named state; a helper that could not
  be prepared or timed out → `the native control helper is unavailable`, as today.
- `cli/src/engines/kit/identityScan.ts`: the two sentences as constants (`IdentityReadUnavailable` takes a message);
  `REPLACED_PROGRAM` becomes the replaced-program sentence as the hold's message.
- `cli/src/lib/agentHandoff.ts`: `PROGRAM_REPLACED` keys on the new hold string.
- `cli/src/lib/agentFrame.ts`: `NAMED_STATES` includes the two sentences.
- `cli/src/core/agents/bind.ts`: `hold()` logs `[discovery] <id> binding held · <reason>` only when
  `registry.setIdentityHold` changed the row. The release line stays.

### Clients

- `cli/src/agentClient/model.ts`: `Frame.namedState`; `State` gains `held`; one function says whether a frame's named
  state is held, used by every verb.
- `cli/src/agentClient/commands.ts`: wait, show, watch and ps as above; `WAIT_USAGE` exit line.
- Desktop: `desktop/test/pane_named_state_test.dart` already shows any `namedState` in `PaneNote` and clears it, so no
  Dart change and no new Flutter test; the design doc and gallery do not change (no element changes). Mobile: the
  same through `phone_status.dart`.

### Measures

No new hot path. The log line is the signal; no new counter.

### Platforms

- macOS: the helper state (the helper is macOS only). Linux reads `/proc`; Windows does not reach this read.
- All platforms: the replaced-program state's new words, agentClient verbs.

## Verification (for the plan)

- Unit tests at each layer, red first: `nativeProcessControl` with no helper in the build; `agentFrame` named states;
  `bind.ts` logs once over repeated passes; agentClient wait/show/watch/ps with a held, a recovering and no named state.
- End to end on this Mac: a daemon built without the helper (the bundle without `__DARWIN_PROCESS_IMAGES__`, isolated
  state and backend), a Codex or Claude agent started in it: `namedState` is the helper sentence, the log shows
  `binding held` once, `harness wait` exits 3 with the held line, Desktop's pane shows the note (screenshot).
- `npm run test:core` receipt (100%) before the push.

## Calls made after the builder check (the child's, not the orchestrator's)

1. **Dev and test builds.** Only release builds carry the helper (`HARNESS_PROCESS_IMAGES_ARTIFACT`,
   `cli/build-bundle.mjs`); `npm run dev`, a local bundle and e2e `IsolatedDaemon` (tsx) carry none. They show the same
   sentence: such a build really lacks the helper, and its agents are already held forever on main today; the sentence
   only makes that visible. No dev-only copy, no change to how e2e daemons are built.
2. **Push delay.** A hold set while `wait` or `watch` already follows the agent is seen at the next look (at most the
   60 s `PUSHED_BACKSTOP_MS`): setting a hold is not one of the events `core/toolWatches.ts` pushes, and the core does
   not grow for this. A hold set before the wait starts is seen at the first look.
3. **Held is a list, not an exclusion.** The client treats as held only the sentences it knows to be held (the
   OpenClaw states, OpenClaw's local stop, the two new states); any other `namedState`, including one from a newer
   daemon on another machine, is printed but does not end `wait`. This keeps the anti-goal under version skew: an
   unknown state never makes `wait` say "needs the person".
4. **A broken bundled helper counts as missing.** Besides no `__DARWIN_PROCESS_IMAGES__`, unparsable JSON or no
   `sha256`, an artifact whose schema, size, base64 or checksum fails its checks is a build without a usable helper
   (permanent). Only preparing a valid artifact (writing or linking its file) or the time budget running out stays
   the transient `the native control helper is unavailable`.

## Left to the builder

- Whether `stateOf` returns `held` or each verb checks a separate helper, as long as one function decides.
- How the bundle check is exposed from `nativeProcessImages.ts`.
- Test fixtures and e2e harness details.
