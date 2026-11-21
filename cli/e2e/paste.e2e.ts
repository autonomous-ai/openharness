/** File drops cross the real edge worker; terminal authority and ordinary input stay in the core. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { everyPid, harnessdProcesses } from './harness/endurance.js'

const exec = promisify(execFile)
const CHUNK = 256 * 1024
type Process = { pid: number; started: string }
type Pane = { client: LocalClient; agentId: string; streamId: string; inputSeq: number; dataDir: string }
const stream = (pane: Pane, type: string) => (frame: Frame) => frame.type === type && frame.payload?.streamId === pane.streamId
const gone = (pid: number): boolean => {
  try { process.kill(pid, 0); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}
async function identity(pid: number): Promise<Process> {
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart=,comm='], { timeout: 3_000 })
  if (!stdout.trim()) throw new Error(`owned process ${pid} has no start identity`)
  return { pid, started: stdout.trim() }
}
async function signal(owned: Process, how: NodeJS.Signals): Promise<void> {
  expect(await identity(owned.pid), 'the captured owned process still holds this PID').toEqual(owned)
  process.kill(owned.pid, how)
}
async function stopped(owned: Process): Promise<boolean> {
  expect(await identity(owned.pid)).toEqual(owned)
  const { stdout } = await exec('ps', ['-p', String(owned.pid), '-o', 'state='], { timeout: 3_000 })
  return stdout.trim().startsWith('T')
}
async function bounded<T>(what: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: ${ms}ms deadline`)), ms) })]) }
  finally { clearTimeout(timer) }
}
function type(pane: Pane, text: string): void {
  pane.client.sendBinary({ kind: TerminalBinaryKind.input, streamId: pane.streamId, seq: pane.inputSeq++, compressed: false, bytes: Buffer.from(text) })
}
function chunk(pane: Pane, bytes: Buffer, seq = 0): void {
  pane.client.sendBinary({ kind: TerminalBinaryKind.pasteFile, streamId: pane.streamId, seq, compressed: false, bytes })
}
function begin(pane: Pane, bytes: number, filename: string): Promise<Frame> {
  // This result is correlated by stream, not requestId.
  const answer = pane.client.next(stream(pane, 'terminal_chunked_upload_begin_result'), 10_000, `begin ${filename}`)
  pane.client.send('terminal_chunked_upload_begin', { streamId: pane.streamId, uploadKind: 'file', totalBytes: bytes, filename })
  return answer
}
async function accepted(pane: Pane, bytes: number, filename: string): Promise<void> {
  expect((await begin(pane, bytes, filename)).payload).toMatchObject({ accepted: true })
}
async function typedTurn(pane: Pane, text: string): Promise<void> {
  const since = pane.client.frames.length
  type(pane, `${text}\r`)
  const started = await pane.client.waitFor(frame => frame.type === 'turn_started' && frame.agentId === pane.agentId
    && frame.payload?.userMessage === text, 5_000, `typed turn ${text}`, since)
  await pane.client.waitFor(frame => frame.type === 'turn_ended' && frame.agentId === pane.agentId,
    15_000, `ended ${text}`, pane.client.frames.indexOf(started) + 1)
}
async function finish(pane: Pane, bytes: Buffer, filename: string): Promise<string> {
  await accepted(pane, bytes.length, filename)
  return deliver(pane, bytes)
}
async function deliver(pane: Pane, bytes: Buffer): Promise<string> {
  const since = pane.client.frames.length
  for (let offset = 0; offset < bytes.length; offset += CHUNK) chunk(pane, bytes.subarray(offset, offset + CHUNK), offset / CHUNK)
  // Exactly the desktop's final window followed by Enter, with no worker-result wait in between.
  type(pane, '\r')
  const answer = await pane.client.waitFor(stream(pane, 'terminal_paste_file_result'), 35_000, 'file delivered', since)
  const path = answer.payload?.path as string
  expect(path.startsWith(`${join(pane.dataDir, 'paste-drops')}/`), 'read only this fixture\'s paste artifact').toBe(true)
  expect(relative(pane.dataDir, path)).not.toMatch(/^\.\./)
  expect(readFileSync(path)).toEqual(bytes)
  const started = await pane.client.waitFor(frame => frame.type === 'turn_started' && frame.agentId === pane.agentId
    && frame.payload?.userMessage === path, 5_000, 'file path submitted once', since)
  await pane.client.waitFor(frame => frame.type === 'turn_ended' && frame.agentId === pane.agentId,
    15_000, 'file path turn ended', pane.client.frames.indexOf(started) + 1)
  return path
}

// Windows has neither this fixture's tmux backend nor these process signals. This is not Windows evidence.
describe.skipIf(process.platform === 'win32')('file paste in the edge worker', () => {
  let daemon: IsolatedDaemon | undefined
  const clients: LocalClient[] = []
  const heartbeats: ReturnType<typeof setInterval>[] = []
  const paused = new Map<number, Process>()
  const pids = new Set<number>()
  let core: Process | undefined

  afterEach(async () => {
    const d = daemon
    try {
      for (const owned of paused.values()) if (!gone(owned.pid)) await signal(owned, 'SIGCONT')
    } finally {
      paused.clear()
      heartbeats.splice(0).forEach(clearInterval)
      clients.splice(0).forEach(client => client.close())
      if (d) {
        everyPid(d).forEach(pid => pids.add(pid))
        await bounded('private daemon cleanup', d.close(), 45_000)
        await until('every captured fixture PID gone', () => [...pids].every(gone) || null, 5_000, 50)
        expect(existsSync(d.root), 'private home and artifacts removed').toBe(false)
      }
      pids.clear(); daemon = undefined; core = undefined
    }
  }, 55_000)

  async function fresh(env: Record<string, string> = {}, held = false) {
    const d = daemon = await IsolatedDaemon.create({ submissionGate: true, env })
    const gate = join(d.root, 'hold-paste')
    if (held) { writeFileSync(gate, 'hold'); d.env.HARNESSD_TEST_HOLD_CONNECT = `paste:${gate}` }
    onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
    await d.start()
    core = await identity(d.corePid()!)
    pids.add(core.pid)
    if (!held && !env.HARNESSD_TEST_FAULTS) await connected(d)
    return { d, gate }
  }
  async function connected(d: IsolatedDaemon, since = 0): Promise<void> {
    await until('paste connected to this core', () => d.log().slice(since).includes('[services] paste connected') || null, 30_000, 50)
  }
  async function pane(d: IsolatedDaemon, name: string, existing?: LocalClient): Promise<Pane> {
    const client = existing ?? await bounded('private client connected', LocalClient.connect(d), 10_000)
    if (!existing) clients.push(client)
    const cwd = join(d.projectsDir, name); mkdirSync(cwd)
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error).toBeUndefined()
    const agent = await until('fake Claude bound', async () => (await client.request('agents_list', {}, 5_000)).agents
      .find((row: Record<string, any>) => row.id === created.agent.id && row.status === 'active' && row.sessionId), 30_000, 100)
    const owned = await client.request('terminal_info', { agentId: agent.id }, 5_000)
    expect(owned.error).toBeUndefined()
    expect(Number.isSafeInteger(owned.pid) && owned.pid > 0).toBe(true)
    pids.add(owned.pid)
    const tmuxPid = Number(await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pid}'))
    expect(Number.isSafeInteger(tmuxPid) && tmuxPid > 0).toBe(true)
    pids.add(tmuxPid)
    const since = client.binaries.length
    const requestId = `open-${name}`
    const ready = client.next(frame => frame.type === 'terminal_ready' && frame.payload?.requestId === requestId, 10_000, 'terminal ready')
    client.send('terminal_open', { requestId, protocolVersion: 3, agentId: agent.id, cols: 100, rows: 30 })
    const streamId = (await ready).payload?.streamId as string
    await client.waitForBinary(frame => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe, 5_000, 'opening keyframe', since)
    // A connected desktop keeps its lease while a worker is frozen; otherwise the 30s terminal
    // lease could hide the distinct 30s upload deadline this fixture must observe.
    heartbeats.push(setInterval(() => {
      if (client.closed) return
      client.send('terminal_alive', { streamId })
      const drawn = client.binaries.findLast(frame => frame.streamId === streamId)
      if (drawn) client.send('terminal_ack', { streamId, lastSeq: drawn.seq })
    }, 5_000))
    return { client, agentId: agent.id, streamId, inputSeq: 0, dataDir: d.dataDir }
  }
  async function edge(d: IsolatedDaemon): Promise<Process> {
    const pid = harnessdProcesses(d).get('edge')
    expect(pid).toBeDefined()
    pids.add(pid!)
    return identity(pid!)
  }
  async function freeze(owned: Process): Promise<void> {
    await signal(owned, 'SIGSTOP'); paused.set(owned.pid, owned)
    await until('owned edge stopped', () => stopped(owned), 5_000, 50)
  }
  async function resume(owned: Process): Promise<void> {
    await signal(owned, 'SIGCONT'); paused.delete(owned.pid)
  }
  async function inputAndStop(p: Pane): Promise<void> {
    await typedTurn(p, 'ordinary input while paste is unavailable')
    const since = p.client.frames.length
    expect((await p.client.request('agent_delete', { agentId: p.agentId }, 10_000)).error).toBeUndefined()
    await p.client.waitFor(stream(p, 'terminal_closed'), 5_000, 'Stop closed the other terminal', since)
  }
  async function sameCore(d: IsolatedDaemon): Promise<void> {
    expect(d.coresStarted()).toBe(1)
    expect(await identity(d.corePid()!)).toEqual(core)
  }
  function submitted(d: IsolatedDaemon): string[] {
    const path = join(d.root, 'submitted-prompts')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  function results(p: Pane, since = 0): Frame[] { return p.client.frames.slice(since).filter(stream(p, 'terminal_paste_file_result')) }
  async function partial(p: Pane, filename: string): Promise<void> {
    await accepted(p, CHUNK * 4, filename)
    const progress = p.client.next(stream(p, 'terminal_chunked_upload_progress'), 10_000, 'first file chunk settled')
    chunk(p, Buffer.alloc(CHUNK, 1))
    expect((await progress).payload).toMatchObject({ bytesWritten: CHUNK, totalBytes: CHUNK * 4 })
  }
  function failure(p: Pane, since: number): Promise<Frame> {
    return p.client.waitFor(frame => stream(p, 'terminal_error')(frame) && frame.payload?.code === 'TERMINAL_PASTE_FILE_FAILED',
      35_000, 'visible file upload failure', since)
  }
  function onlyFresh(d: IsolatedDaemon, p: Pane, path: string, since: number): void {
    expect(results(p, since).map(frame => frame.payload?.path)).toEqual([path])
    const own = submitted(d).filter(text => text.startsWith(join(d.dataDir, 'paste-drops')))
    expect(own).toEqual([path])
    expect(relative(d.dataDir, path)).not.toMatch(/^\.\./)
  }

  it('delivers four chunks once and orders the next Enter after the path, including a replay', async () => {
    const { d } = await fresh()
    const p = await pane(d, 'four-chunks')
    const bytes = Buffer.alloc(CHUNK * 4, 37)
    const path = await finish(p, bytes, 'four.bin')
    chunk(p, bytes.subarray(CHUNK * 3), 3)
    await typedTurn(p, 'after the completed chunk replay')
    onlyFresh(d, p, path, 0)
    expect(p.client.frames.filter(frame => frame.type === 'turn_started' && frame.agentId === p.agentId && frame.payload?.userMessage === path)).toHaveLength(1)
    expect(p.client.frames.filter(stream(p, 'terminal_chunked_upload_progress')).map(frame => frame.payload?.bytesWritten)).toEqual([CHUNK, CHUNK * 2, CHUNK * 3, CHUNK * 4])
    await sameCore(d)
  }, 150_000)

  it('Cancel and a new begin replace a frozen generation through the same socket without stale delivery', async () => {
    const { d } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '120000' })
    const p = await pane(d, 'cancelled'), other = await pane(d, 'cancel-neighbour', p.client)
    await accepted(p, CHUNK, 'cancelled.bin')
    const worker = await edge(d); await freeze(worker)
    const since = p.client.frames.length
    chunk(p, Buffer.alloc(CHUNK, 1))
    p.client.send('terminal_chunked_upload_cancel', { streamId: p.streamId })
    await typedTurn(other, 'ordinary input while an upload is cancelled')
    expect(await stopped(worker)).toBe(true)
    const bytes = Buffer.from('fresh after Cancel')
    const next = begin(p, bytes.length, 'fresh-cancel.bin')
    void next.catch(() => {}) // Observed below; keep a fast refusal handled while resuming the worker.
    // A same-socket request proves dispatch continued; do not await the frozen worker's begin reply.
    await p.client.request('agents_list', {}, 5_000)
    await resume(worker)
    expect((await next).payload).toMatchObject({ accepted: true })
    const path = await deliver(p, bytes)
    await typedTurn(p, 'after the cancelled generation')
    onlyFresh(d, p, path, since)
    expect(p.client.frames.slice(since).filter(stream(p, 'terminal_chunked_upload_progress')).map(frame => frame.payload?.bytesWritten)).toEqual([bytes.length])
    expect(p.client.frames.slice(since).filter(stream(p, 'terminal_error'))).toEqual([])
    await sameCore(d)
  }, 150_000)

  it('a killed edge fails the current upload visibly, preserves input and Stop, and restarts for a fresh drop', async () => {
    const { d } = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '5000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '5000' })
    const p = await pane(d, 'killed'), other = await pane(d, 'kill-neighbour', p.client)
    await partial(p, 'incomplete-killed.bin')
    const worker = await edge(d), log = d.log().length, since = p.client.frames.length
    await signal(worker, 'SIGKILL')
    await until('paste disconnected after edge death', () => d.log().slice(log).includes('[services] paste disconnected') || null, 5_000, 50)
    chunk(p, Buffer.alloc(CHUNK, 2), 1)
    expect((await failure(p, since)).payload?.message).toMatch(/^PASTE_[A-Z_]+$/)
    expect(results(p, since)).toEqual([])
    await inputAndStop(other)
    await until('a new owned edge PID', () => { const now = harnessdProcesses(d).get('edge'); return now && now !== worker.pid ? now : null }, 30_000, 50)
    await connected(d, log); await edge(d)
    const path = await finish(p, Buffer.from('fresh after edge restart'), 'fresh-restart.bin')
    await typedTurn(p, 'after the killed upload')
    onlyFresh(d, p, path, since)
    // A crashed worker may leave its private .part until the existing orphan retention expires.
    await sameCore(d)
  }, 150_000)

  it('a frozen edge reaches the unchanged chunk deadline while input and Stop work, then recovers without a late path', async () => {
    const { d } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '120000' })
    const p = await pane(d, 'hung'), other = await pane(d, 'hang-neighbour', p.client)
    await partial(p, 'incomplete-hung.bin')
    const worker = await edge(d); await freeze(worker)
    const since = p.client.frames.length, sentAt = performance.now()
    const failed = failure(p, since).then(answer => ({ answer, elapsed: performance.now() - sentAt }))
    chunk(p, Buffer.alloc(CHUNK, 2), 1)
    // Observe both promises immediately, so neither a fast refusal nor a failed input is unhandled.
    const [failureAt] = await Promise.all([failed, inputAndStop(other)])
    expect(failureAt.elapsed, 'the upload reached its existing 30s result deadline').toBeGreaterThanOrEqual(29_000)
    expect(failureAt.answer.payload?.message).toMatch(/^PASTE_[A-Z_]+$/)
    expect(await stopped(worker)).toBe(true)
    expect(results(p, since)).toEqual([])
    await resume(worker)
    const path = await finish(p, Buffer.from('fresh after the chunk deadline'), 'fresh-timeout.bin')
    await typedTurn(p, 'after the timed out upload')
    onlyFresh(d, p, path, since)
    await sameCore(d)
  }, 150_000)

  it('a held-off paste connection refuses promptly while input and Stop work, then connects for a fresh upload', async () => {
    const { d, gate } = await fresh({}, true)
    const p = await pane(d, 'held'), other = await pane(d, 'held-neighbour', p.client)
    expect((await begin(p, 3, 'held.bin')).payload).toMatchObject({ accepted: false, reason: 'PASTE_UNAVAILABLE' })
    expect(results(p)).toEqual([])
    await inputAndStop(other)
    const log = d.log().length; rmSync(gate)
    await connected(d, log)
    const path = await finish(p, Buffer.from('fresh after connection'), 'fresh-connected.bin')
    await typedTurn(p, 'after paste connected')
    onlyFresh(d, p, path, 0)
    await sameCore(d)
  }, 150_000)

  it('a paste service that fails to start refuses visibly without an inline file fallback or blocking input and Stop', async () => {
    const { d } = await fresh({ HARNESSD_TEST_FAULTS: 'paste' })
    const p = await pane(d, 'failed-start'), other = await pane(d, 'failed-start-neighbour', p.client)
    expect((await begin(p, 3, 'unavailable.bin')).payload).toMatchObject({ accepted: false, reason: 'PASTE_UNAVAILABLE' })
    chunk(p, Buffer.from('bad'))
    await inputAndStop(other)
    await typedTurn(p, 'after refused paste')
    expect(results(p)).toEqual([])
    expect(submitted(d).some(text => text.includes('unavailable.bin'))).toBe(false)
    const files = join(d.dataDir, 'paste-drops', 'file-uploads')
    expect(existsSync(files) ? readdirSync(files) : []).toEqual([])
    expect(d.log()).not.toContain('[services] paste connected')
    await sameCore(d)
  }, 150_000)
})
