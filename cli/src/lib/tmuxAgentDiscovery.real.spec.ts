import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  ENGINE_CLI_COMMANDS,
  ENGINES,
  executableFileIdentity,
  installedEngineBin,
} from './engineBin.js'
import { TmuxBackend } from './tmuxBackend.js'
import { probeTerminalAgents, type DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import { HARNESS_SESSION_PREFIX } from './harnessSessionLabel.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'

// Discovery only sees sessions named like agent_create's; a session outside the prefix is
// invisible to it by design, so every session this suite expects to find must wear it.
const SESSION_PREFIX = `${HARNESS_SESSION_PREFIX}real-${process.pid}`

const realDescribe = process.env.RUN_REAL_TMUX_DISCOVERY === '1' ? describe : describe.skip
let server: IsolatedTmux | undefined

const ownership = agentCommandOwnershipSnapshot()
const engines: Array<[AgentEngine, string, string | null]> = ENGINES.map((engine) => [
  engine,
  ENGINE_CLI_COMMANDS[engine],
  installedEngineBin(engine, ownership),
])
const installedAgentAliases: Array<[AgentEngine, string]> = []
const seenAgentAliases = new Set<string>()
for (const [engine, candidates] of [
  ['cursor', ownership.cursorAgentCandidates],
  ['grok', ownership.grokCandidates],
] as const) {
  for (const candidate of candidates) {
    const alias = executableFileIdentity(join(dirname(candidate.path), 'agent'))
    if (!alias || seenAgentAliases.has(alias.realPath) || agentAliasOwner([alias.fileKey], ownership) !== engine) continue
    seenAgentAliases.add(alias.realPath)
    installedAgentAliases.push([engine, alias.path])
  }
}

async function tmux(args: string[]): Promise<string> {
  if (!server) throw new Error('The private tmux test server has not been initialized')
  return server.run(...args)
}

/** The daemon's own scan (probeTerminalAgents over the tmux backend), narrowed to one pane. */
async function agentsInPane(pane: string): Promise<DiscoveredTerminalAgent[]> {
  const result = await probeTerminalAgents([new TmuxBackend()], ['tmux'])
  if (!result.processTableAvailable) throw new Error('the process table could not be read')
  return result.agents.filter((agent) => agent.runtimes.some((runtime) => runtime.paneId === pane))
}

async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

realDescribe.sequential('real installed CLI process discovery', () => {
  beforeAll(async () => {
    server = await isolatedTmux()
    vi.stubEnv('TMUX_TMPDIR', server.root)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    // Start with our config before TmuxBackend's first bare new-session call.
    await server.run('new-session', '-d', '-s', `${SESSION_PREFIX}-keeper`, 'sleep 600')
  })

  afterAll(async () => {
    try { await server?.close() } finally { vi.unstubAllEnvs() }
  })

  it('creates, notifies, and kills a test-owned session through the shared backend contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-real-tmux-lifecycle-'))
    const session = `${SESSION_PREFIX}-lifecycle`
    const backend = new TmuxBackend()
    try {
      const created = await backend.create({ cwd: dir, label: session })
      expect(created.state).toBe('succeeded')
      if (created.state !== 'succeeded') return
      await expect(tmux(['display-message', '-p', '-t', created.runtime.paneId, '#{session_name}']))
        .resolves.toBe(session)
      await expect(backend.notify(created.runtime, 'Harness test', 'Lifecycle message'))
        .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
      await expect(backend.kill(created.runtime))
        .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
      await expect(tmux(['has-session', '-t', session])).rejects.toBeTruthy()
    } finally {
      await tmux(['kill-session', '-t', session]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })

  for (const [engine, bin, path] of engines) {
    if (!path) console.warn(`[tmux-real] unavailable matrix row: ${engine} (${bin} has no verified installed executable)`)
    const matrixIt = path ? it : it.skip
    matrixIt(`discovers ${engine} once and process-only deletion preserves its pane`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `harness-real-${engine}-`))
      const session = `${SESSION_PREFIX}-${engine}`

      try {
        await tmux(['new-session', '-d', '-s', session, '-c', dir])
        const pane = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}'])
        await tmux(['send-keys', '-t', pane, '-l', '--', path!])
        await tmux(['send-keys', '-t', pane, 'C-m'])

        const discovered = await eventually(async () => {
          const inPane = await agentsInPane(pane)
          return inPane.length === 1 && inPane[0].engine === engine ? inPane[0] : null
        })
        const capture = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '')
        expect(discovered, `${bin} was not discovered in ${pane}\n${capture}`).not.toBeNull()

        // A second scan finds the same process. Node engines may change their process title between
        // snapshots; the PID and birth stamp prove this is still the same launched process.
        const matches = await agentsInPane(pane)
        expect(matches).toHaveLength(1)
        expect(matches[0]).toMatchObject({ engine, processIdentity: {
          pid: discovered!.processIdentity.pid,
          startMarker: discovered!.processIdentity.startMarker,
        } })

        const pid = discovered!.processIdentity.pid
        process.kill(pid, 'SIGTERM')
        const gone = await eventually(async () => {
          try { process.kill(pid, 0) } catch { return true }
          return null
        }, 2_000)
        if (!gone) {
          try { process.kill(pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }

        const absent = await eventually(async () => (await agentsInPane(pane)).length > 0 ? null : true, 5_000)
        expect(absent, `${bin} remained discoverable after its exact saved PID was terminated`).toBe(true)
        await expect(tmux(['display-message', '-p', '-t', pane, '#{pane_id}'])).resolves.toBe(pane)
      } finally {
        await tmux(['kill-session', '-t', session]).catch(() => {})
        await rm(dir, { recursive: true, force: true })
      }
    }, 35_000)
  }

  it('types literally and submits short text through stdin-loaded buffers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-real-tmux-input-'))
    const session = `${SESSION_PREFIX}-input`
    try {
      await tmux(['new-session', '-d', '-s', session, '-c', dir])
      const pane = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}'])
      const runtime = { backend: 'tmux' as const, paneId: pane }
      const backend = new TmuxBackend()
      const literalMarker = join(dir, 'literal-marker')
      const submitMarker = join(dir, 'submit-marker')

      await expect(backend.typeLiteral(runtime, `touch ${literalMarker}`)).resolves.toEqual({
        state: 'succeeded', dispatch: 'executed',
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await expect(access(literalMarker)).rejects.toBeTruthy()
      await expect(backend.sendKey(runtime, 'enter')).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
      expect(await eventually(() => access(literalMarker).then(() => true).catch(() => null), 5_000)).toBe(true)

      await expect(backend.submitText(runtime, `touch ${submitMarker}`)).resolves.toEqual({
        state: 'succeeded', dispatch: 'executed',
      })
      expect(await eventually(() => access(submitMarker).then(() => true).catch(() => null), 5_000)).toBe(true)
    } finally {
      await tmux(['kill-session', '-t', session]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(installedAgentAliases)('classifies installed %s alias named agent from its executable identity', async (engine, path) => {
    const dir = await mkdtemp(join(tmpdir(), `harness-real-agent-alias-${engine}-`))
    const session = `${SESSION_PREFIX}-${engine}-agent-alias`
    try {
      await tmux(['new-session', '-d', '-s', session, '-c', dir])
      const pane = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}'])
      await tmux(['send-keys', '-t', pane, '-l', '--', path])
      await tmux(['send-keys', '-t', pane, 'C-m'])
      const discovered = await eventually(async () => {
        const inPane = await agentsInPane(pane)
        return inPane.length === 1 && inPane[0].engine === engine ? inPane[0] : null
      })
      const capture = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '')
      expect(discovered, `${path} was not classified as ${engine} in ${pane}\n${capture}`).not.toBeNull()
    } finally {
      await tmux(['kill-session', '-t', session]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }, 35_000)
})
