# Redact every command's words (task #4340) Implementation Plan

> Written by the Engineer by the project's way of working: superpowers writing-plans, then each task test first
> (test-driven-development), one pull request.

**Goal:** A credential typed into any command's free text is removed before it is stored or copied, as it already is for
messages and tasks; a new command that adds free text fails a test until it is covered or exempted with a reason.

**Architecture:** `withoutCredentials` (commands.ts) already cleans every command at the one entry, `applyCommandOnce`,
before any handler reads it; copies (Buddy chats, notices, card rows) are made from that cleaned command. The gap is the
`WORDS` table, which lists only older commands. Add the missing paths; a test walks `commandSchema` and fails on any
string field that is neither in `WORDS` nor in its commented exemption list.

**Tech Stack:** TypeScript, zod 4 (schema walk through `_zod.def`), vitest.

**Spec:** Task #4340's brief, from Auditflow's delta review of #3310. Head start: Cleanup's 3b854228b and b1ae7dbd9 on
#3310, taken for their redaction half (pause reason, a person's card answer, the proposal commands in `WORDS`). Their
refusal of an agent's text in those commands needs #3310's `AGENT_TEXT` list, which main lacks, and stays on #3310.

## Verification (schema walk on main cbdcc6f06)

Missing from `WORDS`, each stored or copied as written:

| Command | Fields |
|---|---|
| `proposal.decide` | `reason` (also copied to the proposer's Buddy chat), the accepted task's words, `checks[].description` |
| `proposal.ask` | `question`, `defaultAnswer` |
| `proposal.answer` | `text` |
| `proposal.merge` | `reason` |
| `proposal.create` | `title`, `text`, `goal`, `why`, `doneWhen`, `evidence[]` |
| `buddy.propose` | `why`, `doneWhen`, `evidence[]` (the rest was listed) |
| `decision.ask` | `questions[].question`, `options[]`, `unblocks` |
| `decision.answer` | `note` |
| `work.status` | `ask.options[]`, `ask.unblocks` |
| `work.pause` | `reason` |
| `person.tell` | `text` |
| `agent.screenResult`, `agent.inputResult` | `error` |
| Names | `agent.new`, `buddy.create`, `member.name`, `member.username`, role names, `roleName`, lanes, `swarm.delete` name |
| Settings prose | `tab.routingPolicy` `policy.notes`, `rules.set` rule names and reasons, `conversation.create` `step`, `task.requires.access[]` |

Exempt, each with its reason in the test: terminal text (`agent.input`, screen results), a role's skill text, launch
settings (engine, model, effort, grid), folder paths, URLs and refs checked by shape, ids and times, an invite's email,
`machine.access` words (refused outright when they look like a secret), and fields the server writes itself (`stepUp.reason`, `sameEngine`).

## Global Constraints

- Never post or log a real secret: tests assemble fake token shapes at run time.
- Backend only. No data migration: stored rows stay as they are; new writes are clean.

## Design

N/A because nothing new is stored, synced or exposed: the same fields are stored, with credentials removed.

## Task 1: Proposal words are clean, in the card and the Buddy chat

**Files:** `backend/src/superTabs/commands.ts`, `proposalCards.test.ts`

- [ ] Test: a token in a proposal, a ruling's reason, a question, an answer and a merge reason is absent from the state
      and from every message, the proposer's Buddy chat included.
- [ ] Run it: fails. Add the proposal commands to `WORDS`. Passes.

## Task 2: Every other gap

**Files:** `backend/src/superTabs/commands.ts`, `commands.test.ts`

- [ ] Test: `withoutCredentials` cleans each listed field of `decision.ask`, `decision.answer`, `work.status`,
      `work.pause`, `person.tell` and the names and settings above.
- [ ] Run it: fails. Add them to `WORDS`. Passes.

## Task 3: The next command cannot slip

**Files:** `backend/src/superTabs/commands.ts` (export `WORDS`), `commands.test.ts`

- [ ] Test: walk `commandSchema`; every string field is in `WORDS` or a commented exemption; every `WORDS` path exists.
- [ ] Run it on main: fails, naming the gaps. After tasks 1–2: passes.
