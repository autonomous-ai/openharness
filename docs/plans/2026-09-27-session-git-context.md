# Session Git context

The current product and data contract is [Session branches and pull requests](../worktree-pull-requests.md).
The original location-driven design below records the first delivery; it is superseded by the branch-first correction at the end.

## Product contract

A session is a durable conversation, a worktree is a checkout, a branch is a
mutable Git ref, and a pull request is a durable review record. These have
different lifetimes. A session can work in several checkouts and produce many
branches and PRs without changing its name or launch directory.

The focused context shows the branch read from Git in the most recently
observed work location. Its tooltip explains the location and observation time.
Pending, failed or unsupported newer activity retains that confirmed location
with a “last observed” qualifier. Unknown is reserved for sessions without a
confirmed location; an attempted command is never promoted to confirmed work.
The session's original directory remains available as “Launch workspace”.
If several locations occur in one operation, show “Multiple workspaces” and
let the user inspect them. Never select one by an arbitrary completion order.
When no work location is observable, label the registered directory as the
session workspace rather than claiming to know where a tool is executing.

The branch opens session work details. The current PR remains a direct GitHub
link. Details contain recent workspaces/branches and PRs associated with this
session, with open work before merged/closed history. A PR opened for review,
a successful push, and a merge are different facts. Do not call a push shipped.
All actions on this surface are inspection/navigation; opening it cannot
checkout, stash, merge, reset, delete, or send terminal input.

## Evidence and ownership

Keep registry `cwd` unchanged: launch, resume, viewers, and cleanup depend on it.
Add display context separately. Source absolute work locations from successful
tool receipts, including explicit tool cwd, literal `cd … && …`, `git -C …`, and
file tools. Read actual branch names from Git; folder names and transcript
startup `gitBranch` fields are not current branch evidence.

Parse only literal, unambiguous commands. Never execute transcript text. Dynamic
shell expressions and arbitrary code-mode scripts cannot establish a location.
Record uncertainty rather than attaching their results to a guessed checkout.
Handle Claude and Codex receipts through the existing incremental transcript
reader. Other engines retain their registered workspace until they supply the
same observations. Ignore inherited fork history and another session's rows.

Persist minimal locations, timestamps, branch observations and validated PR URLs
on the owning machine, outside the checkout. Keep raw commands, tool output,
credentials and environment out of the record and wire response. Bound pending
receipts, history, subprocesses, cache sizes and network work. Replays and daemon
restarts must not duplicate associations. Git data and PR data have independent
freshness; an unavailable lookup must not become “no PR” or erase known history.

Associate PRs by successful creation receipts or a verified repository + head
branch lookup for an observed checkout. Never infer session ownership from the
GitHub author, branch prefix, or every branch in the shared repository. Retain
PR identity after branch/worktree deletion. Fork PR identity includes base
repository, head repository and head ref. Show unavailable access explicitly in
details; keep a validated saved link usable.

## Delivery and transport

Every agent frame carries the same display context in list and push responses.
Old clients continue to receive the registered `project`. New clients prefer
the observed display context. Branch and PR must refer to the same checkout
identity: discard replies after focus, repository, branch or workspace changes.
Use the existing encrypted `git_pull_request` RPC with an optional history
request, so a new protocol type is unnecessary. Readers remain on the owning
machine and use its existing GitHub access.

Desktop, native titlebar and web share the existing status formatter. Mobile
uses the same context semantics and exposes details through its session UI.
The terminal design system applies: plain text, measured cells, keyboard
navigation, preserved focus, no terminal recreation. Narrow layouts truncate
the current context while preserving the details action and accessible names.
Offline views show last-known observations as such.

## Git workflow

Use one topic branch per independently reviewable change and one worktree per
concurrently edited checkout. An agent can reuse its own worktree for sequential
tasks and have several PRs open. Switch only with saved work and no process still
using that checkout. Start unrelated work from updated `origin/main`; explicitly
stack dependent changes. Put review fixes on the original PR branch. Retire
merged topic branches and start new ones for subsequent work. PR history is the
durable output record. Worktrees share refs and remotes, so they are isolation
for files/index/HEAD rather than independent repositories.

## Verification gates

- Reproduce `silent-beacon` launch + successful work under `ship-hn/tui`; show
  the branch of that checkout and preserve the launch directory.
- Same worktree switching branches refreshes display and PR identity.
- Multiple worktrees and overlapping/out-of-order tool completions cannot
  confidently label the wrong checkout as current.
- Quoted paths, subdirectories, detached HEAD, non-Git folders, deleted worktrees,
  invalid paths, dynamic shell code, failed tools and running tools are covered.
- PR creation, repeated receipts, multiple PRs, forks, merges, branch deletion,
  permission failure and offline refresh retain correct associations.
- Restart/checkpoint migration, append-only reads, transcript replacement,
  foreign-session records and inherited fork history are covered.
- Old/new wire shapes, list/push equivalence, stale async replies, independent
  machines, dependent viewers and account/session changes are covered.
- UI verification covers keyboard access, dismissal/focus restoration, long
  names, narrow windows, light/dark palettes and enlarged terminal text.

## Implementation

- `sessionWork.ts` extracts minimal receipt evidence; `literalToolCall.ts` parses
  a static literal subset without evaluating code. Yielded processes and cells
  are correlated with passive waits, including waits after checkpoint reload.
- `agentTokenUsage.ts` maintains observations in its existing append-only reader
  and v4 private checkpoint. No new transcript scanner or idle watcher is added.
- `sessionGitContext.ts` resolves checkout roots and branches. `agentFrame.ts`
  includes the same additive context on list and push frames; stable daemon
  versions and client merge rules protect against response reordering.
- `sessionGitHistory.ts` persists bounded conversation history. Entries with
  active readers/writes cannot be evicted, older lookups cannot undo newer state,
  and repository-rename aliases do not duplicate receipts.
- `gitPullRequest.ts` handles current head/fork matching, multiple PRs and saved
  URLs independently of checkout lifetime. Caches retain the actual GitHub check
  time. `sessionGitPullRequest.ts` and the existing encrypted RPC serve details.
- Desktop/native/web share observed context through `WorkspacePaneContext`.
  Branch navigation and the command picker open `SessionWorkDialog`; phone
  offers `SessionWorkPage`. Launch, clone, resume and cleanup identities retain
  their previous meaning.

## Verification evidence

Final checks on 2026-09-27:

- CLI: TypeScript check, 295 tests across 12 relevant files, and production build
  passed. The build retains an existing ESM `require` warning in the unchanged
  `src/dsh/verdict.spec.ts`.
- Desktop: 35 widget/model/controller regression tests passed; changed files
  passed static analysis without issues.
- Phone: 35 widget/model/state regression tests passed; changed files passed
  static analysis without issues.
- All eight synthetic renders were inspected. The final diff has no whitespace
  errors. Two representative captures are included in
  [the PR assets](../../.github/assets/session-git-context/README.md); generated
  build products and the remaining captures stay outside the source diff.

Pre-merge validation after rebasing onto `aae13041` (PR #396), on macOS 26.6.2
with Node 22.23.1 and Flutter 3.47.2 / Dart 3.13.2:

- Full CLI suite: 5,252 tests passed, 63 skipped; 310 files passed and 7 skipped.
  TypeScript check and production build passed. The opt-in real-engine and
  multiplexer suites were not enabled. The first sandboxed attempt was stopped
  after process-access restrictions; the complete run outside that sandbox
  passed using the suite's isolated data/runtime directories.
- Desktop's 35 tests and changed-file analysis passed again after the rebase.
- Phone sources were unaffected by the rebase; the 35-test and analysis results
  above apply to the final sources.

The automated Git integration uses real temporary repositories, linked worktrees
and JSONL transcripts, with deterministic GitHub responses. It exercises the
same readers and frame/RPC service used in production, without touching a user's
checkout or opening a live PR.

| Contract | Evidence |
| --- | --- |
| Original `hn` reproduction and branch switches | `sessionGitPullRequest.spec.ts`: launch in `silent-beacon`, receipts in `ship-hn/tui`, two actual Git branches, branch-bound PR replies, unchanged registered cwd |
| Worktree/branch deletion and restart | Same integration removes the linked checkout and both branches, verifies merged PRs by URL, reloads history from disk, then simulates unavailable GitHub access |
| Ambiguous, overlapping and yielded work | `sessionWork.spec.ts`: literal/quoted/dynamic commands, failed calls, multiple paths, out-of-order completion, code-mode cells, process polls and interactive input |
| Git identity | `sessionGitContext.spec.ts`, `agentProject.spec.ts`: actual branch rather than folder name, linked worktree roots, subdirectories, non-Git/missing folders, detached HEAD, bounded reads and stable frame versions |
| Durable minimal data | `sessionGitHistory.spec.ts`: two branches, restart, file mode 0600, separate conversations/forks, active-write eviction, stale state and renamed-URL deduplication |
| Incremental replay | `sessionWorkCache.spec.ts`, `agentTokenUsage.spec.ts`, `agentOutputStats.spec.ts`: append-only reads, restart, old checkpoints, compaction, foreign session metadata and inherited/sidechain records |
| GitHub states and forks | `gitPullRequest.spec.ts`: open/draft/closed/merged, fork collisions, parent PRs, repository renames, saved URLs, concurrency bounds, truthful cached check time and a branch switch during a lookup |
| Transport compatibility | `agentFrame.spec.ts`, `backendSocket.spec.ts`: shared complete frame shape, legacy badge requests, encrypted requester-scoped history replies |
| Client ordering and navigation | Desktop/mobile `session_git_context_test.dart` and `session_work_state_test.dart`: old/new data, rename aliases, reordered pushes, machine/session replacement; existing focused-PR tests cover viewer ownership and stale replies |
| Terminal safety and appearance | Desktop `session_work_navigation_test.dart`: native and Flutter branch actions, same terminal object, zero input, Escape; dialog/page tests cover keyboard return, late replies, offline links, long names, multiple PRs, scrolling and large text |

Synthetic screens were rendered and visually inspected at 1000×720 and 420×680
on desktop, and 390×760 on phone, in both application brightness settings and
normal/1.6× text sizes. They inherit the selected terminal palette, which can
remain dark when the surrounding application is light. Screens use real test
fonts and the phone's actual back-button icon font. Capture them again with
`HARNESS_GIT_CONTEXT_CAPTURE_DIR=/tmp/session-work-captures` when running the
respective dialog/page widget tests.

### Delivery boundaries

Observation history is intentionally partial. Dynamic/arbitrary code and engines
without readable receipts show explicit uncertainty or the labeled registered
workspace. Git and GitHub caches refresh independently (15 seconds and 60 seconds).
The reader supports github.com origins and their fork parents; GitHub Enterprise
and arbitrary fork-network bases are not claimed. No live GitHub credentials or
network were needed for the deterministic tests. A release/install is a separate
step; this change does not alter running agents' checkouts.

The user-facing behavior and recommended Git workflow are documented in
[Session work, branches, and pull requests](../worktree-pull-requests.md).

### Follow-up: recorded Codex batches

The session that created PR #397 exposed a gap in the original tests: its code
mode used multiple calls and emitted each result as a separate text block.
Treating the batch as unknown, and concatenating result blocks before parsing,
lost the yielded PR-creation receipt. A later unsupported call then erased the
last successful location before the daemon projected it into branch history.

The reader now accepts bounded unconditional sequential calls and literal
`Promise.all` / `Promise.allSettled` batches with exact result forwarding. It
keeps each result tied to its command, groups concurrent locations, and follows
partial cell output and subsequent process polls. Dynamic scripts remain
unconfirmed. Failed/unconfirmed work preserves the latest successful location;
desktop and phone qualify that context, including the branch-history marker.
Subfolders under a Git-verified root collapse into one recent workspace.

Version 3 checkpoints replay their available transcript once with the new reader,
retaining validated minimal history whose receipts were already compacted away.
Version 4 restarts resume append-only reads. The recorded regression fixture is
documented in `cli/src/lib/fixtures/session-work-codex.md`.

A read-only replay of this session's 26 MB transcript into temporary caches
resolved its actual `happy-owl` checkout, populated branch history, recovered
PR #397's creation URL, and verified its **Merged** state against GitHub. No
running daemon data was changed by that replay.

## Branch-first correction — September 28

Git, rather than transcript parsing, now supplies checked-out branch facts for
every engine. The assigned checkout is always inspected; validated historical
associations and successful activity add other checkouts. The projection emits
bounded Git snapshots, and history records branches even without tool receipts.
Unknown activity cannot clear a known branch. Multiple checked-out branches
produce a branch count; worktree paths are internal bookkeeping.

The desktop lists checked-out branches, recorded branches and PRs without
launch paths or recent subdirectory lists. GitHub head repository + branch
queries discover PRs from saved branch identities even after local deletion;
PR URL refresh preserves durable merged/closed history. Discovery and URL checks
share bounded pagination and retain actual cache check times.

Regression coverage includes real temporary Git repositories with Claude, Codex
and Grok registry rows and no transcripts, branch switches, another session's
unassociated branch, deleted branches before the first PR lookup, multiple
checkouts, offline preservation and the recorded Codex batch fixture. App tests
cover branch grouping, merged history, paths absent from the view, native and
Flutter navigation without terminal input, narrow layouts and large text.
