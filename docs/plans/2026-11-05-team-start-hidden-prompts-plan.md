# Team-account starts that wait on a hidden screen: plan

**Goal:** Team-written Codex starts in a Harness Team account start instead of timing out at 3 minutes, and any start
whose engine stops on a screen nobody sees fails at once with that screen's text (task #3009, requested by Dee).

**Architecture:** The cause (task #3009, production start records 2026-10-29..11-05 and two Team accounts' host logs):
a Team-written Codex start runs in an empty engine home of its own that trusts no project (audit H2), and codex-cli 0.165
stops there on "Trust this folder? 1. Trust and continue / 2. Quit". Nobody answers it, Codex never records a session, and
the backend fails the start at 3 minutes (10 of 10 such starts; 0 of 37 ordinary Codex starts on the same accounts). The
fix keeps the H2 guarantee and removes the wait:

1. The start writes its own engine home's `config.toml` with the start's checkout marked `trust_level = "untrusted"`.
   Codex then asks "Open restricted / Quit" instead: its first row keeps the branch's config, hooks and exec policies off,
   which is what the empty home is for. ("Trust and continue" would trust the branch: never sent.)
2. The host answers exactly that screen with Enter, only for a Team-written Codex start, and only while the visible screen
   is still the one it read (`inputIfScreen`).
3. Any other screen an engine stops on before it has a session (the readings' `WAITING` holds: trust, sign-in, update,
   model, question, menu, permission) fails the start at once with that screen's prompt text, instead of 3 minutes later.

**Tech Stack:** TypeScript (cli), vitest.

**Spec:** task #3009 brief; evidence in its conversation.

## Global Constraints

- Swarm code stays out of cli/src/core. Engine screen parsing stays in cli/src/engines/codex.
- Never trust a Team-written branch: nothing writes `trusted` for it, and no key but Enter on the exact restricted screen.
- A failure reason is read raw only by the start's maker, its coordinator and the machine's owner (backend
  startFailure.ts); members read "could not prepare or launch it". Links on a screen are cut to their origin.
- Never sign any account in or out; tests use fakes and temp folders.

## Review Focus

- Team isolation (audit H2): the untrusted entry must keep project config, hooks and exec policies off; Enter only on the
  exact "Open restricted" screen, never on "Trust and continue".
- A screen misread as a prompt must not fail a healthy start: only `WAITING` holds count, read on a launched start that has
  no session yet.
- The prompt text in a failure reason: bounded, links cut.

## Task 1: the engine home marks the checkout untrusted, and Codex's restricted screen reads as a trust prompt

**Files:** cli/src/superTabs/start.ts, cli/src/superTabs/start.spec.ts, cli/src/engines/codex/screen.ts,
cli/src/engines/codex/openRestricted.spec.ts, cli/src/superTabs/fixtures/screens/codex-*.txt

**Interfaces:** `openRestrictedKeys(capture: string): string[] | null` (engines/codex/screen.ts).

- [ ] Failing tests: a Team-written Codex start's engine home has `config.toml` naming its checkout `untrusted`;
      `openRestrictedKeys` answers only the exact 0.165 screen; the restricted screen reads as `trust` in the classifier.
- [ ] Code that passes them.

## Task 2: the host answers the restricted screen, and fails a start on any other hidden screen at once

**Files:** cli/src/superTabs/machines.ts, cli/src/superTabs/startScreen.ts, cli/src/superTabs/machines.spec.ts

**Interfaces:** `hiddenPromptReason(text: string): string` (startScreen.ts).

- [ ] Failing tests: a launched Team-written Codex start on the restricted screen gets Enter through `inputIfScreen`; one
      on "Trust and continue" (or a sign-in screen) is failed at once with that text and nothing is typed; a start with no
      prompt on screen is left waiting; an ordinary start on the restricted screen is failed, not answered.
- [ ] Code that passes them.
