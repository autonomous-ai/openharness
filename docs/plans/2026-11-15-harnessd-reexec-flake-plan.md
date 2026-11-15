# A copied Node under Rosetta, a named refusal: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. One task, test-first: a red commit (the test
> alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A test that copies its Node fails in under a second with `RosettaNodeError`, which names the cause and the
fix, when that Node is an x86_64 build on an Apple Silicon Mac, where today it times out after 30 s.

**Architecture:** One test helper, `cli/src/testing/placeNode.ts`. Before it copies anything, `placeNode` reads
`process.platform`, `process.arch` and the first CPU's model, and throws when they say Rosetta runs this Node. The
three readings are its third parameter, with the real ones as its default, so its spec names any machine on any
runner. No caller, no timeout and no product code changes.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node 22.21.1 (the arm64 build). No new dependency.

**Spec:** [docs/plans/2026-11-15-harnessd-reexec-flake-design.md](2026-11-15-harnessd-reexec-flake-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Open questions

None.

## Global Constraints

- The condition, verbatim from the spec: `process.platform` is `darwin`, `process.arch` is `x64` and
  `os.cpus()[0].model` starts with `Apple`. An Intel Mac, an arm64 Node, Linux and Windows are unchanged.
- No timeout changes anywhere: `until`'s 30 s in `master.spec.ts`, `testTimeout: 30_000` in `cli/vitest.config.ts`
  and the 20 s of `selfUpdate.spec.ts`'s describe all stay.
- Files: `cli/src/testing/placeNode.ts` and `cli/src/testing/placeNode.spec.ts`. Nothing else: no caller
  (`master.spec.ts`, `processName.spec.ts`, `selfUpdate.spec.ts`), not `scripts/local-checks.py`, and not
  `cli/src/lib/runtimeInstall.ts` (`platformKey` under Rosetta is a separate proposal).
- **Every command here runs with the arm64 Node first on `PATH`.** This Mac's own `node` is nvm's x86_64 build, the
  cause of the bug. Start each shell with:

  ```bash
  export PATH="$(echo /private/tmp/claude-503/*-harnessd-reexec-flake/*/scratchpad/node-v22.21.1-darwin-arm64/bin):$PATH"
  node -p process.arch
  ```

  It must print `arm64`. If it prints `x64` or fails, stop and tell the orchestrator: the arm64 Node is gone (a
  reboot clears `/private/tmp`).
- `cli/node_modules` is installed (`npm ci` under that arm64 Node, so its native packages are arm64). Do not install
  again, and never under another Node.
- The error names no path, version or user: its message is one fixed sentence. Nothing of this Mac's paths goes in a
  comment, a commit message or the pull request body.
- Comments say why, in plain sentences, with the spec's measurement (M1 Pro, 2026-11-15).
- A task runs only the specs it names. No full local suite: PR CI runs it.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Platforms: a test helper only, no product code. What changes is a developer's Apple Silicon Mac whose Node is
  x86_64. One pull request; its body names that, and carries the red and green output, the spec's table and the
  Verification results.

## Found while reading the code

Checked at `be613c89a9`, on the reporting Mac (M1 Pro), with the change rehearsed under the arm64 Node and put back.

- **The readings tell the two Nodes apart.** nvm's `v22.21.1` (`file`: `Mach-O 64-bit executable x86_64`) prints
  `x64` and `Apple M1 Pro` for `process.arch` and `os.cpus()[0].model`; the arm64 Node prints `arm64` and
  `Apple M1 Pro`.
- **Baseline.** `npx vitest run src/testing/placeNode.spec.ts`: `Tests  2 passed (2)`.
- **Rehearsed.** Step 1's cases alone: `1 failed | 6 passed (7)`. With Step 4: `7 passed (7)`; `npm run typecheck`
  clean in 30 s; the three calling specs `Test Files  3 passed (3)`, `Tests  148 passed (148)` in 33 s;
  `npm run test:harnessd` `Test Files  10 passed (10)`, `Tests  367 passed | 1 skipped (368)` in 25 s, exit 0. The
  Mac was at load 15 to 70 throughout.
- **The real refusal, rehearsed.** Under nvm's x86_64 Node, Verification 4's command printed the
  `RosettaNodeError` line in 0.31 s and left nothing behind. It imports `placeNode.ts` through Node's own type
  stripping: Vitest cannot start under that Node here, since `cli/node_modules` holds arm64 native packages only
  (`@esbuild/darwin-arm64`). So the class takes no constructor parameter property, which type stripping refuses.
- **Callers.** `master.spec.ts:317, 1304, 1337, 1365`, `processName.spec.ts:110`, `selfUpdate.spec.ts:1521, 1626`.
  Each calls `placeNode` in a test body or a `beforeEach` and none catches, so the error is that test's failure.
  All pass two arguments at most: a third, defaulted parameter changes none of them.
- **`os.cpus()` can be empty** (a sandbox that hides the CPUs), and a default parameter is read on every platform,
  so the default is `cpus()[0]?.model`, as `cli/src/lib/machineHardware.ts:47` reads it.
- **Injection follows `suiteWorkers(machine = availableParallelism())`** (`cli/src/testing/suiteWorkers.ts`): the
  real reading is the parameter's default, and the spec passes another.
- **No CI job runs these specs under Rosetta.** `cli-tests` is Linux. The `macos-15` jobs are Apple Silicon with
  `actions/setup-node`'s default arm64 build; no workflow sets a Node `architecture:`. The Windows workflow's list
  of specs does not hold `placeNode.spec.ts`.
- **The local gate is not required for this diff.**
  `python3 scripts/local-checks.py --list cli/src/testing/placeNode.ts cli/src/testing/placeNode.spec.ts` prints
  `{}`: `cli-harnessd` is selected by `cli/src/harnessd/*` and `cli/vitest.harnessd.config.ts` only. So `--run`
  writes no receipt here, and Verification runs `npm run test:harnessd` by hand as well.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/testing/placeNode.spec.ts` | two imports; one refusal case and four "copies as before" cases | 1 |
| `cli/src/testing/placeNode.ts` | `RosettaNodeError`, the `machine` parameter, the check, the comment | 1 |

## Review Focus

- The real reading on a real Rosetta Node: every spec case names its machine, and CI has no such Node. Verification 4
  runs the default on this Mac under the x86_64 Node.
- A refusal that comes after a write: a copy, a `runFrom` folder or a libnode link left in a folder the test then
  hard-links from. Step 1, the refusal case: `readdirSync(dir)` is `[]`, with a `runFrom` given.
- Refusing too much: an Intel Mac (`x64`, an Intel CPU), an arm64 Node, an x86_64 Node off the Mac. Step 1, one row
  each; each row fails if its part of the condition is dropped.
- A machine that names no CPU: `os.cpus()` empty must copy, never throw a `TypeError`. Step 1, the last row; the two
  old cases read the real default on every runner.
- A message that names a path or the user: red output is pasted into pull requests. Step 1 pins the whole text, which
  holds neither.

---

### Task 1: `placeNode` refuses a Node that Rosetta runs

**Depends on:** nothing. **Effort:** medium (mechanical: one helper and its spec, every value given below).

**Files:**
- Modify: `cli/src/testing/placeNode.ts`
- Test: `cli/src/testing/placeNode.spec.ts`

**The test that fails before the change:** `placeNode › refuses an x86_64 Node that Rosetta runs, by name, and
copies nothing`, in `cli/src/testing/placeNode.spec.ts`. It names its machine, so it is red on any runner.

**Interfaces:** produces, from `cli/src/testing/placeNode.ts`:
`placeNode(path: string, runFrom?: string[], machine?: { platform: string; arch: string; cpu: string | undefined }): void`
and `class RosettaNodeError extends Error` (`name` is `'RosettaNodeError'`, no constructor argument).

- [ ] **Step 1: Write the failing test**

In `cli/src/testing/placeNode.spec.ts`, add `readdirSync` to the `node:fs` import and `RosettaNodeError` to the
`./placeNode.js` import. Then, inside `describe('placeNode', …)`, after the last case:

```ts
  // On an Apple Silicon Mac, Rosetta translates an x86_64 Node again at each new path it runs from: 15.3 s for the
  // first run of a fresh copy and 16.1 s for a hard link of it, against 0.30 s for an arm64 copy (M1 Pro, 2026-11-15).
  // Two such paths in one test ran past master.spec.ts's 30 s waits, and the failure named a timeout, not the Node.
  it('refuses an x86_64 Node that Rosetta runs, by name, and copies nothing', () => {
    const refusal = (() => {
      try { placeNode(join(dir, 'node'), [join(dir, 'libexec')], { platform: 'darwin', arch: 'x64', cpu: 'Apple M1 Pro' }) } catch (error) { return error }
    })()
    expect(String(refusal)).toBe('RosettaNodeError: This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
    expect(refusal).toBeInstanceOf(RosettaNodeError)
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['an arm64 Node on Apple Silicon', { platform: 'darwin', arch: 'arm64', cpu: 'Apple M1 Pro' }],
    ['an x86_64 Node on an Intel Mac', { platform: 'darwin', arch: 'x64', cpu: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' }],
    ['an x86_64 Node off the Mac', { platform: 'linux', arch: 'x64', cpu: 'Apple M1 Pro' }],
    ['a Node whose machine names no CPU', { platform: 'darwin', arch: 'x64', cpu: undefined }],
  ])('copies %s as before', (_, machine) => {
    const node = join(dir, 'node')
    placeNode(node, [], machine)
    expect(statSync(node).size).toBe(statSync(process.execPath).size)
  })
```

The four rows pass before the change too (today's `placeNode` ignores a third argument): they hold what must not
change. They copy and never run the copy.

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/placeNode.spec.ts`
Expected: `Tests  1 failed | 6 passed (7)`, the failure:

```
AssertionError: expected 'undefined' to be 'RosettaNodeError: This Node is an x86…' // Object.is equality
```

Keep the output for the pull request body. (`npm run typecheck` is red on this commit, by design: the export does
not exist yet.)

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/testing/placeNode.spec.ts
git commit -m "CLI tests: a spec for placeNode's refusal of an x86_64 Node under Rosetta (red)"
```

- [ ] **Step 4: Refuse before anything is copied**

In `cli/src/testing/placeNode.ts`: import `cpus` from `node:os`, and add above `placeNode`'s comment:

```ts
/** What tells a Node that Rosetta runs from any other: `process.platform`, `process.arch` and the first CPU's model. */
interface Machine { platform: string; arch: string; cpu: string | undefined }

/** The Node running the tests is an x86_64 build on an Apple Silicon Mac. */
export class RosettaNodeError extends Error {
  override readonly name = 'RosettaNodeError'
  constructor() {
    super('This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.')
  }
}
```

`placeNode` gains the parameter and, as its first statement, the check:

```ts
export function placeNode(path: string, runFrom: string[] = [], machine: Machine = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }): void {
  if (machine.platform === 'darwin' && machine.arch === 'x64' && machine.cpu?.startsWith('Apple')) throw new RosettaNodeError()
```

Its doc comment gains one paragraph, after the libnode one:

```ts
 *
 * Never a Node that Rosetta runs: it translates a binary again at each new path. On an M1 Pro (2026-11-15) the first
 * run of a fresh x86_64 copy took 15.3 s and of a hard link of it 16.1 s, against 0.30 s for an arm64 copy. A test
 * that runs two such paths outlasts master.spec.ts's 30 s waits (2 failed in 141 s; on an arm64 Node 60 of 60 in
 * 23 s). No wait is long enough for that, so [machine] is refused by name before anything is copied. A test names
 * another machine.
```

The rest of the body stays as it is.

- [ ] **Step 5: Run the spec, the typecheck and the callers**

Run: `cd cli && npx vitest run src/testing/placeNode.spec.ts`
Expected: `Tests  7 passed (7)`.

Run: `cd cli && npm run typecheck`
Expected: no error (about 30 s).

Run: `cd cli && npx vitest run src/harnessd/master.spec.ts src/harnessd/processName.spec.ts src/lib/selfUpdate.spec.ts`
Expected: `Test Files  3 passed (3)`, `Tests  148 passed (148)` (about 35 s). A `MODULE_NOT_FOUND` trace from a
stand-in child in the output is one of those tests' own and was there before.

- [ ] **Step 6: Check the diff is that and nothing else**

Run: `git status --short && git diff --stat`
Expected: `cli/src/testing/placeNode.ts` modified, about 20 lines added and 1 changed; nothing else but the untracked
documents under `docs/plans/`.

- [ ] **Step 7: Commit**

```bash
git add cli/src/testing/placeNode.ts
git commit -m "CLI tests: placeNode refuses an x86_64 Node under Rosetta by name, where the re-exec tests timed out"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

## Left out

- `runtimeInstall.ts` `platformKey` under Rosetta: the spec sends it to the maintainers as its own proposal.
- Specs that copy their Node without `placeNode`: `cli/e2e/nodeReferences.e2e.ts:26, 57` (and
  `cli/src/lib/engineBin.spec.ts:142`, Linux only). The spec names `placeNode`'s three callers; the final report
  names these two as a possible follow-up.
- A `cli-harnessd` path for `cli/src/testing/placeNode*` in `scripts/local-checks.py`: not asked.

## Verification

All on the final head, after the review, on the reporting Mac (Apple Silicon): the subject is that Mac's Node, and no
workflow in the repo runs an x86_64 Node on Apple Silicon. Nothing needs an account, a sign-in, a backend, a device or
Diego himself, and nothing touches production. The specs run in Vitest's own throwaway folders (`cli/vitest.setup.ts`,
`cli/vitest.tmpdir.ts`) and start only stand-in cores from them; nothing of the developer's daemon (port 18473),
`~/.harness`, `~/.claude` or `~/.codex` is read. Checks 1 to 3 run with the arm64 Node first on `PATH` (Global
Constraints); check 4 names the x86_64 Node by its path.

1. **The receipt run, once.** From the repository root, on a clean tree at the final commit. The script refuses a
   tree with untracked files, so it runs once the two documents under `docs/plans/` are committed.

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see, for this plan's two files: `No local check is required.` on stderr, nothing on stdout, exit 0. There is
   then no fence to paste. If the final diff also holds a file under `cli/src/harnessd/` (a review fix), it runs
   `npm run test:harnessd` itself and prints one `harness-local-checks` fence with `"check": "cli-harnessd"` and
   `"status": "passed"`: paste the fence into the pull request body, and check 2 is done by it.

2. **The harnessd gate, once, by hand.** The check that had no receipt on this Mac; PR CI does not run it.

   ```bash
   cd cli && npm run test:harnessd
   ```

   To see: `Test Files  10 passed (10)`, `Tests  367 passed | 1 skipped (368)`, exit 0, in about 25 s. Exit 0 also
   means 100% in every file of `src/harnessd/`: a file below it prints `ERROR: Coverage for …` and exits 1. Put the
   command, the two lines and the Node (`v22.21.1`, `arm64`) in the pull request body as plain text, never as a
   fence written by hand.

3. **`master.spec.ts`, five times.** About two minutes.

   ```bash
   cd cli && for run in 1 2 3 4 5; do npx vitest run src/harnessd/master.spec.ts || { echo "run $run failed"; break; }; done
   ```

   To see: five summaries, each `Test Files  1 passed (1)` and `Tests  60 passed (60)`, about 25 s each, and no
   `run N failed` line. One failure in five is not a pass, whatever its cause: report the run, the test's name and
   its error, and stop.

4. **The refusal on the real x86_64 Node.** Under a second. It writes only into a `mktemp -d` folder, and there it
   should write nothing.

   ```bash
   cd cli && dir=$(mktemp -d) && /usr/bin/time -p ~/.nvm/versions/node/v22.21.1/bin/node --input-type=module -e '
   import { readdirSync } from "node:fs"
   import { join } from "node:path"
   import { placeNode } from "./src/testing/placeNode.ts"
   const dir = process.argv[1]
   console.log(process.arch, process.version)
   try { placeNode(join(dir, "node"), [join(dir, "libexec")]); console.log("copied") } catch (error) { console.log(String(error)) }
   console.log("left behind:", JSON.stringify(readdirSync(dir)))
   ' "$dir"; rm -rf "$dir"
   ```

   To see: `x64 v22.21.1`; then
   `RosettaNodeError: This Node is an x86_64 build, so Rosetta runs it and translates it again at each new path, about 15 s for every copy or link a test starts. Run the tests with an arm64 Node.`;
   then `left behind: []`; `real` under 1 s (0.31 s in the rehearsal). The same command with the arm64 `node`
   prints `arm64 v22.21.1`, `copied` and `left behind: ["libexec","node"]`. If that nvm Node is gone, any x86_64
   Node from 22.18 on does (`file <node>` says `x86_64`); with none on this Mac, report the check as unverified,
   never as passed.

Not checked, and said so in the pull request: an Intel Mac (no such machine at hand; the spec's Intel row stands in
for it).

On GitHub nothing is started by hand. PR CI runs by itself what a `cli/` change selects: `cli-typecheck` and
`cli-tests` (Linux), where the five new cases run with the machines they name and the two old cases read the
runner's own.

**Temporary workflow:** none. No check is long (the longest is two minutes), and all four are about this Mac's Node.

**Checks PR CI does not run:** none required: `scripts/local-checks.py --list` on the two files prints `{}`.
`npm run test:harnessd` runs anyway (check 2), because this change exists to make that gate green on this Mac.
`npm run test:core` does not apply: nothing under `cli/src/core/` or `cli/src/services/` changes.
