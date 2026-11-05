import { describe, expect, it, vi } from 'vitest'
import type { TerminalRuntimeRef } from '../terminalTypes.js'
import { ensureGuestEngine, guestEngineInstallArgv, guestEngineInstallable, guestEngineProbeArgv,
  guestNpmCli, guestNodeDir, guestNodeExe, type GuestEngineBackend } from './guestEngine.js'

const runtime = (paneId: string): TerminalRuntimeRef => ({ backend: 'ptyhost', instance: 'p3-0.5.55-gu0123456789ab', paneId })
const HOME = 'C:\\Users\\hg_0123456789ab'
const PREFIX = 'C:\\ProgramData\\HarnessGuests\\hosts\\hg_0123456789ab\\engines'

// The guest's own host, faked: each pane it makes is answered with the states the test lists, then comes to rest.
function backend(states: Array<Record<string, unknown>>, over: { createFails?: boolean; capture?: string } = {}) {
  let made = 0
  const queue = [...states]
  const next = () => (queue.length > 1 ? queue.shift()! : queue[0] ?? { dead: true, exitStatus: 0, command: 'node', engineExit: null })
  const created: TerminalRuntimeRef[] = []
  const killed: TerminalRuntimeRef[] = []
  const host = {
    create: vi.fn(async (request: { command?: string[]; label?: string }) => {
      if (over.createFails) return { state: 'failed' as const, dispatch: 'not_started' as const, reason: 'no guest host' }
      const at = runtime(`%${++made}`)
      created.push(at)
      return { state: 'succeeded' as const, dispatch: 'executed' as const, runtime: at }
    }),
    kill: vi.fn(async (at: TerminalRuntimeRef) => { killed.push(at); return { state: 'succeeded' as const, dispatch: 'executed' as const } }),
    paneState: vi.fn(async () => next()),
    capture: vi.fn(async () => ({ state: 'succeeded' as const, value: over.capture ?? '' })),
  }
  return { host: host as unknown as GuestEngineBackend, created, killed, calls: host.create }
}

const options = { user: 'hg_0123456789ab', engine: 'claude', cwd: HOME, prefix: PREFIX, setupVersion: 2, sleep: async () => {}, now: () => 0 }

describe('a guest\'s engine on Windows', () => {
  it('is installed as the guest, from the Node runtime staged beside the host, into that account\'s own prefix', () => {
    expect(guestNodeDir(2)).toBe('C:\\ProgramData\\HarnessGuests\\bin\\node-2')
    expect(guestNodeExe(2)).toBe(`${guestNodeDir(2)}\\node.exe`)
    expect(guestNpmCli(2)).toBe(`${guestNodeDir(2)}\\node_modules\\npm\\bin\\npm-cli.js`)
    expect(guestEngineProbeArgv('claude')).toEqual(['cmd.exe', '/d', '/s', '/c', 'where claude'])
    expect(guestEngineInstallArgv('codex', PREFIX, 2)).toEqual([guestNodeExe(2), guestNpmCli(2),
      'install', '--global', '--prefix', PREFIX, '--no-fund', '--no-audit', '--loglevel=error', '@openai/codex'])
    expect(guestEngineInstallArgv('claude', PREFIX, 2).at(-1)).toBe('@anthropic-ai/claude-code')
    // Only the engines whose subscription the relay spends are a guest's to have.
    expect(guestEngineInstallable('claude')).toBe(true)
    expect(guestEngineInstallable('opencode')).toBe(false)
  })

  it('runs nothing more when the account already has the engine', async () => {
    const log = vi.fn()
    const f = backend([{ dead: true, exitStatus: 0, command: 'cmd.exe', engineExit: null }])
    expect(await ensureGuestEngine(f.host, { ...options, log })).toEqual({ ok: true })
    expect(f.calls).toHaveBeenCalledTimes(1)
    expect(f.calls.mock.calls[0]![0]).toMatchObject({ command: ['cmd.exe', '/d', '/s', '/c', 'where claude'], cwd: HOME })
    expect(f.killed).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('installs it in its own pane when it is missing, and asks nothing of the person', async () => {
    const log = vi.fn()
    const f = backend([
      { dead: true, exitStatus: 1, command: 'cmd.exe', engineExit: null },
      { dead: true, exitStatus: 0, command: 'node.exe', engineExit: null },
    ])
    expect(await ensureGuestEngine(f.host, { ...options, log })).toEqual({ ok: true })
    expect(f.calls).toHaveBeenCalledTimes(2)
    expect(f.calls.mock.calls[1]![0]).toMatchObject({ label: 'guest-engine-install-claude', command: guestEngineInstallArgv('claude', PREFIX, 2) })
    expect(f.killed).toHaveLength(2)
    expect(log.mock.calls.flat().join(' ')).toContain('install · claude · hg_0123456789ab')
  })

  it('says what npm said when it fails, never a bare failure', async () => {
    const f = backend([
      { dead: true, exitStatus: 1, command: 'cmd.exe', engineExit: null },
      { dead: true, exitStatus: 1, command: 'node.exe', engineExit: null },
    ], { capture: 'npm ERR! code EAI_AGAIN\nnpm ERR! network\n' })
    expect(await ensureGuestEngine(f.host, options)).toEqual({ ok: false, error: 'GUEST_ENGINE_INSTALL_FAILED',
      detail: 'npm ERR! code EAI_AGAIN npm ERR! network' })
    expect(f.killed).toHaveLength(2)
  })

  it('stops an install that never finishes, and says so in words', async () => {
    let clock = 0
    const f = backend([
      { dead: true, exitStatus: 1, command: 'cmd.exe', engineExit: null },
      { dead: false, exitStatus: null, command: 'node.exe', engineExit: null },
    ])
    expect(await ensureGuestEngine(f.host, { ...options, now: () => clock, sleep: async () => { clock += 1000 }, installTimeoutMs: 2000 }))
      .toMatchObject({ ok: false, error: 'GUEST_ENGINE_INSTALL_FAILED', detail: expect.stringContaining('did not finish in time') })
    expect(f.killed).toHaveLength(2)
  })

  it('refuses an engine a guest\'s harness cannot be, before anything runs', async () => {
    const f = backend([])
    expect(await ensureGuestEngine(f.host, { ...options, engine: 'opencode' }))
      .toMatchObject({ ok: false, error: 'GUEST_ENGINE_UNSUPPORTED' })
    expect(f.calls).not.toHaveBeenCalled()
  })

  it('says the host could not check, rather than installing into nothing', async () => {
    const f = backend([], { createFails: true })
    expect(await ensureGuestEngine(f.host, options)).toEqual({ ok: false, error: 'GUEST_ENGINE_CHECK_FAILED', detail: 'no guest host' })
    expect(f.calls).toHaveBeenCalledTimes(1)
  })
})
