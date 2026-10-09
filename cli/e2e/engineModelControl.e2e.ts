/** Real private daemon, tmux, engine workers and RPC; deterministic CLIs, no model accounts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

type Engine = 'claude' | 'codex'
const profile = (agent: string, engine: Engine, model: string, effort: string) => `runtime-v1:${agent}:${engine}:${model}@${effort}`

describe('engine model-control workers', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
  async function fresh(engine: Engine, options: DaemonOptions = {}) {
    const d = daemon = await IsolatedDaemon.create(options)
    writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
    onTestFailed(() => console.log(d.log()))
    await d.start()
    const c = client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, engine); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('bound engine', async () => (await c.request('agents_list', {})).agents.find((row: any) => row.id === created.agent.id && row.sessionId), 60_000, 100)
    const turn = async (content: string) => {
      const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, content)
      c.send('message', { agentId: agent.id, content }); await ended
    }
    await turn('before model control')
    const commandsPath = join(d.engineConfig.root, 'model-control-commands')
    const commands = () => existsSync(commandsPath) ? readFileSync(commandsPath, 'utf8').trim().split('\n') : []
    const selected = profile(agent.id, engine, engine === 'claude' ? 'sonnet' : 'gpt-6-luna', 'high')
    const offered = await c.request('models_list', { agentId: agent.id }, 15_000)
    expect(offered.models.some((option: { id: string }) => option.id === selected)).toBe(true)
    return { d, c, agent, selected, turn, commands, commandsPath }
  }

  it.each([false, true])('switches Claude Code model and effort with inline=%s', async inline => {
    const { d, c, agent, selected, turn, commands } = await fresh('claude', inline ? { env: { HARNESSD_SERVICES: 'none' } } : {})
    const result = await c.request('agent_update', { agentId: agent.id, selectedModel: selected }, 45_000)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result.agent.selectedModel).toBe(selected)
    expect(commands()).toEqual(['claude /model sonnet', 'claude /effort high'])
    const lower = profile(agent.id, 'claude', 'sonnet', 'low')
    const changed = await c.request('agent_update', { agentId: agent.id, selectedModel: lower }, 45_000)
    expect(changed.error, JSON.stringify(changed)).toBeUndefined()
    expect(changed.agent.selectedModel).toBe(lower)
    expect(commands().at(-1)).toBe('claude /effort low')
    await turn('after model control')
    expect(d.coresStarted()).toBe(1)
    expect(!!harnessdProcesses(d).get('engine-claude')).toBe(!inline)
  })

  it.each(['claude', 'codex'] as const)('revokes an interrupted %s model change, keeps the CLI alive, and accepts a new intent after recovery', async engine => {
    const { d, c, agent, selected, turn, commands, commandsPath } = await fresh(engine, { modelControlGate: true,
      env: { HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' } })
    const core = d.corePid(), worker = harnessdProcesses(d).get(`engine-${engine}`)!
    const panePid = (await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()
    const pending = c.request('agent_update', { agentId: agent.id, selectedModel: selected }, 45_000)
    // The native CLI has received the command, but has not answered it. Core must revoke this
    // operation when the engine worker stops, even though the CLI's later answer is still real.
    await until('command reached the engine', () => commands().length > 0 || null, 15_000, 20)
    process.kill(worker, 'SIGSTOP')
    const answer = await pending
    expect(answer.error, JSON.stringify(answer)).toBe('BUSY')
    await until('replacement worker', () => {
      const pid = harnessdProcesses(d).get(`engine-${engine}`)
      return pid && pid !== worker ? pid : null
    }, 20_000, 100)
    writeFileSync(`${commandsPath}.release`, 'continue')
    if (engine === 'codex') {
      await until('still-open picker, with no late digit', async () => /Select Model|Select a model/.test(await d.capture(agent.tmuxPane)) || null, 15_000, 100)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(await d.capture(agent.tmuxPane)).toMatch(/Select Model|Select a model/)
      // The user closes an interrupted picker before making a new request. Core never guesses an Escape.
      await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    } else {
      await until('actual model evidence after the worker recovers', async () => {
        const row = (await c.request('agents_list', {})).agents.find((row: any) => row.id === agent.id)
        return row?.selectedModel?.includes(':sonnet@') || null
      }, 15_000, 100)
      expect(commands()).toEqual(['claude /model sonnet']) // no resumed /effort from the cancelled worker
    }
    const retried = await c.request('agent_update', { agentId: agent.id, selectedModel: selected }, 45_000)
    expect(retried.error, JSON.stringify(retried)).toBeUndefined()
    expect(retried.agent.selectedModel).toBe(selected)
    await turn('after worker recovery')
    expect((await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()).toBe(panePid)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })
})
