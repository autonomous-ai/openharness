# Task Contract Implementation Plan

> Implement task by task, test first, following the project's Engineer workflow (project instructions, Engineer).

**Goal:** A task an agent opens (the PM included) says its goal, how to tell it is done (at least one check), its priority and who asked. Without them the server refuses with `TASK_CONTRACT_MISSING`, naming the missing fields and an example. People keep today's defaults.

**Architecture:** One new pure module `backend/src/superTabs/taskContract.ts` (the fields, the message, the example). `conversation.create` in `commands.ts` calls it for an agent author after the requester is resolved, before the group number is taken. Nothing else changes for people, steps (`reviewOf`/`step`) and private chats (`audience`).

**Tech Stack:** Backend TypeScript (zod commands, Vitest).

**Spec:** Swarm task #3389 brief (Dee's Swarm redesign, 2026-11-05): code over prompts; refuse only at named guards, each refusal naming the next step; #2414's removed refusals stay removed.

## Global Constraints

- The code is new: `TASK_CONTRACT_MISSING` (status 400). No code from `removedRefusals.test.ts` returns.
- Only agent authors are checked. A person's create is unchanged (priority defaults to P2 with the existing warning).
- A step (`reviewOf` or `step`) and a private chat (`audience`) are no task of their own and are not checked.
- A field a Buddy's proposal supplies counts as given: its brief (goal), its priority, its person (requester).
- The warning `REQUESTER_UNKNOWN` can no longer happen for an agent, so it goes with its dead branch.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in.

## Design

- growth: N/A because it stores nothing.
- concurrency: N/A because it runs inside the existing per-Swarm command transaction before anything is written.
- read cost: N/A because it reads only the command and the requester already resolved.
- scale: N/A because it is a constant-time check per create.
- compatibility: old clients and CLIs that send a create without the fields now get a 400 naming them with an example; every field already exists on the command. People's clients are unaffected.
- migration + rollback: no migration; rolling back removes the refusal.
- audience: the server enforces it, by actor kind.
- identity: N/A because it uses the command's actor, never the machine owner's login.
- failure: the refusal names every missing field at once and the next step.
- platforms: backend only.

## Review Focus

- Every way an agent can open a task still works when it gives all four (task form or brief form, requesterId, a proposal, a request message).
- A step, a private chat and a person's create are never refused.

## Task 1: the check

**Files:** Create `backend/src/superTabs/taskContract.ts`, `backend/src/superTabs/taskContract.test.ts`; modify `backend/src/superTabs/commands.ts`.

**Interfaces:** `missingContract(given: { goal: boolean; checks: number; priority: boolean; requester: boolean }): ContractField[]`; `contractRefusal(missing): string`.

- [ ] Write the failing tests: an agent's create missing each field (alone and together) is refused naming them; a person's with defaults opens; steps, private chats, proposals and request messages are not refused.
- [ ] Watch them fail.
- [ ] Add the module and call it in `conversation.create`.
- [ ] Update the tests of the replaced `REQUESTER_UNKNOWN` warning; run the tests of what changed, then `npm test`.
