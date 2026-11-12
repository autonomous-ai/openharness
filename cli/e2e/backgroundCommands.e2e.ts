/**
 * The background commands an idle harness still runs (docs/plans/2026-11-12-background-count-design.md), on the real
 * daemon: the fake Claude Code starts one as its Bash tool's `run_in_background` does (harness/fakeEngine.mjs
 * `!background`), a shell that is the engine's own child and runs until the test creates its release file. `show`,
 * `wait`, `watch` and `close` read it as not done; the cleanup leaves it open, and closes it at its two-hour ceiling.
 * `BACKGROUND_COST=1` also measures what the count adds to a close's `inspect`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

type Row = Record<string, any>

const ME: FakeMachine = { machineId: 'b9'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000b9', name: 'studio', token: 'e2e-token-background-commands' }
const SHIM = resolve(CLI_ROOT, 'e2e/harness/clockShift.mjs')

/** `harness <args>` from [pane] (`''`: the person at a terminal), as an agent's shell tool runs it: plain text. */
function harness(d: IsolatedDaemon, pane: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: pane }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const named = async (client: LocalClient, name: string) => (await rows(client)).find((agent) => agent.name === name)

/** A Claude Code harness the person made, bound to its conversation. */
async function create(d: IsolatedDaemon, client: LocalClient, name: string): Promise<Row> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, name }, 90_000)
  expect(made.error, JSON.stringify(made)).toBeUndefined()
  return until(`${name} to bind its conversation`, async () => {
    const row = (await rows(client)).find((agent) => agent.id === made.agent.id)
    return row?.sessionId && row.status === 'active' ? row : null
  }, 60_000, 500)
}

/** One turn of the person's in [agent], answered. */
async function turn(client: LocalClient, agent: Row, content: string): Promise<void> {
  const from = client.frames.length
  client.send('message', { agentId: agent.id, content })
  await client.waitFor((f) => f.type === 'turn_ended' && f.agentId === agent.id, 60_000, `${agent.name}'s turn to end`, from)
}

/** The CPU time `ps` reads for [pid], in milliseconds (10 ms resolution). */
function cpuMs(pid: number): number {
  const time = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  return Math.round(time.split(':').reverse().reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0) * 1000)
}

describe('background commands an idle harness still runs, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  let scratch: string | undefined
  afterEach(async () => {
    // The background loop ends before its daemon goes, so a failed run leaves none behind.
    if (daemon) writeFileSync(release(daemon), '')
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })
  const release = (d: IsolatedDaemon) => join(d.root, 'background.release')
  /** A background command that runs until the test creates [d]'s release file. */
  const loop = (d: IsolatedDaemon) => `!background while [ ! -e "${release(d)}" ]; do sleep 0.2; done`
  const isolated = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    return d
  }

  it('a harness with a background command reads idle, not done, until it ends', async () => {
    const d = await isolated()
    await d.start()
    const client = await LocalClient.connect(d)
    const builder = await create(d, client, 'builder')
    await turn(client, builder, loop(d))
    const run = (...args: string[]) => harness(d, '', args)

    const shown = await run('show', 'builder', '--json')
    expect(shown.code, shown.err).toBe(0)
    const json = JSON.parse(shown.out)
    expect(json).toMatchObject({ state: 'idle', backgroundCommands: 1 })
    expect(json.next[0].run).toBe('harness wait builder')
    const text = await run('show', 'builder')
    expect(text.out.split('\n')).toContain('1 background command running')

    const refused = await run('close', 'builder')
    expect(refused.code, refused.out).toBe(1)
    expect(refused.err.trim()).toBe('builder: 1 background command running; --now closes anyway')
    expect((await named(client, 'builder'))?.status).toBe('active')

    // Read line by line as it prints: `background` while the command runs, `done` only once it has ended.
    const watch = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'watch', 'builder', '--json', '--timeout', '2m'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const lines: Row[] = []
      createInterface({ input: watch.stdout }).on('line', (line) => { lines.push(JSON.parse(line)) })
      await until('watch\'s first line', () => lines.length > 0, 60_000)
      expect(lines[0]).toMatchObject({ event: 'background', backgroundCommands: 1 })
      expect(lines.filter((line) => line.event === 'done')).toEqual([])
      writeFileSync(release(d), '')
      const done = await until('watch\'s done line', () => lines.find((line) => line.event === 'done'), 60_000)
      expect(done.backgroundCommands).toBe(0)
    } finally { watch.kill() }

    const waited = await run('wait', 'builder', '--timeout', '1m')
    expect(waited.code, waited.out + waited.err).toBe(0)
    expect(JSON.parse((await run('show', 'builder', '--json')).out).backgroundCommands).toBe(0)
    const closed = await run('close', 'builder')
    expect(closed.code, closed.out + closed.err).toBe(0)
    await until('builder to stop', async () => (await named(client, 'builder'))?.status === 'stopped', 60_000, 500)
    client.close()
  })

  it('the cleanup leaves it open, and closes it at its ceiling', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'background-clock-'))
    const shiftFile = join(scratch, 'shift')
    writeFileSync(shiftFile, '0')
    let shifted = 0
    const move = (minutes: number) => { shifted += minutes * 60_000; writeFileSync(shiftFile, String(shifted)) }
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.experiments.agents_start_agents = true
    const d = await isolated({
      BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      NODE_OPTIONS: `--import ${SHIM}`, E2E_CLOCK_SHIFT_FILE: shiftFile,
    })
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
      machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    await until('the account\'s experiments to be kept', () => {
      try { return JSON.parse(readFileSync(join(d.dataDir, 'agent-settings.json'), 'utf8')).agentsStartAgents === true } catch { return false }
    }, 30_000, 200)
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const lead = await create(d, client, 'lead')
    await turn(client, lead, 'hello lead')
    const fromLead = (...args: string[]) => harness(d, String(lead.tmuxPane), args)

    // Never sent a message: one would make it the person's, which the cleanup never closes.
    const started = await fromLead('new', 'claude', 'kid', '--name', 'kid', '--', loop(d))
    expect(started.code, started.out + started.err).toBe(0)
    await until('kid to run its background command', async () => {
      const shown = await fromLead('show', 'kid', '--json')
      return shown.code === 0 && JSON.parse(shown.out).backgroundCommands === 1
    }, 90_000, 1_000)

    // The first look after kid appeared only records it; three moves of 31 minutes stay under the ceiling.
    const left = /\[agent-cleanup\] left kid \(\w+\) open: 1 background command running/
    for (let attempt = 1; !left.test(d.log()); attempt++) {
      expect(attempt, 'the cleanup never left kid open').toBeLessThanOrEqual(3)
      move(31)
      await until('the cleanup to leave kid open', () => left.test(d.log()), 70_000, 500).catch(() => null)
    }
    expect((await named(client, 'kid'))?.status).toBe('active')

    move(125)
    await until('kid to be closed at its ceiling', async () => (await named(client, 'kid'))?.status === 'stopped', 70_000, 500)
    expect(d.log()).toMatch(/\[agent-cleanup\] closed kid \(\w+\): another agent started it, and it has sat idle \d+ minutes, with 1 background command running\. Its conversation is kept\./)
    client.close()
  }, 420_000)

  it.runIf(process.env.BACKGROUND_COST === '1')('cost', async () => {
    const d = await isolated()
    await d.start()
    const client = await LocalClient.connect(d)
    const idle = await create(d, client, 'idle')
    await turn(client, idle, 'hello idle')
    const corePid = d.corePid()
    expect(corePid).not.toBeNull()
    const cpuBefore = cpuMs(corePid!)
    const took: number[] = []
    for (let i = 0; i < 20; i++) {
      const at = performance.now()
      const reply = await client.request('agent_close', { agentId: idle.id, sessionId: idle.sessionId, createdAt: idle.createdAt, mode: 'inspect' }, 60_000)
      took.push(performance.now() - at)
      expect(reply.error, JSON.stringify(reply)).toBeUndefined()
    }
    const coreCpuMs = cpuMs(corePid!) - cpuBefore
    took.sort((a, b) => a - b)
    const medianMs = Math.round((took[9] + took[10]) / 2)
    const p95Ms = Math.round(took[18])
    // Written past the console, which a passing test's run does not show.
    process.stdout.write(`${JSON.stringify({ medianMs, p95Ms, coreCpuMs })}\n`)
    client.close()
  })
})
