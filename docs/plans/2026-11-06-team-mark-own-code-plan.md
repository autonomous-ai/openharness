# A task's Team-written mark rests on its own code, not on links in its chat (task #3554)

> Implemented by its Engineer test first, by superpowers:test-driven-development, as the project's instructions say
> (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** A task is marked Team-written only when a Team agent's code is on its own branch: a Team builder, or GitHub's
record of a bot's push on the task's own pull requests. A link to another pull request posted in the task or in one of
its steps (a reviewer's verdict, log lines, a batch) no longer marks it. On 11-06 that blocked main-account agents from
#3462 and #3514, which they had built themselves (River's ruling in #3554).

**As built after the security reviews (SecAlder, SecLarch):** in a task itself, a post by a person, the project's PM or
the task's own assignee is a code source too: that is where a builder is told what to merge, and a squash or a rebase of a
Team pull request leaves only the builder's own commits on its branch, which GitHub's read cannot tell from its own. Another
agent's post (a Team reviewer's verdict, log lines), or any post in a step, the project chat or a private chat, never is.

**Architecture:** Today every message shown in a conversation adds the full pull request links in its text to that
conversation's `pullRequestUrls` (store.ts execute). The push read before an assignment, a start or a Ready
(store.ts `pushOriginFor`) asks GitHub about all of them, and for a step about the task's too. A step's Team answer marks
its task (teamWritten.ts `applyPushOrigin`). The fix gives each conversation a second list, `codePullRequestUrls`: the pull
requests named in its brief and title, its assignment's result, its checks' evidence and its merge record, never in posts.
The push read uses that list. For a step it reads the task's code and the step's own separately, and the step's own
answer marks only the step. `pullRequestUrls` stays as it is for cards, task lines and releases.

**Tech Stack:** TypeScript, vitest; the Super Tab store and command reducer; integration tests on a MongoDB memory replica set.

**Spec:** task #3554's brief and River's ruling of 11-06 in it (build as proposed; two security reviews; both check that a
main-account builder told to merge a Team pull request into its branch still ends up marked).

## Global Constraints

- An access rule: never weaker for an unknown. A task from before this change (no `codePullRequestUrls`) reads what it
  recorded before, `pullRequestUrls`, so nothing it was protected by is lost.
- A Team agent's push on the task's own pull request marks it, as now. GitHub's read is unchanged (github/pushOrigin.ts).
- Swarm code stays in backend/src/superTabs.

## Design

- growth: one list per conversation, of this project's pull request links; it is deleted with its conversation.
- concurrency: written inside the command's transaction, like `pullRequestUrls`.
- read cost: none added for a task; a step's Ready, assign or start asks GitHub twice (its task's code, then its own)
  where it asked once. Answers are kept per head (github/app.ts), so a repeat costs nothing.
- scale: at 10x the GitHub read budget warns first (app.ts pushOrigin cache); nothing here grows with posts.
- compatibility: an older server ignores the field and reads `pullRequestUrls` as before; a task from before reads what
  it recorded (above).
- migration + rollback: none. Rolling back reads `pullRequestUrls` again, the old behaviour.
- audience: the server alone writes and reads the field; no client sends it.
- identity: GitHub's record of who pushed; never a commit's author or a login.
- failure: an unreadable answer stays `unknown`, which refuses the main account, as now.
- platforms: server only.

## Review Focus

- No path where a Team agent's code lands on the task's own branch without the task being marked at the next read:
  a Team builder, a bot's push on the task's own pull request, and a main-account builder that merged a Team pull request
  into its branch (its own pull request then holds commits the bot pushed: pushOrigin.ts reads `team`).
- A step's own links mark the step, so a main-account agent is still refused on it.
- A task from before keeps its protection.

## Task 1: the push read covers a task's own code

**Files:** `backend/src/superTabs/model.ts`, `store.ts` (execute's link loop, `pushOriginFor`), `commands.ts` (creation,
`conversation.merged`), `teamWritten.ts` (`applyPushOrigin`); tests `backend/integration/superTabTeam.test.ts`,
`backend/src/superTabs/teamWritten.test.ts`, `backend/src/github/pushOrigin.test.ts`.

**Interfaces:** `Conversation.codePullRequestUrls?: string[]`; `codePullRequests(group, repositoryUrl)` (model.ts);
`applyPushOrigin(state, group, origin, pulls, taskRead?)` where `taskRead` is the task's own answer for a step.

- [ ] Failing tests: a link to a Team-pushed pull request posted in a task is not read, and the task's own is; a step's
  posted links mark the step, not its task; a bot's push on the task's own pull request still marks it; a task from before
  reads what it recorded; a main-account builder's pull request that took a Team pull request's commits reads `team`.
- [ ] Implement.
