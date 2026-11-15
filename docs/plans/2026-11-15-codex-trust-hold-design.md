# A failed native read no longer holds an agent for good

## The problem

A Codex agent started in a folder Codex does not trust stops at "Trust this folder?". `harness wait` must then say it
needs the person (exit 3). On CI it sometimes waited the full 2 minutes instead (`e2e/agentClient.e2e.ts`, "an agent is
told, not left waiting, when Claude Code or Codex would ask the person to trust its folder"; runs 43670913136 shard 5
and 43503224991). Real users hit the same thing: the fake engine starts its native child the way the npm `@openai/codex`
wrapper does.

What happens, read in the code on `85d8e618`:

1. The discovery pass binds the new agent (`bindObservedAgent`, `cli/src/core/agents/bind.ts`). It has no conversation
   yet, so it runs the repair (`findLiveSession`), which inspects the process tree. The wrapper is still starting its
   native child, so the inspection fails: "a native child changed during inspection"
   (`cli/src/lib/processEvidence.ts:131`).
2. `read()` turns that failure into an identity hold on the agent (`bind.ts:311-328`). Nothing releases it. The only
   release paths are `revalidateBinding` (agents with a conversation and a transcript, `bind.ts:293`), a later
   `registry.register`, and the OpenClaw and Hermes holds' own code. An agent at the trust question has no
   conversation and binds none until the person answers, so the hold stays.
3. While the hold stands, close inspection answers `unknown` without reading the screen (`cli/src/core/agents/close.ts:49-50`,
   `ready`). `harness wait` reads its state from that inspection (`agentClient/commands.ts` `inspect`), so it never
   sees the trust dialog (`team_waiting_user` → `needs_input`) and waits until its timeout.

The later passes, every 5 s, read the process tree again, and those reads complete: they find no conversation, as is
right before the person answers. The hold is wrong from the second pass on.

The same cause reaches more than Codex: any agent whose native read failed once while it had no conversation (any
engine's repair or resume lookup), and an OpenClaw agent whose pane capture failed once (its own code says that hold
"is that reason's to clear", and nothing does).

## The fix

A discovery pass that read the agent's native evidence completely releases the hold an earlier pass's failed read set.

- `createBinding` remembers, per agent, the hold a failed `read()` in `bindObservedAgent` set, as the row stored it:
  its reason and the row's `evidenceRevision` right after the hold was set (`setIdentityHold` raises the revision on
  every change). That pair is the hold's token: any later change to the row's evidence (another reason, a release, a
  register, a release and a hold set again) raises the revision, and the token no longer matches. A call that leaves
  the row as it was (the same reason set again) changes nothing, so it changes no token either.
- The map stays small and never keeps an agent that is gone: each time an entry is written, the entries whose agent
  the registry no longer has, or whose row no longer carries that token, are dropped first; at 256 entries it is
  cleared, as `openclawFolderReads` is. An entry also goes when its hold is released and when the agent's row no
  longer carries its token at the end of a pass.
- Each pass notes whether it ran a native read through `read()` and whether any failed. A pass that ran at least one
  and saw none fail, for an agent whose row still carries the recorded token, clears the hold, announces the agent and
  logs `[discovery] <agent> binding released · its native evidence was read completely`.
- A released agent that already has a conversation (`sessionId`) has its stream attached (`attachSession`), as
  OpenClaw's own clear does (`bind.ts:380`): an agent bound while held never had its stream attached
  (`discovery.ts:245`), and released without it, its pane would work while the apps and devices showed nothing. An
  attach that fails is logged as there (`transcript attachment is unavailable`) and changes nothing else. An agent
  with no conversation has nothing to attach.
- Only that hold is released. A hold set for another reason stays exactly as today: a refused `register`
  (`commit`), a saved binding that could not be checked (`BINDING_RECOVERY_HOLD`, `revalidateBinding`), a registry load
  that could not read a home, the OpenClaw screen and store holds, the Hermes sandbox hold, and holds Hermes's own
  follower sets.
- A pass that reads nothing (the repair's slow rhythm after its eager attempts, an early return) releases nothing.
- A pass whose reads succeed and then binds a conversation is unchanged: the registry's own register already clears
  the hold.

Rule 6 of the core (evidence newer than the state it contradicts) holds: the release comes from a read that started
after the failed one, within the same `current()` check the pass already makes.

### Why this belongs in the core

The core's rules (`cli/AGENTS.md`, Protect the core; `cli/src/core/AGENTS.md`) allow it:

- Binding a running engine to its conversation is session work the core owns (`core/agents/`), for every engine and
  every session; no component asks for it. Rule 7 (the core grows nothing for a component) is not touched: no
  component, list or record is added for one, and nothing outside the core uses the release.
- It fixes a defect in code already in the core, in the file that owns it (`bind.ts`). No file is added to the core's
  process, so `architecture.coreFiles.txt` is unchanged; nothing is imported that the core does not load today.
- It meets nothing outside: the release is decided from the core's own native reads of this computer's processes, the
  same reads it makes now. No connection, command line or outside text is added (core rules 4 and 7 of
  `src/core/AGENTS.md`).
- The state it adds is in memory, bounded (256 entries), and dropped with the agent.

### What users see

- An agent at its folder-trust question (Codex, or Claude Code started by hand in an untrusted folder) shows as needing
  the person within one discovery pass (about 5 s) of the failed read, in `harness wait`, `harness ps`, the apps and
  the cleanup preview.
- An agent that briefly read as "binding held" while starting reads as starting again on the next pass.
- Nothing else changes: no agent closes, binds or resumes differently.

### Not done: reading the screen under a hold (candidate b)

Letting close inspection read the trust question while the identity is held is not needed and not wanted:

- The trust question comes before any conversation, so every agent at it is unbound, and with the fix its read hold
  clears within a pass.
- A hold means the daemon cannot tell which conversation the agent is in. Close inspection is also what a close and the
  cleanup decide on; answering from the screen under a hold widens what they act on. The one close that needs it
  (`now` at the startup question) already reads it (`atStartupQuestion`).

## Failure cases

- The read fails on every pass (a process that never settles): the hold stays, as today, and `hold()` logs
  `binding held · <reason>` on each failed read, as today (every 5 s for the repair's first 24 attempts, then once a
  minute). That line is not changed here.
- The read fails, then succeeds, then fails again: hold, release, hold, each a real change, each announced once. A
  process that does this keeps changing; no pass releases on a read that failed.
- The agent changes (a stop, a restart, a new process, deleted) during the pass: `current()` is false and nothing is
  released, as with every write in the pass.
- The daemon restarts: holds are not saved (`registry.ts` strips `identityHold`), and neither is the map.

## Cost

One map lookup and at most one registry write per agent per discovery pass, only when a hold was recorded, and one
stream attach per release of an agent with a conversation (not awaited by the pass). No new read, timer or process. The map holds at most 256 entries.

## Tests

- `cli/src/core/agents/bind.spec.ts` (red first):
  - an unbound agent whose repair read fails is held; on the next pass the read completes and finds nothing: the hold
    is released and the agent announced once;
  - the same for a resume lookup that fails then completes and finds no transcript;
  - an OpenClaw agent whose pane capture fails, then succeeds: released;
  - a released agent with a conversation has its stream attached once; one with none attaches nothing; an attach that
    rejects is logged and the release stands;
  - a hold from a refused register, the Hermes sandbox hold, or any hold the binding did not set: kept after a
    complete pass;
  - a pass that ran no read (repair throttled): nothing released;
  - a pass with one read that succeeds and one that fails: the hold stays;
  - a hold changed after the recorded one, to another reason or released and set again with the same reason text by
    another path (its revision moved): kept;
  - an agent forgotten while held: its entry is dropped on the next write, and the map never holds more than 256;
  - the agent changing during the pass: nothing released.
- `npm run test:core` keeps `bind.ts` at 100%.
- End to end: the existing `agentClient.e2e.ts` test is the check. It no longer depends on how the race falls: whether
  the first inspection fails or not, the agent reads as needing the person within a pass. Forcing the failure every
  time would need a test fault inside the core's native read, which is core growth for a test; the unit tests cover
  the failing case deterministically instead.

## Platforms

Core logic only, the same on macOS, Linux and Windows: it has no platform branch and reads only the lookups injected
into the binding. Tested on macOS locally (unit tests, `npm run test:core`, the end-to-end test) and on Linux in PR CI
and the `cli-e2e.yml` run. No Windows job runs `bind.spec.ts`, and none is added for this change.
