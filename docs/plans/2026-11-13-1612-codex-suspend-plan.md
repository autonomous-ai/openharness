# Codex Ctrl+Z under bash 5.3, proved from the engine (#1612): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Two tasks, three commits: the temporary
> workflow, then the red test, then the fake engine that turns it green. Steps use checkbox (`- [ ]`) syntax for
> tracking. Tasks commit and never push: a push starts the temporary workflow, and that starts only on the
> orchestrator's go (Verification).

**Goal:** The Ctrl+Z cases of `cli/e2e/suspend.e2e.ts` prove the stop and the launch script's continue from the fake
engine's own record, so Codex under bash 5.3 passes on the Linux runner with the same 15 s deadline.

**Architecture:** A test-layer fix. The fake engine appends `stopped <pid>` before it stops its process group and
`continued <pid>` from the one-time SIGCONT handler that stop arms, in `suspends` under the test's root. The test
waits for exactly that pair, from this pane's engine, in place of the shell's notice in the pane's output.

**Tech Stack:** TypeScript and Vitest 4 (`cli/e2e`), the fake engine (plain Node, `fakeEngine.mjs`), tmux, GitHub
Actions for one temporary workflow. No new dependency.

**Spec:** [docs/plans/2026-11-13-1612-codex-suspend-design.md](2026-11-13-1612-codex-suspend-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- No product change: nothing under `cli/src/` changes. `STOP_PROOF_FUNCTIONS` (`cli/src/lib/engineLaunch.ts`) stays
  as it is, and the launch goldens with it.
- No skip, no retry, no longer deadline: the wait stays `15_000` ms, polled every `100` ms.
- The Ctrl+Z proof never reads the process state `T` (the stop lasts about 5 ms).
- The pane capture (`pipe-pane`) and the Claude Code message check stay. Every later step of the test is unchanged.
- The failure dumps that run after `afterEach` ("tmux socket missing") are out of scope.
- The workflow is temporary: push to `fix/1612-codex-suspend` only, `permissions: contents: read`, no secrets, nothing
  written outside its run. Phase 4 removes it in its own commit before the pull request opens.
- Stage only the files a task names. Comments say why, in plain sentences, and name #1612.
- Platforms: macOS and Linux, where the suite runs. Windows has none of the three shells, so the file has no case
  there.

## Found while reading the code

Checked at `4961894fbc` (the branch's base):

- **The failing wait** is `cli/e2e/suspend.e2e.ts:126`; its step comment is lines 119-121 and the file header lines
  1-15. Only this file types Ctrl+Z into a fake engine (`grep -rln "C-z" cli/e2e`).
- **`until`** (`cli/e2e/harness/daemon.ts:204`) catches a probe that throws and puts the last error in its timeout
  message, so an `expect` inside the probe shows what was recorded when the wait times out.
- **The fake's stop** is `suspend()` (`cli/e2e/harness/fakeEngine.mjs:1708-1717`), inside `run()`, where `config` is
  in scope; `appendFileSync` and `join` are imported (lines 73, 75). Notes under `config.root`: lines 201 and 206;
  the form that never fails the engine: line 294. The standing `process.on('SIGCONT', () => draw())` (line 1721)
  fires on every continue; the one-time handler only on a Ctrl+Z's.
- **Codex's `suspend()` runs below npm's wrapper** (`codexWrapper`, line 118): `process.pid` there is not the pane's
  job, which the test calls `pid`. `enginePid(d, root, engine, true)` (`suspend.e2e.ts:62`) finds it, as the kill
  cases do (line 167). For Claude Code the shim is the engine, so it is `pid`.
- **Each case has its own root:** `IsolatedDaemon.create` hands the fake `root` (`daemon.ts:246, 267`), which is
  `d.root`, so `join(d.root, 'suspends')` is that case's file and starts absent.
- **The runner:** nightly run 43247147594, shard 3: `Image: ubuntu-26.04` (20261101.186.1), tmux 3.6;
  `suspend.e2e.ts (12 tests | 1 failed)` in 122 s, the failure at line 126.
- **A push to this branch starts nothing else:** no workflow has a `push` trigger that matches it, and `ci.yml` runs on
  pull requests. The branch is not on the remote yet.
- **actionlint 1.7.12** (CI's pin, and `/opt/homebrew/bin/actionlint`) does not know the label `ubuntu-26.04`. CI
  lints a fixed list of workflows, never this one; locally the finding is ignored by name (Task 1).
- **Locally:** this worktree has no `cli/node_modules`. Node 23.11.0 meets `engines` (`>=22.15.0`); tmux is 3.8,
  `/bin/bash` 3.2.57. `python3 scripts/local-checks.py --list` prints `{}` for the two `cli/e2e` files: no receipt.

## Red and green

One task carries the pair, in two files. The red commit changes only `cli/e2e/suspend.e2e.ts`: the six Ctrl+Z cases
fail on any machine, because no engine writes the record yet. The green commit changes only
`cli/e2e/harness/fakeEngine.mjs`. The temporary workflow is committed before both, so either commit can be pushed
and run on the Linux runner.

## Review Focus

No test beyond the twelve cases is added (the spec keeps every other step). Each line names the case that pins it,
or what to check by eye.

- An engine with no test root, or whose root is gone or unwritable, still suspends: the note is skipped or
  swallowed, never thrown before the SIGTSTP. By eye: `noteSuspend` returns on no `config.root` and catches the write.
- A continue no Ctrl+Z asked for (the test's SIGSTOP, a debugger) notes nothing: only the one-time handler armed in
  `suspend()` writes `continued`, the standing SIGCONT handler does not. By eye.
- Codex's record carries the pid of the engine below npm's wrapper: pinned by the three Codex Ctrl+Z cases, which
  compare with `enginePid(…, true)`.
- A stale or foreign record cannot satisfy the wait: the file is the case's own and is compared whole, pid
  included. Pinned by the `toEqual` in all six Ctrl+Z cases.
- Ctrl+Z inside a paste is pasted text and notes nothing: the guard (`fakeEngine.mjs:1724`) is above `suspend()` and
  unchanged. By eye.

---

### Task 1: The temporary Linux workflow

**Depends on:** nothing. **Effort:** medium (mechanical, one file). **Red test:** none: it changes no behavior and is
one commit. Temporary: phase 4 removes it before the pull request opens.

**Files:**
- Create: `.github/workflows/tmp-1612-codex-suspend.yml`

- [ ] **Step 1: Create the workflow with exactly this content**

It sets a runner up as the `e2e` job of `.github/workflows/cli-e2e.yml` does (lines 43-89), pinned to the image by
name. Left out: the npm cache (its save would write outside the run), the real backend's step (this file never
starts it), the inventory and the artifact uploads. Added: the step that prints the bash and tmux versions.

```yaml
name: tmp 1612 codex suspend

# TEMPORARY, for #1612 only: removed before the pull request opens. Runs cli/e2e/suspend.e2e.ts alone on
# the image the CLI end-to-end shards run on (their ubuntu-latest is ubuntu-26.04: bash 5.3, tmux 3.6),
# set up as cli-e2e.yml's e2e job sets a runner up. That workflow's Run workflow has no single-file
# input and holds nine runners; this holds one for a few minutes.
on:
  push:
    branches: [fix/1612-codex-suspend]

permissions:
  contents: read

# cli-e2e.yml's pin.
env:
  CLI_NODE_VERSION: 24.22.2

jobs:
  suspend:
    name: suspend.e2e.ts (ubuntu-26.04)
    # Pinned, not ubuntu-latest: the evidence is for bash 5.3, whatever latest comes to mean.
    runs-on: ubuntu-26.04
    timeout-minutes: 20
    defaults:
      run:
        working-directory: cli
    env:
      # As the shards: tmux and procps need a UTF-8 locale, and the daemons launch engines through zsh.
      LANG: C.UTF-8
      SHELL: /bin/zsh
    steps:
      - uses: actions/checkout@v7
      # Without setup-node's npm cache, whose save would write outside this run.
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ env.CLI_NODE_VERSION }}
      # cli-e2e.yml's step, whose comments say why each line is there.
      - name: Install tmux, the shells the tests launch through, and lsof
        run: |
          sudo bash ../scripts/apt-install.sh tmux zsh tcsh dash lsof
          sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288
          tmux -V && zsh --version && tcsh --version && command -v dash
          insecure=$(zsh -fc 'autoload -U compaudit && compaudit' 2>/dev/null | grep '^/' | sort -u || true)
          if [ -n "$insecure" ]; then
            echo "$insecure" | xargs sudo chown root:root
            echo "$insecure" | xargs sudo chmod g-w,o-w
          fi
          zsh -fc 'autoload -U compaudit && compaudit'
      - name: The bash and tmux under test
        run: |
          { /bin/bash --version | head -n 1; tmux -V; } | tee -a "$GITHUB_STEP_SUMMARY"
      - run: npm ci --no-audit --no-fund
      # The real backend's step is left out: this file never starts it.
      - name: Run suspend.e2e.ts
        env:
          E2E_BUNDLE: '1'
        run: npx vitest run --config vitest.e2e.ci.config.ts e2e/suspend.e2e.ts --reporter=verbose
```

- [ ] **Step 2: Lint it**

From the repository root:

```bash
actionlint -ignore 'label "ubuntu-26.04" is unknown' .github/workflows/tmp-1612-codex-suspend.yml
```

Expected: no output, exit 0. The ignored finding is actionlint 1.7.12's label table, which predates the image.

- [ ] **Step 3: Check what it may not have**

```bash
grep -nE 'secrets\.|pull_request|workflow_dispatch|schedule:|upload-artifact|cache:|id-token|contents: write' .github/workflows/tmp-1612-codex-suspend.yml
```

Expected: no output (exit 1).

- [ ] **Step 4: Commit, and do not push**

```bash
git add .github/workflows/tmp-1612-codex-suspend.yml
git commit -m "CI: a temporary workflow runs suspend.e2e.ts alone on ubuntu-26.04 (#1612)"
```

Report the commit.

---

### Task 2: The engine records its stop and its continue, and the test waits for the record

**Depends on:** Task 1, for the commit order only: the red commit must already carry the workflow, so that it can
be pushed and run on the runner. **Effort:** high.

**Files:**
- Modify (red commit): `cli/e2e/suspend.e2e.ts` (header 1-15; a helper after `processState`, line 80; the Ctrl+Z
  step, lines 119-127)
- Modify (green commit): `cli/e2e/harness/fakeEngine.mjs` (the Ctrl+Z paragraph of the header, lines 64-67;
  `suspend()` and its comment, lines 1704-1717)
- Test that must fail before the change: the six cases
  `<engine> under <shell>: Ctrl+Z and a SIGSTOP leave the agent there and working, and its own exit still ends it`

**Interfaces:**
- Produces (the fake): the file `suspends` under `config.root`, one line per event, each ending in `\n`:
  `stopped <pid>` then `continued <pid>`, where `<pid>` is `process.pid` of the process that ran `suspend()`.
- Consumes (the test): that file at `join(d.root, 'suspends')`.

- [ ] **Step 1: Install once**

`cli/node_modules` is absent in this worktree: in `cli/`, run `npm ci --no-audit --no-fund`.

- [ ] **Step 2: Write the failing test in `cli/e2e/suspend.e2e.ts`**

Add this paragraph to the header, between its two paragraphs:

```ts
 * The Ctrl+Z is proved by the fake engine's own note (fakeEngine.mjs `suspend`): `stopped` before it stops
 * its process group, `continued` when a SIGCONT brings it back from that stop, and only the launch script's
 * `fg` sends that SIGCONT, as tmux continues the pane's own process alone. Not by the shell's "Stopped"
 * notice: bash 5.3 holds it back until its next prompt, which an agent's pane never reaches, and Codex
 * prints nothing of its own, so Codex under bash 5.3 timed out here on the Linux runner while its engine
 * had stopped and been continued (#1612).
```

Add the reader after `processState`:

```ts
/** What the fake engine noted of its Ctrl+Z (fakeEngine.mjs `suspend`), a line each: `stopped <pid>` before
 *  it stops its process group, `continued <pid>` once a SIGCONT has brought it back from that stop. */
const suspends = (d: IsolatedDaemon): string[] => {
  try { return readFileSync(join(d.root, 'suspends'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
```

Replace the Ctrl+Z step (the comment at lines 119-121 through the `until` at line 126; lines 127-128 stay):

```ts
      // Ctrl+Z, typed into the pane. The engine gives the terminal back and stops itself, and the launch
      // script continues it within milliseconds: too short a stop to catch in the process table, and the
      // shell's notice of it is no proof (bash 5.3 holds it back, #1612). The engine's own note is: it
      // stopped, then was continued, and it is this pane's engine, for Codex the one below npm's wrapper,
      // which reads the key. The comparison throws until it holds, so a timeout says what was noted.
      const self = await until(`the ${engine} engine itself`, () => enginePid(d, root, engine, engine === 'codex'), 10_000, 200)
      // Claude Code says it is suspended. Read from everything the pane writes from here on, not its
      // screen: the engine repaints its composer over that line the moment it is back.
      const written = join(d.root, `pane-${engine}.out`)
      await d.tmux.run('pipe-pane', '-t', pane, '-o', `cat >> '${written}'`)
      const output = () => { try { return readFileSync(written, 'utf8') } catch { return '' } }
      await d.tmux.run('send-keys', '-t', pane, 'C-z')
      await until('the engine to stop itself and the launch script to continue it', () => {
        expect(suspends(d)).toEqual([`stopped ${self}`, `continued ${self}`])
        return true
      }, 15_000, 100)
```

No import changes. Nothing else in the file changes.

- [ ] **Step 3: Run it and keep the red output**

In `cli/`:

```bash
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/suspend.e2e.ts
```

Expected (a few minutes): `Tests  6 failed | 6 passed (12)`. Each Ctrl+Z case fails at the new wait, with a message
of this shape: `timed out after 15000ms waiting for the engine to stop itself and the launch script to continue it
(last error: AssertionError: expected [] to deeply equal [ 'stopped <pid>', 'continued <pid>' ])`. The six `dies of`
cases pass. A failure anywhere else, or fewer than 12 cases, is not this red: stop and report it.

- [ ] **Step 4: Commit the red test**

```bash
git add cli/e2e/suspend.e2e.ts
git commit -m "e2e: the Ctrl+Z cases wait for the engine's own record of its stop and its continue (#1612)"
```

- [ ] **Step 5: Make the fake engine write the record, in `cli/e2e/harness/fakeEngine.mjs`**

Beside `suspend`, inside `run()`, add `noteSuspend(what)`, where `what` is `'stopped'` or `'continued'`: it returns
when `config.root` is unset, and otherwise appends `` `${what} ${process.pid}\n` `` to `join(config.root, 'suspends')`
inside `try { … } catch { /* a note, never a failure */ }`, the form of `hookLog` (line 294).

Call it twice in `suspend()`, and change nothing else there:
- `noteSuspend('continued')` as the first statement of the one-time `process.once('SIGCONT', …)` handler;
- `noteSuspend('stopped')` immediately before `process.kill(0, 'SIGTSTP')`, after that handler is armed.

Not in the standing `process.on('SIGCONT', () => draw())`: a continue from a stop the engine did not ask for notes
nothing.

Say why, in two places. End the header's Ctrl+Z paragraph (lines 64-67) with:

```js
// It notes that stop, and the continue that ends it, in `suspends` under the test's root, each with its
// pid: the proof a test has of a Ctrl+Z, as Codex prints nothing and bash 5.3 keeps its "Stopped" notice
// for a prompt an agent's pane never reaches (#1612, suspend.e2e.ts).
```

And end the comment above `suspend` (lines 1704-1707) with:

```js
  // Both are noted for the test: `stopped` before the SIGTSTP, as nothing runs between it and the
  // continue, and `continued` from this stop's own handler alone, which only a `fg` reaches.
```

- [ ] **Step 6: Run the same command and keep the green output**

The command of Step 3. Expected: `Test Files  1 passed (1)` and `Tests  12 passed (12)`, none skipped.

- [ ] **Step 7: Check the diff, then commit the fake**

`git diff --stat` shows `cli/e2e/harness/fakeEngine.mjs` alone, and `git diff 4961894fbc --stat -- cli/src` prints
nothing.

```bash
git add cli/e2e/harness/fakeEngine.mjs
git commit -m "e2e: the fake engine notes its Ctrl+Z stop and the continue that ends it (#1612)"
```

Report the red and the green commit, each with its output from Steps 3 and 6. Do not push.

---

## Verification

Every check boots its own daemons: a throwaway root per case (home, data, auth and runtime folders, a private tmux
server, a free port; `IsolatedDaemon.create`) and fake Claude Code and Codex engines. No backend, no account, no
sign-in, never the machine's own `~/.claude`, `~/.codex`, daemon (port 18473) or tmux server (`cli/AGENTS.md`, rule
6). None needs Ken himself, and none touches production.

1. **The suspend file on macOS** (bash 3.2, zsh, tcsh handing off to dash). On the Mac, in `cli/` at the final
   head: `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/suspend.e2e.ts`. A person sees
   `Test Files  1 passed (1)` and `Tests  12 passed (12)`, none skipped, in a few minutes. Local only: no workflow
   runs this file on macOS (the macOS job of `cli-e2e.yml` runs the full-disk cases alone).
2. **The suspend file on the Linux runner** (`ubuntu-26.04`: bash 5.3, tmux 3.6), by the temporary workflow
   `tmp 1612 codex suspend`, job `suspend.e2e.ts (ubuntu-26.04)`. It has no manual trigger: a push to the branch runs
   it, and only it. Start it only on the orchestrator's go. What it shows at each commit:

   | Pushed commit | Expected on the runner |
   | --- | --- |
   | Task 1 (workflow only) | `1 failed \| 11 passed (12)`: Codex under `/bin/bash`, at the old wait. #1612 as on main. |
   | Task 2 red | `6 failed \| 6 passed (12)`: every Ctrl+Z case, Codex under `/bin/bash` among them, at the new wait. |
   | Task 2 green (the head) | `12 passed (12)`, none skipped. |

   The runs as decided, two of them (open question 1):
   `git push origin <Task 1 commit>:refs/heads/fix/1612-codex-suspend`, then `git push origin fix/1612-codex-suspend`.
   Find them with `gh run list --workflow tmp-1612-codex-suspend.yml --branch fix/1612-codex-suspend`. In each, a
   person sees `Image: ubuntu-26.04` under "Set up job", `GNU bash, version 5.3` and `tmux 3.6` in the step "The bash
   and tmux under test" (and on the run's summary page), and the verbose reporter's line for each of the 12 cases
   with the totals above. Keep both run links for the pull request. A job still waiting for a runner after ten
   minutes means the label is not served: stop and report, change nothing.
3. **After the runs,** phase 4 removes the workflow in its own commit. `git diff <verified head> HEAD --stat -- .github cli`
   then shows only `.github/workflows/tmp-1612-codex-suspend.yml` deleted, so the verified tree under `cli/` is the
   one the pull request carries.
4. **Required local checks.** `python3 scripts/local-checks.py --list cli/e2e/suspend.e2e.ts cli/e2e/harness/fakeEngine.mjs`
   prints `{}`: no receipt, and the pull request body carries no `harness-local-checks` fence. PR CI does not run
   `cli/e2e`, so checks 1 and 2 are the evidence.

Not used: **Actions → CLI end to end → Run workflow**, the repo's by-hand run. It has no single-file input and
holds nine runners for all eight shards. No permanent workflow is proposed: that workflow's nightly run already
runs this file on `ubuntu-latest`, and its first run after the merge is where #1612 shows fixed on main.

## Open questions

None. Question 1, which baseline the runner shows before the head, was decided for the Task 1 commit: its run is
the one that shows #1612 itself (one red of twelve, Codex under `/bin/bash` at the old wait) on this workflow's
runner, which the red commit's six reds would not.
