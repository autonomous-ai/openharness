# External engines: completion and commit audit

The original `external-engines` branch is preserved at `40f12db0`; its `dapper-otter`
worktree is clean. The continuation used a separate branch and worktree.

## Original commits confirmed

`git range-diff 244cfe71..40f12db0 93f148d6..c6871968` reports `=` for every commit:

| Original | Rebased | Work |
| --- | --- | --- |
| `adc7f2e1` | `015668e8` | External-provider framework |
| `0b8d7f36` | `c4993f85` | Framework tests, search filters, desktop engine names |
| `5c52bad8` | `46b2ce60` | OpenCode, Kilo, Hermes, Devin, Pi, Command Code, Muse, Antigravity |
| `7f97678f` | `a54fb579` | Cursor, Grok, Copilot; stale-lock and timestamp handling |
| `c07a20b2` | `7768a453` | Review fixes |
| `40f12db0` | `c6871968` | Research and handoff |

The rebase includes #391 and #392. The continuation added `930c7ba4` to refresh
cached immutable SQLite readers after a complete write/checkpoint/close cycle and
rebuild older search indexes. [PR #396](https://github.com/autonomous-ai/openharness/pull/396)
merged as `aae13041`. `git diff 930c7ba4 aae13041` is empty: the merged tree is the
tested tree.

## What users gain

- Search and resume local conversations from 13 engines: Claude Code, Codex,
  Cursor, OpenCode, Kilo, Hermes, Devin, Pi, Command Code, Muse, Grok, Antigravity,
  and Copilot. Amp remains outside local discovery because its threads live remotely.
- Ownership checks distinguish terminal, app, Harness, and uncertain ownership.
  Only verified ownership can authorize takeover; an argument-only guess cannot
  stop a process. Busy conversations can wait for an idle turn.
- Engine-specific filtering removes child/internal streams and handles timestamps,
  stale locks, profiles, overridden store locations, and resumable session IDs.
- Idle SQLite stores stay read-only, without new WAL/SHM files; completed write
  cycles now invalidate a cached snapshot so search sees subsequent conversations.

## Outstanding work resolved

[PR #388](https://github.com/autonomous-ai/openharness/pull/388) merged as `8e814775`.
Codex file, browser, and editor context no longer replaces the person's actual ask
in search. Its schema was reconciled to **11**, with rebuild tests for 0, 8, 9, and
10. All 350 session-search tests passed before merging.

[PR #390](https://github.com/autonomous-ai/openharness/pull/390) merged as `c9577b42`.
Hermes's offline hook can wait three seconds for its store, matching the process
scan budget. The delayed-store regression and all 32 hook tests passed before merging.

The four existing engine bugs recorded by Claude are fixed in the follow-up:

- Cursor now resolves config and data roots independently for hook installation,
  transcript validation/discovery, subagent replay/live completion, and recap cleanup.
  Tests use separate physical roots and verify that another conversation survives cleanup.
- OpenCode recap processes set an absolute `OPENCODE_DB` and their own `PWD` while
  preserving provider configuration and the authentication-file location.
  OpenCode 1.18.32 was run in an isolated home: `db path` named the recap database,
  a real session-table query succeeded, and the default database path remained absent.
- Hermes accepts `tui` alongside `cli` in both online and offline hook classification;
  delegation children and unknown offline rows remain excluded.
- Command Code uses the same pinned `@sindresorhus/slugify` 2.2.1 implementation as
  the published Command Code 1.66.0 package, including camel case, acronym and Unicode
  handling and the `root` fallback. The package was inspected without installing or
  executing Command Code.

The desktop timer failure was confirmed on the original base and main, then fixed
as a stale test expectation: a signed-out desktop now opens a guest workspace.
The other baseline failures were stale shortcut, picker, hover, or sign-out
expectations. Guest fixtures avoid real CLI/daemon calls, and account-wide teardown
tests explicitly exercise viewers. The shared toolbar owns compact-pane model
selection; pane close becomes clickable on header hover.

## Validation

- CLI typecheck and production build pass. Full suite: **5,266 passed, 63 skipped**,
  312 passing test files. Focused engine regressions: **154 passed, one optional
  real-engine test skipped**. The final Cursor fixture also passes using built-in
  SQLite, without requiring a separate sqlite3 executable.
- The original external-provider implementation had **100% statement, branch,
  function, and line coverage** at #396, across `external.ts` and `externals/*.ts`.
- Complete desktop suite: **3,778 passed, 12 skipped, zero failures**. All 33
  baseline failures recorded at handoff are resolved, including the test-file load error.
- Desktop analyzer: no errors or warnings with `--no-fatal-infos`; 13 existing
  informational diagnostics remain in `third_party/xterm`. The compile error and
  all application/test analyzer diagnostics from the handoff are resolved.
- Real tmux validation in the continuation passed nine cases and skipped nine
  unavailable engine rows. All fixtures used an isolated home and explicit socket.
- The historical Herdr suite requires 0.8.x/protocol 19; the installed binary is
  0.9.1/protocol 22. Herdr is retired from active backend selection (see
  `cli/README.md`), so this is not evidence for a supported release backend.

Release through `make release-cli`, followed by `make release-desktop`, from the
merged, tested commit. The GitHub releases and public manifests record the final
versions and artifact checksums.
