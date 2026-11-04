# A Buddy relays to its owner's own sessions on their Mac Implementation Plan

> **For agentic workers:** Written by the writing-plans skill as the project's instructions adapt it (Engineer role,
> revision 58). The Engineer implements it task by task, test first, in this session; the pull request's two security
> reviews are the independent reviews. No execution handoff.

**Goal:** On its owner's own Mac, while the owner allows `agents-tell-agents`, the owner's Buddy may pass words to the
owner's own local sessions with `harness tell NAME -- WORDS` (and `harness reply NAME -- WORDS` for one that is idle), and
is refused for another person's session, another machine's, a Swarm agent, one an agent started, and with the setting off.

**Architecture:** Three gates, each enough to refuse. (1) The Buddy's guard (lib/buddyGuard.ts, its PreToolUse hook) lets
`harness tell|reply NAME [--json] -- WORDS` run only while the Buddy holds its wide grant (the host proved, at the owner's
last message within the hour, that they wrote in their own Buddy chat signed in on this Mac: the same proof wide reads use),
with no `--machine`, and with no secret in the words. (2) The CLI (agentClient/commands.ts) hands a tell or reply for a
harness on this machine that the caller did not start to the machine, from the caller's pane; one for another machine stays
refused. (3) The machine (messages/service.ts) decides from its own registry: the pane's harness is a Buddy session
(`swarmSkill.role === 'buddy'`) with a live grant, on a machine that is not a Team account; the target is a live harness here,
not a terminal, not a Swarm session, not started by an agent, not a guest's (another person's), not the Buddy; the switch is
on. It queues the words under the pseudo-tab `relayed`, headed as from the owner's Buddy, and checks the same again at each
delivery look. A reply also needs the target idle. The Buddy gets no new read: no `ps`, `show` or `wait`.

**Tech Stack:** TypeScript (CLI), vitest, the guard's plain JavaScript (run as text by its spec).

**Spec:** the task's brief (#2626, thaibao56, 11-04); messages/tell.ts and messages/replyLocal.ts (the paths it extends);
docs/specs/2026-10-30-buddy-read-access.md (the wide grant it reuses as the owner's proof).

## Global Constraints

- Two independent security reviews by two different Reviewers: who counts as the owner, same Mac only, never another
  person's session, the setting off by default, no new read access.
- `agents-tell-agents` stays off by default; nothing here turns it on. Swarm code stays out of `cli/src/core`.
- CLI specs with a scratchpad TMPDIR; no test signs the Mac out of the real CLI.

## Review Focus

- The owner is the person whose Buddy it is, proven present on this Mac by the host's grant (this launch, the account signed
  in here, under an hour old). A grant that lapsed while words wait refuses them at the next look.
- A Swarm agent, or a harness an agent started, is never a target, even when it runs in the owner's account here.
- A guest's harness on a shared Mac is another person's: refused.
- `--machine` is refused by the guard and by the CLI; the machine accepts the Buddy path only from a pane here.
- A non-Buddy harness gains nothing: telling one it did not start is still refused, now by the machine; reply from an agent
  that is not a Buddy is still refused.

## Design

- **Growth.** Each relayed message is one message in the machine's Agent Messages store, kept and dropped as told ones are.
- **Concurrency.** None new: the mailbox's queue and the per-sender rate (30 in 10 minutes) apply.
- **Read cost.** One read of the Buddy's grant list, its folder's launch file and the account file per request and per
  delivery look; all small local files.
- **Scale.** Bounded by the tell limits (rate, queue, length).
- **Compatibility.** An older CLI in the Buddy's pane cannot reach it (its guard refuses `harness tell`); an older machine
  refuses as before (NOT_YOURS).
- **Migration + rollback.** None; rolling back refuses again, and queued `relayed` messages are refused at the next look.
- **Audience.** The machine enforces it, from its own registry; the CLI's and the guard's checks only refuse earlier.
- **Identity.** Never the machine owner's login used for someone else: the Buddy is the owner's own, on the owner's Mac.
- **Failure.** Each refusal names why (TELL_OFF, NOT_YOURS, OWNER_AWAY, NOT_IDLE, NOT_RUNNING) and what to do.
- **Platforms.** macOS and Linux, where wide grants exist; none on a Team account.

## File Structure

- Modify `cli/src/lib/buddyGuard.ts`: the guard's `harness tell|reply`; `buddyGrantLive` for the machine.
- Modify `cli/src/messages/tell.ts`: `RELAYED_TAB`, `buddyTellRefusal`, `relayedText`.
- Modify `cli/src/messages/service.ts`: the Buddy path in `tell`, the `relayed` delivery check and text.
- Modify `cli/src/agentClient/commands.ts`: `tell` and `reply` hand a local, not-started target to the machine.
- Modify `cli/src/lib/swarmSkills.ts`: one line in the Buddy skill.
- Tests: `cli/src/messages/service.spec.ts`, `cli/src/lib/buddyGuard.spec.ts`, `cli/src/agentClient/commands.spec.ts`.

### Task 1: The machine decides (service, tell.ts)

**Interfaces:** `buddyTellRefusal(check: { on: boolean; granted: boolean; target: RelayTarget | null; idle?: boolean }):
TellRefusal | null`; `RELAYED_TAB = 'relayed'`; `relayedText(message)`; service option `buddyGranted(session): boolean`
(default: Buddy role, not a Team account, `buddyGrantLive`).

- [ ] Failing tests in `service.spec.ts`: the owner's Buddy tells and replies to the owner's harness here, headed as its
  Buddy; refused for a guest's harness, a Swarm agent, an agent-started harness, the Buddy itself, with the setting off, with
  no live grant, over the relay; a reply to a working harness; a grant that lapses refuses the queued words; a non-Buddy
  harness is still NOT_YOURS. Commit; then implement; run the file.

### Task 2: The guard lets the command through (buddyGuard)

- [ ] Failing tests in `buddyGuard.spec.ts`: with a live grant `harness tell NAME -- 'words'` and `harness reply` are
  allowed; refused without a grant, with `--machine`, with another option, with a secret in the words, and in narrow mode.
  Commit; implement; run the file.

### Task 3: The CLI hands it over (commands, skill)

- [ ] Failing tests in `commands.spec.ts`: `tell` of a local harness the caller did not start, and `reply` from a pane,
  reach the machine from the pane; `--machine` for one not started stays NOT_YOURS. Commit; implement; one skill line.
