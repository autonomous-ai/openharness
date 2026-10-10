/**
 * The daemon over time, every service in its own process: what no single end-to-end test shows (opt-in:
 * `SOAK=1`; about 90 minutes at its defaults).
 *
 * - **Soak** (`SOAK_MINUTES`, 60): Claude Code and Codex agents (`SOAK_AGENTS`, 6) take turns without a
 *   break, with interrupts, questions, tool calls and floods of terminal output among them; windows come
 *   and go, open an agent's terminal and close it; search, the Devices tab, the edge host's readers, the
 *   models and the Store are asked as the apps ask them; a fake dial is plugged in and out. Every harnessd
 *   process (master, core, each service's) is sampled every `SOAK_SAMPLE_MS` (30 s): resident memory,
 *   footprint and open files. Growth rates are measurements by default. Set `SOAK_MAX_MIB_PER_HOUR`
 *   and `SOAK_MAX_FDS_PER_HOUR` only against an established baseline for the same workload.
 * - **Chaos** (`CHAOS_MINUTES`, 30), while the agents go on: a service process (search, viewers, the edge
 *   host, the gateway, models, the devices, and the experiments once woken) is killed, two at once, frozen
 *   until the master finds it hung, or killed again as it starts. Every time: the core never restarts; a
 *   request to the service is answered at once (`SERVICE_UNAVAILABLE` or its answer), never left hanging;
 *   the service comes back and serves again. At the end every turn sent was started once, in the order
 *   sent, and no tmux client or process of the daemon outlives it.
 *
 * Questions are answered as the app answers them (e2e/harness/questionWork.ts): Claude Code a choice, a
 * multiSelect through its review, a typed answer and a permission, Codex a choice and a permission. Each
 * answer's result is awaited; a refused one is retried as a new intent, and every refusal is reported (a
 * finding in the soak; in chaos, where an engine worker can be killed mid-answer, only an answer that never
 * goes in is). At the end each engine's transcript must hold every answer that went in, once, in order.
 *
 * `SOAK_OUT=<folder>` keeps the samples (CSV) and the report (JSON). `SOAK_SEED` picks the run.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { alive, everyPid, forget, harnessdProcesses, slopes, startSampler, strays, tmuxClients, TurnLedger, type Sample } from './harness/endurance.js'
import { askAndAnswer, compareAnswers, engineAnswers, QUESTION_KINDS, summarizeAnswers, type QuestionEngine, type QuestionOutcome } from './harness/questionWork.js'

const ON = process.env.SOAK === '1'
function knob(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}
const SOAK_MINUTES = knob('SOAK_MINUTES', 60, 0.1, 240)
const CHAOS_MINUTES = knob('CHAOS_MINUTES', 30, 0.1, 240)
const AGENTS = Math.floor(knob('SOAK_AGENTS', 6, 2, 24))
const SAMPLE_MS = knob('SOAK_SAMPLE_MS', 30_000, 1000, 120_000)
// Growth limits require a baseline for the same workload. Otherwise report measurements only.
const MAX_MIB_PER_HOUR = process.env.SOAK_MAX_MIB_PER_HOUR === undefined ? null : knob('SOAK_MAX_MIB_PER_HOUR', 20, 0, 10000)
const MAX_FDS_PER_HOUR = process.env.SOAK_MAX_FDS_PER_HOUR === undefined ? null : knob('SOAK_MAX_FDS_PER_HOUR', 30, 0, 10000)
const SEED = knob('SOAK_SEED', 20261007, 0, 0xffffffff)
const OUT = process.env.SOAK_OUT ?? (ON ? mkdtempSync(join(tmpdir(), 'harness-soak-')) : '')
/** How long a request to a service that is down may take to be answered: at once, not after its wait. */
const FAST_MS = 5_000
const PROTOCOL = 3
const MARK = /soak-[a-z0-9]+-\d+/

/** mulberry32: small, seeded, and the same sequence on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function pause(ms: number, deadline: () => boolean): Promise<void> {
  const end = Date.now() + ms
  while (!deadline() && Date.now() < end) await sleep(Math.min(1000, end - Date.now()))
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/** A request each service's process answers, as the apps ask it: answered by the service when it is up. */
const PROBES: Record<string, { type: string; payload: Record<string, unknown> }> = {
  'engine-claude': { type: 'session_get', payload: { limit: 10 } },
  'engine-codex': { type: 'session_get', payload: { limit: 10 } },
  gateway: { type: 'e2ee_pairings_list', payload: {} },
  sharing: { type: 'harness_share_list', payload: {} },
  search: { type: 'session_search', payload: { query: 'soak' } },
  viewers: { type: 'dsh_list', payload: {} },
  edge: { type: 'machine_resources', payload: {} },
  models: { type: 'models_list', payload: {} },
  devices: { type: 'harness_devices_list', payload: {} },
  orchestrator: { type: 'orchestrator', payload: { action: 'list' } },
  teams: { type: 'team', payload: { action: 'capabilities' } },
}
/** The service names a process's comings and goings are logged under (`[services] <name> connected`). */
const LINKS: Record<string, string> = { 'engine-claude': 'engine-claude', 'engine-codex': 'engine-codex', search: 'search', viewers: 'viewers', edge: 'monitor', gateway: 'gateway', models: 'models', devices: 'devices', orchestrator: 'orchestrator', teams: 'teams', sharing: 'sharing' }
const down = (answer: Record<string, unknown>) => answer.error === 'SERVICE_UNAVAILABLE' || answer.error === 'SERVICE_FAILED' || answer.error === 'GATEWAY_UNAVAILABLE' || answer.error === 'ENGINE_UNAVAILABLE' || answer.error === 'ENGINE_STALE_REPLY' || answer.error === 'ENGINE_BUSY'

const acceptable = (name: string, answer: Record<string, unknown>): boolean => answer.error === undefined
  || (name === 'sharing' && answer.error === 'HARNESS_NOT_FOUND')
async function wakeServices(client: LocalClient): Promise<void> {
  const agents = (await client.request('agents_list', {})).agents as Array<Record<string, unknown>>
  for (const engine of ['claude', 'codex']) {
    const agent = agents.find(agent => agent.engine === engine && agent.sessionId)
    if (!agent) throw new Error(`no ${engine} conversation for the reader probe`)
    PROBES[`engine-${engine}`].payload.sessionId = agent.id
  }
  for (const [name, probe] of Object.entries(PROBES)) {
    await until(`${name} to answer its probe`, async () => {
      const answer = await client.request(probe.type, probe.payload, 30_000)
      if (down(answer)) return null
      if (!acceptable(name, answer)) throw new Error(`${name}: ${JSON.stringify(answer)}`)
      return true
    }, 60_000, 200)
  }
}

interface Findings { lines: string[] }
/** Every question asked in a run, and whether a refused answer is a finding (the soak) or expected (chaos). */
interface Questions { outcomes: Array<QuestionOutcome & { agentId: string; at: string }>; refusalsAreFindings: boolean }

/** What the questions came to: answered, refused, never answered, and each engine's own record of them. */
async function questionReport(d: IsolatedDaemon, client: LocalClient, questions: Questions, engines: Map<string, QuestionEngine>) {
  const rows = (await client.request('agents_list', {}, 30_000)).agents as Array<Record<string, any>>
  const ledger = [...engines].map(([agentId, engine]) => {
    const mine = questions.outcomes.filter(outcome => outcome.agentId === agentId)
    const sessionId = String(rows.find(row => row.id === agentId)?.sessionId ?? '')
    return { agentId, engine, asked: mine.length, answered: mine.filter(outcome => outcome.ok).length,
      ...compareAnswers(mine.filter(outcome => outcome.ok).map(outcome => outcome.expected!), sessionId ? engineAnswers(d.root, engine, sessionId) : []) }
  })
  const outcomes = questions.outcomes
  return {
    asked: outcomes.length, answered: outcomes.filter(outcome => outcome.ok).length,
    refusedThenAnswered: outcomes.filter(outcome => outcome.ok && outcome.errors.length).length,
    neverAnswered: outcomes.filter(outcome => !outcome.ok).length,
    refusals: outcomes.filter(outcome => outcome.errors.length).map(({ at, agentId, kind, token, attempts, errors, ok }) => ({ at, agentId, kind, token, attempts, errors, ok })),
    lost: ledger.reduce((sum, row) => sum + row.lost, 0), duplicated: ledger.reduce((sum, row) => sum + row.duplicated, 0),
    ledger, latency: summarizeAnswers(outcomes),
  }
}

/** An agent's pane as it is now, kept beside the report (`SOAK_OUT`) once per agent and token. */
async function keepPane(d: IsolatedDaemon, agentId: string, name: string): Promise<void> {
  let client: LocalClient | undefined
  try {
    client = await LocalClient.connect(d)
    const row = ((await client.request('agents_list', {}, 15_000)).agents as Array<Record<string, any>>).find((agent) => agent.id === agentId)
    if (row?.tmuxPane) {
      writeFileSync(join(OUT, `pane-${name}.txt`), await d.capture(String(row.tmuxPane)))
      // Input and question readers include scrollback. Keeping only the visible pane hid the old
      // dialog they still read after its answer, while the screen already showed the next composer.
      const capture = await d.tmux.run('capture-pane', '-p', '-e', '-J', '-S', '-100', '-t', String(row.tmuxPane))
      writeFileSync(join(OUT, `pane-${name}-history.txt`), capture)
    }
  } catch { /* a pane that cannot be read: the finding stands without it */ }
  finally { client?.close() }
}

/** One agent's turns, one after another until `until`: plain, a tool call, a question answered, an
 *  interrupt, a flood of output; each carries a token the ledger checks. */
async function agentLoop(d: IsolatedDaemon, agentId: string, engine: QuestionEngine, tag: string, ledger: TurnLedger, deadline: () => boolean, rand: () => number, findings: Findings, questions: Questions): Promise<number> {
  const client = await LocalClient.connect(d)
  let n = 0
  let asked = 0
  try {
    while (!deadline()) {
      const token = `soak-${tag}-${n++}`
      const pick = rand()
      const kind = pick < 0.5 ? 'plain' : pick < 0.65 ? 'tool' : pick < 0.78 ? 'ask' : pick < 0.93 ? 'interrupt' : 'flood'
      if (kind === 'ask') {
        // Asked, answered through question_response, its result awaited and a refusal retried as a new intent.
        const kinds = QUESTION_KINDS[engine]
        ledger.send(agentId, token)
        const outcome = await askAndAnswer(client, { id: agentId, engine }, kinds[asked % kinds.length], asked, { token, askMs: 60_000, endMs: 120_000, retries: 20 })
        asked++
        questions.outcomes.push({ ...outcome, agentId, at: new Date().toISOString() })
        if (!outcome.ok || (outcome.errors.length && questions.refusalsAreFindings)) {
          findings.lines.push(`${new Date().toISOString()} ${tag} ask ${outcome.kind} ${token}: ${outcome.errors.join('; ')}`)
          await keepPane(d, agentId, `${tag}-${token}`)
        }
        // Never answered, its dialog is still up: this agent asks nothing more.
        if (!outcome.ok) return n
        forget(client)
        await sleep(rand() * 1_500)
        continue
      }
      const content = kind === 'plain' ? `${token} hello` : kind === 'tool' ? `!tool echo ${token}`
        : kind === 'interrupt' ? `!holdtool sleep-${token}` : `!flood ${token}`
      const ended = kind === 'interrupt' ? null : client.next(isTurn('turn_ended', agentId), 120_000, `turn_ended (${token})`)
      ledger.send(agentId, token)
      client.send('message', { agentId, content })
      try {
        if (kind === 'interrupt') {
          await client.next((frame) => frame.type === 'turn_started' && frame.agentId === agentId, 60_000, `turn_started (${token})`)
          await sleep(800 + rand() * 1_500)
          // Told, not asked; and a turn interrupted ends with no turn_ended (core/turns/cancel.ts): every window
          // reads the agent as idle.
          const idle = client.next((frame) => frame.type === 'agent_activity' && frame.agentId === agentId && frame.payload?.activity?.state === 'idle', 60_000, `idle after its interrupt (${token})`)
          client.send('cancel', { agentId })
          await idle
          // The engine's own end of the interrupted turn, written as the pane takes the interrupt.
          await sleep(1_000)
        }
        await ended
      } catch (error) {
        findings.lines.push(`${new Date().toISOString()} ${tag} ${kind} ${token}: ${error instanceof Error ? error.message : String(error)}`)
        // What the agent's pane showed then: what the daemon read, to tell its mistake from the engine's.
        await keepPane(d, agentId, `${tag}-${token}`)
        await ended?.catch(() => {})
      }
      forget(client)
      await sleep(rand() * 1_500)
    }
  } finally { client.close() }
  return n
}

/** Windows coming and going: each says its tabs and focus, opens an agent's terminal, keeps it a while,
 *  and closes it or simply goes; and the apps' requests to the services, now and then. */
async function deskLoop(d: IsolatedDaemon, agentIds: string[], deadline: () => boolean, rand: () => number, findings: Findings): Promise<number> {
  let windows = 0
  const ask = async (client: LocalClient, service: string): Promise<void> => {
    const probe = PROBES[service]
    const answer = await client.request(probe.type, probe.payload, 60_000).catch((error) => ({ error: String(error) }))
    if (!acceptable(service, answer) && !down(answer)) findings.lines.push(`${new Date().toISOString()} desk ${probe.type}: ${JSON.stringify(answer).slice(0, 200)}`)
  }
  while (!deadline()) {
    windows++
    const window = await LocalClient.connect(d)
    try {
      const shown = agentIds.filter(() => rand() < 0.6)
      window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: shown, panes: shown.length }], tiles: [] })
      window.send('app_panes', { agentIds: shown, foreground: rand() < 0.8 })
      const agentId = agentIds[Math.floor(rand() * agentIds.length)]
      window.send('app_focus', { agentId })
      const requestId = `open-${windows}`
      const opened = window.next((frame) => (frame.type === 'terminal_ready' || frame.type === 'terminal_error') && frame.payload?.requestId === requestId, 30_000, 'terminal_ready')
      window.send('terminal_open', { requestId, protocolVersion: PROTOCOL, agentId, cols: 100, rows: 30, takeover: false })
      const ready = await opened.catch((error) => ({ type: 'timeout', payload: { error: String(error) } }) as Frame)
      if (ready.type !== 'terminal_ready') findings.lines.push(`${new Date().toISOString()} desk terminal_open: ${JSON.stringify(ready.payload).slice(0, 200)}`)
      const streamId = ready.payload?.streamId as string | undefined
      const holdFor = 3_000 + rand() * 12_000
      const until = Date.now() + holdFor
      while (Date.now() < until && !deadline()) {
        if (streamId) {
          window.send('terminal_alive', { streamId })
          const drawn = window.binaries.filter((frame) => frame.streamId === streamId)
          if (drawn.length) window.send('terminal_ack', { streamId, lastSeq: drawn[drawn.length - 1].seq })
        }
        const service = Object.keys(PROBES)[Math.floor(rand() * Object.keys(PROBES).length)]
        if (rand() < 0.4 && !['orchestrator', 'teams'].includes(service)) await ask(window, service)
        forget(window)
        await sleep(2_000)
      }
      if (streamId && rand() < 0.7) window.send('terminal_close', { streamId })
    } finally {
      window.close()
    }
    await sleep(rand() * 3_000)
  }
  return windows
}

/** A dial plugged in and taken out now and then. */
async function dialLoop(desk: Desk, deadline: () => boolean, rand: () => number): Promise<number> {
  let plugs = 0
  while (!deadline()) {
    await pause(60_000 + rand() * 120_000, deadline)
    if (deadline()) break
    plugs++
    await desk.plug('SOAK-DIAL', 'e2:e0:00:00:00:5a')
    await pause(20_000 + rand() * 40_000, deadline)
    await desk.unplug('SOAK-DIAL')
  }
  return plugs
}

const engineOf = (index: number): QuestionEngine => index % 2 ? 'codex' : 'claude'

async function createAgents(d: IsolatedDaemon, count: number): Promise<string[]> {
  const client = await LocalClient.connect(d)
  const ids: string[] = []
  try {
    for (let i = 0; i < count; i++) {
      const cwd = join(d.projectsDir, `soak-${i}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine: engineOf(i), cwd, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      ids.push(created.agent.id)
    }
    for (const id of ids) {
      await until(`${id.slice(0, 8)} to bind`, async () => ((await client.request('agents_list', {})).agents as Array<Record<string, unknown>>)
        .find((agent) => agent.id === id)?.sessionId || null, 90_000, 500)
    }
  } finally { client.close() }
  return ids
}

describe.skipIf(!ON)('the daemon over time, every service in its own process', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    const ended = await Promise.allSettled(cleanup.splice(0).reverse().map(stop => Promise.resolve().then(stop)))
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
    for (const result of ended) if (result.status === 'rejected') throw result.reason
  })

  const fresh = async (env: Record<string, string> = {}): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
    daemon = d
    const file = join(d.root, 'dials.json')
    writeFileSync(file, '[]')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    desk = new Desk(file)
    onTestFailed(() => {
      writeFileSync(join(OUT, `daemon-${d.port}.log`), d.log())
      console.log(`---- daemon log (whole log in ${OUT})\n${d.log().split('\n').slice(-120).join('\n')}`)
    })
    await d.start()
    return { d, desk: desk! }
  }

  it(`soak: ${AGENTS} agents for ${SOAK_MINUTES} min; measure every process; preserve every turn`, async () => {
    mkdirSync(OUT, { recursive: true })
    const { d, desk } = await fresh()
    const agentIds = await createAgents(d, AGENTS)
    const observer = await LocalClient.connect(d)
    cleanup.push(() => observer.close())
    const ledger = new TurnLedger(observer, MARK)
    const reading = setInterval(() => ledger.drain(), 1_000)
    cleanup.push(() => clearInterval(reading))
    await wakeServices(observer)
    const samples: Sample[] = []
    const stopSampling = startSampler(d, SAMPLE_MS, join(OUT, 'soak-samples.csv'), samples)
    cleanup.push(stopSampling)
    const findings: Findings = { lines: [] }
    const questions: Questions = { outcomes: [], refusalsAreFindings: true }
    const ends = Date.now() + SOAK_MINUTES * 60_000
    let stopping = false
    cleanup.push(() => { stopping = true })
    const deadline = () => stopping || Date.now() >= ends
    const [turns, windows, plugs] = await Promise.all([
      Promise.all(agentIds.map((id, i) => agentLoop(d, id, engineOf(i), `a${i}`, ledger, deadline, random(SEED + i + 1), findings, questions))),
      deskLoop(d, agentIds, deadline, random(SEED + 100), findings),
      dialLoop(desk, deadline, random(SEED + 200)),
    ])
    await stopSampling()
    clearInterval(reading)
    await sleep(3_000)
    const differences = ledger.differences()
    const asked = await questionReport(d, observer, questions, new Map(agentIds.map((id, i) => [id, engineOf(i)])))
    observer.close()
    const warmup = Math.min(10 * 60_000, (SOAK_MINUTES * 60_000) / 4)
    const growth = slopes(samples, warmup, Math.max(SAMPLE_MS * 4, 2 * 60_000))
    const report = { minutes: SOAK_MINUTES, agents: AGENTS, turns: turns.reduce((sum, n) => sum + n, 0), windows, plugs, ledger: ledger.totals(), differences, questions: asked, findings: findings.lines, slopes: growth, coresStarted: d.coresStarted() }
    writeFileSync(join(OUT, 'soak-report.json'), JSON.stringify(report, null, 2))
    console.log(`soak report: ${join(OUT, 'soak-report.json')}\n${growth.map((s) => `${s.name}: ${s.first.toFixed(0)} → ${s.last.toFixed(0)} MiB, ${s.perHour?.toFixed(1) ?? 'unmeasured'} MiB/h; fds ${s.fdsFirst} → ${s.fdsLast}, ${s.fdsPerHour?.toFixed(1)}/h; restarts ${s.restarts}`).join('\n')}`)
    expect(d.coresStarted()).toBe(1)
    expect(differences).toEqual([])
    expect(findings.lines).toEqual([])
    expect(asked.answered, 'no question answered').toBeGreaterThan(0)
    expect(asked.ledger.filter(row => !row.equal)).toEqual([])
    expect(growth.map(p => p.name).sort()).toEqual(['master', 'core', ...Object.keys(PROBES)].sort())
    for (const process of growth) {
      expect(process.samples, `${process.name} sample count`).toBeGreaterThanOrEqual(2)
      expect(process.restarts, `${process.name} restarted`).toBe(0)
      if (MAX_MIB_PER_HOUR !== null) {
        expect(process.perHour, `${process.name}: insufficient windows for a growth limit`).not.toBeNull()
        expect(process.perHour).toBeLessThan(MAX_MIB_PER_HOUR)
      }
      if (MAX_FDS_PER_HOUR !== null) {
        expect(process.fdsPerHour, `${process.name}: insufficient descriptor measurements`).not.toBeNull()
        expect(process.fdsPerHour).toBeLessThan(MAX_FDS_PER_HOUR)
      }
    }
  }, (SOAK_MINUTES + 15) * 60_000)

  it(`chaos: services killed, frozen and killed as they start, for ${CHAOS_MINUTES} min, while ${AGENTS} agents work`, async () => {
    mkdirSync(OUT, { recursive: true })
    const { d, desk } = await fresh({
      // Frozen, a service is found hung in seconds; killed, it is back in under two; and it is never parked:
      // the run kills each one far more often than a crash loop would.
      HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '2000',
      HARNESSD_SERVICE_PARK_CRASHES: '100000',
    })
    const rand = random(SEED + 1_000)
    const agentIds = await createAgents(d, AGENTS)
    const observer = await LocalClient.connect(d)
    cleanup.push(() => observer.close())
    const ledger = new TurnLedger(observer, MARK)
    const reading = setInterval(() => ledger.drain(), 1_000)
    cleanup.push(() => clearInterval(reading))
    const findings: Findings = { lines: [] }
    // A killed engine worker fails the answer it was entering (it never resumes in a replacement), so a
    // refusal here is expected; an answer that never goes in, or goes in twice, is not.
    const questions: Questions = { outcomes: [], refusalsAreFindings: false }
    // The experiments and the devices, woken as the apps wake them, so their processes are in the run too.
    const waker = await LocalClient.connect(d)
    await desk.plug('CHAOS-DIAL', 'e2:e0:00:00:00:5b')
    cleanup.push(() => waker.close())
    await wakeServices(waker)
    const samples: Sample[] = []
    const stopSampling = startSampler(d, SAMPLE_MS, join(OUT, 'chaos-samples.csv'), samples)
    cleanup.push(stopSampling)
    const ends = Date.now() + CHAOS_MINUTES * 60_000
    let stopping = false
    cleanup.push(() => { stopping = true })
    const deadline = () => stopping || Date.now() >= ends
    const events: Array<Record<string, unknown>> = []
    const starts = (name: string) => [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${name} started \\(pid (\\d+)\\)`, 'g'))].map((match) => Number(match[1]))
    const linked = (name: string) => d.log().split(`[services] ${LINKS[name]} connected`).length - 1

    /** Asked while it is down: answered at once. Frozen: answered by the time the master has found it hung
     *  and killed it, never left waiting. Back: answered by it again. */
    const probe = async (name: string, phase: 'down' | 'frozen' | 'back'): Promise<void> => {
      const spec = PROBES[name]
      if (!spec) return
      const asked = Date.now()
      const answer = await waker.request(spec.type, spec.payload, 60_000).catch((error) => ({ error: `no answer: ${String(error)}` }))
      const ms = Date.now() - asked
      if (phase === 'down' && ms > FAST_MS) findings.lines.push(`${name} down: ${spec.type} answered after ${ms} ms: ${JSON.stringify(answer).slice(0, 160)}`)
      if (!acceptable(name, answer) && (phase === 'back' || !down(answer))) findings.lines.push(`${name} ${phase}: ${spec.type}: ${JSON.stringify(answer).slice(0, 160)}`)
      events[events.length - 1][`${phase}Ms`] = ms
    }
    /** The master started it again and it connected to the core. */
    const comesBack = async (name: string, startsBefore: number, linksBefore: number): Promise<boolean> => {
      try {
        await until(`${name} to be started again`, () => starts(name).length > startsBefore || null, 60_000, 100)
        await until(`${name} to connect again`, () => linked(name) > linksBefore || null, 60_000, 100)
        return true
      } catch (error) {
        findings.lines.push(`${name} never came back: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    const actions = ['kill', 'kill two', 'freeze', 'kill as it starts'] as const
    const chaos = (async () => {
      let cycle = 0
      while (!deadline()) {
        await pause(5000 + rand() * 5000, deadline)
        if (deadline()) break
        const running = [...harnessdProcesses(d)].filter(([name, pid]) => name !== 'master' && name !== 'core' && alive(pid))
        if (!running.length) continue
        const names = Object.keys(PROBES)
        const name = names[cycle % names.length]
        const action = actions[Math.floor(cycle / names.length) % actions.length]
        cycle++
        const primary = running.find(([role]) => role === name)
        if (!primary) { findings.lines.push(`${name} was not running for ${action}`); continue }
        const second = running.find(([role]) => role !== name)
        const targets = action === 'kill two' && second ? [primary, second] : [primary]
        const before = targets.map(([name]) => ({ name, starts: starts(name).length, links: linked(name) }))
        const hung = (): number => d.log().split(`[harnessd] service ${targets[0][0]} sent no heartbeat`).length
        const hungBefore = hung()
        events.push({ at: new Date().toISOString(), action, targets: targets.map(([name]) => name) })
        for (const [, pid] of targets) process.kill(pid, action === 'freeze' ? 'SIGSTOP' : 'SIGKILL')
        if (action === 'kill as it starts') {
          const [{ name, starts: count }] = before
          await until(`${name} to be started`, () => starts(name).length > count || null, 30_000, 20).catch(error => { findings.lines.push(String(error)) })
          const next = starts(name)[count]
          if (next && alive(next)) process.kill(next, 'SIGKILL')
          before[0].starts = count + 1
        }
        if (action === 'freeze') {
          const frozen = probe(targets[0][0], 'frozen')
          await until(`${targets[0][0]} to be found hung`, () => hung() > hungBefore || null, 30_000, 100).catch(error => { findings.lines.push(String(error)) })
          await frozen
        } else await probe(targets[0][0], 'down')
        for (const { name, starts: count, links } of before) {
          if (await comesBack(name, count, links)) await probe(name, 'back')
        }
        if (d.coresStarted() !== 1) findings.lines.push(`the core restarted after ${action} ${targets.map(([name]) => name).join(', ')}`)
      }
    })()
    const [turns] = await Promise.all([
      Promise.all(agentIds.map((id, i) => agentLoop(d, id, engineOf(i), `c${i}`, ledger, deadline, random(SEED + 2_000 + i), findings, questions))),
      deskLoop(d, agentIds, deadline, random(SEED + 3_000), findings),
      chaos,
    ])
    await stopSampling()
    clearInterval(reading)
    await sleep(3_000)
    const differences = ledger.differences()
    const asked = await questionReport(d, observer, questions, new Map(agentIds.map((id, i) => [id, engineOf(i)])))
    observer.close()
    waker.close()
    await desk.unplug('CHAOS-DIAL')
    // Every window has gone: no terminal stream, so no tmux client, is left behind.
    const clients = await until('every tmux client to be let go', async () => ((await tmuxClients(d)) === 0 ? true : null), 30_000, 500).catch(async () => `still ${await tmuxClients(d)}`)
    const pids = everyPid(d)
    const growth = slopes(samples, 0, Math.max(SAMPLE_MS * 4, 2 * 60_000))
    const report = { minutes: CHAOS_MINUTES, agents: AGENTS, turns: turns.reduce((sum, n) => sum + n, 0), events, ledger: ledger.totals(), differences, questions: asked, findings: findings.lines, slopes: growth, coresStarted: d.coresStarted(), tmuxClients: clients }
    writeFileSync(join(OUT, 'chaos-report.json'), JSON.stringify(report, null, 2))
    console.log(`chaos report: ${join(OUT, 'chaos-report.json')}: ${events.length} events, ${report.turns} turns`)
    expect(d.coresStarted()).toBe(1)
    expect(differences).toEqual([])
    expect(findings.lines).toEqual([])
    expect(events.length, 'no chaos event exercised').toBeGreaterThan(0)
    expect(asked.answered, 'no question answered').toBeGreaterThan(0)
    expect(asked.ledger.filter(row => !row.equal)).toEqual([])
    if (CHAOS_MINUTES >= 15) {
      expect(new Set(events.map(event => event.action))).toEqual(new Set(actions))
      expect(new Set(events.flatMap(event => event.targets as string[]))).toEqual(new Set(Object.keys(PROBES)))
      expect(new Set(events.flatMap(event => (event.targets as string[]).map(name => `${event.action}:${name}`))))
        .toEqual(new Set(actions.flatMap(action => Object.keys(PROBES).map(name => `${action}:${name}`))))
    }
    expect(clients).toBe(true)
    // Nothing of the daemon's outlives it: every process its master started, its engines and its servers.
    await daemon!.close()
    daemon = undefined
    await until('every process of the daemon to be gone', () => pids.every((pid) => !alive(pid)) || null, 30_000, 250)
    expect(await strays(d)).toEqual([])
  }, (CHAOS_MINUTES + 15) * 60_000)
})
