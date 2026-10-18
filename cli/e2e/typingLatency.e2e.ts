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
      const flooding = !(await d.tmux.run('capture-pane', '-p', '-t', others[0].tmuxPane)).includes('flooded')
      conditions[label] = {
        rawPty: raw, tmuxDirect: tmux, daemon, loadAverage: [loadBefore, loadavg()[0]], flooding,
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
    // The same floods with no window holding their panes: what showing no output for a hidden pane could
    // save at most (the floods go on in tmux, read by no control client of the daemon's).
    for (const s of otherStreams) client.send('terminal_close', { streamId: s })
    await sleep(1_500)
    await measure('flood-closed')
    burn(); await sleep(1_000); await measure('cpu-flood-closed'); unburn()

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
