# Keystrokes Off the Spawn Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core's short-lived probe children (`ps`, `lsof`, `tmux` queries, the login-shell capture)
are spawned from a worker thread, so a terminal keystroke is never queued behind a synchronous
`posix_spawn` on the core's main thread.

**Architecture:**
- One `worker_threads` worker (inline source, `eval: true`) owns `child_process.execFile` for probes. It
  is started lazily and `unref()`ed.
- The main thread posts `{ id, file, args, options }` and gets back `{ id, error, stdout, stderr }`.
- `patientExec` and four direct `execFile` probes route through it when the core has turned the route on
  (`enableOffThreadExec()` in `runForeground`). Everywhere else (services, CLI commands, unit tests) the
  route stays off and behaviour is byte-for-byte today's.

**Tech Stack:** Node 22 (`node:worker_threads`, `node:child_process`), TypeScript, vitest; the cli e2e
harness (`cli/e2e/harness/*`).

**Spec:** `docs/plans/2026-10-15-keystrokes-off-spawn-path.md` (problem, measurements, options, design,
phases). Read it first.

## Global Constraints

- Do not commit, push or open a PR. Leave every change in the working tree; the owner commits. The
  "Checkpoint" steps below replace commits.
- Work in `cli/`. Run commands from `cli/` unless a step says otherwise.
- Comments say why, in plain sentences, naming the measurement or incident (cli/AGENTS.md rule 7).
- `src/core/**` and `src/services/**` stay at 100 % per-file coverage (`npm run test:core`).
  `src/core/main.ts` is exempt (wiring).
- Tests never touch the developer's real daemon (port 18473), real tmux server or real `~/.claude` /
  `~/.codex` (cli/AGENTS.md rule 6).
- The route is turned on only by the core's composition root. Unit tests must not turn it on except in
  `offThreadExec.spec.ts` and `patientExec.spec.ts`, which reset it in `afterEach`.
- Pre-existing failures on this machine are not this change's: compare any red against a clean worktree
  at the same base before investigating (17 known reds in `src/engines/**` and `src/services/searchProcess.spec.ts`
  on 2026-10-15).

## Review Focus

1. **`process.env.PATH` changed after the worker started** (the core prepends tmux's directory at start,
   `src/lib/tmuxOnPath.ts`). Expected: the child finds the same binary the main thread would. Pinned by
   Task 2's "env is the caller's, read per call" test.
2. **The core's loop held for seconds while a probe is in flight** (`e2e/stall.e2e.ts`). Expected: the
   answer that arrived is read, never reported as a timeout or an empty answer. Pinned by Task 3's
   held-loop test with the route on.
3. **The worker dies mid-call.** Expected: in-flight calls fail with `code: 'EWORKER'` (callers treat it
   like any failed probe: "could not ask"), the next call starts a new worker, and two deaths within 60 s
   fall back to in-thread for good. Pinned by Task 2.
4. **A probe that reads stdin** (the interactive login shell of the launch-environment capture).
   Expected: it sees end-of-file and finishes, as it does today with `child.stdin.end()`. Pinned by
   Task 2's stdin test.
5. **A timeout in `patientExec` with the route on.** Expected: the same error shape as today
   (`code: 'ETIMEDOUT'`, `killed: true`, `signal`, message `<file> did not answer within <n> ms`), since
   `tmuxBackend.ts` reads it. Pinned by Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `cli/e2e/typingLatency.e2e.ts` (create) | Opt-in measurement: keystroke→echo latency by hop, idle and under load; JSON report |
| `cli/e2e/harness/typingEcho.mjs` (create) | A composer-like TUI that redraws its input line on every key |
| `cli/e2e/harness/ptyRoundTrip.py` (create) | Raw pty round trip for the same TUI, the floor every other path is compared to |
| `cli/src/lib/offThreadExec.ts` (create) | The probe worker, `execFileOffThread`, `probeExecFile`, enable/active/reset |
| `cli/src/lib/offThreadExec.spec.ts` (create) | Real-children tests of the worker route |
| `cli/src/lib/patientExec.ts` (modify) | Route to the worker when active; shared timeout error |
| `cli/src/lib/patientExec.spec.ts` (modify) | The same contract with the route on |
| `cli/src/lib/processEnv.ts` (modify) | `ps eww` through `probeExecFile` |
| `cli/src/lib/tmux.ts` (modify, `execText` ~378) | `lsof` through `probeExecFile` |
| `cli/src/lib/nativeProcessImages.ts` (modify, ~194) | The image helper through `probeExecFile` |
| `cli/src/engines/kit/launchExecutable.ts` (modify, `captureEnvironment`) | The login-shell capture through `probeExecFile` |
| `cli/src/core/main.ts` (modify, `runForeground` ~406) | `enableOffThreadExec()` |
| `docs/plans/2026-10-15-keystrokes-off-spawn-path.md` (modify) | The spawn inventory (Task 6) and results (Task 7) |

---

### Task 1: The typing-latency measurement (Phase 0)

**Files:**
- Create: `cli/e2e/harness/typingEcho.mjs`
- Create: `cli/e2e/harness/ptyRoundTrip.py`
- Create: `cli/e2e/typingLatency.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT` (`e2e/harness/daemon.ts`); `LocalClient` (`e2e/harness/client.ts`);
  `TerminalBinaryKind` (`src/lib/terminalBinary.ts`); the probe preload `e2e/harness/corePerf.cjs`
  (POST `/start` `{label}` and `/end` on the port it writes to `core-<pid>.json`).
- Produces: `TYPING=1 TYPING_REPORT=<file> npx vitest run --config vitest.e2e.config.ts e2e/typingLatency.e2e.ts`
  writing `{ machine, conditions: { [label]: { rawPty, tmuxDirect, daemon, core } } }`, each path
  `{ n, p50, p90, p99, max }` in ms. Task 7 compares two of these files.

- [ ] **Step 1: Write the composer-like TUI**

`cli/e2e/harness/typingEcho.mjs`:

```js
// The engine side of a typing measurement: every key redraws the input line, as Claude Code's composer
// does, so an echo is a real redraw and not the kernel's line discipline. Ctrl+C ends it.
process.stdin.setRawMode(true)
let line = ''
process.stdout.write('\x1b[?2004h> ready\r\n')
process.stdin.on('data', (data) => {
  for (const c of data.toString()) {
    if (c === '\x03') process.exit(0)
    line = c === '\x7f' ? line.slice(0, -1) : line + c
  }
  process.stdout.write(`\r\x1b[0J\x1b[39m❯ ${line}\x1b[0m`)
})
```

- [ ] **Step 2: Write the raw pty round trip**

`cli/e2e/harness/ptyRoundTrip.py`:

```python
"""Raw pty round trip: the floor for a typing measurement.

Runs argv[2:] on a fresh pty, writes one key at a time to its master and times the first byte back.
Prints the round trips in ms as a JSON list. No tmux, no daemon, no socket.
"""
import json, os, pty, select, sys, time

count = int(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

def drain(seconds):
    end = time.monotonic() + seconds
    while True:
        ready, _, _ = select.select([fd], [], [], max(0, end - time.monotonic()))
        if not ready:
            return
        os.read(fd, 65536)

drain(1.5)
out = []
for i in range(count):
    started = time.perf_counter()
    os.write(fd, b'x' if i % 2 == 0 else b'\x7f')
    ready, _, _ = select.select([fd], [], [], 5)
    out.append(round((time.perf_counter() - started) * 1000, 3))
    if ready:
        os.read(fd, 65536)
    drain(0.015 + (i % 3) * 0.005)
os.write(fd, b'\x03')
print(json.dumps(out))
```

- [ ] **Step 3: Write the e2e**

`cli/e2e/typingLatency.e2e.ts`:

```ts
/**
 * TYPING=1: keystroke → echo latency at each hop, idle and under load, on an isolated daemon.
 * TYPING_REPORT=<file> writes JSON; TYPING_N=<keys per path> (default 150); TYPING_SAMPLE=1 (macOS) also
 * `sample`s the core's main thread for each daemon window, beside the report.
 *
 * Why it exists: a terminal stuttered while typing on a busy machine and the median said nothing. Each
 * condition times the same composer-like TUI four ways: on a raw pty (the floor), through a tmux control
 * client of our own (tmux's share), through the daemon as the desktop types (the core's share), and the
 * core's event-loop delay meanwhile (e2e/harness/corePerf.cjs). Run alone: the host's load is the noise.
 *
 * Lessons kept from the spike (2026-10-15): the load processes are spawned directly, since `sh -c 'yes …'`
 * orphans `yes` when killed; streams get `terminal_alive` every 5 s or they expire after 30 s; never
 * `--cpu-prof`, which profiles the fake engines too and slows everything it measures.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const exec = promisify(execFile)
const N = Number(process.env.TYPING_N ?? 150)
const HARNESS = join(CLI_ROOT, 'e2e', 'harness')
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const gap = (i: number) => 15 + (i % 3) * 5
const key = (i: number) => (i % 2 === 0 ? 'x' : '\x7f')
type Stats = { n: number; p50: number; p90: number; p99: number; max: number }

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2)
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: +sorted[sorted.length - 1].toFixed(2) }
}

async function rawPty(): Promise<number[]> {
  const { stdout } = await exec('python3', [join(HARNESS, 'ptyRoundTrip.py'), String(N), process.execPath, join(HARNESS, 'typingEcho.mjs')], { timeout: 120_000 })
  return JSON.parse(stdout)
}

/** Our own control client on `pane`: `send-keys -H`, then the first `%output` for that pane. */
async function tmuxDirect(d: IsolatedDaemon, pane: string): Promise<number[]> {
  const child = spawn('tmux', ['-S', d.tmux.socket, '-C', 'attach-session', '-f', 'ignore-size', '-t', pane], { env: d.tmux.env, stdio: ['pipe', 'pipe', 'ignore'] })
  let waiter: (() => void) | null = null
  let tail = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    tail += chunk.toString('latin1')
    const lines = tail.split('\n')
    tail = lines.pop()!
    for (const line of lines) if (line.startsWith(`%output ${pane} `) && waiter) { const wake = waiter; waiter = null; wake() }
  })
  await sleep(800)
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    const echoed = new Promise<void>((done) => { waiter = done })
    const started = performance.now()
    child.stdin!.write(`send-keys -t ${pane} -H ${Buffer.from(key(i)).toString('hex')}\n`)
    await Promise.race([echoed, sleep(5_000)])
    out.push(performance.now() - started)
    await sleep(gap(i))
  }
  child.stdin!.end()
  child.kill()
  return out
}

/** The desktop's path: an input frame over the local WS, the daemon, tmux, the engine, and back. */
async function daemonPath(client: LocalClient, streamId: string, firstSeq: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    const echoed = client.waitForBinary((f) => f.streamId === streamId && f.kind === TerminalBinaryKind.output, 5_000, 'echo', client.binaries.length)
    const started = performance.now()
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: firstSeq + i, compressed: false, bytes: Buffer.from(key(i)) })
    const frame = await echoed
    out.push(performance.now() - started)
    client.send('terminal_ack', { streamId, lastSeq: frame.seq })
    await sleep(gap(i))
  }
  return out
}

async function createAgent(d: IsolatedDaemon, client: LocalClient, folder: string): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  return until(`${folder} active`, async () => {
    const rows = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
    const row = rows.find((r) => r.id === created.agent.id)
    return row?.sessionId && row.status === 'active' ? row : null
  }, 60_000, 500)
}

async function openTerminal(client: LocalClient, agentId: string): Promise<string> {
  const requestId = `open-${Math.random().toString(36).slice(2)}`
  const ready = client.next((f) => f.type === 'terminal_ready' && f.payload?.requestId === requestId, 30_000, 'terminal_ready')
  client.send('terminal_open', { requestId, protocolVersion: 3, agentId, cols: 120, rows: 40 })
  return (await ready).payload!.streamId as string
}

it.runIf(process.env.TYPING === '1')('typing latency by hop, idle and under load', async () => {
  const report = resolve(process.env.TYPING_REPORT ?? join(CLI_ROOT, '.typing-latency.json'))
  const perfDir = join(dirname(report), `typing-core-${Date.now()}`)
  mkdirSync(perfDir, { recursive: true })
  const token = `typing-${process.pid}-${Date.now()}`
  const d = await IsolatedDaemon.create({ env: {
    NODE_OPTIONS: `--require=${join(HARNESS, 'corePerf.cjs')}`, HARNESS_E2E_PERF_DIR: perfDir, HARNESS_E2E_PERF_TOKEN: token,
  } })
  const burners: ChildProcess[] = []
  const timers: NodeJS.Timeout[] = []
  try {
    await d.start()
    const corePid = await until('core pid', () => d.corePid() ?? null, 30_000, 200)
    const endpoint = await until('core probe', () => {
      try { return JSON.parse(readFileSync(join(perfDir, `core-${corePid}.json`), 'utf8')) as { port: number } } catch { return null }
    }, 30_000, 200)
    const probe = async (op: 'start' | 'end', label: string) => (await (await fetch(`http://127.0.0.1:${endpoint.port}/${op}`, {
      method: 'POST', headers: { 'x-harness-perf-token': token }, body: JSON.stringify({ label }),
    })).json()) as Record<string, any>

    const client = await LocalClient.connect(d)
    const target = await createAgent(d, client, 'target')
    const others = await Promise.all([1, 2, 3, 4].map((i) => createAgent(d, client, `other${i}`)))
    const streamId = await openTerminal(client, target.id)
    const otherStreams = await Promise.all(others.map((a) => openTerminal(client, a.id)))
    // A window acks what it drew every ~16 ms. Frames are dropped once acked: a flood would otherwise
    // pile up in this process's memory.
    timers.push(setInterval(() => {
      const last = new Map<string, number>()
      for (const f of client.binaries) last.set(f.streamId, f.seq)
      for (const s of otherStreams) if (last.has(s)) client.send('terminal_ack', { streamId: s, lastSeq: last.get(s)! })
      client.binaries.length = 0
    }, 16))
    timers.push(setInterval(() => { for (const s of [streamId, ...otherStreams]) client.send('terminal_alive', { streamId: s }) }, 5_000))
    await d.tmux.run('new-session', '-d', '-s', 'echo', '-x', '120', '-y', '40', `${process.execPath} ${join(HARNESS, 'typingEcho.mjs')}`)
    const echoPane = await d.tmux.run('display-message', '-p', '-t', 'echo', '#{pane_id}')

    const conditions: Record<string, Record<string, unknown>> = {}
    let seq = 0
    const measure = async (label: string) => {
      const loadBefore = loadavg()[0]
      const raw = stats(await rawPty())
      const tmux = stats(await tmuxDirect(d, echoPane))
      await probe('start', label)
      const sampled = process.env.TYPING_SAMPLE === '1' && process.platform === 'darwin'
        ? exec('sample', [String(corePid), '8', '-file', join(dirname(report), `typing-sample-${label}.txt`)], { timeout: 60_000 }).catch(() => null)
        : null
      const daemon = stats(await daemonPath(client, streamId, seq))
      seq += N
      await sampled
      const core = await probe('end', label)
      conditions[label] = {
        rawPty: raw, tmuxDirect: tmux, daemon, loadAverage: [loadBefore, loadavg()[0]],
        core: { cpuPercent: core.cpu.percent, loopDelayP99Ms: core.eventLoop.p99Ms, loopDelayMaxMs: core.eventLoop.maxMs },
      }
    }
    const burn = () => { for (let i = 0; i < cpus().length; i++) burners.push(spawn('yes', [], { stdio: 'ignore' })) }
    const unburn = () => { for (const b of burners.splice(0)) b.kill() }

    await measure('idle')
    burn(); await sleep(1_000); await measure('cpu'); unburn(); await sleep(1_000)
    for (const a of others) client.send('message', { agentId: a.id, content: '!flood 409600' })
    await sleep(3_000)
    await measure('flood')
    burn(); await sleep(1_000); await measure('cpu-flood'); unburn()

    writeFileSync(report, `${JSON.stringify({
      schema: 1, at: new Date().toISOString(), keysPerPath: N,
      machine: { cpus: cpus().length, model: cpus()[0]?.model, platform: process.platform },
      conditions,
    }, null, 2)}\n`)
    console.log(`typing latency report: ${report}`)
    client.close()
  } finally {
    for (const t of timers) clearInterval(t)
    for (const b of burners) b.kill()
    await d.close()
  }
}, 900_000)
```

- [ ] **Step 4: Run it and check its output is sane**

Run (from `cli/`):
`TYPING=1 TYPING_REPORT=/tmp/typing-base-1.json npx vitest run --config vitest.e2e.config.ts e2e/typingLatency.e2e.ts`

Expected:
- The run passes in about 2–3 minutes.
- `/tmp/typing-base-1.json` has 4 conditions. Each has `rawPty`, `tmuxDirect` and `daemon` with `n: 150`.
- `idle.daemon.p50` is under 2 ms. `cpu.daemon.p99` is well above `cpu.tmuxDirect.p99` (on the reference
  Mac: 62–101 ms against 12–28 ms).
- Afterwards, `ps -Ao command | awk '$1=="yes"' | wc -l` prints `0`.

- [ ] **Step 5: Confirm the default suite skips it**

Run: `npx vitest run --config vitest.e2e.config.ts e2e/typingLatency.e2e.ts`
Expected: 1 skipped, no daemon started.

- [ ] **Step 6: Record the baseline**

Before any other task touches the code, run Step 4 three times with
`TYPING_SAMPLE=1 TYPING_REPORT=/tmp/typing-base-{1,2,3}.json`. Keep the files; Task 7 compares against them.

- [ ] **Step 7: Checkpoint**

Run: `git status --short` (from the repo root)
Expected: the three new files, nothing else from this task.

---

### Task 2: The off-thread exec

**Files:**
- Create: `cli/src/lib/offThreadExec.ts`
- Test: `cli/src/lib/offThreadExec.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (exact exports):
  - `interface ProbeOptions { timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string }`
  - `type ProbeDone = (error: ExecFileException | null, stdout: string, stderr: string) => void`
  - `interface ProbeChild { kill(signal?: NodeJS.Signals): boolean; readonly killed?: boolean; stdin?: { end(): void } | null }`
  - `function execFileOffThread(file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone): ProbeChild`
  - `function probeExecFile(inThread: (...args: any[]) => unknown): (file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone) => ProbeChild | undefined`
  - `function enableOffThreadExec(): void`
  - `function offThreadExecActive(): boolean`
  - `function resetOffThreadExec(): void`: test seam; turns the route off and drops the worker without counting a death.
  - `function stopProbeWorkerForTest(): Promise<void>`: test seam; terminates the worker as a death would.

- [ ] **Step 1: Write the failing tests**

`cli/src/lib/offThreadExec.spec.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enableOffThreadExec, execFileOffThread, offThreadExecActive, probeExecFile, resetOffThreadExec,
  stopProbeWorkerForTest, type ProbeOptions,
} from './offThreadExec.js'

afterEach(() => { resetOffThreadExec(); vi.unstubAllEnvs() })

const call = (file: string, args: string[], options: ProbeOptions = {}) =>
  new Promise<{ error: (Error & Record<string, unknown>) | null; stdout: string; stderr: string; killed?: boolean }>((resolve) => {
    const child = execFileOffThread(file, args, options, (error, stdout, stderr) =>
      resolve({ error: error as never, stdout, stderr, killed: child.killed }))
  })

describe('probes spawned from a worker thread', () => {
  it('answers what the child printed', async () => {
    expect(await call('echo', ['still here'])).toMatchObject({ error: null, stdout: 'still here\n', stderr: '' })
  })

  it('passes an exit code through with both outputs', async () => {
    const { error, stdout, stderr } = await call('sh', ['-c', 'echo out; echo err >&2; exit 3'])
    expect(error).toMatchObject({ code: 3 })
    expect([stdout, stderr]).toEqual(['out\n', 'err\n'])
  })

  it('reports a binary that does not exist as execFile does', async () => {
    expect((await call('/no/such/binary', [])).error).toMatchObject({ code: 'ENOENT' })
  })

  it('times a child out in the worker, killed with the signal asked for', async () => {
    const { error, killed } = await call('sleep', ['5'], { timeout: 100, killSignal: 'SIGKILL' })
    expect(error).toMatchObject({ killed: true, signal: 'SIGKILL' })
    expect(killed).toBe(true)
  })

  it('kills a child from the main thread', async () => {
    const answered = new Promise<Error | null>((resolve) => {
      const child = execFileOffThread('sleep', ['5'], {}, (error) => resolve(error))
      setTimeout(() => child.kill('SIGKILL'), 50)
    })
    expect(await answered).toMatchObject({ signal: 'SIGKILL' })
  })

  it('ends the child\'s stdin, so a probe that reads it finishes', async () => {
    // The launch-environment capture is an interactive login shell, which reads stdin.
    expect(await call('sh', ['-c', 'cat; echo done'], { timeout: 5_000 })).toMatchObject({ error: null, stdout: 'done\n' })
  })

  it('stops reading at maxBuffer, as execFile does', async () => {
    const { error } = await call('sh', ['-c', 'yes | head -c 5000'], { maxBuffer: 100 })
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('runs the child in the environment the caller has now, not the one the worker started with', async () => {
    // The core prepends tmux's folder to PATH after it starts (tmuxOnPath.ts): a worker's own copy of
    // process.env, made at its start, would find another tmux.
    vi.stubEnv('HARNESS_PROBE_ENV', 'before')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'])).stdout).toBe('before')
    vi.stubEnv('HARNESS_PROBE_ENV', 'after')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'])).stdout).toBe('after')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'], { env: { HARNESS_PROBE_ENV: 'given' } })).stdout).toBe('given')
  })

  it('fails the calls in flight when the worker dies, and starts a new one for the next', async () => {
    const inFlight = call('sleep', ['5'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    await stopProbeWorkerForTest()
    expect((await inFlight).error).toMatchObject({ code: 'EWORKER' })
    expect(await call('echo', ['again'])).toMatchObject({ error: null, stdout: 'again\n' })
  })

  it('lets a script that used it exit: the worker never keeps a process alive', () => {
    const module = fileURLToPath(new URL('./offThreadExec.ts', import.meta.url))
    const script = `import(${JSON.stringify(module)}).then(m => m.execFileOffThread('echo', ['x'], {}, () => {}))`
    // Throws if the process is still running after 10 s.
    execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { timeout: 10_000 })
  })
})

describe('the route the core turns on', () => {
  it('is off until the core enables it, and probeExecFile calls the execFile it was given', () => {
    expect(offThreadExecActive()).toBe(false)
    const inThread = vi.fn((_f: string, _a: string[], _o: object, done: (...a: unknown[]) => void) => { done(null, 'mocked', ''); return { kill: () => true } })
    const done = vi.fn()
    probeExecFile(inThread)('ps', ['-ax'], { timeout: 10 }, done)
    expect(inThread).toHaveBeenCalledWith('ps', ['-ax'], { timeout: 10 }, done)
    expect(done).toHaveBeenCalledWith(null, 'mocked', '')
  })

  it('sends probes to the worker once enabled', async () => {
    enableOffThreadExec()
    expect(offThreadExecActive()).toBe(true)
    const inThread = vi.fn()
    const stdout = await new Promise<string>((resolve) => { probeExecFile(inThread)('echo', ['worker'], {}, (_e, out) => resolve(out)) })
    expect(stdout).toBe('worker\n')
    expect(inThread).not.toHaveBeenCalled()
  })

  it('falls back to the main thread for good after the worker dies twice in a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enableOffThreadExec()
    await call('echo', ['one'])
    await stopProbeWorkerForTest()
    await call('echo', ['two'])
    await stopProbeWorkerForTest()
    expect(offThreadExecActive()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    const inThread = vi.fn()
    probeExecFile(inThread)('echo', [], {}, () => {})
    expect(inThread).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/offThreadExec.spec.ts`
Expected: FAIL. The module `./offThreadExec.js` does not exist.

- [ ] **Step 3: Write the module**

`cli/src/lib/offThreadExec.ts`:

```ts
/**
 * The core's short-lived probes (`ps`, `lsof`, `tmux` queries, the login-shell capture), spawned from a
 * worker thread.
 *
 * Node spawns a child synchronously on the thread that asks (`uv_spawn` → `posix_spawn`), and under CPU
 * contention one spawn takes tens of milliseconds. The core's terminals share its main thread: a keystroke
 * read from the local socket, and its echo written back, wait behind every probe spawned in between.
 * Measured 2026-10-15 on a 12-core Mac with 12 busy processes: ~60 % of the core main thread's non-idle
 * samples were inside `uv_spawn`, and a keystroke's echo took p99 62–101 ms through the daemon against
 * 12–28 ms through tmux alone (docs/plans/2026-10-15-keystrokes-off-spawn-path.md). From a worker, a
 * spawn holds only the worker.
 *
 * The child's timeout runs in the worker. Its loop is not held when the core's is, so a timeout there is
 * real; the main thread keeps no timer, since a held loop fires a timer late, before it reads the answer
 * waiting in the port (patientExec.ts). The environment travels with every call: a worker's process.env
 * is a copy made at its start, and the core changes PATH after that (tmuxOnPath.ts).
 *
 * Only the core turns this on (`enableOffThreadExec`, core/main.ts). Everything else, and every unit test,
 * calls `execFile` on its own thread as before, so a test's mock of `node:child_process` still applies.
 */
import type { ExecFileException } from 'node:child_process'
import { Worker } from 'node:worker_threads'

export interface ProbeOptions {
  timeout?: number
  killSignal?: NodeJS.Signals
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}
export type ProbeDone = (error: ExecFileException | null, stdout: string, stderr: string) => void
export interface ProbeChild {
  kill(signal?: NodeJS.Signals): boolean
  readonly killed?: boolean
  stdin?: { end(): void } | null
}

interface Reply {
  id: number
  stdout: string
  stderr: string
  error: { message: string; code?: unknown; killed?: boolean; signal?: unknown; cmd?: string } | null
}

// CommonJS, evaluated in the worker: the lean bundle carries it as a string, with no file of its own.
// Nothing writes to a probe's stdin, so it is ended at once: an interactive shell that reads it then sees
// end-of-file, as the in-thread capture arranged with `child.stdin.end()`.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { execFile } = require('node:child_process')
const children = new Map()
parentPort.on('message', (m) => {
  if (m.kill !== undefined) { const child = children.get(m.kill); if (child) child.kill(m.signal); return }
  const reply = (error, stdout, stderr) => {
    children.delete(m.id)
    parentPort.postMessage({ id: m.id, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error
      ? { message: error.message, code: error.code, killed: error.killed, signal: error.signal, cmd: error.cmd } : null })
  }
  try {
    const child = execFile(m.file, m.args, m.options, reply)
    if (child.stdin) child.stdin.end()
    children.set(m.id, child)
  } catch (error) { reply(error, '', '') }
})
`

/** Two deaths this close together turn the route off for the rest of the process. */
const DEATH_WINDOW_MS = 60_000

let enabled = false
let fallen = false
let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, ProbeDone>()
const deaths: number[] = []

export function enableOffThreadExec(): void {
  enabled = true
}

export function offThreadExecActive(): boolean {
  return enabled && !fallen
}

/** Test seam: the route off, the worker gone, no death counted. */
export function resetOffThreadExec(): void {
  enabled = false
  fallen = false
  deaths.length = 0
  const stopping = worker
  worker = null
  failAll('the probe worker was reset')
  void stopping?.terminate()
}

/** Test seam: the worker ends as a crash would end it. */
export async function stopProbeWorkerForTest(): Promise<void> {
  const stopping = worker
  if (!stopping) return
  const exited = new Promise<void>((resolve) => stopping.once('exit', () => resolve()))
  await stopping.terminate()
  await exited
}

function failAll(reason: string): void {
  for (const [id, done] of [...pending]) {
    pending.delete(id)
    done(Object.assign(new Error(reason), { code: 'EWORKER' }) as ExecFileException, '', '')
  }
}

function start(): Worker {
  const started = new Worker(WORKER_SOURCE, { eval: true })
  // A probe in flight never keeps the process alive: the core has its sockets for that.
  started.unref()
  started.on('message', (reply: Reply) => {
    const done = pending.get(reply.id)
    if (!done) return
    pending.delete(reply.id)
    const error = reply.error ? Object.assign(new Error(reply.error.message), reply.error) as ExecFileException : null
    done(error, reply.stdout, reply.stderr)
  })
  // An uncaught error in the worker ends it; `exit` follows and does the accounting.
  started.on('error', () => {})
  started.once('exit', () => {
    if (worker !== started) return
    worker = null
    failAll('the probe worker exited')
    const now = Date.now()
    deaths.push(now)
    while (deaths.length && now - deaths[0] > DEATH_WINDOW_MS) deaths.shift()
    if (deaths.length >= 2 && !fallen) {
      fallen = true
      console.warn('[probes] the probe worker exited twice within a minute; probes run on the main thread from now on')
    }
  })
  return started
}

export function execFileOffThread(file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone): ProbeChild {
  const id = nextId++
  let killed = false
  pending.set(id, (error, stdout, stderr) => {
    if (error?.killed) killed = true
    done(error, stdout, stderr)
  })
  const target = worker ?? (worker = start())
  target.postMessage({ id, file, args: [...args], options: { ...options, env: { ...(options.env ?? process.env) }, encoding: 'utf8' } })
  return {
    get killed() { return killed },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (!pending.has(id) || !worker) return false
      worker.postMessage({ kill: id, signal })
      return true
    },
  }
}

/**
 * `execFile` for a probe: the worker's when the core has turned it on, else `inThread` (the caller's own
 * `execFile`, passed in so a test's mock of `node:child_process` applies) with the same arguments.
 */
export function probeExecFile(inThread: (...args: any[]) => unknown) {
  return (file: string, args: readonly string[], options: ProbeOptions, done: ProbeDone): ProbeChild | undefined =>
    offThreadExecActive()
      ? execFileOffThread(file, args, options, done)
      : inThread(file, args, options, done) as ProbeChild | undefined
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/offThreadExec.spec.ts`
Expected: PASS, 13 tests.

If `probeExecFile ... toHaveBeenCalledWith('ps', ['-ax'], ...)` fails on array identity, that is fine:
`toHaveBeenCalledWith` compares deeply. Do not copy `args` in the in-thread branch; today's callers pass
their own arrays straight to `execFile`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat; git status --short`
Expected: the two new files.

---

### Task 3: `patientExec` through the worker

**Files:**
- Modify: `cli/src/lib/patientExec.ts` (the `patientExec` function, ~line 62)
- Test: `cli/src/lib/patientExec.spec.ts`

**Interfaces:**
- Consumes: `offThreadExecActive`, `execFileOffThread` (Task 2).
- Produces: unchanged signature `patientExec(execFile)(file, args, options, done)`. With the route on, the
  child runs in the worker and a timeout is reported with today's error shape.

- [ ] **Step 1: Write the failing tests**

In `cli/src/lib/patientExec.spec.ts`, add this import with the existing ones at the top:

```ts
import { enableOffThreadExec, resetOffThreadExec } from './offThreadExec.js'
```

and append this block at the end of the file (it uses the file's existing `hold` helper and `execFile` import):

```ts
describe('the same contract, with the core\'s probes in their worker', () => {
  afterEach(() => { resetOffThreadExec() })

  it('reads an answer that arrived while this loop was held, and never runs the in-thread execFile', async () => {
    enableOffThreadExec()
    const inThread = vi.fn()
    const kept = new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      patientExec(inThread)('echo', ['still here'], { timeout: 100 }, (error, stdout) => resolve({ error, stdout }))
    })
    setImmediate(() => hold(400))
    expect(await kept).toEqual({ error: null, stdout: 'still here\n' })
    expect(inThread).not.toHaveBeenCalled()
  })

  it('reports a timeout exactly as the in-thread path does', async () => {
    enableOffThreadExec()
    const error = await new Promise<Error | null>((resolve) => {
      patientExec(execFile)('sleep', ['5'], { timeout: 100 }, (e) => resolve(e))
    })
    expect(error).toMatchObject({ killed: true, code: 'ETIMEDOUT', signal: 'SIGTERM' })
    expect(error!.message).toBe('sleep did not answer within 100 ms')
  })

  it('passes a failure through as it is', async () => {
    enableOffThreadExec()
    const error = await new Promise<Error | null>((resolve) => { patientExec(execFile)('false', [], { timeout: 1_000 }, (e) => resolve(e)) })
    expect(error).toMatchObject({ code: 1 })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/patientExec.spec.ts`
Expected: FAIL. The first test times out after vitest's 5 s: the in-thread path calls `inThread`,
a `vi.fn()` that never calls back. The timeout test passes already (the in-thread path behaves the same).

- [ ] **Step 3: Implement the route**

In `cli/src/lib/patientExec.ts`, add the import under the existing `import type { ExecFileException } ...`:

```ts
import { execFileOffThread, offThreadExecActive } from './offThreadExec.js'
```

Replace the whole `patientExec` function with:

```ts
/** The error a timed-out child is reported with, on either path: `tmuxBackend.ts` reads its shape. */
function timedOut(file: string, args: readonly string[], timeout: number, killSignal: NodeJS.Signals): ExecFileException {
  return Object.assign(new Error(`${file} did not answer within ${timeout} ms`), {
    killed: true, signal: killSignal, code: 'ETIMEDOUT', cmd: [file, ...args].join(' '),
  }) as ExecFileException
}

export function patientExec(execFile: (...args: any[]) => unknown) {
  return (file: string, args: readonly string[], options: PatientExecOptions, done: ExecDone): void => {
    const { timeout = 0, killSignal = 'SIGTERM', ...rest } = options
    if (offThreadExecActive()) {
      // The worker's loop is not held when this one is: its own timeout is a real one, and an answer
      // waits in the port until this loop reads it (offThreadExec.ts). No deadline is armed here.
      execFileOffThread(file, args, { ...rest, timeout, killSignal }, (error, stdout, stderr) => {
        if (error && timeout > 0 && error.killed && error.signal === killSignal) { done(timedOut(file, args, timeout, killSignal), stdout, stderr); return }
        done(error, stdout, stderr)
      })
      return
    }
    let finished = false
    let timedOutHere = false
    let cancel = (): void => {}
    const child = execFile(file, [...args], { ...rest, encoding: 'utf8' }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      finished = true
      cancel()
      // Exit 0 is an answer even when the kill raced it: unlike Node's own timeout, this one never
      // throws the output away.
      if (error && timedOutHere) {
        done(timedOut(file, args, timeout, killSignal), stdout ?? '', stderr ?? '')
        return
      }
      done(error, stdout ?? '', stderr ?? '')
    }) as { kill?: (signal: NodeJS.Signals) => boolean } | undefined
    if (timeout > 0 && !finished) {
      cancel = patientDeadline(timeout, () => {
        timedOutHere = true
        child?.kill?.(killSignal)
      })
    }
  }
}
```

The in-thread branch is today's code with the error built by `timedOut` and the flag renamed
`timedOutHere` (it would shadow the helper otherwise). The message, `killed`, `signal`, `code` and `cmd`
are unchanged.

- [ ] **Step 4: Run every patientExec test, old and new**

Run: `npx vitest run src/lib/patientExec.spec.ts`
Expected: PASS. The existing tests are unchanged and still pass with the route off.

- [ ] **Step 5: Run the users of patientExec**

Run: `npx vitest run src/lib/tmux src/lib/tmuxCapture src/lib/tmuxAgentDiscovery src/lib/tmuxBackend src/lib/tmuxVersion`
Expected: same result as on the base commit (route off in all of them).

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat`
Expected: `patientExec.ts`, `patientExec.spec.ts`, plus Task 2's files.

---

### Task 4: The direct probes

**Files:**
- Modify: `cli/src/lib/processEnv.ts` (`read`, ~line 54)
- Modify: `cli/src/lib/tmux.ts` (`execText`, ~line 378; import line 3)
- Modify: `cli/src/lib/nativeProcessImages.ts` (~line 194)
- Modify: `cli/src/engines/kit/launchExecutable.ts` (`captureEnvironment`)
- Test: `cli/src/lib/offThreadExec.spec.ts` (one routing test per caller)

**Interfaces:**
- Consumes: `probeExecFile` (Task 2).
- Produces: nothing new. Each caller keeps its signature and behaviour; with the route on, its child
  runs in the worker.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/lib/offThreadExec.spec.ts`:

```ts
import { launchEnvironment, clearLaunchEnvironmentCache } from '../engines/kit/launchExecutable.js'
import { clearProcessEnvCache, readProcessEnv } from './processEnv.js'

describe('the probes that called execFile directly', () => {
  afterEach(() => { clearProcessEnvCache(); clearLaunchEnvironmentCache() })

  it.runIf(process.platform === 'darwin')('reads a process environment through the worker', async () => {
    enableOffThreadExec()
    const { pid } = process
    // `ps eww` of this test's own Node: not an Apple platform binary, so its environment is shown.
    const env = await readProcessEnv({ pid, startMarker: 'x', executable: process.execPath } as never)
    expect(env?.HOME).toBe(process.env.HOME)
  })

  it('captures the launch environment through the worker', async () => {
    enableOffThreadExec()
    const env = await launchEnvironment('/bin/sh')
    expect(env?.HOME).toBe(process.env.HOME)
  })
})
```

`tmux.ts` `execText` and `nativeProcessImages` are covered end to end in Task 5: on macOS discovery runs
both every few seconds, and `paneLifecycle.e2e.ts` fails if discovery cannot read the process table.

- [ ] **Step 2: Run them**

Run: `npx vitest run src/lib/offThreadExec.spec.ts`
Expected: PASS even before the change (the in-thread path gives the same answers).

That is the point: these tests pin behaviour, not the route. The route itself is checked in Step 4 by
making the in-thread path unavailable.

- [ ] **Step 3: Route the four callers**

`cli/src/lib/processEnv.ts`: add `import { probeExecFile } from './offThreadExec.js'` beside the
`execFile` import, then in `read` replace

```ts
    execFile('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 2_000, maxBuffer: 4 << 20 }, (err, stdout) => {
```

with

```ts
    probeExecFile(execFile)('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 2_000, maxBuffer: 4 << 20 }, (err, stdout) => {
```

`cli/src/lib/tmux.ts`: add `import { probeExecFile } from './offThreadExec.js'` with the other `./`
imports, then in `execText` replace

```ts
    let child: { killed?: boolean } | undefined
    child = execFile(command, args, { timeout }, (err, stdout) => resolve((err && !stdout) || child?.killed ? null : stdout))
```

with

```ts
    let child: { killed?: boolean } | undefined
    child = probeExecFile(execFile)(command, args, { timeout }, (err, stdout) => resolve((err && !stdout) || child?.killed ? null : stdout))
```

`cli/src/lib/nativeProcessImages.ts`: add `import { probeExecFile } from './offThreadExec.js'`, then replace

```ts
      execFile(helper.path, ['--paths', ...new Set(pids).values()].map(String),
```

with

```ts
      probeExecFile(execFile)(helper.path, ['--paths', ...new Set(pids).values()].map(String),
```

`cli/src/engines/kit/launchExecutable.ts`: add `import { probeExecFile } from '../../lib/offThreadExec.js'`,
then in `captureEnvironment` replace

```ts
      const child = execFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, output) => {
```

with

```ts
      const child = probeExecFile(execFile)(argv[0], argv.slice(1), { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, output) => {
```

Change the `child.stdin?.end()` line after it to `child?.stdin?.end()`. `probeExecFile` may return
`undefined` (a test's stand-in), the in-thread child still needs its stdin ended, and the worker ends
stdin itself.

The `encoding: 'utf8'` option is dropped because `ProbeOptions` has no `encoding`. The worker always
uses utf8, and `execFile` defaults to utf8 in-thread, so `output` is still a string. If the typecheck
complains about the callback's parameter types at any of the four sites, annotate them as
`(err: ExecFileException | null, stdout: string)`. Do not cast the call.

- [ ] **Step 4: Prove the route is taken**

Add to the `describe('the probes that called execFile directly')` block:

```ts
  it('does not spawn on this thread once the route is on', async () => {
    enableOffThreadExec()
    const childProcess = await import('node:child_process')
    const spy = vi.spyOn(childProcess, 'execFile')
    await launchEnvironment('/bin/sh')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
```

Run: `npx vitest run src/lib/offThreadExec.spec.ts`
Expected: PASS.

If `vi.spyOn` cannot redefine the ESM namespace export, drop this test and rely on Task 5's `sample`
check instead (`uv_spawn` must disappear from the core's main thread). Do not mock the worker.

- [ ] **Step 5: Run the callers' own specs and the typecheck**

Run: `npm run typecheck && npx vitest run src/lib/processEnv src/lib/tmux src/lib/nativeProcessImages src/engines/kit/launchEnvironment src/engines/kit/launchExecutable src/engines/nativeLaunch`
Expected: typecheck exit 0. Specs give the same result as on the base commit: they mock `node:child_process`
and the route is off in them.

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat`
Expected: the four callers modified, plus earlier tasks' files.

---

### Task 5: The core turns it on

**Files:**
- Modify: `cli/src/core/main.ts` (`runForeground`, line ~406)

**Interfaces:**
- Consumes: `enableOffThreadExec` (Task 2).
- Produces: the route on in the core process, and only there.

- [ ] **Step 1: Enable it first thing in the core**

In `cli/src/core/main.ts`, add `import { enableOffThreadExec } from '../lib/offThreadExec.js'` with the
other `../lib/` imports, and in `runForeground` right after `installTimestampedConsole()`:

```ts
  // The core's probes spawn from a worker, so a terminal's keystrokes never wait behind one (lib/offThreadExec.ts).
  enableOffThreadExec()
```

- [ ] **Step 2: Typecheck and the core's coverage gate**

Run: `npm run typecheck && npm run test:core`
Expected:
- typecheck exits 0;
- `test:core` gives the same failures as on the base commit (2026-10-15: 3 in
  `src/services/searchProcess.spec.ts`).

The only core file touched is `src/core/main.ts`, which the gate exempts, so no per-file coverage check
is needed here.

- [ ] **Step 3: The bundle carries and loads the worker**

Run: `npm run bundle && node scripts/check-lean-bundle.mjs dist/cli.js`
Expected: both exit 0.

- [ ] **Step 4: The e2e that exercise probes and terminals**

Run: `npx vitest run --config vitest.e2e.config.ts e2e/stall.e2e.ts e2e/terminal.e2e.ts e2e/paneLifecycle.e2e.ts e2e/robustness.e2e.ts`
Expected: PASS, or exactly the base commit's result for these files (run them on a clean worktree of the
base to compare if anything is red).

`stall.e2e.ts` is the one that matters most: it holds the core's loop and checks no live pane is taken
for gone.

- [ ] **Step 5: Spawns are off the main thread**

On macOS, run Task 1's e2e once with `TYPING_SAMPLE=1 TYPING_REPORT=/tmp/typing-route-1.json`, then:

```bash
for f in /tmp/typing-sample-cpu.txt /tmp/typing-sample-cpu-flood.txt; do
  printf '%s ' "$f"
  awk '/Call graph:/{f=1} /Total number in stack/{f=0} f' "$f" \
  | awk '/^    [0-9]+ Thread_/{t=$0} {print t "\t" $0}' | grep main-thread | awk -F'\t' '{print $2}' \
  | sed -E 's/^[ +!:|]*//' \
  | awk '$2 ~ /^Thread_/ {tot=$1} $2=="uv_spawn"{s+=$1} $2=="kevent"{k+=$1} END{printf "busy=%d uv_spawn=%d (%.1f%%)\n", tot-k, s, 100*s/(tot-k)}'
done
```

Expected: `uv_spawn` under 5 % of the main thread's busy samples in both (it was ~60 % before).

- [ ] **Step 6: Checkpoint**

Run: `git diff --stat`

---

### Task 6: Inventory the remaining spawns

**Files:**
- Modify: `docs/plans/2026-10-15-keystrokes-off-spawn-path.md` (append a "Spawn inventory" section)

**Interfaces:**
- Consumes: Tasks 2–5 merged in the working tree.
- Produces: a table of every `child_process` call reachable from the core, marked routed, stays (with
  the reason), or follow-up.

- [ ] **Step 1: List the call sites**

Run (from `cli/`):

```bash
rg -n "\b(execFile|execFileSync|spawn|spawnSync|exec|execSync)\(" src/lib src/core src/engines \
  -g '!*.spec.ts' -g '!*.golden.spec.ts' | rg -v "probeExecFile|offThreadExec"
```

- [ ] **Step 2: Find which run on a timer in the core**

From the `sample` files of Task 5, list any remaining JS frames under `uv_spawn`. `sample` shows native
frames only, so use the earlier e2e CPU-profile method on a throwaway run. Run Task 1's e2e with
`NODE_OPTIONS` extended by `--cpu-prof --cpu-prof-dir=/tmp/typing-prof` for the core only. Set it in
`IsolatedDaemon.create({ env })` for this one run; do not commit that change.

Then attribute `ChildProcess.spawn` and `spawnSync` self time to callers. Write this script to /tmp
(do not put it in the repo):

```python
import json, sys, collections
p = json.load(open(sys.argv[1])); target = sys.argv[2]
nodes = {n['id']: n for n in p['nodes']}
parent = {c: n['id'] for n in p['nodes'] for c in n.get('children', [])}
dt = collections.Counter()
for sid, d in zip(p['samples'], p['timeDeltas']): dt[sid] += d
def name(n):
    cf = n['callFrame']; u = cf['url']
    return f"{cf['functionName'] or '(anon)'} {u.split('/src/')[-1]}:{cf['lineNumber']+1}"
agg = collections.Counter()
for nid, t in dt.items():
    if not name(nodes[nid]).startswith(target): continue
    chain, cur = [], parent.get(nid)
    while cur is not None and len(chain) < 40: chain.append(name(nodes[cur])); cur = parent.get(cur)
    agg[' <- '.join([c for c in chain if '.ts:' in c][:4])] += t
for k, t in agg.most_common(15): print(f"{t/1000:8.1f}ms  {k}")
```

Run it as `python3 /tmp/attr.py <core>.cpuprofile ChildProcess.spawn`, and again with `spawnSync`.

- [ ] **Step 3: Write the table**

Append to the spec:

```markdown
## Spawn inventory (after Phase 2)

| Call site | Runs | Thread | Why |
|---|---|---|---|
| `lib/patientExec.ts` users (tmux.ts run, tmuxCapture, tmuxAgentDiscovery, tmuxBackend, tmuxVersion) | timers, requests | worker | Phase 1 |
| `lib/processEnv.ts` read | discovery, gateway runtime, DSH | worker | Phase 2 |
| … one row per remaining site from Step 1, with what Step 2 measured … |
```

Fill every row from Steps 1–2; a site with no measured time on a timer is "stays: on demand". If Step 2
shows a periodic site still on the main thread, add it to Task 4's pattern and rerun Task 4 Step 5.

- [ ] **Step 4: Checkpoint**

Run: `git diff --stat`

---

### Task 7: Measure and decide (Phase 3)

**Files:**
- Modify: `docs/plans/2026-10-15-keystrokes-off-spawn-path.md` (append "Results")

**Interfaces:**
- Consumes: Task 1's baseline `/tmp/typing-base-{1,2,3}.json`; everything above.
- Produces: the numbers and the decision: done, or design option 2.

- [ ] **Step 1: Three runs with the change**

Run Task 1's e2e three times with `TYPING_SAMPLE=1 TYPING_REPORT=/tmp/typing-route-{1,2,3}.json`.

- [ ] **Step 2: Compare against the gate**

Write `/tmp/compare.py` (not in the repo):

```python
import json, statistics, sys
def load(prefix): return [json.load(open(f'{prefix}-{i}.json'))['conditions'] for i in (1, 2, 3)]
base, route = load(sys.argv[1]), load(sys.argv[2])
def med(runs, cond, path, stat): return statistics.median(r[cond][path][stat] for r in runs)
for cond in ('idle', 'cpu', 'flood', 'cpu-flood'):
    for stat in ('p50', 'p99', 'max'):
        print(f"{cond:10} daemon {stat}: {med(base, cond, 'daemon', stat):8.2f} -> {med(route, cond, 'daemon', stat):8.2f}"
              f"   (tmux {med(route, cond, 'tmuxDirect', stat):.2f})")
```

Run: `python3 /tmp/compare.py /tmp/typing-base /tmp/typing-route`

The gate, from the spec:
- `cpu`: daemon p99 ≤ 2× tmux p99, and max < 100 ms.
- `cpu-flood`: daemon p99 < 60 ms.
- `idle`: p50 ≤ 1 ms and p99 ≤ 5 ms.

- [ ] **Step 3: CPU and memory did not grow**

Run `PERF=1 E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/perf.e2e.ts` on the base and on
the change, with the same `PERF_REPORT` naming. Compare the core's CPU % and RSS.

Expected: within 5 %. The worker costs one isolate, roughly 5–10 MB RSS.

- [ ] **Step 4: The real Mac (owner's machine, with their go)**

Do this only with the owner's go: installing restarts their daemon.
- Install with `bash cli/scripts/install-cli.sh` from a worktree of the current release tag plus this
  diff, as was done for fix A (2026-10-15).
- Record children per minute and the core's `uv_spawn` share, before and after. Use `sample <core pid> 60`
  and the main-thread `awk` from Task 5 Step 5.
- Tell the owner the machine is now on a `-dev.` build that never self-updates; `harness update --force`
  returns it to releases.

- [ ] **Step 5: Write the results and the decision**

Append to the spec a "Results" section with three things:
- the medians table from Step 2;
- the perf comparison from Step 3;
- the real-Mac numbers from Step 4.

Then one of:
- **Gate met:** done. List any `execFileSync`/`spawnSync` still on a timer (Task 6) as follow-ups.
- **Gate missed:** quote what `sample` shows the main thread doing instead, and state that option 2 (the
  terminal data plane in its own worker) needs its own design document before any code.

- [ ] **Step 6: Checkpoint**

Run: `git status --short`
Expected: Tasks 1–7's files, uncommitted, for the owner to review and commit.
