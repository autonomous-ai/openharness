# Batch repository paths and branch discovery

Live daemon profiling identified Git subprocess startup during project metadata
refreshes as recurring work. Even after cache improvements, an uncached normal
lookup still started three processes: repository paths, branch, and configuration.

`agentProject` now obtains the paths and abbreviated branch from one `rev-parse`
call. A resolved detached HEAD skips the otherwise unsuccessful `symbolic-ref`
call. Git still determines branch names, configuration precedence, includes and
worktree identity. Refresh intervals, cache invalidation and the four-repository
concurrency limit are unchanged.

An unborn HEAD prints valid paths before exiting with status 128. Only that
bounded output shape is reused; `symbolic-ref` still supplies its branch. Ambiguous
HEAD names that omit the abbreviation also use `symbolic-ref`. Newline-containing
physical paths and older Git path-format output retain separate path reads.

## Component measurements

[Raw trials, source hashes and validation](2026-10-02-project-read-batching.json)
come from `cli/scripts/benchmark-project-reads.mjs`. Four trials alternate baseline
and candidate order. Each case has two warmups and six measured uncached reads per
trial, with at most four repositories inspected concurrently. The table uses the
median of all 24 measured rounds per variant. Git Trace2 counts subprocesses in
separate reads, outside the timing window.

| Case | Git processes, before → after | Before, ms | After, ms | Less wall time |
| --- | ---: | ---: | ---: | ---: |
| One checked-out branch | 3 → 2 | 39.534 | 26.929 | 31.9% |
| 16 checkouts (15 linked worktrees) | 48 → 32 | 196.067 | 132.998 | 32.2% |
| New repository, no commit | 3 → 3 | 40.146 | 40.125 | 0.1% |
| Detached HEAD | 4 → 3 | 54.481 | 40.461 | 25.7% |

The new-repository control is effectively unchanged. Node CPU per 16-checkout
batch fell from 50.721 to 37.046 ms in this run; that excludes Git child CPU.
Wall time includes both Git and filesystem work. These are component results on
macOS arm64, Node 22.23.2 and Apple Git 2.50.1. Other user work remained active,
so this does not prove a matching whole-daemon CPU, energy or battery improvement.
The benchmark uses only disposable repositories and performs no network access.
Its fixture repositories were removed after completion.

To reproduce from the repository root, provide the old source as a file and use
a new output directory (existing evidence is never overwritten):

```sh
git show afea68e8f2f802fed5a7886f6c76ae07fdbb18e1:cli/src/lib/agentProject.ts > /tmp/project-before.ts
node cli/scripts/benchmark-project-reads.mjs /tmp/project-before.ts cli/src/lib/agentProject.ts /tmp/project-read-results
```

## Validation and scope

- 107 affected tests passed across seven files, including 18 project-reader cases.
  The tests use real Git for branch changes, detached and unborn HEADs, colliding
  ref names, linked worktrees, nested/symlink/newline paths, exact config keys,
  included and worktree config precedence, missing folders, cache pressure and
  racing metadata. Direct session/project/PR consumers are included.
- CLI typecheck, benchmark syntax and process cleanup verification passed.
- Project-reader coverage is 140/142 executable lines (98.59%) and 167/186 branches
  (89.78%). This is component coverage, not 100% end-to-end coverage of Harness.
- No application, daemon, engine or tmux session was restarted. No persistence,
  terminal protocol, session lifecycle or UI behavior changes are included.

The first validation run could not inspect its process groups inside the sandbox;
its receipt remains `cleanup_failed`. A later run exposed a TypeScript narrowing
error despite passing behavior tests. The final const expression passed typecheck
and all affected tests, with cleanup inspection enabled. Its exact source also
ran through the benchmark above. Those earlier failed receipts are recorded rather
than counted as passing evidence.

Final validation ran from 16:38:37 to 16:38:56 UTC on October 2. Tested implementation
commit: `3c715b8057a8c5102fe9789af3376f997bb096a0`; the receipt also records the preceding dirty-source
fingerprint. Only evidence documentation was added afterward. Original request
time is unavailable in this continuation; GitHub records PR and merge times.
This work is PR/merge only under the user's release hold. It has not been installed
in the running daemon or released.

Main then added memory extraction prompt changes outside the project-reader graph.
The rebase preserved all tested Git inputs byte for byte; whole-CLI typecheck
passed again at 16:45:36 UTC. The 107 behavior tests and benchmark retain their
original evidence.
