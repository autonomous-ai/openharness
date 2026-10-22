# Five-part Swarm tasks implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Track the steps below.

**Goal:** Every delegated task states its goal, changes, constraints, owned code and observable acceptance checks.

**Architecture:** Add an optional structured task to conversations and keep the existing brief as a rendered compatibility view. Validate complete tasks in the agent CLI command path, retry an explicit old-backend schema refusal once with the rendered brief, and display the structured fields in assignment deliveries and Desktop work details.

**Tech stack:** TypeScript, Zod, Vitest, Dart/Flutter. No new dependencies.

**Spec:** Workgroup assignment in the shared Swarm, Five-part task template (on Ken's machine), 2026-10-22. Its requirements are captured below.

## Global constraints

- Keep old CLI requests with a brief accepted by the backend. Desktop group creation continues using a free-text brief.
- New CLI requests require all four task fields and at least one nonempty acceptance check. New CLI against an older backend retries once only after an invalid-command refusal.
- Task goal, changes and constraints are trimmed nonempty strings, each limited to 8,000 characters. Owns has 1–40 trimmed nonempty paths/areas of at most 4,096 characters each. Rendered tasks also fit the existing brief limits: 8,000 characters for conversation.create, 32,000 for work.define. This keeps old-backend fallback valid without truncation.
- Only touch task-related cases/schema in backend commands, the conversation models, CLI task command validation/help and assignment text, Desktop details and the template sentence in the launch prompt. Coordinate shared files with the other workgroup.
- Tests use isolated data and never the live daemon, port 18473, real tmux, ~/.harness, ~/.claude or ~/.codex. CLI runs on Node 24.
- Start from current origin/main, rebase before delivery, push the branch and open a draft PR. Do not mark ready, merge or release.

## Review focus

- A legacy work.define replacing a structured task must clear the prior task, so details do not show stale instructions.
- A structured task takes precedence over a supplied brief on write; worker delivery reuses the stored rendered brief.
- Compatibility retry must preserve the operation ID and all non-task fields. Permission, transport and unrelated validation failures never retry; an operation conflict may check its exact legacy receipt once after an upgrade.
- Whitespace-only fields and empty check descriptions must be rejected with useful errors.
- Long real group/tab IDs must keep the launch prompt below 2,000 UTF-16 units.

## Phase 1: Backend contract and delivery

Files: `backend/src/superTabs/model.ts`, `commands.ts`, `commands.test.ts`.

Interface: `Conversation.task?: { goal: string; changes: string; constraints: string; owns: string[] }`. The conversation.create and work.define schemas accept task and optional brief; applying a task renders `Goal`, `Changes`, `Constraints`, `Owns`. Assignment messages add the existing acceptance checks as the fifth section.

- [x] Add failing tests for task-only create/define, trimmed storage and rendered brief, validation bounds, legacy requests, stale-task removal and structured worker delivery.
- [x] Run the affected tests and observe the missing behavior.
- [x] Implement schema, storage and rendering; reuse the rendered brief for assignment text while preserving legacy delivery.
- [x] Run backend unit tests and typecheck.

## Phase 2: CLI task enforcement and compatibility

Files: `cli/src/superTabs/service.ts`, `service.spec.ts`, `host.ts`, `host.spec.ts`; a focused task helper and its tests if needed.

Interface: the agent command path requires complete task fields and nonempty checks on conversation.create/work.define. It always sends a rendered brief with the task. On explicit invalid-command/schema rejection from an older backend, retry exactly once without task, with the same operation ID and rendered brief. If a later backend upgrade returns an operation conflict after a lost legacy acknowledgement, check the exact legacy-form receipt once; genuine content changes remain conflicts. Other commands retain their behavior. HELP demonstrates the whole template; the delivery header names its five parts.

- [x] Add failing service tests covering both commands, each missing field/check, rendered briefs, successful new backend, old backend rejection, a failed retry and unrelated errors.
- [x] Run the affected tests and observe failures.
- [x] Implement validation, rendering, bounded retry and HELP/header copy.
- [x] Run affected CLI tests, the 100% super-tabs coverage gate and typecheck on Node 24.

## Phase 3: Desktop structured work details

Files: `desktop/lib/super_tabs/model.dart`, `work_details.dart`, `launch_prompt.dart`, affected `desktop/test/super_tab_*_test.dart`.

Interface: parse optional task into a typed immutable object. Show Goal, Changes, Constraints and Owns sections when task exists, otherwise show the existing brief; label acceptance checks as the fifth section. The launch template sentence lists all five parts.

- [x] Add failing model/widget tests for structured details, legacy fallback and bounded launch copy.
- [x] Run the affected tests and observe failures.
- [x] Implement parsing and sections using existing typography and message rendering.
- [x] Run Flutter analyze and affected widget/unit tests.

## Phase 4: Validation and draft delivery

- [x] Run backend `npx tsc --noEmit`, `npx vitest run src/superTabs`, `npm run test:super-tabs`.
- [x] Run CLI `npm run typecheck`, affected unit tests and `npm run test:super-tabs` (100% gate). Assess the isolated end-to-end workflow coverage and full component checks required by the validation guide.
- [x] Run Desktop `flutter analyze` and affected tests; assess full component tests for the shared protocol change.
- [ ] Review the final diff independently, resolve material findings, fetch/rebase current main, and reuse only checks whose inputs remain unchanged.
- [ ] Commit and push the isolated branch, open a draft PR with exact check results and limitations, and report its revision/link to the workgroup. Record implementation, validation and waiting separately; merging/publication are outside scope.
