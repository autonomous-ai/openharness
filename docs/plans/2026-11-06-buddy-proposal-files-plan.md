# A Buddy can send a proposal with attached files — Plan

**Goal:** A Buddy's `propose ... --attach FILE` uploads the file and the proposal arrives with it.

**Architecture:** `proposalFiles` (cli/src/superTabs/command.ts) read chats, agents and projects from the `status` action. For a Buddy that action answers `{ lastChangedAt, summary }` and no `state` (service.ts), so the chat, its project session and the project were never found and the errors named the wrong cause. A small Buddy-only service action, `proposalContext`, answers exactly what the upload decides on: the chat it goes from (kind, project), the Buddy's own project session, and each project's chat id.

**Tech Stack:** TypeScript, vitest (cli/src/superTabs).

**Spec:** task #3872.

## Global Constraints
- Proposals without files unchanged. Files go only to the target project. No secret in errors or logs: the context holds ids and kinds only.

## Review Focus
- The context holds no brief, no machine, no folder; only a Buddy may ask.

## Task 1: the context action and its use (service.ts, command.ts; tests service.spec.ts, command.spec.ts)
- [ ] Failing tests: a Buddy gets the chat, session and projects from `proposalContext` and nothing else; another agent is refused; both proposal-file tests use the real Buddy status shape (a summary with no state) and still upload.
- [ ] Implement.
