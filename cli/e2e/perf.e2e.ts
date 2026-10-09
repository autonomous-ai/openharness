/**
 * PERF=1 E2E_BUNDLE=1: an isolated signed-in core, 25 agents, four turning and two windows.
 * PERF_SECONDS=60, PERF_AGENTS=25, PERF_ACTIVE=4, PERF_WARMUP_SECONDS=20, PERF_HISTORY_MIB=1.
 * PERF_PROFILE=1 adds node --cpu-prof; PERF_HEAP=1 writes snapshots AFTER measurement windows.
 * PERF_REPORT=<file> writes JSON; raw artifacts stay in its recorded private temporary directory.
 * Run alone. CPU is the core's process CPU (100% = one logical CPU), never the master's/children's.
 * PERF_READERS=1 additionally measures reader PIDs and history pages every 2 s; totals include them.
 * PERF_MODEL_CONTROLS=1 adds a window of alternating model changes in the two engine types.
 * PERF_QUESTIONS=1 adds a window of questions asked and answered through `question_response`
 * (e2e/harness/questionWork.ts): PERF_QUESTION_AGENTS (default all) agents ask again and again, Claude Code
 * a choice, a multiSelect, a typed answer and a permission, Codex a choice and a permission. It measures the
 * core and both engine workers (the workers without PERF_READERS' history pages), the master by `ps`, answer
 * latency and errors, and compares every answer sent with the one the engine's transcript recorded.
 * PERF_QUESTION_SECONDS (default PERF_SECONDS) is that window's length.
 * PERF_BUNDLE_SOURCE identifies an externally built baseline bundle; its bytes are hashed either way.
 * On macOS set HARNESS_PROCESS_IMAGES_ARTIFACT to a verified local build for release-like discovery.
 */
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { askAndAnswer, compareAnswers, engineAnswers, QUESTION_KINDS, summarizeAnswers, type QuestionEngine, type QuestionOutcome } from './harness/questionWork.js'

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
function transcriptBytes(directory: string): number {
  if (!existsSync(directory)) return 0
  return readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
    const file = join(directory, entry.name)
    return bytes + (entry.isDirectory() ? transcriptBytes(file) : entry.isFile() && entry.name.endsWith('.jsonl') ? statSync(file).size : 0)
  }, 0)
}
/** The master's CPU and resident memory from `ps`: the probe runs in the core and the engine workers only. */
const ps = (pid: number) => new Promise<{ cpuSeconds: number; rssBytes: number } | null>((done) => {
  execFile('ps', ['-o', 'time=,rss=', '-p', String(pid)], { timeout: 3_000 }, (error, stdout) => {
    const [time, rss] = String(stdout).trim().split(/\s+/)
    if (error || !time || !rss) { done(null); return }
    done({ cpuSeconds: time.split(':').reverse().reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0), rssBytes: Number(rss) * 1024 })
  })
})
function sampleProcess(pid: number) {
  const startedAt = performance.now()
  const rss: number[] = []
  const first = ps(pid)
  const timer = setInterval(() => { void ps(pid).then(sample => { if (sample) rss.push(sample.rssBytes) }) }, 1_000)
  return async () => {
    clearInterval(timer)
    const [begin, end] = [await first, await ps(pid)]
    const seconds = (performance.now() - startedAt) / 1000
    if (end) rss.push(end.rssBytes)
    return { pid, durationSeconds: seconds, source: 'ps (10 ms CPU resolution)',
      cpu: { percent: begin && end ? 100 * (end.cpuSeconds - begin.cpuSeconds) / seconds : null },
      memory: { rssMean: rss.length ? rss.reduce((a, b) => a + b, 0) / rss.length : null, rssMax: rss.length ? Math.max(...rss) : null, samples: rss.length } }
  }
}
function knob(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return n
}

/** A renderer's cadence, not a request flood: ACK a received batch after painting, heartbeat at 5 s,
 *  and reconcile inventory at 60 s (the desktop's terminal_session.dart and app_state.dart). */
class PerfWindow {
  readonly streams = new Set<string>()
  readonly errors: string[] = []
  bytes = 0
  keyframes = 0
  outputs = 0
  inventories = 0
  private timers: ReturnType<typeof setInterval>[] = []
  constructor(readonly client: LocalClient) {}
  async open(agentId: string): Promise<void> {
    const requestId = randomUUID()
    // QA #908: record before the request; ready and its keyframe can share a socket callback.
    const since = this.client.binaries.length
    const answer = this.client.next(f => ['terminal_ready', 'terminal_error'].includes(f.type)
      && f.payload?.requestId === requestId, 30_000, 'performance terminal ready')
    this.client.send('terminal_open', { requestId, protocolVersion: 3, agentId, cols: 100, rows: 30 })
    const ready = await answer
    expect(ready.type, JSON.stringify(ready.payload)).toBe('terminal_ready')
    const id = String(ready.payload!.streamId)
    await this.client.waitForBinary(f => f.streamId === id && f.kind === TerminalBinaryKind.keyframe, 20_000, 'opening screen', since)
    this.streams.add(id)
  }
  start(): void {
    this.timers.push(setInterval(() => {
      const drawn = new Map<string, number>()
      for (const frame of this.client.binaries.splice(0)) {
        if (!this.streams.has(frame.streamId)) continue
        this.bytes += frame.bytes.length
        if (frame.kind === TerminalBinaryKind.keyframe) this.keyframes++
        if (frame.kind === TerminalBinaryKind.output) this.outputs++
        drawn.set(frame.streamId, frame.seq)
      }
      for (const [streamId, lastSeq] of drawn) this.client.send('terminal_ack', { streamId, lastSeq })
      for (const frame of this.client.frames.splice(0)) {
        if ((frame.type === 'terminal_closed' || frame.type === 'terminal_error' || frame.type === 'error') && this.errors.length < 10) {
          this.errors.push(JSON.stringify(frame))
        }
      }
    }, 16))
    this.timers.push(setInterval(() => {
      for (const streamId of this.streams) this.client.send('terminal_alive', { streamId })
    }, 5_000))
    this.timers.push(setInterval(() => {
      void this.client.request('agents_list', { includeStopped: true }, 10_000)
        .then(answer => { if (answer.error) throw new Error(String(answer.error)); this.inventories++ })
        .catch(error => { if (this.errors.length < 10) this.errors.push(String(error)) })
    }, 60_000))
  }
  stats() { return { bytes: this.bytes, keyframes: this.keyframes, outputs: this.outputs, inventories: this.inventories } }
  stop(): void { for (const timer of this.timers.splice(0)) clearInterval(timer) }
}

describe.runIf(process.env.PERF === '1')('core CPU and memory under a working desk', () => {
  it('reports empty, populated-idle and turning windows without losing an agent or stream', async () => {
    const agents = knob('PERF_AGENTS', 25, 4, 100)
    const active = knob('PERF_ACTIVE', 4, 2, agents)
    const seconds = knob('PERF_SECONDS', 60, 10, 600)
    const warmup = knob('PERF_WARMUP_SECONDS', 20, 0, 120)
    const historyMiB = knob('PERF_HISTORY_MIB', 1, 0, 8)
    const measureReaders = process.env.PERF_READERS === '1'
    const measureControls = process.env.PERF_MODEL_CONTROLS === '1'
    const measureQuestions = process.env.PERF_QUESTIONS === '1'
    const questionSeconds = knob('PERF_QUESTION_SECONDS', seconds, 10, 900)
    const questionAgents = knob('PERF_QUESTION_AGENTS', agents, 2, agents)
    // The engine workers' probes: with history pages (PERF_READERS), or for the question window, without.
    const measureWorkers = measureReaders || measureQuestions
    const profile = process.env.PERF_PROFILE === '1'
    const heaps = process.env.PERF_HEAP === '1'
    const bundle = process.env.E2E_BUNDLE_PATH
    if (!bundle) throw new Error('PERF requires E2E_BUNDLE=1 so every process runs one frozen bundle')
    const artifactDir = mkdtempSync(join(tmpdir(), 'core-perf-'))
    const reportFile = process.env.PERF_REPORT ? resolve(process.env.PERF_REPORT) : join(artifactDir, 'report.json')
    mkdirSync(dirname(reportFile), { recursive: true })
    const preload = fileURLToPath(new URL('./harness/corePerf.cjs', import.meta.url))
    const token = randomBytes(24).toString('hex')
    const nodeOptions = [`--require=${JSON.stringify(preload)}`]
    if (profile) nodeOptions.push('--cpu-prof', `--cpu-prof-dir=${JSON.stringify(artifactDir)}`)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: CLI_ROOT, encoding: 'utf8', timeout: 5_000 }).trim()
    const report: Record<string, any> = {
      schema: 1, state: 'running', startedAt: new Date().toISOString(), artifactDir,
      source: { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
        dirty: Boolean(git('status', '--porcelain')), bundleSource: process.env.PERF_BUNDLE_SOURCE ?? git('rev-parse', 'HEAD'), bundleSha256: sha(bundle), preloadSha256: sha(preload) },
      machine: { platform: platform(), release: release(), node: process.version, logicalCpus: cpus().length,
        cpu: cpus()[0]?.model, ramBytes: totalmem(), tmux: execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 }).trim() },
      workload: { modelControls: measureControls,
        questions: measureQuestions ? { agents: questionAgents, seconds: questionSeconds, kinds: QUESTION_KINDS, answeredThrough: 'question_response from a local window, as the desktop app answers', retries: 0 } : null,
        readerPageEveryMs: measureReaders ? 2000 : null, agents, active, windows: 2, terminalStreams: 4, seconds, warmup, historyMiB,
        turnDelayMs: '5000 + a unique round offset', inventoryEveryMs: 60_000, heartbeatEveryMs: 5_000, ackEveryMs: 16 },
      instrumentation: { profile, heaps, delayResolutionMs: 10, rssSampleEveryMs: 1_000, cpuPercentBasis: 'one logical CPU',
        scope: measureWorkers ? 'core PID and both engine worker PIDs (engine-claude, engine-codex) by in-process probe; the master by ps, reported separately; excludes other services, engines and tmux' : 'core PID only; the master by ps, reported separately; excludes services, engines and tmux', heapPausesOutsideWindows: true },
      loadAverage: { start: loadavg() },
      nativeProcessImages: process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
        ? { mode: 'embedded', artifactSha256: sha(process.env.HARNESS_PROCESS_IMAGES_ARTIFACT) } : { mode: 'fallback' },
      limitations: ['Fake engines and a loopback fake backend; no real model latency or token streaming.',
        'Cable access disabled for isolation; not a measurement of USB discovery.', 'Heap snapshots force GC after each measured window.'],
      phases: [], snapshots: [],
    }
    if (profile) copyFileSync(bundle, join(artifactDir, 'profiled-cli.js'))
    let machine: PhoneMachine | undefined
    const windows: PerfWindow[] = []
    let corePid: number | null = null
    try {
      machine = await startPhoneMachine({ env: { NODE_OPTIONS: nodeOptions.join(' '),
        HARNESS_E2E_PERF_READERS: measureWorkers ? '1' : '0', HARNESS_E2E_PERF_DIR: artifactDir, HARNESS_E2E_PERF_TOKEN: token } })
      const d = machine.machine.daemon
      if (measureControls) writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'),
        readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
      corePid = d.corePid()
      if (!corePid) throw new Error('no owned core PID')
      report.corePid = corePid
      report.masterPid = d.pid
      // Which engine controls the master gave this core to its workers (harnessd/services.ts
      // `serviceProcessesEnv`): a build without isolated question control has no QUESTION_CONTROL entry.
      const coreEnvironment = await new Promise<string>(done => execFile('ps', ['-E', '-ww', '-o', 'command=', '-p', String(corePid)], { timeout: 3_000 }, (error, stdout) => done(error ? '' : String(stdout))))
      report.coreEngineCapabilities = Object.fromEntries([...coreEnvironment.matchAll(/\b(HARNESSD_ENGINE_[A-Z_]+)=(\d+:\d+)/g)].map(match => [match[1], match[2] === `${d.pid}:1`]))
      const readyFile = join(artifactDir, `core-${corePid}.json`)
      await until('the owned core performance probe', () => existsSync(readyFile), 10_000)
      const endpoint = JSON.parse(readFileSync(readyFile, 'utf8')) as { pid: number; port: number }
      expect(endpoint.pid).toBe(corePid)
      const probe = async (op: string, label: string, pid = corePid!) => {
        const target = pid === corePid ? endpoint : JSON.parse(readFileSync(join(artifactDir, `core-${pid}.json`), 'utf8'))
        const response = await fetch(`http://127.0.0.1:${target.port}/${op}`, {
          method: 'POST', headers: { 'x-harness-perf-token': token }, body: JSON.stringify({ label }),
          signal: AbortSignal.timeout(op === 'heap' ? 120_000 : 10_000),
        })
        const result = await response.json() as Record<string, any>
        if (!response.ok) throw new Error(`perf ${op}: ${JSON.stringify(result)}`)
        expect(result.pid).toBe(pid)
        return result
      }
      await until('signed in to the fake backend', () => machine!.backend.nodeUp(machine!.machine.machineId), 30_000)
      for (let i = 0; i < 2; i++) {
        const window = new PerfWindow(await LocalClient.connect(d, { machineId: machine.machine.machineId }))
        windows.push(window)
        window.start()
      }
      const client = windows[0].client
      const saved: Array<{ id: string; sessionId: string; engine: string }> = []
      const inventory = async () => (await client.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>
      const checkDesk = async () => {
        const rows = await inventory()
        for (const agent of saved) expect(rows.find(row => row.id === agent.id)).toMatchObject({ sessionId: agent.sessionId, status: 'active' })
        expect(d.corePid()).toBe(corePid)
        expect(d.coresStarted()).toBe(1)
        for (const window of windows) { expect(window.client.closed).toBe(false); expect(window.errors).toEqual([]) }
      }
      const turn = async (id: string, content: string) => {
        const ended = client.next(f => f.type === 'turn_ended' && f.agentId === id, 45_000, 'performance turn ended')
        client.send('message', { agentId: id, content })
        await ended
      }
      const phase = async (label: string, turning: boolean, controlling = false, asking = false) => {
        await checkDesk()
        const before = windows.map(w => w.stats())
        const turns = Array.from({ length: turning ? active : 0 }, () => 0)
        const latencies: number[] = []
        const controlLatencies: Record<string, number[]> = { claude: [], codex: [] }
        let running = true
        let problem: unknown
        const readers = measureWorkers ? [...harnessdProcesses(d)].filter(([name]) => name.startsWith('engine-')) : []
        // On demand: with no agent yet (the empty desk) neither worker has started.
        if (measureWorkers && saved.length) expect(readers.map(([name]) => name).sort()).toEqual(['engine-claude', 'engine-codex'])
        for (const [, pid] of readers) await until('reader performance probe', () => existsSync(join(artifactDir, `core-${pid}.json`)), 10_000)
        const loadStart = loadavg()
        await Promise.all([probe('start', label), ...readers.map(([, pid]) => probe('start', label, pid))])
        const masterEnd = sampleProcess(d.pid!)
        const readLatencies: number[] = []
        const reads = (async () => {
          while (measureReaders && saved.length && running) {
            await Promise.all(saved.map(async agent => {
              const at = performance.now()
              const answer = await client.request('session_get', { sessionId: agent.id, limit: 50 }, 15_000)
              if (answer.error) throw new Error(`history read: ${JSON.stringify(answer)}`)
              readLatencies.push(performance.now() - at)
            }))
            await sleep(2000)
          }
        })().catch(error => { problem ??= error })
        const workers = turns.map(async (_, i) => {
          while (running) {
            const began = performance.now()
            try { await turn(saved[i].id, `!slow ${5000 + i + turns[i] * 17}`) }
            catch (error) { problem ??= error; return }
            if (running) { turns[i]++; latencies.push(performance.now() - began) }
          }
        })
        // Questions: each asking agent asks, the window answers it, and the turn ends, again and again. An agent
        // whose answer did not go in still has its dialog up, so it stops asking; its errors are reported.
        const answers: Array<QuestionOutcome & { agentId: string; completedAt: number }> = []
        let windowEndedAt = Infinity
        const askers = (asking ? saved.slice(0, questionAgents) : []).map(async (agent, index) => {
          const kinds = QUESTION_KINDS[agent.engine as QuestionEngine]
          for (let n = 0; running; n++) {
            const outcome = await askAndAnswer(client, { id: agent.id, engine: agent.engine as QuestionEngine }, kinds[n % kinds.length], n, { token: `q${index}-${n}` })
            answers.push({ ...outcome, agentId: agent.id, completedAt: performance.now() })
            if (!outcome.ok) return
          }
        })
        const controls = (controlling ? saved.slice(0, active) : []).map(async agent => {
          let changes = 0
          while (running) {
            const model = agent.engine === 'claude' ? (changes % 2 ? 'opus' : 'sonnet') : (changes % 2 ? 'gpt-5.5' : 'gpt-6-luna')
            const selectedModel = `runtime-v1:${agent.id}:${agent.engine}:${model}@high`
            const began = performance.now()
            try {
              const answer = await client.request('agent_update', { agentId: agent.id, selectedModel }, 45_000)
              if (answer.error || answer.agent?.selectedModel !== selectedModel) throw new Error(`model control: ${JSON.stringify(answer)}`)
              if (running) controlLatencies[agent.engine].push(performance.now() - began)
              changes++
            } catch (error) { problem ??= error; return }
            await sleep(250)
          }
        })
        let readerMetrics: Record<string, any>[] = []
        let metrics: Record<string, any>
        let master: Record<string, any> | null = null
        try { await sleep((asking ? questionSeconds : seconds) * 1000) }
        finally {
          running = false
          windowEndedAt = performance.now()
          const measured = await Promise.all([probe('end', label), ...readers.map(async ([name, pid]) => ({ name, ...await probe('end', label, pid) }))])
          metrics = measured[0]; readerMetrics = measured.slice(1)
          master = await masterEnd()
        }
        const loadEnd = loadavg()
        const after = windows.map(w => w.stats())
        await Promise.all([...workers, ...controls, ...askers, reads])
        if (problem) throw problem
        expect(metrics!.cpu.percent).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(metrics!.cpu.percent)).toBe(true)
        expect(metrics!.memory.rssMax).toBeGreaterThan(0)
        expect(metrics!.eventLoop.delaySamples).toBeGreaterThan(0)
        if (turning) for (const count of turns) expect(count).toBeGreaterThan(0)
        if (controlling) for (const agent of saved.slice(0, active)) expect(controlLatencies[agent.engine].length).toBeGreaterThan(0)
        latencies.sort((a, b) => a - b)
        readLatencies.sort((a, b) => a - b)
        let questions: Record<string, unknown> | null = null
        if (asking) {
          // What each engine took, from its transcript, against what was answered: none lost, none twice.
          const ledger = saved.slice(0, questionAgents).map(agent => {
            const mine = answers.filter(answer => answer.agentId === agent.id)
            const seen = engineAnswers(d.root, agent.engine as QuestionEngine, agent.sessionId)
            return { agentId: agent.id, engine: agent.engine, asked: mine.length, answered: mine.filter(answer => answer.ok).length,
              ...compareAnswers(mine.filter(answer => answer.ok).map(answer => answer.expected!), seen) }
          })
          const inWindow = answers.filter(answer => answer.completedAt <= windowEndedAt)
          questions = { summary: summarizeAnswers(answers), inWindow: { count: inWindow.length, summary: summarizeAnswers(inWindow) }, ledger,
            errors: answers.flatMap(answer => answer.errors.map(error => `${answer.engine} ${answer.kind} ${answer.token}: ${error}`)),
            samples: answers.map(({ sentAt, completedAt, ...answer }) => ({ ...answer, inWindow: completedAt <= windowEndedAt })) }
        }
        report.phases.push({ ...metrics!, readers: readerMetrics, master, loadAverage: { start: loadStart, end: loadEnd }, questions,
          modelControls: Object.fromEntries(Object.entries(controlLatencies).map(([engine, values]) => {
            values.sort((a, b) => a - b)
            return [engine, { count: values.length, p50Ms: values[Math.floor(values.length * .5)] ?? null, p95Ms: values[Math.floor(values.length * .95)] ?? null }]
          })),
          historyReads: { count: readLatencies.length, p50Ms: readLatencies[Math.floor(readLatencies.length * .5)] ?? null, p95Ms: readLatencies[Math.floor(readLatencies.length * .95)] ?? null },
          coreAndReaders: { cpuPercent: metrics!.cpu.percent + readerMetrics.reduce((sum, m) => sum + m.cpu.percent, 0), rssMean: metrics!.memory.rssMean + readerMetrics.reduce((sum, m) => sum + m.memory.rssMean, 0) }, turns, completedTurns: turns.reduce((a, b) => a + b, 0),
          turnLatencyMs: { p50: latencies[Math.floor(latencies.length * .5)] ?? null, p95: latencies[Math.floor(latencies.length * .95)] ?? null },
          windows: after.map((stats, i) => Object.fromEntries(Object.entries(stats).map(([key, value]) =>
            [key, value - before[i][key as keyof ReturnType<PerfWindow['stats']>]]))) })
        await checkDesk()
        if (heaps) report.snapshots.push({ label, ...await probe('heap', label) })
        writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
      }
      await sleep(warmup * 1000)
      await phase('empty', false)
      for (let i = 0; i < agents; i++) {
        const cwd = join(d.projectsDir, `perf-${i}`)
        mkdirSync(cwd, { recursive: true })
        const engine = i % 2 ? 'codex' : 'claude'
        const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
        expect(created.error, JSON.stringify(created)).toBeUndefined()
        const agent = await until(`performance agent ${i} to bind`, async () => {
          const row = (await inventory()).find(row => row.id === created.agent.id)
          return row?.sessionId && row.status === 'active' ? row : null
        }, 60_000, 250)
        saved.push({ id: agent.id, sessionId: agent.sessionId, engine })
      }
      for (const window of windows) window.stop()
      for (let i = 0; i < 4; i++) await windows[i % 2].open(saved[i].id)
      for (const window of windows) window.start()
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < saved.length; i += 4) await Promise.all(saved.slice(i, i + 4).map(agent => turn(agent.id, `warm ${round}`)))
      }
      if (historyMiB) for (let i = 0; i < saved.length; i += 4) {
        await Promise.all(saved.slice(i, i + 4).map(agent => turn(agent.id, `!grow ${historyMiB}`)))
      }
      report.transcriptBytes = transcriptBytes(join(d.root, 'claude/projects')) + transcriptBytes(join(d.root, 'codex/sessions'))
      if (measureReaders) {
        report.firstHistoryReads = []
        for (const agent of saved) {
          const at = performance.now()
          const answer = await client.request('session_get', { sessionId: agent.id, limit: 50 }, 15_000)
          expect(answer.error, JSON.stringify(answer)).toBeUndefined()
          report.firstHistoryReads.push({ engine: agent.engine, ms: performance.now() - at })
        }
      }
      await sleep(warmup * 1000)
      await phase('populated-idle', false)
      await phase('active', true)
      if (measureControls) await phase('model-control', false, true)
      if (measureQuestions) await phase('questions', false, false, true)
      report.agents = saved
      report.state = 'passed'
    } catch (error) {
      report.state = 'failed'; report.error = String(error)
      if (machine) console.log(`---- daemon log\n${machine.machine.daemon.log().split('\n').slice(-120).join('\n')}`)
      throw error
    } finally {
      for (const window of windows) { window.stop(); window.client.close() }
      if (machine) {
        writeFileSync(join(artifactDir, 'daemon.log'), machine.machine.daemon.log())
        await machine.close()
      }
      report.endedAt = new Date().toISOString()
      report.loadAverage.end = loadavg()
      report.cpuProfiles = readdirSync(artifactDir).filter(name => name.endsWith('.cpuprofile') && name.includes(`.${corePid}.`))
        .map(name => ({ name, sha256: sha(join(artifactDir, name)), bytes: statSync(join(artifactDir, name)).size }))
      const missingProfile = profile && report.state === 'passed' && report.cpuProfiles.length === 0
      if (missingProfile) { report.state = 'failed'; report.error = 'the owned core did not write its CPU profile' }
      writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
      console.log(`PERF report: ${reportFile}\n${JSON.stringify({ state: report.state, phases: report.phases, cpuProfiles: report.cpuProfiles })}`)
      if (missingProfile) throw new Error(report.error)
    }
  }, 3_600_000)
})
