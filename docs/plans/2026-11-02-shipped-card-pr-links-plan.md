# Shipped card: PR links of the project's repository, Shipped after the merge

Task #2081, for Diego. Task #2002's Shipped card showed four chips, two of them for #2527, one opening
`github.com/openharness/openharness/pull/2527` (the project is `autonomous-ai/openharness`), and said
Shipped while #2527 to #2529 were open.

## What people see

```
Before (task #2002, posted when the Builder set it Done, PRs open)
  🎉 Shipped: <title>      Requested by diego · Built by … · Reviewed by …
  [openharness · PR #2527] [openharness · PR #2527] [openharness · PR #2528] [openharness · PR #2529]

After
  Done, a PR still open   -> no Shipped line (the task's PR cards show them open)
  Done, all PRs merged    -> 🎉 Shipped: <title>   Requested by diego · Built by … · Reviewed by …
                             [openharness · PR #2527] [openharness · PR #2528] [openharness · PR #2529]
  a link outside the project's repository (rows already posted):
                             [other-org/openharness · PR #2527]
```

## Backend (`backend/src/superTabs`)

- `model.ts`: `githubRepository`, `projectPullRequestUrl`; `pullRequestLinks` and `appendPullRequestUrls` take the
  project's repository address. Only that repository's links count (its own spelling of owner and name); a link into any
  other repository, another owner's included, is not recorded. An owner is never guessed or corrected (Lead's ruling).
  Without a GitHub repository nothing changes.
- `conversation.merged`: refuses another repository (`PULL_REQUEST_REPOSITORY`, naming the project's); records the merge by
  link (`ledger.mergedUrls`), whether or not a card names the PR.
- `cards.ts`: cards bind only the project's links; `cleanPullRequestLinks` cleans a stored group (links, cards, merged and
  awaited lists). `store.ts` runs it for every group on each command, so task #2002 drops its bad entry on the next write
  and keeps the right link. Nothing is deleted from messages.
- `ship.ts`, `commands.ts`: Shipped when the work is Done and every PR it delivered has a recorded merge, once per group
  (`ledger.shipPostedAt`). The PRs a Done delivers are those its result names (else its checks' evidence) plus every recorded
  merge: a link only mentioned in the task never blocks. Done with one still open sets `ledger.shipWaiting` (the PRs awaited,
  possibly none); the merge that completes them posts the line and clears it. Groups opened before this (no
  `ledger.shipsAfterMerge`) keep the old guard, so work already announced is never announced again.

## Desktop and phone

- Chips are one per owner/repo/number (case-insensitive). The label is `repo · PR #n`, `owner/repo · PR #n` when the PR is
  not in the project's repository (or, when it is unknown, when two owners share a repository name).

## Design

- growth: four small ledger fields per group (merged links, awaited links, two marks); the link lists only shrink.
- concurrency: inside the command's existing Swarm transaction.
- read cost: no new reads; cleaning touches only groups already loaded for the command.
- scale: N/A, constant work per group per command.
- compatibility: old clients still draw chips from the same fields; old rows keep their text. A group from before this keeps the old announce-once guard.
- migration + rollback: self-healing on next write; rolling back leaves cleaned links in place, which older code accepts.
- audience: unchanged, the ship line stays in the project chat.
- identity: N/A.
- failure: a link in another repository (another owner's too) through `conversation.merged` is refused with a clear message; links in text are not recorded. A fork's PR of the same name is not guessed at.
- platforms: Desktop and phone.

## Tests

`ship.test.ts`, `pullRequestRepository.test.ts`, `buddyNews.test.ts` (backend); `super_tab_ship_test.dart` (Desktop);
`swarm_ship_row_test.dart` (phone).
