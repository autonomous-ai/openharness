# Swarm immediate delivery implementation plan

**Goal:** Deliver Swarm chat input into Claude Code and Codex immediately during a running turn and remove the chat's Queued label.

**Architecture:** Identify Swarm deliveries by their existing `team:service:superTabs:` prefix. Reuse each engine's `typesWhileBusy` policy and submission reader. Keep Agent Messages on its current path. One pane writer and one pending delivery receipt remain serialized.

**Spec:** The Delivery builder workgroup brief: immediate typing for capable engines; preserve dialogs, questions, menus, human drafts, control locks and unavailable captures; confirm native queue acceptance without waiting for another turn; keep withheld notices and uncertain-delivery review.

**Constraints:** Node 24; no dependencies; CLI core and Super Tab coverage gates stay at 100%; tests use isolated homes, daemon ports and private tmux, never the running developer daemon. Own only session input, core input, kit screen holds, associated tests, and Desktop message presentation. Push a draft PR; do not mark ready, merge or release.

## Review focus

- Multiple Swarm messages during the same turn stay ordered and each gets its own receipt.
- A multiline draft with an empty first line stays untouched while busy.
- A dialog opening between paste and Enter still withholds Enter.
- Ambiguous terminal dispatch or unreadable submission evidence never becomes confirmed acceptance.
- Agent Messages and engines without busy typing retain their idle gate.

## Esc interruption evidence

An isolated real Claude Code 2.1.307 run used a disposable HOME/config, `--bare`, a fake API key,
a loopback streaming Anthropic fixture and private tmux. A follow-up submitted while the first
response streamed left the composer and entered the native queue. Esc interrupted that response
and automatically executed the exact queued follow-up; it did not restore an unsent draft. The
next conversation request included the interruption marker and follow-up, with an empty composer
while that response ran. This covers the tested version/configuration, not every future engine.

The fake Claude engine models this behavior. The Super Tab E2E asserts acknowledged busy input,
Esc, a new turn containing the exact queued Swarm message, no draft restoration and a retained
delivered receipt. Busy person-input checks observe acceptance only to drain waiting Swarm input;
overlays or unavailable readings leave the person receipt for its real turn event, and a persistent
draft cannot keep the observer polling indefinitely.

## Task 1: Immediate, safe native delivery

Files: `cli/src/lib/sessionInput.ts`, `cli/src/core/input.ts`, `cli/src/engines/kit/screen.ts`, their specs and `cli/e2e/superTabs.e2e.ts`.

- [x] Add failing tests for busy Claude/Codex delivery, ordered follow-ups, control locks, safe holds and native queue receipts; retain Agent Messages assertions.
- [x] Let only Swarm deliveries bypass turn-idle scheduling for engines declaring `typesWhileBusy`.
- [x] Reuse the kit's screen hold checks with an explicit busy allowance at both preflight and locked paste boundaries; still read every draft line.
- [x] Reuse the engine submission reader to settle an executed Swarm paste when its text leaves a visible composer. Never retry Enter for automatic traffic. Preserve uncertainty when evidence is missing.
- [x] Exercise the real isolated daemon with both fake engines busy; assert the prompt is submitted and acknowledged before the current turn ends. The fake already removes submitted text from its composer immediately and queues handling separately.

## Task 2: Chat presentation

Files: `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/model.dart`, `desktop/test/super_tab_delivery_test.dart`.

- [x] Add a failing widget test covering queued and claimed messages without the label, alongside uncertain-delivery review.
- [x] Remove the label and its unused model getter; preserve uncertain review controls.

## Task 3: Validate and deliver

- [ ] Run CLI typecheck, affected input/screen specs, `npm run test:core`, `npm run test:super-tabs`, isolated Super Tab/input-safety end to end, and the default CLI suite. Bound workers to machine capacity.
- [ ] Run `flutter analyze` and affected Desktop tests on macOS.
- [ ] Review the full diff independently, fetch main and integrate any relevant changes; reuse checks only for unchanged inputs.
- [ ] Commit and push the branch, open a draft PR with exact evidence, report its head and any unavailable checks to the workgroup.

## Timing and evidence

Implementation started 2026-10-22 after the lead's explicit go. Record implementation, validation and publication separately in the PR; no merge or release is authorized.

## Review and scope decisions

- Independent review found two important native-queue races: a late start for the preceding follow-up invalidated the next receipt, and a matching start left the next follow-up waiting for turn end. Both were reproduced RED then fixed GREEN, including FIFO order and wrapped native prompts.
- The lead approved one test-only addition in `cli/src/services/osDevice.spec.ts` for an existing unreadable boot-command-line coverage gap on main. `osDevice.ts` remains unchanged.
