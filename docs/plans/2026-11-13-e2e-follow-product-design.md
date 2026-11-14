# Two end-to-end tests follow intended product changes

## Problem

The nightly `CLI end to end` workflow (`.github/workflows/cli-e2e.yml`) has failed on main since 2026-11-12 (run
43247147594; last green 42936847389 at 5cb00b72ff). Two of its failures are tests that still expect behavior the product
changed on purpose:

- **D.** `cli/e2e/swarmV4Journey.e2e.ts`, step "its person deletes a builder: the Swarm lets go of it, and its computer
  stops its session". It sends `agent.remove` and waits for Pip's session to stop. #4078 (merged 2026-11-11) made
  `agent.remove` keep the session: anh Dee, 2026-11-11, "removing an agent follows the rule for closing a pane; in a Swarm,
  closing a view never stops the work" (review finding PSW-B 5: removing a pane from Your Team killed the person's running
  Claude Code). The wait now times out.
- **E.** `cli/e2e/superTabChannel.e2e.ts:156`, "stores an agent's post in its channel once…". It posts
  `'Pip: ✅ shipped …'` as the agent Pip and expects the stored text to be exactly that. #4074 (merged 2026-11-11) makes the
  daemon drop an agent's own name (and a time) from the start of its post (`cli/src/superTabs/signature.ts`): anh Dee,
  2026-11-11, agents should talk like people on Slack, and the app already shows who wrote a post and when. The stored text
  is now `'✅ shipped …'`.

Both changes are intended (each PR cites anh Dee's decision and adds unit and integration tests for it); neither is a
regression. The tests are wrong, so the fix is in the tests.

## Approaches for D

- **Delete as Desktop does (picked):** stop the session through the daemon, then `agent.remove`. It is the flow a person
  runs today, so the step keeps testing what it was written for.
- **The Swarm's Stop (`agent.release` with `stop`, then `agent.remove`):** Desktop never sends it, and for a session a
  person shared (Pip) the host refuses it as not Swarm-started and posts a "Could not stop" line to the Lead mid-step.
- **Assert the session still runs after `agent.remove`:** "the host did not close it" has no positive signal to wait
  for; only a fixed sleep would make it pass or fail.

## Design

### D: delete a builder as the person's Desktop does

Desktop no longer relies on the Swarm to stop a removed agent (`desktop/lib/super_tabs/remove_agent.dart`): when Your Team
is the session's last place, it first stops the session through its computer's daemon (`agent_close`, mode `idle`, the
quiet close of a pane's last view), and only then sends `agent.remove`; the Swarm's removal stops nothing on the computer.

The step follows that flow, renamed "its person deletes a builder: its computer stops its session, then the Swarm lets go
of it":

1. Pip's session is active on computer A (as now).
2. Stop it as Desktop does: `A.client.request('agent_close', { agentId, sessionId, createdAt, mode: 'idle' })` with the
   session's identity from `agents_list`. Pip is idle (it answered and waits), so the close succeeds; the step expects
   `closed`.
3. Wait (bounded `until`, no sleep) for Pip's session to no longer be active on A.
4. Send `agent.remove` as the person: it succeeds, and Pip is no longer on the Swarm's roster (read by parts as Desktop
   reads it, `GET /api/super-tabs/:tabId/parts`, as `swarmAttachChat.e2e.ts` does), while the PM still is.
5. Faye, on the same computer, still runs (as now).

`agent.remove` keeping the session is #4078's own behavior, already covered at the layer where it lives (backend
`commands.test.ts` and `integration/superTabs.test.ts`: no `closingSessions` on a person's removal). Asserting it here
would need a wait for "the host did not close it", which has no positive signal to wait for without a fixed sleep.

### E: an agent's signed post arrives unsigned, its words whole

The post keeps its purpose (unicode, quotes, shell characters and newlines arrive as written) and now also checks #4074
end to end: `said` is the words without a signature; Pip posts `Pip: ${said}` and the stored text is `said`. The same
for the stdin post (`-`). The 32,000-character and over-length cases are unchanged.

## Out of scope

The other six causes of the nightly failure (other sessions own them). No product code changes.

## Verification

- E: `superTabChannel.e2e.ts` runs locally in seconds (fake backend): red at base (the failing assertion at line 159),
  green after.
- D: `swarmV4Journey.e2e.ts` needs the real-backend rig (`e2e/harness/realBackend.ts`); red at base is the nightly run
  43247147594's failure of that step. Green: run the spec locally if the rig runs on this Mac, and the `CLI end to end`
  workflow on the branch (workflow_dispatch), only on the orchestrator's go (shared runners).
