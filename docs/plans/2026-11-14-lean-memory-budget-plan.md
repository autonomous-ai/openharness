# The lean master's memory budget, one piece for every hash: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Task 1 is test-first: a red commit (the test
> alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The master hashes every file through one 64 KiB buffer, so it idles at about 75 MiB resident where it
drifted from 88 to 111 and failed `cli/e2e/lean.e2e.ts`'s 100 MiB budget by chance.

**Architecture:** One function, `sha256File` in `cli/src/harnessd/reexec.ts`, which the master runs on cli.js
(`fingerprint`) and on every file of its lean folder (`leanBundle.ts` `folderFingerprint`) before each process it
starts. It reads into one module-level buffer instead of a new one per call. Its signature, its callers and the hashes
it returns do not change.

**Tech Stack:** TypeScript, Vitest 4, Node 24.22.2 (CI; 22.15 and up supported). No new dependency.

**Spec:** [docs/plans/2026-11-14-lean-memory-budget-design.md](2026-11-14-lean-memory-budget-design.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/harnessd/AGENTS.md`. The spec is the authority.

## Open questions

None.

## Decisions

- The test goes in `cli/src/harnessd/reexec.spec.ts`, beside the function that owns the buffer: it covers both
  callers, and that file has no `node:fs` mock in the way (`leanBundle.spec.ts` has one).
- `HASH_PIECE_BYTES` goes: the buffer `HASH_PIECE` is the one constant, made as the module loads.
- `leanBundle.ts`, `cli/e2e/lean.e2e.ts` and `docs/design/2026-10-03-harnessd.md` do not change: what each says of the
  hash ("a piece at a time") stays true.

## Global Constraints

- Files: `cli/src/harnessd/reexec.ts` and `cli/src/harnessd/reexec.spec.ts`. Nothing else, and nothing under
  `cli/src/core/`.
- The budget stays 100 MiB: `cli/e2e/lean.e2e.ts` is not touched, nor any other budget.
- Viewers on macOS (102 to 109 MiB on Node 24) is not this branch's.
- No RSS threshold in a unit test: the test counts allocations, which is the same on every machine.
- `npm run test:harnessd` stays at 100% in every file.
- The measurement the comment and the pull request record (spec, 2026-11-14, Node 24.22.2, medians [min-max]): the
  lean folder grew from 236 files to 393; the master went from 95.6 [88-99] to 75.3 [75-75] MiB on Linux and from
  108.6 [101-111] to 76.6 on macOS; the failed run read 100.4.
- Comments say why, in plain sentences, with the measurement.
- A task runs only the specs of what it changed, the typecheck and the harnessd gate (22 s). No other local suite:
  PR CI runs them.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Platforms: Linux and macOS, where the master checks a lean folder. On Windows the master runs from cli.js
  (`cli/src/masterProcess.ts:405`) and hashes that one file through the same function: nothing changes there.
- One pull request; its body names the platforms and carries the red and green output, the spec's numbers and the
  Verification results.

## Found while reading the code

Checked at `39c675b7af`, on a Mac (arm64).

- **Baseline.** `npx vitest run src/harnessd/reexec.spec.ts src/harnessd/leanBundle.spec.ts`: `76 passed (76)` (54 and
  22). `npm run test:harnessd`: `10 passed (10)`, `367 passed | 1 skipped (368)`, 100% on all four measures, 22 s.
- **Callers.** `sha256File` is called by `fingerprint` (`reexec.ts:69`; `master.ts:323` and `:326`, on cli.js) and by
  `folderFingerprint` (`leanBundle.ts:106`; `leanServices.ts:68`, before each process started from the lean folder).
  `HASH_PIECE_BYTES` is used on `reexec.ts:47` and `:59` only.
- **The core never loads the file.** Neither `harnessd/reexec.ts` nor `harnessd/leanBundle.ts` is in
  `cli/src/architecture.coreFiles.txt`. The master, `masterProcess.ts` and the CLI (`lib/daemonStop.ts`) load it: each
  holds the one piece from then on.
- **Rehearsed** in a scratch copy of the module, on Node 22.23.2, 23.11.0 and 24.22.2: the test below is red on
  today's code (`expected 40 to be +0`), green with Step 4's change, and passes `tsc` with the repo's options. Nothing
  inside Node calls `Buffer.alloc`, `allocUnsafe` or `allocUnsafeSlow` while a file is opened, read and hashed.
- **Restoring a spy clears its calls** (Vitest 4.1.10): the test counts before it restores.
- **Local gate.** `python3 scripts/local-checks.py --list` on the two files names `cli-harnessd`
  (`npm run test:harnessd`, in `cli/`, any platform). `process-checks` refuses the pull request without its receipt.

## Review Focus

- A short file hashed after a long one: the piece still holds the end of the longer file, and none of it may be hashed
  into the shorter. Pinned by the new case: the longest file first, 39 shorter ones after it, each hash its own.
- A file of several pieces with a last piece that is not whole, and an empty file: the existing case `reads it a piece
  at a time…`, unchanged, must stay green.
- A file that cannot be read (missing, a folder): the throw closes the file and `fingerprint` answers null, as the
  existing case `is told by the sha256 of its bytes…` holds. The piece keeps no length or offset between calls, so
  there is nothing to reset for the next file.
- Two calls holding the piece at once: none can, the function is synchronous from open to close. Its `: string`
  return type is what keeps it so: an async version would not compile at `fingerprint`.
- The allocation is counted, not the memory: the spies see `Buffer.alloc`, `allocUnsafe` and `allocUnsafeSlow` only.
  What the master's RSS then is, the end-to-end check shows (Verification, check 2).

---

### Task 1: `sha256File` reads every file through one piece

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Modify: `cli/src/harnessd/reexec.ts:46-65`
- Test: `cli/src/harnessd/reexec.spec.ts` (`describe('which bundle')`, a new case after line 43; no new import)

**Interfaces:**
- Produces: `sha256File(path: string): string` and `fingerprint(path: string): string | null`, both unchanged.

**The test that fails before the change:** `which bundle › reads every file through one piece: no buffer per file,
and nothing of one file hashed into the next`, in `cli/src/harnessd/reexec.spec.ts`.

- [ ] **Step 1: Write the failing test**

After the case `reads it a piece at a time, to the same sha256 as all its bytes at once, empty or not`:

```ts
  it('reads every file through one piece: no buffer per file, and nothing of one file hashed into the next', () => {
    // A lean folder in small: many files, the longest first, so every one after it is read into a piece that
    // still holds the end of a longer file.
    const files = Array.from({ length: 40 }, (_, index) => {
      const path = join(dir, `chunk-${index}.mjs`)
      const bytes = randomBytes(index === 0 ? 2 * 64 * 1024 + 5 : index * 97)
      writeFileSync(path, bytes)
      return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
    // Watched from here on: the one piece the module holds was made as it loaded.
    const allocators = (['alloc', 'allocUnsafe', 'allocUnsafeSlow'] as const).map((name) => vi.spyOn(Buffer, name))
    let hashes: string[]
    let allocations: number
    try {
      hashes = files.map(({ path }) => sha256File(path))
      // Counted before the spies are restored: restoring one clears its calls.
      allocations = allocators.reduce((sum, allocator) => sum + allocator.mock.calls.length, 0)
    } finally {
      for (const allocator of allocators) allocator.mockRestore()
    }
    expect(allocations, 'buffers allocated while hashing 40 files').toBe(0)
    expect(hashes).toEqual(files.map(({ sha256 }) => sha256))
  })
```

- [ ] **Step 2: See it fail**

Run: `cd cli && npx vitest run src/harnessd/reexec.spec.ts -t "reads every file through one piece"`
Expected: `1 failed | 54 skipped (55)`, with
`AssertionError: buffers allocated while hashing 40 files: expected 40 to be +0`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/harnessd/reexec.spec.ts
git commit -m "harnessd: the hash test expects one piece for every file, none allocated per file"
```

- [ ] **Step 4: One piece, and why**

In `reexec.ts`, lines 46-47 (`HASH_PIECE_BYTES` and its comment) become:

```ts
/** The piece of a file `sha256File` holds at a time: one, for every call (why is on `sha256File`). */
const HASH_PIECE = Buffer.allocUnsafe(64 * 1024)
```

In `sha256File`, the line `const piece = Buffer.allocUnsafe(HASH_PIECE_BYTES)` goes and the loop reads into
`HASH_PIECE` and hashes `HASH_PIECE.subarray(0, read)`; nothing else in the body changes. Its comment keeps its first
paragraph to the character and gains a second: the closing ` */` on line 54 is replaced by

```ts
 *
 * Every call reads through the same piece. With a piece of its own per call, a check of the lean folder
 * allocated 64 KiB per file, and the folder grew from 236 files to 393: about 25 MiB at each check. They
 * were freed, but the allocator kept the pages, so the master stayed as high as the collections' timing
 * had let it climb: 88 to 99 MiB resident on Linux and 101 to 111 on macOS, against the 100 MiB
 * e2e/lean.e2e.ts holds it under, which failed at 100.4 on 2026-11-14. Through one piece it is 75.3 MiB
 * on Linux (the median was 95.6) and 76.6 on macOS (108.6), the same in every run (Node 24.22.2, measured
 * 2026-11-14). The reads are synchronous, so no two calls ever hold the piece at once.
 */
```

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/harnessd/reexec.spec.ts src/harnessd/leanBundle.spec.ts   # 77 passed (77)
npm run typecheck                                                            # no error, about a minute
npm run test:harnessd                # 10 passed (10); 368 passed | 1 skipped (369); 100% on all four measures
grep -c 'HASH_PIECE_BYTES' src/harnessd/reexec.ts                            # 0
git status --short                   # reexec.ts alone, besides the two untracked documents under docs/plans/
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/harnessd/reexec.ts
git commit -m "harnessd: the master hashes every file through one buffer (75 MiB resident, was 88 to 111 against a 100 MiB budget)"
```

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): the specs write
only under their run's temporary folder; the end-to-end file boots its own daemon under a throwaway home and data
folder, with a private tmux server and fake engines, signed out. No sign-in, no account, no backend, no production,
nothing of the developer's daemon (port 18473) or `~/.harness`. None of these checks needs Ken himself.

1. **The check PR CI does not run: `cli-harnessd`.** Local, on a Mac, from a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:harnessd` in `cli/` (22 s). To see: `10 passed (10)`, `368 passed | 1 skipped (369)`, the
   coverage summary at 100% on all four measures. Its output, one `harness-local-checks` fence, goes in the pull
   request's body.

2. **`cli/e2e/lean.e2e.ts` on Linux, on GitHub, by hand, once, on the orchestrator's go.** Ask first: it is a heavy
   workflow (nine runners), never started beside another one.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/lean-memory-budget
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; in its shard `e2e/lean.e2e.ts`
   with 7 passed, among them `re-executes the master, same pid, on the lean bundle, and runs every service and the
   core from it`, which holds the master, search, viewers, edge and models under 100 MiB each. A pass prints no
   number: the spec's are 75.3 MiB [75-75] for the master and 95.6 for viewers, the highest. Report the run's link. A
   red test is reported with its link, the process and the MiB its assertion names, and whether main's last nightly
   run has it too.

3. **Linux, by PR CI, not started by hand:** `cli-typecheck` and `cli-tests` (Node 24.22.2) run `reexec.spec.ts`. To
   see: `ci/required` green.

**Not a check: `lean.e2e.ts` on a Mac.** It is red there for viewers before and after this branch (spec, "Not in this
branch"). macOS has check 1, which runs the new case on a Mac, and the spec's measurement of the master with this
change (108.6 to 76.6 MiB).

**Temporary workflow:** none. The one long check has a workflow already (`cli-e2e.yml`).
