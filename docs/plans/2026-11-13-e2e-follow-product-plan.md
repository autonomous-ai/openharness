# Two end-to-end tests follow intended product changes: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Two independent tasks, one commit each (see
> "Red and green" for why neither has a separate red commit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two end-to-end tests that still expect behavior the product changed on purpose (#4078, #4074) test the
behavior the product has now, so the nightly `CLI end to end` run stops failing for these two causes.

**Architecture:** Test changes only, one file each. The Swarm journey's last step deletes a builder the way Desktop
does (stop the session through its computer's daemon, then `agent.remove`). The channel test posts a signed message
and expects it stored unsigned, its words whole.

**Tech Stack:** TypeScript, Vitest (`cli/vitest.e2e.config.ts`), the CLI's end-to-end rigs (`cli/e2e/harness/`). No
new dependency.

**Spec:** [docs/plans/2026-11-13-e2e-follow-product-design.md](2026-11-13-e2e-follow-product-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- Only two files change: `cli/e2e/swarmV4Journey.e2e.ts` (two imports and its last step) and
  `cli/e2e/superTabChannel.e2e.ts` (lines 155-165). No product code, nothing under `cli/e2e/harness/`, no workflow,
  no other doc.
- Both product changes are intended (#4078: `agent.remove` keeps the session; #4074: the daemon drops an agent's own
  name and time from the start of its post). Neither test works around them.
- D deletes as Desktop does: `agent_close` with mode `idle`, then `agent.remove`. Not `agent.release` with `stop`. No
  assertion that the session survives `agent.remove`.
- E: the 32,000-character and over-length cases do not change.
- No fixed sleeps. Every wait is the bounded `until` of `cli/e2e/harness/daemon.ts:204`.
- Tests never touch the developer's own daemon (port 18473), tmux server, `~/.harness`, `~/.claude` or `~/.codex`,
  and never production: the rigs below are the only backends.
- The `CLI end to end` workflow is started once, by hand, and only after the orchestrator's go (shared runners).
- Platforms: none of the product's. The tests run on Linux (the workflow's shards) and on macOS (locally).

## Found while reading the code

Checked at `4961894fbc` on the Mac, 2026-11-13. Every local run below was made for this plan.

- **E is red at base, locally.** `superTabChannel.e2e.ts` fails at `e2e/superTabChannel.e2e.ts:159:46`
  (`expect(f.stored.get('post-unicode')!.text).toBe(words)`): expected `Pip: ✅ shipped …`, received `✅ shipped …`.
  The spec's "line 156" is the `words` constant; the assertion is line 159. The stdin assertion (line 165) is never
  reached at base.
- **D is red at base, locally and in the nightly.** On the local real-backend rig: `Tests  1 failed | 9 passed (10)`,
  `Error: timed out after 120000ms waiting for Pip's session to stop on its computer` at
  `e2e/swarmV4Journey.e2e.ts:320:5`, 205 s. Nightly run 43247147594 (main at `ad613a9f0d`): job `e2e (4)` fails the
  same step at the same line; job `e2e (6)` fails E at `:159:46`.
- **Both planned changes pass here.** Throwaway copies of the two files with the code of Tasks 1 and 2, run and then
  deleted: the journey `Tests  10 passed (10)` in 79 s, the channel file `Tests  2 passed (2)` in 20 s.
- **The real-backend rig runs on this Mac.** It needed one thing this checkout lacked: `backend/node_modules`
  (`npm ci` in `backend/`, 5 s; its postinstall runs `prisma generate`). It is installed now and is git-ignored.
  Already here: `cli/node_modules`, `~/test-services` (mongodb-memory-server 11.2.0, redis-memory-server 0.17.1),
  `/usr/local/bin/redis-server` (8.0.1), tmux 3.8, Node v23.11.0 (the CLI needs 22.15 or later; CI pins 24.22.2).
- **MongoDB is downloaded on every run unless `HARNESS_E2E_MONGOD` names a binary.** The suite runs under a throwaway
  `HOME` (`cli/vitest.setup.ts`), so mongodb-memory-server never finds its cache and fetches MongoDB 8.2.6 (76.6 MB).
  `~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6` exists on this Mac; with it named, nothing is downloaded.
- **`agent_close` with `idle`** (`cli/src/lib/closeAgentService.ts`): answers `{ closed: true }` for a session that
  reads idle, `{ error: 'SESSION_NOT_IDLE', activity }` otherwise. The request names the session by `agentId`,
  `sessionId` and `createdAt` of its `agents_list` row; a mismatch answers `AGENT_CHANGED`.
- **Pip stays on the roster after its session stops.** A session added to an agent's own chat is a Regular agent
  (`backend/src/superTabs/commands.ts:1520`), which a machine's report never removes
  (`closedAgents.ts` `removable`), so the `agent.remove` that follows is answered 200. A person's `agent.remove`
  takes it out of `state.agents` (`commands.ts:815`).
- **The roster read.** The journey has no roster read today. `cli/e2e/swarmAttachChat.e2e.ts:37, 141` reads one as
  Desktop does: `GET /api/super-tabs/:tabId/parts`, then `reassemble(storeOf({ ...data, tabId }))`, and waits for the
  removed agent to leave `agents`. Task 2 does the same through the journey's own `api`.
- **What the daemon strips** (`cli/src/superTabs/signature.ts` `unsigned`): only the poster's own name at the start,
  then it trims the start of what is left. `said` therefore opens with a visible character. Another agent's name stays:
  Pip's `'Juno, 14:05: free: Pip'` (lines 137-141) is stored as written, and does not change.
- **Nothing type-checks `cli/e2e/`.** `npm run typecheck` covers `src/` only: keep the `Record<string, any>` shapes
  the two files already use.

## Red and green

Each failing test is already on main and is the file its task changes, so there is nothing to commit before the
change: a task is one commit. The proof is the same command run twice: before the task's edit (red, with the `HEAD` it
ran on) and on the tree the task commits (green, with that commit). Both outputs go in the pull request body, beside
the nightly's red (run 43247147594: job `e2e (6)` for E, job `e2e (4)` for D) and the Linux green (the run link and
the two lines of Verification check 3). The pull request names no product platform: tests only, run on macOS and
Linux.

The two tasks share no file and neither uses anything of the other, so they run at the same time. In one checkout the
other task's file may show as modified: each task stages its own file only.

## Review Focus

Each line names what pins it: an assertion in the changed step, or a test that already exists.

- **Pip is working when its person deletes it.** The close answers `SESSION_NOT_IDLE` and Desktop asks the person. The
  journey never makes Pip busy; `cli/e2e/ends.e2e.ts` ("closed only when idle, a working agent is left working and
  says so") pins the refusal. In Task 2 the answer is in the assertion's message, so it fails with the activity named,
  not as a timeout.
- **A roster read that returns nothing.** "Pip is not on it" would pass on an empty or unread roster. Task 2 asserts
  Faye is on the same read; a parts read that is not a 200 throws inside `storeOf`, and `until` reports it as its last
  error.
- **The backend removes Pip by itself once its session stops**, and `agent.remove` then answers 404. It does not for
  a Regular agent: `backend/src/superTabs/regularAssign.test.ts` (task #4218). The journey's `command` asserts 200
  with the body in its message.
- **`agent.remove` keeps the session.** Not asserted end to end, by decision (no positive signal to wait for). Pinned
  in `backend/src/superTabs/commands.test.ts` and `backend/integration/superTabs.test.ts`.
- **A start the daemon must keep.** Another agent's name and time, and a post with no signature, arrive whole: lines
  135-141 and the 32,000 x's of this same test, unchanged; the full table is `cli/src/superTabs/signature.spec.ts`.

---

### Task 1 (E): an agent's signed post is stored unsigned, its words whole

**Depends on:** nothing. **Effort:** medium (mechanical, one file).

**Files:**
- Modify: `cli/e2e/superTabChannel.e2e.ts:155-165`
- Test that must fail before the change: this file's "stores an agent's post in its channel once, from its own pane,
  whatever it says and however many Swarms it is in", at base. Its name does not change.

- [ ] **Step 1: Run the file at base and keep the red output**

Before any edit of this file (`git status --short cli/e2e/superTabChannel.e2e.ts` prints nothing):

```bash
cd cli && git rev-parse HEAD && npx vitest run --config vitest.e2e.config.ts e2e/superTabChannel.e2e.ts
```

Expected (about 20 s): `Tests  1 failed | 1 passed (2)`, an `AssertionError` at `e2e/superTabChannel.e2e.ts:159:46`
with `- Pip: ✅ shipped …` expected and `+ ✅ shipped …` received. A failure anywhere else is another cause: stop and
report it.

- [ ] **Step 2: Replace lines 155-165**

`words` becomes `said`, the words without a signature; Pip posts `Pip: ${said}` by argv and on stdin, and both are
stored as `said`. The three `full` lines stay as they are.

```ts
  // What it says arrives as it said it, without the name it signed with (#4074, src/superTabs/signature.ts: its channel shows
  // who wrote a post): unicode, quotes, shell characters and newlines; a post of 32,000 characters whole.
  const said = '✅ shipped 👨‍👩‍👧‍👦 🇻🇳 שלום مرحبا 日本語 é "double" \'single\' $(not run) `ticks` \\ back\nand a second line\n\n    indented'
  const unicode = await f.run(pip, ['post', CHANNEL, `Pip: ${said}`, 'post-unicode'])
  expect(unicode.code, JSON.stringify(unicode.answer)).toBe(0)
  expect(f.stored.get('post-unicode')!.text).toBe(said)
  const full = 'x'.repeat(32_000)
  expect((await f.run(pip, ['post', CHANNEL, full, 'post-full'])).code).toBe(0)
  expect(f.stored.get('post-full')!.text).toBe(full)
  // The message on stdin with `-`, which no shell quoting can split.
  expect((await f.run(pip, ['post', CHANNEL, '-', 'post-stdin'], `Pip: ${said}\n`)).code).toBe(0)
  expect(f.stored.get('post-stdin')!.text).toBe(said)
```

`said` is the old string with its leading `Pip: ` taken off, character for character: copy it from line 156, do not
retype it.

- [ ] **Step 3: Run the file again and keep the green output**

The command of Step 1. Expected: `Tests  2 passed (2)`.

- [ ] **Step 4: Check the diff, then commit**

`git diff -- cli/e2e/superTabChannel.e2e.ts` changes lines 155-165 and nothing else. Stage this file only.

```bash
git add cli/e2e/superTabChannel.e2e.ts
git commit -m "e2e: an agent's signed post is stored without its name, its words whole (#4074)"
```

Report the commit, and for the pull request the red output (Step 1) with the `HEAD` it ran on and the green output
(Step 3) with this commit.

---

### Task 2 (D): the journey deletes a builder as its person's Desktop does

**Depends on:** nothing. **Effort:** high (the real-backend rig, a flow in four parts).

**Files:**
- Modify: `cli/e2e/swarmV4Journey.e2e.ts` (imports after line 14; the last step, lines 314-324)
- Test that must fail before the change: this file's last step, "its person deletes a builder: the Swarm lets go of
  it, and its computer stops its session", at base. The task renames it.

- [ ] **Step 1: Run the journey at base on the real-backend rig and keep the red output**

Once per checkout: `(cd cli && npm ci --no-audit --no-fund)` and `(cd backend && npm ci --no-audit --no-fund)` when
either `node_modules` is missing. Then, before any edit of this file:

```bash
cd cli && git rev-parse HEAD && \
HARNESS_E2E_SERVICES_DIR="$HOME/test-services" \
HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6" \
npx vitest run --config vitest.e2e.config.ts e2e/swarmV4Journey.e2e.ts
```

Expected (about 3.5 minutes, two of them the wait that times out): `Tests  1 failed | 9 passed (10)`,
`Error: timed out after 120000ms waiting for Pip's session to stop on its computer`, at
`e2e/swarmV4Journey.e2e.ts:320:5`.

`10 skipped` is not a pass: the file skips without `HARNESS_E2E_SERVICES_DIR` (`describe.skipIf`, line 48). On
another machine that folder is made as `.github/workflows/cli-e2e.yml` lines 98-100 make it, and without
`HARNESS_E2E_MONGOD` MongoDB is downloaded each run. If an earlier step fails, the delete step is skipped and this
machine cannot show D red or green: stop and report the step and its error; the nightly run and Verification check 3
are then the only evidence.

- [ ] **Step 2: Add the two imports after line 14 (`superTabCommand`)**

```ts
import { storeOf } from '../src/superTabs/partsStore.js'
import { reassemble } from '../src/superTabs/reassemble.js'
```

- [ ] **Step 3: Replace the last step (lines 314-324) with this one**

```ts
  it('its person deletes a builder: its computer stops its session, then the Swarm lets go of it', async context => {
    step(context)
    const rows = async () => (await A.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
    const active = async (name: 'Pip' | 'Faye') => (await rows()).some(a => a.id === agents[name]!.harnessId && a.status === 'active')
    expect(await active('Pip')).toBe(true)
    // As Desktop's Remove does when Your Team is the session's last place (desktop/lib/super_tabs/remove_agent.dart): the quiet
    // close of a pane's last view, then the removal, which stops nothing on the computer (#4078). Pip answered and waits, so
    // the close is not refused as a working session's is.
    const pip = (await rows()).find(a => a.id === agents.Pip.harnessId)!
    const closed = await A.client.request('agent_close', { agentId: pip.id, sessionId: pip.sessionId, createdAt: pip.createdAt, mode: 'idle' }, 60_000)
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true })
    await until('Pip\'s session to stop on its computer', async () => (await active('Pip')) ? null : true, 120_000, 1_000)
    await command({ type: 'agent.remove', agentId: agents.Pip.id })
    // The roster as Desktop reads it, by parts (client.dart readSnapshot). The PM still on it says the read was a real one.
    const roster = await until('Pip to leave the Swarm\'s roster', async () => {
      const swarm = reassemble(storeOf({ ...(await api(`/api/super-tabs/${tab}/parts`)).body.data, tabId: tab })) as Record<string, any>
      const ids = (swarm.agents as Array<Record<string, any>>).map(a => a.id as string)
      return ids.includes(agents.Pip.id) ? null : ids
    }, 30_000, 500)
    expect(roster).toContain(agents.Faye.id)
    // Faye, on the same computer, runs on.
    expect(await active('Faye')).toBe(true)
  }, 300_000)
```

The wait for Pip's session is the existing one, kept with its label and bounds. Nothing else in the file changes.

- [ ] **Step 4: Run the journey again and keep the green output**

The command of Step 1. Expected (about 80 s): `Tests  10 passed (10)`.

If the close answers anything but `{ closed: true }` (the assertion prints the answer), stop and report it with the
"computer A" log the step prints. Do not add a retry or a sleep, and do not change the mode to `now`: the spec's flow
is the idle close.

- [ ] **Step 5: Check the diff, then commit**

`git diff -- cli/e2e/swarmV4Journey.e2e.ts` adds the two imports, replaces the last step and changes nothing else.
Stage this file only.

```bash
git add cli/e2e/swarmV4Journey.e2e.ts
git commit -m "e2e: the journey deletes a builder as Desktop does: its session stops, then the Swarm lets go of it (#4078)"
```

Report the commit, and for the pull request the red output (Step 1) with the `HEAD` it ran on, the green output
(Step 4) with this commit, and the machine (macOS).

---

## Verification

All checks run on the final head. Nothing is built: Vitest runs the specs and the daemon from source. No check needs
a person's own login or eye, a real account, a device or production.

How the rigs isolate (the repo's own rules, `cli/AGENTS.md` rules 5 and 6, as `cli/e2e/harness/daemon.ts` and
`realBackend.ts` apply them):

- **Daemons:** the real daemon from this checkout, each under its own throwaway root with its own data folder, free
  port, private tmux server and fake Claude Code and Codex engines. The suite's `HOME` is a throwaway folder.
- **Backend, check 1:** `FakeBackend`, a loopback server inside the test. No account.
- **Backend, checks 2 and 3:** `backend/src/server.ts` from this checkout, started by the rig with `NODE_ENV=test` on
  free loopback ports, on a MongoDB replica set and a Redis that live in memory for the run, with a loopback stand-in
  for sign-in. Billing and mesh are off.
- **Accounts:** the fixture `account('owner')` (`owner@spike.invalid`, a random token), made for the run.
- **GitHub:** never reached. The journey's repository is a bare folder behind git's `insteadOf`.
- **Cleanup:** `afterAll` stops the daemons, the backend, MongoDB and Redis; the worker's reaper ends them if the run
  is killed.

1. **E, on the Mac, fake backend.** From `cli/`:
   `npx vitest run --config vitest.e2e.config.ts e2e/superTabChannel.e2e.ts`. A person sees `Tests  2 passed (2)` in
   about 20 s. On GitHub it runs in check 3.
2. **D, on the Mac, the local real-backend rig.** The command of Task 2, Step 1, with its three variables. A person
   sees `Tests  10 passed (10)` in about 80 s, and no `skipped`. The rig ran on this Mac on 2026-11-13 with what
   "Found while reading the code" lists; a fresh checkout needs `npm ci` in `cli/` and in `backend/` first. On GitHub
   it runs in check 3.
3. **Both, on Linux: the `CLI end to end` workflow on the branch.** Only after the orchestrator's go, once, and never
   beside another heavy workflow: the run holds nine runners (eight Linux shards and one macOS job) of the account's
   twenty. Start it by hand:

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-follow-product
   gh run list --workflow cli-e2e.yml --branch fix/e2e-follow-product --limit 1 --json databaseId,status,url
   ```

   When it ends (each shard has 45 minutes at most), read it by file, not by its conclusion: the run can still end
   red for the nightly's other six causes, which this branch does not fix.

   ```bash
   out=$(mktemp -d) && gh run download <run id> --pattern 'cli-e2e-shard-*' --dir "$out"
   jq -r '.testResults[] | select(.name | test("swarmV4Journey|superTabChannel"))
     | "\(.status) \(.name | sub(".*/cli/"; "")) passed=\([.assertionResults[] | select(.status == "passed")] | length) of \(.assertionResults | length)"' \
     "$out"/*/result-*.json
   ```

   A person sees exactly:

   ```
   passed e2e/swarmV4Journey.e2e.ts passed=10 of 10
   passed e2e/superTabChannel.e2e.ts passed=2 of 2
   ```

   The same two commands on run 43247147594 print `failed … passed=9 of 10` and `failed … passed=1 of 2`: the red.
   Put the run link and the two lines in the pull request. A failure in another file is not this branch's: report
   the file, start no second run.
4. **What runs by itself, and what does not.** PR CI runs `cli-typecheck` and `cli-tests` for the `cli/` change;
   neither reads `cli/e2e/*.e2e.ts`. No local check is required:
   `python3 scripts/local-checks.py --list cli/e2e/swarmV4Journey.e2e.ts cli/e2e/superTabChannel.e2e.ts` prints `{}`,
   so the pull request carries no `harness-local-checks` fence. No temporary workflow: the `CLI end to end` workflow
   already runs both files, nightly and by hand.
