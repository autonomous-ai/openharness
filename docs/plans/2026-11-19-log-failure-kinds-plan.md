# Daemon failure logs: a kind, never content — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A sweep task's red commit deletes its own pending list, so the guard fails on exactly its hits. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** Every daemon log line that reports a failure names it with a short, stable token (`EACCES`, `TypeError`, `RegistryOwnershipChanged IDENTITY_UNAVAILABLE`) and carries no message, reason, stack or path; a guard test keeps it so.

**Architecture:**
- **One helper, `errorKind(error)`, in `cli/src/lib/log.ts`**, which the core already loads: no new file in the core's process, no second logging path.
- **A guard spec beside the architecture specs** reads `cli/src` as code and fails on a log call that prints an error's words, or that logs from a catch without naming what it caught. It lands with a pending list per sweep task; each sweep task deletes its own; the last task deletes the mechanism.
- **The sweep is fifteen tasks by folder**, no file shared, each red on the guard for its own files. Two more follow them: the end-to-end expectations, and the guard without its lists.

**Tech Stack:** TypeScript (Node 24), vitest, the TypeScript compiler API for the guard (as `architecture.environment.spec.ts` uses it). No new dependency.

**Spec:** `docs/plans/2026-11-19-log-failure-kinds-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core), `cli/src/core/AGENTS.md` and `cli/src/services/AGENTS.md`. Prior art: #4458.

**Answers** (the main session's, to the draft's questions; the plan below follows them and names them "answer N"):

1. **`harness start` reads the daemon's log.** `lib/daemonLaunch.ts` `connectFailure` reads `Unexpected server response: NNN`, TLS and DNS words off the log tail to tell a revoked sign-in (401, 403), a busy machine (409), a wrong backend (404) and a certificate fault, from `[backend] socket error: <message>` (`gateway/upstream.ts:261`). Answer: the line keeps the HTTP status as a number in fixed words, and `connectFailure` learns Node's TLS codes. Editing `lib/daemonLaunch.ts` is in scope (Task 8).
2. **The crash lines** (`[fatal-guard] unhandledRejection`, `[fatal-guard] uncaughtException`, the core's `Failed to start adapter`: `core/main.ts:492, 495, 3428, 3431`). Answer: kind only; the safe-mode marker file keeps the stack on the machine (Task 4).
3. **The end-to-end suite asserts the old text** (about 35 assertions in 13 files of `cli/e2e`). Answer: Task 18 rewrites them, and the repo's **CLI end to end** workflow (`cli-e2e.yml`) runs once by hand on the branch after Tasks 18 and 19: approved (Verification).
4. **Thirteen lines already log a hand-rolled kind** (`error.name`, `.code`, `typeof error`). Answer: they move to `errorKind`, one way of doing it, each in the sweep task that owns its file, marked "by hand (answer 4)": Task 6 (3: `core/transcripts/ingest.ts:97, 123`, `sideReads.ts:24`), Task 10 (1: `cable/noticeFile.ts:142`), Task 11 (1: `cloud/service.ts:233`), Task 12 (2: `services/goals.ts:70, 88`), Task 13 (2: `services/handoffRequest.ts:42`, `swarmLeftovers.ts:34`), Task 17 (4: `lib/attachTranscript.ts:252`, `openrouter.ts:152-154`, `sqliteThread.ts:166`, `terminalAgentReconciler.ts:136`).
5. **A serial port's device name** on `cable/cableFleet.ts:241, 368, 412, 422`. Answer: it stays, the dial's id.
6. **What the guard catches** (a change from the draft). Answer: in this pull request it catches only content read from an error object: `.message`, `.stack`, `String(err)`, `${err}`, a bare caught error, an error handed to a helper such as `describe(error)`, a local derived from one, and a catch that logs a failure with no kind. It does not flag an error's `.reason`, `.detail`, `.stderr`, `.stdout` or `.path`: those belong to the follow-up task (the ~70 stored-string lines), which extends the guard later. Two sweep lines were caught by those fields alone and leave the sweep for Task 20's list: `lib/windows/ptyUpdate.ts:219` (`error.reason`, was Task 15) and `lib/connectors/renew.ts:33` (`error.detail`, was Task 16). Every other line the draft's guard found is still found (a prototype of both rule sets over the base: 369 hits before, 367 after).

**Open questions** (the plan takes the default named; the main session asks it):

1. **A binding-less catch that logs without the word "fail".** Answer 6 lists "a catch with no binding that logs 'failed' with no kind". The plan's rule 4 (below) flags any log call in `catch {` or a handler with no parameter, whatever its words: 37 hits, of which about 17 do not say "fail" (`catch { log('[x] its reader is unavailable') }`, a fixed code such as `LIVE_REATTACH_FAILED` aside). Rule 5 also flags a catch *with* a binding that says "fail" and names nothing it caught (6 hits: `backendSocket.ts:1193`, `core/agentLife.ts:172`, `core/agents/newPane.ts:236`, `lib/registry.ts:1956, 3638`, `lib/restoreAgents.ts:1023`). Default: keep both rules as drafted (the spec's "a catch that logs 'failed' with the error discarded", rule 6: nobody can act on a line with no kind). Narrowing rule 4 to "fail" would drop about 17 lines from Tasks 3 to 17 and leave them for no task. Keep, or narrow?

## Base

- `fix/log-failure-kinds` at `959a54236f`. The spec and this plan are untracked; the main session commits them, no task does.
- Line numbers are the base's. A task follows the expression it names when a line has moved, and says so in its report.
- Nothing is installed in this worktree: `cd cli && npm ci` once. Every command below runs from `cli/`.

## Tasks at a glance

| Task | Files (tests beside them, see each task) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `errorKind` | `src/lib/log.ts`, `lib/log.spec.ts` | none | high | `lib/log.spec.ts`, `errorKind` |
| 2 The guard and its pending lists | `src/architecture.failureLogs.spec.ts`, `src/architecture.failureLogs.pending/*.txt` (new) | none | xhigh | the guard on today's tree, before its lists exist |
| 3 The registry | `lib/registry.ts`, `lib/registryPersistence.ts` | 1, 2 | xhigh | the guard without `registry.txt`; the save lines' tests |
| 4 Core: the files in `core/` | `core/*.ts` (7), `lib/retainExitedSession.ts`, `lib/daemonState.ts` | 1, 2 | xhigh | the guard without `core.txt` |
| 5 Core: agents | `core/agents/*.ts` (12), `lib/sessionSync.ts` | 1, 2 | xhigh | the guard without `core-agents.txt` |
| 6 Core: engines, terminals, transcripts, turns | 11 files under `core/`, 3 lines by hand | 1, 2 | xhigh | the guard without `core-sessions.txt` |
| 7 The socket, the hook door, the entries | `backendSocket.ts`, `hookServer.ts`, `masterProcess.ts`, `serviceProcess.ts`, `cli.ts` (two lines) | 1, 2 | high | the guard without `entries.txt`; `cliCommand.spec.ts` |
| 8 The gateway, and what `harness start` reads | `gateway/*.ts` (6), `lib/daemonLaunch.ts`, `backendSocket.lanes.spec.ts` | 1, 2 | xhigh | the guard without `gateway.txt`; `daemonLaunch.spec.ts`, `upstream.spec.ts` |
| 9 Engines | `engines/**` (24) | 1, 2 | high | the guard without `engines.txt`; `engines/hooks.spec.ts` |
| 10 Dials and devices | `cable/**` (5), `device/*.ts` (2), `services/fleet.spec.ts` | 1, 2 | high | the guard without `devices.txt` |
| 11 The master, the viewers, the rest | `harnessd/`, `dsh/`, `watcher/`, `orchestrator/`, `scm/`, `cloud/` (9) | 1, 2 | high | the guard without `edges.txt` |
| 12 Services a to g | `services/[a-g]*.ts` (8) | 1, 2 | high | the guard without `services-a.txt` |
| 13 Services h to z | `services/[h-z]*.ts` (21) | 1, 2 | high | the guard without `services-h.txt` |
| 14 The agent browser | `services/agentBrowser*.ts`, `services/agentBrowser/*.ts` (8) | 1, 2 | high | the guard without `agent-browser.txt` |
| 15 lib: platform | `lib/windows/`, `lib/ptyHost/`, six more (11) | 1, 2 | high | the guard without `lib-platform.txt` |
| 16 lib: folders | `lib/e2ee/`, `sessionSearch/`, `connectors/`, `autonomous-device/` (11) | 1, 2 | high | the guard without `lib-folders.txt` |
| 17 lib: the files in `lib/` | 23 files, 5 lines by hand, `services/router.spec.ts` | 1, 2 | high | the guard without `lib.txt` |
| 18 End-to-end expectations | `cli/e2e/*.e2e.ts` (13) | 3 to 17 | high | none committed: test code only, one commit |
| 19 The guard keeps no pending list | `src/architecture.failureLogs.spec.ts`, specs the sweep reported | 3 to 17 | medium | none: test code only, one commit |
| 20 The follow-up list | none: a report | 19 | medium | none: changes no code |

Longest chain: four tasks (1 or 2 → any of 3 to 17 → 19 → 20).

- Tasks 1 and 2 share no file and start at once. Tasks 3 to 17 share no file with each other and start when both are done.
- Files shared by two tasks are shared only along a dependency: Task 2 creates the fifteen lists and Tasks 3 to 17 each delete their own; Task 19 edits Task 2's spec after them.
- Three spec files sit in one task's folder and belong to another's: `services/fleet.spec.ts` (Task 10, not 12), `services/router.spec.ts` (Task 17, not 13), `backendSocket.lanes.spec.ts` (Task 8, not 7). Four `lib/` files belong outside the `lib` tasks: `lib/retainExitedSession.ts` and `lib/daemonState.ts` (Task 4), `lib/sessionSync.ts` (Task 5), `lib/daemonLaunch.ts` (Task 8).

## Global Constraints

- **The token never carries free text.** Not a message, a reason, a detail, a stack or a path. Code shape: upper case, digits and `_`, 2 to 40 characters, first a letter (`/^[A-Z][A-Z0-9_]{1,39}$/`).
- **Log text only**, but for two things: Task 8 (answer 1), and the `cause` Task 3 gives `RegistryPersistenceUnavailable`. No error a client receives changes: reply `error` and `detail` fields, hold reasons kept in the registry and command output stay as they are. No typed error is added; a plain `new Error('…')` reads `Error`.
- **No new file in the core's process.** `errorKind` lives in `cli/src/lib/log.ts`; `cli/src/architecture.coreFiles.txt` is not edited. `lib/log.ts` keeps importing Node alone: the master and every lean process load it.
- **No second logging path**: no console wrapper, no logger class, no option.
- **Out of scope, not edited for this rule:** what a command prints on the terminal of the person who ran it (the terminal list in Task 2), `cli/src/e2e/`, `cli/src/tui/`, the lines that log stored strings not read from an error at the line, and the lines whose only content is an error's `.reason`, `.detail`, `.stderr`, `.stdout` or `.path` (answer 6). Task 20 lists them all for the follow-up, which extends the guard to those fields.
- **Nothing left behind.** A local helper that only turned an error into words for a log (`describe`, `message`, `reason`, `said`, `short`, `msg`, `why`) is deleted with its last use. One still used for a reply stays, for the reply.
- **100% coverage per file** holds for `src/core`, `src/services`, `src/harnessd`, `src/orchestrator`, `lib/resumeAgentService.ts`, `dsh/builtins.ts`: a deleted branch takes its now-idle test case's expectation with it, never the case.
- **Comments say why.** A comment that explains what a message could quote stays true or goes.
- **Platforms the pull request names:** the CLI daemon on macOS, Linux and Windows, the same on each.

## The token

`errorKind(error: unknown): string` returns, and never throws:

| Thrown | Token |
|---|---|
| Not an `Error` | `typeof error` (`string`, `object`, `undefined`; `null` is `object`) |
| An `Error` | its name, then its code, joined by one space; `Error` when it has neither |

- **Name:** `error.name` when it is shaped like a type name (`/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/`) and is not `Error`; otherwise `error.constructor.name` under the same test. Our typed errors rarely set `name` (`IdentityReadUnavailable`, `AtomicWriteUnconfirmed`), so the class name is what tells them apart; the release bundle keeps class names (`build-bundle.mjs`, `keepNames: true`).
- **Code:** the first code-shaped string among `error.code`, `error.cause.code`, `error.cause.cause.code`. Two causes deep and no further: `AtomicWriteUnconfirmed` wraps `RegistryPersistenceUnavailable`, which Task 3 has keep the disk's code on its own `cause`.
- A getter that throws, a `cause` that loops, a numeric or lower-case `code`, a `name` holding a sentence: none is printed and none throws.

## What the guard finds

A **log call** is `console.log`, `.warn`, `.error`, `.info` or `.debug`, or an injected logger: a call named `log`, `warn`, `error` or `info`, bare or on anything but `console` and `Math` (`deps.log`, `this.opts.log?.()`, `d.error`), unless its value is thrown.

An **error** is a name bound by `catch (x)`; the first parameter of the handler given to `.catch()`, to `.then()` second, or to `.on`/`.once`/`.addListener`/`.prependListener` for `'error'`, `'unhandledRejection'` or `'uncaughtException'`; any name on the left of `instanceof` in the expression at hand; a name spelled `e`, `err`, `error`, `ex` or `exception`, or ending `Error` or `Err`, unless it is a parameter typed `string`; and the `.cause` of any of these.

In a log call's arguments the guard reports:

1. **An error's text:** `.message`, `.stack`, `.toString()`, except as an operand of `===` or `!==`. Not `.reason`, `.detail`, `.stderr`, `.stdout` or `.path` (answer 6): they pass as a typed field does, and the follow-up adds them.
2. **An error whole:** as an argument, in a template, added to a string, as a branch of `?:`, `??` or `||`, in an object or array, handed to any function but `errorKind`, or built in place (`new Error('…')`, `new XError(…)`).
3. **A local made from an error:** a `const` or `let` whose initializer does 1 or 2, logged by its name. A property of such a local is not followed.
4. **A catch that logs and caught nothing:** any log call whose nearest catch is `catch {` or a handler with no parameter.
5. **A failed line that does not say what failed:** a log call in a catch that has a binding, whose text holds `fail` (any case) and whose arguments name neither the binding nor a local made from it.

It passes `errorKind(x)`, `x instanceof T`, `typeof x`, a comparison, a typed field read at the line by its name (`error.code`, `error.state`), and `Number(…)` of anything: a number carries no words. Its limits go in the spec's header comment, as the other architecture specs state theirs: a logger under another name, text carried two locals away, a catch with a binding that logs without the word `fail`, and an error's `.reason`, `.detail`, `.stderr`, `.stdout` and `.path`, which a follow-up task adds with the stored-string lines (answer 6).

## How a line changes

| Today | Becomes |
|---|---|
| `` `… ${error instanceof Error ? error.message : String(error)}` `` | `` `… ${errorKind(error)}` `` |
| `console.error('[x] failed:', err instanceof Error ? err.message : err)` | `console.error('[x] failed:', errorKind(err))` |
| `console.error('[x] listen failed:', err)` | `console.error('[x] listen failed:', errorKind(err))` |
| `` log(`[x] did not start · ${describe(error)}`) `` | `` log(`[x] did not start · ${errorKind(error)}`) ``, and `describe` goes |
| `.catch(() => console.error('[registry] save failed'))` | `` .catch((error) => console.error(`[registry] save failed · ${errorKind(error)}`)) `` |
| `catch { log('[engine-others] LIVE_RECOVERY_FAILED') }` | `` catch (error) { log(`[engine-others] LIVE_RECOVERY_FAILED · ${errorKind(error)}`) } `` |
| `const detail = …error.message…; reply({ error: detail }); console.warn(`` `… ${detail}` ``)` | the reply keeps `detail`; the log line takes `errorKind(error)` |

- **The line keeps** its tag, its words, its separator, its ids (`sid`), sizes and counts. A line with no kind gets it after ` · `.
- **A path or URL on a changed line goes**: a folder, a file, a socket, a worktree, a transcript, a `cwd`. The line names the thing in words or by an id it has. A request line keeps its method, never its route (`hookServer.ts:507, 1111`, `gateway/keyRoutes.ts:122`). A fixed name of Harness's own (an exe, a version, an engine, a service, a port number) stays.
- **A typed field the line already printed stays**, read at the line by its name (a code, a state, a failure category, a byte count). Never through a function that takes the error; hand the function the field instead (`describeSpawnLockOwner(error.owner)`).
- **Never hoist** an error's words into a local to get past the guard, and never rename a logger.
- **A new binding shadows nothing**: check the scope for an `error` parameter or logger before naming it.
- **Import** `errorKind` from `lib/log.js` (extend the import where `sid` or `ts` already comes from it).

Each sweep task's steps, with its own names filled in below:

- **Red.** Delete the task's pending list. Rewrite, in the specs beside its files, each expectation of a line it will change to the new line. Run the guard and those specs: the guard fails with exactly the task's hits, the rewritten expectations fail on the old text. Commit `test(cli): <message> (red)`.
- **Change** the lines.
- **Check.** Run the guard, the task's specs and `npm run typecheck`. Then, for each changed line, `grep -rlF '<its fixed words>' src --include='*.spec.ts'` and run what it finds. A failing spec outside the task's files is not edited: it goes in the report as `cross-area: <spec>:<line> '<old>' -> '<new>'`, and Task 19 applies it.
- **Commit** with the task's message.

## Review Focus

1. **`harness start` after the sweep.** A revoked sign-in, a busy machine, DNS down, a refused connection and a certificate fault are still told apart from the lines the daemon now writes. Task 8, `reads %s, as the gateway writes it`.
2. **A code or a name that is not a token**: an exit number, a lower-case word, a sentence with a path, 41 characters. Never printed. Task 1, `a code that is %s is not printed`, `a name that is not a type name is not printed`.
3. **An error that fights back**: a `name` or `code` getter that throws, a `cause` that is the error itself. The log line is still written and the catch block still runs. Task 1, `never throws`, `a cause that loops ends`.
4. **The release bundle.** A typed error's kind is its class name, which a minifier would turn into a letter. Task 1, `the release bundle keeps class names`.
5. **A full or read-only disk.** The registry's save lines say `ENOSPC`, `EROFS`, `EACCES`, also when the error crossed `persistenceFailure`. Task 3, `a save refused with %s logs that code`, `a names save refused with ENOSPC`.

## Decided here, where the spec left it to the builder

- **The name is `errorKind`.** `failure` is a local in 115 places and `failureKind` exists (`lib/productUsageSignals.ts`).
- **The token follows `cause` two levels**, for the code only.
- **The disk's code crosses `persistenceFailure` on `cause`**, as `{ code }` and nothing else: the comment there says only fixed categories cross that boundary. Not as the error's own `code`: generic readers of `error.code` answer clients (`core/agents/close.ts:149`).
- **The guard reads code with the TypeScript compiler API**, with `finds`/`passes` tables as its neighbours have.
- **The guard reaches where the same cause hides** (answer 6, now in the spec): an error handed to a helper (`describe(error)`, `message(error)`, `said(error)`: about 45 lines) and a local made from one (20 lines). It does not read an error's `.reason`, `.detail`, `.stderr`, `.stdout` or `.path`: the follow-up task does.
- **A catch that logs without a binding is a hit whatever its words** (37 lines; the spec names the ones that say "failed"; open question 1). With a binding, only a line that says `fail` and names nothing it caught (6 lines).
- **The pending lists hold a file and its hit count**, not line numbers: 367 hits, and a line number moves when `main` does. One more hit in a listed file still fails.
- **`cli.ts` is on the terminal list whole.** Two of its lines reach a log and Task 7 changes them by hand: `resolveMachineIfUnknown` (1272) and the status flush (2689).
- **`lib/machineEngines.ts` is on it too**: its only log lines are `harness machines engines`' own. `lib/selfUpdate.ts` and `lib/runtimeInstall.ts`, the spec's other two mixed files, are scanned whole: every hit in them is a daemon's line.
- **`onError` stays a command's.** The core stops calling it: `enterSafeMode` logs its own kind line, lets go of the pid file and exits (Task 4). `lib/daemonState.ts` is then on the terminal list.
- **Two error objects stop travelling through an injected logger**, each with its one wiring, in one task: `lib/sessionSync.ts` `warn(error)` (Task 5) and `lib/retainExitedSession.ts` `warn(message, error)` (Task 4).

---

### Task 1: `errorKind`

**Depends on:** none. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/log.ts` (a new export after `sid`)
- Test: `cli/src/lib/log.spec.ts`

**Interfaces:**
- Produces: `export function errorKind(error: unknown): string`, imported from `lib/log.js`.

- [ ] **Step 1: Write the failing tests**, a `describe('errorKind', …)` in `lib/log.spec.ts`:

```ts
class Held extends Error { readonly code = 'IDENTITY_UNAVAILABLE' }
class Changed extends Held {}
class Unconfirmed extends Error { constructor(cause: unknown) { super('unconfirmed', { cause }) } }
const disk = (code: string) => Object.assign(new Error(`${code}: refused, open '/Users/dee/.harness/cli/data/registry.json'`), { code })

it.each([
  ['a Node fs error is its code', disk('EACCES'), 'EACCES'],
  ['a typed error with a fixed code is both', new Changed('the owner changed in /Users/dee/work'), 'Changed IDENTITY_UNAVAILABLE'],
  ['a built-in type is its name', new TypeError("Cannot read properties of undefined (reading 'secret')"), 'TypeError'],
  ['a type with a code is both', Object.assign(new TypeError('The "path" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' }), 'TypeError ERR_INVALID_ARG_TYPE'],
  ['a plain Error is Error', new Error('could not read /Users/dee/notes.txt'), 'Error'],
  ['an abort is its name, not its number', new DOMException('aborted', 'AbortError'), 'AbortError'],
  ['a wrapper shows the disk code on its cause', new Unconfirmed(disk('ENOSPC')), 'Unconfirmed ENOSPC'],
  ['two causes deep', new Unconfirmed(new Error('storage', { cause: { code: 'EDQUOT' } })), 'Unconfirmed EDQUOT'],
  ['a thrown string is its type', 'reader failed on /Users/dee/x', 'string'],
  ['undefined', undefined, 'undefined'],
  ['null', null, 'object'],
  ['a thrown object is its type, whatever it holds', { code: 'ENOENT', message: '/Users/dee/x' }, 'object'],
])('%s', (_, thrown, kind) => expect(errorKind(thrown)).toBe(kind))

it.each([['a number', 1], ['lower case', 'enoent'], ['words', 'no such file /Users/dee/x'], ['41 characters', `E${'X'.repeat(40)}`], ['one letter', 'E']])(
  'a code that is %s is not printed', (_, code) => expect(errorKind(Object.assign(new Error('x'), { code }))).toBe('Error'))

it('a name that is not a type name is not printed', () => {
  expect(errorKind(Object.assign(new Error('x'), { name: 'Could not read /Users/dee/x' }))).toBe('Error')
  expect(errorKind(Object.assign(new TypeError('x'), { name: 'a b' }))).toBe('TypeError')
})

it('a cause that loops ends', () => {
  const looped = new Error('x'); Object.defineProperty(looped, 'cause', { value: looped })
  expect(errorKind(looped)).toBe('Error')
})

it('never throws: a getter that throws reads Error', () => {
  for (const field of ['name', 'code', 'cause']) {
    const hostile = new TypeError('x'); Object.defineProperty(hostile, field, { get() { throw new Error('no') } })
    expect(errorKind(hostile)).toBe('Error')
  }
})

it('the release bundle keeps class names, which a typed error\'s kind is', () =>
  expect(readFileSync(join(__dirname, '..', '..', 'build-bundle.mjs'), 'utf8')).toMatch(/keepNames: true/))
```

- [ ] **Step 2: Run** `npx vitest run src/lib/log.spec.ts`. Expected: FAIL, `errorKind` is not exported. Commit `test(cli): a failure's kind for a log line (red)`.
- [ ] **Step 3: Implement** `errorKind` as "The token" says, the whole body in one `try`/`catch` that returns `Error`. Its doc comment says why: a message or stack can quote the person's files, prompts or a peer's text, and Export logs sends the log off the machine.
- [ ] **Step 4: Run** `npx vitest run src/lib/log.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: errorKind names a failure by its code and type, never its words`.

### Task 2: The guard and its pending lists

**Depends on:** none (it names `errorKind`, it does not import it). **Effort:** `xhigh`.

**Red test:** the guard itself, run on today's tree before its lists exist (the spec's "must fail on `main` today"). It lands green with the lists.

**Files:**
- Create: `cli/src/architecture.failureLogs.spec.ts`
- Create: `cli/src/architecture.failureLogs.pending/registry.txt`, `core.txt`, `core-agents.txt`, `core-sessions.txt`, `entries.txt`, `gateway.txt`, `engines.txt`, `devices.txt`, `edges.txt`, `services-a.txt`, `services-h.txt`, `agent-browser.txt`, `lib-platform.txt`, `lib-folders.txt`, `lib.txt`

**Interfaces:**
- Produces: `npx vitest run src/architecture.failureLogs.spec.ts`, the red test of Tasks 3 to 17; one pending list per sweep task.

**What it scans:** every `.ts` under `cli/src` but `*.spec.ts`, `*.test.ts`, `*.d.ts`, `e2e/`, `tui/`, `testing/`, any `__fixtures__/`, and the terminal list. Paths are relative to `cli/src`, with forward slashes. A hit prints as `<file>:<line>: <what it found>`.

**The terminal list**, a file and the command whose output it prints, in the spec with this reason: a command's output is on the terminal of the person who ran it, not in a log.

| File | Prints |
|---|---|
| `cli.ts` | the commands; its two lines that reach a log are changed by hand (Task 7) |
| `remoteCommand.ts`, `shellLaunch.ts` | `harness remote`; `harness shell-launch`, in the pane it starts |
| `devices/client.ts`, `orchestrator/command.ts` | `harness hardware`; `harness orchestrator` |
| `lib/apiCommand.ts`, `lib/newCommand.ts`, `lib/flash.ts`, `lib/daemonStop.ts`, `lib/machineEngines.ts` | `harness api`, `new`, `flash`, `stop`, `machines engines` |
| `lib/updateCommand.ts`, `lib/windows/ptyUpdateCommand.ts` | `harness update` and its terminal host step |
| `lib/daemonState.ts` | `onError`, how a command fails |

A file the guard finds that is not here and whose every log call is a command's output joins this list, named in the report. Any other goes on its area's pending list.

**The pending lists.** One line a file: `<file> <hits>`. A listed file is excused exactly that many hits; one more, or one fewer, fails. First match wins:

| List | Task | Files |
|---|---|---|
| `registry.txt` | 3 | `lib/registry.ts`, `lib/registryPersistence.ts` |
| `core.txt` | 4 | files directly in `core/`; `lib/retainExitedSession.ts` |
| `core-agents.txt` | 5 | `core/agents/**`; `lib/sessionSync.ts` |
| `core-sessions.txt` | 6 | every other folder under `core/` |
| `entries.txt` | 7 | files directly in `src/` |
| `gateway.txt` | 8 | `gateway/**` |
| `engines.txt` | 9 | `engines/**` |
| `devices.txt` | 10 | `cable/**`, `device/**`, `devices/**` |
| `agent-browser.txt` | 14 | `services/agentBrowser.ts`, `services/agentBrowserProcess.ts`, `services/agentBrowser/**` |
| `services-a.txt` | 12 | under `services/`, a name that starts `a` to `g` |
| `services-h.txt` | 13 | the rest of `services/` |
| `lib-platform.txt` | 15 | `lib/windows/**`, `lib/ptyHost/**`, `lib/ptyHostBackend.ts`, `lib/terminalBackend*.ts`, `lib/tmux.ts`, `lib/selfUpdate.ts`, `lib/nodeMigration.ts`, `lib/launchers.ts` |
| `lib-folders.txt` | 16 | every other folder under `lib/` |
| `lib.txt` | 17 | every other file directly in `lib/` |
| `edges.txt` | 11 | every other folder: `harnessd/`, `dsh/`, `watcher/`, `orchestrator/`, `scm/`, `cloud/`, … |

The code that reads the lists is a few lines of its own, under a comment that names Task 19, which deletes it.

- [ ] **Step 1: Write the spec.** Its header comment states the rule, why (AGENTS.md rule 7; Export logs, #4447), and its limits. `failureLogs(code: string, file = 'file.ts'): string[]` implements "What the guard finds". The cases:

```ts
it.each([
  "try { run() } catch (error) { console.error('[x] failed:', error) }",
  "try { run() } catch (error) { console.error(`[x] failed: ${error}`) }",
  "try { run() } catch (error) { console.warn(`[x] failed: ${error instanceof Error ? error.message : String(error)}`) }",
  "try { run() } catch (err) { console.error('[x] failed:', err instanceof Error ? (err.stack ?? err.message) : err) }",
  "try { run() } catch (error) { console.warn('[x] ' + (error as Error).message) }",
  "try { run() } catch (e) { d.error(`[x] ${e}`) }",
  "try { run() } catch (error) { console.warn(`[x] ${error.toString()}`) }",
  "try { run() } catch (error) { console.error('[x] failed', (error as { cause?: unknown }).cause) }",
  "try { run() } catch (error) { wiring.log('[x] failed', { error }) }",
  "try { run() } catch (error) { this.opts.log?.(`[x] ${describe(error)}`) }",
  "try { run() } catch (error) { warn('[x] could not announce', new Error('archive unavailable')) }",
  "run().catch((reason) => console.error('[x] failed', reason))",
  "run().then(done, (why) => log(`[x] ${why}`))",
  "socket.on('error', (problem) => console.error('[x] socket error:', problem.message))",
  "process.on('unhandledRejection', (reason) => { console.error('[x]', reason) })",
  "function report(err: unknown) { deps.log(`[x] failed · ${String(err)}`) }",
  "function report(value: unknown) { log(`[x] ${value instanceof Error ? value.message : 'unknown'}`) }",
  "try { run() } catch (error) { const detail = error instanceof Error ? error.message : String(error); reply({ error: detail }); console.warn(`[x] refused · ${detail}`) }",
  "try { run() } catch (error) { const line = explain(error); console.error(line) }",
  "try { run() } catch { console.error('[x] save failed') }",
  "try { run() } catch { log('[x] its reader is unavailable') }",
  "run().catch(() => console.error('[x] save failed'))",
  "run().catch(() => { saved = false; log('[x] LIVE_REATTACH_FAILED') })",
  "try { run() } catch (error) { if (strict) throw wrap(error); console.error('[x] save failed') }",
  "socket.on('error', (err) => { const status = /^Unexpected server response: (\\d{3})$/.exec(err.message)?.[1]; console.error(`[x] socket error: ${status}`) })",
])('finds %s', (code) => expect(failureLogs(code)).not.toEqual([]))

it.each([
  "try { run() } catch (error) { console.error(`[x] save failed · ${errorKind(error)}`) }",
  "run().catch((error) => console.error(`[x] failed · ${errorKind(error)}`))",
  "try { run() } catch (error) { console.error(`[x] failed · ${errorKind((error as { cause?: unknown }).cause)}`) }",
  "// console.error('[x] failed:', error)",
  "const script = \"console.error('failed', error.message)\"",
  "try { run() } catch (error) { reply({ error: error instanceof Error ? error.message : 'FAILED' }) }",
  "try { run() } catch (error) { throw contract.error(error) }",
  "const refused = (error: string) => { log(`[frames] ${error}`); return { error } }",
  "console.warn(`[x] refused · ${verdict.error}`)",
  "console.log(JSON.stringify({ ok: false, error: 'NOT_SIGNED_IN' }))",
  "try { run() } catch (error) { console.warn(`[x] unavailable · ${error instanceof ReadError ? error.code : 'UNAVAILABLE'}`) }",
  "try { run() } catch (error) { log(`[x] not opened · ${(error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'in use' : 'failed'}`) }",
  "try { run() } catch (error) { const code = error instanceof Error && error.message === 'TOO_LARGE' ? 'LIVE_TOO_LARGE' : 'LIVE_OPEN_FAILED'; console.warn(`[x] ${code}`) }",
  "try { run() } catch (error) { const disposition = classify(error); console.error(`[x] not staying up — ${disposition.reason}`) }",
  "try { run() } catch (error) { if (missing(error)) return; console.log('[x] nothing saved yet') }",
  "try { run() } catch { /* not there yet */ }",
  "run().catch(() => undefined)",
  "const depth = Math.log(error)",
  "setTimeout(() => console.log('[x] retrying'), 100)",
  "socket.on('error', (err) => { const status = Number(/^Unexpected server response: (\\d{3})$/.exec(err.message)?.[1]); console.error(`[x] socket error: ${errorKind(err)}${status ? ` · Unexpected server response: ${status}` : ''}`) })",
  // Not yet: the follow-up task moves these two to `finds` when it adds the stored fields (answer 6).
  "try { run() } catch (error) { console.warn(`[x] not unpacked (${error.reason})`) }",
  "try { run() } catch (error) { console.error('[x] git refused:', (error as { stderr?: string }).stderr) }",
])('passes %s', (code) => expect(failureLogs(code)).toEqual([]))
```

  And four more:
  - `a pending line excuses its file's hits and no more`: with a planted file of two hits, `planted.ts 2` excuses it, `planted.ts 1` and `planted.ts 3` do not.
  - `no daemon log line carries an error's words or hides its kind`: the hits left after the terminal list and the pending lists equal `[]`. Its failure message is the rule in two sentences and where `errorKind` lives.
  - `every terminal file exists`.
  - `every pending line names a file with exactly that many hits`: the failure names the list and the line.
- [ ] **Step 2: Run** `npx vitest run src/architecture.failureLogs.spec.ts` before any list exists. Expected: every case passes but `no daemon log line …`, which FAILS with about 367 hits in about 161 files (this plan's prototype counted `registry` 12, `core` 37, `core-agents` 28, `core-sessions` 21, `entries` 19, `gateway` 14, `engines` 35, `devices` 34, `edges` 16, `services-a` 20, `services-h` 32, `agent-browser` 20, `lib-platform` 27, `lib-folders` 22, `lib` 30). `lib/windows/ptyUpdate.ts:219` and `lib/connectors/renew.ts:33` are not among them (answer 6). A count far from these means a rule was misread: the two tables above are the truth, and a hit in a file no task below names is reported. Commit `test(cli): no daemon log line carries an error's words or hides its kind (red)`, with the counts by list in the report.
- [ ] **Step 3: Write the fifteen lists** from that output.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `The failure-log guard lands with today's lines listed as pending, one list a sweep task`.

### Task 3: The registry

**Depends on:** 1, 2. **Effort:** `xhigh`. **Red test:** the guard without `registry.txt`, and the three tests below.

**Files:**
- Modify: `cli/src/lib/registry.ts` (1296, 1347, 1629, 1661, 1956, 1994, 3181, 3235, 3638, 3665; `persistenceFailure`, 570-587)
- Modify: `cli/src/lib/registryPersistence.ts` (100, 366; `RegistryPersistenceUnavailable`, 31-33)
- Test: `cli/src/lib/registry.diskFailure.spec.ts`, and the `lib/registry*.spec.ts` and `lib/registryPersistence*.spec.ts` that assert a changed line (`registry.quarantine.spec.ts` does)
- Delete: `cli/src/architecture.failureLogs.pending/registry.txt`

**Interfaces:**
- Consumes: `errorKind` (Task 1).
- Produces: `new RegistryPersistenceUnavailable(reason: string, disk?: string)`; `disk` is kept as `cause: { code: disk }` and nowhere else. `persistenceFailure` passes the disk's code when it is a string. The message, the name and every `instanceof` are unchanged.

`save()`'s own line (3638) holds the raw error: `EACCES`, or `AtomicWriteUnconfirmed ENOSPC` after the rename. The strict paths (1956, 1994, 3181, 3665) hold what `persistenceFailure` made: `RegistryPersistenceUnavailable ENOSPC`. Line 1661 keeps no path; line 1658 (`moved it aside to ${aside}`) is not this branch's.

- [ ] **Step 1: Write the failing tests** in `lib/registry.diskFailure.spec.ts`:

```ts
it.each(['EACCES', 'ENOSPC'])('a save refused with %s logs that code, and no path', async (code) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  refuse.code = code
  registry.setActive(input.agentId, false) // save(): logged, never thrown
  await registry.flush().catch(() => {})
  const lines = error.mock.calls.map((call) => call.map(String).join(' '))
  expect(lines).toContain(`[registry] save failed · ${code}`)
  expect(lines.join('\n')).not.toContain(directory)
})

it.each(['ENOSPC', 'EROFS'])('a strict save refused with %s keeps the disk code for the log, off the message', async (code) => {
  refuse.code = code
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(errorKind(failure)).toBe(`RegistryPersistenceUnavailable ${code}`)
  expect((failure as { code?: unknown }).code).toBeUndefined()
})
```

  And `a names save refused with ENOSPC logs the type and the disk code`: an inherited name while `refuse.code = 'ENOSPC'`, set up as `lib/registry.spec.ts`'s `retries an inherited name on the next save after its observational write fails` does, expects the line `[registry] save names failed · RegistryPersistenceUnavailable ENOSPC`.
- [ ] **Step 2: Red.** Delete `registry.txt`; rewrite `registry.quarantine.spec.ts`'s `could not be moved aside (EXDEV: cross-device link not permitted)` to `(EXDEV)`. Run `npx vitest run src/architecture.failureLogs.spec.ts src/lib/registry.diskFailure.spec.ts src/lib/registry.quarantine.spec.ts`. Expected: FAIL: the guard on 12 hits in the two files, the new tests, the rewritten line. Commit `test(cli): the registry's save lines name the disk's code (red)`.
- [ ] **Step 3: Change** the twelve lines, the class and `persistenceFailure`.
- [ ] **Step 4: Check** with `npx vitest run src/architecture.failureLogs.spec.ts src/lib/registry src/lib/registryPersistence` and `npm run typecheck`, then the grep of "How a line changes". Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: the registry's save, admission and cleanup lines name what failed`.

### Task 4: Core: the files in `core/`

**Depends on:** 1, 2. **Effort:** `xhigh`. **Red test:** the guard without `core.txt`.

**Files:**
- Modify: `cli/src/core/main.ts` (363, 368, 492, 495, 559, 601, 1143, 1320, 1381, 1389, 2020, 2123, 2128, 2557, 2625, 2692, 2767, 2773, 3102, 3290, 3317, 3428, 3431, 3475), `core/agentLife.ts` (169, 172), `core/deliveries.ts` (107), `core/experiments.ts` (108, 120, 217), `core/serviceHost.ts` (109, 114, 177; `describe`, 77), `core/serviceRoutes.ts` (70), `core/updateHandoff.ts` (67, 73; its `message` helper)
- Modify: `cli/src/lib/retainExitedSession.ts` (33, 71, 75), `cli/src/lib/daemonState.ts` (the comment on `onError`, 77-78)
- Test: the `<name>.spec.ts` and `<name>.*.spec.ts` beside each `core/` file above, and `lib/retainExitedSession.spec.ts`. `core/main.ts` has none: the guard is its test.
- Delete: `cli/src/architecture.failureLogs.pending/core.txt`

Not mechanical:
- **3428.** `onError(err, code)` becomes the core's own: `` console.error(`Failed to start adapter: ${errorKind(err)}`) ``, `removePidFileIf(process.pid)`, `process.exit(code)`. The `onError` import goes; its comment in `lib/daemonState.ts` says commands alone fail through it. `detail` and the safe-mode marker (3430, 3434) are not a log and stay.
- **492, 495.** `[fatal-guard] …: ${errorKind(reason)}` (answer 2).
- **2020 with `lib/retainExitedSession.ts`.** `warn(message: string): void`. The handler at 71 and the catch at 74 each take the error they are given, and the line names it after ` · `; the two `new Error('…')` go, their words join the lines; `main.ts` wires `warn: (message) => console.warn(message)`.
- **3424** (`disposition.reason`) is a stored string and stays.

- [ ] **Step 1: Red.** Delete `core.txt`; rewrite the expectations (`core/agentLife.spec.ts` `[agents] a follower failed on running: boom` and its two neighbours, `serviceHost.spec.ts`, `updateHandoff.spec.ts`, `experiments.spec.ts`, `deliveries.spec.ts`, `serviceRoutes.spec.ts`, `lib/retainExitedSession.spec.ts`). Run `npx vitest run src/architecture.failureLogs.spec.ts src/core/agentLife src/core/deliveries src/core/experiments src/core/serviceHost src/core/serviceRoutes src/core/updateHandoff src/lib/retainExitedSession`. Expected: FAIL: the guard on 37 hits in 8 files, the rewritten lines. Commit `test(cli): the core's own failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command plus `src/architecture.spec.ts src/startupOrder.spec.ts src/leanEntry.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the core's wiring, service host and handoff lines name a failure's kind`.

### Task 5: Core: agents

**Depends on:** 1, 2. **Effort:** `xhigh`. **Red test:** the guard without `core-agents.txt`.

**Files:**
- Modify: `cli/src/core/agents/bind.ts` (220, 227, 323, 339, 340, 390, 432, 478; its `reason` helper), `conversationOwners.ts` (81), `create.ts` (261, 265, 299, 321), `discovery.ts` (108, 125, 215, 310), `events.ts` (42), `forget.ts` (116), `heldLaunches.ts` (68), `launch.ts` (145), `launches.ts` (179, 198), `newPane.ts` (126, 236), `quietTitles.ts` (34), `update.ts` (77)
- Modify: `cli/src/lib/sessionSync.ts` (12, 37)
- Test: the specs beside each, and `lib/sessionSync.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/core-agents.txt`

Not mechanical:
- **`bind.ts:390`, `create.ts:265, 299`, `update.ts:77`.** `reason`, `detail` and `message` still go to the registry's hold and to the reply, unchanged. Only the log line takes `errorKind(error)`.
- **`events.ts:42` with `lib/sessionSync.ts`.** `warn(kind: string): void`; `sessionSync.ts:37` calls `deps.warn(errorKind(error))`; `events.ts` wires `warn: (kind) => console.error('[cli] announceSession failed:', kind)`.
- **`create.ts:261, 321`, `launches.ts:179, 198`.** The folder goes: `[agent] pre-trust skipped · <kind>`, in the task's words.
- **`newPane.ts:236`.** `… · readiness publication unavailable` gains ` · ${errorKind(error)}`.

- [ ] **Step 1: Red.** Delete `core-agents.txt`; rewrite the expectations in the specs beside the files. Run `npx vitest run src/architecture.failureLogs.spec.ts src/core/agents src/lib/sessionSync`. Expected: FAIL: the guard on 28 hits in 13 files, the rewritten lines. Commit `test(cli): the agents' failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: creating, binding and discovering an agent name a failure's kind`.

### Task 6: Core: engines, terminals, transcripts, turns

**Depends on:** 1, 2. **Effort:** `xhigh`. **Red test:** the guard without `core-sessions.txt`.

**Files:**
- Modify: `cli/src/core/engines/hooks.ts` (308, 339), `nativeControls.ts` (124, 211), `otherStreams.ts` (161, 191), `pendingAdmission.ts` (58); `core/terminals/browser.ts` (101, 118); `core/transcripts/attach.ts` (138, 185, 186, 457, 596, 696), `ingest.ts` (109); `core/turns/agyBackstop.ts` (62), `funnel.ts` (108), `heartbeats.ts` (70), `turnHooks.ts` (256, 288)
- Modify, by hand (answer 4, the guard passes them today): `core/transcripts/ingest.ts` (97, 123), `core/transcripts/sideReads.ts` (24): `err instanceof Error ? err.name : typeof err` becomes `errorKind(err)`
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/core-sessions.txt`

Left as they are: `core/engines/backgroundJobs.ts:38`, `core/transcripts/lastTurn.ts:35`, `history.ts:90` (a typed reader code, read by name).

- [ ] **Step 1: Red.** Delete `core-sessions.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/core/engines src/core/terminals src/core/transcripts src/core/turns`. Expected: FAIL: the guard on 21 hits in 11 files, the rewritten lines. Commit `test(cli): the session modules' failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: hooks, transcripts, terminals and turns name a failure's kind`.

### Task 7: The socket, the hook door, the entries

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `entries.txt`, and `cliCommand.spec.ts`.

**Files:**
- Modify: `cli/src/backendSocket.ts` (447, 605, 908, 924, 962, 1180, 1193, 1442, 1446), `hookServer.ts` (402, 507, 734, 868, 869, 1111, 1135, 1166), `masterProcess.ts` (204), `serviceProcess.ts` (132; `describe`, 77), `cli.ts` (1272, 2689)
- Test: `backendSocket.spec.ts` and `backendSocket.*.spec.ts` but `backendSocket.lanes.spec.ts` (Task 8's); `hookServer.spec.ts`, `hookServer.hermes.spec.ts`, `localWsServer.spec.ts`, `masterProcess.spec.ts`, `serviceProcess.spec.ts`, `cliCommand.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/entries.txt`

Not mechanical:
- **`cli.ts` is not scanned.** Only 1272 (`machine id not resolved yet — <kind>; …`) and 2689 (`[registry] status flush failed · <kind>`) change; every other line of it is a command's.
- **`hookServer.ts:507, 1111`** keep the method, not the route. **1166** keeps no socket path.
- **`hookServer.ts:606, 742, 893, 950`** (`reason`) and **`backendSocket.ts:1068`** (`verdict.error`) are stored strings and stay.

- [ ] **Step 1: Write the failing test**: in `cliCommand.spec.ts`, `starts without the backend even when the session has no machine id yet, on the computer id` also expects

```ts
expect(result.stdout).toMatch(/machine id not resolved yet — [A-Za-z_ ]+; starting on the computer id/)
expect(result.stdout).not.toContain('fetch failed')
```

- [ ] **Step 2: Red.** Delete `entries.txt`; rewrite the expectations in the specs above. Run `npx vitest run src/architecture.failureLogs.spec.ts src/cliCommand.spec.ts src/backendSocket.spec.ts src/backendSocket.historyOrder.spec.ts src/hookServer.spec.ts src/hookServer.hermes.spec.ts src/masterProcess.spec.ts src/serviceProcess.spec.ts`. Expected: FAIL: the guard on 19 hits in 4 files, the `cliCommand` case, the rewritten lines. Commit `test(cli): the socket's, the hook door's and the entries' failure lines are no longer excused (red)`.
- [ ] **Step 3: Change** the lines.
- [ ] **Step 4: Check** with the step 2 command plus `src/localWsServer.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: the socket, the hook door and the process entries name a failure's kind`.

### Task 8: The gateway, and what `harness start` reads

**Depends on:** 1, 2. **Effort:** `xhigh`. **Red test:** the guard without `gateway.txt`, and the two tests below.

**Files:**
- Modify: `cli/src/gateway/accountRoutes.ts` (143, 148), `gateway.ts` (318, 551, 578, 581, 896), `gatewayProcess.ts` (94), `keyRoutes.ts` (122), `start.ts` (299), `upstream.ts` (261, 295, 402, 413)
- Modify: `cli/src/lib/daemonLaunch.ts` (`connectFailure`, the TLS test at 95)
- Test: the specs beside the gateway files, `gateway/upstream.spec.ts`, `lib/daemonLaunch.spec.ts`, `backendSocket.lanes.spec.ts` (line 107 asserts the gateway's line)
- Delete: `cli/src/architecture.failureLogs.pending/gateway.txt`

**Interfaces:**
- Produces: the line `[backend] socket error: <kind>`, followed by ` · Unexpected server response: <status>` when the message is exactly that with a three-digit status. The status is taken as a number, `Number(/^Unexpected server response: (\d{3})$/.exec(msg)?.[1])`, which is what lets the guard pass it. `msg` still feeds the 401, 403 and 409 tests below it and is no longer logged.

- [ ] **Step 1: Write the failing tests.** In `lib/daemonLaunch.spec.ts`:

```ts
it.each([
  ['[backend] socket error: Error · Unexpected server response: 401', { deauth: true, fatal: true }],
  ['[backend] socket error: Error · Unexpected server response: 403', { deauth: true, fatal: true }],
  ['[backend] socket error: Error · Unexpected server response: 409', { busy: true }],
  ['[backend] socket error: Error · Unexpected server response: 404', { fatal: true, deauth: false }],
  ['[backend] socket error: Error · Unexpected server response: 502', { fatal: false }],
  ['[backend] socket error: ENOTFOUND', { detail: 'host not found (DNS)', fatal: false }],
  ['[backend] socket error: EAI_AGAIN', { detail: 'host not found (DNS)', fatal: false }],
  ['[backend] socket error: ECONNREFUSED', { detail: 'connection refused', fatal: false }],
  ['[backend] socket error: CERT_HAS_EXPIRED', { detail: 'TLS certificate error', fatal: true }],
  ['[backend] socket error: DEPTH_ZERO_SELF_SIGNED_CERT', { detail: 'TLS certificate error', fatal: true }],
  ['[backend] socket error: SELF_SIGNED_CERT_IN_CHAIN', { detail: 'TLS certificate error', fatal: true }],
  ['[backend] socket error: UNABLE_TO_VERIFY_LEAF_SIGNATURE', { detail: 'TLS certificate error', fatal: true }],
  ['[backend] socket error: ERR_TLS_CERT_ALTNAME_INVALID', { detail: 'TLS certificate error', fatal: true }],
])('reads %s, as the gateway writes it', async (line, expected) => {
  const { connectFailure } = await load()
  expect(connectFailure(line, 18473)).toMatchObject(expected)
})
```

  In `gateway/upstream.spec.ts`, `the socket's error line names its kind and the status, never the host`: an `'error'` of `new Error('Unexpected server response: 401')` logs `[backend] socket error: Error · Unexpected server response: 401`; one of `Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND' })` logs `[backend] socket error: ENOTFOUND`, and no logged line holds `api.example.test`.
- [ ] **Step 2: Red.** Delete `gateway.txt`; rewrite the expectations (`gateway/gateway.spec.ts:888-889`, `backendSocket.lanes.spec.ts:107`, the others beside the files). Run `npx vitest run src/architecture.failureLogs.spec.ts src/gateway src/lib/daemonLaunch.spec.ts src/backendSocket.lanes.spec.ts`. Expected: FAIL: the guard on 14 hits in 6 files, the `DEPTH_ZERO_SELF_SIGNED_CERT` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` rows, the `upstream` case, the rewritten lines. Commit `test(cli): the gateway's failure lines, as harness start reads them (red)`.
- [ ] **Step 3: Change** the fourteen lines and `connectFailure`'s TLS test.
- [ ] **Step 4: Check** with the step 2 command plus `src/backendSocket.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: the gateway names a failure's kind, and harness start still reads why it could not connect`.

### Task 9: Engines

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `engines.txt`, and `engines/hooks.spec.ts`.

**Files:**
- Modify, under `cli/src/engines/`: `hooks.ts` (43), `inProcess.ts` (69), `nativeHooks.ts` (80, 81, 196), `nativeLaunch.ts` (293), `resumeRepairs.ts` (90), `amp/threadExport.ts` (62), `commandcode/profileReader.ts` (113), `cursor/profileReader.ts` (291), `devin/profileReader.ts` (106), `kilo/profileReader.ts` (63), `opencode/profileReader.ts` (99), `pi/profileReader.ts` (82), `openclaw/reader.ts` (551; `errorCode`, 160), `others/readerRequests.ts` (138), `others/streamRequests.ts` (105), `others/streams.ts` (288, 309, 532), `kit/hookReview.ts` (262), `kit/hookSettings.ts` (68, 69, 116, 120, 128), `kit/nativeHookSettings.ts` (97, 98), `kit/notifyHooks.ts` (`hooksNotInstalled`, 69-72), `kit/nativeHookYaml.ts` (459), `kit/nativeInstall.ts` (345), `kit/nativePlugin.ts` (52, 83), `kit/statusLine.ts` (59), `kit/transcriptDiscovery.ts` (46, 70)
- Test: `engines/hooks.spec.ts`, and the specs beside each file
- Delete: `cli/src/architecture.failureLogs.pending/engines.txt`

Not mechanical:
- **`kit/hookSettings.ts:68`, `kit/nativeHookSettings.ts:97`, `nativeHooks.ts:80`.** `hooksNotInstalled(engine, err, platform)` returns a whole line that ends in the error's `reason`, and these three log it; it has no other caller. It splits in two in `kit/notifyHooks.ts`: whether the error is that hold (a boolean, from the error and the platform, today's test for a line), and the line's words (from the engine alone). Each caller logs the words, ` · ` and `errorKind(err)`. `kit/hookScript.spec.ts` follows.
- **`kit/hookSettings.ts:116, 120, 128`, `kit/statusLine.ts:59`** keep no file or folder.
- **`engines/others/streamRequests.ts:119`** (a fixed code chosen from the error) stays.
- The engines' declared `messages.failed` texts are data and stay; only the error beside them becomes its kind.

- [ ] **Step 1: Write the failing test**: `engines/hooks.spec.ts`, `rejects a hook when its engine admission check throws, and leaves other engines available`, throws `new Error('could not read /Users/dee/.codex/sessions/rollout-1.jsonl')` then the string `'reader failed on /Users/dee/.codex'`, keeps its three `admitHook` expectations, and ends

```ts
expect(warn.mock.calls).toEqual([['[hooks] codex admission failed:', 'Error'], ['[hooks] codex admission failed:', 'string']])
expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/dee')
```

- [ ] **Step 2: Red.** Delete `engines.txt`; rewrite the other expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/engines`. Expected: FAIL: the guard on 35 hits in 24 files, the `admitHook` case, the rewritten lines. Commit `test(cli): the engines' failure lines are no longer excused (red)`.
- [ ] **Step 3: Change** the lines.
- [ ] **Step 4: Check** with the step 2 command plus `src/hookAdmission.golden.spec.ts src/architecture.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: an engine's hooks, launch and readers name a failure's kind`.

### Task 10: Dials and devices

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `devices.txt`.

**Files:**
- Modify: `cli/src/cable/cableFleet.ts` (150, 241, 368, 412, 422), `cableHost.ts` (385, 446, 1331), `cableSession.ts` (1005, 1149, 1537, 1657, 1746, 2224, 2248, 2632, 2640, 2889, 3594, 3611), `cable/hosts/observed.ts` (515, 534, 858, 1066), `cable/pets/store.ts` (100); `cli/src/device/deviceFleet.ts` (298, 371, 394), `deviceLink.ts` (533, 585, 751, 880, 982, 1126)
- Modify, by hand (answer 4): `cable/noticeFile.ts` (142)
- Test: the specs beside each, and `services/fleet.spec.ts` (line 185 asserts `device/deviceFleet.ts`'s line)
- Delete: `cli/src/architecture.failureLogs.pending/devices.txt`

Left as they are: `cable/cableHost.ts:431, 434, 480` (stored strings); the serial port's device name (answer 5).

- [ ] **Step 1: Red.** Delete `devices.txt`; rewrite the expectations (`services/fleet.spec.ts:185`, `'[device] device: agent_recent r1 failed (timed out)'`, ends in the kind of the error that test throws: `(Error)` for a plain one). Run `npx vitest run src/architecture.failureLogs.spec.ts src/cable src/device src/services/fleet.spec.ts`. Expected: FAIL: the guard on 34 hits in 7 files, the rewritten lines. Commit `test(cli): the dials' and devices' failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the dials and the device link name a failure's kind`.

### Task 11: The master, the viewers, the rest

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `edges.txt`.

**Files:**
- Modify: `cli/src/harnessd/master.ts` (476, 515), `harnessd/reexec.ts` (473, 484, 637, 658; its `message` helper), `dsh/builtins.ts` (72), `dsh/verdict.ts` (141, 160), `dsh/viewer.ts` (310, 362, 435), `orchestrator/service.ts` (93), `scm/launch.ts` (31), `watcher/watcher.ts` (130, 402)
- Modify, by hand (answer 4): `cloud/service.ts` (233)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/edges.txt`

The master imports Node, its own folder and `../lib/log.js` alone (`architecture.spec.ts`): `errorKind` comes from there. `dsh/verdict.ts:141` keeps no folder; `watcher/watcher.ts:402` keeps no file name. `harnessd`, `orchestrator` and `dsh/builtins.ts` are held to 100%.

- [ ] **Step 1: Red.** Delete `edges.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/harnessd src/dsh src/watcher src/orchestrator src/scm src/cloud`. Expected: FAIL: the guard on 16 hits in 8 files, the rewritten lines. Commit `test(cli): the master's and the viewers' failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command plus `src/architecture.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the master, the viewers, the watcher and the orchestrator name a failure's kind`.

### Task 12: Services a to g

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `services-a.txt`.

**Files:**
- Modify, under `cli/src/services/`: `agentCleanup.ts` (136, 241, 248, 270; `reason`, 95), `connectors.ts` (108, 141, 149, 186, 200, 220, 241), `devices.ts` (1726), `devicesGuard.ts` (52, 57, 87; `describe`, 31), `fleetRouter.ts` (484), `followLink.ts` (51, 68), `guestLaunches.ts` (92, 113)
- Modify, by hand (answer 4): `goals.ts` (70, 88)
- Test: the specs beside each. Not `services/fleet.spec.ts` (Task 10's).
- Delete: `cli/src/architecture.failureLogs.pending/services-a.txt`

`connectors.ts:141, 220` keep no socket path or folder. `fleetRouter.ts:484` and `guestLaunches.ts:92`: the reply keeps its text, the log takes the kind.

- [ ] **Step 1: Red.** Delete `services-a.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/services/agentCleanup src/services/connectors src/services/devices src/services/fleetRouter src/services/followLink src/services/guestLaunches src/services/goals`. Expected: FAIL: the guard on 20 hits in 7 files, the rewritten lines. Commit `test(cli): the services' failure lines, a to g, are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the agent cleanup, the connectors, the devices and their neighbours name a failure's kind`.

### Task 13: Services h to z

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `services-h.txt`.

**Files:**
- Modify, under `cli/src/services/`: `hachi.ts` (171, 206, 255; `said`, 54), `hachiHandOver.ts` (57), `hachiWakes.ts` (81), `models.ts` (359), `orchestratorProcess.ts` (68), `osDevice.ts` (165, 322, 437, 462, 505; `short`, 211), `process.ts` (236, 253, 263, 303, 338; `describe`, 96), `requestErrors.ts` (14), `search.ts` (131), `sharedMachines.ts` (266), `sharingProcess.ts` (89), `turnsLink.ts` (37), `updaterProcess.ts` (114, 176, 198), `viewers.ts` (141, 147), `wifi.ts` (134), `wifiProcess.ts` (111, 142), `windowNames.ts` (162), `workspacesProcess.ts` (182)
- Modify, by hand: `handoffRequest.ts` (42) and `swarmLeftovers.ts` (34) (answer 4); `workspaceFrames.ts` (48): `[workspaces] WORKSPACE_FACTS_UNAVAILABLE` gains ` · ${errorKind(error)}`, a fixed code with no kind in a catch the guard does not reach
- Test: the specs beside each. Not `services/router.spec.ts` (Task 17's).
- Delete: `cli/src/architecture.failureLogs.pending/services-h.txt`

`osDevice.ts:165` keeps no file path. `sharedMachines.ts:250` and `handoffRequest.ts:47` are stored strings and stay.

- [ ] **Step 1: Red.** Delete `services-h.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/services/hachi src/services/handoffRequest src/services/models src/services/orchestratorProcess src/services/osDevice src/services/process src/services/requestErrors src/services/search src/services/sharedMachines src/services/sharingProcess src/services/swarmLeftovers src/services/turnsLink src/services/updaterProcess src/services/viewers src/services/wifi src/services/windowNames src/services/workspace`. Expected: FAIL: the guard on 32 hits in 18 files, the rewritten lines. Commit `test(cli): the services' failure lines, h to z, are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: Hachi, the service processes, the updater and their neighbours name a failure's kind`.

### Task 14: The agent browser

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `agent-browser.txt`.

**Files:**
- Modify, under `cli/src/services/`: `agentBrowser.ts` (276, 556), `agentBrowserProcess.ts` (193), `agentBrowser/browsers.ts` (191, 226, 284, 300, 318, 326, 343, 415, 534), `agentBrowser/containers.ts` (70), `agentBrowser/image.ts` (68), `agentBrowser/notices.ts` (78, 188, 199), `agentBrowser/streams.ts` (125, 146), `agentBrowser/toolServers.ts` (165)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/agent-browser.txt`

`browsers.ts:318, 534` are the message and nothing else today: each gets words of its own and the kind. `browsers.ts:343` keeps `state`. `agentBrowser.ts:317` (`error.state`, a typed field) and `browsers.ts:522` (a string code) stay.

- [ ] **Step 1: Red.** Delete `agent-browser.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/services/agentBrowser`. Expected: FAIL: the guard on 20 hits in 8 files, the rewritten lines. Commit `test(cli): the agent browser's failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command plus `src/backendSocket.agentBrowser.spec.ts src/core/agentBrowserLink.spec.ts`, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the agent browser names a failure's kind`.

### Task 15: lib: platform

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `lib-platform.txt`.

**Files:**
- Modify, under `cli/src/lib/`: `windows/ptyUpdate.ts` (191, 246, 249, 278, 342, 379, 387, 418, 432, 500; `message`, 80), `windows/cliVersions.ts` (102, 159), `ptyHost/drain.ts` (192), `ptyHost/launch.ts` (236, 625), `ptyHostBackend.ts` (443, 460), `terminalBackendCoordinator.ts` (32), `terminalBackendRecovery.ts` (28), `tmux.ts` (236, 469), `selfUpdate.ts` (542, 882, 894, 897), `nodeMigration.ts` (51), `launchers.ts` (44)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/lib-platform.txt`

Not mechanical:
- **`selfUpdate.ts:894`, `windows/ptyUpdate.ts:246`.** `describeSpawnLockFailure(error)` takes the error. The line keeps who holds the lock by handing the function a field: `error instanceof SpawnLockBusyError && error.owner ? describeSpawnLockOwner(error.owner) : errorKind(error)`. `lib/daemonSpawnLock.ts` is not edited.
- **`windows/ptyUpdate.ts:219`** (`error.reason`) stays: the guard does not read `.reason` (answer 6), and Task 20 lists it.
- **`launchers.ts:44`, `ptyHost/launch.ts:625`** keep no path. `bin\<name>` and a version are Harness's own names and stay.
- `selfUpdate.ts:804, 832, 839` (`why`, `result.detail`) are stored strings and stay.

- [ ] **Step 1: Red.** Delete `lib-platform.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/lib/windows/ptyUpdate. src/lib/windows/cliVersions. src/lib/ptyHost/drain. src/lib/ptyHost/launch. src/lib/ptyHostBackend. src/lib/terminalBackendCoordinator. src/lib/terminalBackendRecovery. src/lib/tmux. src/lib/selfUpdate. src/lib/nodeMigration. src/lib/launchers.` (a filter is a part of the spec's path: `src/lib/tmux.` runs `tmux.spec.ts` and `tmux.*.spec.ts`, not `tmuxBackend`). Expected: FAIL: the guard on 27 hits in 11 files, the rewritten lines. Commit `test(cli): the update and terminal host failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: updates, the terminal host and tmux name a failure's kind`.

### Task 16: lib: folders

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `lib-folders.txt`.

**Files:**
- Modify, under `cli/src/lib/`: `e2ee/deviceLogSyncer.ts` (309, 317, 346, 522, 691, 964, 1213), `e2ee/groupSyncer.ts` (369, 387), `e2ee/machinePeers.ts` (117), `sessionSearch/external.ts` (68, 103, 231), `sessionSearch/externals/index.ts` (87), `sessionSearch/indexer.ts` (227, 284, 435), `connectors/agents.ts` (365), `connectors/elsewhere.ts` (208), `connectors/vaultSync.ts` (208), `autonomous-device/dump.ts` (57), `autonomous-device/parts.ts` (14)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/lib-folders.txt`

`autonomous-device/dump.ts:57` keeps no path. `connectors/renew.ts:33` (`error.detail`) is not this task's: the guard does not read `.detail` (answer 6), and Task 20 lists it.

- [ ] **Step 1: Red.** Delete `lib-folders.txt`; rewrite the expectations. Run `npx vitest run src/architecture.failureLogs.spec.ts src/lib/e2ee src/lib/sessionSearch src/lib/connectors src/lib/autonomous-device`. Expected: FAIL: the guard on 22 hits in 11 files, the rewritten lines. Commit `test(cli): the key sync, search and connector failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: the key sync, search and the connectors name a failure's kind`.

### Task 17: lib: the files in `lib/`

**Depends on:** 1, 2. **Effort:** `high`. **Red test:** the guard without `lib.txt`.

**Files:**
- Modify, under `cli/src/lib/`: `apiConnections.ts` (128), `attachTranscript.ts` (286), `commander.ts` (1245), `deleteAgentFallback.ts` (116), `disposableOneShotPool.ts` (278), `engineBin.ts` (438), `engineLaunch.ts` (1489), `gitProject.ts` (393, 524), `gridAttach.ts` (108, 131, 160, 240; `msg`, 84), `hookRoutes.ts` (27), `hostTheme.ts` (60), `keepAbandonedConversation.ts` (44), `peerAccount.ts` (62), `questionController.ts` (277), `remoteRelay.ts` (593), `restartAgent.ts` (186), `restoreAgents.ts` (599, 1023), `resumeAgentService.ts` (70, 194), `routeDecide.ts` (286; `why`, 127), `runtimeProfileState.ts` (98, 414), `sessionInput.ts` (662), `terminalAgentReconciler.ts` (310), `voiceRouter.ts` (491)
- Modify, by hand: `attachTranscript.ts` (252), `openrouter.ts` (152-154; `errorToken` stays for the response body), `sqliteThread.ts` (166), `terminalAgentReconciler.ts` (136) (answer 4); `createAgentPane.ts` (190): `[agent] create … not saved · …` gains ` · ${errorKind(error)}`, a save that failed with no kind
- Test: the specs beside each, and `services/router.spec.ts` (line 212 asserts `lib/routeDecide.ts`'s line)
- Not this task's: `lib/registry*.ts` (3), `lib/retainExitedSession.ts`, `lib/daemonState.ts` (4), `lib/sessionSync.ts` (5), `lib/daemonLaunch.ts` (8), Task 15's and Task 16's files
- Delete: `cli/src/architecture.failureLogs.pending/lib.txt`

Not mechanical:
- **`voiceRouter.ts:491`.** `failureOf(err)` takes the error. The line keeps the one-shot's category and stderr size by reading `failure` and `stderrBytes` at the line, beside `errorKind(err)`; `failureOf` goes.
- **`resumeAgentService.ts:70`** keeps `reason` (a typed `kind`) and takes `errorKind(error)` for `said`. The file is held to 100% (`npm run test:resume`).
- **`gitProject.ts:393`** logs git's stderr through `gitReason`: the kind instead. **524**, `attachTranscript.ts:286`, `hookRoutes.ts:27` keep no path.
- `gridAttach.ts:165, 176` are stored strings and stay.

- [ ] **Step 1: Red.** Delete `lib.txt`; rewrite the expectations (`services/router.spec.ts:212` becomes the kind of the error that test throws). Run `npx vitest run src/architecture.failureLogs.spec.ts src/services/router.spec.ts` with, for each file above, `src/lib/<name>.` (the dot keeps `src/lib/tmux.` from running `tmuxBackend`). Expected: FAIL: the guard on 30 hits in 23 files, the rewritten lines. Commit `test(cli): lib's failure lines are no longer excused (red)`.
- [ ] **Step 2: Change** the lines.
- [ ] **Step 3: Check** with the step 1 command, `npm run typecheck`, and the grep. Expected: PASS.
- [ ] **Step 4: Commit** `Daemon logs: restore, resume, the worktrees and the routers name a failure's kind`.

### Task 18: End-to-end expectations

**Depends on:** 3 to 17. **Effort:** `high`. **Red test:** none committed: test code only, one commit. Its red run is the files below failing on the swept tree, seen and reported.

**Files:**
- Modify, under `cli/e2e/`: `services.e2e.ts`, `robustness.e2e.ts`, `fleet.e2e.ts`, `wifiDevice.e2e.ts`, `accountRoutes.e2e.ts`, `deviceRoutes.e2e.ts`, `keyRoutes.e2e.ts`, `engineSubmission.e2e.ts`, `devicesProcess.e2e.ts`, `updateHostile.e2e.ts`, `eagerIdentity.e2e.ts`, `enginehomes.e2e.ts`, `lean.e2e.ts`, and any other file under `cli/e2e` the search below finds

What they assert today, and where it comes from:

| Assertion | Lines |
|---|---|
| `… failed · injected fault: <name>`, `… did not start · injected fault: <name>` | `grep -n "injected fault" e2e/*.ts`: 28 lines in 9 files |
| `binding held · Conversation identity is held: <reason>` | `eagerIdentity.e2e.ts:73`, `enginehomes.e2e.ts:577, 646` |
| `[engine screens] unavailable · …core-legacyScreen-`, `[engine amp] unavailable · …core-inProcess-` | `lean.e2e.ts:261, 263` |
| `did not let go (a teardown step that throws) — handing over all the same` | `updateHostile.e2e.ts:497` |
| `dropped (N faults in a minute: injected fault: dial.E2E-A)`, `dropped (flooding the port: …)` | `devicesProcess.e2e.ts:325, 350` |

- An assertion that read a message off the log reads the line's own words and the kind: `[service search] touch failed · Error`.
- A test that told two causes apart by the message tells them apart where the product shows it: a binding's hold reason is on the agent's row, which clients are sent. Where nothing else shows it, the test waits on the kind and says so in a comment.
- No assertion is dropped.

- [ ] **Step 1: Search** `cli/e2e` for each changed line: the table's greps, then `git diff --unified=0 "$(git merge-base HEAD origin/main)" -- src | grep '^-.*\(console\.\|log(\|warn(\|error(\)'` for the old lines, and each one's fixed words in `e2e/`.
- [ ] **Step 2: Run** three of the files on the swept tree, `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/services.e2e.ts e2e/updateHostile.e2e.ts e2e/eagerIdentity.e2e.ts`. Expected: FAIL on the old text. The suite runs its own daemons under throwaway homes, a private tmux server and fake engines.
- [ ] **Step 3: Rewrite** the assertions.
- [ ] **Step 4: Run** every changed file the same way. Expected: PASS, or a failure that the same file shows on `origin/main`, named in the report.
- [ ] **Step 5: Commit** `test(cli): the end-to-end suite reads a failure's kind off the log`.

### Task 19: The guard keeps no pending list

**Depends on:** 3 to 17. **Effort:** `medium`. **Red test:** none: test code only, one commit.

**Files:**
- Modify: `cli/src/architecture.failureLogs.spec.ts` (the list-reading code and its two cases go)
- Delete: `cli/src/architecture.failureLogs.pending/` if anything is left of it
- Modify: each spec a sweep task reported as `cross-area`, for the reported lines alone
- Modify: a source file the guard still reports that no task named (expected: none)

- [ ] **Step 1: Check** that `src/architecture.failureLogs.pending/` is empty or gone. A list still there names a task that did not finish: stop and report it.
- [ ] **Step 2: Delete** the list-reading code, `a pending line excuses its file's hits and no more` and `every pending line names a file with exactly that many hits`; the header comment no longer names this plan's lists.
- [ ] **Step 3: Apply** each reported `cross-area` line.
- [ ] **Step 4: Run** `npx vitest run src/architecture.failureLogs.spec.ts src/architecture.spec.ts` and the specs of step 3, then `npm run typecheck`. Expected: PASS, the terminal list the guard's only exception. A hit left in a file no task named is fixed here by "How a line changes" and named in the report.
- [ ] **Step 5: Commit** `The failure-log guard excuses nothing but a command's own output`.

### Task 20: The follow-up list

**Depends on:** 19. **Effort:** `medium`. **Changes no code and commits nothing**: its report is the list the spec asks the final report to carry.

**Files:** none.

- [ ] **Step 1: List** every log call under `cli/src` (the guard's scan, terminal list left out) that prints content not read from an error at the line, as `file:line · category · the line's fixed words`:
  - **a stored string**: a `.detail`, `.reason`, `.message` or `.error` of a result, a reply, a launch state or a hold;
  - **a process's output**: `stderr`, `stdout`;
  - **a path or URL**: a `cwd`, a folder, a file, a socket, a worktree, a home;
  - **a peer's or the backend's error string**: `payload.error`, `body.error`, `reply.error`;
  - **an error's stored field**: `.reason`, `.detail`, `.stderr`, `.stdout` or `.path` read off a caught error, which this branch's guard does not read (answer 6).
- [ ] **Step 2: Start from the lines this plan left**: an error's stored field, `lib/windows/ptyUpdate.ts:219` (`error.reason`) and `lib/connectors/renew.ts:33` (`error.detail`), then any other the search below finds on an error (`grep -rnE "\b(e|err|error|ex|exception|\w+(Error|Err))\)?\.(reason|detail|stderr|stdout|path)\b" src --include='*.ts'` among the log calls); and the rest, then search for the rest (`grep -rnE "(console\.(log|warn|error)|\b(log|warn|error)\??\.?\()" src --include='*.ts'` narrowed by `\.(detail|reason|message|error|stderr|stdout)\b|\$\{[^}]*(cwd|[Pp]ath|[Ff]ile|[Dd]ir|[Ff]older|[Uu]rl|home)[^}]*\}`): `hookServer.ts:606, 742, 893, 950`; `backendSocket.ts:1068`; `core/main.ts:3424`; `lib/registry.ts:1658`; `lib/selfUpdate.ts:804, 832, 839`; `lib/gridAttach.ts:165, 176`; `lib/gridWindowsPin.ts:40`; `lib/runtimeInstall.ts:368`; `services/sharedMachines.ts:250`; `services/handoffRequest.ts:47`; `cable/cableHost.ts:431, 434, 480`; `orchestrator/service.ts:447`; `gateway/start.ts:327`; the cable lines that name a serial port.
- [ ] **Step 3: Report** the list with its count by category, and beside it the typed fields the sweep kept at a line (`error.code`, `error.state`), for the follow-up's reviewer. The report says the follow-up extends the guard to the five stored fields and moves its two `passes` cases for them to `finds`.

---

## The pull request's body

- What it helps someone do, in the root `AGENTS.md` words: rule 7 (no personal content in logs, which Export logs now sends off the machine) and rule 6 (a failure has a name).
- The guard's red run on the base: the hit count by list (Task 2's report). Each sweep task's red and green commits.
- Platforms: the CLI daemon on macOS, Linux and Windows; daemon TypeScript only; local checks ran on macOS.
- The answers that changed behaviour: Task 8 (`lib/daemonLaunch.ts`, answer 1), the crash lines (answer 2), and the guard leaving an error's `.reason`, `.detail`, `.stderr`, `.stdout` and `.path` to the follow-up (answer 6).
- The `harness-local-checks` fence from Verification, the CLI end to end run's link, and Task 20's list.
- `architecture.coreFiles.txt` is unchanged: `lib/log.ts` was already the core's.

## Verification

**End-to-end checks of the feature: none.** The change is the text of daemon log lines. No screen, command, protocol frame or stored file changes, so there is nothing for a person to watch; the helper's tests, the guard and the line tests of Tasks 3, 7, 8 and 9 pin it.

**One regression run, because the end-to-end suite reads the log** (answer 3, approved). After Tasks 18 and 19, on the pushed branch, once: **Actions → CLI end to end → Run workflow** on `fix/log-failure-kinds` (`gh workflow run cli-e2e.yml --ref fix/log-failure-kinds`), the repo's own workflow (`.github/workflows/cli-e2e.yml`, eight Linux shards and the macOS full-disk job). Each shard starts its own daemons from one bundle under throwaway homes, with private tmux servers, fake engines and the suite's fake backend: no account, no production, nobody's own login. Expected: `e2e-summary` passes. The suite is advisory: a file that fails here and in `main`'s latest nightly run is not this branch's; every file Task 18 changed must pass. The run's link goes in the pull request. No temporary workflow is needed.

**Required local checks, which PR CI does not run.** From a clean tree at the final commit, on a Mac: `python3 scripts/local-checks.py --run`. It selects by path; expected here: `cli-core` (`npm run test:core`: the branch changes `src/core`, `src/services` and `lib/log.ts`, which the core loads), `cli-harnessd`, `cli-orchestrator`, `cli-resume`, `cli-portability`, `cli-local-models`, `cli-pty`, `cli-shell`. Its fence goes in the pull request body before the pull request is marked ready.

**PR CI:** `cli-typecheck`, `cli-tests`, and the suites that read `cli/` (`companions`, `pty-checks`), by the automatic run alone.
