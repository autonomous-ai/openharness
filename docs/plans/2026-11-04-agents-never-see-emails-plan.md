# Agents never see or type people's emails: implementation plan

> Way of working: the project's Engineer role (plan first, then each task test first, one review on the pull request).

**Goal:** No text the Swarm hands an agent names a person by their email, so no agent copies an email into a command
or a pull request body and a machine's privacy hook never stops its session. Agents tag people by username, display
name or id; an email still tags for older callers. (Task #2954, Ken.)

**Architecture:** The backend is where emails enter what agents read: a person's message author is stored as
`{ name: <email> }`, the requester line and a few refusals and notes interpolate `person.email`. The backend now hands
an agent reader each person author as `{ name: <username>, displayName: <shown name> }` (claims and message pages),
and writes names instead of emails into the agent-facing lines. Every CLI, old or new, already prefers `displayName`.
The CLI host additionally never prints a person author's `name` that holds an `@` (an older backend), and names people
by username where it read their email (Buddy chat line, check verdicts, note askers). `post --mention` resolves an id,
a username, a display name or (older callers) an email, and refuses a name two people answer to. Help and skill texts
say to tag by @username or id.

**Tech stack:** TypeScript; backend vitest units (`npm test`) and the Super Tab integration suite in PR CI; CLI vitest
specs.

**Spec:** the task's brief (#2954).

## Global constraints

- PR body first line: "Requested by Ken through Harness."
- Keep older CLIs working: email mentions still resolve; the wire shapes are only extended.
- Two people with the same display name resolve by username or id, with a clear refusal when ambiguous.
- Status keeps people's emails (the apps need them); prompts, help and examples never show one.
- Swarm code stays out of cli/src/core. Never run a test that signs the Mac out of the real CLI.
- People readers (Desktop, phone, web) keep reading person authors exactly as today: only agent readers change.

## Review focus

- A person reader's page and an agent reader's page of the same conversation: only the agent's person authors change.
- A Buddy's own-person check compares author id and membership generation, never the name: it still passes.
- A person who left the Swarm: their old messages still read with a name (their stored username is gone), never an email.
- `--mention` with a token that is one person's username and another's display name: the username wins (the server
  never lets these collide, so this only meets legacy data).
- Text `@tags` are unchanged: `@username` and `@email` (older agents) still tag; display names are not text tags,
  since the apps highlight tags by username (tagFixture.json).

## Design

- growth: N/A because nothing new is stored; names are worked out at read time from the people rows.
- concurrency: N/A because reads only.
- read cost: one username map per page or claim that has a person author (`swarmUsernames`, already computed on sends).
- scale: per read, linear in people and agents, as `swarmUsernames` already is on every message send.
- compatibility: the author keeps its fields; agent readers get a username in `name` and a new `displayName`, which every
  CLI already prefers. Older CLIs keep sending emails to `--mention`, which still resolve.
- migration + rollback: none; reverting the change restores today's reads.
- audience: the server decides by reader kind (agent vs person); people rows in status are unchanged.
- identity: N/A because no login is used.
- failure: an author whose person is gone reads as "a person" in `name`, never an email.
- platforms: backend; CLI on macOS and Linux.

## Task 1: the backend names people, not emails, to agents

**Files:**
- Modify: `backend/src/superTabs/personNames.ts` (new `authorForAgent`), `backend/src/superTabs/store.ts` (claim and
  page reads for agent readers), `backend/src/superTabs/projects.ts` (`requestedByLine`), `backend/src/superTabs/decisions.ts`,
  `backend/src/superTabs/commands.ts` (person.tell refusal, "Asked …", "Not asked …"), `backend/src/superTabs/digest.ts`.
- Test: `backend/src/superTabs/personNames.test.ts`, `projects.test.ts`, `commands.test.ts`, `digest.test.ts`,
  `backend/integration/superTabMessagePages.test.ts`.

**Interfaces:**
- Produces: `authorForAgent(state: SuperTabState, author: Author): Author` — a person author as
  `{ ...author, name: usernameOf(state, id) ?? 'a person', displayName: shownNameOf(state, id) ?? that name }`; an agent's unchanged.

- [ ] Failing tests: `requestedByLine` reads `Start each pull request body with: Requested by <written name> through Harness.`
  with no `@`; `authorForAgent` gives a username/display name and no email; the decision and tell refusals, the "Asked"
  line and the digest line name the username; an integration read of a person's message as an agent (claim and page)
  has no email anywhere in its JSON, while the same page read by a person keeps `name: <email>`.
- [ ] Implement; run those test files; commit.

## Task 2: the CLI names people, not emails, and tags by name

**Files:**
- Modify: `cli/src/superTabs/host.ts` (`shownName`), `deliveryContext.ts` (Buddy chat line), `agentContext.ts`
  (`checkerName`), `service.ts` (`mentionCommand`, `MENTION_HELP`, `withAskerNames`), `command.ts` (comment),
  `cli/src/lib/swarmTools.ts`, `cli/src/lib/swarmSkills.ts` (Lead and Buddy "tag them" lines).
- Test: `cli/src/superTabs/host.spec.ts`, `deliveryContext.spec.ts`, `service.spec.ts`, `cli/src/lib/swarmTools.spec.ts`.

- [ ] Failing tests: a delivery of a person's message whose author carries `displayName` names it, and one from an older
  backend (`name: sam@example.com`, no `displayName`) has no email anywhere in the delivered text; the Buddy chat line
  names the username; `--mention` by username (any case, with or without `@`) and by display name sends that person's
  id; two people with one display name are refused with `MENTION_AMBIGUOUS` naming their usernames; an email still
  resolves; help and skill texts carry no "email" for tagging.
- [ ] Implement; run those spec files; commit.
