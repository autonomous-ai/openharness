# Harness Commit Identity Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** Harness's commits and squash merges read `Harness by Autonomous <noreply@autonomous.ai>`, and Team-written branches stay recognised.

**Architecture:** `commitIdentity` becomes a constant. `readPushOrigin` already rests on GitHub's activity log, whose actor a pusher can't write, so that remains the signal; the app's login, which it asks the log for, moves off the commit email onto the app's slug. The merge helper composes the squash message itself, so the old bot address is rewritten and each co-author appears once.

**Tech Stack:** TypeScript, Vitest, Python `unittest`.

**Spec:** Task #2136 (Dee). Commit autonomous-ai/spaceship f80a4ba2c lists `Co-authored-by: harness-for-autonomous[bot] <...@users.noreply.github.com>`.

## Global Constraints

- Name: `Harness by Autonomous`. Email: `noreply@autonomous.ai`. Line: `Co-authored-by: Harness by Autonomous <noreply@autonomous.ai>`.
- The PR body starts with: `Requested by dee@autonomous.ai through Harness.`
- Two security reviews (Reed, Cleo). Full Super Tab integration suite before Ready.
- A commit's author or email can only add a Team-written mark, and never clears one.
- The merge helper runs from a checkout of main.

## Review Focus

1. A Team agent's commit has the new email and no linked GitHub author, pushed with the app's token: it reads `team` from the log's actor.
2. A branch's author writes a person's name and email on a commit pushed with the app's token: still `team`.
3. The app's login no longer comes from the email: losing that would turn every read `unknown` and refuse every main-account agent.
4. The CLI rejects a commit identity it doesn't know, so a released CLI drops the new one and commits as `harnessteam@<host>.local`. That address still marks a branch, but it means the CLI goes out first.
5. A squash message that can't be composed never blocks a merge: it falls back to GitHub's own message.

## Design

- **Growth:** N/A because this stores nothing new.
- **Concurrency:** N/A because the identity is a constant and the message is composed once, before the merge request.
- **Read cost:** fewer: no `/users` call for the identity. The helper reads the pull request's commits once per merge.
- **Scale:** N/A because a pull request has at most 250 commits to read, and past that the helper uses GitHub's message.
- **Compatibility:** a new CLI accepts both identities. A released CLI rejects the new one and falls back to the machine's own address until it updates, so release the CLI before the backend.
- **Migration and rollback:** none. Commits already made keep their address, and the helper rewrites it in squash messages.
- **Audience:** N/A because no data is exposed.
- **Identity:** the mark comes from GitHub's record of the pusher, never a commit's author.
- **Failure:** a failed commit read in the helper logs and merges with GitHub's message.
- **Platforms:** N/A because nothing here depends on the platform.

---

### Task 1: The commit identity and the app's login

**Files:**
- Modify: `backend/src/github/app.ts`, `backend/src/github/attribution.ts`, `backend/src/github/pushOrigin.ts`, `cli/src/lib/swarmGitHub.ts`, `docs/swarm-github-app.md`
- Test: `backend/src/github/app.test.ts`, `backend/src/github/attribution.test.ts`, `backend/src/github/pushOrigin.test.ts`, `backend/integration/superTabGithub.test.ts`, `cli/src/lib/swarmGitHub.spec.ts`

**Interfaces:**
- Produces: `COMMIT_IDENTITY: CommitIdentity`, `HARNESS_CO_AUTHOR: string`, `GitHubApp.commitIdentity(): CommitIdentity`, `GitHubApp.botLogin(): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests:** the identity is the constant, with no GitHub call; `botLogin` comes from the slug, or `/app` with none; `pushOrigin` asks for the bot by login with the new identity; `readPushOrigin` reads `team` for a bot's push of a commit with the new email and no linked author, and for a forged person's address on a bot's push, and for the new address on a person's push; a person's own commits still read `clean`; the trailers carry the line once; the CLI writes the new identity and still takes the old one.
- [ ] **Step 2: Run them:** `npm test -- src/github/` in `backend`, `npx vitest run --no-coverage src/lib/swarmGitHub.spec.ts` in `cli`. Expected: FAIL.
- [ ] **Step 3: Implement.** `TEAM_ADDRESS` also takes `noreply@autonomous.ai`, as an added mark only.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: The squash message

**Files:**
- Modify: `scripts/merge-validated-pr.py`
- Test: `scripts/tests/test_merge_validated_pr.py`

**Interfaces:**
- Produces: `squash_message(pr: dict, commits: list[dict]) -> tuple[str, str]` (title, message).

- [ ] **Step 1: Write the failing tests:** the old bot address, the new one and a trailer of either collapse to the new line once; another co-author keeps its line once, whatever its case; the pull request's author gets no line; another bot keeps its own; a merge sends the composed title and message; a failed commit read merges with GitHub's message.
- [ ] **Step 2: Run them:** `python3 -m unittest scripts/tests/test_merge_validated_pr.py`. Expected: FAIL.
- [ ] **Step 3: Implement** with the same `* ` list GitHub writes, and the message passed from a file under the output folder.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit, run the full Super Tab suite, open the pull request** and ask Reed and Cleo.
