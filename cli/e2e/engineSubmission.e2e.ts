/**
 * Submission verification read by the engine workers: a real private daemon, tmux, supervised workers and
 * the fake CLIs, which take a `!latestart` prompt off the composer and hold its turn's start until released.
 * The core's checks then find the composer clear and no turn, and ask the worker again each window.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

type Engine = 'claude' | 'codex'

describe('submission verification in the engine workers', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

  async function fresh(engine: Engine, env: DaemonOptions['env'] = {}) {
    const d = daemon = await IsolatedDaemon.create({ submissionGate: true, env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100', ...env } })
    onTestFailed(() => console.log(d.log()))
    await d.start()
    const c = client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, engine); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('bound engine', async () => (await c.request('agents_list', {})).agents.find((row: any) => row.id === created.agent.id && row.sessionId), 60_000, 100)
    const log = join(d.engineConfig.root, 'submitted-prompts')
    // Every Enter that sent the composer's text, as the fake CLI took it: an Enter pressed twice is a second line.
    const submitted = (): string[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    const turn = async (content: string) => {
      const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, content)
      c.send('message', { agentId: agent.id, content }); await ended
    }
    const started = (since: number, content: string) => c.frames.slice(since)
      .filter(frame => frame.type === 'turn_started' && frame.agentId === agent.id && JSON.stringify(frame.payload).includes(content))
    // The core's first reading of the composer, which only the engine's worker (or, inline, its reader) gives.
    const observed = (n: number) => until(`reading ${n} of the composer`, () => new RegExp(`accepted \\(queued/submitted\\) · engine=${engine} · observe=${n}/`).test(d.log()) || null, 20_000, 20)
    return { d, c, agent, submitted, turn, started, observed, release: () => writeFileSync(`${log}.release`, 'go') }
  }

  it.each([['claude', 'SIGSTOP'], ['codex', 'SIGKILL']] as const)('%s: a worker lost (%s) in the middle of verifying a prompt costs no second Enter, and the core, the CLI and the next prompt go on', async (engine, signal) => {
    const { d, c, agent, submitted, turn, started, observed, release } = await fresh(engine)
    await turn('before the check')
    const core = d.corePid(), worker = harnessdProcesses(d).get(`engine-${engine}`)!
    const panePid = (await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()
    const first = c.frames.length
    c.send('message', { agentId: agent.id, content: '!latestart held' })
    await observed(1)
    process.kill(worker, signal)
    // Frozen, the next check gets no reading and says the message could not be confirmed; killed, a new
    // worker may answer it instead. Either way no Enter is pressed: the composer was clear when read.
    await until('a replacement worker', () => {
      const pid = harnessdProcesses(d).get(`engine-${engine}`)
      return pid && pid !== worker ? pid : null
    }, 30_000, 100)
    if (signal === 'SIGSTOP') {
      await until('the message reported unconfirmed', () => c.frames.slice(first).some(frame => frame.type === 'error' && frame.agentId === agent.id
        && /could not be confirmed/.test(String(frame.payload?.message))) || null, 20_000, 50)
      expect(d.log()).toContain(`service engine-${engine} sent no heartbeat`)
    }
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, 'the held turn')
    release()
    await ended
    expect(started(first, '!latestart held')).toHaveLength(1)
    expect(submitted()).toEqual(['before the check', '!latestart held'])
    await turn('after the worker came back')
    expect(submitted()).toEqual(['before the check', '!latestart held', 'after the worker came back'])
    expect((await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()).toBe(panePid)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('codex: a worker whose reading itself fails, its screen read fine, leaves the message unconfirmed and presses no Enter', async () => {
    const { d, c, agent, submitted, turn, started, release } = await fresh('codex', { HARNESSD_TEST_FAULTS: 'engine-codex.engine_submission_read' })
    await turn('before the check')
    const core = d.corePid(), worker = harnessdProcesses(d).get('engine-codex')
    const first = c.frames.length
    c.send('message', { agentId: agent.id, content: '!latestart held' })
    await until('the message reported unconfirmed', () => c.frames.slice(first).some(frame => frame.type === 'error' && frame.agentId === agent.id
      && /could not be confirmed/.test(String(frame.payload?.message))) || null, 20_000, 50)
    expect(d.log()).toContain('engine_submission_read failed · injected fault')
    expect(d.log()).not.toMatch(/accepted \(queued\/submitted\) · engine=codex/)
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, 'the held turn')
    release()
    await ended
    expect(started(first, '!latestart held')).toHaveLength(1)
    expect(submitted()).toEqual(['before the check', '!latestart held'])
    await turn('the next prompt')
    expect(harnessdProcesses(d).get('engine-codex')).toBe(worker)
    expect(d.corePid()).toBe(core)
  })

  it('reads the composer with the engine\'s own reader in explicit inline mode, and presses no second Enter', async () => {
    const { d, c, agent, submitted, turn, started, observed, release } = await fresh('claude', { HARNESSD_SERVICES: 'none' })
    await turn('before the check')
    const first = c.frames.length
    c.send('message', { agentId: agent.id, content: '!latestart held' })
    await observed(2)
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, 'the held turn')
    release()
    await ended
    expect(started(first, '!latestart held')).toHaveLength(1)
    expect(submitted()).toEqual(['before the check', '!latestart held'])
    expect(c.frames.slice(first).filter(frame => frame.type === 'error' && frame.agentId === agent.id)).toEqual([])
    expect(harnessdProcesses(d).get('engine-claude')).toBeUndefined()
    expect(d.coresStarted()).toBe(1)
  })
})
