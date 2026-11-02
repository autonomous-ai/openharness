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
  project's repository address. The owner of a link into the same repository is corrected, a link into another repository
  is not recorded, so a pull request is one entry. Without a GitHub repository nothing changes.
- `conversation.merged`: normalizes the link; refuses another repository (`PULL_REQUEST_REPOSITORY`, naming the project's).
- `cards.ts`: cards bind normalized links; `cleanPullRequestLinks` corrects a stored group (links and cards, merged
  time kept). `store.ts` runs it for every group on each command, so task #2002's record cleans itself on the next write.
  Nothing is deleted from messages.
- `ship.ts`, `commands.ts`: Shipped only when every linked PR has a recorded merge, once per group (`ledger.shipPostedAt`).
  Done with a PR open sets `ledger.shipWaiting`; the merge that completes the set posts the line. Work Done before this
  change has no `shipWaiting` and is never announced again.

## Desktop and phone

- Chips are one per owner/repo/number (case-insensitive). The label is `repo · PR #n`, `owner/repo · PR #n` when the PR is
  not in the project's repository (or, when it is unknown, when two owners share a repository name).

## Design

- growth: two ledger fields per group; the link lists only shrink.
- concurrency: inside the command's existing Swarm transaction.
- read cost: no new reads; cleaning touches only groups already loaded for the command.
- scale: N/A, constant work per group per command.
- compatibility: old clients still draw chips from the same fields; old rows keep their text.
- migration + rollback: self-healing on next write; rolling back leaves cleaned links in place, which older code accepts.
- audience: unchanged, the ship line stays in the project chat.
- identity: N/A.
- failure: a link in another repository through `conversation.merged` is refused with a clear message; links in text are not recorded.
- platforms: Desktop and phone.

## Tests

`ship.test.ts`, `pullRequestRepository.test.ts`, `buddyNews.test.ts` (backend); `super_tab_ship_test.dart` (Desktop);
`swarm_ship_row_test.dart` (phone).
