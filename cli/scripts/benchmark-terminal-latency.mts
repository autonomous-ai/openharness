// Real local/remote terminal round trips through the running Harness daemon.
// Creates one named disposable terminal and deletes only that terminal in finally.
// No agent/model is launched. Results contain synthetic observations, not terminal history.
// Usage: npx tsx scripts/benchmark-terminal-latency.mts --machine ID --label local --output /tmp/result.json
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { platform, arch } from 'node:os'
import { deflateSync, inflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind } from '../src/lib/terminalBinary.ts'

const { values } = parseArgs({ options: {
  machine: { type: 'string' }, label: { type: 'string', default: 'target' },
  output: { type: 'string' }, samples: { type: 'string', default: '200' },
  port: { type: 'string', default: '18473' },
  local: { type: 'boolean', default: false },
  'control-samples': { type: 'string', default: '30' },
  revision: { type: 'string' },
} })
if (!values.machine || !values.output) throw new Error('--machine and --output are required')
const sampleCount = Number(values.samples)
const controlCount = Number(values['control-samples'])
const port = Number(values.port)
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 2000) throw new Error('samples must be 1–2000')
if (!Number.isInteger(controlCount) || controlCount < 1 || controlCount > 500) throw new Error('control-samples must be 1–500')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
if (existsSync(values.output)) throw new Error('output already exists; use a fresh result path')
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const now = () => performance.now()
type Frame = { type: string; payload: Record<string, any> }
type Waiter = { test: (frame: Frame) => boolean; resolve: (frame: Frame) => void; reject: (error: Error) => void }
const nonce = randomUUID().replaceAll('-', '')
const prefix = `~HB${nonce}:`
const rows: Record<string, unknown>[] = []
const controls: Record<string, unknown>[] = []
const result: Record<string, any> = {
  schema: 2, success: false, startedAt: new Date().toISOString(), label: values.label,
  sourceRevision: values.revision ?? 'unspecified',
  boundary: 'client binary input send to matching PTY probe response received; excludes UI rendering and OS keyboard input',
  client: { platform: platform(), arch: arch(), node: process.version },
  samplesPerWorkload: sampleCount, warmupsPerWorkload: 10,
  controlSamplesPerRoute: controlCount, controlObservations: controls,
  observations: rows, stagesMs: {}, cleanup: { created: false, deleted: false },
  linkModes: [],
}

class Peer {
  readonly socket = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`, { handshakeTimeout: 10000 })
  readonly opened: Promise<void>
  readonly waiters = new Set<Waiter>()
  readonly modes: { atMs: number; mode: string }[] = []
  stream = ''
  inputSeq = -1
  mode = values.local ? 'loopback' : 'unknown'
  output = ''
  outputBytes = 0
  keyframes = 0
  fatal: Error | null = null
  outputWaiter: { marker: string; began: number; resolve: (elapsed: number) => void; reject: (error: Error) => void } | null = null
  alive: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('error', (error) => this.fail(error))
    this.socket.on('close', (code) => this.fail(new Error(`connection closed (${code})`)))
    this.socket.on('message', (raw, binary) => {
      try {
        if (binary) {
          const frame = decodeTerminalLocal(new Uint8Array(raw as Buffer))
          if (!frame || (this.stream && frame.streamId !== this.stream)) return
          if (frame.kind === TerminalBinaryKind.keyframe) this.keyframes++
          if (frame.kind === TerminalBinaryKind.output || frame.kind === TerminalBinaryKind.keyframe) {
            const bytes = frame.compressed ? inflateSync(frame.bytes) : frame.bytes
            this.outputBytes += bytes.length
            this.output = (this.output + Buffer.from(bytes).toString('utf8')).slice(-128 * 1024)
            const pending = this.outputWaiter
            if (pending && this.output.includes(pending.marker)) {
              this.outputWaiter = null
              pending.resolve(now() - pending.began)
            }
          }
          // This is a transport consumer, not a renderer. Acknowledge consumed bytes.
          this.send('terminal_ack', { streamId: frame.streamId, lastSeq: frame.seq })
          return
        }
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.type === 'terminal_link_mode') {
          this.mode = String(frame.payload.mode)
          this.modes.push({ atMs: now(), mode: this.mode })
        }
        for (const waiter of [...this.waiters]) {
          if (waiter.test(frame)) { this.waiters.delete(waiter); waiter.resolve(frame) }
        }
        if (frame.type === 'terminal_error' && !frame.payload.requestId) {
          this.fail(new Error(`terminal error: ${String(frame.payload.error ?? frame.payload.code)}`))
        }
      } catch (error) { this.fail(error as Error) }
    })
  }

  fail(error: Error) {
    this.fatal = error
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
    this.outputWaiter?.reject(error)
    this.outputWaiter = null
  }

  send(type: string, payload: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('socket is not open')
    this.socket.send(JSON.stringify({ type, payload }))
  }

  wait(test: Waiter['test'], ms = 30000): Promise<Frame> {
    if (this.fatal) return Promise.reject(this.fatal)
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, frame?: Frame) => {
        clearTimeout(timer); this.waiters.delete(waiter)
        if (error) reject(error); else resolve(frame!)
      }
      const waiter: Waiter = { test, resolve: (frame) => finish(undefined, frame), reject: finish }
      const timer = setTimeout(() => finish(new Error('timed out waiting for a protocol reply')), ms)
      this.waiters.add(waiter)
    })
  }

  async select() {
    await this.opened
    const ready = this.wait((frame) => frame.type === 'connected' || frame.type === 'machine_select_error')
    const began = now()
    this.send('machine_select', { machineId: values.machine, localProtocolVersion: 1 })
    const frame = await ready
    if (frame.type !== 'connected') throw new Error(`machine selection: ${String(frame.payload.error)}`)
    return now() - began
  }

  async rpc(type: string, payload: Record<string, unknown>) {
    const requestId = randomUUID()
    const ready = this.wait((frame) => frame.type === `${type}_result` && frame.payload.requestId === requestId)
    this.send(type, { requestId, ...payload })
    const frame = await ready
    if (frame.payload.error) throw new Error(`${type}: ${String(frame.payload.error)}`)
    return frame.payload
  }

  async attach(agentId: string) {
    const requestId = randomUUID()
    const ready = this.wait((frame) => ['terminal_ready', 'terminal_error'].includes(frame.type) && frame.payload.requestId === requestId)
    const began = now()
    this.send('terminal_open', { requestId, agentId, cols: 120, rows: 40, protocolVersion: 3,
      compression: ['zlib'], takeover: false, client: { kind: 'benchmark', name: 'Disposable latency probe' } })
    const frame = await ready
    if (frame.type !== 'terminal_ready' || frame.payload.readOnly) throw new Error('disposable terminal could not be attached for input')
    this.stream = String(frame.payload.streamId)
    this.inputSeq = -1
    this.alive = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN) this.send('terminal_alive', { streamId: this.stream })
    }, 5000)
    return now() - began
  }

  input(bytes: Buffer) {
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: this.stream,
      seq: ++this.inputSeq, bytes, compressed: false })
    if (!frame) throw new Error('input encoding failed')
    this.socket.send(frame, { binary: true })
  }

  exchange(bytes: Buffer, marker: string, ms = 15000, paste = false): Promise<number> {
    if (this.fatal) return Promise.reject(this.fatal)
    if (this.outputWaiter) throw new Error('overlapping input probes')
    this.output = ''
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, elapsed?: number) => {
        clearTimeout(timer); this.outputWaiter = null
        if (error) reject(error); else resolve(elapsed!)
      }
      const timer = setTimeout(() => finish(new Error(`PTY response timeout (${ms} ms)`)), ms)
      this.outputWaiter = { marker, began: now(), resolve: (elapsed) => finish(undefined, elapsed), reject: finish }
      if (paste) {
        const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.paste, streamId: this.stream,
          seq: 0, bytes, compressed: false })
        if (!frame) throw new Error('paste encoding failed')
        this.socket.send(frame, { binary: true })
        this.input(Buffer.from('\r'))
      } else {
        this.input(bytes)
      }
    })
  }

  close() {
    if (this.alive) clearInterval(this.alive)
    this.alive = null
    result.linkModes.push(...this.modes)
    this.modes.length = 0
    this.socket.close()
  }
}

// Encoded before shell input: the shell's echo cannot satisfy READY/ECHO checks.
// Raw tty mode means every probe traverses stdin -> Python -> stdout -> tmux.
const probe = `import os,sys,termios,tty,threading,time,platform
fd=sys.stdin.fileno()
saved=termios.tcgetattr(fd)
prefix=${JSON.stringify(prefix)}
lock=threading.Lock()
busy=threading.Event()
done=threading.Event()
def emit(s):
 with lock: os.write(1,s.encode())
def output():
 while not done.wait(.05):
  if busy.is_set(): emit('\\x1b7\\x1b[2;1H'+('background output '*240)+'\\x1b8')
try:
 tty.setraw(fd)
 threading.Thread(target=output,daemon=True).start()
 emit(prefix+'READY:'+platform.system()+':'+platform.machine()+'~')
 n=0
 while True:
  b=os.read(fd,1)
  if b==b'\\x04' or not b: break
  if b==b'\\x02':
   busy.set()
   emit('\\r\\n'+prefix+'LOAD:1~')
  elif b==b'\\x01':
   busy.clear()
   emit('\\r\\n'+prefix+'LOAD:0~')
  else:
   emit('\\r\\n'+prefix+'ECHO:'+str(n)+':'+str(b[0])+'~')
   n+=1
finally:
 done.set()
 termios.tcsetattr(fd,termios.TCSADRAIN,saved)
`
let peer = new Peer()
let agentId: string | undefined
let echoSeq = 0
const interrupted = () => peer.fail(new Error('benchmark interrupted; attempting probe cleanup'))
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)
try {
  const status = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()) as { version?: string }
  result.client.daemonVersion = status.version ?? 'unknown'
  const connectionBegan = now()
  result.stagesMs.select = await peer.select()
  await peer.rpc('terminal_capabilities', {})
  result.stagesMs.readyForRequests = now() - connectionBegan
  const began = now()
  const created = await peer.rpc('agent_create', { engine: 'terminal', name: `Performance probe ${nonce.slice(0, 8)}`, cwd: '/tmp', bypassPermission: false })
  agentId = created.agent?.id
  if (!agentId || created.agent?.engine !== 'terminal') throw new Error('probe terminal was not created')
  result.cleanup.created = true
  result.stagesMs.createTerminal = now() - began
  result.stagesMs.attach = await peer.attach(agentId)
  const command = `python3 -u -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode("${deflateSync(Buffer.from(probe)).toString('base64')}")))'`
  result.stagesMs.startProbe = await peer.exchange(Buffer.from(command), prefix + 'READY:', 15000, true)
  result.target = peer.output.match(new RegExp(`${prefix}READY:([^~]+)~`))?.[1] ?? 'unknown'
  // Permit normal direct-path negotiation; record actual modes on every observation.
  await sleep(2000)
  // Measure control separately: streamless RPCs may use the cloud while a known
  // terminal stream uses P2P. Neither is an ICMP ping or pure network latency.
  for (let sample = -3; sample < controlCount; sample++) {
    const routes = sample % 2 === 0 ? ['machine', 'terminal_stream'] : ['terminal_stream', 'machine']
    for (const route of routes) {
      const modeBefore = peer.mode
      const began = now()
      await peer.rpc('terminal_capabilities', route === 'terminal_stream' ? { streamId: peer.stream } : {})
      controls.push({ route, phase: sample < 0 ? 'warmup' : 'measured', elapsedMs: now() - began,
        terminalModeBefore: modeBefore, terminalModeAfter: peer.mode })
    }
  }
  for (const load of ['idle', 'redraw_20hz']) {
    if (load !== 'idle') { await peer.exchange(Buffer.from([2]), `${prefix}LOAD:1~`); await sleep(150) }
    const bytesBefore = peer.outputBytes
    const loadBegan = now()
    for (let sample = -10; sample < sampleCount; sample++) {
      // Pre-input think time is outside the measurement. Vary timing deterministically.
      await sleep(8 + ((sample + 10) * 11 % 35))
      const byte = 97 + echoSeq % 26
      const modeBefore = peer.mode
      const keyframesBefore = peer.keyframes
      const elapsed = await peer.exchange(Buffer.from([byte]), `${prefix}ECHO:${echoSeq}:${byte}~`)
      rows.push({ load, phase: sample < 0 ? 'warmup' : 'measured', sequence: echoSeq++, elapsedMs: elapsed,
        modeBefore, modeAfter: peer.mode, keyframesDuring: peer.keyframes - keyframesBefore })
    }
    result[`${load}Achieved`] = { bytes: peer.outputBytes - bytesBefore, durationMs: now() - loadBegan }
    if (load !== 'idle') await peer.exchange(Buffer.from([1]), `${prefix}LOAD:0~`)
  }
  const restoreBegan = now()
  peer.close()
  peer = new Peer()
  await peer.select()
  await peer.attach(agentId)
  const byte = 97 + echoSeq % 26
  const echoMs = await peer.exchange(Buffer.from([byte]), `${prefix}ECHO:${echoSeq}:${byte}~`)
  result.reattach = { totalMs: now() - restoreBegan, firstEchoMs: echoMs, sameProbeSequence: echoSeq,
    mode: peer.mode, boundary: 'new local client socket, existing daemon route and same running PTY; not a network outage' }
  result.success = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  result.failureDiagnostics = { outputBytes: peer.outputBytes, keyframes: peer.keyframes,
    mode: peer.mode, inputSeq: peer.inputSeq, outputTail: peer.output.slice(-1200) }
  process.exitCode = 1
} finally {
  if (agentId) {
    try {
      if (peer.fatal || peer.socket.readyState !== WebSocket.OPEN) {
        peer.close()
        peer = new Peer()
        await peer.select()
      }
      // The ID is only the terminal returned by this invocation's agent_create.
      const deleted = await peer.rpc('agent_delete', { agentId })
      if (deleted.deleted !== true) throw new Error('daemon did not confirm probe deletion')
      result.cleanup.deleted = true
    } catch (error) {
      result.cleanup = { deleted: false, agentId, error: String(error) }
      result.success = false; process.exitCode = 1
    }
  }
  peer.close()
  result.finishedAt = new Date().toISOString()
  result.summaries = ['idle', 'redraw_20hz'].map((load) => {
    const values = rows.filter((row) => row.load === load && row.phase === 'measured').map((row) => Number(row.elapsedMs)).sort((a,b) => a-b)
    const at = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1] : null
    return { load, samples: values.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: values.at(-1) ?? null }
  })
  result.controlSummaries = ['machine', 'terminal_stream'].map((route) => {
    const values = controls.filter((row) => row.route === route && row.phase === 'measured').map((row) => Number(row.elapsedMs)).sort((a,b) => a-b)
    const at = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1] : null
    return { route, samples: values.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: values.at(-1) ?? null }
  })
  result.summariesByTerminalMode = [...new Set(rows.map((row) => `${row.load}/${row.modeBefore === row.modeAfter ? row.modeAfter : 'changed_during_sample'}`))].map((group) => {
    const [load, mode] = group.split('/')
    const values = rows.filter((row) => row.phase === 'measured' && row.load === load
      && (row.modeBefore === row.modeAfter ? row.modeAfter : 'changed_during_sample') === mode)
      .map((row) => Number(row.elapsedMs)).sort((a,b) => a-b)
    const at = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1] : null
    return { load, mode, samples: values.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: values.at(-1) ?? null }
  })
  process.removeListener('SIGINT', interrupted)
  process.removeListener('SIGTERM', interrupted)
  writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ label: values.label, success: result.success, summaries: result.summaries, stagesMs: result.stagesMs,
    controlSummaries: result.controlSummaries, reattach: result.reattach, target: result.target, cleanup: result.cleanup, error: result.error }))
}
