# Background commands a harness still runs: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave; each task commits its failing
> test, then the code). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harness show`, `wait` and `watch` say how many background commands an idle harness still runs and treat one
with any running as not finished; `harness close` without `--now` and the cleanup's idle close leave it open (the
cleanup for at most two hours).

**Architecture:** The count is read on demand, in the daemon's reply to `agent_close` `inspect`, by a dispatcher in
`cli/src/lib/` that asks the engine's own module: Hermes's list of running processes, or Claude Code's command shells
among the engine's direct children in one shared `ps` read. The client verbs read the new reply field. The cleanup's
idle close carries a rule only `CoreApi.agents.closeStarted` can set. No frame field, no poll, no app or backend
change.

**Tech Stack:** TypeScript (`cli/src`, Node 24), vitest, `ps`, SQLite through `lib/sqliteRead.ts`, tmux for the end to
end. No new dependency.

**Spec:** [docs/plans/2026-11-12-background-count-design.md](2026-11-12-background-count-design.md) (issue #4194,
second ask). Read it with this plan, and `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`,
`docs/naming-system.md`. The spec is the authority, its "(our call)" decisions included.

## Global Constraints

- One name on every surface: `backgroundCommands: number | null` (the `inspect` reply, `show`/`wait`/`watch` JSON, a
  close's result). `null` is "Harness cannot know" and never blocks anything. Never `0` when unknown.
- What is counted, as this plan builds it (the last two rows differ from the spec's table: see Shapes confirmed and
  Open question 1):

  | Engine | Count |
  |---|---|
  | Hermes, every platform | entries of `<hermes home>/processes.json` whose `session_key` is the harness's session id or one of its ancestors (`sessions.parent_session_id` in the same home's `state.db`, at most 32 up). No file, an entry without the `session_key` field, an unreadable or malformed file or store, more than 1 MiB or 1,024 entries, a session the store does not hold: `null`. An empty `session_key` is not counted. The file is trusted: no pid check. |
  | Claude Code, macOS and Linux | the engine process's direct children whose argv is `<shell> -c …` naming `/shell-snapshots/snapshot-`. Windows, an engine process not found, a table that cannot be read: `null`. |
  | Codex, OpenClaw (`--local` and Gateway) | `null` |
  | every other engine, cloud harnesses, terminals | `null` |

- Read on demand only: no frame field, no timer, no cache, no Desktop, phone, web or backend change. `agent_close`'s
  `idle` and `after_task` modes keep today's rule for every caller but the cleanup.
- Exact copy: `1 background command running` · `N background commands running` ·
  `<name>: N background commands running; --now closes anyway` (`now: true` in place of `--now` through MCP) ·
  next step `harness wait <name>  (until its background commands end)`.
- Copy this plan adds (the spec left it open): the `watch` text line `<time> <name>: background: N background commands
  running`; `wait`'s timeout line `<name>: timeout · N background commands running; wait again or read it: …`; the
  two cleanup log lines in Task 6.
- Constants: `BACKGROUND_CLOSE_MS = 2 * 60 * 60_000` (services/agentCleanup.ts); `HERMES_PROCESSES_MAX_BYTES = 1 << 20`,
  `HERMES_PROCESSES_MAX_ENTRIES = 1_024`, `HERMES_ANCESTORS_MAX = 32` (engines/hermes/backgroundCommands.ts).
- A log line carries a count, never command text, a path or a session id.
- Where code goes: per-engine knowledge in `cli/src/engines/<engine>/`; the dispatcher in `cli/src/lib/`; the close
  service gets it as a dependency; `core/main.ts` gains wiring only. Hermes's code is reached only through
  `engines/inProcess.ts` (`loadEngine('hermes')`): `src/architecture.spec.ts` fails a static import of it from the
  core. The cleanup (edge host) imports nothing heavier than `lib/backgroundSaid.ts`.
- `cli/src/core/**` and `cli/src/services/**` stay at 100% per file: every branch a task adds there is covered by
  that task's own spec.
- Tests never touch the real `~/.harness`, `~/.claude`, `~/.hermes`, the daemon on 18473 or the real tmux server. No
  fixed sleeps.
- Compatibility: a daemon from before this answers `inspect` without the field, which the client reads as `null`. A
  core from before this ignores the cleanup's `pastCeiling`; a cleanup from before this never sends it.
- Platforms the pull request names: macOS and Linux (Claude Code's count), every platform (Hermes's), Windows reads
  `null` for Claude Code.

## Shapes confirmed (read-only, on this Mac, 2026-11-12)

**Claude Code 2.1.322, macOS (Darwin 25.6), zsh 5.9.** `ps -axo pid=,ppid=,args=` under this session's own engine,
while its Bash tool held `sleep 40` with `run_in_background` (home and command replaced; the config folder's path
has a space in it):

```
31097 30612 claude --plugin-dir <dir> --dangerously-skip-permissions --resume <id> --fork-session
 1850 31097 /bin/zsh -c source '<config>/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh' 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'which'; \builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval 'sleep 40' < /dev/null && pwd -P >| /tmp/claude-9e33-cwd
 1858  1850 sleep 40
31143 31097 <home>/.codegraph/versions/v1.6.2/node --liftoff-only --disable-warning=ExperimentalWarning <home>/.codegraph/versions/v1.6.2/lib/dist/bin/codegraph.js serve --mcp
98996 31097 caffeinate -i -t 300
```

A foreground command has the same argv. The wrapper ends with `&& pwd -P >| …`, so the shell stays for as long as
the command runs. A pipeline's subshells carry the same argv with the snapshot shell as their parent (seen: three
under one), so only direct children are counted.

**Hermes** (the checkout at `~/.hermes/hermes-agent`, pyproject 0.20.1, commit `56a41715d`). `tools/process_registry.py`
`_write_checkpoint` writes a JSON array of the processes still running, each entry with these keys: `session_id` (the
process's own id, not a conversation's), `command`, `pid`, `pid_scope`, `host_start_time`, `systemd_unit`, `cwd`,
`started_at`, `task_id`, `session_key`, `watcher_platform`, `watcher_chat_id`, `watcher_user_id`, `watcher_user_name`,
`watcher_thread_id`, `watcher_message_id`, `watcher_interval`, `parent_session_id`, `notify_on_complete`,
`watch_patterns`. `cli.py` and `tui_gateway/server.py` set the key to the session's id; `hermes_state.py` keeps
`sessions.parent_session_id`. This Mac has no `processes.json` (Hermes ran no background process here), so the fixture
is built from the writer.

**Codex 0.167.1** (no Codex TUI was running; read from the source at tag `rust-v0.167.1`). `--no-daemon` runs the app
server in the TUI's process (`tui/src/lib.rs`, `InProcessAppServerClient`), so a command is the `codex` process's
direct child. Its argv is `[<shell>, "-lc" | "-c", <command>]` (`core/src/shell.rs` `derive_exec_args`), under
`/usr/bin/sandbox-exec -p <policy> -D<k>=<v>… -- …` on macOS (`sandboxing/src/seatbelt.rs`) or `codex-linux-sandbox
--sandbox-policy-cwd … --permission-profile … -- …` on Linux, which may replace itself with `bwrap`
(`linux-sandbox/src/linux_run_main.rs`).

**OpenClaw 2026.11.2** (`/opt/homebrew/lib/node_modules/openclaw/dist`). The exec tool's argv is `[<shell>, …args,
<command>]`: `-f -c` for zsh, `--noprofile --norc -c` for bash, `-c` for any other (`shell-utils` `getPosixShellArgs`,
`bash-tools.exec-runtime` `prepareHostExecSpawn`). In a `--local` run it is the TUI's direct, detached child, or runs
under `node …/dist/process/supervisor/service-child-relay.js` when a scope needs its process tree cleaned up.

**Why Codex and OpenClaw read `null` here.** A shell given one simple command replaces itself with it, so the
engine's child is then the command, with nothing in its argv to tell it from an MCP server:

```
/bin/zsh -lc 'sleep 3'                      ->  sleep 3
/bin/zsh -f -c 'sleep 3'                    ->  sleep 3
/bin/zsh -lc 'cd /tmp && sleep 3'           ->  sleep 3
/bin/bash --noprofile --norc -c 'sleep 3'   ->  sleep 3
/bin/sh -c 'sleep 3'                        ->  sleep 3
/bin/bash -lc 'sleep 3'                     ->  /bin/bash -lc sleep 3
/bin/zsh -lc 'sleep 3 && echo done'         ->  /bin/zsh -lc sleep 3 && echo done
```

(zsh 5.9, bash 3.2.57, `ps -o args=` 0.7 s after the start.) Counting `<shell> -c` children would read `0` for
`npm run dev` or `cd app && make`, the common case, which the spec's first anti-goal forbids. The spec's own rule
applies: "an engine whose shape cannot be pinned stays `null`". Open question 1.

## Review Focus

Failure modes the spec implies that are most likely to bite, each pinned by a test in the task that owns the code:

1. **One command counted several times.** A background pipeline's subshells carry the snapshot shell's argv.
   Expected: one command, one count; another harness's shells are not counted. Task 5.
2. **`0` where Harness could not look.** The engine process is gone from the table, its pid was reused, or `ps`
   failed. Expected: `null`, and the count's reader is never what makes a close or an inspect fail. Tasks 3 and 5.
3. **A daemon and a client of different builds.** No field, or one that is not a whole number (`"2"`, `-1`, `1.5`).
   Expected: `null`, and every verb behaves as today. Task 4.
4. **`harness close` now looks first.** A working harness, a screen that cannot be read, a harness on another
   machine. Expected: today's answers, word for word, and the close is still sent. Task 4.
5. **A `processes.json` that is not what Hermes writes.** Entries that are not objects, a file past 1 MiB, a parent
   loop in the store. Expected: `null` or a bounded count, never a throw or a walk without end. Task 2.

## Files

| File | What changes | Task |
|---|---|---|
| `cli/src/engines/claude/backgroundCommands.ts` (new) | Claude Code's rule over an engine's direct children | 1 |
| `cli/src/engines/hermes/backgroundCommands.ts` (new), `engines/hermes/inProcess.ts` | Hermes's bounded read of its list and its session chain | 2 |
| `cli/src/lib/closeAgentService.ts` | the `inspect` reply's field; the cleanup's `refuse` and `count` rules | 3 |
| `cli/src/lib/backgroundSaid.ts` (new), `cli/src/agentClient/commands.ts`, `agentClient/mcp.ts`, `docs/cli.md`, `docs/design/2026-10-11-agent-client.md` | the words; `show`, `wait`, `watch`, `close`; their docs | 4 |
| `cli/src/lib/backgroundCommands.ts` (new) | the dispatcher | 5 |
| `cli/src/core/api.ts`, `core/agentCleanupLink.ts`, `services/agentCleanupProcess.ts`, `services/agentCleanup.ts`, `docs/design/2026-10-11-agent-client.md` | the cleanup's refusal and its two-hour ceiling | 6 |
| `cli/src/core/agents/close.ts` | the dependency handed to the close service | 7 |
| `cli/src/core/main.ts`, `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/backgroundCommands.e2e.ts` (new) | wiring, a faithful background command in the fake engine, the end to end, the cost | 8 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 Claude Code's count · 2 Hermes's count · 3 Close service · 4 Client verbs |
| 2 | 5 Dispatcher · 6 Cleanup ceiling · 7 Core close dependency |
| 3 | 8 Wiring and end to end |

Every command below runs from `cli/`.

---

### Task 1: Claude Code's count

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Create: `cli/src/engines/claude/backgroundCommands.ts`
- Test: `cli/src/engines/claude/backgroundCommands.spec.ts`

**Interfaces (produces):**
`claudeBackgroundCommands(children: readonly Pick<ProcessRow, 'args'>[]): number`: how many of an engine's direct
children are the shells Claude Code's Bash tool runs.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest'
import { claudeBackgroundCommands } from './backgroundCommands.js'

// Claude Code 2.1.322, macOS, zsh 5.9: `ps -axo pid=,ppid=,args=` under one engine, 2026-11-12 (home and command replaced).
const SHELL = "/bin/zsh -c source '/Users/u/Library/Application Support/claude/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh' 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval 'sleep 40' < /dev/null && pwd -P >| /tmp/claude-9e33-cwd"
const MCP = '/Users/u/.codegraph/versions/v1.6.2/node --liftoff-only --disable-warning=ExperimentalWarning /Users/u/.codegraph/versions/v1.6.2/lib/dist/bin/codegraph.js serve --mcp'
const CAFFEINATE = 'caffeinate -i -t 300'
const rows = (...args: string[]) => args.map((a) => ({ args: a }))

it('counts the shells its Bash tool runs, and none of its helpers', () => {
  expect(claudeBackgroundCommands(rows(SHELL, MCP, CAFFEINATE, SHELL))).toBe(2)
  expect(claudeBackgroundCommands(rows(MCP, CAFFEINATE))).toBe(0)
  expect(claudeBackgroundCommands([])).toBe(0)
})

// Not recorded: the rule reads only the shell's name, `-c` and the snapshot's path, so bash on Linux reads the same.
it('takes the same wrapper under another shell', () => {
  expect(claudeBackgroundCommands(rows("/bin/bash -c source '/home/u/.claude/shell-snapshots/snapshot-bash-1794472199641-ab12cd.sh' 2>/dev/null || true && eval 'npm test' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"))).toBe(1)
})

it('leaves out a shell that is not its Bash tool\'s, and a program that only names a snapshot', () => {
  expect(claudeBackgroundCommands(rows(
    '/bin/sh -c /Users/u/.harness/hook/notify.sh',                                  // a hook: a shell, no snapshot
    "/bin/zsh -lic . '/Users/u/.harness/cli/data/launch/x.sh' harness-engine",      // no -c of its own
    'cat /Users/u/.claude/shell-snapshots/snapshot-zsh-1794472199641-2xja85.sh',    // names one, is no shell
    'node /opt/tool/shell-snapshots/snapshot-reader.js -c x',
  ))).toBe(0)
})
```

- [ ] **Step 2:** `npx vitest run src/engines/claude/backgroundCommands.spec.ts` → FAIL (no such module).
- [ ] **Step 3: Implement.** A row counts when its first word's program name (`programName`, lib/processTable.ts) is
  one of `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`; `-c` is among the option words that directly follow it (read at
  most three); and its text contains `/shell-snapshots/snapshot-`. Read the head of `args` with one anchored regular
  expression: never tokenise the command. The file's comment names the recording above and why helpers must read 0
  (the cleanup would never close a Claude Code harness).
- [ ] **Step 4:** the same command → PASS.
- [ ] **Step 5:** Commit the spec, then the code.

### Task 2: Hermes's count

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/engines/hermes/backgroundCommands.ts`
- Modify: `cli/src/engines/hermes/inProcess.ts` (two re-exports)
- Test: `cli/src/engines/hermes/backgroundCommands.spec.ts`

**Interfaces (produces):**
- `hermesBackgroundCommands(home: string, sessionId: string): Promise<number | null>`, and the three constants in
  Global Constraints. It never throws.
- `engines/hermes/inProcess.ts` re-exports `hermesBackgroundCommands`, and `hermesHomeForSession` from
  `../../lib/hermesHome.js` beside `hermesDbForSession`.

- [ ] **Step 1: Write the failing test.** Build the store with the `sqlite3` CLI as `home.spec.ts` does
  (`describe.skip` without it), in a `mkdtemp` folder removed after each test.

```ts
const OLD = '20261112_090000_aaaaaa', LIVE = '20261112_100000_bbbbbb', OTHER = '20261112_110000_cccccc'
/** One entry as Hermes' `_write_checkpoint` writes it (tools/process_registry.py); `key` undefined: an older format. */
const entry = (key: string | undefined, id: string) => ({ session_id: id, command: 'npm run build', pid: 4242, pid_scope: 'host',
  host_start_time: 1794472199.5, systemd_unit: null, cwd: '/work/app', started_at: 1794472200.1, task_id: 't1',
  ...(key === undefined ? {} : { session_key: key }), watcher_platform: '', watcher_chat_id: '', watcher_user_id: '',
  watcher_user_name: '', watcher_thread_id: '', watcher_message_id: '', watcher_interval: 0, parent_session_id: '',
  notify_on_complete: true, watch_patterns: [] })
/** A home whose store holds [sessions] (id, parent) and, when given, a `processes.json` with [processes] as its text. */
function home(sessions: Array<[string, string | null]>, processes?: string): string
// CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT);

it('counts its own and the session it was compressed from, and nothing of another session', async () => {
  const h = home([[OLD, null], [LIVE, OLD], [OTHER, null]],
    JSON.stringify([entry(LIVE, 'proc_1'), entry(OLD, 'proc_2'), entry(OTHER, 'proc_3'), entry('', 'proc_4')]))
  expect(await hermesBackgroundCommands(h, LIVE)).toBe(2)
  expect(await hermesBackgroundCommands(h, OTHER)).toBe(1)
  expect(await hermesBackgroundCommands(h, OLD)).toBe(1)   // a child is not an ancestor
})

it('reads 0 from a list Hermes has emptied, and null where it never wrote one', async () => {
  expect(await hermesBackgroundCommands(home([[LIVE, null]], '[]'), LIVE)).toBe(0)
  expect(await hermesBackgroundCommands(home([[LIVE, null]]), LIVE)).toBeNull()
})

it('is null, never 0, for what it cannot read', async () => {
  const of = (text: string) => hermesBackgroundCommands(home([[LIVE, null]], text), LIVE)
  expect(await of(JSON.stringify([entry(undefined, 'proc_1')]))).toBeNull()   // no session_key field
  for (const text of ['{}', 'not json', '[null]', '[3]', `[${' '.repeat(HERMES_PROCESSES_MAX_BYTES)}]`]) expect(await of(text)).toBeNull()
  expect(await of(JSON.stringify(Array.from({ length: HERMES_PROCESSES_MAX_ENTRIES + 1 }, (_, i) => entry(LIVE, `proc_${i}`))))).toBeNull()
  expect(await hermesBackgroundCommands(home([[OTHER, null]], '[]'), LIVE)).toBeNull()   // the store does not hold it
  const bare = mkdtempSync(join(tmpdir(), 'hm-none-'))                                    // a list, and no store
  writeFileSync(join(bare, 'processes.json'), '[]')
  expect(await hermesBackgroundCommands(bare, LIVE)).toBeNull()
  expect(await hermesBackgroundCommands(home([[LIVE, null]], '[]'), 'not-an-id')).toBeNull()
})

it('walks at most 32 sessions up, and ends on a parent loop', async () => {
  const id = (i: number) => `20261112_1200${String(i).padStart(2, '0')}_abcdef`
  const chain: Array<[string, string | null]> = Array.from({ length: 41 }, (_, i) => [id(i), i ? id(i - 1) : null])
  const h = home(chain, JSON.stringify([entry(id(8), 'proc_in'), entry(id(7), 'proc_out')]))   // 32 and 33 above id(40)
  expect(await hermesBackgroundCommands(h, id(40))).toBe(1)
  const loop = home([[OLD, LIVE], [LIVE, OLD]], JSON.stringify([entry(OLD, 'proc_1')]))
  expect(await hermesBackgroundCommands(loop, LIVE)).toBe(1)
})
```

- [ ] **Step 2:** `npx vitest run src/engines/hermes/backgroundCommands.spec.ts` → FAIL (no such module).
- [ ] **Step 3: Implement.** In this order, any failure answering `null`: the id must match `HERMES_HISTORY_ID_RE`;
  read `join(home, 'processes.json')`, at most `HERMES_PROCESSES_MAX_BYTES` (a longer file is `null`; `ENOENT` is
  `null`); parse; it must be an array of at most `HERMES_PROCESSES_MAX_ENTRIES` objects that each have a string
  `session_key`; read the chain in ONE statement through `sqliteReadAll(hermesDbPath(home), …, [sessionId],
  { maxBuffer: 1 << 16 })`; a chain with no row is `null`; count the entries whose non-empty key is in the chain.

```sql
WITH RECURSIVE chain(id, depth) AS (
  SELECT id, 0 FROM sessions WHERE id = ?
  UNION ALL
  SELECT s.parent_session_id, chain.depth + 1 FROM sessions s JOIN chain ON s.id = chain.id
  WHERE s.parent_session_id IS NOT NULL AND chain.depth < 32
)
SELECT id FROM chain;
```

  The comment says why the file is trusted (host pids cannot be checked from outside a pid namespace; Hermes adopts
  them back from this file) and why no file is `null`.
- [ ] **Step 4:** the same command → PASS.
- [ ] **Step 5:** Commit the spec, then the code.

### Task 3: Close service

**Depends on:** nothing. **Effort:** xhigh (it decides whether a harness's process tree is ended, across queued jobs).

**Files:**
- Modify: `cli/src/lib/closeAgentService.ts` (types :24-26, `jobKey` :97, deps :108, `attempt` :288-380)
- Test: `cli/src/lib/closeAgentService.spec.ts`

**Interfaces (produces):**
- `AgentCloseRequest` gains `background?: 'refuse' | 'count'`: only with `mode: 'idle'`. `refuse`: refused while any
  background command runs. `count`: closed whatever runs, the answer carrying the count. Absent: today's rule.
- `AgentCloseResult` gains `backgroundCommands?: number | null`.
- `CloseAgentServiceDeps` gains `backgroundCommands?(s: RegisteredSession): Promise<number | null>`.

- [ ] **Step 1: Write the failing tests** (the file's `deps`, `request`, `row`, `registry`):

```ts
describe('background commands', () => {
  const withCount = (count: () => Promise<number | null>) => { const backgroundCommands = vi.fn(count); return { backgroundCommands, svc: new CloseAgentService({ ...deps, backgroundCommands }) } }

  it('an inspect of an idle harness says how many it runs, and of any other says nothing', async () => {
    const { svc, backgroundCommands } = withCount(async () => 2)
    expect(await svc.request(request('inspect'))).toEqual({ activity: 'idle', backgroundCommands: 2 })
    vi.mocked(deps.activity).mockResolvedValue('working')
    expect(await svc.request(request('inspect'))).toEqual({ activity: 'working' })
    expect(backgroundCommands).toHaveBeenCalledTimes(1)
    // No reader (a build without one), no field; a reader that fails is unknown.
    expect(await service.request(request('inspect'))).toEqual({ activity: 'working' })
    vi.mocked(deps.activity).mockResolvedValue('idle')
    expect(await service.request(request('inspect'))).toEqual({ activity: 'idle' })
    expect(await withCount(async () => { throw new Error('ps') }).svc.request(request('inspect'))).toEqual({ activity: 'idle', backgroundCommands: null })
  })

  it('the cleanup\'s idle close is refused while any runs, with the count, and nothing is stopped', async () => {
    const { svc } = withCount(async () => 2)
    expect(await svc.request({ ...request('idle'), background: 'refuse' })).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'idle', backgroundCommands: 2 })
    expect(deps.stop).not.toHaveBeenCalled()
    expect(registry.byAgent(row.agentId)).toBe(row)
  })

  it.each([0, null, 'throws'] as const)('none running, or not known (%s), never blocks it', async (count) => {
    const { svc } = withCount(async () => { if (count === 'throws') throw new Error('ps'); return count })
    expect(await svc.request({ ...request('idle'), background: 'refuse' })).toEqual({ closed: true })
  })

  it('past the ceiling it closes whatever runs, and says how many', async () => {
    expect(await withCount(async () => 2).svc.request({ ...request('idle'), background: 'count' })).toEqual({ closed: true, backgroundCommands: 2 })
  })

  it('every other close never reads the count: a window\'s idle, a close now, a close after the task', async () => {
    const { svc, backgroundCommands } = withCount(async () => 5)
    expect(await svc.request(request('idle'))).toEqual({ closed: true })
    expect(backgroundCommands).not.toHaveBeenCalled()
    // Also: request('now'), `{ ...request('now'), background: 'refuse' }`, and the deferred close a tick carries out
    // (as 'automatically stops only after two timer observations of sustained idle' builds one): never called.
  })

  it('a window\'s idle close asked while the cleanup\'s reads the count is answered for itself', async () => {
    let release!: (n: number) => void
    const { svc } = withCount(() => new Promise<number>((done) => { release = done }))
    const cleanup = svc.request({ ...request('idle'), background: 'refuse' })
    const window = svc.request(request('idle'))
    await vi.waitFor(() => expect(release).toBeDefined())
    release(2)
    expect(await cleanup).toEqual({ error: 'SESSION_NOT_IDLE', activity: 'idle', backgroundCommands: 2 })
    expect(await window).toEqual({ closed: true })
  })

  it('a harness replaced while the count was read is not closed', async () => {
    const { svc } = withCount(async () => { row.sessionId = 'another'; return 0 })
    expect(await svc.request({ ...request('idle'), background: 'refuse' })).toEqual({ error: 'AGENT_CHANGED' })
    expect(deps.stop).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2:** `npx vitest run src/lib/closeAgentService.spec.ts -t "background commands"` → FAIL.
- [ ] **Step 3: Implement.**
  - `jobKey` includes `request.background`, so a job answers only a request with the same rule.
  - `inspect`: `{ activity }` unless `activity === 'idle'` and the reader exists; then
    `{ activity, backgroundCommands }`, the reader's answer or `null` when it rejects.
  - `idle` with `background`: after the existing `activity !== 'idle'` refusal, read the count (a rejection is
    `null`), check `current()` again (`AGENT_CHANGED`), and for `refuse` with a count above 0 answer
    `{ error: 'SESSION_NOT_IDLE', activity, backgroundCommands }`. Otherwise go on to the stop exactly as today; a
    close that ran under `count` with a count above 0 answers `{ closed: true, backgroundCommands }`.
  - Nothing else changes: `now`, `after_task`, `cancel`, `beforeStop`'s recheck, `tick`, `whileStarting`.
  - The comment says why only the first check reads the count: a command starts only in a turn, and a turn makes the
    activity `working`, which `beforeStop` already rechecks.
- [ ] **Step 4:** `npx vitest run src/lib/closeAgentService.spec.ts` → PASS, the tests from before included.
- [ ] **Step 5:** Commit the spec, then the code.

### Task 4: Client verbs

**Depends on:** nothing (it reads a field of the wire). **Effort:** high.

**Files:**
- Create: `cli/src/lib/backgroundSaid.ts`, `cli/src/lib/backgroundSaid.spec.ts`
- Modify: `cli/src/agentClient/commands.ts` (`inspect` :469, `showNext` :644, `showCommand` :732, `waitCommand`'s
  `look` :1209 and its lines, `WatchEvent` :1337, `EVENT_STATES` :1345, `watchCommand`'s `look` :1388, `printWatch`
  :1445, `closeCommand` :1469, `SHOW_USAGE`, `WAIT_USAGE`, `WATCH_USAGE`, `CLOSE_USAGE`), `cli/src/agentClient/mcp.ts`
  (`harness_close`'s two descriptions), `docs/cli.md`, `docs/design/2026-10-11-agent-client.md` (the `show`, `wait`
  and `close` bullets of "How it works")
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces (produces):** `backgroundSaid(n: number): string` in `lib/backgroundSaid.ts` (no imports): `1 background
command running`, else `<n> background commands running`. **Consumes:** `backgroundCommands` in the `agent_close`
`inspect` reply.

- [ ] **Step 1: Write the failing tests.** `backgroundSaid(1)` and `backgroundSaid(2)` are the two strings above. In
  `commands.spec.ts`, beside `FakeDaemon`:

```ts
/** Each inspect answers idle with the next of [counts], the last staying; `undefined`: a daemon from before the field. */
const counting = (d: FakeDaemon, counts: unknown[]) => {
  d.extra.agent_close = (payload) => {
    if (payload.mode !== 'inspect') return { closed: true }
    const n = counts.length > 1 ? counts.shift() : counts[0]
    return n === undefined ? { activity: 'idle' } : { activity: 'idle', backgroundCommands: n }
  }
}
const answeredTurn = (d: FakeDaemon, id: string) => d.pages.set(`s-${id}`, [{ events: [ev('user_message', { content: 'fix it' }), ev('tool_start'), ev('text_delta', { content: 'Fixed.' }), ev('done')], hasMore: false }])
```

  `show` (`d.frames = [frame('lead'), frame('kid')]`, `started(h.ledger, 'lead', 'kid')`, `answeredTurn(d, 'kid')`):

```ts
counting(d, [2])
expect(await showCommand(['kid'], h.deps)).toBe(EXIT.ok)
expect(h.out.slice(-2)).toEqual(['2 background commands running', 'Next: harness wait kid  (until its background commands end)'])
expect(h.out.join('\n')).not.toContain('harness close')
// --json
expect(JSON.parse(json.out[0])).toMatchObject({ state: 'idle', backgroundCommands: 2, next: [{ run: 'harness wait kid', when: 'until its background commands end' }] })
// One: '1 background command running'. None, a daemon from before the field, or a field that is no whole number:
for (const [count, read] of [[0, 0], [undefined, null], ['2', null], [-1, null], [1.5, null]] as const) {
  // text has no 'background command'; its last line is 'Next: harness close kid  (once you have what you need)';
  // --json has backgroundCommands === read
}
// Working (d.screens.set('kid', ['working']) with no `extra`): --json has no backgroundCommands key at all.
```

  `wait` (`d.frames = [frame('kid')]`, `answeredTurn(d, 'kid')`, a fresh `harness(d)` for each command):

```ts
counting(d, [1, 1, 1, 0, 0])
expect(await waitCommand(['kid'], h.deps)).toBe(EXIT.ok)
expect(d.requests.filter((r) => r.type === 'agent_close')).toHaveLength(5)   // three looks held, then two idle looks
expect(h.out).toEqual(['kid: idle · read it: harness show kid'])
// A wait that ends on them:
counting(d, [2])
expect(await waitCommand(['kid', '--timeout', '3s'], h.deps)).toBe(EXIT.timeout)
expect(h.out).toEqual(['kid: timeout · 2 background commands running; wait again or read it: harness show kid'])
// --json: harnesses[0] matches { state: 'timeout', backgroundCommands: 2, next: [{ run: 'harness wait kid', when: 'to keep waiting' }] }
// A timeout while it works keeps 'still working; …' and no backgroundCommands key.
```

  `watch`, in `describe('wait and watch on pushed events')` (its `PushingDaemon` and `answered`):

```ts
it('watch says background while commands run, again when their number changes, and done once none does', async () => {
  const d = new PushingDaemon()
  d.frames = [frame('kid')]
  answered(d, 'kid')
  counting(d, [2, 2, 1, 1, 0, 0])
  const h = harness(d)
  const slept: number[] = []
  h.deps.sleep = async (ms) => { slept.push(ms); h.advance(ms) }
  expect(await watchCommand(['kid', '--json', '--timeout', '8s'], h.deps)).toBe(EXIT.timeout)
  const said = h.out.map((l) => JSON.parse(l))
  expect(said.map((l) => [l.event, l.state, l.backgroundCommands])).toEqual([['background', 'idle', 2], ['background', 'idle', 1], ['done', 'idle', 0]])
  expect(said[0].summary).toBeUndefined()
  expect(said[2].summary).toBe('Fixed.')
  // Their end is pushed by nothing: a look every interval until it is done, then the backstop (cut by the timeout).
  expect(slept).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 3_000])
})
// Text: the first line ends 'kid: background: 2 background commands running'.
// A daemon from before the field: the events are ['done'], and its line has backgroundCommands: null.
```

  `close`, in `describe('harness close')`:

```ts
it('refuses one that still runs background commands, and sends no close', async () => {
  const d = new FakeDaemon()
  d.frames = [frame('lead'), frame('kid')]
  counting(d, [2])
  const h = harness(d)
  started(h.ledger, 'lead', 'kid')
  expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.failed)
  expect(h.err).toEqual(['kid: 2 background commands running; --now closes anyway'])
  expect(d.requests.filter((r) => r.type === 'agent_close').map((r) => r.payload.mode)).toEqual(['inspect'])
  // --json: { error: 'WORKING', detail: 'kid: 2 background commands running; --now closes anyway' }
  // env HARNESS_VIA_MCP=1: 'kid: 2 background commands running; now: true closes anyway'
  // --now: modes are ['now'] (it does not look), and it closes.
})
it('closes as before when none runs, when the daemon cannot say, and when it is not idle', async () => {
  // counting(d, [0]) and counting(d, [undefined]): modes ['inspect', 'idle'], exit 0, today's output.
  // d.screens.set('kid', ['working']) with agent_close answering { error: 'SESSION_NOT_IDLE', activity: 'working' } to
  // 'idle': modes ['inspect', 'idle'], and the error is today's 'kid is working. Wait for it (harness wait kid), or
  // close it anyway with --now.'
  // An inspect that throws (extra.agent_close throwing for 'inspect' only): the idle close is still sent.
  // With --machine: `others: { office: remote }` and the same counts on `remote`: the same answers.
})
```

- [ ] **Step 2:** `npx vitest run src/lib/backgroundSaid.spec.ts src/agentClient/commands.spec.ts -t "background"` → FAIL.
- [ ] **Step 3: Implement.**
  - `inspect` answers `{ screen: Screen | null; background: number | null }`: `background` is the reply's
    `backgroundCommands` only when the screen is `idle` and it is a whole number of 0 or more; else `null`. Its
    three callers take `screen` as before.
  - `show`: `backgroundCommands` joins the JSON whenever `state` is `idle` (`null` for a draft, a cloud harness, an
    unread screen). Above 0, the line `backgroundSaid(n)` is printed directly before `Next:`, and `showNext` answers
    `[{ run: step(env, 'wait', at), when: 'until its background commands end' }]`, then the `tell` step where it
    offered one; never `close`. Whoever started it.
  - `wait`'s `look`: idle with a count above 0 forgets its idle looks (`idle.delete(t)`), remembers the count for the
    target, and answers `null`; any other look forgets the count. A target that times out with a remembered count
    carries `backgroundCommands` in JSON and says `backgroundSaid(n)` where it said `still working`.
  - `watch`: `WatchEvent` gains `'background'` (`EVENT_STATES.background = 'idle'`). Idle with a count above 0
    answers `background` at once, with `idle = null` and `pushedNext = false`; `done` and `idle` then need their two
    idle looks without one. The printed key of a `background` line is the event and the count. `printWatch` puts
    `backgroundCommands` on every `background`, `done` and `idle` line of a harness here (the count, `0` or `null`);
    a `background` line has no `summary`, and its text is `backgroundSaid(n)`.
  - `close` without `--now`: after the ownership checks and before the close, one `inspect`; idle with a count above
    0 throws `AgentClientError('WORKING', …)` with the copy in Global Constraints and sends nothing. Anything else
    sends the `idle` close as today. `--now` does not look.
  - Usage and tool text: `WATCH_USAGE` names `background (idle, with commands it started still running: how many)`
    between `needs_person` and `done`; `CLOSE_USAGE` reads `It is refused while the harness is working or still runs
    background commands, unless --now.`; `WAIT_USAGE`'s first sentence reads `Waits until each harness has stopped
    working and the background commands it started have ended, then prints its state.`; `SHOW_USAGE` adds `, and how
    many background commands it still runs when idle`. `mcp.ts` `harness_close`: `Refused while it works or still
    runs background commands, unless now is true.` and `Close it even while it works or runs background commands.`
- [ ] **Step 4:** `npx vitest run src/lib/backgroundSaid.spec.ts src/agentClient` → PASS, the tests from before included.
- [ ] **Step 5: Docs.** `docs/cli.md`: a `background` row in the `watch` table (`idle after a turn, with background
  commands it started still running` · `backgroundCommands`; a new line each time the number changes; `done` once
  none runs), `backgroundCommands` on `done` and `idle`, and one paragraph after the table: what `show`, `wait` and
  `close` do with the count, and what is counted (the table in Global Constraints, in sentences: Hermes's own list;
  Claude Code's Bash tool on macOS and Linux; every other engine and Windows not known, shown as nothing; never MCP
  servers or other helpers; never a command that left its engine: `nohup … &` whose shell exits, `setsid`, a double
  fork). `docs/design/2026-10-11-agent-client.md`, "How it works": `show` and `wait` read `backgroundCommands` from
  `inspect`; `close` in `idle` mode inspects first and refuses on the client.
- [ ] **Step 6:** Commit the spec, then the code and docs.

### Task 5: Dispatcher

**Depends on:** Tasks 1 and 2. **Effort:** high.

**Files:**
- Create: `cli/src/lib/backgroundCommands.ts`
- Test: `cli/src/lib/backgroundCommands.spec.ts`

**Interfaces:**
- Consumes: `claudeBackgroundCommands` (Task 1); `hermesBackgroundCommands`, `hermesHomeForSession` through
  `loadEngine('hermes')` (Task 2); `processRows`, `sameProcessIdentity`.
- Produces:

```ts
export interface BackgroundCommandsDeps {
  platform?: NodeJS.Platform
  rows?: () => Promise<ProcessRow[] | null>
  hermes?: () => Promise<Pick<InProcessModules['hermes'], 'hermesBackgroundCommands' | 'hermesHomeForSession'> | null>
}
/** How many background commands [session]'s engine still runs; null when Harness cannot know. Never throws. */
export function backgroundCommands(session: Pick<RegisteredSession, 'engine' | 'agentId' | 'sessionId' | 'hermesHome' | 'processIdentity'>,
  deps?: BackgroundCommandsDeps): Promise<number | null>
```

- [ ] **Step 1: Write the failing test** (`SHELL`, `MCP` as in Task 1's spec):

```ts
const ENGINE = { pid: 500, executable: 'claude', startMarker: 'Thu Nov 12 10:00:01 2026' }
const row = (pid: number, parentPid: number, args: string): ProcessRow => ({ pid, parentPid, executable: args.split(' ')[0], startMarker: 'Thu Nov 12 10:00:02 2026', args })
const TABLE: ProcessRow[] = [
  { ...ENGINE, parentPid: 499, args: 'claude --resume abc' },
  row(501, 500, SHELL),                 // a background command
  row(502, 501, SHELL),                 // its pipeline's subshell: the same argv, not the engine's child
  row(503, 501, 'sleep 600'),
  row(504, 500, MCP), row(505, 500, 'caffeinate -i -t 300'),
  row(601, 600, SHELL),                 // another harness's
]
const claude = { engine: 'claude', agentId: 'a1', sessionId: 's1', processIdentity: ENGINE } as const
const on = (rows: ProcessRow[] | null, platform: NodeJS.Platform = 'darwin') => ({ rows: vi.fn(async () => rows), platform })

it('Claude Code: its Bash tool\'s shells among the engine\'s direct children, in one read', async () => {
  const deps = on(TABLE)
  expect(await backgroundCommands(claude, deps)).toBe(1)
  expect(deps.rows).toHaveBeenCalledTimes(1)
  expect(await backgroundCommands(claude, on(TABLE.filter((r) => r.pid !== 501 && r.pid !== 502)))).toBe(0)
  expect(await backgroundCommands(claude, on(TABLE, 'linux'))).toBe(1)
})

it('is null, never 0, where it cannot look', async () => {
  expect(await backgroundCommands(claude, on(null))).toBeNull()                                   // ps failed
  expect(await backgroundCommands(claude, on(TABLE.slice(1)))).toBeNull()                         // the engine is gone
  expect(await backgroundCommands({ ...claude, processIdentity: { ...ENGINE, startMarker: 'another start' } }, on(TABLE))).toBeNull()   // its pid, reused
  expect(await backgroundCommands({ ...claude, processIdentity: null }, on(TABLE))).toBeNull()
  const windows = on(TABLE, 'win32')
  expect(await backgroundCommands(claude, windows)).toBeNull()
  expect(windows.rows).not.toHaveBeenCalled()
  expect(await backgroundCommands(claude, { rows: async () => { throw new Error('ps') }, platform: 'darwin' })).toBeNull()
})

it.each(['codex', 'openclaw', 'opencode', 'terminal'] as const)('%s is not known, and reads no table', async (engine) => {
  const deps = on(TABLE)
  expect(await backgroundCommands({ ...claude, engine }, deps)).toBeNull()
  expect(deps.rows).not.toHaveBeenCalled()
})

it('Hermes: its own list, in the home that holds the session', async () => {
  const module = { hermesHomeForSession: vi.fn(async () => '/h/profiles/p'), hermesBackgroundCommands: vi.fn(async () => 3) }
  const session = { engine: 'hermes', agentId: 'a2', sessionId: '20261112_100000_bbbbbb', hermesHome: '/h/profiles/p', processIdentity: null } as const
  expect(await backgroundCommands(session, { hermes: async () => module })).toBe(3)
  expect(module.hermesBackgroundCommands).toHaveBeenCalledWith('/h/profiles/p', '20261112_100000_bbbbbb')
  expect(await backgroundCommands({ ...session, sessionId: '' }, { hermes: async () => module })).toBeNull()   // not bound yet
  expect(await backgroundCommands(session, { hermes: async () => null })).toBeNull()                           // its code could not load
})
```

- [ ] **Step 2:** `npx vitest run src/lib/backgroundCommands.spec.ts` → FAIL (no such module).
- [ ] **Step 3: Implement.** One `switch` on the engine inside one `try` (`catch` answers `null`). `claude`: `null` on
  `win32` or without a `processIdentity`; else `rows()` (default `processRows`), the engine's row by
  `sameProcessIdentity`, and `claudeBackgroundCommands` over the rows whose `parentPid` is its pid. `hermes`: the
  module (default `() => loadEngine('hermes')`), `null` without it or without a session id, else its count for
  `await hermesHomeForSession(session)`. Everything else `null`. No cache: see Task 8's cost step.
- [ ] **Step 4:** the same command → PASS; `npx vitest run src/architecture.spec.ts` → PASS.
- [ ] **Step 5:** Commit the spec, then the code.

### Task 6: Cleanup ceiling

**Depends on:** Tasks 3 (the request's `background`, the result's `backgroundCommands`) and 4 (`lib/backgroundSaid.ts`;
it also edits the design doc after Task 4 has). **Effort:** high.

**Files:**
- Modify: `cli/src/core/api.ts` (`closeStarted` :202-206 and :2181), `cli/src/core/agentCleanupLink.ts` (:35-43),
  `cli/src/services/agentCleanupProcess.ts` (:37), `cli/src/services/agentCleanup.ts` (`close` :119, `look` :164),
  `docs/design/2026-10-11-agent-client.md` ("Cleaning up", "When idle")
- Test: `cli/src/core/api.spec.ts`, `cli/src/core/agentCleanupLink.spec.ts`,
  `cli/src/services/agentCleanupProcess.spec.ts`, `cli/src/services/agentCleanup.spec.ts`

**Interfaces (produces):**
- `CoreApi.agents.closeStarted?(agentId: string, mode: 'idle' | 'now', pastCeiling?: boolean): Promise<AgentCloseResult>`.
  `idle` asks the close service with `background: 'refuse'`, or `'count'` when `pastCeiling` is `true`; `now` sends
  no `background`.
- The link's `closeStarted` query takes `pastCeiling: true` in its payload; anything else is not past the ceiling.
- `BACKGROUND_CLOSE_MS` exported from `services/agentCleanup.ts`.
- The cleanup passes the third argument only at the ceiling (`true`), so every call and expectation from before this
  keeps its two arguments.

- [ ] **Step 1: Write the failing tests.**

```ts
// core/api.spec.ts, in 'closes for the agent cleanup only a harness another agent started…'
expect(closeAgent).toHaveBeenCalledWith({ agentId: 'kid', sessionId: 's-kid', createdAt: '2026-10-12T08:00:00.000Z', mode: 'idle', background: 'refuse' })
await core.agents.closeStarted!('kid', 'idle', true)
expect(closeAgent).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'idle', background: 'count' }))
await core.agents.closeStarted!('kid', 'now', true)
expect(closeAgent.mock.calls.at(-1)![0]).toEqual({ agentId: 'kid', sessionId: 's-kid', createdAt: '2026-10-12T08:00:00.000Z', mode: 'now' })

// core/agentCleanupLink.spec.ts
expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'idle', pastCeiling: true })).toEqual({ closed: true })
expect(await link.answer('closeStarted', { agentId: 'kid', mode: 'idle', pastCeiling: 'yes' })).toEqual({ closed: true })
expect(closeStarted.mock.calls.slice(-2)).toEqual([['kid', 'idle', true], ['kid', 'idle']])
// and a refusal's count crosses the link: closeStarted answering { error: 'SESSION_NOT_IDLE', backgroundCommands: 2 } is answered whole.

// services/agentCleanupProcess.spec.ts
await api.agents.closeStarted!('k1', 'idle', true)
expect(query).toHaveBeenLastCalledWith('closeStarted', { agentId: 'k1', mode: 'idle', pastCeiling: true })
await api.agents.closeStarted!('k1', 'idle')
expect(query).toHaveBeenLastCalledWith('closeStarted', { agentId: 'k1', mode: 'idle' })

// services/agentCleanup.spec.ts
it('leaves one that still runs background commands open, says so once, and closes it once it has sat two hours', async () => {
  expect(BACKGROUND_CLOSE_MS).toBe(2 * 60 * 60_000)
  const sessions = [kid('kid')]
  const refuse: Record<string, AgentCloseResult> = { kid: { error: 'SESSION_NOT_IDLE', activity: 'idle', backgroundCommands: 2 } }
  const quiet: Record<string, number | null> = { kid: IDLE_CLOSE_MS }   // how long ago its last answer was, at each look
  const t = setup(sessions, quiet, { refuse })
  await t.cleanup.look()                    // first seen
  t.advance(IDLE_CLOSE_MS)
  await t.cleanup.look()                    // refused
  t.advance(ASK_AGAIN_MS)
  await t.cleanup.look()                    // asked again, refused again
  expect(t.closeStarted.mock.calls).toEqual([['kid', 'idle'], ['kid', 'idle']])
  expect(t.log.mock.calls).toEqual([['[agent-cleanup] left kid (kid) open: 2 background commands running']])
  // Two hours after its last answer: closed whatever runs, one line with the count.
  delete refuse.kid
  quiet.kid = BACKGROUND_CLOSE_MS
  t.closeStarted.mockImplementationOnce(async () => { sessions.splice(0, 1); return { closed: true, backgroundCommands: 2 } })
  t.advance(BACKGROUND_CLOSE_MS)
  await t.cleanup.look()
  expect(t.closeStarted).toHaveBeenLastCalledWith('kid', 'idle', true)
  expect(t.log).toHaveBeenLastCalledWith(expect.stringMatching(/^\[agent-cleanup\] closed kid \(kid\): another agent started it, and it has sat idle \d+ minutes, with 2 background commands running\. Its conversation is kept\.$/))
})
// Also: a refusal with no backgroundCommands (working after all) still says nothing; a close past the ceiling that
// answers { closed: true } alone logs today's line; a starter's close ('now') never passes a third argument.
```

  (`setup`'s `lastActivity` answers `clock - quiet[id]` at each look, and the cleanup counts from the later of that
  and when it first saw the harness: so the test sets `quiet.kid` to two hours before the look at the ceiling.)

- [ ] **Step 2:** `npx vitest run src/core/api.spec.ts src/core/agentCleanupLink.spec.ts src/services/agentCleanupProcess.spec.ts src/services/agentCleanup.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - `core/api.ts`: the signature and its doc comment (the rule, and that only the cleanup's link reaches it); the
    request as in Interfaces.
  - `core/agentCleanupLink.ts`: `payload.pastCeiling === true` and nothing else passes `true`.
  - `services/agentCleanupProcess.ts`: `pastCeiling: true` in the query's payload only when given.
  - `services/agentCleanup.ts`: `look` computes `quiet >= BACKGROUND_CLOSE_MS` and hands it to `close`. A refusal
    whose `backgroundCommands` is above 0 logs `[agent-cleanup] left ${label(s)} open: ${backgroundSaid(n)}` once
    for a harness (a set of its own, cleared as `said` is when the harness goes), and is asked again after
    `ASK_AGAIN_MS` like any other. A close whose answer carries a count above 0 logs
    `[agent-cleanup] closed ${label(s)}: ${why}, with ${backgroundSaid(n)}. Its conversation is kept.`
    The file's header comment gains the rule and the ceiling's reason (a dev server or a watcher left running on
    purpose, a stale Hermes entry).
- [ ] **Step 4:** the same command → PASS; `npx vitest run src/core/agents/closeCleanup.spec.ts` → PASS (unchanged).
- [ ] **Step 5: Docs.** `docs/design/2026-10-11-agent-client.md`, "When idle": never one that works, waits for the
  person, holds a draft or still runs background commands (`closeStarted` answers `SESSION_NOT_IDLE` with
  `backgroundCommands`), until it has sat two hours (`BACKGROUND_CLOSE_MS`) after its last answer: then it is closed
  whatever runs, and the log line carries the count. A window's or the phone's Close is unchanged.
- [ ] **Step 6:** Commit the specs, then the code and docs.

### Task 7: Core close dependency

**Depends on:** Task 3. **Effort:** medium.

**Files:**
- Modify: `cli/src/core/agents/close.ts` (`ClosingDeps` :19, the service's construction :77)
- Test: `cli/src/core/agents/close.spec.ts`

**Interfaces (produces):** `ClosingDeps.backgroundCommands?: CloseAgentServiceDeps['backgroundCommands']`, handed to
the close service as it is.

- [ ] **Step 1: Write the failing tests** (the file's `setup`):

```ts
it('hands the close service the count of background commands it was given, or none', () => {
  const backgroundCommands = vi.fn(async () => 1)
  expect(setup({ backgroundCommands }).close.backgroundCommands).toBe(backgroundCommands)
  expect(setup().close.backgroundCommands).toBeUndefined()
})

// in describe('agent_close'): a client cannot name the cleanup's rule
it('never passes on a background rule a client names', () => {
  const request = vi.fn(async () => ({ closed: true as const }))
  const { close } = createCloseRequests({ cleanupPreview: async () => ({}), closeAgentService: () => ({ request }) })
  close({ agentId: 'a1', sessionId: 's1', createdAt: '2026-10-12T08:00:00.000Z', mode: 'idle', background: 'count', pastCeiling: true }, vi.fn())
  expect(request).toHaveBeenCalledWith({ agentId: 'a1', sessionId: 's1', createdAt: '2026-10-12T08:00:00.000Z', mode: 'idle' })
})
```

- [ ] **Step 2:** `npx vitest run src/core/agents/close.spec.ts` → the first FAILS; the second passes already and
  stays as the pin.
- [ ] **Step 3: Implement** the pass-through. `createCloseRequests` is not changed: it builds the request from the
  fields it names. `cleanupPreview` is not changed either: its inspects of idle hidden agents now read the count too
  (one `ps` each, one after the other) and drop it, which is accepted for a list a person asks for rarely.
- [ ] **Step 4:** the same command → PASS.
- [ ] **Step 5:** Commit the spec, then the code.

### Task 8: Wiring and end to end

**Depends on:** Tasks 4, 5, 6 and 7. **Effort:** high.

**Files:**
- Modify: `cli/src/core/main.ts` (`createAgentClosing({…})` :3043), `cli/e2e/harness/fakeEngine.mjs`
- Create: `cli/e2e/backgroundCommands.e2e.ts`

- [ ] **Step 1: The fake engine, as Claude Code does it** (Shapes confirmed). A new directive, documented in the
  file's header: `!background <command>` (Claude Code) writes a `Bash` `tool_use` whose input is
  `{ command, run_in_background: true }` and its `tool_result` (`Command running in background with ID: bg_<turn>`),
  starts the command as its own direct child and does not wait for it:
  `spawn('/bin/sh', ['-c', "source '<home>/shell-snapshots/snapshot-sh-<ms>-<6 chars>.sh' 2>/dev/null || true && eval '<command>' < /dev/null && pwd -P >| '<home>/claude-<4 hex>-cwd'"], { stdio: 'ignore' })`
  (`<home>` is `claudeHome ?? join(homedir(), '.claude')`; single quotes in the command are escaped), then ends the
  turn answering `started in the background: <command>`. And one faithful change: a task that begins with the line
  `harness new` puts before it (`[from …, the harness that started you. It reads your answer itself.]` and a blank
  line) is read for its directive from the task itself, as an agent acts on the task and not on the header.
- [ ] **Step 2: Write the end to end** (`e2e/agentClient.e2e.ts`'s `harness()` runner and `signedIn`, copied or
  imported; `until` for every wait). The background command is `while [ ! -e "<release>" ]; do sleep 0.2; done`,
  with `<release>` a file under the daemon's throwaway root that the test creates to end it; `afterEach` creates it
  before it closes the daemon, so a failed run leaves no loop behind.

  **A. "a harness with a background command reads idle, not done, until it ends"** (one isolated daemon, the person
  at a terminal, pane `''`):
  1. `agent_create` Claude Code `builder`; one `message` `!background …`; wait for `turn_ended`.
  2. `harness show builder --json`: `state: 'idle'`, `backgroundCommands: 1`, `next[0].run` is
     `harness wait builder`. Text: the line `1 background command running`.
  3. `harness close builder`: exit 1, stderr `builder: 1 background command running; --now closes anyway`; the
     harness is still `active`.
  4. `harness watch builder --json --timeout 2m`, started now and read line by line: the first line is `background`
     with `backgroundCommands: 1`. Create `<release>`: a `done` line follows with `backgroundCommands: 0`. No `done`
     line came before the file existed.
  5. `harness wait builder --timeout 1m`: exit 0. `harness show builder --json`: `backgroundCommands: 0`.
     `harness close builder`: exit 0, and the harness is `stopped`.

  **B. "the cleanup leaves it open, and closes it at its ceiling"** (a signed-in daemon with `agents_start_agents`,
  the clock shim of `e2e/clockjump.e2e.ts`: `NODE_OPTIONS=--import e2e/harness/clockShift.mjs`,
  `E2E_CLOCK_SHIFT_FILE`; the cleanup in its own process, as by default):
  1. A lead (Claude Code, one turn of the person's). From its pane:
     `harness new claude kid --name kid -- '!background …'`. Never send `kid` a `message` (it would become the
     person's). Wait until `harness show kid --json` from the lead's pane reads `backgroundCommands: 1`.
  2. Up to three times, until the daemon's log has `[agent-cleanup] left kid (<id>) open: 1 background command
     running`: move the clock 31 minutes on, then `until` that line for 70 s. (The first look after `kid` appeared
     only records it; 93 minutes at most stay under the ceiling.) `kid` is still `active`.
  3. Move the clock 125 minutes on. `until` `kid` is `stopped` (70 s). The log has
     `[agent-cleanup] closed kid (<id>): another agent started it, and it has sat idle <n> minutes, with 1 background
     command running. Its conversation is kept.`
  Test timeout 420 s.

  **C. "cost"**, `it.runIf(process.env.BACKGROUND_COST === '1')`: one isolated daemon, an idle Claude Code harness
  with one answered turn; 20 `agent_close` `inspect` requests through `LocalClient`, one after the other; print
  `JSON.stringify({ medianMs, p95Ms, coreCpuMs })` (`coreCpuMs` from `ps -o time= -p <d.corePid()>` before and
  after, as `e2e/perf.e2e.ts` reads it).
- [ ] **Step 3:** `npx vitest run --config vitest.e2e.config.ts e2e/backgroundCommands.e2e.ts` → A FAILS at step 2
  (`backgroundCommands` is absent: nothing hands the close service a count) and B at its step 1.
- [ ] **Step 4: Cost, before.** `BACKGROUND_COST=1 npx vitest run --config vitest.e2e.config.ts
  e2e/backgroundCommands.e2e.ts -t cost` → keep the printed line: no count is read yet, which is today's inspect.
- [ ] **Step 5: Wire.** In `core/main.ts`, `createAgentClosing({ …, backgroundCommands: (s) => backgroundCommands(s) })`
  with the import from `../lib/backgroundCommands.js`. Nothing else.
- [ ] **Step 6:** Step 3's command → PASS. `npx vitest run src/architecture.spec.ts` → PASS.
- [ ] **Step 7: Cost, after.** Step 4's command again. Record both lines, the machine and its process count for the
  pull request. No cache is planned: a harness that reads idle is looked at once per 3 s per client at most
  (`DEFAULT_INTERVAL_MS`), once a minute once it is done, and one count is one `ps` that concurrent readers share
  (40 ms on this Mac with 717 processes, measured 2026-11-12). If the after median is more than 150 ms above the
  before median, stop and tell the main session: do not add a cache on your own.
- [ ] **Step 8:** Commit the end to end and the fake engine, then the wiring.

---

## Decided after the draft

The three open questions were settled on the draft's choices (recorded in the spec): Codex and OpenClaw read `null`;
`wait`'s timeout line says the count and `--json` carries `backgroundCommands`; the cleanup logs one line per refusal,
`left <name> open: N background commands running`.

## Verification

Isolation, for every end-to-end check: the CLI's own end-to-end harness (`cli/e2e/harness/daemon.ts`
`IsolatedDaemon`, `cli/AGENTS.md` rules 5 and 6, `docs/development.md` "Isolated end-to-end testing"): a real
daemon under a throwaway root (its own `HOME`, `ZDOTDIR`, data, runtime and auth folders, a free port, never 18473),
a private tmux server, the fake Claude Code engine, and a loopback `FakeBackend` for the signed-in test. No real
account, no production backend, no real `~/.claude` or `~/.hermes`.

| # | What to run | Where | What a person should see |
|---|---|---|---|
| 1 | `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/backgroundCommands.e2e.ts` | this Mac (macOS) | Tests A and B pass. A: `show` reads `backgroundCommands: 1` and `1 background command running`; `close` is refused with `builder: 1 background command running; --now closes anyway`; `watch` prints `background`, then `done` only after the release file exists; then `wait` exits 0, `show` reads `0`, `close` closes. B: the log has the `left kid … open` line before the ceiling and the `closed kid … with 1 background command running` line after it. |
| 2 | **Actions → CLI end to end → Run workflow** on the branch | GitHub's Linux runners (the same isolated harness) | The shard that holds `e2e/backgroundCommands.e2e.ts` passes: the same checks on Linux, where `/bin/sh` is dash. |
| 3 | `cd cli && npx vitest run src/engines/hermes/backgroundCommands.spec.ts src/lib/backgroundCommands.spec.ts` | this Mac (needs the `sqlite3` CLI) | Hermes: a fixture home with entries for two sessions and a compressed session's parent reads its own and its ancestor's, nothing of the other; no file reads `null`. |
| 4 | `cd cli && BACKGROUND_COST=1 npx vitest run --config vitest.e2e.config.ts e2e/backgroundCommands.e2e.ts -t cost` | this Mac | One JSON line; with Task 8's before line, the inspect's median grows by about one `ps` (tens of ms). |
| 5 | `cd cli && npm run typecheck` | this Mac | no errors |
| 6 | `cd cli && npm run test:core` | this Mac | PASS, 100% statements, branches, functions and lines in every file of `src/core/` and `src/services/`; recorded in the pull request (PR CI does not run it). |
| 7 | `cd cli && npx vitest run src/architecture.spec.ts src/engines/claude/backgroundCommands.spec.ts src/lib/closeAgentService.spec.ts src/lib/backgroundSaid.spec.ts src/agentClient src/core/agents src/core/api.spec.ts src/core/agentCleanupLink.spec.ts src/services/agentCleanup.spec.ts src/services/agentCleanupProcess.spec.ts` | this Mac | PASS |

Not checked end to end, and why: Hermes in a real pane (no fake Hermes engine; a real one needs a model account), so
its path rests on check 3 and on the dispatcher's spec; Windows, where Claude Code reads `null` by the dispatcher's
spec and nothing else changes. The pull request names both, the platforms (macOS, Linux; Windows `null`), each task's
red then green commits, and the two cost lines.
