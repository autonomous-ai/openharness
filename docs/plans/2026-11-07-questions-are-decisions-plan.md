# Every question for a person is a Decision; no agent relays news — plan

> Written by the task's Engineer by superpowers writing-plans, and implemented by the same Engineer task by task, test first.
> No Execution Handoff. Task #4623; builds on #4525 (PR #3548) and #4547 (branch task-4547-rest).

**Goal:** anh Dee (11-07 18:55): a person sees every question for them, from every project, in one place (Decisions), and no
agent relays news to its owner: with ten Members, all ten would relay it, or one would be a Buddy under another name.

**Architecture:** In `message.send` (commands.ts), an agent's post that tags a person and asks a question is refused with
QUESTION_FOR_PERSON, naming decision.ask; a reply inside a thread that person started stays a conversation. The Buddy news
deliveries (buddyNews.ts: project-chat rows that tag or answer the owner, the assigned and shipped lines) stop; the card
(#4547) and Decisions carry what they said. A person still asks any of their own agents for a second opinion, and the agent
reads the project as before.

**Tech Stack:** TypeScript backend and CLI skill text (vitest).

**Spec:** the brief of #4623.

## Global Constraints

- Server-enforced; one check in the one command that posts.
- Nothing that needs a person is lost: questions are Decisions; accepted, working and shipped are on the card.

## Review Focus

- Every path that asks a person ends in Decisions.
- Nothing a person needs depended on the news deliveries.

## Design

- growth: fewer rows and deliveries. concurrency: unchanged. read cost: none new. scale: fewer deliveries per post.
- compatibility: an older Lead skill's tagged question is refused with what to use; older Buddies simply hear no news.
- migration/rollback: none. audience: unchanged. identity: unchanged. failure: the refusal is named and says what to do.
- platforms: backend (Linux), CLI skill.

## Task 1: A tagged question is a Decision

**Files:** backend/src/superTabs/commands.ts, personQuestions.ts (new), personQuestions.test.ts

- [ ] Failing test: a Lead's project-chat post tagging a person with a question is refused and names decision.ask; a tag
  without a question passes; a reply in the person's own thread passes; a person's own post is never refused.
- [ ] Code.

## Task 2: No news to agents

**Files:** backend/src/superTabs/buddyNews.ts, commands.ts, releases.ts, store.ts, model.ts and tests

- [ ] Failing test: a tag, an answer to a proposal, a first assignment and a shipped release deliver nothing to the person's
  Buddy and write no "News for your owner" line.
- [ ] Code.

## Task 3: The skills

**Files:** cli/src/lib/swarmSkills.ts and spec

- [ ] Failing test: the Lead skill sends a person's question to decision.ask; the Buddy skill promises no news and still
  reads the project for a second opinion.
- [ ] Code.
