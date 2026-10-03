# Session branches and pull requests

A session can use several branches and create several pull requests. The app
shows those branches and their PRs. Worktree directories are internal references
for locating code, not user-facing identities.

## Display and navigation

The focused bar shows the branch at the most recent confirmed Git work location,
plus its matching PR link when there is one. Other checked-out branches appear
as a compact count, for example `ship-hn +3`. This is recent work, not a claim
that an agent is executing there now. Hovering explains the observation time.
Without a unique recent location, one checked-out branch appears by name and
multiple branches appear as `2 branches` (or the corresponding count). Historical
branches do not increase this count. A dependent viewer uses its owner's context.

Click the branch, or use **Branches and pull requests** in the desktop command
picker. The dialog has two tabs: **Pull requests** and **Branches**. Its heading
is the session name, with the shared repository below it.

**Pull requests** is the default. Each PR appears once, with its title and state
on the first line, then its number, head/base branches and GitHub date. Open and
draft PRs come first, followed by unresolved records and merged/closed PRs.
Within each group, GitHub dates determine the order: update time for open PRs,
merge time for merged PRs, and close time for closed PRs. Missing dates are not
invented from refresh times; older records retain their observation order.
All saved PRs remain available in the scrolling list, including completed PRs.
There is no completed-history toggle and no branch grouping in this view.

**Branches** lists the session's associated branches separately, with checked-out
branches first and labeled **Checked out**. Matching repository and branch names
are one visible branch even when several local copies exist; different repositories
remain distinct. Temporary folders are never displayed.

The tabs support Left/Right navigation and retain their scroll positions.
Hover and accessibility inspection expose full titles and the actual GitHub check
time. Short lists fit their content; long lists scroll within a bounded dialog.

| Fact | Source |
| --- | --- |
| Session's assigned checkout | Harness's saved launch/resume association |
| Checked-out branch | Git, read directly on the owning machine |
| Recent work branch | Most recent successful location observation, resolved through current Git facts |
| Branch history | Saved Git observations for this conversation |
| Additional checkout association | Previously verified observations or successful tool activity |
| PR identity and state | GitHub, matched by head repository and branch, or a recorded PR URL |
| PR dates | GitHub's created, updated, merged and closed timestamps |

The Git reader works for every engine, including Claude Code, Codex and Grok.
No transcript or successful tool receipt is required for the assigned branch,
branch switches, branch history, or PR lookup. Unknown, pending and failed tool
activity cannot erase Git facts. Looking up a saved branch can discover its PR
after that local branch or checkout has been deleted.

This is an association record, not an authorship claim. Harness does not attach
every branch in the shared repository to every agent, infer ownership from a
branch prefix or GitHub author, or pretend that the last command's directory is
the session's one current branch. Engine activity can add associations and PR
URLs. Formats the reader cannot understand add nothing and remove nothing.
Recent work is an optional refinement: missing activity never hides known Git
branches. A later command outside Git retains the last useful Git context.
One observation spanning different branches or partially unresolved locations
does not choose an arbitrary branch.

## Freshness and history

The assigned checkout and previously associated checkouts are read through the
existing 15-second Git cache. An explicit details refresh clears their cached
Git snapshots. One projection inspects at most eight additional locations,
deduplicating resolved checkout roots. Nested checkouts are resolved through
Git rather than assumed to share their parent directory's branch. Incomplete
history is labeled. Short-lived branches switched away between observations,
and activity deleted before it was observed, cannot be reconstructed reliably.

Opening details checks a bounded page of four saved branch identities and four
PR URLs. **Load more** continues discovery and history refresh; it does not hide
already saved records behind another display limit. GitHub results
are cached for 60 seconds with their actual check times. A failed lookup retains
saved PR state. Offline clients show saved data with an offline label. Deleted
checkouts do not delete branch/PR history. A merged PR is not proof of a release
or permission to delete a checkout.

Histories live in private atomic files under `ADAPTER_DATA_DIR/session-git-history`,
outside the Git checkout, with at most 128 branches and 128 PRs per conversation.
They contain validated locations, branch identities and PR metadata, never raw
commands, credentials or transcript output. Inherited fork receipts are excluded.
The optional Claude/Codex reader accepts bounded literal operations without
executing transcript text. Existing v3 checkpoints replay available transcripts
once to recover missed batched receipts; later v4 reads stay incremental.

Registry `cwd` and the legacy `project` field keep their launch/resume meaning.
The additive `gitContext.checkouts` contains verified Git snapshots; optional
`gitContext.recentWork` selects one of them with its observation time. List and
push frames use the same projection and versions. Older clients remain readable;
the desktop groups the snapshots into branch identities. PR badge responses
are bound to the displayed repository, branch and checkout, and stale replies
are discarded. Readers run on the owning machine; private data uses the existing
encrypted machine RPC. No new dependencies or filesystem watchers are required.

This UI only inspects and navigates. It never checks out, pushes, merges,
deletes, or sends input to a terminal.

## Branch workflow

Use one topic branch per independently reviewable change and one isolated
checkout per concurrently editing agent. Sequential tasks can reuse a checkout
and produce several PRs. Start unrelated changes from updated `origin/main`;
make deliberate stacked dependencies explicit. Put review fixes on the original
PR branch. After merging, start a new branch for the next task, once changes are
saved and processes using the checkout have finished.
