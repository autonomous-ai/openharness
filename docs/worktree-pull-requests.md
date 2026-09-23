# Pull requests beside the branch

Wide terminal headers show a separate `PR #123 · Draft / Open / Merged / Closed` link next to
branch context. The branch keeps its existing colour. The PR badge and branch context hide together when hovering
reveals the pane controls; compact headers use `#123 · Draft` and reserve room for the badge before branch prose.
Only very small headers (under 360 logical pixels at normal text scale) omit it.
Clicking opens GitHub. Nothing merges a PR, changes a checkout, or deletes a worktree.

The CLI resolves the current branch and `origin` of the registered agent's working directory,
including linked worktrees. It uses the existing `gh` installation and GitHub sign-in on that
machine, via a bounded read-only subprocess (no interactive login). Both request and response are
encrypted when relayed to another machine. Device/admin operations are not exposed.

Only a validated PR result shows a badge. Loading, empty lookups and unavailable results stay hidden.
The API still distinguishes an unavailable lookup from a successful lookup with no PR.
The widget refreshes once a minute and discards replies from previous agent/branch identities.
CLI requests share a bounded 60-second cache. An open PR wins over an older closed/merged PR for
the same branch; otherwise the most recently updated matching PR is shown.

Initial scope: github.com repositories referenced by `origin`, matching both head branch and head
repository. Fork-to-upstream PRs and GitHub Enterprise are not resolved. Merge status says nothing
about uncommitted local changes or whether deleting the worktree is safe.
