# A verdict carries over git's own main merge (task #3553)

> Requested by Dee through Harness. Built test first: each test commit comes before its code.

**Goal:** about 40 reviewer rounds on the night of 11-05 only confirmed that a pull request's new head was its reviewed head
plus a merge of main. When git made that merge by itself, the verdict carries to the new head. A merge with any
hand-resolved line, or any other commit, still needs a reviewer.

## Design

- **Where it is judged:** the PR watch (`superTabs/pullRequestEvents.ts`) asks, for a head that is new to a task, whether the
  head is git's own merge of another head and main (`reader.merge`). The answer is computed by the server from GitHub,
  never taken from the pull request.
- **What GitHub is asked** (`github/app.ts mainMergeSides`, read-only token): the pull request (it must still name the
  head; its base branch and base commit), the head's parents (`GET /git/commits`), whether the second parent is on the base
  branch (`GET /compare/{second}...{base commit}` is identical or ahead), and three comparisons of fixed commits. It
  compares against the commit, never the branch name, which a tag of the same name could shadow (security review,
  Important 1). Main's side runs from
  the first parent to the second. The pull request's side runs from the second to the first. The merge side runs from the
  first parent to the head. A side at GitHub's file cap (300) answers nothing.
- **The judge** (`superTabs/mergeCarry.ts cleanMainMergeOf`, pure): the head carries its first parent only when all of
  these hold:
  - It has exactly two parents, and the second is on the base branch.
  - Main changed something.
  - No path (a rename's old name included) was changed on both sides.
  - The merge changes exactly main's files, each with main's blob, status and old name, and no file is listed twice.

  Then every path of the head holds the reviewed blob or main's, which is git's own merge. A hand-resolved line or an extra
  change is another blob or another file.
- **Where it is kept:** `PullRequestHead.carries` (at most 20, newest first). A clean merge of the head the task recorded
  before, on the same base, carries that head and what it carried, so a chain of clean merges keeps the verdict.
  `verdictCounts` counts a verdict at a head that carries its own head, on the verdict's own base only, by the full commit
  id.

## What still needs a reviewer

- Any file both sides changed. Git would merge its lines, and the server can't reproduce that merge from GitHub's API
  without a checkout. This is the safe side: some clean merges still need a review.
- Any merge with a hand-resolved line, an added change, or a file left out; any non-merge commit; a merge from a commit
  not on the base branch; a merge whose sides GitHub can't fully list.

## Residual, for the security review

GitHub's comparisons give each file's blob and status, but not its mode. A mode change alone (an executable bit) made in the
merge commit on a file main also changed, to the same content, would not be seen. A mode change on any other file adds a
file to the merge side and carries nothing.

## Cost

- Only for a head new to a task, once per pass: one more pull request read, one commit read, and for a two-parent head
  whose second parent is on the base, one branch compare and three file compares. All are read-only, through the token
  the patch read already takes.
- Nothing changes on a request path. `verdictCounts` adds an in-memory check of at most 20 ids.
